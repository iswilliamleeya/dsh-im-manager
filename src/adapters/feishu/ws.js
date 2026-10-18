/**
 * Feishu / Lark long-connection (`ws`) mode.
 *
 * Uses the Lark SDK's `WSClient` + `EventDispatcher`: the app opens an
 * outbound WebSocket to Feishu's gateway, so no public URL / TLS certificate
 * is required. Feishu pushes `im.message.receive_v1` events over that socket;
 * the SDK dispatches them to the handler registered here.
 *
 * `WSClient.start()` is fire-and-forget: it resolves before the socket is
 * connected and reconnects internally with backoff. Connection lifecycle is
 * surfaced through `onState` (and `health()`), not through `start()` throwing.
 */

import { createSdkLogger, resolveSdkDomain } from './sdk.js';

/** @typedef {'connected' | 'connecting' | 'degraded' | 'disconnected'} WsState */

/**
 * Create the EventDispatcher used by both modes, registering the message
 * receive handler.
 *
 * @param {{
 *   lark: any,
 *   config: Record<string, any>,
 *   log?: import('../../core/types.js').Logger,
 *   onEvent: (payload: unknown, source: 'ws') => Promise<void>,
 * }} options
 * @returns {any}
 */
export function createEventDispatcher({ lark, config, log, onEvent }) {
  const logger = createSdkLogger(log, [config.appSecret, config.encryptKey, config.verificationToken]);
  const dispatcher = new lark.EventDispatcher({
    verificationToken: config.verificationToken,
    encryptKey: config.encryptKey,
    loggerLevel: lark.LoggerLevel?.error ?? 1,
    logger,
  });
  dispatcher.register({
    'im.message.receive_v1': (payload) => onEvent(payload, 'ws'),
  });
  return dispatcher;
}

/**
 * Start the WebSocket client.
 *
 * @param {{
 *   lark: any,
 *   config: Record<string, any>,
 *   log?: import('../../core/types.js').Logger,
 *   createWsClient?: (options: { config: Record<string, any>, eventDispatcher: any, sdkOptions: Record<string, any>, log?: import('../../core/types.js').Logger, onState: (state: WsState, detail?: string) => void }) => any,
 *   onEvent: (payload: unknown, source: 'ws') => Promise<void>,
 *   onState: (state: WsState, detail?: string) => void,
 * }} options
 * @returns {Promise<{ wsClient: any, eventDispatcher: any }>}
 */
export async function startWebSocket({ lark, config, log, createWsClient, onEvent, onState }) {
  const eventDispatcher = createEventDispatcher({ lark, config, log, onEvent });

  /** @type {Record<string, any>} */
  const sdkOptions = {
    appId: config.appId,
    appSecret: config.appSecret,
    domain: resolveSdkDomain(config.domain, lark),
    loggerLevel: lark.LoggerLevel?.error ?? 1,
    logger: createSdkLogger(log, [config.appSecret, config.encryptKey, config.verificationToken]),
    onReady: () => onState('connected'),
    onReconnecting: () => onState('connecting', 'reconnecting'),
    onReconnected: () => onState('connected', 'reconnected'),
    onError: (error) => onState('degraded', error instanceof Error ? error.message : String(error)),
  };

  const wsClient = typeof createWsClient === 'function'
    ? createWsClient({ config, eventDispatcher, sdkOptions, log, onState })
    : new lark.WSClient(sdkOptions);

  if (typeof wsClient?.start !== 'function') {
    throw new Error('feishu: WebSocket client does not implement start()');
  }
  await wsClient.start({ eventDispatcher });
  return { wsClient, eventDispatcher };
}

/**
 * Stop the WebSocket client. Safe to call on a client that never connected.
 *
 * @param {any} wsClient
 * @param {import('../../core/types.js').Logger} [log]
 * @returns {Promise<void>}
 */
export async function stopWebSocket(wsClient, log) {
  if (wsClient === null || wsClient === undefined) return;
  try {
    if (typeof wsClient.close === 'function') {
      await wsClient.close({ force: true });
    } else if (typeof wsClient.stop === 'function') {
      await wsClient.stop();
    }
  } catch (error) {
    log?.warn?.('feishu websocket close failed', { error });
  }
}

/**
 * Map the SDK's connection status onto the gateway's ChannelHealth states.
 *
 * @param {any} wsClient
 * @returns {{ state: WsState, detail?: string } | null}
 */
export function readWsConnectionState(wsClient) {
  if (wsClient === null || wsClient === undefined || typeof wsClient.getConnectionStatus !== 'function') {
    return null;
  }
  try {
    const status = wsClient.getConnectionStatus();
    switch (status?.state) {
      case 'connected':
        return { state: 'connected' };
      case 'connecting':
      case 'reconnecting':
        return { state: 'connecting', detail: status.state };
      case 'failed':
        return { state: 'degraded', detail: 'websocket failed' };
      default:
        return { state: 'disconnected', detail: status?.state };
    }
  } catch {
    return null;
  }
}
