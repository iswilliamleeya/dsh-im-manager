/**
 * WeCom inbound normalization: platform payload → InboundMessage contract.
 *
 * Two transports share this module:
 *  - ws:     智能机器人 long connection callbacks (`aibot_msg_callback`)
 *  - webhook: 自建应用 (and compatible 群机器人 XML) encrypted callbacks
 *
 * Access control (allowFrom / groups / requireMention) is core's job; the
 * adapter only reports `mentioned` and strips the bot mention from `text`.
 */
import { createHash, randomBytes } from 'node:crypto';

import { childText, firstText, pickChild, asText } from './xml.js';

export const CHANNEL_ID = 'wecom';

/**
 * Convert a platform timestamp to epoch milliseconds.
 * WeCom sends seconds; tolerate milliseconds and invalid input.
 * @param {unknown} value
 * @returns {number}
 */
export function normalizeTimestamp(value) {
  const raw = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(raw) || raw <= 0) return Date.now();
  return raw < 1e12 ? raw * 1000 : raw;
}

/**
 * Deterministic fallback message id when the platform does not provide one.
 * @param {...unknown} parts
 * @returns {string}
 */
export function generateStableMessageId(...parts) {
  const hash = createHash('sha1').update(parts.map((part) => String(part ?? '')).join('\u0000')).digest('hex');
  return `gen_${hash.slice(0, 32)}`;
}

/**
 * @returns {string} 16 random bytes as hex
 */
export function createStreamId() {
  return randomBytes(16).toString('hex');
}

/**
 * Collect a mention list from a callback body, if the platform supplies one.
 * @param {Record<string, any> | null | undefined} msg
 * @returns {string[]}
 */
function collectMentions(msg) {
  const candidates = [msg?.mentions, msg?.mention, msg?.mention_list, msg?.mentionList];
  /** @type {string[]} */
  const out = [];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    for (const entry of candidate) {
      if (typeof entry === 'string') {
        if (entry.trim()) out.push(entry.trim());
      } else if (entry && typeof entry === 'object') {
        const id = firstText(entry.userid, entry.userId, entry.id, entry.name, entry.user_name);
        if (id) out.push(id);
      }
    }
  }
  return out;
}

/**
 * Decide whether the bot was mentioned.
 * DM is always "mentioned"; in groups prefer an explicit mention list, then
 * `@<botName>`, then any `@token` in the text (matches the reference adapter).
 * @param {{ text: string, conversationType: 'dm'|'group', botName?: string, msg?: Record<string, any> }} params
 * @returns {boolean}
 */
export function detectMentioned(params) {
  if (params.conversationType !== 'group') return true;
  if (collectMentions(params.msg).length > 0) return true;
  const name = String(params.botName ?? '').trim();
  if (name) return params.text.includes(`@${name}`);
  return /@[^\s@]+/.test(params.text);
}

/**
 * Remove the bot mention from the text. Other users' @mentions are preserved.
 * @param {string} text
 * @param {{ conversationType: 'dm'|'group', botName?: string }} params
 * @returns {string}
 */
export function stripBotMention(text, params) {
  let out = String(text ?? '');
  if (params.conversationType === 'group') {
    const name = String(params.botName ?? '').trim();
    if (name) {
      out = out.split(`@${name}`).join(' ');
    } else {
      // Without a configured bot name only a leading @token is safe to remove.
      out = out.replace(/^\s*@[^\s@]+\s*/, '');
    }
  }
  return out.replace(/[ \t]{2,}/g, ' ').trim();
}

/**
 * Text extraction for ws callbacks (text / mixed / voice transcription).
 * @param {Record<string, any>} msg
 * @returns {string}
 */
export function extractWsText(msg) {
  const msgtype = String(msg?.msgtype ?? '').toLowerCase();
  if (msgtype === 'text') return asText(msg?.text?.content);
  if (msgtype === 'voice') return asText(msg?.voice?.content);
  if (msgtype === 'mixed') {
    const items = Array.isArray(msg?.mixed?.msg_item) ? msg.mixed.msg_item : [];
    return items
      .filter((item) => String(item?.msgtype ?? '').toLowerCase() === 'text')
      .map((item) => asText(item?.text?.content))
      .filter((part) => part !== '')
      .join('\n');
  }
  return '';
}

/**
 * Attachments from a ws callback.
 * @param {Record<string, any>} msg
 * @returns {import('../../core/types.js').Attachment[]}
 */
export function extractWsAttachments(msg) {
  const msgtype = String(msg?.msgtype ?? '').toLowerCase();
  /** @type {any[]} */
  const attachments = [];
  const pushMedia = (kind, node, fallbackName) => {
    if (!node || typeof node !== 'object') return;
    const url = String(node.url ?? '').trim();
    const aesKey = String(node.aeskey ?? node.aesKey ?? '').trim();
    if (!url && !aesKey) return;
    const name = String(node.filename ?? node.file_name ?? node.name ?? fallbackName ?? '').trim();
    attachments.push({
      kind,
      ...(url ? { url } : {}),
      ...(name ? { name } : {}),
      ...(aesKey ? { aesKey } : {}),
    });
  };
  if (msgtype === 'image') pushMedia('image', msg?.image, 'image');
  else if (msgtype === 'file') pushMedia('file', msg?.file, 'file');
  else if (msgtype === 'video') pushMedia('video', msg?.video, 'video');
  else if (msgtype === 'mixed') {
    const items = Array.isArray(msg?.mixed?.msg_item) ? msg.mixed.msg_item : [];
    for (const item of items) {
      if (String(item?.msgtype ?? '').toLowerCase() === 'image') pushMedia('image', item?.image, 'image');
    }
  }
  return attachments;
}

/**
 * Attachments from a decrypted webhook callback.
 * media_id / pic_url are preserved in addition to the contract fields.
 * @param {Record<string, any>} message
 * @returns {any[]}
 */
export function extractWebhookAttachments(message) {
  const msgtype = String(firstText(pickChild(message, 'MsgType'), pickChild(message, 'msgtype'))).toLowerCase();
  const picUrl = firstText(pickChild(message, 'PicUrl'), pickChild(message, 'picUrl'));
  const mediaId = firstText(pickChild(message, 'MediaId'), pickChild(message, 'mediaId'));
  const thumbMediaId = firstText(pickChild(message, 'ThumbMediaId'));
  const fileName = firstText(pickChild(message, 'FileName'), pickChild(message, 'Title'));
  const format = firstText(pickChild(message, 'Format'));
  const push = (kind, extra = {}) => {
    const attachment = {
      kind,
      ...(picUrl ? { url: picUrl } : {}),
      ...(mediaId ? { mediaId } : {}),
      ...(thumbMediaId ? { thumbMediaId } : {}),
      ...(picUrl ? { picUrl } : {}),
      ...(fileName ? { name: fileName } : {}),
      ...(format && kind === 'audio' ? { mimeType: `audio/${format}` } : {}),
      ...extra,
    };
    return attachment;
  };
  if (msgtype === 'image') return [push('image')];
  if (msgtype === 'voice') return [push('audio')];
  if (msgtype === 'file') return [push('file')];
  if (msgtype === 'video') return [push('video')];
  return [];
}

/**
 * Map an `aibot_msg_callback` frame body to an InboundMessage.
 * @param {{
 *   msg: Record<string, any>,
 *   reqId: string,
 *   accountId: string,
 *   botName?: string,
 * }} params
 * @returns {import('../../core/types.js').InboundMessage | null}
 */
export function mapWsInbound(params) {
  const msg = params.msg ?? {};
  const msgtype = String(msg.msgtype ?? '').toLowerCase();
  if (msgtype === 'event' || msgtype === 'stream') return null;
  const senderId = String(msg.from?.userid ?? '').trim();
  if (!senderId) return null;

  const chatTypeRaw = String(msg.chattype ?? '').toLowerCase();
  const chatId = String(msg.chatid ?? '').trim();
  const conversationType = chatTypeRaw === 'group' ? 'group' : 'dm';
  const conversationId = conversationType === 'group' ? chatId || 'unknown' : senderId;
  if (!conversationId) return null;

  const rawText = extractWsText(msg);
  const mentioned = detectMentioned({
    text: rawText,
    conversationType,
    botName: params.botName,
    msg,
  });
  const text = stripBotMention(rawText, { conversationType, botName: params.botName });
  const attachments = extractWsAttachments(msg);
  const messageId =
    String(msg.msgid ?? '').trim() ||
    generateStableMessageId('ws', senderId, conversationId, msg.create_time, msgtype, rawText, attachments.map((a) => a.url ?? '').join(','));

  return {
    channel: CHANNEL_ID,
    accountId: params.accountId,
    conversationId,
    conversationType,
    messageId,
    sender: { id: senderId },
    text,
    mentioned,
    attachments,
    target: {
      channel: CHANNEL_ID,
      accountId: params.accountId,
      conversationId,
      conversationType,
      raw: {
        mode: 'ws',
        reqId: params.reqId,
        chatId: conversationType === 'group' ? chatId : senderId,
        chatType: chatTypeRaw === 'group' ? 'group' : 'single',
        msgId: messageId,
        responseUrl: String(msg.response_url ?? '').trim() || undefined,
      },
    },
    timestamp: normalizeTimestamp(msg.create_time),
    raw: msg,
  };
}

/**
 * Map a decrypted webhook callback body to an InboundMessage.
 * Supports both 自建应用 XML (`FromUserName`/`MsgId`/`AgentID`) and the
 * compatible 群机器人 XML (`<From><UserId>` / `ChatId` / `WebhookUrl`).
 * @param {{
 *   message: Record<string, any>,
 *   accountId: string,
 *   botName?: string,
 * }} params
 * @returns {import('../../core/types.js').InboundMessage | null}
 */
export function mapWebhookInbound(params) {
  const message = params.message ?? {};
  const msgtype = firstText(pickChild(message, 'MsgType'), pickChild(message, 'msgtype')).toLowerCase();
  // v1 ignores event callbacks (subscribe/enter_agent/...) and stream refreshes.
  if (!msgtype || msgtype === 'event' || msgtype === 'stream') return null;

  const fromBlock = pickChild(message, 'From');
  const senderId = firstText(
    childText(fromBlock, 'UserId'),
    pickChild(message, 'FromUserName'),
    pickChild(message, 'fromUserName'),
    pickChild(message, 'UserId'),
    pickChild(message, 'userid'),
  );
  if (!senderId) return null;

  const chatId = firstText(
    pickChild(message, 'ChatId'),
    pickChild(message, 'chatid'),
    pickChild(message, 'ChatID'),
  );
  const chatTypeRaw = firstText(pickChild(message, 'ChatType'), pickChild(message, 'chattype')).toLowerCase();
  const conversationType = chatTypeRaw === 'group' || chatId !== '' ? 'group' : 'dm';
  const conversationId = conversationType === 'group' ? chatId : senderId;

  const toUserName = firstText(pickChild(message, 'ToUserName'), pickChild(message, 'toUserName'));
  const agentId = firstText(pickChild(message, 'AgentID'), pickChild(message, 'agentId'), pickChild(message, 'agentid'));
  const responseUrl = firstText(pickChild(message, 'WebhookUrl'), pickChild(message, 'response_url'));

  let rawText = '';
  if (msgtype === 'text') {
    rawText = firstText(childText(pickChild(message, 'Text'), 'Content'), pickChild(message, 'Content'));
  } else if (msgtype === 'voice') {
    // 自建应用 sends <Recognition> (speech-to-text) for voice messages.
    rawText = firstText(pickChild(message, 'Recognition'), childText(pickChild(message, 'Voice'), 'Content'));
  } else if (msgtype === 'mixed') {
    const textBlock = pickChild(message, 'Text');
    rawText = firstText(childText(textBlock, 'Content'), pickChild(message, 'Content'));
  }

  const mentioned = detectMentioned({
    text: rawText,
    conversationType,
    botName: params.botName,
    msg: message,
  });
  const text = stripBotMention(rawText, { conversationType, botName: params.botName });
  const attachments = extractWebhookAttachments(message);
  const messageId =
    firstText(pickChild(message, 'MsgId'), pickChild(message, 'msgid')) ||
    generateStableMessageId('webhook', senderId, conversationId, firstText(pickChild(message, 'CreateTime')), msgtype, rawText, attachments.map((a) => a.mediaId ?? '').join(','));

  return {
    channel: CHANNEL_ID,
    accountId: params.accountId,
    conversationId,
    conversationType,
    messageId,
    sender: { id: senderId },
    text,
    mentioned,
    attachments,
    target: {
      channel: CHANNEL_ID,
      accountId: params.accountId,
      conversationId,
      conversationType,
      raw: {
        mode: 'webhook',
        fromUserName: senderId,
        toUserName: toUserName || undefined,
        agentId: agentId || undefined,
        chatId: chatId || undefined,
        responseUrl: responseUrl || undefined,
        msgType: msgtype,
      },
    },
    timestamp: normalizeTimestamp(firstText(pickChild(message, 'CreateTime'), pickChild(message, 'create_time'))),
    raw: message,
  };
}
