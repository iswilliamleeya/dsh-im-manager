/**
 * Pure inbound mapping: one iLink `WeixinMessage` → one contract
 * `InboundMessage` (docs/contracts.md §2). No I/O, no network — this module is
 * intentionally trivial to unit test.
 *
 * Mapping rules:
 *   - only `message_type === 1` (real user messages); bot echoes (`2`) and
 *     unknown types are dropped before they reach core
 *   - `from_user_id` is both `sender.id` and `conversationId` (1:1 chat only)
 *   - `messageId` = `wx-<message_id>`; when the id is missing a stable FNV-1a
 *     hash of the identifying fields is used instead (redelivery safe)
 *   - item types: 1 text, 2 image, 3 voice (transcript when present),
 *     4 file, 5 video; tool-call items (11/12) are ignored
 *   - this mapper stays pure/no-I/O: it records `attachment.url` (CDN address),
 *     `mediaId` / `aesKey` extras and `itemIndex` (position inside
 *     `raw.item_list`). `media.js` then downloads + decrypts before emit and
 *     fills in `path` / `mimeType` / `name` / `size`; failures keep URL-only
 *   - `context_token` is stripped from `raw` (it is stored separately by the
 *     monitor in `context-tokens.json`) so it can never leak through a log that
 *     dumps `raw`
 *
 * @see docs/contracts.md §2.1
 * @see docs/channels/weixin.md
 */
import {
  MESSAGE_ITEM_TYPE_FILE,
  MESSAGE_ITEM_TYPE_IMAGE,
  MESSAGE_ITEM_TYPE_TEXT,
  MESSAGE_ITEM_TYPE_VIDEO,
  MESSAGE_ITEM_TYPE_VOICE,
  MESSAGE_TYPE_USER,
  buildCdnMediaUrl,
  isPlainObject,
} from './protocol.js';

export const WEIXIN_CHANNEL_ID = 'weixin';

/**
 * Stable FNV-1a 32-bit hash (hex string). Used only when the platform omits a
 * message id; the same input must always produce the same output so core
 * dedupe and cursor replay stay correct.
 * @param {string} input
 * @returns {string}
 */
export function stableHash(input) {
  const text = String(input ?? '');
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function textOf(value) {
  return typeof value === 'string' ? value : '';
}

/**
 * Convert the `len` file field (decimal string per protocol) to a number.
 * @param {unknown} value
 * @returns {number | undefined}
 */
function byteLengthOf(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.floor(value);
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return undefined;
}

/**
 * Extract a CDN media reference for one item.
 * @param {Record<string, any>} media
 * @returns {{ url?: string, mediaId?: string, aesKey?: string, encryptType?: number }}
 */
function mediaFields(media) {
  if (!isPlainObject(media)) return {};
  const encryptQueryParam = textOf(media.encrypt_query_param);
  const fullUrl = textOf(media.full_url);
  const aesKey = textOf(media.aes_key);
  return {
    ...(fullUrl !== '' ? { url: fullUrl } : {}),
    ...(encryptQueryParam !== '' ? { mediaId: encryptQueryParam } : {}),
    ...(aesKey !== '' ? { aesKey } : {}),
    ...(Number.isFinite(media.encrypt_type) ? { encryptType: media.encrypt_type } : {}),
  };
}

/**
 * Map one `item_list` entry to an attachment, or `null` if unsupported/empty.
 *
 * `itemIndex` is the position inside `raw.item_list`; the media downloader
 * uses it to find the original item (AES key / filenames) before emitting.
 *
 * @param {Record<string, any>} item
 * @param {{ cdnBaseUrl?: string, index?: number }} [options]
 * @returns {import('../../core/types.js').Attachment | null}
 */
export function mapItemAttachment(item, options = {}) {
  const itemIndex = Number.isInteger(options.index) ? options.index : undefined;
  if (!isPlainObject(item)) return null;
  switch (item.type) {
    case MESSAGE_ITEM_TYPE_IMAGE: {
      const image = isPlainObject(item.image_item) ? item.image_item : {};
      const media = mediaFields(image.media);
      if (media.url === undefined) {
        const fallback = textOf(image.url);
        if (fallback !== '') media.url = fallback;
      }
      if (media.url === undefined) {
        media.url = buildCdnMediaUrl(options.cdnBaseUrl, media.mediaId);
      }
      const aesKey = textOf(image.aeskey) !== '' ? textOf(image.aeskey) : media.aesKey;
      return pruneAttachment({
        kind: 'image',
        itemIndex,
        url: media.url,
        ...(Number.isFinite(image.mid_size) ? { size: image.mid_size } : {}),
        ...(media.mediaId ? { mediaId: media.mediaId } : {}),
        ...(aesKey ? { aesKey } : {}),
        raw: { type: item.type, ...media },
      });
    }
    case MESSAGE_ITEM_TYPE_VOICE: {
      const voice = isPlainObject(item.voice_item) ? item.voice_item : {};
      const media = mediaFields(voice.media);
      if (media.url === undefined) media.url = buildCdnMediaUrl(options.cdnBaseUrl, media.mediaId);
      return pruneAttachment({
        kind: 'audio',
        itemIndex,
        url: media.url,
        ...(Number.isFinite(voice.playtime) ? { durationMs: voice.playtime } : {}),
        ...(media.mediaId ? { mediaId: media.mediaId } : {}),
        ...(media.aesKey ? { aesKey: media.aesKey } : {}),
        raw: {
          type: item.type,
          ...(textOf(voice.text) !== '' ? { transcript: textOf(voice.text) } : {}),
          ...media,
        },
      });
    }
    case MESSAGE_ITEM_TYPE_FILE: {
      const file = isPlainObject(item.file_item) ? item.file_item : {};
      const media = mediaFields(file.media);
      if (media.url === undefined) media.url = buildCdnMediaUrl(options.cdnBaseUrl, media.mediaId);
      const size = byteLengthOf(file.len);
      return pruneAttachment({
        kind: 'file',
        itemIndex,
        ...(media.url ? { url: media.url } : {}),
        ...(textOf(file.file_name) !== '' ? { name: textOf(file.file_name) } : {}),
        ...(size !== undefined ? { size } : {}),
        ...(media.mediaId ? { mediaId: media.mediaId } : {}),
        ...(media.aesKey ? { aesKey: media.aesKey } : {}),
        raw: { type: item.type, ...media },
      });
    }
    case MESSAGE_ITEM_TYPE_VIDEO: {
      const video = isPlainObject(item.video_item) ? item.video_item : {};
      const media = mediaFields(video.media);
      if (media.url === undefined) media.url = buildCdnMediaUrl(options.cdnBaseUrl, media.mediaId);
      return pruneAttachment({
        kind: 'video',
        itemIndex,
        url: media.url,
        ...(Number.isFinite(video.video_size) ? { size: video.video_size } : {}),
        ...(Number.isFinite(video.play_length) ? { durationMs: video.play_length } : {}),
        ...(media.mediaId ? { mediaId: media.mediaId } : {}),
        ...(media.aesKey ? { aesKey: media.aesKey } : {}),
        raw: { type: item.type, ...media },
      });
    }
    default:
      return null;
  }
}

/**
 * Drop undefined fields from an attachment but keep the extra protocol fields
 * (`mediaId`, `aesKey`, `raw`, ...) that the JS contract object accepts.
 * @param {Record<string, any>} attachment
 * @returns {import('../../core/types.js').Attachment}
 */
function pruneAttachment(attachment) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const [key, value] of Object.entries(attachment)) {
    if (value !== undefined) out[key] = value;
  }
  return /** @type {import('../../core/types.js').Attachment} */ (out);
}

/**
 * Extract the text a message carries: concatenated `text_item.text`, plus the
 * voice transcript when the message is voice-only (WeChat renders the
 * transcription as text for the bot).
 *
 * @param {Record<string, any>[]} items
 * @returns {string}
 */
export function extractText(items) {
  const texts = [];
  const transcripts = [];
  for (const item of items) {
    if (!isPlainObject(item)) continue;
    if (item.type === MESSAGE_ITEM_TYPE_TEXT) {
      const text = textOf(item.text_item?.text);
      if (text !== '') texts.push(text);
    } else if (item.type === MESSAGE_ITEM_TYPE_VOICE) {
      const transcript = textOf(item.voice_item?.text);
      if (transcript !== '') transcripts.push(transcript);
    }
  }
  if (texts.length > 0) return texts.join('\n');
  return transcripts.join('\n');
}

/**
 * Strip credential-ish fields from the raw message before exposing it to core.
 * `context_token` is persisted separately; keep it out of anything dumpable.
 * @param {Record<string, any>} raw
 * @returns {Record<string, any>}
 */
function sanitizeRaw(raw) {
  /** @type {Record<string, any>} */
  const out = { ...raw };
  delete out.context_token;
  delete out.bot_token;
  delete out.token;
  return out;
}

/**
 * Map one raw iLink message to a contract `InboundMessage`.
 *
 * @param {unknown} raw
 * @param {{ accountId?: string, cdnBaseUrl?: string, now?: number }} [options]
 * @returns {import('../../core/types.js').InboundMessage | null}
 */
export function mapInbound(raw, options = {}) {
  if (!isPlainObject(raw)) return null;
  // Only real user messages; bot echoes (2) would otherwise create reply loops.
  if (raw.message_type !== MESSAGE_TYPE_USER) return null;
  const fromUserId = textOf(raw.from_user_id).trim();
  if (fromUserId === '') return null;

  const items = Array.isArray(raw.item_list) ? raw.item_list : [];
  /** @type {import('../../core/types.js').Attachment[]} */
  const attachments = [];
  for (let index = 0; index < items.length; index += 1) {
    const attachment = mapItemAttachment(items[index], { cdnBaseUrl: options.cdnBaseUrl, index });
    if (attachment !== null) attachments.push(attachment);
  }
  const text = extractText(items);
  if (text === '' && attachments.length === 0) return null;

  const accountId = typeof options.accountId === 'string' && options.accountId !== '' ? options.accountId : WEIXIN_CHANNEL_ID;
  const messageId = resolveMessageId(raw, fromUserId);
  const timestamp = Number.isFinite(raw.create_time_ms) ? Math.floor(raw.create_time_ms) : (options.now ?? Date.now());

  /** @type {import('../../core/types.js').ReplyTarget} */
  const target = {
    channel: WEIXIN_CHANNEL_ID,
    accountId,
    conversationId: fromUserId,
    conversationType: 'dm',
    replyToMessageId: messageId,
    raw: {
      messageId: raw.message_id ?? undefined,
      sessionId: textOf(raw.session_id) || undefined,
    },
  };

  return {
    channel: WEIXIN_CHANNEL_ID,
    accountId,
    conversationId: fromUserId,
    conversationType: 'dm',
    messageId,
    sender: { id: fromUserId },
    text,
    mentioned: true, // DM only
    attachments,
    target,
    timestamp,
    raw: sanitizeRaw(raw),
  };
}

/**
 * Stable platform message id.
 * @param {Record<string, any>} raw
 * @param {string} fromUserId
 * @returns {string}
 */
export function resolveMessageId(raw, fromUserId) {
  const messageId = raw.message_id;
  if (typeof messageId === 'number' && Number.isFinite(messageId)) return `wx-${String(Math.trunc(messageId))}`;
  if (typeof messageId === 'string' && messageId.trim() !== '') return `wx-${messageId.trim()}`;
  const seed = [fromUserId, raw.create_time_ms ?? '', raw.seq ?? '', raw.session_id ?? ''].join('|');
  return `wx-${stableHash(seed)}`;
}

/** @typedef {ReturnType<typeof mapInbound>} WeixinInboundMessage */
