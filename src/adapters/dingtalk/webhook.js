/**
 * DingTalk webhook (HTTP callback) transport.
 *
 * Inbound requests are authenticated with the DingTalk signature scheme:
 *
 *   stringToSign = `${timestamp}` + "\n" + clientSecret
 *   sign         = base64(HMAC-SHA256(key = clientSecret, data = stringToSign))
 *
 * `timestamp` is epoch milliseconds. The callback is ACKed immediately (before
 * the agent turn) and the message is emitted asynchronously, mirroring the
 * Stream transport.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { DEFAULT_SIGNATURE_MAX_SKEW_MS } from './config.js';

/**
 * Compute the DingTalk signature for a timestamp.
 *
 * @param {string|number} timestamp
 * @param {string} secret
 * @returns {string}
 */
export function computeWebhookSign(timestamp, secret) {
  return createHmac('sha256', String(secret))
    .update(`${timestamp}\n${secret}`)
    .digest('base64');
}

/**
 * @param {unknown} left
 * @param {unknown} right
 * @returns {boolean}
 */
function safeEqual(left, right) {
  const a = Buffer.from(String(left ?? ''));
  const b = Buffer.from(String(right ?? ''));
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * @param {{
 *   timestamp: unknown,
 *   sign: unknown,
 *   secret: string,
 *   now?: number,
 *   maxSkewMs?: number,
 * }} options
 * @returns {{ ok: boolean, reason?: string }}
 */
export function verifyWebhookSignature(options) {
  const secret = typeof options.secret === 'string' ? options.secret : '';
  if (secret.length === 0) return { ok: false, reason: 'signature secret is not configured' };
  if (options.timestamp === undefined || options.timestamp === null || String(options.timestamp).trim().length === 0) {
    return { ok: false, reason: 'missing timestamp' };
  }
  if (options.sign === undefined || options.sign === null || String(options.sign).trim().length === 0) {
    return { ok: false, reason: 'missing sign' };
  }
  const timestamp = Number(options.timestamp);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return { ok: false, reason: 'invalid timestamp' };
  const now = typeof options.now === 'number' ? options.now : Date.now();
  const maxSkewMs = typeof options.maxSkewMs === 'number' && options.maxSkewMs > 0
    ? options.maxSkewMs
    : DEFAULT_SIGNATURE_MAX_SKEW_MS;
  // Timestamps are milliseconds; allow a small amount of future skew.
  if (Math.abs(now - timestamp) > maxSkewMs) return { ok: false, reason: 'timestamp expired' };
  const expected = computeWebhookSign(options.timestamp, secret);
  return safeEqual(expected, String(options.sign).trim())
    ? { ok: true }
    : { ok: false, reason: 'signature mismatch' };
}

/**
 * @param {Record<string, unknown>} headers
 * @returns {string}
 */
function headerValue(headers, names) {
  for (const name of names) {
    const value = headers[name];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
    if (Array.isArray(value) && typeof value[0] === 'string' && value[0].trim().length > 0) return value[0].trim();
  }
  return '';
}

/**
 * Signature material can arrive as headers (documented) or as query parameters
 * depending on how the callback was registered; accept both.
 *
 * @param {{ req?: { headers?: Record<string, unknown>, url?: string }, payload?: Record<string, unknown> | null }} input
 * @returns {{ timestamp: string, sign: string }}
 */
export function extractWebhookSignature(input) {
  const headers = input.req?.headers ?? {};
  let timestamp = headerValue(headers, ['timestamp', 'x-dingtalk-timestamp', 'x-dt-timestamp']);
  let sign = headerValue(headers, ['sign', 'x-dingtalk-sign', 'x-dt-sign', 'x-dingtalk-signature']);
  if (timestamp.length === 0 || sign.length === 0) {
    const url = typeof input.req?.url === 'string' ? input.req.url : '';
    const queryIndex = url.indexOf('?');
    if (queryIndex >= 0) {
      try {
        const params = new URLSearchParams(url.slice(queryIndex + 1));
        if (timestamp.length === 0) timestamp = params.get('timestamp') ?? '';
        if (sign.length === 0) sign = params.get('sign') ?? '';
      } catch {
        // Ignore malformed query strings; header material (if any) still applies.
      }
    }
  }
  if (timestamp.length === 0 || sign.length === 0) {
    const payload = input.payload ?? {};
    if (timestamp.length === 0 && typeof payload.timestamp === 'string') timestamp = payload.timestamp;
    if (sign.length === 0 && typeof payload.sign === 'string') sign = payload.sign;
  }
  return { timestamp, sign };
}

/**
 * Webhook bodies are usually the robot message object, but stream-shaped
 * `{ headers, data }` envelopes are also accepted for convenience.
 *
 * @param {unknown} payload
 * @returns {Record<string, unknown> | null}
 */
export function normalizeWebhookPayload(payload) {
  if (payload === null || typeof payload !== 'object') return null;
  const record = /** @type {Record<string, unknown>} */ (payload);
  if (typeof record.data === 'string' && record.headers !== null && typeof record.headers === 'object') {
    try {
      const parsed = JSON.parse(record.data);
      return parsed !== null && typeof parsed === 'object' ? /** @type {Record<string, unknown>} */ (parsed) : null;
    } catch {
      return null;
    }
  }
  return record;
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {Record<string, unknown>} body
 */
function sendJson(res, status, body) {
  if (res.headersSent === true) {
    if (res.writableEnded !== true) res.end();
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

/**
 * Build the `POST <webhookPath>` handler for `ctx.http.route`.
 *
 * @param {{
 *   config: { verifySignature: boolean, signatureSecret: string, signatureMaxSkewMs: number },
 *   log?: any,
 *   onPayload: (payload: Record<string, unknown>) => Promise<void> | void,
 *   now?: () => number,
 * }} options
 * @returns {(request: { req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, body: Buffer }) => Promise<void>}
 */
export function createWebhookHandler(options) {
  const { config } = options;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const log = options.log;

  return async function handleDingtalkWebhook(request) {
    const { req, res, body } = request;
    /** @type {unknown} */
    let payload;
    try {
      const text = body instanceof Uint8Array ? Buffer.from(body).toString('utf8') : String(body ?? '');
      payload = JSON.parse(text);
    } catch {
      sendJson(res, 400, { errcode: 400, errmsg: 'invalid json body' });
      return;
    }
    const record = payload !== null && typeof payload === 'object'
      ? /** @type {Record<string, unknown>} */ (payload)
      : null;
    if (record === null) {
      sendJson(res, 400, { errcode: 400, errmsg: 'invalid payload' });
      return;
    }

    if (config.verifySignature) {
      const { timestamp, sign } = extractWebhookSignature({ req, payload: record });
      const verdict = verifyWebhookSignature({
        timestamp,
        sign,
        secret: config.signatureSecret,
        now: now(),
        maxSkewMs: config.signatureMaxSkewMs,
      });
      if (!verdict.ok) {
        log?.warn?.('dingtalk webhook signature rejected', { reason: verdict.reason });
        sendJson(res, 401, { errcode: 401, errmsg: `invalid signature: ${verdict.reason ?? 'rejected'}` });
        return;
      }
    }

    const message = normalizeWebhookPayload(record);
    if (message === null) {
      sendJson(res, 400, { errcode: 400, errmsg: 'invalid message payload' });
      return;
    }

    // ACK immediately; the agent turn happens asynchronously.
    sendJson(res, 200, { errcode: 0, errmsg: 'ok' });
    Promise.resolve()
      .then(() => options.onPayload(message))
      .catch((error) => log?.error?.('dingtalk webhook message handling failed', { error }));
  };
}
