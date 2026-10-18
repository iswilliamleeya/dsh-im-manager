/**
 * DingTalk Stream transport.
 *
 * The `dingtalk-stream` SDK does NOT acknowledge callbacks automatically: a
 * `registerCallbackListener` handler returns `void`, and the adapter must call
 * `client.socketCallBackResponse(headers.messageId, { success: true })` to stop
 * the server from redelivering (it retries after ~60s). We therefore ACK
 * synchronously on receipt and emit to the gateway asynchronously.
 *
 * Everything here is injectable: tests pass a fake client factory that records
 * the registered listener and ACKs.
 */
import { DEFAULT_UA } from './config.js';

/** Robot message callback topic (`/v1.0/im/bot/messages/get`). */
export const TOPIC_ROBOT = '/v1.0/im/bot/messages/get';

/**
 * Load the optional `dingtalk-stream` package lazily so a missing SDK only
 * disables this channel.
 *
 * @returns {Promise<any>}
 */
export async function loadStreamSdk() {
  try {
    return await import('dingtalk-stream');
  } catch (error) {
    throw new Error(
      'dingtalk-stream 未安装（Stream 模式需要该 SDK）：请在 dsh-im-manager 目录执行 `npm install`。'
        + `原始错误：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * The official package exports `DWClient`; tolerate forks that rename it.
 *
 * @param {any} sdk
 * @returns {new (...args: any[]) => any}
 */
export function resolveStreamClientClass(sdk) {
  const candidates = [sdk?.DWClient, sdk?.DingTalkStreamClient, sdk?.default?.DWClient, sdk?.default];
  const constructor = candidates.find((candidate) => typeof candidate === 'function');
  if (constructor === undefined) {
    throw new Error('dingtalk-stream SDK 未导出 DWClient/DingTalkStreamClient，无法建立 Stream 连接');
  }
  return constructor;
}

/**
 * Create the real SDK client.
 *
 * @param {{
 *   clientId: string,
 *   clientSecret: string,
 *   ua?: string,
 *   keepAlive?: boolean,
 * }} options
 * @returns {Promise<any>}
 */
export async function createDefaultStreamClient(options) {
  const sdk = await loadStreamSdk();
  const StreamClient = resolveStreamClientClass(sdk);
  return new StreamClient({
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    ua: options.ua || DEFAULT_UA,
    ...(typeof options.keepAlive === 'boolean' ? { keepAlive: options.keepAlive } : {}),
  });
}

/**
 * ACK one downstream callback so DingTalk does not redeliver it.
 *
 * @param {any} client
 * @param {string} messageId
 * @param {{ warn?: (...args: any[]) => void }} [log]
 * @returns {boolean}
 */
export function acknowledgeStreamMessage(client, messageId, log) {
  if (typeof messageId !== 'string' || messageId.length === 0) return false;
  if (client === null || typeof client !== 'object' || typeof client.socketCallBackResponse !== 'function') {
    return false;
  }
  try {
    client.socketCallBackResponse(messageId, { success: true });
    return true;
  } catch (error) {
    log?.warn?.('dingtalk stream ACK failed', { messageId, error });
    return false;
  }
}

/**
 * Register the robot-message listener and open the Stream connection.
 *
 * @param {{
 *   client: any,
 *   log?: any,
 *   onPayload: (payload: any) => Promise<void> | void,
 *   topic?: string,
 * }} options
 * @returns {Promise<{ disconnect: () => Promise<void> }>}
 */
export async function startStreamTransport(options) {
  const { client } = options;
  const topic = options.topic ?? TOPIC_ROBOT;
  const log = options.log;
  if (client === null || typeof client !== 'object') throw new Error('dingtalk stream client is not available');
  if (typeof client.registerCallbackListener !== 'function') {
    throw new Error('dingtalk stream client does not implement registerCallbackListener()');
  }

  /** @param {any} payload */
  const handler = (payload) => {
    const messageId = payload?.headers?.messageId;
    // ACK first, synchronously: the platform retries un-ACKed callbacks, and the
    // agent turn can take much longer than the retry window.
    acknowledgeStreamMessage(client, messageId, log);
    Promise.resolve()
      .then(() => options.onPayload(payload))
      .catch((error) => log?.error?.('dingtalk stream message handling failed', { error }));
  };

  client.registerCallbackListener(topic, handler);
  if (typeof client.connect !== 'function') {
    throw new Error('dingtalk stream client does not implement connect()');
  }
  await client.connect();

  return {
    async disconnect() {
      if (typeof client.disconnect === 'function') {
        try {
          client.disconnect();
        } catch (error) {
          log?.warn?.('dingtalk stream disconnect failed', { error });
        }
      }
    },
  };
}
