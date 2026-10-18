/**
 * Public programmatic API for dsh-im-manager.
 *
 * Everything a test, a CLI, or a DSH host plugin needs is exported here. The
 * core is usable without the DSH bridge: inject a bridge (real or fake) into
 * `createGateway`.
 */
import { loadConfig } from './core/config.js';
import { createLogger } from './core/logger.js';
import { createGateway } from './core/gateway.js';

export {
  loadConfig,
  resolveConfigPath,
  defaultConfig,
  validate,
  resolveAccess,
  enabledChannels,
  CHANNEL_IDS,
} from './core/config.js';
export { createLogger, silentLogger } from './core/logger.js';
export { createGateway, extractAssistantText } from './core/gateway.js';
export { loadAdapter, loadAdapterModule, ADAPTER_IDS } from './adapters/registry.js';
export { createManager } from './manager/manager.js';
export { createManagerApi } from './manager/api.js';
export { createConfigStore } from './manager/config-store.js';
export { resolveDshCommand } from './core/dsh-command.js';
export { chunkText, markdownToPlain } from './core/text.js';

/**
 * Create the DSH SDK bridge (lazy import; see docs/contracts.md §4).
 * @param {Record<string, any>} options
 * @returns {Promise<import('./core/types.js').DshBridge>}
 */
export async function createDshBridge(options) {
  const module = await import('./bridge/dsh-sdk.js');
  return module.createDshBridge(options);
}

/**
 * Load config and construct the gateway, unstarted.
 *
 * @param {{
 *   configPath?: string,
 *   env?: NodeJS.ProcessEnv,
 *   logger?: import('./core/types.js').Logger,
 * }} [options]
 * @returns {Promise<{
 *   gateway: ReturnType<typeof createGateway>,
 *   config: Record<string, any>,
 *   path: string | null,
 *   warnings: string[],
 *   logger: import('./core/types.js').Logger,
 * }>}
 */
export async function prepareGateway(options = {}) {
  const loaded = loadConfig({ configPath: options.configPath, env: options.env });
  const logger = options.logger ?? createLogger({ level: loaded.config.gateway.log.level });
  for (const warning of loaded.warnings) logger.warn('config warning', { detail: warning });
  const gateway = createGateway({ config: loaded.config, logger });
  return { gateway, config: loaded.config, path: loaded.path, warnings: loaded.warnings, logger };
}

/**
 * Load config, construct, and start the gateway.
 * @param {Parameters<typeof prepareGateway>[0]} [options]
 */
export async function startGateway(options = {}) {
  const prepared = await prepareGateway(options);
  await prepared.gateway.start();
  return prepared;
}

// ── DSH host plugin surface ────────────────────────────────────────────────
// The package main is the programmatic library, but the DSH loader imports this
// same entry for the patch row `name: dsh-im-manager`. The plugin implementation
// imports in-box packages (`@deepseek-ai/dsh-tools`, `schemastery`), so it is
// loaded lazily: standalone CLI/test imports never touch the host runtime.

/** Stable Loader identity. */
export const name = 'im-manager';

/** Services this plugin consumes. */
export const inject = ['tools'];

/**
 * Mount the gateway/manager plugin. Thin wrapper so the in-box imports stay
 * lazy. Every field is forwarded explicitly: the Loader hands us the raw patch
 * row config, and dropping `mode`/`managerFile` here would silently downgrade a
 * manager-mode install to the legacy single-gateway mode.
 * @param {any} ctx
 * @param {{ mode?: string, configFile?: string, managerFile?: string, host?: string, port?: number, autoStart?: boolean, startAllWorkspaces?: boolean }} [config]
 */
export async function apply(ctx, config = {}) {
  const host = await import('./dsh-plugin.js');
  return host.apply(ctx, {
    mode: typeof config.mode === 'string' && config.mode.length > 0 ? config.mode : 'gateway',
    configFile: typeof config.configFile === 'string' ? config.configFile : '',
    managerFile: typeof config.managerFile === 'string' ? config.managerFile : '',
    host: typeof config.host === 'string' && config.host.length > 0 ? config.host : '127.0.0.1',
    port: Number.isInteger(config.port) ? config.port : 8788,
    autoStart: config.autoStart !== false,
    startAllWorkspaces: config.startAllWorkspaces === true,
  });
}
