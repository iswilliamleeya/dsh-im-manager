/**
 * Feishu / Lark inbound event normalization.
 *
 * Turns the platform payload into the gateway's `InboundMessage` contract
 * (docs/contracts.md §2). Three payload shapes are accepted:
 *
 *   1. raw v2 webhook payload:  { schema: '2.0', header, event }
 *   2. flattened v2 payload:    what `lark.EventDispatcher` passes to a
 *      registered handler (header fields + event fields merged at top level)
 *   3. legacy v1 payload:       { type: 'event_callback', event: {...} }
 *
 * Nothing here performs I/O: the caller decides whether to emit.
 */

import { createHash } from 'node:crypto';

/** Message types the adapter can turn into text and/or attachments. */
const SUPPORTED_MESSAGE_TYPES = new Set([
  'text',
  'post',
  'image',
  'file',
  'audio',
  'media',
  'video',
  'sticker',
]);

/**
 * @typedef {Object} BotIdentity
 * @property {string} [openId]  The bot's own open_id (used to match mentions / drop self messages).
 * @property {string} [name]    The bot's display name (fallback for `post` @-tags).
 */

/**
 * @typedef {Object} UnwrappedEvent
 * @property {'challenge' | 'event'} kind
 * @property {string} [eventType]
 * @property {string} [eventId]
 * @property {Record<string, any>} [event]
 * @property {Record<string, any>} [header]
 */

/**
 * Detect the payload shape and unwrap the platform event.
 *
 * @param {unknown} payload
 * @returns {UnwrappedEvent | null}
 */
export function unwrapEventPayload(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const body = /** @type {Record<string, any>} */ (payload);

  if (body.type === 'url_verification') {
    return { kind: 'challenge' };
  }

  // Raw v2 webhook payload.
  if (body.header !== undefined && body.event !== undefined && body.event !== null && typeof body.event === 'object') {
    return {
      kind: 'event',
      eventType: typeof body.header?.event_type === 'string' ? body.header.event_type : undefined,
      eventId: typeof body.header?.event_id === 'string' ? body.header.event_id : undefined,
      event: body.event,
      header: body.header,
    };
  }

  // Flattened v2 payload (EventDispatcher output) — header and event fields merged.
  if (body.message !== undefined && typeof body.message === 'object' && body.message !== null) {
    return {
      kind: 'event',
      eventType: typeof body.event_type === 'string' ? body.event_type : undefined,
      eventId: typeof body.event_id === 'string' ? body.event_id : undefined,
      event: { sender: body.sender, message: body.message },
      header: body.header ?? {
        event_id: body.event_id,
        event_type: body.event_type,
        create_time: body.create_time,
      },
    };
  }

  // Legacy v1 event callback wrapper.
  if (body.type === 'event_callback' && body.event !== undefined && typeof body.event === 'object') {
    return {
      kind: 'event',
      eventType: typeof body.event?.type === 'string' ? body.event.type : undefined,
      eventId: typeof body.uuid === 'string' ? body.uuid : (typeof body.event_id === 'string' ? body.event_id : undefined),
      event: body.event,
      header: { event_id: body.uuid ?? body.event_id, create_time: body.event?.create_time },
    };
  }

  return null;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function textOf(value) {
  return typeof value === 'string' ? value : '';
}

/**
 * True when this mention refers to our bot.
 *
 * Matching order:
 *   1. bot open_id known  -> compare `mention.id.open_id` (authoritative);
 *   2. bot display name known -> compare `mention.name` (needed for `post` at-tags,
 *      which carry user_id rather than open_id);
 *   3. neither known -> fall back to Feishu's placeholder convention where the
 *      first @-mention in the content is keyed `@_user_1`.
 *
 * @param {{ key?: string, name?: string, id?: { open_id?: string, user_id?: string, union_id?: string } }} mention
 * @param {BotIdentity} bot
 * @returns {boolean}
 */
export function isBotMention(mention, bot) {
  if (mention === null || typeof mention !== 'object') return false;
  const openId = textOf(mention.id?.open_id);
  if (bot.openId !== undefined && bot.openId.length > 0) {
    if (openId.length > 0) return openId === bot.openId;
    if (bot.name !== undefined && bot.name.length > 0 && textOf(mention.name) === bot.name) return true;
    return false;
  }
  if (bot.name !== undefined && bot.name.length > 0 && textOf(mention.name) === bot.name) return true;
  return textOf(mention.key) === '@_user_1';
}

/**
 * Remove all @-mention placeholders from a text message.
 *
 * Feishu text messages contain placeholders like `@_user_1`; the `mentions`
 * array maps each placeholder to the mentioned user. The bot's own mention is
 * removed entirely; mentions of other people are rendered back as `@name`.
 *
 * @param {string} text
 * @param {Array<{ key?: string, name?: string, id?: { open_id?: string } }>} mentions
 * @param {BotIdentity} bot
 * @returns {string}
 */
export function stripMentions(text, mentions, bot) {
  let out = text;
  for (const mention of mentions) {
    const key = textOf(mention?.key);
    if (key.length === 0) continue;
    const replacement = isBotMention(mention, bot) ? '' : `@${textOf(mention?.name)}`;
    out = out.split(key).join(replacement);
  }
  // Any placeholder that had no matching mention entry (e.g. @all) is dropped.
  out = out.replace(/@_user_\d+/g, '');
  return out;
}

/**
 * @param {string} text
 * @returns {string}
 */
function cleanText(text) {
  return text
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/**
 * @param {Record<string, any>} content
 * @returns {Array<{ tag?: string, text?: string, href?: string, user_name?: string, image_key?: string, file_key?: string, emoji_type?: string }>}
 */
function flattenPostRows(content) {
  /** @type {Array<any>} */
  const rows = [];
  if (Array.isArray(content.content)) {
    if (typeof content.title === 'string' && content.title.length > 0) {
      rows.push([{ tag: 'text', text: content.title }]);
    }
    rows.push(...content.content);
  } else {
    // Some payloads wrap the post per locale: { zh_cn: { title, content } }.
    for (const value of Object.values(content)) {
      if (value !== null && typeof value === 'object' && Array.isArray(/** @type {any} */ (value).content)) {
        if (typeof /** @type {any} */ (value).title === 'string' && /** @type {any} */ (value).title.length > 0) {
          rows.push([{ tag: 'text', text: /** @type {any} */ (value).title }]);
        }
        rows.push(.../** @type {any} */ (value).content);
        break;
      }
    }
  }
  /** @type {Array<any>} */
  const items = [];
  for (const row of rows) {
    if (Array.isArray(row)) items.push(...row);
  }
  return items;
}

/**
 * Extract plain text + attachments from a Feishu message body.
 *
 * @param {string} messageType
 * @param {unknown} rawContent  JSON string from `message.content`
 * @param {BotIdentity} bot
 * @returns {{ text: string, attachments: Array<Record<string, unknown>> } | null}
 */
export function extractMessageContent(messageType, rawContent, bot) {
  if (!SUPPORTED_MESSAGE_TYPES.has(messageType)) return null;

  let content;
  if (typeof rawContent === 'string' && rawContent.length > 0) {
    try {
      content = JSON.parse(rawContent);
    } catch {
      return messageType === 'text'
        ? { text: cleanText(rawContent), attachments: [] }
        : null;
    }
  } else {
    content = {};
  }
  if (content === null || typeof content !== 'object') content = {};

  /** @type {Array<Record<string, unknown>>} */
  const attachments = [];

  switch (messageType) {
    case 'text': {
      return { text: cleanText(textOf(content.text)), attachments };
    }
    case 'post': {
      const items = flattenPostRows(content);
      /** @type {string[]} */
      const parts = [];
      for (const item of items) {
        switch (item.tag) {
          case 'text':
            parts.push(textOf(item.text));
            break;
          case 'a':
            parts.push(textOf(item.text) || textOf(item.href));
            break;
          case 'at': {
            const name = textOf(item.user_name);
            if (name.length > 0 && name !== bot.name) parts.push(`@${name}`);
            break;
          }
          case 'img':
          case 'image': {
            const key = textOf(item.image_key);
            if (key.length > 0) attachments.push({ kind: 'image', name: key, mediaId: key });
            break;
          }
          case 'media': {
            const key = textOf(item.file_key);
            if (key.length > 0) attachments.push({ kind: 'video', name: key, mediaId: key });
            break;
          }
          case 'emotion':
            parts.push(textOf(item.emoji_type) ? `:${textOf(item.emoji_type)}:` : '');
            break;
          default:
            if (typeof item.text === 'string') parts.push(item.text);
            break;
        }
      }
      return { text: cleanText(parts.join('')), attachments };
    }
    case 'image': {
      const key = textOf(content.image_key);
      if (key.length > 0) attachments.push({ kind: 'image', name: key, mediaId: key });
      return { text: '', attachments };
    }
    case 'file': {
      const key = textOf(content.file_key);
      const size = Number(content.file_size);
      attachments.push({
        kind: 'file',
        name: textOf(content.file_name) || key,
        ...(key.length > 0 ? { mediaId: key } : {}),
        ...(Number.isFinite(size) && size > 0 ? { size } : {}),
      });
      return { text: '', attachments };
    }
    case 'audio': {
      const key = textOf(content.file_key);
      if (key.length > 0) attachments.push({ kind: 'audio', name: key, mediaId: key });
      return { text: '', attachments };
    }
    case 'media':
    case 'video': {
      const key = textOf(content.file_key);
      const name = textOf(content.file_name) || key;
      if (key.length > 0) attachments.push({ kind: 'video', name, mediaId: key });
      return { text: '', attachments };
    }
    case 'sticker': {
      const key = textOf(content.file_key);
      if (key.length > 0) attachments.push({ kind: 'image', name: key, mediaId: key });
      return { text: '', attachments };
    }
    default:
      return null;
  }
}

/**
 * @param {string | undefined} raw
 * @returns {number}
 */
function parseCreateTime(raw) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return 0;
  // Feishu message.create_time is epoch ms; v2 header.create_time is epoch seconds.
  return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
}

/**
 * Derive a stable message id when the platform omits one.
 *
 * Stability matters because core dedupes on `messageId`: the same event body
 * replayed by the platform must produce the same id, otherwise the user sees
 * duplicate agent turns.
 *
 * @param {{ messageId: string, eventId: string, chatId: string, senderId: string, createTime: string, messageType: string, content: string }} parts
 * @returns {string}
 */
function deriveMessageId(parts) {
  if (parts.messageId.length > 0) return parts.messageId;
  if (parts.eventId.length > 0) return `event:${parts.eventId}`;
  const hash = createHash('sha256')
    .update([parts.chatId, parts.senderId, parts.createTime, parts.messageType, parts.content].join('\u0000'))
    .digest('hex');
  return `derived:${hash.slice(0, 24)}`;
}

/**
 * @typedef {Object} ParseMessageOptions
 * @property {string} [accountId]
 * @property {BotIdentity} [bot]
 * @property {() => number} [now]
 */

/**
 * Normalize one Feishu event payload into an InboundMessage.
 *
 * Returns `null` for anything the adapter must ignore: bot/app senders, our
 * own messages, unsupported message types, malformed payloads.
 *
 * @param {unknown} payload
 * @param {ParseMessageOptions} [options]
 * @returns {import('../../core/types.js').InboundMessage | null}
 */
export function parseMessageEvent(payload, options = {}) {
  const accountId = options.accountId ?? 'feishu';
  const bot = options.bot ?? {};
  const now = options.now ?? Date.now;

  const unwrapped = unwrapEventPayload(payload);
  if (unwrapped === null || unwrapped.kind !== 'event') return null;
  if (unwrapped.eventType !== undefined && unwrapped.eventType !== 'im.message.receive_v1') return null;

  const event = unwrapped.event ?? {};
  const message = /** @type {Record<string, any>} */ (event.message ?? {});
  if (message === null || typeof message !== 'object') return null;

  const sender = /** @type {Record<string, any>} */ (event.sender ?? {});
  const senderType = textOf(sender.sender_type).toLowerCase();
  // Never react to other bots / apps (including our own outgoing messages).
  if (senderType === 'app' || senderType === 'bot') return null;

  const senderId = textOf(sender.sender_id?.open_id)
    || textOf(sender.sender_id?.user_id)
    || textOf(sender.sender_id?.union_id);
  if (senderId.length === 0) return null;
  // Safety net for payloads that omit sender_type but include our open_id.
  if (bot.openId !== undefined && bot.openId.length > 0 && senderId === bot.openId) return null;

  const messageType = textOf(message.message_type);
  const content = textOf(message.content);
  const parsed = extractMessageContent(messageType, content, bot);
  if (parsed === null) return null;

  const mentions = Array.isArray(message.mentions) ? message.mentions : [];
  const chatType = textOf(message.chat_type);
  const conversationType = chatType === 'p2p' ? 'dm' : 'group';
  const chatId = textOf(message.chat_id);
  if (chatId.length === 0) return null;

  let text = parsed.text;
  let mentioned = false;
  if (conversationType === 'group') {
    mentioned = mentions.some((mention) => isBotMention(mention, bot));
    if (!mentioned && messageType === 'post' && bot.name !== undefined && bot.name.length > 0) {
      mentioned = text.includes(`@${bot.name}`);
    }
    if (messageType === 'text') {
      text = stripMentions(text, mentions, bot);
    } else if (bot.name !== undefined && bot.name.length > 0) {
      text = text.split(`@${bot.name}`).join('');
    }
    text = cleanText(text);
  } else {
    // DM: every message is implicitly addressed to the bot.
    mentioned = true;
    if (messageType === 'text') text = cleanText(stripMentions(text, mentions, bot));
  }

  if (text.length === 0 && parsed.attachments.length === 0) return null;

  const messageId = deriveMessageId({
    messageId: textOf(message.message_id),
    eventId: unwrapped.eventId ?? '',
    chatId,
    senderId,
    createTime: textOf(message.create_time),
    messageType,
    content,
  });

  const createdAt = parseCreateTime(message.create_time)
    || parseCreateTime(unwrapped.header?.create_time)
    || now();

  const threadId = textOf(message.thread_id) || textOf(message.root_id);

  /** @type {import('../../core/types.js').ReplyTarget} */
  const target = {
    channel: 'feishu',
    accountId,
    conversationId: chatId,
    conversationType,
    ...(threadId.length > 0 ? { threadId } : {}),
    ...(textOf(message.message_id).length > 0 ? { replyToMessageId: textOf(message.message_id) } : {}),
  };

  return {
    channel: 'feishu',
    accountId,
    conversationId: chatId,
    conversationType,
    messageId,
    sender: { id: senderId },
    text,
    mentioned,
    attachments: /** @type {import('../../core/types.js').Attachment[]} */ (parsed.attachments),
    target,
    timestamp: createdAt,
    raw: payload,
  };
}
