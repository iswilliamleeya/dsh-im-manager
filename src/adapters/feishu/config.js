/**
 * Feishu / Lark channel config normalization and validation.
 *
 * The gateway (`src/core/config.js`) has already interpolated `env:NAME` and
 * `${NAME}` tokens before handing the channel config to the adapter, so this
 * module only deals with plain values. Everything thrown here is meant to be a
 * clear, actionable startup error — the gateway logs it and disables the channel.
 */

export const DEFAULT_WEBHOOK_PATH = '/webhook/feishu';

const DOMAINS = new Set(['feishu', 'lark']);
// Feishu/Lark app ids look like `cli_` + 16 hex chars. The SDK's WS client
// silently refuses to connect for anything else, which is very hard to debug,
// so we fail fast in `ws` mode with a clear message.
const APP_ID_PATTERN = /^cli_[0-9a-f]{16}$/i;
const URL_PATTERN = /^https?:\/\//i;

/**
 * @param {unknown} value
 * @returns {string}
 */
function trimmed(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * @param {unknown} value
 * @returns {boolean | undefined}
 */
function optionalBoolean(value) {
  return typeof value === 'boolean' ? value : undefined;
}

/**
 * Normalize the raw `channels.feishu` object into the shape the adapter uses.
 *
 * @param {Record<string, unknown>} [raw]
 * @returns {{
 *   mode: 'ws' | 'webhook',
 *   accountId: string,
 *   appId: string,
 *   appSecret: string,
 *   domain: string,
 *   encryptKey: string,
 *   verificationToken: string,
 *   webhookPath: string,
 *   botOpenId: string,
 *   botName: string,
 *   markdownAsCard: boolean,
 *   replyInThread: boolean,
 * }}
 */
export function normalizeFeishuConfig(raw = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('feishu: channel config (channels.feishu) must be an object');
  }

  const modeRaw = trimmed(raw.mode) || trimmed(raw.connectionMode) || 'ws';
  const mode = modeRaw === 'websocket' ? 'ws' : modeRaw;
  if (mode !== 'ws' && mode !== 'webhook') {
    throw new Error(`feishu: config.mode must be "ws" or "webhook" (got "${modeRaw}")`);
  }

  const appId = trimmed(raw.appId);
  const appSecret = trimmed(raw.appSecret);
  if (appId.length === 0 || appSecret.length === 0) {
    const missing = [appId.length === 0 ? 'appId' : '', appSecret.length === 0 ? 'appSecret' : '']
      .filter((part) => part.length > 0)
      .join(' and ');
    throw new Error(
      `feishu: missing ${missing}. Set channels.feishu.appId / channels.feishu.appSecret ` +
        '(env:FEISHU_APP_ID / env:FEISHU_APP_SECRET are supported). '
        + 'Create an enterprise self-built app at https://open.feishu.cn/app.',
    );
  }

  if (mode === 'ws' && !APP_ID_PATTERN.test(appId)) {
    throw new Error(
      `feishu: invalid appId "${appId}" for mode=ws — expected "cli_" followed by 16 hex characters. `
        + 'Copy the App ID from the Feishu developer console (Credentials & Basic Info).',
    );
  }

  const domainRaw = trimmed(raw.domain) || 'feishu';
  const domain = domainRaw.toLowerCase();
  if (!DOMAINS.has(domain) && !URL_PATTERN.test(domainRaw)) {
    throw new Error(
      `feishu: config.domain must be "feishu" or "lark" (got "${domainRaw}"). `
        + 'Use "lark" for apps created on open.larksuite.com.',
    );
  }

  const webhookPath = trimmed(raw.webhookPath) || DEFAULT_WEBHOOK_PATH;
  if (mode === 'webhook' && !webhookPath.startsWith('/')) {
    throw new Error(`feishu: config.webhookPath must start with "/" (got "${webhookPath}")`);
  }

  return {
    mode,
    accountId: trimmed(raw.accountId) || 'feishu',
    appId,
    appSecret,
    domain: DOMAINS.has(domain) ? domain : domainRaw,
    encryptKey: trimmed(raw.encryptKey),
    verificationToken: trimmed(raw.verificationToken),
    webhookPath,
    botOpenId: trimmed(raw.botOpenId),
    botName: trimmed(raw.botName),
    markdownAsCard: optionalBoolean(raw.markdownAsCard)
      ?? optionalBoolean(raw.sendMarkdownAsCard)
      ?? true,
    replyInThread: optionalBoolean(raw.replyInThread) ?? false,
  };
}
