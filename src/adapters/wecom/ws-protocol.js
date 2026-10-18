/**
 * WeCom 智能机器人 long-connection (WebSocket) protocol.
 *
 * Frames are JSON `{ cmd, headers: { req_id }, body }`. The server identifies
 * responses purely by the `req_id` prefix:
 *  - developer → platform: `aibot_subscribe`, `ping`, `aibot_respond_msg`,
 *    `aibot_respond_welcome_msg`, `aibot_respond_update_msg`, `aibot_send_msg`
 *  - platform → developer: `aibot_msg_callback`, `aibot_event_callback`
 *  - ack frames have no `cmd`; `headers.req_id` carries the original request id
 *    (the platform echoes it) and `errcode`/`errmsg` carry the result.
 *
 * All builders are pure functions so they can be unit-tested without a socket.
 */
import { randomBytes } from 'node:crypto';

/** Built-in WeCom long-connection endpoint. */
export const DEFAULT_WECOM_WS_URL = 'wss://openws.work.weixin.qq.com';

/** Maximum bytes accepted in a single stream reply snapshot (`stream.content`). */
export const MAX_STREAM_CONTENT_BYTES = 20480;

export const WsCmd = Object.freeze({
  SUBSCRIBE: 'aibot_subscribe',
  HEARTBEAT: 'ping',
  RESPONSE: 'aibot_respond_msg',
  RESPONSE_WELCOME: 'aibot_respond_welcome_msg',
  RESPONSE_UPDATE: 'aibot_respond_update_msg',
  SEND_MSG: 'aibot_send_msg',
  CALLBACK: 'aibot_msg_callback',
  EVENT_CALLBACK: 'aibot_event_callback',
});

const REQ_ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/**
 * Generate a request id the way the platform SDK does: `<prefix>_<ms>_<random>`,
 * so acks can be routed by prefix even before the pending map is consulted.
 * @param {string} prefix
 * @returns {string}
 */
export function createReqId(prefix) {
  const bytes = randomBytes(8);
  let suffix = '';
  for (const byte of bytes) suffix += REQ_ID_ALPHABET[byte % REQ_ID_ALPHABET.length];
  return `${prefix}_${Date.now()}_${suffix}`;
}

/**
 * @param {{ botId: string, secret: string }} params
 * @returns {{ cmd: string, headers: { req_id: string }, body: { bot_id: string, secret: string } }}
 */
export function buildSubscribeFrame(params) {
  return {
    cmd: WsCmd.SUBSCRIBE,
    headers: { req_id: createReqId(WsCmd.SUBSCRIBE) },
    body: { bot_id: params.botId, secret: params.secret },
  };
}

/**
 * @param {string} [reqId]
 * @returns {{ cmd: string, headers: { req_id: string } }}
 */
export function buildPingFrame(reqId = createReqId(WsCmd.HEARTBEAT)) {
  return { cmd: WsCmd.HEARTBEAT, headers: { req_id: reqId } };
}

/**
 * Reply with a stream message (text/markdown). `finish: true` finalizes it.
 * The same `req_id` as the inbound callback is mandatory; `stream.id` tells the
 * client which bubble to refresh.
 * @param {{ reqId: string, streamId: string, content?: string, finish?: boolean }} params
 * @returns {{ cmd: string, headers: { req_id: string }, body: { msgtype: 'stream', stream: { id: string, finish: boolean, content?: string } } }}
 */
export function buildStreamReplyFrame(params) {
  const stream = {
    id: params.streamId,
    finish: params.finish !== false,
    ...(params.content !== undefined && String(params.content) !== ''
      ? { content: truncateUtf8Bytes(String(params.content), MAX_STREAM_CONTENT_BYTES) }
      : {}),
  };
  return {
    cmd: WsCmd.RESPONSE,
    headers: { req_id: params.reqId },
    body: { msgtype: 'stream', stream },
  };
}

/**
 * Proactive message to an already-activated conversation (`aibot_send_msg`).
 * Only markdown is supported by the platform for proactive text messages.
 * @param {{ chatId: string, content: string }} params
 * @returns {{ cmd: string, headers: { req_id: string }, body: { chatid: string, msgtype: 'markdown', markdown: { content: string } } }}
 */
export function buildSendMarkdownFrame(params) {
  return {
    cmd: WsCmd.SEND_MSG,
    headers: { req_id: createReqId(WsCmd.SEND_MSG) },
    body: {
      chatid: params.chatId,
      msgtype: 'markdown',
      markdown: { content: truncateUtf8Bytes(String(params.content ?? ''), MAX_STREAM_CONTENT_BYTES) },
    },
  };
}

/**
 * Classify a req_id by its command prefix. Command names themselves contain
 * underscores (`aibot_subscribe`), so a naive split("_") is wrong.
 * @param {string} reqId
 * @returns {string} matching `WsCmd` value, or the first segment for unknown ids
 */
export function reqIdPrefix(reqId) {
  const value = String(reqId ?? '');
  for (const cmd of Object.values(WsCmd)) {
    if (value.startsWith(cmd)) return cmd;
  }
  return value.split('_')[0] ?? '';
}

/**
 * Parse a raw WebSocket text frame. Some servers prepend control characters;
 * discard them, matching the reference SDK behavior.
 * @param {string} raw
 * @returns {Record<string, any> | null}
 */
export function parseWsFrame(raw) {
  const cleaned = String(raw ?? '').replace(/[\x00-\x08\x0B-\x0D\x0E-\x1F]/g, '');
  if (!cleaned.trim()) return null;
  try {
    const parsed = JSON.parse(cleaned);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Normalize an inbound callback frame.
 * @param {Record<string, any>} frame
 * @returns {{ kind: 'message'|'event', reqId: string, msg: Record<string, any>, msgId?: string, eventType?: string } | null}
 */
export function normalizeWsCallback(frame) {
  const cmd = String(frame?.cmd ?? '').trim();
  if (cmd !== WsCmd.CALLBACK && cmd !== WsCmd.EVENT_CALLBACK) return null;
  const reqId = String(frame?.headers?.req_id ?? '').trim();
  const body = frame?.body;
  if (!reqId || !body || typeof body !== 'object') return null;
  const msgId = typeof body.msgid === 'string' ? body.msgid.trim() || undefined : undefined;
  if (cmd === WsCmd.CALLBACK) return { kind: 'message', reqId, msg: body, msgId };
  const eventType = String(body.event?.eventtype ?? '').trim().toLowerCase() || undefined;
  return { kind: 'event', reqId, msg: body, msgId, eventType };
}

/**
 * True when an event callback says "a new connection replaced this one".
 * @param {Record<string, any>} frame
 * @returns {boolean}
 */
export function isDisconnectedEvent(frame) {
  if (String(frame?.cmd ?? '') !== WsCmd.EVENT_CALLBACK) return false;
  const body = frame?.body;
  return String(body?.event?.eventtype ?? '').toLowerCase() === 'disconnected_event';
}

/**
 * Truncate a UTF-8 string to at most `maxBytes` without splitting code points.
 * @param {string} text
 * @param {number} maxBytes
 * @returns {string}
 */
export function truncateUtf8Bytes(text, maxBytes) {
  const value = String(text ?? '');
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let bytes = 0;
  let out = '';
  for (const char of value) {
    const size = Buffer.byteLength(char, 'utf8');
    if (bytes + size > maxBytes) break;
    bytes += size;
    out += char;
  }
  return out;
}
