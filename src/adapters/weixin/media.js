/**
 * Inbound media for the personal WeChat channel: CDN download + AES-128-ECB
 * decryption + local persistence.
 *
 * Protocol (see upstream `docs/protocol.md` §"CDN media flow"):
 *   1. resolve the URL: `media.full_url` wins; otherwise
 *      `<cdnBaseUrl>/download?encrypted_query_param=<encrypt_query_param>`
 *   2. resolve the key:
 *        - image: `image_item.aeskey` (32 hex chars) first, then `media.aes_key`
 *        - file / video / voice: `media.aes_key`
 *      `media.aes_key` may be base64 of 16 raw bytes OR base64 of the 32-char
 *      hex string; both are normalized to a 16-byte Buffer.
 *   3. AES-128-ECB + PKCS#7 decrypt (`node:crypto`). Images without a key are
 *      kept as plaintext, per the official client.
 *   4. save decrypted bytes to `<stateDir>/media/<messageId>-<index>.<ext>`
 *      (dir 0700, file 0600, atomic rename), sniff the MIME type from the
 *      content where possible, and produce attachment fields
 *      `{ path, mimeType, name, size }`.
 *
 * Any failure (bad key, HTTP error, timeout, too large, unknown image format)
 * is logged as a redacted warning and the attachment is left URL-only — media
 * must never block the inbound message from reaching the gateway.
 *
 * @see docs/channels/weixin.md §"入站媒体"
 */
import { createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';

import {
  DEFAULT_MEDIA_MAX_BYTES,
  DEFAULT_MEDIA_MAX_ITEMS,
  DEFAULT_MEDIA_TIMEOUT_MS,
  MESSAGE_ITEM_TYPE_FILE,
  MESSAGE_ITEM_TYPE_IMAGE,
  MESSAGE_ITEM_TYPE_VIDEO,
  MESSAGE_ITEM_TYPE_VOICE,
  MESSAGE_TYPE_USER,
  buildCdnMediaUrl,
  isPlainObject,
  redactSecrets,
  truncateForLog,
} from './protocol.js';

/** Typed failure for one media item (always caught by the downloader). */
export class MediaDownloadError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, cause?: unknown }} [options]
   */
  constructor(message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'MediaDownloadError';
    this.code = options.code ?? 'WEIXIN_MEDIA_ERROR';
  }
}

/** MIME type + extension tables used for file/video/voice classification. */
const MIME_BY_EXTENSION = Object.freeze({
  '7z': 'application/x-7z-compressed',
  amr: 'audio/amr',
  bin: 'application/octet-stream',
  bmp: 'image/bmp',
  css: 'text/css',
  csv: 'text/csv',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  gif: 'image/gif',
  gz: 'application/gzip',
  heic: 'image/heic',
  htm: 'text/html',
  html: 'text/html',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  js: 'text/javascript',
  json: 'application/json',
  log: 'text/plain',
  m4a: 'audio/mp4',
  md: 'text/markdown',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  ogg: 'audio/ogg',
  pdf: 'application/pdf',
  png: 'image/png',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  rar: 'application/vnd.rar',
  silk: 'audio/silk',
  tar: 'application/x-tar',
  ts: 'text/typescript',
  txt: 'text/plain',
  wav: 'audio/wav',
  webm: 'video/webm',
  webp: 'image/webp',
  xml: 'application/xml',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  zip: 'application/zip',
});

/**
 * Normalize the two AES-key wire forms to 16 raw bytes.
 *
 * Accepts:
 *   - 32 hex characters (image_item.aeskey, or a raw hex media.aes_key)
 *   - base64 of 16 raw bytes
 *   - base64 of the 32-char ASCII hex string (Tencent outbound encoding)
 *   - base64url variants of the above
 *
 * @param {unknown} value
 * @returns {Buffer | undefined} 16-byte key, or undefined when unusable
 */
export function decodeAesKey(value) {
  if (typeof value !== 'string') return undefined;
  const raw = value.trim();
  if (raw === '') return undefined;
  if (/^[0-9a-fA-F]{32}$/.test(raw)) return Buffer.from(raw, 'hex');

  const normalized = raw.replace(/-/g, '+').replace(/_/g, '/');
  let decoded;
  try {
    decoded = Buffer.from(normalized, 'base64');
  } catch {
    return undefined;
  }
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32) {
    const ascii = decoded.toString('utf8');
    if (/^[0-9a-fA-F]{32}$/.test(ascii)) return Buffer.from(ascii, 'hex');
  }
  return undefined;
}

/**
 * AES-128-ECB + PKCS#7 decrypt.
 * @param {Buffer} ciphertext
 * @param {Buffer} key 16 bytes
 * @returns {Buffer}
 */
export function decryptAes128Ecb(ciphertext, key) {
  if (!Buffer.isBuffer(key) || key.length !== 16) {
    throw new MediaDownloadError('AES 密钥长度不是 16 字节', { code: 'WEIXIN_MEDIA_KEY_INVALID' });
  }
  try {
    const decipher = createDecipheriv('aes-128-ecb', key, null);
    decipher.setAutoPadding(true);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (error) {
    throw new MediaDownloadError('AES 解密失败（密钥错误或数据损坏）', {
      code: 'WEIXIN_MEDIA_DECRYPT_FAILED',
      cause: error,
    });
  }
}

/**
 * Sniff an image MIME type from magic bytes.
 * @param {Buffer} data
 * @returns {{ mimeType: string, ext: string } | undefined}
 */
export function sniffImageMime(data) {
  if (!Buffer.isBuffer(data) || data.length < 12) return undefined;
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return { mimeType: 'image/jpeg', ext: '.jpg' };
  if (
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47 &&
    data[4] === 0x0d &&
    data[5] === 0x0a &&
    data[6] === 0x1a &&
    data[7] === 0x0a
  ) {
    return { mimeType: 'image/png', ext: '.png' };
  }
  const header = data.subarray(0, 12).toString('latin1');
  if (header.startsWith('GIF87a') || header.startsWith('GIF89a')) return { mimeType: 'image/gif', ext: '.gif' };
  if (header.startsWith('RIFF') && data.subarray(8, 12).toString('latin1') === 'WEBP') {
    return { mimeType: 'image/webp', ext: '.webp' };
  }
  if (data[0] === 0x42 && data[1] === 0x4d) return { mimeType: 'image/bmp', ext: '.bmp' };
  // HEIF/HEIC: ISO-BMFF `ftyp` box at offset 4.
  if (data.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = data.subarray(8, 12).toString('latin1');
    if (brand === 'heic' || brand === 'heix' || brand === 'hevc' || brand === 'mif1' || brand === 'msf1') {
      return { mimeType: 'image/heic', ext: '.heic' };
    }
  }
  return undefined;
}

/**
 * Sniff audio/video MIME from magic bytes.
 * @param {Buffer} data
 * @returns {{ mimeType: string, ext: string } | undefined}
 */
export function sniffAvMime(data) {
  if (!Buffer.isBuffer(data) || data.length < 12) return undefined;
  const ascii = data.subarray(0, 12).toString('latin1');
  if (ascii.startsWith('#!SILK')) return { mimeType: 'audio/silk', ext: '.silk' };
  if (ascii.startsWith('#!AMR')) return { mimeType: 'audio/amr', ext: '.amr' };
  if (ascii.startsWith('ID3')) return { mimeType: 'audio/mpeg', ext: '.mp3' };
  if (ascii.startsWith('OggS')) return { mimeType: 'audio/ogg', ext: '.ogg' };
  if (ascii.startsWith('RIFF') && data.subarray(8, 12).toString('latin1') === 'WAVE') {
    return { mimeType: 'audio/wav', ext: '.wav' };
  }
  if (data.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = data.subarray(8, 12).toString('latin1');
    if (brand === 'qt  ') return { mimeType: 'video/quicktime', ext: '.mov' };
    if (brand.startsWith('M4A')) return { mimeType: 'audio/mp4', ext: '.m4a' };
    if (brand === 'avif' || brand === 'avis') return { mimeType: 'image/avif', ext: '.avif' };
    return { mimeType: 'video/mp4', ext: '.mp4' };
  }
  if (data[0] === 0x1a && data[1] === 0x45 && data[2] === 0xdf && data[3] === 0xa3) {
    return { mimeType: 'video/webm', ext: '.webm' };
  }
  // MP3 frame sync (0xFFEx).
  if (data[0] === 0xff && (data[1] & 0xe0) === 0xe0) return { mimeType: 'audio/mpeg', ext: '.mp3' };
  return undefined;
}

/**
 * One of `sniffImageMime` / `sniffAvMime`, plus generic document magic.
 * @param {Buffer} data
 * @returns {{ mimeType: string, ext: string } | undefined}
 */
export function sniffMime(data) {
  const image = sniffImageMime(data);
  if (image !== undefined) return image;
  if (Buffer.isBuffer(data) && data.length >= 5 && data.subarray(0, 5).toString('latin1') === '%PDF-') {
    return { mimeType: 'application/pdf', ext: '.pdf' };
  }
  if (Buffer.isBuffer(data) && data.length >= 4 && data[0] === 0x50 && data[1] === 0x4b && data[2] === 0x03 && data[3] === 0x04) {
    return { mimeType: 'application/zip', ext: '.zip' };
  }
  if (Buffer.isBuffer(data) && data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b) {
    return { mimeType: 'application/gzip', ext: '.gz' };
  }
  return sniffAvMime(data);
}

/**
 * MIME by filename extension (case-insensitive).
 * @param {string | undefined} name
 * @returns {string | undefined}
 */
export function mimeFromFilename(name) {
  if (typeof name !== 'string' || name.trim() === '') return undefined;
  const ext = extname(name.trim()).replace(/^\./, '').toLowerCase();
  return MIME_BY_EXTENSION[ext];
}

/**
 * Safe extension (`.pdf`) from a filename; `''` when absent/invalid.
 * @param {string | undefined} name
 * @returns {string}
 */
export function extensionFromFilename(name) {
  if (typeof name !== 'string') return '';
  const ext = extname(name.trim()).toLowerCase();
  return /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : '';
}

/**
 * Sanitize an untrusted platform filename for display and fs usage:
 * take the basename, strip control/path characters, cap the length.
 * @param {unknown} name
 * @param {string} [fallback]
 * @returns {string}
 */
export function sanitizeFilename(name, fallback = '') {
  if (typeof name !== 'string') return fallback;
  const base = basename(name.trim().replace(/\\/g, '/'));
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned === '' || cleaned === '.' || cleaned === '..') return fallback;
  if (cleaned.length <= 120) return cleaned;
  const ext = extensionFromFilename(cleaned);
  const cut = Math.max(1, 120 - ext.length);
  return `${cleaned.slice(0, cut)}${ext}`;
}

/**
 * Resolve the download descriptor for one `item_list` entry.
 *
 * @param {unknown} item
 * @param {{ cdnBaseUrl?: string }} [options]
 * @returns {{
 *   kind: 'image'|'voice'|'file'|'video',
 *   url: string,
 *   aesKeySource?: string,
 *   requiresKey: boolean,
 *   payload: Record<string, any>,
 * } | null}
 */
export function describeItemMedia(item, options = {}) {
  if (!isPlainObject(item)) return null;
  /** @type {Record<number, 'image'|'voice'|'file'|'video'>} */
  const kindByType = {
    [MESSAGE_ITEM_TYPE_IMAGE]: 'image',
    [MESSAGE_ITEM_TYPE_VOICE]: 'voice',
    [MESSAGE_ITEM_TYPE_FILE]: 'file',
    [MESSAGE_ITEM_TYPE_VIDEO]: 'video',
  };
  const kind = kindByType[item.type];
  if (kind === undefined) return null;
  const payloadKey = kind === 'image' ? 'image_item' : kind === 'voice' ? 'voice_item' : kind === 'file' ? 'file_item' : 'video_item';
  const payload = isPlainObject(item[payloadKey]) ? item[payloadKey] : null;
  if (payload === null) return null;
  const media = isPlainObject(payload.media) ? payload.media : {};

  let url;
  let urlFromMedia = false;
  if (typeof media.full_url === 'string' && media.full_url.trim() !== '') {
    url = media.full_url.trim();
    urlFromMedia = true;
  } else if (typeof media.encrypt_query_param === 'string' && media.encrypt_query_param !== '') {
    url = buildCdnMediaUrl(options.cdnBaseUrl, media.encrypt_query_param);
    urlFromMedia = true;
  } else if (kind === 'image' && typeof payload.url === 'string' && payload.url.trim() !== '') {
    // Legacy direct image URL: no CDN media reference, so treat as plaintext
    // even if a stray aeskey field is present.
    url = payload.url.trim();
  }
  if (url === undefined) return null;

  /** @type {string | undefined} */
  let aesKeySource;
  if (urlFromMedia) {
    if (kind === 'image') {
      if (typeof payload.aeskey === 'string' && payload.aeskey.trim() !== '') aesKeySource = payload.aeskey;
      else if (typeof media.aes_key === 'string' && media.aes_key.trim() !== '') aesKeySource = media.aes_key;
    } else if (typeof media.aes_key === 'string' && media.aes_key.trim() !== '') {
      aesKeySource = media.aes_key;
    }
  }

  return {
    kind,
    url,
    ...(aesKeySource !== undefined ? { aesKeySource } : {}),
    // Images without a key are plaintext by protocol; others need the key.
    requiresKey: kind !== 'image',
    payload,
  };
}

/**
 * Redact CDN URLs and token-ish material from a media error before logging.
 * @param {unknown} error
 * @returns {string}
 */
export function safeMediaError(error) {
  const raw = error instanceof Error ? error.message : String(error);
  return truncateForLog(
    redactSecrets(raw)
      .replace(/https?:\/\/\S+/gi, '<cdn-url>')
      .replace(/encrypted_query_param=[^&\s]+/gi, 'encrypted_query_param=<redacted>'),
    200,
  );
}

/**
 * @param {string} url
 * @returns {URL}
 */
function parseDownloadUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new MediaDownloadError('媒体下载地址无效', { code: 'WEIXIN_MEDIA_URL_INVALID' });
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new MediaDownloadError('媒体下载地址协议不受支持', { code: 'WEIXIN_MEDIA_URL_INVALID' });
  }
  return parsed;
}

/**
 * Read a Response body with a hard byte cap.
 * @param {any} response
 * @param {number} maxBytes
 * @returns {Promise<Buffer>}
 */
async function readResponseBody(response, maxBytes) {
  if (response?.body !== null && response?.body !== undefined && typeof response.body[Symbol.asyncIterator] === 'function') {
    /** @type {Buffer[]} */
    const chunks = [];
    let total = 0;
    for await (const chunk of response.body) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > maxBytes) {
        throw new MediaDownloadError(`媒体超过大小上限（>${maxBytes} bytes）`, { code: 'WEIXIN_MEDIA_TOO_LARGE' });
      }
      chunks.push(buffer);
    }
    return Buffer.concat(chunks);
  }
  if (typeof response?.arrayBuffer === 'function') {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) {
      throw new MediaDownloadError(`媒体超过大小上限（>${maxBytes} bytes）`, { code: 'WEIXIN_MEDIA_TOO_LARGE' });
    }
    return buffer;
  }
  if (typeof response?.text === 'function') {
    const buffer = Buffer.from(await response.text(), 'utf8');
    if (buffer.length > maxBytes) {
      throw new MediaDownloadError(`媒体超过大小上限（>${maxBytes} bytes）`, { code: 'WEIXIN_MEDIA_TOO_LARGE' });
    }
    return buffer;
  }
  throw new MediaDownloadError('媒体响应没有可读的 body', { code: 'WEIXIN_MEDIA_BODY_MISSING' });
}

/**
 * Create the inbound media downloader bound to one channel state dir.
 *
 * @param {{
 *   fetch?: typeof fetch,
 *   cdnBaseUrl?: string,
 *   stateDir: string,
 *   maxBytes?: number,
 *   timeoutMs?: number,
 *   signal?: AbortSignal,
 *   log?: { debug?: (...args: unknown[]) => void, info?: (...args: unknown[]) => void, warn?: (...args: unknown[]) => void },
 *   now?: () => number,
 * }} options
 */
export function createMediaDownloader(options) {
  const stateDir = String(options?.stateDir ?? '.');
  const maxBytes =
    Number.isFinite(options?.maxBytes) && options.maxBytes > 0 ? Math.floor(options.maxBytes) : DEFAULT_MEDIA_MAX_BYTES;
  const timeoutMs =
    Number.isFinite(options?.timeoutMs) && options.timeoutMs > 0 ? Math.floor(options.timeoutMs) : DEFAULT_MEDIA_TIMEOUT_MS;
  const cdnBaseUrl = typeof options?.cdnBaseUrl === 'string' ? options.cdnBaseUrl : undefined;
  const log = options?.log ?? {};
  const externalSignal = options?.signal;

  /**
   * Download one buffer with timeout + optional external abort + maxBytes.
   * @param {string} url
   * @returns {Promise<Buffer>}
   */
  async function downloadBuffer(url) {
    const fetchImpl =
      typeof options?.fetch === 'function'
        ? options.fetch
        : typeof globalThis.fetch === 'function'
          ? globalThis.fetch
          : undefined;
    if (typeof fetchImpl !== 'function') {
      throw new MediaDownloadError('没有可用的 fetch 实现', { code: 'WEIXIN_MEDIA_NO_FETCH' });
    }
    parseDownloadUrl(url);

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    timer.unref?.();
    const onExternalAbort = () => controller.abort();
    if (externalSignal) {
      if (externalSignal.aborted) controller.abort();
      else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }

    try {
      let response;
      try {
        response = await fetchImpl(url, { method: 'GET', signal: controller.signal });
      } catch (error) {
        if (timedOut) throw new MediaDownloadError('媒体下载超时', { code: 'WEIXIN_MEDIA_TIMEOUT', cause: error });
        if (externalSignal?.aborted) {
          throw new MediaDownloadError('媒体下载已取消', { code: 'WEIXIN_MEDIA_ABORTED', cause: error });
        }
        throw new MediaDownloadError('媒体下载网络错误', { code: 'WEIXIN_MEDIA_NETWORK', cause: error });
      }

      const status = Number(response?.status ?? 0);
      const ok = typeof response?.ok === 'boolean' ? response.ok : status >= 200 && status < 300;
      if (!ok) {
        // Release the socket rather than leaving an unread body behind.
        try {
          await response?.body?.cancel?.();
        } catch {
          // ignore
        }
        throw new MediaDownloadError(`媒体下载 HTTP ${status}`, { code: 'WEIXIN_MEDIA_HTTP' });
      }
      const rawContentLength = response?.headers?.get?.('content-length');
      const contentLength =
        rawContentLength === null || rawContentLength === undefined || rawContentLength === ''
          ? Number.NaN
          : Number(rawContentLength);
      if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        try {
          await response?.body?.cancel?.();
        } catch {
          // ignore
        }
        throw new MediaDownloadError(`媒体超过大小上限（content-length ${contentLength}）`, {
          code: 'WEIXIN_MEDIA_TOO_LARGE',
        });
      }
      try {
        return await readResponseBody(response, maxBytes);
      } catch (error) {
        if (timedOut) throw new MediaDownloadError('媒体下载超时', { code: 'WEIXIN_MEDIA_TIMEOUT', cause: error });
        throw error;
      }
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', onExternalAbort);
    }
  }

  /**
   * Classify decrypted bytes into attachment fields.
   * @param {{ kind: string, payload: Record<string, any> }} resolved
   * @param {Buffer} plaintext
   * @param {number} index
   * @returns {{ mimeType: string, ext: string, name: string }}
   */
  function classifyMedia(resolved, plaintext, index) {
    const label = index + 1;
    if (resolved.kind === 'image') {
      const sniffed = sniffImageMime(plaintext);
      if (sniffed === undefined) {
        throw new MediaDownloadError('无法识别图片格式', { code: 'WEIXIN_MEDIA_UNKNOWN_IMAGE' });
      }
      return { mimeType: sniffed.mimeType, ext: sniffed.ext, name: `image-${label}${sniffed.ext}` };
    }
    if (resolved.kind === 'video') {
      const sniffed = sniffAvMime(plaintext);
      const chosen = sniffed !== undefined && sniffed.mimeType.startsWith('video/') ? sniffed : { mimeType: 'video/mp4', ext: '.mp4' };
      return { mimeType: chosen.mimeType, ext: chosen.ext, name: `video-${label}${chosen.ext}` };
    }
    if (resolved.kind === 'voice') {
      const sniffed = sniffAvMime(plaintext);
      const chosen = sniffed !== undefined && sniffed.mimeType.startsWith('audio/') ? sniffed : { mimeType: 'audio/silk', ext: '.silk' };
      return { mimeType: chosen.mimeType, ext: chosen.ext, name: `voice-${label}${chosen.ext}` };
    }
    // file
    const original = sanitizeFilename(resolved.payload?.file_name, '');
    const extFromName = extensionFromFilename(original);
    const sniffed = sniffMime(plaintext);
    let ext = extFromName !== '' ? extFromName : sniffed?.ext ?? '.bin';
    if (!/^\.[a-z0-9]{1,8}$/.test(ext)) ext = '.bin';
    let mimeType = mimeFromFilename(original) ?? sniffed?.mimeType ?? MIME_BY_EXTENSION.bin;
    if (mimeType === undefined) mimeType = MIME_BY_EXTENSION.bin;
    let name = original;
    if (name === '') name = `file-${label}${ext}`;
    else if (extensionFromFilename(name) === '') name = `${name}${ext}`;
    return { mimeType, ext, name };
  }

  /**
   * Persist decrypted bytes to `<stateDir>/media/<messageId>-<index><ext>`.
   * @param {string} messageId
   * @param {number} index
   * @param {string} ext
   * @param {Buffer} plaintext
   * @returns {string} absolute path
   */
  function saveMediaFile(messageId, index, ext, plaintext) {
    const dir = join(stateDir, 'media');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(dir, 0o700);
    } catch {
      // chmod may be unsupported on some filesystems
    }
    const safeMessageId =
      String(messageId ?? 'msg')
        .replace(/[^A-Za-z0-9._-]/g, '_')
        .slice(0, 80) || 'msg';
    const file = join(dir, `${safeMessageId}-${index}${ext}`);
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      writeFileSync(tmp, plaintext, { mode: 0o600 });
      renameSync(tmp, file);
      try {
        chmodSync(file, 0o600);
      } catch {
        // ignore
      }
    } catch (error) {
      try {
        rmSync(tmp, { force: true });
      } catch {
        // best effort
      }
      throw new MediaDownloadError('媒体文件写入失败', { code: 'WEIXIN_MEDIA_WRITE_FAILED', cause: error });
    }
    return file;
  }

  return {
    /**
     * Download + decrypt + save one media item.
     * Returns `null` on any failure (caller keeps the URL-only attachment).
     *
     * @param {{ item: unknown, messageId: string, index: number }} params
     * @returns {Promise<{ path: string, mimeType: string, name: string, size: number } | null>}
     */
    async downloadItem(params) {
      const resolved = describeItemMedia(params?.item, { cdnBaseUrl });
      if (resolved === null) return null;
      const index = Number.isInteger(params?.index) && params.index >= 0 ? params.index : 0;
      const messageId = String(params?.messageId ?? 'msg');

      /** @type {Buffer | undefined} */
      let key;
      if (resolved.aesKeySource !== undefined) key = decodeAesKey(resolved.aesKeySource);
      // A malformed image_item.aeskey must not mask a usable media.aes_key.
      if (key === undefined && resolved.kind === 'image') {
        const alternate = resolved.payload?.media?.aes_key;
        if (typeof alternate === 'string' && alternate.trim() !== '') key = decodeAesKey(alternate);
      }
      if (key === undefined) {
        if (resolved.aesKeySource !== undefined) {
          log.warn?.('weixin inbound media key is malformed; keeping URL only', {
            kind: resolved.kind,
            index,
          });
        } else {
          log.debug?.('weixin inbound media has no AES key; keeping URL only', {
            kind: resolved.kind,
            index,
          });
        }
        if (resolved.requiresKey || resolved.aesKeySource !== undefined) return null;
        // Image without any key: protocol defines the bytes as plaintext.
      }

      let ciphertext;
      try {
        ciphertext = await downloadBuffer(resolved.url);
      } catch (error) {
        log.warn?.('weixin inbound media download failed; keeping URL only', {
          kind: resolved.kind,
          index,
          error: safeMediaError(error),
        });
        return null;
      }

      let plaintext;
      try {
        plaintext = key === undefined ? ciphertext : decryptAes128Ecb(ciphertext, key);
      } catch (error) {
        log.warn?.('weixin inbound media decrypt failed; keeping URL only', {
          kind: resolved.kind,
          index,
          error: safeMediaError(error),
        });
        return null;
      }

      try {
        const classified = classifyMedia(resolved, plaintext, index);
        const path = saveMediaFile(messageId, index, classified.ext, plaintext);
        log.info?.('weixin inbound media saved', {
          kind: resolved.kind,
          index,
          bytes: plaintext.length,
          mimeType: classified.mimeType,
        });
        return { path, mimeType: classified.mimeType, name: classified.name, size: plaintext.length };
      } catch (error) {
        log.warn?.('weixin inbound media could not be saved; keeping URL only', {
          kind: resolved.kind,
          index,
          error: safeMediaError(error),
        });
        return null;
      }
    },
  };
}

/**
 * Download every media attachment of one inbound message before it is emitted.
 *
 * Attachments produced by `inbound.js` carry `itemIndex` pointing into
 * `inbound.raw.item_list`; only user messages are hydrated, and at most
 * `maxItems` media items are fetched per message.
 *
 * This function never throws: per-item failures leave the attachment URL-only.
 *
 * @param {import('../../core/types.js').InboundMessage | null | undefined} inbound
 * @param {{
 *   downloader?: { downloadItem: (params: { item: unknown, messageId: string, index: number }) => Promise<any> } | null,
 *   maxItems?: number,
 *   log?: { debug?: (...args: unknown[]) => void, info?: (...args: unknown[]) => void, warn?: (...args: unknown[]) => void },
 * }} [options]
 * @returns {Promise<import('../../core/types.js').InboundMessage | null | undefined>}
 */
export async function hydrateInboundMedia(inbound, options = {}) {
  if (inbound === null || inbound === undefined || typeof inbound !== 'object') return inbound;
  if (inbound.raw === null || typeof inbound.raw !== 'object' || inbound.raw.message_type !== MESSAGE_TYPE_USER) {
    return inbound;
  }
  const attachments = Array.isArray(inbound.attachments) ? inbound.attachments : [];
  const downloader = options.downloader;
  if (attachments.length === 0 || downloader === null || downloader === undefined) return inbound;
  const items = Array.isArray(inbound.raw.item_list) ? inbound.raw.item_list : [];
  const maxItems =
    Number.isFinite(options.maxItems) && options.maxItems > 0 ? Math.floor(options.maxItems) : DEFAULT_MEDIA_MAX_ITEMS;
  const log = options.log ?? {};

  let attempted = 0;
  for (const attachment of attachments) {
    const itemIndex = Number.isInteger(attachment?.itemIndex) ? attachment.itemIndex : -1;
    if (itemIndex < 0 || itemIndex >= items.length) continue;
    if (attempted >= maxItems) {
      log.warn?.('weixin inbound message has too many media items; extra items keep URL only', { maxItems });
      break;
    }
    attempted += 1;
    try {
      const result = await downloader.downloadItem({ item: items[itemIndex], messageId: inbound.messageId, index: itemIndex });
      if (result === null || result === undefined) continue;
      attachment.path = result.path;
      attachment.mimeType = result.mimeType;
      attachment.name = result.name;
      attachment.size = result.size;
    } catch (error) {
      log.warn?.('weixin inbound media hydrate failed; keeping URL only', {
        kind: attachment?.kind,
        index: itemIndex,
        error: safeMediaError(error),
      });
    }
  }
  return inbound;
}
