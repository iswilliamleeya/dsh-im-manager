/**
 * iLink HTTP client for the personal WeChat channel.
 *
 * One instance talks to a single bot account: API base URL + bot token. The
 * base URL is mutable because the QR login flow can redirect polling to an IDC
 * host and the `confirmed` response carries the effective `baseurl`.
 *
 * Responsibilities:
 *   - build request URLs / headers / `base_info` for every endpoint
 *   - enforce per-request timeouts, combined with the gateway abort signal
 *   - treat long-poll client-side timeouts (`getupdates`,
 *     `get_qrcode_status`) as normal control flow
 *   - normalize server envelopes: non-zero `ret`/`errcode` throws; `-14`
 *     throws {@link StaleTokenError}
 *   - never put a token in an Error message (see `redactSecrets`)
 *
 * A custom `transport` may be injected (tests) with the same shape as the
 * built-in fetch transport: `{ request(url, { method, headers, body, signal }) }`
 * returning the parsed JSON body.
 *
 * @see /tmp/wxref2/tencent/docs_protocol.md (upstream protocol description)
 * @see docs/channels/weixin.md
 */
import {
  DEFAULT_BOT_TYPE,
  DEFAULT_LIGHT_TIMEOUT_MS,
  DEFAULT_LONG_POLL_TIMEOUT_MS,
  DEFAULT_QR_POLL_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  ENDPOINTS,
  STALE_TOKEN_ERRCODE,
  buildApplicationHeaders,
  buildBaseInfo,
  buildHeaders,
  clientVersionFromString,
  describeError,
  isPlainObject,
  normalizeBaseUrl,
  redactSecrets,
  truncateForLog,
  assertTrustedBaseUrl,
  DEFAULT_BASE_URL,
  DEFAULT_CDN_BASE_URL,
  ADAPTER_VERSION,
  DEFAULT_BOT_AGENT,
} from './protocol.js';

/** Sentinel returned by internal request helper on a tolerated client timeout. */
const TIMEOUT = Symbol('weixin-timeout');

/**
 * Base class for every typed error this adapter throws.
 * Messages are always redacted and never contain a token.
 */
export class WeixinError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, cause?: unknown, ret?: number, errcode?: number }} [options]
   */
  constructor(message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'WeixinError';
    this.code = options.code ?? 'WEIXIN_ERROR';
    if (options.ret !== undefined) this.ret = options.ret;
    if (options.errcode !== undefined) this.errcode = options.errcode;
  }
}

/** The bot token is stale/expired (server `ret`/`errcode` = -14). Requires re-login. */
export class StaleTokenError extends WeixinError {
  /**
   * @param {string} [operation]
   * @param {{ cause?: unknown }} [options]
   */
  constructor(operation = 'request', options = {}) {
    super(
      '微信登录凭据已失效（-14），运行 `dsh-im-manager weixin login` 重新扫码登录',
      { code: 'WEIXIN_STALE_TOKEN', cause: options.cause },
    );
    this.name = 'StaleTokenError';
    this.operation = operation;
  }
}

/** A request exceeded its client-side timeout. */
export class WeixinTimeoutError extends WeixinError {
  /** @param {string} operation @param {{ cause?: unknown }} [options] */
  constructor(operation, options = {}) {
    super(`微信接口 ${operation} 请求超时`, { code: 'WEIXIN_TIMEOUT', cause: options.cause });
    this.name = 'WeixinTimeoutError';
    this.operation = operation;
  }
}

/** A request was cancelled by the gateway/adapter abort signal. */
export class WeixinAbortError extends WeixinError {
  /** @param {string} operation @param {{ cause?: unknown }} [options] */
  constructor(operation, options = {}) {
    super(`微信接口 ${operation} 请求已取消`, { code: 'WEIXIN_ABORTED', cause: options.cause });
    this.name = 'WeixinAbortError';
    this.operation = operation;
  }
}

/** Non-2xx HTTP response. */
export class WeixinHttpError extends WeixinError {
  /** @param {number} status @param {string} message @param {{ cause?: unknown }} [options] */
  constructor(status, message, options = {}) {
    super(message, { code: 'WEIXIN_HTTP_ERROR', cause: options.cause });
    this.name = 'WeixinHttpError';
    this.status = status;
  }
}

/** Malformed response body / protocol violation. */
export class WeixinProtocolError extends WeixinError {
  /** @param {string} message @param {{ cause?: unknown }} [options] */
  constructor(message, options = {}) {
    super(message, { code: 'WEIXIN_PROTOCOL_ERROR', cause: options.cause });
    this.name = 'WeixinProtocolError';
  }
}

/**
 * Default transport over `fetch`, returning the parsed JSON body.
 *
 * @param {{ fetchImpl?: typeof fetch }} [options]
 * @returns {{ request: (url: string, init: { method?: string, headers?: Record<string, string>, body?: unknown, signal?: AbortSignal }) => Promise<unknown> }}
 */
export function createFetchTransport(options = {}) {
  const fetchImpl =
    typeof options.fetchImpl === 'function'
      ? options.fetchImpl
      : typeof globalThis.fetch === 'function'
        ? globalThis.fetch
        : undefined;
  if (typeof fetchImpl !== 'function') {
    throw new WeixinError('weixin: no fetch implementation available (Node >= 22 required)', {
      code: 'WEIXIN_NO_FETCH',
    });
  }
  return {
    async request(url, init = {}) {
      /** @type {RequestInit} */
      const fetchInit = {
        method: init.method ?? 'GET',
        ...(init.headers ? { headers: init.headers } : {}),
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        ...(init.signal ? { signal: init.signal } : {}),
      };
      const response = await fetchImpl(url, fetchInit);
      const status = Number(response?.status ?? 0);
      const ok = typeof response?.ok === 'boolean' ? response.ok : status >= 200 && status < 300;
      let text = '';
      try {
        text = typeof response?.text === 'function' ? await response.text() : '';
      } catch {
        text = '';
      }
      if (!ok) {
        const detail = text === '' ? '' : `：${truncateForLog(redactSecrets(text))}`;
        throw new WeixinHttpError(status, `微信接口 HTTP ${status}${detail}`);
      }
      if (typeof text !== 'string' || text.trim() === '') return {};
      try {
        return JSON.parse(text);
      } catch {
        throw new WeixinProtocolError(`微信接口返回了非 JSON 响应：${truncateForLog(redactSecrets(text))}`);
      }
    },
  };
}

/**
 * Resolve the transport dependency from adapter options.
 * @param {{ transport?: unknown, fetch?: typeof fetch }} options
 */
function resolveTransport(options) {
  if (options.transport !== undefined && options.transport !== null) {
    const candidate = options.transport;
    if (typeof candidate === 'function') {
      return {
        request: (url, init) => candidate(url, init),
      };
    }
    if (typeof candidate === 'object' && typeof candidate.request === 'function') {
      return candidate;
    }
    throw new TypeError('weixin: deps.transport must be a function or an object with request()');
  }
  return createFetchTransport({ fetchImpl: options.fetch });
}

/**
 * Wait for `promise` but give up after `ms`; used around best-effort notify
 * calls so adapter shutdown cannot hang on a dead network.
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @returns {Promise<T | undefined>}
 */
export async function withTimeout(promise, ms) {
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(undefined), Math.max(1, ms));
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * iLink HTTP client bound to one bot account.
 */
export class ILinkClient {
  /**
   * @param {{
   *   baseUrl?: string,
   *   cdnBaseUrl?: string,
   *   token?: string,
   *   requestTimeoutMs?: number,
   *   longPollTimeoutMs?: number,
   *   qrPollTimeoutMs?: number,
   *   botAgent?: string,
   *   channelVersion?: string,
   *   routeTag?: string,
   *   transport?: unknown,
   *   fetch?: typeof fetch,
   *   now?: () => number,
   *   rand?: () => number,
   * }} [options]
   */
  constructor(options = {}) {
    this.configuredBaseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
    this.baseUrl = this.configuredBaseUrl;
    this.cdnBaseUrl = String(options.cdnBaseUrl ?? DEFAULT_CDN_BASE_URL).trim().replace(/\/+$/, '');
    this.token = typeof options.token === 'string' && options.token.trim() !== '' ? options.token.trim() : undefined;
    this.requestTimeoutMs = Number.isFinite(options.requestTimeoutMs) && options.requestTimeoutMs > 0
      ? Math.floor(options.requestTimeoutMs)
      : DEFAULT_REQUEST_TIMEOUT_MS;
    this.longPollTimeoutMs = Number.isFinite(options.longPollTimeoutMs) && options.longPollTimeoutMs > 0
      ? Math.floor(options.longPollTimeoutMs)
      : DEFAULT_LONG_POLL_TIMEOUT_MS;
    this.qrPollTimeoutMs = Number.isFinite(options.qrPollTimeoutMs) && options.qrPollTimeoutMs > 0
      ? Math.floor(options.qrPollTimeoutMs)
      : DEFAULT_QR_POLL_TIMEOUT_MS;
    this.botAgent = typeof options.botAgent === 'string' && options.botAgent.trim() !== '' ? options.botAgent.trim() : DEFAULT_BOT_AGENT;
    this.channelVersion = typeof options.channelVersion === 'string' && options.channelVersion.trim() !== '' ? options.channelVersion.trim() : ADAPTER_VERSION;
    this.clientVersion = clientVersionFromString(this.channelVersion);
    this.routeTag = typeof options.routeTag === 'string' && options.routeTag.trim() !== '' ? options.routeTag.trim() : undefined;
    this.rand = typeof options.rand === 'function' ? options.rand : undefined;
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.transport = resolveTransport(options);
  }

  /** Update the bot token (after QR confirmation / credential reload). */
  setToken(token) {
    this.token = typeof token === 'string' && token.trim() !== '' ? token.trim() : undefined;
  }

  /**
   * Switch the effective API base URL (QR redirect / confirmed `baseurl`).
   * Only official `*.weixin.qq.com` hosts or the configured host are accepted.
   * @param {unknown} baseUrl
   * @returns {string}
   */
  setBaseUrl(baseUrl) {
    const trusted = assertTrustedBaseUrl(baseUrl, { configuredBaseUrl: this.configuredBaseUrl });
    this.baseUrl = trusted;
    return this.baseUrl;
  }

  /**
   * Join the base URL with an endpoint path.
   * @param {string} endpoint
   * @returns {string}
   */
  urlFor(endpoint) {
    return `${this.baseUrl}/${String(endpoint).replace(/^\/+/, '')}`;
  }

  /** `base_info` for authenticated requests. */
  baseInfo() {
    return buildBaseInfo({ channelVersion: this.channelVersion, botAgent: this.botAgent });
  }

  /** Full headers (JSON POST) for the current token. */
  headers() {
    return buildHeaders({ token: this.token, rand: this.rand, routeTag: this.routeTag, clientVersion: this.clientVersion });
  }

  /** Application-only headers (QR status polling). */
  applicationHeaders() {
    return buildApplicationHeaders({ routeTag: this.routeTag, clientVersion: this.clientVersion });
  }

  /**
   * Perform one request and return the parsed JSON body (or TIMEOUT).
   *
   * @param {{
   *   operation: string,
   *   method?: 'GET'|'POST',
   *   endpoint: string,
   *   body?: unknown,
   *   timeoutMs: number,
   *   signal?: AbortSignal,
   *   applicationOnly?: boolean,
   *   authenticated?: boolean,
   *   tolerateTimeout?: boolean,
   * }} request
   * @returns {Promise<unknown>}
   */
  async #request(request) {
    const url = this.urlFor(request.endpoint);
    /** @type {Record<string, string>} */
    const headers = request.applicationOnly === true
      ? this.applicationHeaders()
      : this.headers();
    if (request.authenticated === false) delete headers.Authorization;

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, Math.max(1, request.timeoutMs));
    timer.unref?.();

    const external = request.signal;
    const onExternalAbort = () => {
      controller.abort();
    };
    if (external) {
      if (external.aborted) controller.abort();
      else external.addEventListener('abort', onExternalAbort, { once: true });
    }

    try {
      const data = await this.transport.request(url, {
        method: request.method ?? 'POST',
        headers,
        ...(request.body === undefined ? {} : { body: request.body }),
        signal: controller.signal,
        timeoutMs: request.timeoutMs,
      });
      // A stop can land while a (non-fetch) transport still resolves; never
      // hand data back after the caller aborted.
      if (external?.aborted) throw new WeixinAbortError(request.operation);
      return data;
    } catch (error) {
      if (error instanceof WeixinError) throw error;
      if (external?.aborted) throw new WeixinAbortError(request.operation, { cause: error });
      const name = /** @type {{ name?: string }} */ (error)?.name;
      const aborted = timedOut || name === 'AbortError' || name === 'TimeoutError' || name === 'WeixinTimeoutError';
      if (aborted) {
        if (request.tolerateTimeout === true) return TIMEOUT;
        throw new WeixinTimeoutError(request.operation, { cause: error });
      }
      throw new WeixinError(
        `微信接口 ${request.operation} 请求失败：${truncateForLog(redactSecrets(describeError(error)), 200)}`,
        { code: 'WEIXIN_NETWORK_ERROR', cause: error },
      );
    } finally {
      clearTimeout(timer);
      external?.removeEventListener('abort', onExternalAbort);
    }
  }

  /**
   * Check the response envelope for `ret`/`errcode` errors.
   * @param {unknown} data
   * @param {string} operation
   * @returns {Record<string, any>}
   */
  #envelope(data, operation) {
    if (data === TIMEOUT) return {};
    if (data === undefined || data === null) return {};
    if (!isPlainObject(data)) {
      throw new WeixinProtocolError(`微信接口 ${operation} 返回了非对象响应`);
    }
    const ret = data.ret;
    const errcode = data.errcode;
    if (ret === STALE_TOKEN_ERRCODE || errcode === STALE_TOKEN_ERRCODE) {
      throw new StaleTokenError(operation);
    }
    const retFailed = ret !== undefined && ret !== null && ret !== 0;
    const errFailed = errcode !== undefined && errcode !== null && errcode !== 0;
    if (retFailed || errFailed) {
      const code = retFailed ? ret : errcode;
      const label = retFailed ? `ret=${ret}` : `errcode=${errcode}`;
      const upstream = typeof data.errmsg === 'string' && data.errmsg !== ''
        ? `：${truncateForLog(redactSecrets(data.errmsg), 200)}`
        : '';
      throw new WeixinError(`微信接口 ${operation} 返回错误 ${label}${upstream}`, {
        code: 'WEIXIN_API_ERROR',
        ...(typeof ret === 'number' ? { ret } : {}),
        ...(typeof errcode === 'number' ? { errcode } : {}),
      });
    }
    return data;
  }

  /**
   * POST /ilink/bot/get_bot_qrcode?bot_type=3
   * @param {{ localTokens?: string[], botType?: string, signal?: AbortSignal, timeoutMs?: number }} [options]
   * @returns {Promise<{ qrcode: string, qrcode_img_content: string }>}
   */
  async getBotQrcode(options = {}) {
    const botType = typeof options.botType === 'string' && options.botType.trim() !== '' ? options.botType.trim() : DEFAULT_BOT_TYPE;
    /** @type {string[]} */
    const localTokens = [];
    if (Array.isArray(options.localTokens)) {
      const seen = new Set();
      for (const candidate of options.localTokens) {
        if (typeof candidate !== 'string') continue;
        const token = candidate.trim();
        if (token === '' || seen.has(token)) continue;
        seen.add(token);
        localTokens.push(token);
        if (localTokens.length >= 10) break;
      }
    }
    const data = await this.#request({
      operation: 'getBotQrcode',
      method: 'POST',
      endpoint: `${ENDPOINTS.GET_BOT_QRCODE}?bot_type=${encodeURIComponent(botType)}`,
      body: { local_token_list: localTokens },
      timeoutMs: options.timeoutMs ?? this.requestTimeoutMs,
      authenticated: false,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const body = this.#envelope(data, 'getBotQrcode');
    if (typeof body.qrcode !== 'string' || body.qrcode === '') {
      throw new WeixinProtocolError('微信登录：服务器未返回二维码');
    }
    return {
      qrcode: body.qrcode,
      qrcode_img_content: typeof body.qrcode_img_content === 'string' ? body.qrcode_img_content : '',
    };
  }

  /**
   * GET /ilink/bot/get_qrcode_status (long-poll; client timeout → `wait`).
   * @param {{ qrcode: string, verifyCode?: string, signal?: AbortSignal, timeoutMs?: number }} options
   * @returns {Promise<Record<string, any> & { status: string }>}
   */
  async getQrcodeStatus(options = {}) {
    const params = new URLSearchParams({ qrcode: String(options.qrcode ?? '') });
    if (typeof options.verifyCode === 'string' && options.verifyCode !== '') {
      params.set('verify_code', options.verifyCode);
    }
    const data = await this.#request({
      operation: 'getQrcodeStatus',
      method: 'GET',
      endpoint: `${ENDPOINTS.GET_QRCODE_STATUS}?${params.toString()}`,
      timeoutMs: options.timeoutMs ?? this.qrPollTimeoutMs,
      applicationOnly: true,
      tolerateTimeout: true,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (data === TIMEOUT) return { status: 'wait' };
    const body = this.#envelope(data, 'getQrcodeStatus');
    const status = typeof body.status === 'string' && body.status !== '' ? body.status : 'wait';
    return { ...body, status };
  }

  /**
   * POST /ilink/bot/getupdates (long-poll; client timeout → empty round).
   * @param {{ getUpdatesBuf?: string, longPollTimeoutMs?: number, signal?: AbortSignal }} [options]
   * @returns {Promise<{ msgs: any[], get_updates_buf?: string, longpolling_timeout_ms?: number, timedOut: boolean }>}
   */
  async getUpdates(options = {}) {
    const getUpdatesBuf = typeof options.getUpdatesBuf === 'string' ? options.getUpdatesBuf : '';
    const timeout =
      Number.isFinite(options.longPollTimeoutMs) && options.longPollTimeoutMs > 0
        ? Math.floor(options.longPollTimeoutMs)
        : this.longPollTimeoutMs;
    const data = await this.#request({
      operation: 'getUpdates',
      method: 'POST',
      endpoint: ENDPOINTS.GET_UPDATES,
      body: { get_updates_buf: getUpdatesBuf, base_info: this.baseInfo() },
      timeoutMs: timeout,
      tolerateTimeout: true,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (data === TIMEOUT) {
      return { msgs: [], get_updates_buf: getUpdatesBuf, timedOut: true };
    }
    const body = this.#envelope(data, 'getUpdates');
    return {
      msgs: Array.isArray(body.msgs) ? body.msgs : [],
      ...(typeof body.get_updates_buf === 'string' ? { get_updates_buf: body.get_updates_buf } : {}),
      ...(Number.isFinite(body.longpolling_timeout_ms) ? { longpolling_timeout_ms: body.longpolling_timeout_ms } : {}),
      timedOut: false,
    };
  }

  /**
   * POST /ilink/bot/sendmessage
   * @param {{ msg: Record<string, any>, base_info?: Record<string, any> }} payload
   * @param {{ signal?: AbortSignal, timeoutMs?: number }} [options]
   * @returns {Promise<Record<string, any>>}
   */
  async sendMessage(payload, options = {}) {
    if (!isPlainObject(payload) || !isPlainObject(payload.msg)) {
      throw new TypeError('weixin sendMessage requires a msg object');
    }
    const data = await this.#request({
      operation: 'sendMessage',
      method: 'POST',
      endpoint: ENDPOINTS.SEND_MESSAGE,
      body: { msg: payload.msg, base_info: payload.base_info ?? this.baseInfo() },
      timeoutMs: options.timeoutMs ?? this.requestTimeoutMs,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return this.#envelope(data, 'sendMessage');
  }

  /**
   * POST /ilink/bot/getconfig
   * @param {{ ilinkUserId: string, contextToken?: string, signal?: AbortSignal, timeoutMs?: number }} options
   * @returns {Promise<Record<string, any>>}
   */
  async getConfig(options = {}) {
    const data = await this.#request({
      operation: 'getConfig',
      method: 'POST',
      endpoint: ENDPOINTS.GET_CONFIG,
      body: {
        ilink_user_id: String(options.ilinkUserId ?? ''),
        ...(typeof options.contextToken === 'string' && options.contextToken !== ''
          ? { context_token: options.contextToken }
          : {}),
        base_info: this.baseInfo(),
      },
      timeoutMs: options.timeoutMs ?? Math.min(this.requestTimeoutMs, DEFAULT_LIGHT_TIMEOUT_MS),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return this.#envelope(data, 'getConfig');
  }

  /**
   * POST /ilink/bot/sendtyping
   * @param {{ ilinkUserId: string, typingTicket?: string, status: number, signal?: AbortSignal, timeoutMs?: number }} options
   * @returns {Promise<Record<string, any>>}
   */
  async sendTyping(options = {}) {
    const data = await this.#request({
      operation: 'sendTyping',
      method: 'POST',
      endpoint: ENDPOINTS.SEND_TYPING,
      body: {
        ilink_user_id: String(options.ilinkUserId ?? ''),
        ...(typeof options.typingTicket === 'string' && options.typingTicket !== ''
          ? { typing_ticket: options.typingTicket }
          : {}),
        status: Number(options.status),
        base_info: this.baseInfo(),
      },
      timeoutMs: options.timeoutMs ?? Math.min(this.requestTimeoutMs, DEFAULT_LIGHT_TIMEOUT_MS),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return this.#envelope(data, 'sendTyping');
  }

  /**
   * POST /ilink/bot/msg/notifystart (best effort)
   * @param {{ signal?: AbortSignal, timeoutMs?: number }} [options]
   * @returns {Promise<Record<string, any>>}
   */
  async notifyStart(options = {}) {
    const data = await this.#request({
      operation: 'notifyStart',
      method: 'POST',
      endpoint: ENDPOINTS.NOTIFY_START,
      body: { base_info: this.baseInfo() },
      timeoutMs: options.timeoutMs ?? Math.min(this.requestTimeoutMs, DEFAULT_LIGHT_TIMEOUT_MS),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return this.#envelope(data, 'notifyStart');
  }

  /**
   * POST /ilink/bot/msg/notifystop (best effort)
   * @param {{ signal?: AbortSignal, timeoutMs?: number }} [options]
   * @returns {Promise<Record<string, any>>}
   */
  async notifyStop(options = {}) {
    const data = await this.#request({
      operation: 'notifyStop',
      method: 'POST',
      endpoint: ENDPOINTS.NOTIFY_STOP,
      body: { base_info: this.baseInfo() },
      timeoutMs: options.timeoutMs ?? Math.min(this.requestTimeoutMs, DEFAULT_LIGHT_TIMEOUT_MS),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return this.#envelope(data, 'notifyStop');
  }
}
