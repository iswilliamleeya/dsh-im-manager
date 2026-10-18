/**
 * Multi-workspace manager: config store, lifecycle, local HTTP API.
 *
 * Typical use (see `src/cli.js`):
 *
 *   const manager = createManager({ managerFile, logger });
 *   await manager.init();
 *   const api = createManagerApi({ manager, logger });
 *   const listen = await api.start({ host: manager.listen.host, port: manager.listen.port });
 *   await manager.start(); // starts autoStart workspaces
 *   ...
 *   await api.stop();
 *   await manager.stop();
 */
export { createManager, sanitizeErrorMessage } from './manager.js';
export { createManagerApi } from './api.js';
export {
  CONNECT_CHANNELS,
  classifyConnectError,
  createChannelConnectProviders,
  createChannelConnectService,
  isConnectSupportedChannel,
  resolveFeishuConnectDomain,
  sanitizeConnectResult,
  toQrDataUrl,
} from './channel-connect.js';
export {
  createConfigStore,
  createWorkspaceConfig,
  isValidWorkspaceId,
  isSecretPlaceholder,
  maskConfig,
  maskSecretValue,
  slugifyWorkspaceId,
} from './config-store.js';
