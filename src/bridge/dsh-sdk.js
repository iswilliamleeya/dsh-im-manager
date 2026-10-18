/**
 * DSH SDK bridge: owns one `dsh --profile sdk` child process and drives it over
 * newline-delimited JSON-RPC 2.0 on stdio.
 *
 * Responsibilities (see `docs/contracts.md` §4):
 * - spawn + `initialize` handshake, strict stdout protocol purity, stderr → logger;
 * - the SDK request set (`session/prompt`, `session/resume`, `session/wait`,
 *   `session/working-directory/get|set`, `shutdown`);
 * - notification fan-out (`session.event`, `session.status`, subagent lifecycle);
 * - automatic process restart with exponential backoff + jitter, after which
 *   `ensureSession()` restores known sessions via `session/resume` (a failed
 *   resume means "missing", so the next prompt creates the session instead);
 * - graceful, idempotent `stop()` (shutdown → SIGTERM → SIGKILL).
 *
 * The module is dependency-free (Node built-ins only) and accepts an injectable
 * `spawn` for tests.
 *
 * @module dsh-im-manager/bridge/dsh-sdk
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { JsonRpcLineTransport, JsonRpcResponseError } from './jsonrpc.js';

// Re-exported so callers can detect runtime JSON-RPC errors without a deep import.
export { JsonRpcResponseError };

/** @typedef {'starting' | 'ready' | 'restarting' | 'stopped'} DshBridgeState */

/**
 * @typedef {Object} BridgeRestartOptions
 * @property {boolean} [enabled] Restart after an unexpected exit (default true).
 * @property {number} [initialDelayMs] First retry delay (default 1000).
 * @property {number} [maxDelayMs] Backoff cap (default 30000).
 * @property {number} [factor] Exponential factor (default 2).
 * @property {number} [jitterRatio] Symmetric jitter ratio in `[0, 1)` (default 0.2).
 * @property {() => number} [random] RNG hook for deterministic tests (default
 *   `Math.random`).
 */

/**
 * @typedef {Object} DshBridgeOptions
 * @property {string} [command] Executable to spawn (default `'dsh'`).
 * @property {string[]} [args] Arguments (default `['--profile', 'sdk']`).
 * @property {string} [cwd] Initial working directory for the runtime (default
 *   `process.cwd()`); sent as the `initialize` `cwd`.
 * @property {string} [provider] Provider id sent to `initialize` (required to start).
 * @property {string} [model] Model id sent to `initialize` (required to start).
 * @property {string} [reasoningEffort] Optional adapter-owned effort identifier.
 * @property {number} [maxTokens] Optional positive output-token cap.
 * @property {NodeJS.ProcessEnv | Record<string, string | undefined>} [env] Extra
 *   environment variables merged over `process.env`.
 * @property {object} [log] Logger with optional `debug` / `info` / `warn` / `error`
 *   methods. The bridge never creates its own logger and never logs secrets.
 * @property {Function} [spawn] Injectable `child_process.spawn` (must return a
 *   child with pipe stdio). Defaults to `node:child_process.spawn`.
 * @property {number} [initializeTimeoutMs] Handshake timeout (default 60000).
 * @property {number} [requestTimeoutMs] Default per-request timeout (default 60000).
 * @property {number} [readyTimeoutMs] Max wait for `ready` in `ensureSession`
 *   (default 30000).
 * @property {number} [spawnTimeoutMs] Max wait for the process `'spawn'` event
 *   (default 10000).
 * @property {number} [shutdownTimeoutMs] Grace for the `shutdown` request
 *   (default 2000).
 * @property {number} [sigtermTimeoutMs] Grace after SIGTERM (default 3000).
 * @property {number} [killWaitMs] Observation window after SIGKILL (default 2000).
 * @property {BridgeRestartOptions} [restart] Restart policy.
 */

const DEFAULT_RESTART = Object.freeze({
  enabled: true,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  factor: 2,
  jitterRatio: 0.2,
});

/**
 * Create a DSH SDK bridge. Nothing is spawned until {@link DshBridge#start}.
 *
 * @param {DshBridgeOptions} [options]
 * @returns {DshBridge}
 */
export function createDshBridge(options = {}) {
  return new DshBridge(options);
}

/**
 * One bridge instance managing exactly one runtime child process at a time.
 */
export class DshBridge {
  /** @type {ReturnType<typeof normalizeOptions>} */
  #options;
  /** @type {object | null} */
  #log;
  /** @type {DshBridgeState} */
  #state = 'stopped';
  /** @type {string | undefined} */
  #detail;
  /** @type {import('node:child_process').ChildProcess | null} */
  #child = null;
  /** @type {JsonRpcLineTransport | null} */
  #transport = null;
  /** @type {import('node:readline').Interface | null} */
  #stderrReader = null;
  /** @type {unknown} */
  #serverInfo;
  /** @type {Promise<unknown> | null} */
  #startPromise = null;
  /** @type {Promise<void> | null} */
  #stopPromise = null;
  /** @type {boolean} */
  #stopping = false;
  /** @type {boolean} */
  #booting = false;
  /** @type {NodeJS.Timeout | null} */
  #restartTimer = null;
  /** @type {number} */
  #restartAttempt = 0;
  /** @type {number} Incremented by stop() to invalidate in-flight restart work. */
  #restartEpoch = 0;
  /** @type {Set<string>} Sessions created/opened in the current process. */
  #openSessions = new Set();
  /** @type {Set<string>} Every session id this bridge has observed. */
  #knownSessions = new Set();
  /** @type {Map<string, Promise<void>>} */
  #pendingEnsures = new Map();
  /** @type {{ resolve: () => void, reject: (error: Error) => void, timer: NodeJS.Timeout }[]} */
  #readyWaiters = [];
  #listeners = {
    /** @type {Set<(payload: { sessionId: string, event: object }) => void>} */
    event: new Set(),
    /** @type {Set<(payload: { sessionId: string, status: 'running' | 'idle' }) => void>} */
    status: new Set(),
    /** @type {Set<(payload: { state: DshBridgeState, detail?: string }) => void>} */
    state: new Set(),
    /** @type {Set<(payload: object) => void>} */
    subagent: new Set(),
  };

  /** @param {DshBridgeOptions} options */
  constructor(options) {
    this.#options = normalizeOptions(options);
    this.#log = this.#options.log;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /** @returns {DshBridgeState} Current lifecycle state. */
  get state() {
    return this.#state;
  }

  /** @returns {number | null} Live child pid, or `null` when no runtime is up. */
  get pid() {
    return this.#child?.pid ?? null;
  }

  /**
   * The last successful `initialize` result (`{ serverInfo: { name, version } }`).
   *
   * @returns {unknown}
   */
  get serverInfo() {
    return this.#serverInfo;
  }

  /**
   * Spawn the runtime and complete the `initialize` handshake.
   *
   * Rejects if the process cannot be spawned, the handshake fails/times out, or
   * the bridge is stopped before the handshake completes. Calling it again while
   * ready (or while a start is already in flight) is safe and shares the result.
   *
   * @returns {Promise<unknown>} The `initialize` result.
   */
  async start() {
    if (this.#stopPromise !== null) {
      await this.#stopPromise.catch(() => {});
    }
    if (this.#state === 'ready') return this.#serverInfo;
    if (this.#state === 'restarting') {
      await this.#waitForReady();
      return this.#serverInfo;
    }
    if (this.#startPromise !== null) return this.#startPromise;
    if (this.#stopping) throw new Error('dsh bridge is stopping; start() after stop() completes');
    const promise = this.#runStart().finally(() => {
      if (this.#startPromise === promise) this.#startPromise = null;
    });
    this.#startPromise = promise;
    return promise;
  }

  /**
   * Gracefully stop the runtime. Idempotent: concurrent/repeated calls share the
   * same promise and a stopped bridge resolves immediately.
   *
   * Sends `shutdown`, waits {@link DshBridgeOptions.shutdownTimeoutMs}, then
   * SIGTERM, then SIGKILL. Any scheduled restart is cancelled.
   *
   * @returns {Promise<void>}
   */
  stop() {
    if (this.#stopPromise !== null) return this.#stopPromise;
    if (this.#state === 'stopped' && this.#child === null && this.#restartTimer === null) {
      return Promise.resolve();
    }
    this.#stopping = true;
    const promise = this.#runStop().finally(() => {
      if (this.#stopPromise === promise) this.#stopPromise = null;
    });
    this.#stopPromise = promise;
    return promise;
  }

  /**
   * Make sure a session is usable in the current runtime process.
   *
   * Returns immediately when the session is already open. Otherwise it first
   * tries `session/resume`; a failed resume is treated as "session missing"
   * (logged at debug level) and the session is left for `prompt()` to create.
   * Waits for the bridge to become ready if it is starting/restarting.
   *
   * @param {string} sessionId Non-empty session id.
   * @returns {Promise<void>}
   */
  async ensureSession(sessionId) {
    assertNonEmptyString(sessionId, 'sessionId');
    await this.#waitForReady();
    if (this.#openSessions.has(sessionId)) return;
    const inFlight = this.#pendingEnsures.get(sessionId);
    if (inFlight !== undefined) return inFlight;

    const task = this.#resumeSession(sessionId).finally(() => {
      if (this.#pendingEnsures.get(sessionId) === task) this.#pendingEnsures.delete(sessionId);
    });
    this.#pendingEnsures.set(sessionId, task);
    return task;
  }

  /**
   * Queue one user prompt on a session.
   *
   * @param {string} sessionId Non-empty session id.
   * @param {Array<{ type: 'text', text: string } | { type: 'image', data: string, mimeType: string }>} blocks
   *   Non-empty content blocks; encoded images are forwarded verbatim.
   * @returns {Promise<{ messageId?: string }>} The runtime's prompt receipt.
   */
  async prompt(sessionId, blocks) {
    assertNonEmptyString(sessionId, 'sessionId');
    if (!Array.isArray(blocks) || blocks.length === 0) {
      throw new TypeError('dsh bridge: prompt() requires a non-empty blocks array');
    }
    await this.#waitForReady();
    const result = await this.#request('session/prompt', { sessionId, contentBlocks: blocks });
    this.#openSessions.add(sessionId);
    this.#knownSessions.add(sessionId);
    return /** @type {{ messageId?: string }} */ (result ?? {});
  }

  /**
   * Wait for a session's turn (and managed descendants) to settle.
   *
   * @param {string} sessionId Non-empty session id.
   * @returns {Promise<void>}
   */
  async wait(sessionId) {
    assertNonEmptyString(sessionId, 'sessionId');
    await this.#waitForReady();
    await this.#request('session/wait', { sessionId });
  }

  /**
   * Read a session's effective working directory (extension: not part of the
   * §4 API but spoken by the protocol).
   *
   * @param {string} sessionId
   * @returns {Promise<string>}
   */
  async getWorkingDirectory(sessionId) {
    assertNonEmptyString(sessionId, 'sessionId');
    await this.#waitForReady();
    const result = await this.#request('session/working-directory/get', { sessionId });
    // working-directory requests create the session in the runtime, so track it.
    this.#openSessions.add(sessionId);
    this.#knownSessions.add(sessionId);
    return /** @type {{ cwd?: string }} */ (result ?? {}).cwd ?? this.#options.cwd;
  }

  /**
   * Change a session's working directory (extension).
   *
   * @param {string} sessionId
   * @param {string} workingDirectory Absolute or cwd-relative path.
   * @returns {Promise<string>} The validated absolute directory.
   */
  async setWorkingDirectory(sessionId, workingDirectory) {
    assertNonEmptyString(sessionId, 'sessionId');
    assertNonEmptyString(workingDirectory, 'workingDirectory');
    await this.#waitForReady();
    const result = await this.#request('session/working-directory/set', {
      sessionId,
      path: workingDirectory,
    });
    this.#openSessions.add(sessionId);
    this.#knownSessions.add(sessionId);
    return /** @type {{ cwd?: string }} */ (result ?? {}).cwd ?? workingDirectory;
  }

  /**
   * Register a `session.event` listener.
   *
   * @param {(payload: { sessionId: string, event: object }) => void} listener
   * @returns {() => void} Unsubscribe.
   */
  onEvent(listener) {
    return this.#addListener('event', listener);
  }

  /**
   * Register a `session.status` listener.
   *
   * @param {(payload: { sessionId: string, status: 'running' | 'idle' }) => void} listener
   * @returns {() => void} Unsubscribe.
   */
  onStatus(listener) {
    return this.#addListener('status', listener);
  }

  /**
   * Register a lifecycle-state listener. Called with `{ state, detail? }`.
   *
   * @param {(payload: { state: DshBridgeState, detail?: string }) => void} listener
   * @returns {() => void} Unsubscribe.
   */
  onState(listener) {
    return this.#addListener('state', listener);
  }

  /**
   * Register a subagent lifecycle listener (extension). Called with
   * `{ type: 'subagent.started' | 'subagent.finished', ...params }`.
   *
   * @param {(payload: object) => void} listener
   * @returns {() => void} Unsubscribe.
   */
  onSubagent(listener) {
    return this.#addListener('subagent', listener);
  }

  // ── Start / stop internals ────────────────────────────────────────────────

  /** @returns {Promise<unknown>} */
  async #runStart() {
    this.#requireInitOptions();
    this.#stopping = false;
    this.#booting = true;
    this.#setState('starting');
    let child = null;
    try {
      child = this.#spawnRuntime();
      const info = await this.#initializeRuntime(child);
      if (this.#stopping) throw new Error('dsh bridge was stopped during startup');
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`dsh runtime exited during initialization (code ${child.exitCode})`);
      }
      this.#serverInfo = info;
      this.#restartAttempt = 0;
      this.#booting = false;
      this.#setState('ready');
      this.#resolveReadyWaiters();
      this.#logInfo(`dsh bridge ready (pid ${child.pid})`);
      return info;
    } catch (error) {
      // Keep #booting set while terminating so the close handler does not treat
      // this expected failure as an unexpected crash.
      await this.#disposeFailedChild(child);
      this.#booting = false;
      this.#setState('stopped', `start failed: ${errorMessage(error)}`);
      this.#rejectReadyWaiters(error instanceof Error ? error : new Error(String(error)));
      throw this.#startError(error);
    }
  }

  /**
   * Terminate a child whose startup failed without letting its close event
   * schedule a restart. Never throws.
   *
   * @param {import('node:child_process').ChildProcess | null} child
   * @returns {Promise<void>}
   */
  async #disposeFailedChild(child) {
    if (child === null) return;
    try {
      await this.#terminateChild(child);
    } catch (error) {
      this.#logDebug(`dsh bridge: failed to terminate startup child: ${errorMessage(error)}`);
    }
    this.#teardownChild(child);
  }

  /** @returns {Promise<void>} */
  async #runStop() {
    this.#restartEpoch += 1;
    this.#cancelRestartTimer();
    this.#rejectReadyWaiters(new Error('dsh bridge stopped'));
    this.#transport?.failPending(new Error('dsh bridge stopped'));

    if (this.#startPromise !== null) {
      const bootingChild = this.#child;
      if (bootingChild !== null) {
        this.#logDebug('dsh bridge: killing runtime that is still starting');
        try {
          bootingChild.kill('SIGTERM');
        } catch {
          // Already gone.
        }
      }
      await this.#startPromise.catch(() => {});
    }

    const child = this.#child;
    if (child !== null) await this.#terminateChild(child);

    this.#openSessions.clear();
    this.#stopping = false;
    this.#setState('stopped');
    this.#logInfo('dsh bridge stopped');
  }

  /**
   * shutdown → SIGTERM → SIGKILL for one child process.
   *
   * @param {import('node:child_process').ChildProcess} child
   * @returns {Promise<void>}
   */
  async #terminateChild(child) {
    if (child.exitCode !== null || child.signalCode !== null) {
      this.#teardownChild(child);
      return;
    }
    const exit = this.#exitPromise(child);
    const shutdown = this.#request('shutdown', undefined, this.#options.shutdownTimeoutMs).catch(
      (error) => {
        this.#logDebug(`dsh bridge: shutdown request failed: ${errorMessage(error)}`);
      },
    );

    let exited = await withTimeoutFlag(exit, this.#options.shutdownTimeoutMs);
    if (!exited) {
      this.#logWarn('dsh bridge: runtime did not exit after shutdown; sending SIGTERM');
      try {
        child.kill('SIGTERM');
      } catch {
        // Already gone.
      }
      exited = await withTimeoutFlag(exit, this.#options.sigtermTimeoutMs);
    }
    if (!exited) {
      this.#logWarn('dsh bridge: runtime did not exit after SIGTERM; sending SIGKILL');
      try {
        child.kill('SIGKILL');
      } catch {
        // Already gone.
      }
      exited = await withTimeoutFlag(exit, this.#options.killWaitMs);
    }
    if (!exited) this.#logWarn('dsh bridge: runtime still alive after SIGKILL');
    await shutdown;
    this.#teardownChild(child);
  }

  // ── Restart management ────────────────────────────────────────────────────

  /** @param {string} detail */
  #scheduleRestart(detail) {
    const restart = this.#options.restart;
    if (!restart.enabled) {
      this.#setState('stopped', detail);
      this.#rejectReadyWaiters(new Error(`dsh bridge: ${detail}`));
      return;
    }
    const attempt = this.#restartAttempt++;
    const base = Math.min(restart.initialDelayMs * restart.factor ** attempt, restart.maxDelayMs);
    const jitter = 1 + (restart.random() * 2 - 1) * restart.jitterRatio;
    const delayMs = Math.max(1, Math.min(Math.round(base * jitter), restart.maxDelayMs));
    this.#setState('restarting', `${detail}; restart attempt ${attempt + 1} in ${delayMs}ms`);
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = null;
      void this.#attemptRestart();
    }, delayMs);
  }

  /** @returns {Promise<void>} */
  async #attemptRestart() {
    const epoch = this.#restartEpoch;
    if (this.#stopping || this.#state === 'ready') return;
    this.#booting = true;
    let child = null;
    try {
      child = this.#spawnRuntime();
      const info = await this.#initializeRuntime(child);
      // stop() may have run while this attempt was booting; it bumped the epoch
      // and already terminated the child, so this attempt must stay silent.
      if (this.#stopping || epoch !== this.#restartEpoch) {
        this.#teardownChild(child);
        return;
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`dsh runtime exited during restart initialization (code ${child.exitCode})`);
      }
      this.#serverInfo = info;
      this.#restartAttempt = 0;
      this.#booting = false;
      this.#setState('ready');
      this.#resolveReadyWaiters();
      this.#logInfo(`dsh bridge restarted (pid ${child.pid})`);
    } catch (error) {
      await this.#disposeFailedChild(child);
      this.#booting = false;
      if (this.#stopping || epoch !== this.#restartEpoch) return;
      this.#logWarn(`dsh bridge: restart failed: ${errorMessage(error)}`);
      this.#scheduleRestart(`restart failed: ${errorMessage(error)}`);
    }
  }

  #cancelRestartTimer() {
    if (this.#restartTimer !== null) {
      clearTimeout(this.#restartTimer);
      this.#restartTimer = null;
    }
  }

  // ── Process / transport plumbing ──────────────────────────────────────────

  /**
   * Spawn the runtime child and wire stdio, stderr forwarding, and lifecycle.
   *
   * @returns {import('node:child_process').ChildProcess}
   */
  #spawnRuntime() {
    const { command, args, cwd, env, spawn } = this.#options;
    this.#logDebug(
      `dsh bridge: spawning ${command} ${args.join(' ')} (cwd=${cwd})`,
    );
    /** @type {import('node:child_process').ChildProcess} */
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (child === null || typeof child !== 'object' || child.stdin === null || child.stdout === null) {
      throw new Error('dsh bridge: spawn() did not return a child process with stdio pipes');
    }
    this.#child = child;

    // stderr is diagnostics only: forward each line, never parse it as protocol.
    if (child.stderr !== null) {
      this.#stderrReader = createInterface({ input: child.stderr, crlfDelay: Infinity });
      this.#stderrReader.on('line', (line) => this.#forwardStderrLine(line));
      child.stderr.on('error', (error) => {
        this.#logDebug(`dsh bridge: runtime stderr error: ${errorMessage(error)}`);
      });
    }

    // stdout is exclusively the JSON-RPC channel.
    const transport = new JsonRpcLineTransport(child.stdout, child.stdin);
    transport.onMalformedLine((line, error) => {
      this.#logWarn(
        `dsh bridge: ignoring malformed JSON-RPC frame from runtime stdout (${errorMessage(error)}): ${truncate(line)}`,
      );
    });
    transport.onRequest((method) => {
      // The runtime never sends requests today; refuse instead of hanging a peer.
      throw new Error(`dsh bridge does not serve runtime-initiated requests (got "${method}")`);
    });
    transport.onNotification((method, params) => this.#handleNotification(method, params));
    transport.start();
    this.#transport = transport;

    child.stdin.on('error', (error) => {
      this.#logDebug(`dsh bridge: runtime stdin error: ${errorMessage(error)}`);
    });
    child.on('error', (error) => {
      this.#logWarn(`dsh bridge: runtime process error: ${errorMessage(error)}`);
    });
    child.once('close', (code, signal) => {
      this.#handleChildClose(child, code, signal);
    });
    return child;
  }

  /**
   * Wait for the OS-level spawn to succeed so ENOENT surfaces immediately rather
   * than as a 60s handshake timeout.
   *
   * @param {import('node:child_process').ChildProcess} child
   * @returns {Promise<void>}
   */
  #waitForSpawn(child) {
    if (child.pid !== undefined && child.pid !== null) return Promise.resolve();
    return new Promise((resolve, reject) => {
      /** @param {() => void} settle */
      const cleanup = (settle) => {
        clearTimeout(timer);
        child.off('spawn', onSpawn);
        child.off('error', onError);
        settle();
      };
      const onSpawn = () => cleanup(resolve);
      const onError = (/** @type {Error} */ error) => cleanup(() => reject(error));
      const timer = setTimeout(() => {
        cleanup(() => reject(new Error(`dsh bridge: process did not spawn within ${this.#options.spawnTimeoutMs}ms`)));
      }, this.#options.spawnTimeoutMs);
      child.once('spawn', onSpawn);
      child.once('error', onError);
    });
  }

  /**
   * Send `initialize` and wait for the handshake result.
   *
   * @param {import('node:child_process').ChildProcess} child
   * @returns {Promise<unknown>}
   */
  async #initializeRuntime(child) {
    await this.#waitForSpawn(child);
    const info = await this.#request(
      'initialize',
      this.#initializeParams(),
      this.#options.initializeTimeoutMs,
    );
    if (info === null || typeof info !== 'object' || !('serverInfo' in info)) {
      this.#logWarn('dsh bridge: initialize response has no serverInfo field');
    } else {
      const { name, version } = /** @type {{ serverInfo?: { name?: unknown, version?: unknown } }} */ (info).serverInfo ?? {};
      this.#logDebug(`dsh bridge: initialize handshake ok (${String(name)} ${String(version)})`);
    }
    return info ?? {};
  }

  /** @returns {{ cwd: string, provider: string, model: string, reasoningEffort?: string, maxTokens?: number }} */
  #initializeParams() {
    const { cwd, provider, model, reasoningEffort, maxTokens } = this.#options;
    /** @type {Record<string, unknown>} */
    const params = { cwd, provider, model };
    if (reasoningEffort !== undefined) params.reasoningEffort = reasoningEffort;
    if (maxTokens !== undefined) params.maxTokens = maxTokens;
    return /** @type {any} */ (params);
  }

  /**
   * @param {import('node:child_process').ChildProcess} child
   * @param {number | null} code
   * @param {NodeJS.Signals | null} signal
   */
  #handleChildClose(child, code, signal) {
    if (child !== this.#child) return;
    this.#teardownChild(child);
    this.#openSessions.clear();
    if (this.#stopping) return;
    if (this.#booting) return; // start()/restart attempt owns the failure path

    const detail = `runtime exited (code ${code === null ? 'null' : code}${signal === null ? '' : `, signal ${signal}`})`;
    this.#logWarn(`dsh bridge: ${detail}`);
    if (!this.#options.restart.enabled) {
      this.#setState('stopped', detail);
      this.#rejectReadyWaiters(new Error(`dsh bridge: ${detail}`));
      return;
    }
    this.#scheduleRestart(detail);
  }

  /**
   * Release transport/stderr handles for `child` (or whatever is current when
   * `child` is null). Does not kill the process.
   *
   * @param {import('node:child_process').ChildProcess | null} child
   */
  #teardownChild(child) {
    if (child !== null && this.#child !== child) return;
    const transport = this.#transport;
    this.#transport = null;
    transport?.close();
    if (this.#stderrReader !== null) {
      try {
        this.#stderrReader.close();
      } catch {
        // Already closed.
      }
      this.#stderrReader = null;
    }
    if (this.#child === child) this.#child = null;
  }

  // ── JSON-RPC helpers ──────────────────────────────────────────────────────

  /**
   * Send one request over the current transport with a per-request timeout.
   *
   * @param {string} method
   * @param {Record<string, unknown> | undefined} params
   * @param {number} [timeoutMs]
   * @returns {Promise<unknown>}
   */
  #request(method, params, timeoutMs = this.#options.requestTimeoutMs) {
    const transport = this.#transport;
    if (transport === null) {
      return Promise.reject(
        new Error(`dsh bridge: cannot send "${method}": runtime is not running (state: ${this.#state})`),
      );
    }
    const controller = new AbortController();
    return new Promise((resolve, reject) => {
      let settled = false;
      /** @type {NodeJS.Timeout} */
      let timer;
      /** @param {(value: unknown) => void} settle */
      const succeed = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      /** @param {Error} error */
      const fail = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      };
      timer = setTimeout(() => {
        const error = new Error(`dsh bridge: "${method}" timed out after ${timeoutMs}ms`);
        controller.abort(error);
        fail(error);
      }, timeoutMs);
      transport.request(method, params, controller.signal).then(succeed, (error) => {
        fail(this.#decorateRequestError(method, error));
      });
    });
  }

  /**
   * Keep semantic JSON-RPC errors intact but make transport failures readable.
   *
   * @param {string} method
   * @param {unknown} error
   * @returns {Error}
   */
  #decorateRequestError(method, error) {
    const cause = error instanceof Error ? error : new Error(String(error));
    if (cause instanceof JsonRpcResponseError) return cause;
    const connectionLost =
      this.#state !== 'ready' || /JSON-RPC (?:input|transport) (?:closed|input closed)/i.test(cause.message);
    if (!connectionLost) return cause;
    return new Error(
      `dsh bridge: runtime connection lost while waiting for "${method}" (${cause.message})`,
      { cause },
    );
  }

  // ── Notification handling ─────────────────────────────────────────────────

  /**
   * @param {string} method
   * @param {Record<string, unknown>} params
   */
  #handleNotification(method, params) {
    try {
      const sessionId = typeof params.sessionId === 'string' ? params.sessionId : undefined;
      if (sessionId !== undefined) this.#knownSessions.add(sessionId);
      switch (method) {
        case 'session.event': {
          const event = params.event;
          if (sessionId === undefined || event === null || typeof event !== 'object') {
            this.#logDebug(`dsh bridge: ignoring malformed session.event notification`);
            return;
          }
          this.#emit('event', { sessionId, event });
          return;
        }
        case 'session.status': {
          const status = params.status;
          if (sessionId === undefined || (status !== 'running' && status !== 'idle')) {
            this.#logDebug('dsh bridge: ignoring malformed session.status notification');
            return;
          }
          this.#emit('status', { sessionId, status });
          return;
        }
        case 'subagent.started':
        case 'subagent.finished':
          this.#emit('subagent', { type: method, ...params });
          return;
        default:
          this.#logDebug(`dsh bridge: ignoring unknown notification "${method}"`);
      }
    } catch (error) {
      this.#logWarn(`dsh bridge: notification handler failed: ${errorMessage(error)}`);
    }
  }

  /**
   * @param {'event' | 'status' | 'state' | 'subagent'} kind
   * @param {any} payload
   */
  #emit(kind, payload) {
    for (const listener of [...this.#listeners[kind]]) {
      try {
        listener(payload);
      } catch (error) {
        this.#logWarn(`dsh bridge: "${kind}" listener failed: ${errorMessage(error)}`);
      }
    }
  }

  /**
   * @param {'event' | 'status' | 'state' | 'subagent'} kind
   * @param {Function} listener
   * @returns {() => void}
   */
  #addListener(kind, listener) {
    if (typeof listener !== 'function') {
      throw new TypeError(`dsh bridge: ${kind} listener must be a function`);
    }
    this.#listeners[kind].add(listener);
    return () => {
      this.#listeners[kind].delete(listener);
    };
  }

  // ── State / readiness ─────────────────────────────────────────────────────

  /**
   * @param {DshBridgeState} state
   * @param {string} [detail]
   */
  #setState(state, detail) {
    if (this.#state === state && this.#detail === detail) return;
    this.#state = state;
    this.#detail = detail;
    this.#logDebug(`dsh bridge state=${state}${detail === undefined ? '' : ` (${detail})`}`);
    this.#emit('state', detail === undefined ? { state } : { state, detail });
  }

  /** @returns {Promise<void>} */
  #waitForReady(timeoutMs = this.#options.readyTimeoutMs) {
    if (this.#state === 'ready') return Promise.resolve();
    if (this.#state === 'stopped' || this.#stopping) {
      return Promise.reject(
        new Error(`dsh bridge is not running (state: ${this.#state}); call start() first`),
      );
    }
    return new Promise((resolve, reject) => {
      /** @type {{ resolve: () => void, reject: (error: Error) => void, timer: NodeJS.Timeout }} */
      const waiter = { resolve, reject, timer: /** @type {any} */ (null) };
      waiter.timer = setTimeout(() => {
        this.#readyWaiters = this.#readyWaiters.filter((entry) => entry !== waiter);
        reject(
          new Error(
            `dsh bridge did not become ready within ${timeoutMs}ms (state: ${this.#state})`,
          ),
        );
      }, timeoutMs);
      this.#readyWaiters.push(waiter);
    });
  }

  #resolveReadyWaiters() {
    const waiters = this.#readyWaiters;
    this.#readyWaiters = [];
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
  }

  /** @param {Error} error */
  #rejectReadyWaiters(error) {
    const waiters = this.#readyWaiters;
    this.#readyWaiters = [];
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  // ── Session resume ────────────────────────────────────────────────────────

  /**
   * @param {string} sessionId
   * @returns {Promise<void>}
   */
  async #resumeSession(sessionId) {
    try {
      await this.#request('session/resume', { sessionId });
      this.#openSessions.add(sessionId);
      this.#knownSessions.add(sessionId);
      this.#logDebug(`dsh bridge: resumed session ${sessionId}`);
    } catch (error) {
      if (error instanceof JsonRpcResponseError) {
        // Not in this runtime's persistence store: prompt() creates it instead.
        this.#logDebug(
          `dsh bridge: session/resume failed for ${sessionId}; treating as missing (${error.message})`,
        );
        return;
      }
      // A lost connection is not a "missing session": let the caller retry.
      throw new Error(
        `dsh bridge: lost the runtime while restoring session ${sessionId} (${errorMessage(error)})`,
        { cause: error },
      );
    }
  }

  // ── Logging ───────────────────────────────────────────────────────────────

  /** @param {string} message */
  #logDebug(message) {
    this.#log?.debug?.(message);
  }

  /** @param {string} message */
  #logInfo(message) {
    this.#log?.info?.(message);
  }

  /** @param {string} message */
  #logWarn(message) {
    this.#log?.warn?.(message);
  }

  // ── Validation / shutdown helpers ─────────────────────────────────────────

  #requireInitOptions() {
    const { provider, model } = this.#options;
    if (typeof provider !== 'string' || provider.length === 0) {
      throw new TypeError('dsh bridge: options.provider is required to initialize the runtime');
    }
    if (typeof model !== 'string' || model.length === 0) {
      throw new TypeError('dsh bridge: options.model is required to initialize the runtime');
    }
  }

  /**
   * @param {import('node:child_process').ChildProcess} child
   * @returns {Promise<void>}
   */
  #exitPromise(child) {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
      child.once('close', () => resolve());
    });
  }

  /**
   * @param {unknown} error
   * @returns {Error}
   */
  #startError(error) {
    const cause = error instanceof Error ? error : new Error(String(error));
    if (cause instanceof JsonRpcResponseError) {
      return new Error(
        `dsh bridge: initialize failed: ${cause.message} (code ${cause.code ?? 'unknown'})`,
        { cause },
      );
    }
    return cause;
  }

  /**
   * @param {string} line
   */
  #forwardStderrLine(line) {
    const trimmed = line.trimEnd();
    if (trimmed.length === 0) return;
    const message = `[dsh stderr] ${trimmed}`;
    if (/\b(error|fatal|warn(?:ing)?|failed|failure|exception)\b/i.test(trimmed)) {
      this.#logWarn(message);
    } else {
      this.#logInfo(message);
    }
  }
}

// ── Module helpers ──────────────────────────────────────────────────────────

/**
 * @param {DshBridgeOptions} options
 */
function normalizeOptions(options) {
  if (options === null || typeof options !== 'object') {
    throw new TypeError('createDshBridge(options) requires an options object');
  }
  const { spawn: spawnFn = nodeSpawn, restart: restartInput, env, log, args, command, cwd, ...rest } = options;
  if (typeof spawnFn !== 'function') {
    throw new TypeError('createDshBridge: options.spawn must be a function');
  }
  const resolvedCommand = command ?? 'dsh';
  if (typeof resolvedCommand !== 'string' || resolvedCommand.length === 0) {
    throw new TypeError('createDshBridge: options.command must be a non-empty string');
  }
  const resolvedArgs = args ?? ['--profile', 'sdk'];
  if (!Array.isArray(resolvedArgs) || resolvedArgs.some((arg) => typeof arg !== 'string')) {
    throw new TypeError('createDshBridge: options.args must be an array of strings');
  }
  const resolvedCwd = cwd ?? process.cwd();
  if (typeof resolvedCwd !== 'string' || resolvedCwd.length === 0) {
    throw new TypeError('createDshBridge: options.cwd must be a non-empty string');
  }
  if (env !== undefined && (env === null || typeof env !== 'object' || Array.isArray(env))) {
    throw new TypeError('createDshBridge: options.env must be a plain object');
  }
  if (log !== undefined && log !== null && typeof log !== 'object') {
    throw new TypeError('createDshBridge: options.log must be an object with log methods');
  }
  const restart = normalizeRestart(restartInput);

  return {
    command: resolvedCommand,
    args: resolvedArgs,
    cwd: resolvedCwd,
    env: env ?? {},
    log: log ?? null,
    spawn: spawnFn,
    provider: rest.provider,
    model: rest.model,
    // Config files commonly pass `reasoningEffort: ''` / `maxTokens: null` for
    // "unset"; normalize those to omission instead of rejecting the handshake.
    reasoningEffort: normalizeOptionalEffort(rest.reasoningEffort),
    maxTokens: normalizeOptionalMaxTokens(rest.maxTokens),
    initializeTimeoutMs: positiveNumber(rest.initializeTimeoutMs, 60_000, 'initializeTimeoutMs'),
    requestTimeoutMs: positiveNumber(rest.requestTimeoutMs, 60_000, 'requestTimeoutMs'),
    readyTimeoutMs: positiveNumber(rest.readyTimeoutMs, 30_000, 'readyTimeoutMs'),
    spawnTimeoutMs: positiveNumber(rest.spawnTimeoutMs, 10_000, 'spawnTimeoutMs'),
    shutdownTimeoutMs: positiveNumber(rest.shutdownTimeoutMs, 2_000, 'shutdownTimeoutMs'),
    sigtermTimeoutMs: positiveNumber(rest.sigtermTimeoutMs, 3_000, 'sigtermTimeoutMs'),
    killWaitMs: positiveNumber(rest.killWaitMs, 2_000, 'killWaitMs'),
    restart,
  };
}

/**
 * @param {BridgeRestartOptions | undefined} input
 */
function normalizeRestart(input) {
  if (input !== undefined && (input === null || typeof input !== 'object')) {
    throw new TypeError('createDshBridge: options.restart must be an object');
  }
  const merged = { ...DEFAULT_RESTART, ...(input ?? {}) };
  if (typeof merged.enabled !== 'boolean') {
    throw new TypeError('createDshBridge: options.restart.enabled must be a boolean');
  }
  const initialDelayMs = positiveNumber(merged.initialDelayMs, 1000, 'restart.initialDelayMs');
  const maxDelayMs = positiveNumber(merged.maxDelayMs, 30_000, 'restart.maxDelayMs');
  if (!(typeof merged.factor === 'number' && Number.isFinite(merged.factor) && merged.factor >= 1)) {
    throw new TypeError('createDshBridge: options.restart.factor must be a finite number >= 1');
  }
  if (
    !(typeof merged.jitterRatio === 'number' && Number.isFinite(merged.jitterRatio) && merged.jitterRatio >= 0 && merged.jitterRatio < 1)
  ) {
    throw new TypeError('createDshBridge: options.restart.jitterRatio must be a number in [0, 1)');
  }
  const random = merged.random ?? Math.random;
  if (typeof random !== 'function') {
    throw new TypeError('createDshBridge: options.restart.random must be a function');
  }
  return {
    enabled: merged.enabled,
    initialDelayMs,
    maxDelayMs,
    factor: merged.factor,
    jitterRatio: merged.jitterRatio,
    random,
  };
}

/**
 * `reasoningEffort: undefined | null | ''` all mean "use the model default".
 *
 * @param {unknown} value
 * @returns {string | undefined}
 */
function normalizeOptionalEffort(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError('createDshBridge: options.reasoningEffort must be a non-empty string when set');
  }
  return value;
}

/**
 * `maxTokens: undefined | null` means "use the adapter/model default".
 *
 * @param {unknown} value
 * @returns {number | undefined}
 */
function normalizeOptionalMaxTokens(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError('createDshBridge: options.maxTokens must be a positive safe integer when set');
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @param {string} name
 * @returns {number}
 */
function positiveNumber(value, fallback, name) {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`createDshBridge: options.${name} must be a positive finite number`);
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} name
 */
function assertNonEmptyString(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`dsh bridge: ${name} must be a non-empty string`);
  }
}

/**
 * Resolve `true` when `promise` settles before `timeoutMs`, `false` otherwise.
 * Always clears its timer so no handle is retained by a timeout race.
 *
 * @param {Promise<unknown>} promise
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
function withTimeoutFlag(promise, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    const settle = () => {
      clearTimeout(timer);
      resolve(true);
    };
    promise.then(settle, settle);
  });
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * @param {string} text
 * @param {number} [max]
 * @returns {string}
 */
function truncate(text, max = 300) {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
