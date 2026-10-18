#!/usr/bin/env node
/**
 * Executable fake DSH SDK runtime + test helpers for the bridge.
 *
 * Run it as a real child process (the bridge spawns it over stdio):
 *
 * ```sh
 * node test/support/fake-dsh-runtime.js
 * ```
 *
 * It speaks the same newline-delimited JSON-RPC 2.0 protocol as
 * `dsh --profile sdk` (see `docs/contracts.md` §4):
 * `initialize`, `session/prompt`, `session/resume`, `session/wait`,
 * `session/working-directory/get|set`, `shutdown`, and the server→client
 * `session.event` / `session.status` notifications.
 *
 * Environment knobs (all optional):
 * - `FAKE_DSH_SLOW_MS`         delay between a prompt receipt and its event stream.
 * - `FAKE_DSH_CRASH_ON_PROMPT` `1`/`true` crashes on every prompt; any other
 *                              non-empty value crashes only when the prompt text
 *                              contains that substring.
 * - `FAKE_DSH_INIT_FAIL`       answer `initialize` with a JSON-RPC error.
 * - `FAKE_DSH_INIT_DELAY_MS`   delay before the initialize response.
 * - `FAKE_DSH_CRASH_AFTER_INIT_MS` crash this long after a successful initialize.
 * - `FAKE_DSH_REPLY_TEXT`      fixed assistant reply text.
 * - `FAKE_DSH_ECHO`            reply with the prompt text.
 * - `FAKE_DSH_PROMPT_ERROR`    answer `session/prompt` with a JSON-RPC error.
 * - `FAKE_DSH_RESUME_MISSING`  `*`, or a comma-separated session-id list, for
 *                              which `session/resume` rejects as missing.
 * - `FAKE_DSH_WAIT_MS`         delay before the `session/wait` response.
 * - `FAKE_DSH_IGNORE_SHUTDOWN` never answer `shutdown` and do not exit.
 * - `FAKE_DSH_IGNORE_SIGTERM`  ignore SIGTERM (forces SIGKILL escalation).
 * - `FAKE_DSH_STDOUT_GARBAGE`  emit a non-JSON line on stdout after initialize.
 * - `FAKE_DSH_TRACE`           log every received request to stderr.
 * - `FAKE_DSH_SERVER_VERSION`  override the reported `serverInfo.version`.
 *
 * The module also exports {@link bridgeWithFakeRuntime}, {@link waitFor} and
 * {@link createCapturingLogger} so bridge/e2e tests can spawn the fake runtime
 * through a real child process instead of mocking the JSON-RPC boundary.
 *
 * @module dsh-im-manager/test/support/fake-dsh-runtime
 */

import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createDshBridge } from '../../src/bridge/dsh-sdk.js';

/** Absolute path of this executable, for spawn-based tests. */
export const fakeRuntimePath = fileURLToPath(new URL('./fake-dsh-runtime.js', import.meta.url));

// ── Runtime configuration ───────────────────────────────────────────────────

/** @param {string} value */
function truthy(value) {
  return value !== undefined && value !== '' && value !== '0' && value !== 'false';
}

/** @param {string | undefined} value @param {number} fallback */
function intEnv(value, fallback = 0) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * @typedef {Object} FakeRuntimeConfig
 * @property {number} slowMs
 * @property {string} crashOnPrompt
 * @property {boolean} initFail
 * @property {number} initDelayMs
 * @property {number} crashAfterInitMs
 * @property {string | undefined} replyText
 * @property {boolean} echo
 * @property {boolean} promptError
 * @property {string} resumeMissing
 * @property {number} waitMs
 * @property {boolean} ignoreShutdown
 * @property {boolean} ignoreSigterm
 * @property {boolean} garbage
 * @property {boolean} trace
 * @property {string} version
 */

/** @returns {FakeRuntimeConfig} */
function readConfig() {
  const env = process.env;
  return {
    slowMs: intEnv(env.FAKE_DSH_SLOW_MS),
    crashOnPrompt: env.FAKE_DSH_CRASH_ON_PROMPT ?? '',
    initFail: truthy(env.FAKE_DSH_INIT_FAIL),
    initDelayMs: intEnv(env.FAKE_DSH_INIT_DELAY_MS),
    crashAfterInitMs: intEnv(env.FAKE_DSH_CRASH_AFTER_INIT_MS),
    replyText: env.FAKE_DSH_REPLY_TEXT,
    echo: truthy(env.FAKE_DSH_ECHO),
    promptError: truthy(env.FAKE_DSH_PROMPT_ERROR),
    resumeMissing: env.FAKE_DSH_RESUME_MISSING ?? '',
    waitMs: intEnv(env.FAKE_DSH_WAIT_MS),
    ignoreShutdown: truthy(env.FAKE_DSH_IGNORE_SHUTDOWN),
    ignoreSigterm: truthy(env.FAKE_DSH_IGNORE_SIGTERM),
    garbage: truthy(env.FAKE_DSH_STDOUT_GARBAGE),
    trace: truthy(env.FAKE_DSH_TRACE),
    version: env.FAKE_DSH_SERVER_VERSION ?? '0.2.1-rc.2-fake',
  };
}

/** @param {number} ms */
function delay(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

/** @param {string} line */
function stderr(line) {
  process.stderr.write(`[fake-dsh] ${line}\n`);
}

// ── Fake runtime server ─────────────────────────────────────────────────────

/** Start serving JSON-RPC on stdio. Invoked only when run as a script. */
function startServer() {
  /** @type {FakeRuntimeConfig} */
  const config = readConfig();
  let initialized = false;
  let eventSeq = 0;
  let turnSeq = 0;
  let messageSeq = 0;
  /** @type {Set<string>} */
  const sessions = new Set();
  /** @type {Map<string, string>} */
  const workingDirectories = new Map();

  /** @param {Record<string, unknown>} message @returns {Promise<void>} */
  const send = (message) =>
    new Promise((resolve) => {
      process.stdout.write(`${JSON.stringify(message)}\n`, () => resolve());
    });

  /** @param {string | number | undefined} id @param {unknown} result */
  const sendResult = (id, result) => send({ jsonrpc: '2.0', id, result });

  /** @param {string | number | undefined} id @param {number} code @param {string} message */
  const sendError = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

  /** @param {string} method @param {Record<string, unknown>} params */
  const notify = (method, params) => send({ jsonrpc: '2.0', method, params });

  /** @param {string} message */
  const trace = (message) => {
    if (config.trace) stderr(message);
  };

  /** @param {string} sessionId */
  const isResumeMissing = (sessionId) => {
    const skip = config.resumeMissing.trim();
    if (skip === '') return false;
    if (skip === '*') return true;
    return skip.split(',').map((entry) => entry.trim()).includes(sessionId);
  };

  /** @param {string} text */
  const replyTextFor = (text) => {
    if (config.echo) return text;
    if (config.replyText !== undefined) return config.replyText;
    return `fake-reply: ${text}`;
  };

  /** @param {string} sessionId @param {string} text */
  const streamTurn = async (sessionId, text) => {
    const replyText = replyTextFor(text);
    // Real dsh session events carry a numeric `data.turn` on turn/start,
    // assistant/message and turn/end; core's turn waiter keys on it.
    const turn = ++turnSeq;
    await notify('session.status', { sessionId, status: 'running' });
    await notify('session.event', {
      sessionId,
      event: {
        type: 'turn/start',
        seq: ++eventSeq,
        time: Date.now(),
        data: { turn },
      },
    });
    await notify('session.event', {
      sessionId,
      event: {
        type: 'assistant/message',
        seq: ++eventSeq,
        time: Date.now(),
        data: {
          turn,
          step: 1,
          message: {
            id: `assistant_${eventSeq}`,
            role: 'assistant',
            content: [{ type: 'text', text: replyText }],
          },
        },
      },
    });
    await notify('session.event', {
      sessionId,
      event: {
        type: 'turn/end',
        seq: ++eventSeq,
        time: Date.now(),
        data: { turn, reason: { kind: 'completed' } },
      },
    });
    await notify('session.status', { sessionId, status: 'idle' });
  };

  /** @param {string | number | undefined} id @param {Record<string, unknown>} params */
  const handleInitialize = async (id, params) => {
    trace(`initialize ${JSON.stringify(params)}`);
    await delay(config.initDelayMs);
    if (config.initFail) {
      await sendError(id, -32000, 'fake runtime: initialize failed (FAKE_DSH_INIT_FAIL)');
      return;
    }
    initialized = true;
    if (config.garbage) {
      // Deliberately corrupt stdout: the bridge must ignore non-JSON lines.
      process.stdout.write('this line is not json-rpc\n\n');
    }
    await sendResult(id, {
      serverInfo: { name: 'deepseek-harness-sdk-runtime', version: config.version },
    });
    if (config.crashAfterInitMs > 0) {
      setTimeout(() => {
        stderr(`crashing ${config.crashAfterInitMs}ms after initialize (pid ${process.pid})`);
        process.exit(2);
      }, config.crashAfterInitMs);
    }
  };

  /** @param {string | number | undefined} id @param {Record<string, unknown>} params */
  const handlePrompt = async (id, params) => {
    if (!initialized) {
      await sendError(id, -32603, 'SDK server is not initialized');
      return;
    }
    const sessionId = params.sessionId;
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      await sendError(id, -32602, 'session/prompt requires a non-empty sessionId string');
      return;
    }
    const blocks = Array.isArray(params.contentBlocks) ? params.contentBlocks : [];
    const text = blocks
      .filter(
        (block) =>
          block !== null &&
          typeof block === 'object' &&
          block.type === 'text' &&
          typeof block.text === 'string',
      )
      .map((block) => block.text)
      .join('\n');
    trace(`session/prompt ${JSON.stringify({ sessionId, text })}`);

    const crashTrigger = config.crashOnPrompt;
    if (crashTrigger !== '' && (crashTrigger === '1' || crashTrigger === 'true' || text.includes(crashTrigger))) {
      stderr(`crashing on prompt (pid ${process.pid})`);
      process.exit(1);
    }
    if (config.promptError) {
      await sendError(id, -32001, 'fake runtime: prompt rejected (FAKE_DSH_PROMPT_ERROR)');
      return;
    }

    sessions.add(sessionId);
    const messageId = `msg_${++messageSeq}`;
    // Match the real runtime: the prompt receipt returns before the turn streams.
    await sendResult(id, { messageId });
    await delay(config.slowMs);
    await streamTurn(sessionId, text);
  };

  /** @param {string | number | undefined} id @param {Record<string, unknown>} params */
  const handleResume = async (id, params) => {
    if (!initialized) {
      await sendError(id, -32603, 'SDK server is not initialized');
      return;
    }
    const sessionId = params.sessionId;
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      await sendError(id, -32602, 'session/resume requires a non-empty sessionId string');
      return;
    }
    trace(`session/resume ${JSON.stringify({ sessionId })}`);
    if (isResumeMissing(sessionId)) {
      await sendError(id, -32004, `fake runtime: persisted session not found: ${sessionId}`);
      return;
    }
    if (sessions.has(sessionId)) {
      await sendError(id, -32005, `SDK session is already open or opening: ${sessionId}`);
      return;
    }
    sessions.add(sessionId);
    await sendResult(id, {});
    await notify('session.status', { sessionId, status: 'idle' });
  };

  /** @param {string | number | undefined} id @param {Record<string, unknown>} params */
  const handleWait = async (id, params) => {
    if (!initialized) {
      await sendError(id, -32603, 'SDK server is not initialized');
      return;
    }
    const sessionId = params.sessionId;
    if (typeof sessionId !== 'string') {
      await sendError(id, -32602, 'session/wait requires a sessionId string');
      return;
    }
    trace(`session/wait ${JSON.stringify({ sessionId })}`);
    if (!sessions.has(sessionId)) {
      await sendError(id, -32006, `unknown SDK session: ${sessionId}`);
      return;
    }
    await delay(config.waitMs);
    await sendResult(id, {});
  };

  /** @param {string | number | undefined} id @param {Record<string, unknown>} params @param {boolean} write */
  const handleWorkingDirectory = async (id, params, write) => {
    if (!initialized) {
      await sendError(id, -32603, 'SDK server is not initialized');
      return;
    }
    const sessionId = params.sessionId;
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      await sendError(id, -32602, 'working-directory requests require a non-empty sessionId');
      return;
    }
    if (write && typeof params.path !== 'string') {
      await sendError(id, -32602, 'working-directory set requires a path string');
      return;
    }
    sessions.add(sessionId);
    if (write) workingDirectories.set(sessionId, path.resolve(process.cwd(), params.path));
    await sendResult(id, { cwd: workingDirectories.get(sessionId) ?? process.cwd() });
  };

  /** @param {string | number | undefined} id */
  const handleShutdown = async (id) => {
    trace('shutdown');
    if (config.ignoreShutdown) {
      stderr('ignoring shutdown request');
      return;
    }
    if (id !== undefined) await sendResult(id, {});
    // Flush the response, then exit like the real runtime's shutdown path.
    setImmediate(() => process.exit(0));
  };

  /** @param {string} rawLine */
  const handleLine = async (rawLine) => {
    const line = rawLine.trim();
    if (line.length === 0) return;
    /** @type {unknown} */
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      trace(`ignoring malformed line: ${line}`);
      return;
    }
    if (frame === null || typeof frame !== 'object' || Array.isArray(frame)) return;
    const typed = /** @type {Record<string, unknown>} */ (frame);
    const id = typed.id;
    const method = typed.method;
    if (typeof method !== 'string') return; // this fake never receives responses
    const params =
      typed.params !== null && typeof typed.params === 'object' && !Array.isArray(typed.params)
        ? /** @type {Record<string, unknown>} */ (typed.params)
        : {};
    const requestId = typeof id === 'string' || typeof id === 'number' ? id : undefined;

    switch (method) {
      case 'initialize':
        await handleInitialize(requestId, params);
        return;
      case 'session/prompt':
        await handlePrompt(requestId, params);
        return;
      case 'session/resume':
        await handleResume(requestId, params);
        return;
      case 'session/wait':
        await handleWait(requestId, params);
        return;
      case 'session/working-directory/get':
        await handleWorkingDirectory(requestId, params, false);
        return;
      case 'session/working-directory/set':
        await handleWorkingDirectory(requestId, params, true);
        return;
      case 'shutdown':
        await handleShutdown(requestId);
        return;
      default:
        trace(`unknown method ${method}`);
        if (requestId !== undefined) {
          await sendError(requestId, -32601, `unknown DeepSeek Harness SDK runtime method: ${method}`);
        }
    }
  };

  if (config.ignoreSigterm) {
    process.on('SIGTERM', () => stderr('ignoring SIGTERM'));
  }

  const reader = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let queue = Promise.resolve();
  reader.on('line', (line) => {
    queue = queue
      .then(() => handleLine(line))
      .catch((error) => stderr(`line handling failed: ${error instanceof Error ? error.stack : String(error)}`));
  });
  reader.on('close', () => process.exit(0));

  stderr(
    `ready pid=${process.pid} version=${config.version} slowMs=${config.slowMs} ` +
      `initFail=${config.initFail} crashOnPrompt=${config.crashOnPrompt === '' ? '-' : config.crashOnPrompt} ` +
      `echo=${config.echo}`,
  );
}

// ── Test helpers ────────────────────────────────────────────────────────────

/**
 * Create a bridge configured to spawn this file as a real child process.
 * Defaults use short restart backoff and request timeouts so tests stay fast;
 * anything can be overridden through `overrides` (`env`, `restart`, `log`, ...).
 *
 * @param {object} [overrides] Bridge options; `env` is merged over `process.env`.
 * @returns {import('../../src/bridge/dsh-sdk.js').DshBridge}
 */
export function bridgeWithFakeRuntime(overrides = {}) {
  const { env = {}, restart = {}, ...rest } = overrides;
  return createDshBridge({
    command: process.execPath,
    args: [fakeRuntimePath],
    provider: 'deepseek-official',
    model: 'fake-model',
    restart: { initialDelayMs: 25, maxDelayMs: 150, factor: 2, jitterRatio: 0, ...restart },
    initializeTimeoutMs: 5000,
    requestTimeoutMs: 5000,
    readyTimeoutMs: 5000,
    spawnTimeoutMs: 5000,
    ...rest,
    env: { ...process.env, ...env },
  });
}

/**
 * Poll `predicate` until it returns a truthy value.
 *
 * @template T
 * @param {() => T | Promise<T>} predicate
 * @param {{ timeoutMs?: number, intervalMs?: number, description?: string }} [options]
 * @returns {Promise<T>}
 */
export async function waitFor(predicate, options = {}) {
  const { timeoutMs = 3000, intervalMs = 10, description = 'condition' } = options;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() >= deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${description}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/**
 * Create a logger that records every call, for asserting stderr forwarding and
 * lifecycle logging without implementing a real logger.
 *
 * @param {string} [scope]
 * @returns {{ lines: { level: string, message: string, scope?: string }[], debug: Function, info: Function, warn: Function, error: Function, child: (scope: string) => object }}
 */
export function createCapturingLogger(scope) {
  /** @type {{ level: string, message: string, scope?: string }[]} */
  const lines = [];
  /** @param {'debug'|'info'|'warn'|'error'} level */
  const push = (level) => (message) => {
    lines.push({ level, message: String(message), scope });
  };
  /** @type {any} */
  const logger = {
    lines,
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    child: (childScope) => createCapturingLogger(childScope),
  };
  return logger;
}

// ── Entry point ─────────────────────────────────────────────────────────────

const isMain =
  typeof import.meta.main === 'boolean'
    ? import.meta.main
    : process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isMain) startServer();
