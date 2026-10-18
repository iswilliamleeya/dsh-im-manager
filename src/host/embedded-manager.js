/**
 * Start (or attach to) the multi-workspace manager from inside another host
 * process — currently the DSH host plugin (`mode: "manager"`).
 *
 * Responsibilities:
 *   - refuse to run inside an SDK runtime (`--profile sdk`): the gateway spawns
 *     its own SDK runtime, so auto-starting a manager there would recurse;
 *   - take the single-instance lock before creating anything;
 *   - attach to an already-running manager (same manager file) instead of
 *     starting a duplicate;
 *   - start the manager HTTP API, the manager lifecycle, and optionally every
 *     configured workspace;
 *   - expose an idempotent stop() used by the host plugin's dispose hook.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

import { createManager } from '../manager/manager.js';
import { createManagerApi } from '../manager/api.js';
import {
  acquireManagerLock,
  isPidAlive,
  managerLockPath,
  readManagerLock,
  releaseManagerLock,
  updateManagerLock,
} from './manager-lock.js';

const noopLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return this;
  },
};

/** Default manager file: `~/.dsh-im-manager/manager.json`. */
export function defaultManagerFile() {
  return join(homedir(), '.dsh-im-manager', 'manager.json');
}

/**
 * True when this process is a DSH SDK runtime (`--profile sdk`).
 * @param {string[]} [argv]
 * @param {Record<string, string | undefined>} [env]
 */
export function isSdkRuntime(argv = process.argv, env = process.env) {
  if (env.DSH_PROFILE === 'sdk') return true;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--profile' && argv[index + 1] === 'sdk') return true;
    if (value === '--profile=sdk') return true;
  }
  return false;
}

/** @param {string} host @param {number} port @param {typeof fetch} fetchImpl */
async function probeHealth(host, port, fetchImpl) {
  if (!Number.isInteger(port) || port <= 0) return false;
  try {
    const response = await fetchImpl(`http://${host}:${port}/api/health`, {
      signal: AbortSignal.timeout(800),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * @typedef {object} EmbeddedManager
 * @property {'owned' | 'attach'} mode
 * @property {string} baseUrl
 * @property {number} port
 * @property {any} manager
 * @property {any} api
 * @property {object | null} lock
 * @property {() => Promise<void>} stop
 */

/**
 * @param {object} options
 * @param {string} [options.managerFile]
 * @param {string} [options.host]
 * @param {number} [options.port]
 * @param {any} [options.logger]
 * @param {boolean} [options.startAllWorkspaces]
 * @param {Function} [options.managerFactory]
 * @param {Function} [options.apiFactory]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {() => boolean} [options.sdkRuntimeCheck]
 * @param {() => number} [options.now]
 * @returns {Promise<EmbeddedManager>}
 */
export async function startEmbeddedManager(options = {}) {
  const managerFile = options.managerFile ?? defaultManagerFile();
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 8788;
  const logger = options.logger ?? noopLogger;
  const now = options.now ?? Date.now;
  const sdkRuntimeCheck = options.sdkRuntimeCheck ?? (() => isSdkRuntime());
  const managerFactory = options.managerFactory ?? ((input) => createManager(input));
  const apiFactory = options.apiFactory ?? ((input) => createManagerApi(input));
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  if (sdkRuntimeCheck()) {
    throw new Error(
      'im-manager: manager mode cannot start inside a DSH SDK runtime (--profile sdk); '
        + 'install the plugin in the desktop/web profile instead',
    );
  }

  const existing = readManagerLock(managerFile);
  if (existing !== null && isPidAlive(existing.pid)) {
    logger.info?.('manager already running; attaching', {
      pid: existing.pid,
      host: existing.host,
      port: existing.port,
    });
    return attachResult(existing);
  }

  const acquired = acquireManagerLock(managerFile, { host, port, now: now() });
  if (!acquired.acquired) {
    const owner = acquired.existing;
    logger.info?.('manager lock held by another process; attaching', {
      pid: owner?.pid,
      host: owner?.host,
      port: owner?.port,
    });
    return attachResult(owner);
  }

  let manager = null;
  /** @type {any} */
  let api = null;
  let stopped = false;
  try {
    manager = managerFactory({ managerFile, logger });
    await manager.init();
    api = apiFactory({ manager, logger });
    let listen;
    try {
      listen = await api.start({ host, port });
    } catch (error) {
      // Port already bound by a manager that did not take the lock (older
      // version / manual start): attach to it instead of failing the host.
      if (await probeHealth(host, port, fetchImpl)) {
        logger.warn?.('manager port is busy with a healthy manager; attaching instead of starting', {
          host,
          port,
        });
        await api.stop?.().catch?.(() => {});
        await manager.stop?.().catch?.(() => {});
        releaseManagerLock(acquired);
        return attachResult({
          version: 1,
          pid: 0,
          token: '',
          host,
          port,
          managerFile,
          startedAt: 0,
        });
      }
      throw error;
    }

    updateManagerLock(acquired, { host: listen.host, port: listen.port });
    await manager.start();

    if (options.startAllWorkspaces === true) {
      const state = manager.getState();
      for (const workspace of state.workspaces) {
        if (workspace.state === 'running' || workspace.state === 'starting') continue;
        try {
          await manager.startWorkspace(workspace.id);
        } catch (error) {
          logger.warn?.('embedded manager: workspace failed to start', {
            workspace: workspace.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    const baseUrl = `http://${listen.host}:${listen.port}`;
    logger.info?.('embedded manager started', {
      mode: 'owned',
      baseUrl,
      managerFile,
      lock: managerLockPath(managerFile),
    });

    return {
      mode: 'owned',
      baseUrl,
      port: listen.port,
      manager,
      api,
      lock: acquired.record,
      async stop() {
        if (stopped) return;
        stopped = true;
        try {
          await api?.stop?.();
        } catch (error) {
          logger.warn?.('embedded manager: API stop failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
        try {
          await manager?.stop?.();
        } catch (error) {
          logger.warn?.('embedded manager: manager stop failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
        releaseManagerLock(acquired);
      },
    };
  } catch (error) {
    try {
      await api?.stop?.();
    } catch {
      // best effort
    }
    try {
      await manager?.stop?.();
    } catch {
      // best effort
    }
    releaseManagerLock(acquired);
    throw error;
  }
}

/** @param {import('./manager-lock.js').ManagerLockRecord | null} lock */
function attachResult(lock) {
  const host = lock?.host ?? '127.0.0.1';
  const port = lock?.port ?? 0;
  return {
    mode: /** @type {const} */ ('attach'),
    baseUrl: `http://${host}:${port}`,
    port,
    manager: null,
    api: null,
    lock,
    async stop() {
      // Attached managers are owned by another process; never stop them.
    },
  };
}
