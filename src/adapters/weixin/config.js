/**
 * `channels.weixin` configuration normalization and validation.
 *
 * Credentials are NEVER part of the config: the bot token lives in the
 * credential file produced by the QR login flow (see `credentials.js`).
 *
 * The field names are the ones exposed by core's default config:
 * `enabled, accountId, mode, baseUrl, cdnBaseUrl, credentialsFile,
 *  requestTimeoutMs, longPollTimeoutMs, reconnect{enabled,baseDelayMs,maxDelayMs},
 *  typing, botAgent, allowFrom, groups, media{download,maxBytes,timeoutMs,
 *  maxItemsPerMessage}`.
 *
 * Inbound media may also be configured with flat aliases (`mediaDownload`,
 * `mediaMaxBytes`, `mediaDownloadTimeoutMs`) for convenience.
 *
 * Test/CLI-only extras (safe to omit): `credentialsCheckIntervalMs`,
 * `loginTimeoutMs`, `routeTag`, `botType`.
 *
 * @see docs/contracts.md §5
 * @see docs/channels/weixin.md
 */
import {
  DEFAULT_BASE_URL,
  DEFAULT_BOT_AGENT,
  DEFAULT_BOT_TYPE,
  DEFAULT_CDN_BASE_URL,
  DEFAULT_CREDENTIAL_CHECK_INTERVAL_MS,
  DEFAULT_LONG_POLL_TIMEOUT_MS,
  DEFAULT_MEDIA_DOWNLOAD,
  DEFAULT_MEDIA_MAX_BYTES,
  DEFAULT_MEDIA_MAX_ITEMS,
  DEFAULT_MEDIA_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  normalizeBaseUrl,
} from './protocol.js';

/** Only `ilink` (long-poll) is supported for personal WeChat. */
export const WEIXIN_MODES = Object.freeze(['ilink']);

/** Default budget for the interactive QR login flow (5 minutes). */
export const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60_000;

/**
 * @typedef {Object} WeixinReconnectConfig
 * @property {boolean} enabled
 * @property {number} baseDelayMs
 * @property {number} maxDelayMs
 */

/**
 * @typedef {Object} WeixinConfig
 * @property {boolean} enabled
 * @property {string} accountId
 * @property {'ilink'} mode
 * @property {string} baseUrl
 * @property {string} cdnBaseUrl
 * @property {string} credentialsFile
 * @property {number} requestTimeoutMs
 * @property {number} longPollTimeoutMs
 * @property {WeixinReconnectConfig} reconnect
 * @property {boolean} typing
 * @property {string} botAgent
 * @property {string} [routeTag]
 * @property {string} botType
 * @property {number} credentialsCheckIntervalMs
 * @property {number} loginTimeoutMs
 * @property {WeixinMediaConfig} media
 * @property {string[]} allowFrom
 * @property {Record<string, unknown>} groups
 */

/**
 * @typedef {Object} WeixinMediaConfig
 * @property {boolean} download      download + decrypt inbound media
 * @property {number} maxBytes       per-item size cap (ciphertext bytes)
 * @property {number} timeoutMs      per-item download timeout
 * @property {number} maxItemsPerMessage
 */

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function positiveInt(value, fallback) {
  return Number.isFinite(value) && value > 0 ? Math.max(1, Math.floor(Number(value))) : fallback;
}

/**
 * @param {unknown} value
 * @param {string} fallback
 * @returns {string}
 */
function nonEmptyString(value, fallback) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;
}

/**
 * Normalize a raw `channels.weixin` object into a fully-defaulted config.
 * This never performs network I/O and never throws on bad URLs (validation is
 * a separate step so `doctor` can report the problem precisely).
 *
 * @param {Record<string, unknown>} [raw]
 * @returns {WeixinConfig}
 */
export function normalizeWeixinConfig(raw = {}) {
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const reconnectRaw =
    source.reconnect !== null && typeof source.reconnect === 'object' && !Array.isArray(source.reconnect)
      ? /** @type {Record<string, unknown>} */ (source.reconnect)
      : {};
  const mediaRaw =
    source.media !== null && typeof source.media === 'object' && !Array.isArray(source.media)
      ? /** @type {Record<string, unknown>} */ (source.media)
      : {};

  return {
    enabled: source.enabled === true,
    accountId: nonEmptyString(source.accountId, 'weixin'),
    mode: nonEmptyString(source.mode, 'ilink').toLowerCase() === 'ilink' ? 'ilink' : nonEmptyString(source.mode, 'ilink'),
    baseUrl: nonEmptyString(source.baseUrl, DEFAULT_BASE_URL),
    cdnBaseUrl: nonEmptyString(source.cdnBaseUrl, DEFAULT_CDN_BASE_URL).replace(/\/+$/, ''),
    credentialsFile: nonEmptyString(source.credentialsFile, ''),
    requestTimeoutMs: positiveInt(source.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS),
    longPollTimeoutMs: positiveInt(source.longPollTimeoutMs, DEFAULT_LONG_POLL_TIMEOUT_MS),
    reconnect: {
      enabled: reconnectRaw.enabled !== false,
      baseDelayMs: positiveInt(reconnectRaw.baseDelayMs, 2_000),
      maxDelayMs: positiveInt(reconnectRaw.maxDelayMs, 30_000),
    },
    typing: source.typing !== false,
    media: {
      download:
        typeof mediaRaw.download === 'boolean' ? mediaRaw.download : source.mediaDownload !== false,
      maxBytes: positiveInt(mediaRaw.maxBytes ?? source.mediaMaxBytes, DEFAULT_MEDIA_MAX_BYTES),
      timeoutMs: positiveInt(mediaRaw.timeoutMs ?? source.mediaDownloadTimeoutMs, DEFAULT_MEDIA_TIMEOUT_MS),
      maxItemsPerMessage: positiveInt(mediaRaw.maxItemsPerMessage, DEFAULT_MEDIA_MAX_ITEMS),
    },
    botAgent: nonEmptyString(source.botAgent, DEFAULT_BOT_AGENT),
    ...(nonEmptyString(source.routeTag, '') !== '' ? { routeTag: nonEmptyString(source.routeTag, '') } : {}),
    botType: nonEmptyString(source.botType, DEFAULT_BOT_TYPE),
    credentialsCheckIntervalMs: positiveInt(
      source.credentialsCheckIntervalMs,
      DEFAULT_CREDENTIAL_CHECK_INTERVAL_MS,
    ),
    loginTimeoutMs: positiveInt(source.loginTimeoutMs, DEFAULT_LOGIN_TIMEOUT_MS),
    maxQrRefresh: positiveInt(source.maxQrRefresh, 3),
    allowFrom: Array.isArray(source.allowFrom)
      ? source.allowFrom.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => String(item).trim())
      : [],
    groups:
      source.groups !== null && typeof source.groups === 'object' && !Array.isArray(source.groups)
        ? { .../** @type {Record<string, unknown>} */ (source.groups) }
        : {},
  };
}

/**
 * Validate a normalized config. Throws Error with a clear, token-free message.
 *
 * `mode` is restricted to `ilink`; any other value is a configuration error
 * (e.g. someone copied `mp` from the 公众号 channel).
 *
 * @param {WeixinConfig} config
 * @returns {WeixinConfig} the same config
 */
export function validateWeixinConfig(config) {
  if (!WEIXIN_MODES.includes(config.mode)) {
    throw new Error(
      `weixin mode must be 'ilink'（个人微信仅支持 iLink 长轮询模式），收到 '${config.mode}'`,
    );
  }
  if (typeof config.accountId !== 'string' || config.accountId.length === 0) {
    throw new Error('weixin accountId must be a non-empty string');
  }
  // normalizeBaseUrl throws TypeError with a clear message; keep it token-free.
  normalizeBaseUrl(config.baseUrl);
  if (config.cdnBaseUrl !== '') {
    let cdn;
    try {
      cdn = new URL(config.cdnBaseUrl);
    } catch {
      throw new Error('weixin cdnBaseUrl must be a valid https URL');
    }
    if (cdn.protocol !== 'https:') throw new Error('weixin cdnBaseUrl must use https');
  }
  if (!config.reconnect.enabled) {
    // Disabled reconnection is valid; no extra constraint.
  }
  if (config.reconnect.baseDelayMs > config.reconnect.maxDelayMs) {
    throw new Error('weixin reconnect.baseDelayMs must not exceed reconnect.maxDelayMs');
  }
  if (config.credentialsFile !== '' && typeof config.credentialsFile !== 'string') {
    throw new Error('weixin credentialsFile must be a string path');
  }
  if (typeof config.media.download !== 'boolean') {
    throw new Error('weixin media.download must be a boolean');
  }
  for (const field of ['maxBytes', 'timeoutMs', 'maxItemsPerMessage']) {
    if (!Number.isInteger(config.media[field]) || config.media[field] <= 0) {
      throw new Error(`weixin media.${field} must be a positive integer`);
    }
  }
  return config;
}

/**
 * Normalize + validate in one call (adapter start / login / doctor).
 * @param {Record<string, unknown>} [raw]
 * @returns {WeixinConfig}
 */
export function resolveWeixinConfig(raw = {}) {
  return validateWeixinConfig(normalizeWeixinConfig(raw));
}
