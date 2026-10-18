/**
 * WeCom 自建应用 outbound API (webhook mode).
 *
 * `cgi-bin/gettoken` obtains a cached access_token; `cgi-bin/message/send`
 * delivers text / markdown app messages. Both use the injected `fetch`, so
 * tests never touch the real platform.
 *
 * Secrets are never logged: request URLs carry `corpsecret` / `access_token`,
 * so errors only ever include errcode/errmsg.
 */

export const DEFAULT_WECOM_API_BASE_URL = 'https://qyapi.weixin.qq.com';

const TOKEN_ERROR_CODES = new Set([40014, 42001, 42007, 42009]);

const NOOP_LOG = Object.freeze({
  debug() {},
  info() {},
  warn() {},
  error() {},
});

/**
 * @param {unknown} value
 * @returns {number}
 */
function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export class WecomAppApi {
  /**
   * @param {{
   *   corpId: string,
   *   agentId: string|number,
   *   secret: string,
   *   apiBaseUrl?: string,
   *   fetchImpl?: typeof fetch,
   *   log?: { debug?: Function, info?: Function, warn?: Function, error?: Function },
   *   requestTimeoutMs?: number,
   *   tokenRefreshSkewMs?: number,
   * }} options
   */
  constructor(options) {
    this.corpId = String(options.corpId ?? '');
    this.agentId = options.agentId;
    this.secret = String(options.secret ?? '');
    this.apiBaseUrl = String(options.apiBaseUrl ?? DEFAULT_WECOM_API_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl;
    this.log = options.log ?? NOOP_LOG;
    this.requestTimeoutMs = positiveInt(options.requestTimeoutMs, 15_000);
    this.tokenRefreshSkewMs = options.tokenRefreshSkewMs ?? 300_000;
    this.accessToken = '';
    this.accessTokenExpiresAt = 0;
  }

  /**
   * @param {string} url
   * @param {RequestInit} [init]
   * @returns {Promise<Record<string, any>>}
   */
  async requestJson(url, init = {}) {
    const fetchImpl = this.fetchImpl ?? globalThis.fetch;
    if (typeof fetchImpl !== 'function') {
      throw new Error('wecom api: fetch is not available in this runtime');
    }
    /** @type {RequestInit} */
    const requestInit = {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(this.requestTimeoutMs),
    };
    let response;
    try {
      response = await fetchImpl(url, requestInit);
    } catch (error) {
      throw new Error(`wecom api request failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    let text;
    try {
      text = await response.text();
    } catch (error) {
      throw new Error(`wecom api response read failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      const parsed = JSON.parse(text);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      const status = typeof response.status === 'number' ? response.status : 0;
      throw new Error(`wecom api returned non-JSON response (HTTP ${status})`);
    }
  }

  /**
   * @param {{ force?: boolean }} [options]
   * @returns {Promise<string>}
   */
  async getAccessToken(options = {}) {
    if (!options.force && this.accessToken !== '' && Date.now() < this.accessTokenExpiresAt) {
      return this.accessToken;
    }
    if (!this.corpId || !this.secret) {
      throw new Error('wecom api: corpId and secret are required to fetch an access_token');
    }
    const query = new URLSearchParams({ corpid: this.corpId, corpsecret: this.secret });
    const data = await this.requestJson(`${this.apiBaseUrl}/cgi-bin/gettoken?${query.toString()}`);
    if (data.errcode !== 0 || typeof data.access_token !== 'string' || data.access_token === '') {
      throw new Error(`wecom gettoken failed: errcode=${data.errcode ?? 'unknown'} errmsg=${String(data.errmsg ?? '')}`);
    }
    this.accessToken = data.access_token;
    const expiresInSec = Number(data.expires_in);
    const ttlMs = Number.isFinite(expiresInSec) && expiresInSec > 0 ? expiresInSec * 1000 : 7_200_000;
    this.accessTokenExpiresAt = Date.now() + Math.max(0, ttlMs - this.tokenRefreshSkewMs);
    return this.accessToken;
  }

  /**
   * Send an app message. Only DM is supported: 自建应用 callbacks do not carry
   * group chat messages (groups are the 智能机器人 ws mode's territory).
   * @param {{ target: import('../../core/types.js').ReplyTarget, text: string, format?: 'plain'|'markdown' }} params
   * @returns {Promise<{ messageId?: string }>}
   */
  async sendMessage(params) {
    const content = String(params.text ?? '');
    if (content.trim() === '') return {};
    if (params.target?.conversationType === 'group') {
      throw new Error('wecom webhook mode cannot send to a group chat; use mode "ws" (智能机器人长连接) for group chats');
    }
    const raw = /** @type {Record<string, any>} */ (params.target?.raw ?? {});
    const touser = String(raw.fromUserName ?? params.target?.conversationId ?? '').trim();
    if (!touser) throw new Error('wecom message/send: missing recipient (touser)');
    const useMarkdown = params.format === 'markdown';
    const msgtype = useMarkdown ? 'markdown' : 'text';
    const agentId = Number.isFinite(Number(this.agentId)) ? Number(this.agentId) : this.agentId;
    const body = {
      touser,
      msgtype,
      agentid: agentId,
      [msgtype]: { content },
      enable_duplicate_check: 0,
    };
    const send = async (token) =>
      this.requestJson(`${this.apiBaseUrl}/cgi-bin/message/send?access_token=${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    let token = await this.getAccessToken();
    let data = await send(token);
    if (TOKEN_ERROR_CODES.has(Number(data.errcode))) {
      this.log.warn?.(`wecom access_token rejected (errcode=${data.errcode}); refreshing once`);
      token = await this.getAccessToken({ force: true });
      data = await send(token);
    }
    if (data.errcode !== 0) {
      throw new Error(`wecom message/send failed: errcode=${data.errcode ?? 'unknown'} errmsg=${String(data.errmsg ?? '')}`);
    }
    return {};
  }
}
