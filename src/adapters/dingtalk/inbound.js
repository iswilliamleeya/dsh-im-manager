/**
 * DingTalk inbound normalization: raw robot message (Stream callback `data` or
 * webhook JSON body) -> InboundMessage per docs/contracts.md §2.
 *
 * Kept free of I/O so tests can feed fixtures straight into `parseInbound`.
 */
import { createHash } from 'node:crypto';

/**
 * @param {unknown} value
 * @returns {string}
 */
function readString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * DingTalk sends `content` either as an object or as a JSON string; be lenient
 * about both and about previously-unwrapped arrays.
 *
 * @param {unknown} value
 * @returns {Record<string, unknown> | unknown[] | null}
 */
export function parseContentValue(value) {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value;
  if (typeof value === 'object') return /** @type {Record<string, unknown>} */ (value);
  const text = readString(value);
  if (text.length === 0) return null;
  if (!text.startsWith('{') && !text.startsWith('[')) return null;
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
    if (parsed !== null && typeof parsed === 'object') return /** @type {Record<string, unknown>} */ (parsed);
    return null;
  } catch {
    return null;
  }
}

/**
 * Pick the first non-empty string from a list of candidate values.
 *
 * @param {unknown[]} values
 * @returns {string}
 */
function firstString(...values) {
  for (const value of values) {
    const text = readString(value);
    if (text.length > 0) return text;
  }
  return '';
}

/**
 * DingTalk `createAt` is epoch milliseconds; tolerate seconds from other
 * callback shapes.
 *
 * @param {unknown} value
 * @param {number} now
 * @returns {number}
 */
export function normalizeTimestamp(value, now) {
  const number = typeof value === 'string' ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isFinite(number) || number <= 0) return now;
  return number < 1e11 ? Math.round(number * 1000) : Math.round(number);
}

/**
 * @param {Record<string, unknown>} raw
 * @returns {'dm'|'group'}
 */
export function resolveConversationType(raw) {
  const value = raw.conversationType ?? raw.conversation_type ?? raw.chatType;
  // "1" = single chat, "2" = group chat. Everything else is treated as a DM.
  return String(value ?? '1') === '2' ? 'group' : 'dm';
}

/**
 * A DM conversation is keyed by the human on the other side (DingTalk DM
 * `conversationId` is not reliably stable across device/context changes),
 * while a group is keyed by the platform conversation id.
 *
 * @param {Record<string, unknown>} raw
 * @param {'dm'|'group'} conversationType
 * @returns {string}
 */
export function resolveConversationId(raw, conversationType) {
  if (conversationType === 'group') {
    return firstString(raw.conversationId, raw.conversation_id, raw.chatId, raw.openConversationId, raw.senderStaffId, raw.senderId);
  }
  return firstString(
    raw.senderStaffId,
    raw.senderId,
    raw.senderUserId,
    raw.senderUserid,
    raw.conversationId,
    raw.conversation_id,
    raw.chatId,
  );
}

/**
 * @param {Record<string, unknown>} raw
 * @returns {{ id: string, name?: string }}
 */
function resolveSender(raw) {
  const id = firstString(raw.senderStaffId, raw.senderId, raw.senderUserId, raw.senderUserid, raw.senderOpenDingTalkId);
  const name = firstString(raw.senderNick, raw.senderName, raw.senderStaffName);
  return name.length > 0 ? { id, name } : { id };
}

/**
 * Stable message id. `msgId` is the platform-unique id used by dedupe; when the
 * platform omits it (some webhook payloads) a deterministic hash of the message
 * body is used so redeliveries collapse and distinct messages stay distinct.
 *
 * @param {Record<string, unknown>} raw
 * @param {{ conversationId: string, senderId: string, streamMessageId?: string }} context
 * @returns {string}
 */
export function resolveMessageId(raw, context) {
  const direct = firstString(raw.msgId, raw.msg_id, raw.messageId, raw.message_id, context.streamMessageId);
  if (direct.length > 0) return direct;
  const content = typeof raw.content === 'string' ? raw.content : JSON.stringify(raw.content ?? '');
  const material = [
    context.conversationId,
    context.senderId,
    String(raw.createAt ?? raw.createTime ?? raw.create_at ?? ''),
    String(raw.msgtype ?? raw.msgType ?? ''),
    readString(raw.text && typeof raw.text === 'object' ? raw.text.content : ''),
    content,
  ].join('|');
  return `dt_${createHash('sha256').update(material).digest('hex').slice(0, 24)}`;
}

/**
 * Is this callback about a message the bot itself sent? Stream callbacks should
 * only carry user messages, but a misconfigured app can echo them; never feed
 * them back into the agent.
 *
 * @param {Record<string, unknown>} raw
 * @param {{ clientId?: string, robotCode?: string, botUserId?: string }} config
 * @returns {boolean}
 */
export function isBotSelfEcho(raw, config = {}) {
  const senderIds = [raw.senderStaffId, raw.senderId, raw.senderUserId, raw.senderUserid]
    .map(readString)
    .filter((id) => id.length > 0);
  if (senderIds.length === 0) return false;
  const botIds = new Set(
    [config.botUserId, config.clientId, config.robotCode, raw.chatbotUserId, raw.robotCode]
      .map(readString)
      .filter((id) => id.length > 0),
  );
  return senderIds.some((id) => botIds.has(id));
}

/**
 * Group messages only reach the bot when it was @-mentioned. `atUsers` is the
 * most reliable signal across payload versions; `isInAtList` is present in the
 * official robot callback.
 *
 * @param {Record<string, unknown>} raw
 * @param {'dm'|'group'} conversationType
 * @returns {boolean}
 */
export function detectMentioned(raw, conversationType) {
  if (conversationType === 'dm') return true;
  const flag = raw.isInAtList ?? raw.is_in_at_list ?? raw.isAtBot;
  if (flag === true || flag === 'true' || flag === 1 || flag === '1') return true;
  const atUsers = raw.atUsers ?? raw.at_users;
  return Array.isArray(atUsers) && atUsers.length > 0;
}

/**
 * Remove the leading "@机器人" token(s) that DingTalk sometimes leaves in
 * `text.content`. Only applied to group messages that mention the bot; a bare
 * leading `@token` in such a message is the mention (DingTalk has no way to
 * address another user at the very start of a bot-addressed group message).
 *
 * @param {string} text
 * @returns {string}
 */
export function stripMentionPrefix(text) {
  let out = text ?? '';
  // At most a few tokens; guard against pathological input.
  for (let index = 0; index < 3; index += 1) {
    const next = out.replace(/^\s*@[^\s@]{1,64}[\s\u00a0]*/, '');
    if (next === out) break;
    out = next;
  }
  return out.trim();
}

/**
 * @param {Record<string, unknown>} content
 * @param {'image'|'file'|'audio'|'video'} kind
 * @param {{ name?: unknown, size?: unknown, code?: unknown, mimeType?: unknown }} extra
 * @returns {import('../../core/types.js').Attachment}
 */
function makeAttachment(kind, extra) {
  /** @type {import('../../core/types.js').Attachment} */
  const attachment = { kind };
  const name = readString(extra.name);
  if (name.length > 0) attachment.name = name;
  const size = typeof extra.size === 'number' ? extra.size : Number(extra.size);
  if (Number.isFinite(size) && size > 0) attachment.size = size;
  const mimeType = readString(extra.mimeType);
  if (mimeType.length > 0) attachment.mimeType = mimeType;
  const code = readString(extra.code);
  // `mediaId` is the contract's slot for platform-side media handles; for
  // DingTalk this is the downloadCode used by the file-download OpenAPI.
  if (code.length > 0) attachment.mediaId = code;
  return attachment;
}

/**
 * @param {unknown} contentValue
 * @returns {{ text: string, attachments: import('../../core/types.js').Attachment[], mentioned: boolean }}
 */
export function parseRichText(contentValue) {
  /** @type {string[]} */
  const textParts = [];
  /** @type {import('../../core/types.js').Attachment[]} */
  const attachments = [];
  let mentioned = false;

  const parsed = parseContentValue(contentValue);
  /** @type {unknown[]} */
  let elements = [];
  if (Array.isArray(parsed)) {
    elements = parsed;
  } else if (parsed !== null && typeof parsed === 'object') {
    const richText = parsed.richText ?? parsed.rich_text;
    if (Array.isArray(richText)) elements = richText;
    else if (typeof richText === 'string') {
      const nested = parseContentValue(richText);
      if (Array.isArray(nested)) elements = nested;
    }
  }

  for (const element of elements) {
    if (element === null || typeof element !== 'object') continue;
    const item = /** @type {Record<string, unknown>} */ (element);
    const type = readString(item.type).toLowerCase();
    const downloadCode = firstString(
      item.downloadCode,
      item.download_code,
      item.pictureDownloadCode,
      item.videoDownloadCode,
    );
    if (downloadCode.length > 0) {
      attachments.push(makeAttachment(type === 'video' ? 'video' : 'image', { code: downloadCode }));
      continue;
    }
    if (type === 'at' || readString(item.userId).length > 0 || readString(item.atUserId).length > 0) {
      mentioned = true;
      continue;
    }
    if (typeof item.text === 'string' && item.text.length > 0) textParts.push(item.text);
  }

  return { text: textParts.join(''), attachments, mentioned };
}

/**
 * @param {Record<string, unknown>} raw
 * @param {string} msgtype
 * @returns {{ text: string, attachments: import('../../core/types.js').Attachment[], mentionedHint: boolean }}
 */
function parseMessageBody(raw, msgtype) {
  if (msgtype === 'text') {
    const text = raw.text !== null && typeof raw.text === 'object'
      ? readString(/** @type {Record<string, unknown>} */ (raw.text).content)
      : '';
    return { text, attachments: [], mentionedHint: false };
  }
  if (msgtype === 'richtext') {
    const rich = parseRichText(raw.content);
    // The richText array may also live inside `content.richText` already parsed
    // by parseRichText; fall back to raw.text for partial payloads.
    return { text: rich.text, attachments: rich.attachments, mentionedHint: rich.mentioned };
  }

  const content = parseContentValue(raw.content);
  const contentObject = content !== null && typeof content === 'object' && !Array.isArray(content)
    ? /** @type {Record<string, unknown>} */ (content)
    : {};

  /** @type {import('../../core/types.js').Attachment[]} */
  const attachments = [];
  let text = '';

  if (msgtype === 'picture' || msgtype === 'image') {
    const code = firstString(contentObject.downloadCode, contentObject.download_code, contentObject.pictureDownloadCode);
    if (code.length > 0) attachments.push(makeAttachment('image', { code }));
  } else if (msgtype === 'file') {
    const code = firstString(contentObject.downloadCode, contentObject.download_code);
    if (code.length > 0) {
      attachments.push(makeAttachment('file', {
        code,
        name: contentObject.fileName ?? contentObject.file_name,
        size: contentObject.fileSize ?? contentObject.file_size,
      }));
    }
  } else if (msgtype === 'audio') {
    const code = firstString(contentObject.downloadCode, contentObject.download_code);
    if (code.length > 0) attachments.push(makeAttachment('audio', { code }));
    // Voice messages carry the platform's speech-to-text result; use it as text
    // so the agent can answer without a transcription step.
    text = firstString(contentObject.recognition, contentObject.text);
  } else if (msgtype === 'video') {
    const code = firstString(contentObject.downloadCode, contentObject.download_code, contentObject.videoDownloadCode);
    if (code.length > 0) attachments.push(makeAttachment('video', { code }));
  }

  return { text, attachments, mentionedHint: false };
}

/**
 * Normalize one DingTalk robot message into the adapter contract shape.
 *
 * @param {unknown} rawInput Raw robot message object (already JSON-parsed).
 * @param {{
 *   channel?: string,
 *   accountId?: string,
 *   config?: { clientId?: string, robotCode?: string, botUserId?: string },
 *   now?: number,
 *   streamMessageId?: string,
 * }} [options]
 * @returns {import('../../core/types.js').InboundMessage | null} `null` for messages the adapter must ignore.
 */
export function parseInbound(rawInput, options = {}) {
  if (rawInput === null || typeof rawInput !== 'object' || Array.isArray(rawInput)) return null;
  const raw = /** @type {Record<string, unknown>} */ (rawInput);
  const now = typeof options.now === 'number' && Number.isFinite(options.now) ? options.now : Date.now();
  const channel = typeof options.channel === 'string' && options.channel.length > 0 ? options.channel : 'dingtalk';
  const accountId = typeof options.accountId === 'string' && options.accountId.length > 0 ? options.accountId : 'dingtalk';
  const config = options.config ?? {};

  if (isBotSelfEcho(raw, config)) return null;

  const msgtype = firstString(raw.msgtype, raw.msgType).toLowerCase();
  const conversationType = resolveConversationType(raw);
  const body = parseMessageBody(raw, msgtype);

  // Nothing the agent could act on (unsupported type, empty text, no media).
  if (body.text.trim().length === 0 && body.attachments.length === 0) return null;

  const sender = resolveSender(raw);
  const conversationId = resolveConversationId(raw, conversationType);
  if (conversationId.length === 0 || sender.id.length === 0) return null;

  const mentioned = detectMentioned(raw, conversationType) || body.mentionedHint;
  let text = body.text;
  if (conversationType === 'group' && mentioned) text = stripMentionPrefix(text);

  const messageId = resolveMessageId(raw, {
    conversationId,
    senderId: sender.id,
    streamMessageId: options.streamMessageId,
  });
  if (messageId.length === 0) return null;

  const sessionWebhook = firstString(raw.sessionWebhook, raw.session_webhook);
  const sessionWebhookExpiredTime = (() => {
    const value = raw.sessionWebhookExpiredTime ?? raw.session_webhook_expired_time;
    const number = typeof value === 'string' ? Number(value) : value;
    return typeof number === 'number' && Number.isFinite(number) && number > 0 ? number : undefined;
  })();
  const replySenderId = firstString(raw.senderOpenDingTalkId, raw.senderStaffId, raw.senderId);
  const robotCode = firstString(raw.robotCode, config.robotCode, config.clientId);

  /** @type {import('../../core/types.js').ReplyTarget} */
  const target = {
    channel,
    accountId,
    conversationId,
    conversationType,
    replyToMessageId: messageId,
    raw: {
      sessionWebhook,
      ...(sessionWebhookExpiredTime !== undefined ? { sessionWebhookExpiredTime } : {}),
      ...(robotCode.length > 0 ? { robotCode } : {}),
      msgId: messageId,
      ...(replySenderId.length > 0 ? { senderOpenDingTalkId: replySenderId } : {}),
    },
  };

  return {
    channel,
    accountId,
    conversationId,
    conversationType,
    messageId,
    sender,
    text,
    mentioned,
    attachments: body.attachments,
    target,
    timestamp: normalizeTimestamp(raw.createAt ?? raw.createTime ?? raw.create_at, now),
    raw: {
      msgtype,
      conversationType,
      robotCode: robotCode.length > 0 ? robotCode : undefined,
      ...(options.streamMessageId !== undefined ? { streamMessageId: options.streamMessageId } : {}),
    },
  };
}
