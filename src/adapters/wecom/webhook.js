/**
 * WeCom 自建应用 callback (webhook mode): GET URL verification + POST
 * signature/AES decryption with a fast platform ack, then async emit.
 *
 * Contract notes:
 *  - GET: `msg_signature = sha1(sort(token, timestamp, nonce, echostr))`; the
 *    echo string is itself encrypted and must be decrypted before it is echoed.
 *  - POST: verify the signature over `<Encrypt>`, decrypt the envelope, ack
 *    `success` immediately, then hand the normalized message to core. The
 *    platform re-delivers when the ack is slow, so nothing may wait on the agent.
 */
import { decryptWecomMessage, verifySignature } from './crypto.js';
import { mapWebhookInbound } from './inbound.js';
import { parseWecomPayload, pickChild } from './xml.js';

const NOOP_LOG = Object.freeze({
  debug() {},
  info() {},
  warn() {},
  error() {},
});

/**
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizeWebhookPath(raw) {
  const value = String(raw ?? '').trim() || '/webhook/wecom';
  return value.startsWith('/') ? value : `/${value}`;
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @returns {URL}
 */
function requestUrl(req) {
  return new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {string} text
 */
function respond(res, status, text) {
  if (res.writableEnded) return;
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(text);
}

/**
 * Read the signature from the query string. 自建应用 uses `msg_signature`;
 * older proxies sometimes forward it as `signature`.
 * @param {URLSearchParams} query
 * @returns {string}
 */
function signatureParam(query) {
  return String(query.get('msg_signature') ?? query.get('msgsignature') ?? query.get('signature') ?? '');
}

/**
 * Extract the `Encrypt` value from an outer callback envelope (XML or JSON).
 * @param {Buffer|string} body
 * @returns {string}
 */
export function extractEncrypt(body) {
  const payload = parseWecomPayload(body);
  if (payload === null) return '';
  return String(pickChild(payload, 'Encrypt') ?? pickChild(payload, 'encrypt') ?? '').trim();
}

/**
 * Create the GET/POST handlers registered on the core HTTP host.
 * @param {{
 *   config: { token: string, encodingAESKey: string, corpId: string, botName?: string },
 *   emit: (inbound: import('../../core/types.js').InboundMessage) => Promise<void> | void,
 *   log?: { debug?: Function, info?: Function, warn?: Function, error?: Function },
 * }} options
 */
export function createWebhookHandler(options) {
  const { config, emit } = options;
  const log = options.log ?? NOOP_LOG;

  /**
   * GET /webhook/wecom?...  URL verification.
   * @param {{ req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, body?: Buffer }} request
   */
  async function handleGet(request) {
    const { req, res } = request;
    const query = requestUrl(req).searchParams;
    const timestamp = String(query.get('timestamp') ?? '');
    const nonce = String(query.get('nonce') ?? '');
    const echostr = String(query.get('echostr') ?? '');
    const signature = signatureParam(query);
    if (!timestamp || !nonce || !echostr) {
      respond(res, 400, 'missing query params');
      return;
    }
    const valid = signature !== '' && verifySignature(signature, {
      token: config.token,
      timestamp,
      nonce,
      encrypt: echostr,
    });
    if (!valid) {
      log.warn?.('wecom webhook GET signature rejected');
      respond(res, 401, 'unauthorized');
      return;
    }
    try {
      const plain = decryptWecomMessage({
        encodingAESKey: config.encodingAESKey,
        receiveId: config.corpId,
        encrypt: echostr,
      });
      log.info?.('wecom webhook URL verified');
      respond(res, 200, plain);
    } catch (error) {
      log.warn?.(`wecom webhook GET decrypt failed: ${error instanceof Error ? error.message : String(error)}`);
      respond(res, 400, 'decrypt failed');
    }
  }

  /**
   * POST /webhook/wecom?...  Encrypted message callback.
   * @param {{ req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, body: Buffer }} request
   */
  async function handlePost(request) {
    const { req, res, body } = request;
    const query = requestUrl(req).searchParams;
    const timestamp = String(query.get('timestamp') ?? '');
    const nonce = String(query.get('nonce') ?? '');
    const signature = signatureParam(query);
    if (!timestamp || !nonce) {
      respond(res, 400, 'missing query params');
      return;
    }
    const encrypt = extractEncrypt(body);
    if (encrypt === '') {
      respond(res, 400, 'missing Encrypt');
      return;
    }
    const valid = signature !== '' && verifySignature(signature, {
      token: config.token,
      timestamp,
      nonce,
      encrypt,
    });
    if (!valid) {
      log.warn?.('wecom webhook POST signature rejected');
      respond(res, 401, 'unauthorized');
      return;
    }

    let plaintext;
    try {
      plaintext = decryptWecomMessage({
        encodingAESKey: config.encodingAESKey,
        receiveId: config.corpId,
        encrypt,
      });
    } catch (error) {
      log.warn?.(`wecom webhook POST decrypt failed: ${error instanceof Error ? error.message : String(error)}`);
      respond(res, 400, 'decrypt failed');
      return;
    }

    // Fast ack first: the platform expects an empty/"success" reply quickly and
    // retries otherwise. Agent turnaround must never delay this response.
    respond(res, 200, 'success');

    try {
      const message = parseWecomPayload(plaintext);
      if (message === null) {
        log.warn?.('wecom webhook decrypted payload is not XML/JSON');
        return;
      }
      const inbound = mapWebhookInbound({
        message,
        accountId: config.accountId,
        botName: config.botName,
      });
      if (inbound === null) {
        log.debug?.('wecom webhook message ignored (event/unsupported/empty)');
        return;
      }
      await emit(inbound);
    } catch (error) {
      log.warn?.(`wecom webhook emit failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * @param {{ req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, body?: Buffer }} request
   */
  async function handleRequest(request) {
    const method = String(request.req.method ?? '').toUpperCase();
    if (method === 'GET') return handleGet(request);
    if (method === 'POST') return handlePost({ ...request, body: request.body ?? Buffer.alloc(0) });
    respond(request.res, 405, 'Method Not Allowed');
  }

  return { handleGet, handlePost, handleRequest };
}
