/**
 * Feishu / Lark webhook mode.
 *
 * Feishu requires an event callback to be answered within 3 seconds, and it
 * retries failed deliveries. The handler therefore:
 *
 *   1. parses (and decrypts, when `encryptKey` is configured) the body;
 *   2. checks the verification token;
 *   3. answers URL verification (`challenge`) synchronously;
 *   4. answers `{"code":0}` for real events *before* dispatching them to the
 *      gateway, then emits on `setImmediate`. The agent turn never blocks the
 *      platform acknowledgement.
 *
 * Signature verification (`X-Lark-Signature`) is deliberately not enforced:
 * Feishu only sends those headers together with an encryptKey, and the
 * recommended deployment is a long-connection (`ws`) or a TLS reverse proxy.
 * The verification token + decrypt round-trip is what v1 checks. See
 * docs/channels/feishu.md for the trade-off.
 */

import { createDecipheriv, createHash } from 'node:crypto';
import { unwrapEventPayload } from './event.js';

/**
 * Decrypt a Feishu `encrypt` payload.
 *
 * Scheme: key = SHA-256(encryptKey); body = base64(iv[16] || aes-256-cbc(data)).
 *
 * @param {string} encrypted  base64 string from `{"encrypt": "..."}`
 * @param {string} encryptKey
 * @returns {Record<string, any>}
 */
export function decryptPayload(encrypted, encryptKey) {
  if (typeof encrypted !== 'string' || encrypted.length === 0) {
    throw new Error('feishu: encrypted payload is missing');
  }
  if (typeof encryptKey !== 'string' || encryptKey.length === 0) {
    throw new Error('feishu: encryptKey is not configured but the payload is encrypted');
  }
  const buffer = Buffer.from(encrypted, 'base64');
  if (buffer.length <= 16 || (buffer.length - 16) % 16 !== 0) {
    throw new Error('feishu: encrypted payload has an invalid length');
  }
  const key = createHash('sha256').update(encryptKey).digest();
  const iv = buffer.subarray(0, 16);
  const data = buffer.subarray(16);
  try {
    const decipher = createDecipheriv('aes-256-cbc', key, iv);
    const plaintext = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
    const parsed = JSON.parse(plaintext);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('decrypted payload is not a JSON object');
    }
    return parsed;
  } catch (error) {
    throw new Error('feishu: failed to decrypt webhook payload (check encryptKey)', { cause: error });
  }
}

/**
 * @param {unknown} payload
 * @param {string} verificationToken
 * @returns {boolean}
 */
export function verifyVerificationToken(payload, verificationToken) {
  if (typeof verificationToken !== 'string' || verificationToken.length === 0) return true;
  if (payload === null || typeof payload !== 'object') return false;
  const body = /** @type {Record<string, any>} */ (payload);
  const token = typeof body.header?.token === 'string'
    ? body.header.token
    : (typeof body.token === 'string' ? body.token : '');
  return token === verificationToken;
}

/**
 * @param {{
 *   config: Record<string, any>,
 *   log?: import('../../core/types.js').Logger,
 *   onEvent: (payload: unknown, source: 'webhook') => Promise<void>,
 * }} options
 * @returns {(request: any, res?: any, body?: any) => Promise<void>}
 */
export function createWebhookHandler({ config, log, onEvent }) {
  /**
   * The core HTTP host calls `handler({ req, res, body })` (see
   * src/core/http-host.js). docs/contracts.md §3 documents `(req, res, body)`.
   * Accept both so the adapter keeps working if the host adopts the documented
   * three-argument form later.
   *
   * @param {any} request
   * @param {any} [legacyRes]
   * @param {any} [legacyBody]
   */
  return async function feishuWebhookHandler(request, legacyRes, legacyBody) {
    const { req, res, body } = (request !== null && typeof request === 'object' && request.req !== undefined && request.res !== undefined)
      ? request
      : { req: request, res: legacyRes, body: legacyBody };

    /** @param {number} status @param {Record<string, unknown>} payload */
    const respond = (status, payload) => {
      if (res === undefined || res === null) return;
      try {
        if (res.headersSent === true || res.writableEnded === true) return;
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(payload));
      } catch (error) {
        log?.warn?.('feishu webhook response failed', { error });
      }
    };

    const responseBody = Buffer.isBuffer(body)
      ? body
      : Buffer.from(typeof body === 'string' ? body : bodyToText(body));

    let payload;
    try {
      payload = JSON.parse(responseBody.toString('utf8'));
    } catch (error) {
      log?.warn?.('feishu webhook received invalid JSON', { error });
      respond(400, { code: -1, msg: 'invalid json' });
      return;
    }
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      respond(400, { code: -1, msg: 'invalid payload' });
      return;
    }

    // Decrypt when Feishu is configured with an Encrypt Key (安全模式).
    if (typeof payload.encrypt === 'string') {
      if (config.encryptKey.length === 0) {
        log?.warn?.('feishu webhook payload is encrypted but channels.feishu.encryptKey is empty');
        respond(400, { code: -1, msg: 'encryptKey not configured' });
        return;
      }
      try {
        payload = decryptPayload(payload.encrypt, config.encryptKey);
      } catch (error) {
        log?.warn?.('feishu webhook decryption failed', { error });
        respond(400, { code: -1, msg: 'decrypt failed' });
        return;
      }
    }

    if (!verifyVerificationToken(payload, config.verificationToken)) {
      log?.warn?.('feishu webhook verification token mismatch');
      respond(403, { code: -1, msg: 'verification token mismatch' });
      return;
    }

    const unwrapped = unwrapEventPayload(payload);
    if (unwrapped !== null && unwrapped.kind === 'challenge') {
      // URL verification must be answered synchronously with the challenge.
      respond(200, { challenge: payload.challenge });
      return;
    }

    // Answer the platform first; the agent turn runs afterwards.
    respond(200, { code: 0, msg: 'success' });
    setImmediate(() => {
      void onEvent(payload, 'webhook').catch((error) => {
        log?.error?.('feishu webhook event handling failed', { error });
      });
    });
  };
}

/**
 * Fallback stringification for unusual body types (defensive; the HTTP host
 * always passes a Buffer).
 *
 * @param {unknown} value
 * @returns {string}
 */
function bodyToText(value) {
  if (value === undefined || value === null) return '';
  return String(value);
}
