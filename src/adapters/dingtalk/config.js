/**
 * DingTalk adapter configuration: normalization, secret resolution and
 * validation. See docs/contracts.md §5 and docs/channels/dingtalk.md.
 *
 * The gateway already interpolates `env:NAME` / `${NAME}` while loading the
 * config, but tests (and callers embedding the adapter directly) may pass raw
 * values, so `normalizeConfig()` also resolves an `env:` prefix through the
 * `secret(name)` callback when one is available.
 */

export const ADAPTER_ID = 'dingtalk';
export const DEFAULT_WEBHOOK_PATH = '/webhook/dingtalk';
export const DEFAULT_MARKDOWN_TITLE = 'DSH';
export const DEFAULT_SIGNATURE_MAX_SKEW_MS = 60 * 60 * 1000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
export const DEFAULT_UA = 'dsh-im-manager/dingtalk';

/**
 * @param {unknown} value
 * @returns {string}
 */
function readString(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}

/**
 * @param {unknown} value
 * @returns {number | undefined}
 */
function positiveNumber(value) {
  const number = typeof value === 'string' ? Number(value) : value;
  return typeof number === 'number' && Number.isFinite(number) && number > 0 ? number : undefined;
}

/**
 * Resolve one config value that may be written as `env:ENV_NAME`.
 *
 * @param {unknown} value
 * @param {((name: string) => string | undefined)} [secret]
 * @returns {string}
 */
export function resolveSecretValue(value, secret) {
  const raw = readString(value);
  if (raw.length === 0) return '';
  if (!raw.startsWith('env:')) return raw;
  const name = raw.slice(4).trim();
  if (name.length === 0) return '';
  const fromContext = typeof secret === 'function' ? secret(name) : undefined;
  if (typeof fromContext === 'string' && fromContext.trim().length > 0) return fromContext.trim();
  const fromEnv = process.env[name];
  return typeof fromEnv === 'string' ? fromEnv.trim() : '';
}

/**
 * Normalize a webhook path so it always starts with `/` and has no trailing
 * slash. The path is used verbatim for `ctx.http.route`.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeWebhookPath(value) {
  const raw = readString(value) || DEFAULT_WEBHOOK_PATH;
  const withLeadingSlash = raw.startsWith('/') ? raw : `/${raw}`;
  if (withLeadingSlash === '/') return withLeadingSlash;
  return withLeadingSlash.replace(/\/+$/, '') || DEFAULT_WEBHOOK_PATH;
}

/**
 * @typedef {Object} DingtalkConfig
 * @property {'stream'|'webhook'} mode
 * @property {string} accountId
 * @property {string} clientId
 * @property {string} clientSecret
 * @property {string} robotCode
 * @property {string} botUserId
 * @property {string} webhookPath
 * @property {boolean} verifySignature
 * @property {string} signatureSecret
 * @property {number} signatureMaxSkewMs
 * @property {number} requestTimeoutMs
 * @property {string} markdownTitle
 * @property {string} ua
 * @property {boolean} keepAlive
 * @property {boolean} quoteReply
 */

/**
 * @param {Record<string, unknown>} [config]
 * @param {{ secret?: (name: string) => string | undefined }} [options]
 * @returns {DingtalkConfig}
 */
export function normalizeConfig(config = {}, options = {}) {
  const source = config !== null && typeof config === 'object' ? config : {};
  const secret = typeof options.secret === 'function' ? options.secret : undefined;
  const clientId = resolveSecretValue(source.clientId, secret);
  const clientSecret = resolveSecretValue(source.clientSecret, secret);
  const robotCode = resolveSecretValue(source.robotCode, secret) || clientId;
  return {
    mode: source.mode === 'webhook' ? 'webhook' : 'stream',
    accountId: readString(source.accountId) || ADAPTER_ID,
    clientId,
    clientSecret,
    robotCode,
    botUserId: resolveSecretValue(source.botUserId, secret),
    webhookPath: normalizeWebhookPath(source.webhookPath),
    verifySignature: source.verifySignature !== false,
    signatureSecret: resolveSecretValue(source.signatureSecret, secret) || clientSecret,
    signatureMaxSkewMs: positiveNumber(source.signatureMaxSkewMs) ?? DEFAULT_SIGNATURE_MAX_SKEW_MS,
    requestTimeoutMs: positiveNumber(source.requestTimeoutMs) ?? DEFAULT_REQUEST_TIMEOUT_MS,
    markdownTitle: readString(source.markdownTitle) || DEFAULT_MARKDOWN_TITLE,
    ua: readString(source.ua) || DEFAULT_UA,
    keepAlive: source.keepAlive === true,
    quoteReply: source.quoteReply === true,
  };
}

/**
 * Channel-specific validation (the core only validates the shared shape).
 * Throws an actionable error so `doctor` / startup can report the channel.
 *
 * Accepts either the raw `channels.dingtalk` object (as `doctor` passes it) or
 * the normalized object returned by {@link normalizeConfig}.
 *
 * @param {Record<string, any>} config
 * @returns {Record<string, any>}
 */
export function validateConfig(config) {
  /** @param {string} message @returns {never} */
  const fail = (message) => {
    throw new Error(`[dingtalk] invalid config: ${message}`);
  };
  const source = config !== null && typeof config === 'object' ? config : {};
  const accountId = readString(source.accountId) || ADAPTER_ID;
  const mode = source.mode === 'webhook' ? 'webhook' : 'stream';
  const clientId = readString(source.clientId);
  const clientSecret = readString(source.clientSecret);
  const signatureSecret = readString(source.signatureSecret) || clientSecret;
  const webhookPath = normalizeWebhookPath(source.webhookPath);
  const verifySignature = source.verifySignature !== false;

  if (accountId.length === 0) fail('accountId must be a non-empty string');
  if (mode === 'stream') {
    if (clientId.length === 0) {
      fail('clientId (AppKey) is required for stream mode; set channels.dingtalk.clientId or "env:DINGTALK_CLIENT_ID"');
    }
    if (clientSecret.length === 0) {
      fail('clientSecret (AppSecret) is required for stream mode; set channels.dingtalk.clientSecret or "env:DINGTALK_CLIENT_SECRET"');
    }
  } else {
    if (verifySignature && signatureSecret.length === 0) {
      fail(
        'clientSecret (or signatureSecret) is required to verify webhook signatures; '
          + 'set channels.dingtalk.clientSecret or "env:DINGTALK_CLIENT_SECRET", '
          + 'or set verifySignature=false for local testing only',
      );
    }
  }
  if (!webhookPath.startsWith('/')) fail('webhookPath must start with "/"');
  return /** @type {Record<string, any>} */ (config);
}
