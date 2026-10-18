/**
 * Multi-workspace manager: one gateway instance per workspace, lifecycle
 * control, aggregated state, per-workspace log capture, pairing and config
 * editing. See `docs/manager-contract.md` §2/§3.
 *
 * Design notes:
 *   - the constructor performs no I/O; `init()` reads/creates manager.json;
 *   - `gatewayFactory` is injectable so tests never spawn a DSH runtime;
 *   - every write operation is serialized through a promise chain, so two
 *     concurrent starts/saves cannot race on the same workspace;
 *   - one workspace failing to start never blocks the others.
 */
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { format } from 'node:util';

import { CHANNEL_IDS, expandHome } from '../core/config.js';
import { createGateway } from '../core/gateway.js';
import { createConfigStore } from './config-store.js';
import {
  createChannelConnectProviders,
  createChannelConnectService,
  isConnectSupportedChannel,
} from './channel-connect.js';
import { SECRET_KEY_RE, oneLine, redactText, sanitizeErrorMessage, truncate } from './sanitize.js';

// Re-exported for the API layer and the manager's public surface.
export { sanitizeErrorMessage };

const DEFAULT_MANAGER_DIR = () => join(homedir(), '.dsh-im-manager');
const DEFAULT_LISTEN = Object.freeze({ host: '127.0.0.1', port: 8788 });
const LOG_BUFFER_LIMIT = 500;
const DEFAULT_LOG_LINES = 200;
const REFRESH_INTERVAL_MS = 1000;
const LOG_LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

// ── log redaction ────────────────────────────────────────────────────────────

/**
 * Recursively redact a log payload (mirrors the core logger's structural
 * redaction so captured lines are safe to render in the DSH page).
 * @param {unknown} value
 * @param {number} depth
 * @returns {unknown}
 */
function scrub(value, depth = 0) {
  if (value === null || typeof value !== 'object') {
    return typeof value === 'string' ? redactText(value) : value;
  }
  if (depth > 4) return '[depth]';
  if (value instanceof Error) {
    return { name: value.name, message: redactText(value.message), code: value.code };
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => scrub(item, depth + 1));
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = SECRET_KEY_RE.test(key) ? '***' : scrub(item, depth + 1);
  }
  return out;
}

/**
 * Render one captured log line:
 * `2026-01-01T00:00:00.000Z INFO  [channel] message {"key":"value"}`
 * @param {string} level
 * @param {string[]} scopes
 * @param {unknown[]} args
 * @param {number} time
 */
function formatLogLine(level, scopes, args, time) {
  const parts = [new Date(time).toISOString(), level.toUpperCase().padEnd(5)];
  if (scopes.length > 0) parts.push(`[${scopes.join('/')}]`);
  const [first, ...rest] = args;
  let message;
  /** @type {unknown[]} */
  let fields = [];
  if (typeof first === 'string') {
    // printf-style args render into the message; a single plain object stays
    // structured so fields like `{ channel, error }` are machine-readable.
    const onlyScalars = rest.every((item) => item === null || typeof item !== 'object');
    if (rest.length > 0 && onlyScalars) {
      message = format(...args);
    } else {
      message = first;
      fields = rest;
    }
  } else if (first !== undefined) {
    message = format(...args);
  }
  if (message !== undefined) parts.push(truncate(oneLine(redactText(message)), 2000));
  if (fields.length === 1 && fields[0] !== null && typeof fields[0] === 'object' && !(fields[0] instanceof Error)) {
    parts.push(truncate(JSON.stringify(scrub(fields[0], 1)), 2000));
  } else if (fields.length > 0) {
    parts.push(truncate(JSON.stringify(fields.map((item) => scrub(item, 1))), 2000));
  }
  return truncate(parts.join(' '), 4000);
}

/**
 * A core-logger-compatible logger (debug/info/warn/error/child) that appends
 * formatted, redacted lines to a ring buffer instead of writing to a stream.
 *
 * @param {{ push: (line: string) => void }} buffer
 * @param {() => number} now
 * @param {string} [level]
 */
function createCaptureLogger(buffer, now, level = 'info') {
  const threshold = LOG_LEVELS[level] ?? LOG_LEVELS.info;
  /** @param {string[]} scopes */
  function make(scopes) {
    /** @param {string} name */
    function emit(name) {
      if ((LOG_LEVELS[name] ?? 0) < threshold) return () => {};
      return (...args) => {
        try {
          buffer.push(formatLogLine(name, scopes, args, now()));
        } catch {
          // Logging must never take the gateway/manager down.
        }
      };
    }
    return {
      debug: emit('debug'),
      info: emit('info'),
      warn: emit('warn'),
      error: emit('error'),
      /** @param {string} scope */
      child(scope) {
        return make([...scopes, String(scope)]);
      },
    };
  }
  return make([]);
}

/** A logger that writes nothing (tests / no logger supplied). */
function nullLogger() {
  /** @type {any} */
  const logger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    child() {
      return logger;
    },
  };
  return logger;
}

// ── errors ───────────────────────────────────────────────────────────────────

/** @param {string} message @param {string} code */
function codedError(message, code) {
  const error = new Error(message);
  /** @type {any} */ (error).code = code;
  return error;
}

/** @param {string} id */
function workspaceNotFound(id) {
  return codedError(`workspace not found: ${id}`, 'WORKSPACE_NOT_FOUND');
}

/** @param {string} id */
function workspaceNotRunning(id) {
  return codedError(`workspace not running: ${id}`, 'WORKSPACE_NOT_RUNNING');
}

// ── manager ──────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} GatewayLike
 * @property {() => Promise<void>} start
 * @property {() => Promise<void>} stop
 * @property {() => Promise<Record<string, any>>} [status]
 * @property {string} [state]
 * @property {Record<string, any>} [config]
 * @property {{ listPending?: () => any[], approve?: (code: string) => any, ttlSec?: number }} [pairing]
 */

/**
 * @typedef {Object} GatewayInstance
 * @property {GatewayLike | null} gateway
 * @property {'starting'|'running'|'stopping'|'stopped'|'error'} state
 * @property {string | null} error
 * @property {number} startedAt
 * @property {Record<string, any> | null} snapshot
 */

/**
 * @param {{
 *   managerFile?: string,
 *   managerDataDir?: string,
 *   logger?: import('../core/types.js').Logger,
 *   gatewayFactory?: (input: { config: Record<string, any>, logger: any }) => GatewayLike,
 *   connectProviders?: { weixin?: { begin: Function }, feishu?: { begin: Function } },
 *   connectOptions?: Record<string, any>,
 *   now?: () => number,
 *   provider?: string,
 * }} [options]
 */
export function createManager(options = {}) {
  const now = options.now ?? Date.now;
  const managerDataDir = resolve(expandHome(options.managerDataDir ?? DEFAULT_MANAGER_DIR()));
  const managerFile = options.managerFile === undefined
    ? join(managerDataDir, 'manager.json')
    : resolve(expandHome(options.managerFile));
  const logger = options.logger ?? nullLogger();
  const gatewayFactory = options.gatewayFactory ?? ((input) => createGateway(input));

  /** @type {ReturnType<typeof createConfigStore> | null} */
  let store = null;
  /** @type {Map<string, GatewayInstance>} */
  const instances = new Map();
  /** @type {Map<string, { push: (line: string) => void, toArray: () => string[], readonly size: number }>} */
  const logBuffers = new Map();
  /** @type {Map<string, { mtimeMs: number, config: Record<string, any> }>} */
  const configCache = new Map();
  let started = false;
  let startedAt = 0;
  /** @type {ReturnType<typeof setInterval> | null} */
  let refreshTimer = null;
  /** @type {Promise<unknown>} */
  let writeChain = Promise.resolve();
  /** @type {ReturnType<typeof createChannelConnectService> | null} */
  let connectService = null;

  /**
   * Serialize every write operation (start/stop/restart/save/add/remove/approve)
   * so concurrent UI requests cannot race.
   * @template T
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  function withWriteLock(fn) {
    const run = writeChain.then(() => fn());
    writeChain = run.then(() => undefined, () => undefined);
    return run;
  }

  // ── channel connect flows §10 ──────────────────────────────────────────────

  /** Lazily create the QR connect flow store (providers are injectable). */
  function ensureConnectService() {
    if (connectService !== null) return connectService;
    connectService = createChannelConnectService({
      providers: options.connectProviders ?? createChannelConnectProviders(),
      now,
      ...(options.connectOptions ?? {}),
      onConfirmed: handleConnectConfirmed,
      onInactive: handleConnectInactive,
    });
    return connectService;
  }

  /** @param {unknown} channel */
  function requireConnectChannel(channel) {
    const channelId = String(channel ?? '');
    if (!isConnectSupportedChannel(channelId)) {
      throw codedError(
        `channel "${channelId}" does not support QR connect (supported: weixin, feishu)`,
        'INVALID_INPUT',
      );
    }
    return channelId;
  }

  /**
   * Ensure a channel is disabled in the config file, restarting a running
   * workspace when (and only when) the flag actually changed.
   * @param {string} id
   * @param {string} channel
   * @returns {Promise<boolean>} true when the config changed
   */
  async function disableChannelInternal(id, channel) {
    if (store === null) throw workspaceNotFound(id);
    const entry = store.requireWorkspace(id);
    const config = store.readWorkspaceConfig(entry.id);
    const channelConfig = config.channels?.[channel];
    if (channelConfig?.enabled !== true) return false;
    channelConfig.enabled = false;
    await store.writeWorkspaceConfig(entry.id, config);
    configCache.delete(entry.id);
    logger.info('channel disabled', { workspace: entry.id, channel });
    if (instances.get(entry.id)?.state === 'running') {
      try {
        await restartWorkspaceInternal(entry.id);
      } catch (error) {
        logger.error('workspace restart after disabling channel failed', {
          workspace: entry.id,
          channel,
          error: sanitizeErrorMessage(error),
        });
      }
    }
    return true;
  }

  /**
   * Success handler for a connect flow: merge the issued credentials into the
   * workspace config, then restart a running workspace (contract §10.4).
   * Runs under the write lock; throws abort the flow with `failed`.
   *
   * @param {any} record
   * @param {any} rawResult
   */
  async function handleConnectConfirmed(record, rawResult) {
    await withWriteLock(async () => {
      if (record.controller.signal.aborted || record.state === 'cancelled') return;
      if (store === null) throw workspaceNotFound(record.workspaceId);
      const entry = store.requireWorkspace(record.workspaceId);
      const config = store.readWorkspaceConfig(entry.id);
      const channelConfig = config.channels?.[record.channel] ?? {};
      channelConfig.enabled = true;
      if (record.channel === 'feishu') {
        const appId = typeof rawResult?.appId === 'string' ? rawResult.appId : '';
        const appSecret = typeof rawResult?.appSecret === 'string' ? rawResult.appSecret : '';
        if (appId === '' || appSecret === '') {
          throw new Error('feishu connect returned incomplete credentials');
        }
        channelConfig.appId = appId;
        channelConfig.appSecret = appSecret;
        if (rawResult?.domain === 'lark' || rawResult?.domain === 'feishu') {
          channelConfig.domain = rawResult.domain;
        }
      }
      // weixin credentials are persisted by runWeixinLogin itself under
      // <gateway stateDir>/channels/weixin/credentials.json; the config only
      // needs enabled:true.
      config.channels[record.channel] = channelConfig;
      await store.writeWorkspaceConfig(entry.id, config);
      configCache.delete(entry.id);
      logger.info('channel connected', { workspace: entry.id, channel: record.channel });
      if (instances.get(entry.id)?.state === 'running') {
        await restartWorkspaceInternal(entry.id);
      }
    });
  }

  /**
   * Failure/expiry handler: a channel that never confirmed must stay disabled.
   * @param {any} record
   */
  async function handleConnectInactive(record) {
    await withWriteLock(async () => {
      try {
        await disableChannelInternal(record.workspaceId, record.channel);
      } catch (error) {
        if (/** @type {any} */ (error)?.code !== 'WORKSPACE_NOT_FOUND') {
          logger.warn('failed to disable channel after connect flow ended', {
            workspace: record.workspaceId,
            channel: record.channel,
            error: sanitizeErrorMessage(error),
          });
        }
      }
    });
  }

  /** @param {string} id */
  function ensureLogBuffer(id) {
    let buffer = logBuffers.get(id);
    if (buffer === undefined) {
      /** @type {string[]} */
      const lines = [];
      buffer = {
        push(line) {
          lines.push(line);
          if (lines.length > LOG_BUFFER_LIMIT) lines.splice(0, lines.length - LOG_BUFFER_LIMIT);
        },
        toArray() {
          return [...lines];
        },
        get size() {
          return lines.length;
        },
      };
      logBuffers.set(id, buffer);
    }
    return buffer;
  }

  /**
   * Effective (unmasked, non-interpolated) config, cached by mtime.
   * @param {string} id
   * @returns {Record<string, any> | null}
   */
  function rawConfigFor(id) {
    const entry = store?.getWorkspace(id);
    if (entry === undefined) return null;
    try {
      const stat = statSync(entry.configFile);
      const cached = configCache.get(id);
      if (cached !== undefined && cached.mtimeMs === stat.mtimeMs) return cached.config;
      const config = store.readWorkspaceConfig(id);
      configCache.set(id, { mtimeMs: stat.mtimeMs, config });
      return config;
    } catch {
      return configCache.get(id)?.config ?? null;
    }
  }

  /**
   * @param {string} id
   * @returns {Array<{ code: string, channel: string, senderId: string, name: string | null, expiresAt: number }>}
   */
  function listPairingFor(id) {
    const instance = instances.get(id);
    if (instance === undefined || instance.state !== 'running') return [];
    const pairing = instance.gateway?.pairing;
    if (pairing === undefined || typeof pairing.listPending !== 'function') return [];
    const ttl = Number(instance.gateway?.config?.gateway?.access?.pairingTtlSec)
      || Number(pairing.ttlSec)
      || 600;
    const pending = pairing.listPending();
    if (!Array.isArray(pending)) return [];
    return pending.map((entry) => ({
      code: String(entry?.code ?? ''),
      channel: String(entry?.channel ?? ''),
      senderId: String(entry?.senderId ?? ''),
      name: typeof entry?.name === 'string' ? entry.name : null,
      expiresAt: (Number(entry?.createdAt) || now()) + ttl * 1000,
    }));
  }

  /**
   * @param {GatewayInstance | undefined} instance
   * @param {string} state
   */
  function bridgeStateFor(instance, state) {
    if (instance === undefined) return 'absent';
    const fromSnapshot = instance.snapshot?.bridge;
    if (typeof fromSnapshot === 'string') return fromSnapshot;
    if (state === 'running') return 'ready';
    if (state === 'starting') return 'starting';
    return 'stopped';
  }

  /**
   * @param {Record<string, any> | null} config
   * @param {Record<string, any> | null} snapshot
   */
  function httpFor(config, snapshot) {
    const snapshotHttp = snapshot?.http;
    if (snapshotHttp !== null && typeof snapshotHttp === 'object') {
      return {
        port: Number.isInteger(snapshotHttp.port) ? snapshotHttp.port : 0,
        publicBaseUrl: typeof snapshotHttp.publicBaseUrl === 'string' ? snapshotHttp.publicBaseUrl : '',
      };
    }
    const port = config?.gateway?.http?.port;
    return { port: Number.isInteger(port) ? port : 0, publicBaseUrl: '' };
  }

  /**
   * Build the public summary of one workspace (§3). Sync: every live value comes
   * from the cached {@link GatewayLike.status} snapshot.
   * @param {string} id
   */
  function summaryFor(id) {
    if (store === null) throw workspaceNotFound(id);
    const entry = store.getWorkspace(id);
    if (entry === undefined) throw workspaceNotFound(id);
    const instance = instances.get(id);
    const state = instance?.state ?? 'stopped';
    const config = rawConfigFor(id);
    const snapshot = instance?.snapshot ?? null;
    const channels = CHANNEL_IDS
      .filter((channelId) => config?.channels?.[channelId]?.enabled === true)
      .map((channelId) => {
        const channelConfig = config?.channels?.[channelId] ?? {};
        const health = snapshot?.channels?.[channelId] ?? null;
        return {
          id: channelId,
          enabled: true,
          mode: typeof channelConfig.mode === 'string' ? channelConfig.mode : '',
          health: typeof health?.state === 'string' ? health.state : '',
          detail: typeof health?.detail === 'string' && health.detail.length > 0
            ? health.detail
            : (typeof health?.error === 'string' ? health.error : ''),
        };
      });
    return {
      id: entry.id,
      name: entry.name,
      workspaceDir: entry.workspaceDir,
      configFile: entry.configFile,
      autoStart: entry.autoStart,
      state,
      error: state === 'error' ? (instance?.error ?? null) : null,
      workspaceCwd: typeof config?.dsh?.cwd === 'string' ? config.dsh.cwd : entry.workspaceDir,
      bridge: bridgeStateFor(instance, state),
      sessions: Number.isFinite(snapshot?.sessions) ? Number(snapshot.sessions) : 0,
      channels,
      pendingPairings: listPairingFor(id),
      http: httpFor(config, snapshot),
    };
  }

  /**
   * @param {string} id
   */
  async function refreshOne(id) {
    const instance = instances.get(id);
    if (instance === undefined) return;
    if (instance.gateway === null) {
      instance.snapshot = null;
      return;
    }
    let snapshot = null;
    try {
      if (typeof instance.gateway.status === 'function') snapshot = await instance.gateway.status();
    } catch (error) {
      logger.debug('workspace status refresh failed', { workspace: id, error: sanitizeErrorMessage(error) });
    }
    instance.snapshot = snapshot ?? null;
    // Reconcile the manager view with the gateway's own lifecycle (e.g. the
    // bridge/gateway stopped itself).
    if (instance.state === 'running') {
      const gatewayState = instance.gateway.state;
      if (gatewayState === 'stopped') instance.state = 'stopped';
      else if (gatewayState === 'stopping') instance.state = 'stopping';
      else if (gatewayState === 'starting') instance.state = 'starting';
    }
  }

  /** Refresh cached status for every live workspace. */
  async function refresh() {
    if (store === null) return;
    await Promise.allSettled([...instances.keys()].map((id) => refreshOne(id)));
  }

  function startRefreshTimer() {
    if (refreshTimer !== null) return;
    refreshTimer = setInterval(() => {
      void refresh().catch(() => {});
    }, REFRESH_INTERVAL_MS);
    refreshTimer.unref?.();
  }

  function stopRefreshTimer() {
    if (refreshTimer === null) return;
    clearInterval(refreshTimer);
    refreshTimer = null;
  }

  /** Best-effort teardown of a gateway instance we are about to replace. */
  async function disposeInstance(instance) {
    if (instance.gateway === null) return;
    try {
      await instance.gateway.stop();
    } catch (error) {
      logger.warn('gateway stop failed during dispose', { error: sanitizeErrorMessage(error) });
    }
    instance.gateway = null;
    instance.snapshot = null;
  }

  /** @param {string} id */
  async function startWorkspaceInternal(id) {
    if (store === null) throw workspaceNotFound(id);
    store.requireWorkspace(id);
    const existing = instances.get(id);
    if (existing !== undefined && (existing.state === 'running' || existing.state === 'starting')) {
      return summaryFor(id);
    }
    if (existing !== undefined) {
      await disposeInstance(existing);
      instances.delete(id);
    }

    const buffer = ensureLogBuffer(id);
    /** @type {GatewayInstance} */
    const instance = { gateway: null, state: 'starting', error: null, startedAt: 0, snapshot: null };
    instances.set(id, instance);

    try {
      const config = store.loadWorkspaceConfig(id);
      const captureLogger = createCaptureLogger(buffer, now, config?.gateway?.log?.level ?? 'info');
      const gateway = gatewayFactory({ config, logger: captureLogger });
      if (gateway === null || typeof gateway !== 'object' || typeof gateway.start !== 'function') {
        throw new Error('gatewayFactory did not return a gateway with start()');
      }
      instance.gateway = gateway;
      await gateway.start();
      instance.state = 'running';
      instance.startedAt = now();
      instance.error = null;
      await refreshOne(id);
      logger.info('workspace started', { workspace: id });
      return summaryFor(id);
    } catch (error) {
      instance.state = 'error';
      instance.error = sanitizeErrorMessage(error);
      logger.error('workspace failed to start', { workspace: id, error: instance.error });
      if (instance.gateway !== null) {
        try {
          await instance.gateway.stop();
        } catch {
          // Best effort: the failed gateway may not be fully constructed.
        }
      }
      instance.gateway = null;
      instance.snapshot = null;
      throw error;
    }
  }

  /** @param {string} id */
  async function stopWorkspaceInternal(id) {
    if (store === null) throw workspaceNotFound(id);
    store.requireWorkspace(id);
    const instance = instances.get(id);
    if (instance === undefined) return summaryFor(id);
    instance.state = 'stopping';
    if (instance.gateway !== null) {
      const gateway = instance.gateway;
      try {
        await gateway.stop();
      } catch (error) {
        logger.warn('workspace stop failed', { workspace: id, error: sanitizeErrorMessage(error) });
      }
    }
    instances.delete(id);
    logger.info('workspace stopped', { workspace: id });
    return summaryFor(id);
  }

  /** @param {string} id */
  async function restartWorkspaceInternal(id) {
    if (store === null) throw workspaceNotFound(id);
    store.requireWorkspace(id);
    await stopWorkspaceInternal(id);
    return startWorkspaceInternal(id);
  }

  // ── public surface ─────────────────────────────────────────────────────────

  /** @type {any} */
  const manager = {
    async init() {
      if (store !== null) return manager;
      store = createConfigStore({
        managerFile,
        managerDataDir,
        logger,
        now,
        provider: options.provider,
      });
      await store.load();
      for (const entry of store.listWorkspaces()) ensureLogBuffer(entry.id);
      return manager;
    },

    /** Start every `autoStart` workspace; failures are isolated. Idempotent. */
    async start() {
      await manager.init();
      if (started) return manager.getState();
      started = true;
      startedAt = now();
      startRefreshTimer();
      const entries = store.listWorkspaces().filter((entry) => entry.autoStart === true);
      for (const entry of entries) {
        try {
          await withWriteLock(() => startWorkspaceInternal(entry.id));
        } catch (error) {
          logger.error('autoStart workspace failed', {
            workspace: entry.id,
            error: sanitizeErrorMessage(error),
          });
        }
      }
      await refresh();
      return manager.getState();
    },

    /** Stop every workspace. Idempotent. */
    async stop() {
      stopRefreshTimer();
      connectService?.dispose();
      if (store !== null) {
        for (const id of [...instances.keys()]) {
          try {
            await withWriteLock(() => stopWorkspaceInternal(id));
          } catch (error) {
            logger.warn('workspace stop failed during manager shutdown', {
              workspace: id,
              error: sanitizeErrorMessage(error),
            });
          }
        }
      }
      await writeChain.catch(() => {});
      started = false;
      startedAt = 0;
      return manager.getState();
    },

    /** Synchronous, JSON-safe aggregated state (§3). */
    /**
     * Session binding activity for the DSH client plugin: lets the browser
     * refresh the host's session list when IM traffic creates or replaces a
     * session. Only running gateways expose their session store; stopped
     * workspaces keep their bindings on disk.
     *
     * @returns {{ revision: string, workspaces: Array<{ id: string, workspaceDir: string, sessions: Array<{ sessionId: string, lastUsedAt: number }> }> }}
     */
    getSessionActivity() {
      const workspaces = [];
      const entries = new Map((store === null ? [] : store.listWorkspaces()).map((entry) => [entry.id, entry]));
      let count = 0;
      let latest = 0;
      for (const [id, instance] of instances) {
        if (instance === undefined || instance.state !== 'running' || instance.gateway === null) continue;
        const store = instance.gateway.sessions;
        if (store === undefined || store === null || typeof store.list !== 'function') continue;
        const sessions = store.list().map((entry) => ({
          sessionId: entry.sessionId,
          lastUsedAt: Number.isFinite(entry.lastUsedAt) ? entry.lastUsedAt : 0,
        }));
        count += sessions.length;
        for (const session of sessions) latest = Math.max(latest, session.lastUsedAt);
        workspaces.push({ id, workspaceDir: entries.get(id)?.workspaceDir ?? '', sessions });
      }
      return { revision: `${count}:${latest}`, workspaces };
    },

    getState() {
      if (store === null) {
        return {
          manager: { pid: process.pid, listen: { ...DEFAULT_LISTEN }, startedAt: 0, workspaceCount: 0 },
          workspaces: [],
        };
      }
      const workspaces = [];
      for (const entry of store.listWorkspaces()) {
        try {
          workspaces.push(summaryFor(entry.id));
        } catch (error) {
          workspaces.push({
            id: entry.id,
            name: entry.name,
            workspaceDir: entry.workspaceDir,
            configFile: entry.configFile,
            autoStart: entry.autoStart,
            state: 'error',
            error: sanitizeErrorMessage(error),
            workspaceCwd: entry.workspaceDir,
            bridge: 'absent',
            sessions: 0,
            channels: [],
            pendingPairings: [],
            http: { port: 0, publicBaseUrl: '' },
          });
        }
      }
      return {
        manager: {
          pid: process.pid,
          listen: { ...store.getListen() },
          startedAt,
          workspaceCount: workspaces.length,
        },
        workspaces,
      };
    },

    /** Refresh cached gateway status and return fresh state (used by the API). */
    async refresh() {
      await manager.init();
      await refresh();
      return manager.getState();
    },

    /** @param {{ name: string, workspaceDir: string, channels?: string[], autoStart?: boolean }} input */
    async addWorkspace(input) {
      await manager.init();
      return withWriteLock(async () => {
        const entry = await store.addWorkspace(input ?? {});
        ensureLogBuffer(entry.id);
        configCache.delete(entry.id);
        if (started && entry.autoStart) {
          try {
            await startWorkspaceInternal(entry.id);
          } catch (error) {
            logger.error('autoStart of new workspace failed', {
              workspace: entry.id,
              error: sanitizeErrorMessage(error),
            });
          }
        }
        return summaryFor(entry.id);
      });
    },

    /**
     * Idempotently register a workspace discovered from the DSH Workspace
     * registry. Existing entries are matched by workspace directory and only
     * renamed when the discovered title changed; new entries get the normal
     * manager config/state layout with all channels disabled.
     *
     * @param {{ path?: string, workspaceDir?: string, title?: string, name?: string, channels?: string[], autoStart?: boolean }} input
     */
    async adoptWorkspace(input = {}) {
      await manager.init();
      const workspaceDir = typeof input.workspaceDir === 'string' && input.workspaceDir.length > 0
        ? input.workspaceDir
        : (typeof input.path === 'string' ? input.path : '');
      if (workspaceDir.length === 0) {
        const error = new Error('workspace path is required');
        error.code = 'INVALID_INPUT';
        throw error;
      }
      const normalize = (value) => value.replace(/[\\/]+$/, '');
      const name = (typeof input.name === 'string' && input.name.trim().length > 0 ? input.name : input.title) ?? '';
      return withWriteLock(async () => {
        const existing = store.listWorkspaces().find((entry) => normalize(entry.workspaceDir) === normalize(workspaceDir));
        if (existing !== undefined) {
          if (name.length > 0 && name !== existing.name) {
            const updated = await store.updateWorkspace(existing.id, { name });
            return summaryFor(updated.id);
          }
          return summaryFor(existing.id);
        }
        const entry = await store.addWorkspace({
          name: name.length > 0 ? name : basenamePath(workspaceDir),
          workspaceDir,
          channels: Array.isArray(input.channels) ? input.channels : [],
          autoStart: input.autoStart === true,
        });
        ensureLogBuffer(entry.id);
        configCache.delete(entry.id);
        if (started && entry.autoStart) {
          try {
            await startWorkspaceInternal(entry.id);
          } catch (error) {
            logger.error('autoStart of adopted workspace failed', {
              workspace: entry.id,
              error: sanitizeErrorMessage(error),
            });
          }
        }
        logger.info('workspace adopted', { workspace: entry.id, workspaceDir });
        return summaryFor(entry.id);
      });
    },

    /** @param {string} id @param {{ name?: string, autoStart?: boolean }} patch */
    async updateWorkspace(id, patch = {}) {
      await manager.init();
      return withWriteLock(async () => {
        const entry = await store.updateWorkspace(id, patch ?? {});
        return summaryFor(entry.id);
      });
    },

    /** @param {string} id */
    async removeWorkspace(id) {
      await manager.init();
      return withWriteLock(async () => {
        const entry = store.requireWorkspace(id);
        connectService?.cancelWorkspace(entry.id);
        await stopWorkspaceInternal(entry.id);
        await store.removeWorkspace(entry.id);
        instances.delete(entry.id);
        configCache.delete(entry.id);
        logBuffers.delete(entry.id);
        logger.info('workspace removed', { workspace: entry.id });
        return { ok: true, workspace: { ...entry } };
      });
    },

    /**
     * Begin a QR connect flow for a workspace channel (§10.2/§10.3).
     * @param {string} id
     * @param {string} channel
     * @param {{ mode?: string }} [connectInput]
     */
    async beginChannelConnect(id, channel, connectInput = {}) {
      await manager.init();
      const channelId = requireConnectChannel(channel);
      const mode = connectInput?.mode ?? 'qr';
      if (mode !== 'qr') {
        throw codedError(`unsupported connect mode "${String(mode)}" (supported: qr)`, 'INVALID_INPUT');
      }
      // Validate under the write lock, but wait for the first QR *outside* it:
      // the provider may spend a moment on the network, and holding the lock
      // would block start/stop/config writes and cancel for that whole time.
      const context = await withWriteLock(async () => {
        const entry = store.requireWorkspace(String(id));
        const config = store.readWorkspaceConfig(entry.id);
        const channelConfig = config.channels?.[channelId] ?? {};
        if (channelConfig.enabled === true) {
          throw codedError(
            `channel "${channelId}" is already enabled; disable it before connecting`,
            'CONFLICT',
          );
        }
        return {
          entry,
          channelConfig,
          stateDir: join(config.gateway.stateDir, 'channels', channelId),
        };
      });
      const service = ensureConnectService();
      return service.begin({
        workspaceId: context.entry.id,
        workspace: {
          id: context.entry.id,
          name: context.entry.name,
          workspaceDir: context.entry.workspaceDir,
          configFile: context.entry.configFile,
          stateDir: context.stateDir,
        },
        channel: channelId,
        channelConfig: context.channelConfig,
        stateDir: context.stateDir,
        mode,
      });
    },

    /**
     * Current or most recent connect flow for a workspace channel.
     * @param {string} id
     * @param {string} channel
     */
    getChannelConnect(id, channel) {
      if (store === null) throw workspaceNotFound(String(id));
      const channelId = requireConnectChannel(channel);
      if (store.getWorkspace(String(id)) === undefined) throw workspaceNotFound(String(id));
      return ensureConnectService().get(String(id), channelId);
    },

    /**
     * Cancel the current flow and guarantee the channel is disabled (§10.2).
     * @param {string} id
     * @param {string} channel
     */
    async cancelChannelConnect(id, channel) {
      await manager.init();
      const channelId = requireConnectChannel(channel);
      return withWriteLock(async () => {
        const entry = store.requireWorkspace(String(id));
        const flow = ensureConnectService().cancel(entry.id, channelId);
        await disableChannelInternal(entry.id, channelId);
        return { ok: true, flow };
      });
    },

    /** @param {string} id */
    async startWorkspace(id) {
      await manager.init();
      return withWriteLock(() => startWorkspaceInternal(String(id)));
    },

    /** @param {string} id */
    async stopWorkspace(id) {
      await manager.init();
      return withWriteLock(() => stopWorkspaceInternal(String(id)));
    },

    /** @param {string} id */
    async restartWorkspace(id) {
      await manager.init();
      return withWriteLock(() => restartWorkspaceInternal(String(id)));
    },

    /**
     * Masked config for the DSH page/manager API (§4).
     * @param {string} id
     */
    getWorkspaceConfig(id) {
      if (store === null) throw workspaceNotFound(String(id));
      return store.getWorkspaceConfig(String(id));
    },

    /**
     * Validate → write → restart when running. Returns the masked config.
     * @param {string} id
     * @param {unknown} config
     */
    async saveWorkspaceConfig(id, config) {
      await manager.init();
      return withWriteLock(async () => {
        const wasRunning = instances.get(String(id))?.state === 'running';
        const masked = await store.saveWorkspaceConfig(String(id), config);
        configCache.delete(String(id));
        if (wasRunning) {
          try {
            await stopWorkspaceInternal(String(id));
            await startWorkspaceInternal(String(id));
          } catch (error) {
            // The config is valid and persisted; the workspace state exposes the
            // restart failure. Keep the save successful so the UI can react.
            logger.error('workspace restart after config save failed', {
              workspace: String(id),
              error: sanitizeErrorMessage(error),
            });
          }
        }
        return masked;
      });
    },

    /** @param {string} id */
    listPairing(id) {
      if (store === null) return [];
      if (store.getWorkspace(String(id)) === undefined) throw workspaceNotFound(String(id));
      return listPairingFor(String(id));
    },

    /**
     * Approve a pending pairing code via the workspace's live gateway.
     * @param {string} id
     * @param {string} code
     */
    async approvePairing(id, code) {
      await manager.init();
      return withWriteLock(async () => {
        store.requireWorkspace(String(id));
        const instance = instances.get(String(id));
        if (instance === undefined || instance.state !== 'running' || instance.gateway?.pairing === undefined) {
          throw workspaceNotRunning(String(id));
        }
        const result = instance.gateway.pairing.approve(String(code));
        if (result?.ok !== true) {
          throw codedError(result?.reason ?? 'pairing code not found or expired', 'INVALID_INPUT');
        }
        return {
          ok: true,
          channel: String(result.entry?.channel ?? ''),
          senderId: String(result.entry?.senderId ?? ''),
        };
      });
    },

    /**
     * Add a sender to the running workspace's allowlist (host-plugin
     * `im_gateway_allow` tool). Mirrors `dsh-im-gateway allow <channel> <sender>`.
     *
     * @param {string} id
     * @param {{ channel: string, senderId: string, name?: string }} input
     * @returns {Promise<{ channel: string, senderId: string, name?: string }>}
     */
    async allowSender(id, input = {}) {
      await manager.init();
      const channel = typeof input?.channel === 'string' ? input.channel.trim() : '';
      const senderId = typeof input?.senderId === 'string' ? input.senderId.trim() : '';
      const name = typeof input?.name === 'string' && input.name.trim() !== '' ? input.name.trim() : undefined;
      if (channel === '') throw codedError('channel is required', 'INVALID_INPUT');
      if (senderId === '') throw codedError('senderId is required', 'INVALID_INPUT');
      return withWriteLock(async () => {
        store.requireWorkspace(String(id));
        const instance = instances.get(String(id));
        if (instance === undefined || instance.state !== 'running' || instance.gateway?.pairing === undefined) {
          throw workspaceNotRunning(String(id));
        }
        const entry = instance.gateway.pairing.allow({
          channel,
          senderId,
          ...(name === undefined ? {} : { name }),
        });
        /** @type {{ channel: string, senderId: string, name?: string }} */
        const result = {
          channel: String(entry?.channel ?? channel),
          senderId: String(entry?.senderId ?? senderId),
        };
        if (typeof entry?.name === 'string' && entry.name !== '') result.name = entry.name;
        return result;
      });
    },

    /**
     * Send one message through a running workspace's channel adapter
     * (host-plugin `im_gateway_send` tool). The `target` is a ReplyTarget and is
     * passed through untouched; failures are returned to the caller without
     * retrying (the tools surface the error).
     *
     * @param {string} id
     * @param {{ channel: string, target: Record<string, any>, text: string, format?: 'plain'|'markdown' }} input
     * @returns {Promise<{ messageId?: string }>}
     */
    async sendMessage(id, input = {}) {
      await manager.init();
      const channel = typeof input?.channel === 'string' ? input.channel.trim() : '';
      const text = typeof input?.text === 'string' ? input.text : '';
      const format = input?.format === 'markdown' ? 'markdown' : 'plain';
      const target = input?.target;
      if (channel === '') throw codedError('channel is required', 'INVALID_INPUT');
      if (text.trim() === '') throw codedError('text is required', 'INVALID_INPUT');
      if (target === null || typeof target !== 'object' || Array.isArray(target)) {
        throw codedError('target is required', 'INVALID_INPUT');
      }
      store.requireWorkspace(String(id));
      const instance = instances.get(String(id));
      if (instance === undefined || instance.state !== 'running') {
        throw workspaceNotRunning(String(id));
      }
      const adapters = instance.gateway?.adapterMap;
      const adapter = adapters !== undefined && typeof adapters.get === 'function'
        ? adapters.get(channel)
        : undefined;
      if (adapter === undefined || typeof adapter.send !== 'function') {
        throw codedError(`channel "${channel}" is not running`, 'CHANNEL_NOT_RUNNING');
      }
      // No retry: the adapter contract already guarantees chunking/formatting;
      // a transport failure is reported to the tool caller as-is.
      const result = await adapter.send(target, { text, format });
      return result !== null && typeof result === 'object' && typeof result.messageId === 'string'
        ? { messageId: result.messageId }
        : {};
    },

    /**
     * Recent captured gateway log lines (oldest → newest), redacted.
     * @param {string} id
     * @param {number} [lines]
     * @returns {string[]}
     */
    getLogs(id, lines = DEFAULT_LOG_LINES) {
      if (store === null) return [];
      if (store.getWorkspace(String(id)) === undefined) throw workspaceNotFound(String(id));
      let count = Number(lines);
      if (!Number.isFinite(count) || count <= 0) count = DEFAULT_LOG_LINES;
      count = Math.min(Math.floor(count), LOG_BUFFER_LIMIT);
      return ensureLogBuffer(String(id)).toArray().slice(-count);
    },

    /** Configured loopback listen address for the manager HTTP API. */
    get listen() {
      if (store === null) return { ...DEFAULT_LISTEN };
      return store.getListen();
    },
  };

  return manager;
}
