/**
 * WeCom adapter configuration normalization + validation.
 *
 * `ctx.config` is the merged `channels.wecom` object from core (defaults
 * applied, `env:`/`${ENV}` already interpolated). This module never logs
 * secret values and turns missing credentials into a startup error so
 * `doctor`/`serve` report them per channel.
 */
import { decodeEncodingAESKey } from './crypto.js';
import { DEFAULT_WECOM_API_BASE_URL } from './api.js';
import { normalizeWebhookPath } from './webhook.js';
import { DEFAULT_WECOM_WS_URL } from './ws-protocol.js';

/** @param {unknown} value @param {number} fallback @returns {number} */
function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** @param {unknown} value @returns {string} */
function str(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * @param {Record<string, any>} [raw]
 * @returns {{
 *   mode: 'ws'|'webhook',
 *   invalidMode: string,
 *   accountId: string,
 *   webhookPath: string,
 *   botId: string, secret: string,
 *   token: string, encodingAESKey: string, corpId: string, agentId: string,
 *   wsUrl: string,
 *   heartbeatIntervalMs: number,
 *   reconnectInitialDelayMs: number,
 *   reconnectMaxDelayMs: number,
 *   authTimeoutMs: number,
 *   replyAckTimeoutMs: number,
 *   maxMissedPong: number,
 *   reconnectOnKicked: boolean,
 *   botName: string,
 *   apiBaseUrl: string,
 *   requestTimeoutMs: number,
 * }}
 */
export function normalizeWecomConfig(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const configuredMode = str(source.mode);
  const mode = configuredMode === 'webhook' ? 'webhook' : 'ws';
  return {
    mode,
    invalidMode: configuredMode !== '' && configuredMode !== 'ws' && configuredMode !== 'webhook' ? configuredMode : '',
    accountId: str(source.accountId) || 'wecom',
    webhookPath: normalizeWebhookPath(source.webhookPath),
    botId: str(source.botId),
    secret: str(source.secret),
    token: str(source.token),
    encodingAESKey: str(source.encodingAESKey),
    corpId: str(source.corpId),
    agentId: str(source.agentId),
    wsUrl: str(source.wsUrl) || DEFAULT_WECOM_WS_URL,
    heartbeatIntervalMs: positiveInt(source.heartbeatIntervalMs, 30_000),
    reconnectInitialDelayMs: positiveInt(source.reconnectInitialDelayMs, 1_000),
    reconnectMaxDelayMs: positiveInt(source.reconnectMaxDelayMs, 30_000),
    authTimeoutMs: positiveInt(source.authTimeoutMs, 15_000),
    replyAckTimeoutMs: positiveInt(source.replyAckTimeoutMs, 10_000),
    maxMissedPong: positiveInt(source.maxMissedPong, 2),
    reconnectOnKicked: source.reconnectOnKicked === true,
    botName: str(source.botName),
    apiBaseUrl: str(source.apiBaseUrl) || DEFAULT_WECOM_API_BASE_URL,
    requestTimeoutMs: positiveInt(source.requestTimeoutMs, 15_000),
  };
}

/**
 * Validate the normalized config. Error messages name missing fields but never
 * include their values.
 * @param {ReturnType<typeof normalizeWecomConfig>} config
 */
export function validateWecomConfig(config) {
  /** @type {string[]} */
  const problems = [];
  if (config.invalidMode !== '') problems.push(`mode must be "ws" or "webhook" (got "${config.invalidMode}")`);
  if (!/^wss?:\/\//.test(config.wsUrl)) problems.push('wsUrl must start with ws:// or wss://');

  if (config.mode === 'ws') {
    if (config.botId === '') problems.push('botId is required in ws mode');
    if (config.secret === '') problems.push('secret is required in ws mode');
  } else {
    if (config.token === '') problems.push('token is required in webhook mode');
    if (config.encodingAESKey === '') {
      problems.push('encodingAESKey is required in webhook mode');
    } else {
      try {
        decodeEncodingAESKey(config.encodingAESKey);
      } catch {
        problems.push('encodingAESKey must be a 43-character Base64 key (32 bytes after decoding)');
      }
    }
    if (config.corpId === '') problems.push('corpId is required in webhook mode');
    if (config.agentId === '') problems.push('agentId is required in webhook mode');
    if (config.secret === '') problems.push('secret is required in webhook mode (used for app message API)');
  }
  if (problems.length > 0) {
    throw new Error(`wecom channel config invalid (mode=${config.mode}): ${problems.join('; ')}`);
  }
}
