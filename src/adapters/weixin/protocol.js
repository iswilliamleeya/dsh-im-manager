/**
 * iLink protocol primitives for the personal WeChat (个人微信) channel.
 *
 * Everything here is wire-level knowledge taken from the official Tencent
 * `openclaw-weixin` protocol description (`docs/protocol.md` upstream):
 *
 *   - API / CDN base URLs, endpoint paths and `bot_type`
 *   - request header names and their wire values (`AuthorizationType`,
 *     `X-WECHAT-UIN`, `iLink-App-Id`, `iLink-App-ClientVersion`, `SKRouteTag`)
 *   - `base_info` (`channel_version` + `bot_agent`)
 *   - enums for `message_type` / `message_state` / `item_list[].type` / typing
 *   - QR login states and the `-14` stale-token error code
 *   - base URL trust rules (https only; official `*.weixin.qq.com` host or the
 *     host the adapter was configured with)
 *
 * No I/O and no credentials ever leave this module in clear text: `redactSecrets`
 * is the single place that scrubs token-ish substrings before they reach a log
 * line or an Error message.
 *
 * @see docs/channels/weixin.md
 * @see docs/contracts.md §2
 */
import { randomBytes } from 'node:crypto';

/** Default iLink API base URL (QR login always starts here). */
export const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';

/** Default CDN base URL, used to build download URLs for inbound media. */
export const DEFAULT_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';

/** `bot_type` required by `get_bot_qrcode` for this channel build. */
export const DEFAULT_BOT_TYPE = '3';

/** Adapter version reported as `base_info.channel_version`. */
export const ADAPTER_VERSION = '0.1.0';

/** `base_info.bot_agent` default (observability only, not authentication). */
export const DEFAULT_BOT_AGENT = 'dsh-im-manager';

/** `iLink-App-Id` fixed by the protocol for bot clients. */
export const ILINK_APP_ID = 'bot';

/** `AuthorizationType` header value for bot-token authenticated requests. */
export const AUTHORIZATION_TYPE = 'ilink_bot_token';

/** Server error code meaning "bot token is stale / expired". */
export const STALE_TOKEN_ERRCODE = -14;

/** API paths relative to the API base URL. */
export const ENDPOINTS = Object.freeze({
  GET_BOT_QRCODE: 'ilink/bot/get_bot_qrcode',
  GET_QRCODE_STATUS: 'ilink/bot/get_qrcode_status',
  GET_UPDATES: 'ilink/bot/getupdates',
  SEND_MESSAGE: 'ilink/bot/sendmessage',
  GET_CONFIG: 'ilink/bot/getconfig',
  SEND_TYPING: 'ilink/bot/sendtyping',
  NOTIFY_START: 'ilink/bot/msg/notifystart',
  NOTIFY_STOP: 'ilink/bot/msg/notifystop',
});

/** Header names used by the iLink protocol. */
export const HEADERS = Object.freeze({
  CONTENT_TYPE: 'Content-Type',
  AUTHORIZATION_TYPE: 'AuthorizationType',
  AUTHORIZATION: 'Authorization',
  X_WECHAT_UIN: 'X-WECHAT-UIN',
  ILINK_APP_ID: 'iLink-App-Id',
  ILINK_APP_CLIENT_VERSION: 'iLink-App-ClientVersion',
  SK_ROUTE_TAG: 'SKRouteTag',
});

/** `message_type`: 1 = user, 2 = bot (own echo — must be ignored). */
export const MESSAGE_TYPE_USER = 1;
export const MESSAGE_TYPE_BOT = 2;

/** `message_state`: 0 = new, 1 = generating, 2 = finished. */
export const MESSAGE_STATE_NEW = 0;
export const MESSAGE_STATE_GENERATING = 1;
export const MESSAGE_STATE_FINISH = 2;

/** `item_list[].type` values. */
export const MESSAGE_ITEM_TYPE_TEXT = 1;
export const MESSAGE_ITEM_TYPE_IMAGE = 2;
export const MESSAGE_ITEM_TYPE_VOICE = 3;
export const MESSAGE_ITEM_TYPE_FILE = 4;
export const MESSAGE_ITEM_TYPE_VIDEO = 5;
export const MESSAGE_ITEM_TYPE_TOOL_CALL_START = 11;
export const MESSAGE_ITEM_TYPE_TOOL_CALL_RESULT = 12;

/** `sendtyping.status`: 1 = typing, 2 = cancel. */
export const TYPING_STATUS_TYPING = 1;
export const TYPING_STATUS_CANCEL = 2;

/** Every QR login status the server may report. */
export const QR_STATUSES = Object.freeze([
  'wait',
  'scaned',
  'confirmed',
  'expired',
  'need_verifycode',
  'verify_code_blocked',
  'scaned_but_redirect',
  'binded_redirect',
]);

/** Default timeout for regular JSON requests (`sendmessage`, QR fetch, ...). */
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

/** Default long-poll timeout for `getupdates` (server holds the request). */
export const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;

/** Default long-poll timeout for `get_qrcode_status`. */
export const DEFAULT_QR_POLL_TIMEOUT_MS = 35_000;

/** Timeout for lightweight requests (`getconfig`, `sendtyping`, notify). */
export const DEFAULT_LIGHT_TIMEOUT_MS = 10_000;

/** How often the adapter re-checks the credential file while unauthenticated. */
export const DEFAULT_CREDENTIAL_CHECK_INTERVAL_MS = 3_000;

/** Default for inbound media download: enabled. */
export const DEFAULT_MEDIA_DOWNLOAD = true;

/** Default inbound media size cap (25 MiB). */
export const DEFAULT_MEDIA_MAX_BYTES = 25 * 1024 * 1024;

/** Default per-item media download timeout (30s). */
export const DEFAULT_MEDIA_TIMEOUT_MS = 30_000;

/** Default cap of downloaded media items per inbound message. */
export const DEFAULT_MEDIA_MAX_ITEMS = 8;

/**
 * Encode a dotted version as the uint32 the protocol expects in
 * `iLink-App-ClientVersion`: `0x00MMNNPP` (high byte fixed to zero).
 *
 * @param {number} [major]
 * @param {number} [minor]
 * @param {number} [patch]
 * @returns {number} unsigned uint32
 */
export function encodeClientVersion(major = 0, minor = 0, patch = 0) {
  const m = Number.isFinite(major) ? Math.trunc(major) : 0;
  const n = Number.isFinite(minor) ? Math.trunc(minor) : 0;
  const p = Number.isFinite(patch) ? Math.trunc(patch) : 0;
  return (((m & 0xff) << 16) | ((n & 0xff) << 8) | (p & 0xff)) >>> 0;
}

/**
 * Parse `major.minor.patch` and encode it. Non-numeric components count as 0.
 * @param {string} version
 * @returns {number}
 */
export function clientVersionFromString(version) {
  const parts = String(version ?? '')
    .split('.')
    .map((part) => Number.parseInt(part, 10));
  return encodeClientVersion(
    Number.isFinite(parts[0]) ? parts[0] : 0,
    Number.isFinite(parts[1]) ? parts[1] : 0,
    Number.isFinite(parts[2]) ? parts[2] : 0,
  );
}

/** Encoded version reported for this adapter (`0.1.0` → 256). */
export const CLIENT_VERSION = clientVersionFromString(ADAPTER_VERSION);

/**
 * Produce a random uint32. `rand` is injectable so tests can make
 * `X-WECHAT-UIN` deterministic; production uses crypto randomness.
 *
 * @param {(() => number) | undefined} rand
 * @returns {number}
 */
export function randomUint32(rand) {
  if (typeof rand === 'function') {
    const value = Number(rand());
    if (!Number.isFinite(value)) return 0;
    return Math.floor(Math.abs(value) * 0x1_0000_0000) >>> 0;
  }
  return randomBytes(4).readUInt32BE(0) >>> 0;
}

/**
 * `X-WECHAT-UIN` = base64(decimal string of a uint32).
 *
 * @param {number | undefined} uin explicit uint32 (tests)
 * @param {(() => number) | undefined} [rand] random source when `uin` is absent
 * @returns {string}
 */
export function buildWechatUin(uin, rand) {
  const value = uin === undefined || !Number.isFinite(uin) ? randomUint32(rand) : Math.trunc(uin) >>> 0;
  return Buffer.from(String(value), 'utf8').toString('base64');
}

/**
 * Headers shared by every iLink request (application identity only).
 *
 * QR-status polling sends ONLY these headers, per the upstream protocol.
 *
 * @param {{ routeTag?: string, clientVersion?: number }} [options]
 * @returns {Record<string, string>}
 */
export function buildApplicationHeaders(options = {}) {
  /** @type {Record<string, string>} */
  const headers = {
    [HEADERS.ILINK_APP_ID]: ILINK_APP_ID,
    [HEADERS.ILINK_APP_CLIENT_VERSION]: String(
      Number.isFinite(options.clientVersion) ? options.clientVersion : CLIENT_VERSION,
    ),
  };
  if (typeof options.routeTag === 'string' && options.routeTag.trim() !== '') {
    headers[HEADERS.SK_ROUTE_TAG] = options.routeTag.trim();
  }
  return headers;
}

/**
 * Full JSON-request headers: content type, token auth, UIN and application id.
 *
 * @param {{
 *   token?: string,
 *   uin?: number,
 *   rand?: () => number,
 *   routeTag?: string,
 *   clientVersion?: number,
 * }} [options]
 * @returns {Record<string, string>}
 */
export function buildHeaders(options = {}) {
  /** @type {Record<string, string>} */
  const headers = {
    [HEADERS.CONTENT_TYPE]: 'application/json',
    [HEADERS.AUTHORIZATION_TYPE]: AUTHORIZATION_TYPE,
    [HEADERS.X_WECHAT_UIN]: buildWechatUin(options.uin, options.rand),
    ...buildApplicationHeaders({
      routeTag: options.routeTag,
      clientVersion: options.clientVersion,
    }),
  };
  const token = typeof options.token === 'string' ? options.token.trim() : '';
  if (token !== '') headers[HEADERS.AUTHORIZATION] = `Bearer ${token}`;
  return headers;
}

/**
 * Build the `base_info` object attached to authenticated bot requests.
 *
 * @param {{ channelVersion?: string, botAgent?: string }} [options]
 * @returns {{ channel_version: string, bot_agent: string }}
 */
export function buildBaseInfo(options = {}) {
  const channelVersion =
    typeof options.channelVersion === 'string' && options.channelVersion.trim() !== ''
      ? options.channelVersion.trim()
      : ADAPTER_VERSION;
  const botAgent =
    typeof options.botAgent === 'string' && options.botAgent.trim() !== ''
      ? options.botAgent.trim()
      : DEFAULT_BOT_AGENT;
  return { channel_version: channelVersion, bot_agent: botAgent };
}

/**
 * Whether a hostname belongs to the official WeChat domain.
 * @param {string} hostname
 * @returns {boolean}
 */
export function isOfficialWeixinHost(hostname) {
  const host = String(hostname ?? '').toLowerCase();
  return host === 'weixin.qq.com' || host.endsWith('.weixin.qq.com');
}

/**
 * Normalize a base URL: must be https, no credentials/query/fragment, no
 * trailing slash. Throws TypeError with a clear (token-free) message.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeBaseUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError('weixin base URL must be a non-empty https URL');
  }
  /** @type {URL} */
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new TypeError('weixin base URL is not a valid URL');
  }
  if (url.protocol !== 'https:') {
    throw new TypeError(`weixin base URL must use https (got ${url.protocol.replace(/:$/, '')})`);
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new TypeError('weixin base URL must not contain credentials, a query or a fragment');
  }
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${path}`;
}

/**
 * Validate a URL that the *server* handed back (QR redirect host / confirmed
 * `baseurl`). Only the official `*.weixin.qq.com` domain or the exact host the
 * adapter was configured with is accepted, so a compromised/malformed response
 * cannot redirect the bot token to an attacker-controlled host.
 *
 * @param {unknown} value
 * @param {{ configuredBaseUrl?: string }} [options]
 * @returns {string} normalized trusted base URL
 */
export function assertTrustedBaseUrl(value, options = {}) {
  const normalized = normalizeBaseUrl(value);
  const candidateHost = new URL(normalized).host.toLowerCase();

  if (typeof options.configuredBaseUrl === 'string' && options.configuredBaseUrl.trim() !== '') {
    let configuredHost = '';
    try {
      configuredHost = new URL(normalizeBaseUrl(options.configuredBaseUrl)).host.toLowerCase();
    } catch {
      configuredHost = '';
    }
    if (configuredHost !== '' && configuredHost === candidateHost) return normalized;
  }

  if (!isOfficialWeixinHost(new URL(normalized).hostname)) {
    throw new TypeError('weixin base URL host is not trusted (expected *.weixin.qq.com or the configured host)');
  }
  return normalized;
}

/**
 * Build a CDN media download URL from the configured CDN base URL plus the
 * server-provided `encrypt_query_param` (used only when no `full_url` exists).
 *
 * @param {string | undefined} cdnBaseUrl
 * @param {string | undefined} encryptQueryParam
 * @returns {string | undefined}
 */
export function buildCdnMediaUrl(cdnBaseUrl, encryptQueryParam) {
  if (typeof encryptQueryParam !== 'string' || encryptQueryParam === '') return undefined;
  const base =
    typeof cdnBaseUrl === 'string' && cdnBaseUrl.trim() !== ''
      ? cdnBaseUrl.trim().replace(/\/+$/, '')
      : DEFAULT_CDN_BASE_URL;
  return `${base}/download?encrypted_query_param=${encodeURIComponent(encryptQueryParam)}`;
}

/**
 * Scrub token-ish substrings from free text before it reaches a log or error.
 * Errors thrown by this adapter never include raw tokens; this is the last
 * line of defence for upstream error bodies and network error messages.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function redactSecrets(value) {
  if (value === undefined || value === null) return '';
  return String(value)
    .replace(
      /("?(?:bot_token|context_token|typing_ticket|access_token|token|authorization|aes_key|aeskey)"?\s*[:=]\s*)(?!Bearer\b)("?)([^",}\s]+)\2/gi,
      '$1$2<redacted>$2',
    )
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1<redacted>');
}

/**
 * Truncate a string for inclusion in an error/log line.
 * @param {unknown} value
 * @param {number} [max]
 * @returns {string}
 */
export function truncateForLog(value, max = 300) {
  const text = String(value ?? '');
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/**
 * Whether a value is a plain object (not array/null).
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Safe one-line description of a thrown value for logs (redacted, no stack).
 * @param {unknown} error
 * @returns {string}
 */
export function describeError(error) {
  if (error instanceof Error) {
    return truncateForLog(redactSecrets(`${error.name}: ${error.message}`));
  }
  return truncateForLog(redactSecrets(error));
}
