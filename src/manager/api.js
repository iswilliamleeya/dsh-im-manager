/**
 * Local HTTP API + static Web UI for the multi-workspace manager.
 *
 * Listens on loopback only (no auth by design; see `docs/manager-contract.md`
 * §5). Every API response is JSON; errors are `{ "error": { "message": ... } }`.
 * Static files are served from `src/webui/` with path-traversal protection.
 */
import { createReadStream, realpathSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sanitizeErrorMessage } from './manager.js';

const DEFAULT_WEB_ROOT = fileURLToPath(new URL('../webui/', import.meta.url));
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const DEFAULT_LINES = 200;

const MIME_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
});

/** @param {string} message */
class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} message
   */
  constructor(status, message) {
    super(message);
    this.name = 'HttpError';
    /** @type {number} */
    this.status = status;
    /** @type {string} */
    this.code = 'HTTP_ERROR';
  }
}

/** @param {import('node:http').ServerResponse} res @param {number} status @param {unknown} value */
function sendJson(res, status, value) {
  if (res.writableEnded) return;
  const body = `${JSON.stringify(value)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

/** @param {unknown} error */
function statusForError(error) {
  if (error instanceof HttpError) return error.status;
  const code = /** @type {{ code?: unknown }} */ (error)?.code;
  switch (code) {
    case 'WORKSPACE_NOT_FOUND':
      return 404;
    case 'WORKSPACE_NOT_RUNNING':
    case 'CHANNEL_NOT_RUNNING':
    case 'CONFLICT':
      return 409;
    case 'INVALID_INPUT':
    case 'INVALID_CONFIG':
    case 'INVALID_JSON':
      return 400;
    default:
      return 500;
  }
}

/**
 * Read a JSON request body with a hard 2 MiB limit.
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<any>}
 */
async function readJsonBody(req) {
  const declared = Number(req.headers['content-length'] ?? Number.NaN);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    req.resume();
    throw new HttpError(413, 'request body too large (limit 2 MiB)');
  }
  /** @type {Buffer[]} */
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      req.resume();
      throw new HttpError(413, 'request body too large (limit 2 MiB)');
    }
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid JSON body');
  }
}

/**
 * Accept both a bare config object and `{ config }` (the latter makes room for
 * future envelope fields without breaking older clients).
 * @param {any} body
 */
function unwrapConfig(body) {
  if (
    body !== null
    && typeof body === 'object'
    && !Array.isArray(body)
    && Object.prototype.hasOwnProperty.call(body, 'config')
    && body.config !== null
    && typeof body.config === 'object'
    && !Array.isArray(body.config)
  ) {
    return body.config;
  }
  return body;
}

/** @param {unknown} value @param {string} field */
function requireNonEmptyString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HttpError(400, `${field} is required`);
  }
  return value;
}

/**
 * @param {{
 *   manager: ReturnType<typeof import('./manager.js').createManager>,
 *   webRoot?: string,
 *   logger?: import('../core/types.js').Logger,
 * }} options
 */
export function createManagerApi(options = /** @type {any} */ ({})) {
  if (options.manager === undefined || options.manager === null) {
    throw new TypeError('createManagerApi requires a manager');
  }
  const manager = options.manager;
  const webRoot = resolve(options.webRoot ?? DEFAULT_WEB_ROOT);
  const logger = options.logger;

  /** @type {import('node:http').Server | null} */
  let server = null;
  /** @type {{ host: string, port: number }} */
  let actual = { host: '127.0.0.1', port: 0 };

  // ── static files ───────────────────────────────────────────────────────────

  /** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res @param {string} pathname */
  async function serveStatic(req, res, pathname) {
    const method = (req.method ?? 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      throw new HttpError(404, `not found: ${method} ${pathname}`);
    }
    let decoded;
    try {
      decoded = decodeURIComponent(pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, ''));
    } catch {
      throw new HttpError(400, 'invalid URL encoding');
    }
    if (decoded.includes('\0')) throw new HttpError(404, `not found: ${pathname}`);
    const target = resolve(webRoot, decoded);
    if (target !== webRoot && !target.startsWith(`${webRoot}${sep}`)) {
      throw new HttpError(404, `not found: ${pathname}`);
    }
    let stat;
    try {
      stat = statSync(target);
    } catch {
      throw new HttpError(404, `not found: ${pathname}`);
    }
    if (!stat.isFile()) throw new HttpError(404, `not found: ${pathname}`);
    // Reject symlinks that escape the web root.
    try {
      const realTarget = realpathSync(target);
      const realRoot = realpathSync(webRoot);
      if (realTarget !== realRoot && !realTarget.startsWith(`${realRoot}${sep}`)) {
        throw new HttpError(404, `not found: ${pathname}`);
      }
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(404, `not found: ${pathname}`);
    }
    const headers = {
      'content-type': MIME_TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream',
      'content-length': String(stat.size),
      'cache-control': 'no-cache',
    };
    if (method === 'HEAD') {
      res.writeHead(200, headers);
      res.end();
      return;
    }
    await new Promise((resolvePromise, reject) => {
      const stream = createReadStream(target);
      stream.once('error', reject);
      res.once('finish', resolvePromise);
      res.writeHead(200, headers);
      stream.pipe(res);
    });
  }

  // ── API routes ─────────────────────────────────────────────────────────────

  /** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res @param {URL} url */
  async function handleApi(req, res, url) {
    const method = (req.method ?? 'GET').toUpperCase();
    /** @type {string[]} */
    const segments = [];
    for (const raw of url.pathname.split('/').filter((segment) => segment.length > 0)) {
      try {
        segments.push(decodeURIComponent(raw));
      } catch {
        throw new HttpError(400, 'invalid URL encoding');
      }
    }
    if (segments[0] !== 'api') throw new HttpError(404, `not found: ${method} ${url.pathname}`);

    if (segments.length === 2 && segments[1] === 'health') {
      if (method !== 'GET') throw new HttpError(404, `not found: ${method} ${url.pathname}`);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (segments.length === 2 && segments[1] === 'state') {
      if (method !== 'GET') throw new HttpError(404, `not found: ${method} ${url.pathname}`);
      if (typeof manager.refresh === 'function') await manager.refresh();
      sendJson(res, 200, manager.getState());
      return;
    }

    if (segments.length === 3 && segments[1] === 'sessions' && segments[2] === 'activity') {
      if (method !== 'GET') throw new HttpError(404, `not found: ${method} ${url.pathname}`);
      sendJson(res, 200, manager.getSessionActivity());
      return;
    }

    if (segments[1] !== 'workspaces') {
      throw new HttpError(404, `not found: ${method} ${url.pathname}`);
    }

    if (segments.length === 2) {
      if (method !== 'POST') throw new HttpError(404, `not found: ${method} ${url.pathname}`);
      const body = await readJsonBody(req);
      const workspace = await manager.addWorkspace(body);
      sendJson(res, 201, workspace);
      return;
    }

    const id = segments[2];
    if (id === undefined || id.length === 0) throw new HttpError(404, `not found: ${method} ${url.pathname}`);

    if (segments.length === 3) {
      if (method === 'PATCH') {
        const body = await readJsonBody(req);
        sendJson(res, 200, await manager.updateWorkspace(id, body));
        return;
      }
      if (method === 'DELETE') {
        await manager.removeWorkspace(id);
        sendJson(res, 200, { ok: true, id });
        return;
      }
      throw new HttpError(404, `not found: ${method} ${url.pathname}`);
    }

    if (segments.length === 4) {
      const action = segments[3];
      if (method === 'POST' && action === 'start') {
        sendJson(res, 200, await manager.startWorkspace(id));
        return;
      }
      if (method === 'POST' && action === 'stop') {
        sendJson(res, 200, await manager.stopWorkspace(id));
        return;
      }
      if (method === 'POST' && action === 'restart') {
        sendJson(res, 200, await manager.restartWorkspace(id));
        return;
      }
      if (method === 'GET' && action === 'config') {
        sendJson(res, 200, manager.getWorkspaceConfig(id));
        return;
      }
      if (method === 'PUT' && action === 'config') {
        const body = await readJsonBody(req);
        const saved = await manager.saveWorkspaceConfig(id, unwrapConfig(body));
        sendJson(res, 200, { ok: true, config: saved });
        return;
      }
      if (method === 'GET' && action === 'pairing') {
        const pending = manager.listPairing(id);
        // `pending` is the shape the e2e contract exercises; `pendingPairings`
        // mirrors the key used inside `/api/state` so the Web UI can consume
        // either list shape without a special case.
        sendJson(res, 200, { pending, pendingPairings: pending });
        return;
      }
      if (method === 'GET' && action === 'logs') {
        const raw = url.searchParams.get('lines');
        let lines = raw === null ? DEFAULT_LINES : Number(raw);
        if (!Number.isFinite(lines) || lines <= 0) lines = DEFAULT_LINES;
        sendJson(res, 200, { lines: manager.getLogs(id, lines) });
        return;
      }
      // Host-plugin `im_gateway_send`: send one message through a live channel
      // adapter of this workspace.
      if (method === 'POST' && action === 'messages') {
        const body = await readJsonBody(req);
        const channel = requireNonEmptyString(body?.channel, 'channel').trim();
        const conversationId = requireNonEmptyString(body?.conversationId, 'conversationId').trim();
        const text = requireNonEmptyString(body?.text, 'text');
        /** @type {Record<string, any>} */
        const target = {
          channel,
          accountId: channel,
          conversationId,
          conversationType: body?.conversationType === 'group' ? 'group' : 'dm',
        };
        if (typeof body?.replyToMessageId === 'string' && body.replyToMessageId !== '') {
          target.replyToMessageId = body.replyToMessageId;
        }
        const result = await manager.sendMessage(id, { channel, target, text, format: 'plain' });
        sendJson(res, 200, { ok: true, ...(result?.messageId ? { messageId: result.messageId } : {}) });
        return;
      }
      throw new HttpError(404, `not found: ${method} ${url.pathname}`);
    }

    // §10.3 channel QR connect: /channels/:channel/connect[/cancel]
    if (segments.length >= 6 && segments[3] === 'channels') {
      const channel = segments[4];
      const isConnect = segments[5] === 'connect';
      if (isConnect && segments.length === 6) {
        if (method === 'POST') {
          const body = await readJsonBody(req);
          sendJson(res, 200, await manager.beginChannelConnect(id, channel, body ?? {}));
          return;
        }
        if (method === 'GET') {
          const flow = manager.getChannelConnect(id, channel);
          if (flow === null || flow === undefined) {
            throw new HttpError(404, `no connect flow for channel "${channel}"`);
          }
          sendJson(res, 200, flow);
          return;
        }
      }
      if (isConnect && segments.length === 7 && segments[6] === 'cancel') {
        if (method !== 'POST') throw new HttpError(404, `not found: ${method} ${url.pathname}`);
        sendJson(res, 200, await manager.cancelChannelConnect(id, channel));
        return;
      }
      throw new HttpError(404, `not found: ${method} ${url.pathname}`);
    }

    if (segments.length === 5 && segments[3] === 'pairing' && segments[4] === 'approve') {
      if (method !== 'POST') throw new HttpError(404, `not found: ${method} ${url.pathname}`);
      const body = await readJsonBody(req);
      const code = body?.code;
      if (typeof code !== 'string' || code.trim().length === 0) {
        throw new HttpError(400, 'code is required');
      }
      sendJson(res, 200, await manager.approvePairing(id, code.trim()));
      return;
    }

    // Host-plugin `im_gateway_allow`: add a sender to the allowlist directly.
    if (segments.length === 5 && segments[3] === 'pairing' && segments[4] === 'allow') {
      if (method !== 'POST') throw new HttpError(404, `not found: ${method} ${url.pathname}`);
      const body = await readJsonBody(req);
      const channel = requireNonEmptyString(body?.channel, 'channel').trim();
      const senderId = requireNonEmptyString(body?.senderId, 'senderId').trim();
      const name = typeof body?.name === 'string' && body.name.trim() !== '' ? body.name.trim() : undefined;
      const entry = await manager.allowSender(id, {
        channel,
        senderId,
        ...(name === undefined ? {} : { name }),
      });
      sendJson(res, 200, { ok: true, entry });
      return;
    }

    throw new HttpError(404, `not found: ${method} ${url.pathname}`);
  }

  // ── request entry point ────────────────────────────────────────────────────

  /** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res */
  async function handleRequest(req, res) {
    const startedAtMs = Date.now();
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
        await handleApi(req, res, url);
      } else {
        await serveStatic(req, res, url.pathname);
      }
    } catch (error) {
      const status = statusForError(error);
      const message = error instanceof HttpError ? error.message : sanitizeErrorMessage(error);
      if (status >= 500) {
        logger?.error?.('manager api request failed', { method: req.method, path: req.url, error: message });
      }
      if (res.headersSent) {
        res.end();
      } else {
        sendJson(res, status, { error: { message } });
      }
    } finally {
      logger?.debug?.('manager api request', {
        method: req.method,
        path: req.url,
        status: res.statusCode,
        ms: Date.now() - startedAtMs,
      });
    }
  }

  return {
    /**
     * Start listening. Port 0 asks the OS for a free port; the returned value
     * carries the actual one. Idempotent.
     * @param {{ host?: string, port?: number }} [input]
     * @returns {Promise<{ host: string, port: number }>}
     */
    async start(input = {}) {
      if (server !== null) return { ...actual };
      // Default to the manager's configured loopback address (contract §5);
      // explicit arguments (CLI --host/--port) always win.
      /** @type {{ host?: string, port?: number }} */
      let configured = {};
      try {
        const value = manager.listen;
        if (value !== null && typeof value === 'object') configured = value;
      } catch {
        // A manager without a listen getter simply uses the defaults below.
      }
      const host = typeof input.host === 'string' && input.host.length > 0
        ? input.host
        : (typeof configured.host === 'string' && configured.host.length > 0 ? configured.host : '127.0.0.1');
      const port = input.port === undefined
        ? (Number.isInteger(configured.port) ? configured.port : 8788)
        : Number(input.port);
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new TypeError(`invalid port: ${String(input.port)}`);
      }
      const next = createServer((req, res) => {
        void handleRequest(req, res);
      });
      await new Promise((resolvePromise, reject) => {
        const onError = (error) => {
          next.off('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          next.off('error', onError);
          resolvePromise(undefined);
        };
        next.once('error', onError);
        next.once('listening', onListening);
        next.listen(port, host);
      });
      server = next;
      const address = next.address();
      actual = {
        host,
        port: typeof address === 'object' && address !== null ? address.port : port,
      };
      logger?.info?.('manager api listening', { host: actual.host, port: actual.port });
      return { ...actual };
    },

    /** Stop listening. Idempotent. */
    async stop() {
      const current = server;
      if (current === null) return;
      server = null;
      await new Promise((resolvePromise) => {
        current.close(() => resolvePromise(undefined));
        current.closeAllConnections?.();
      });
      logger?.info?.('manager api stopped');
    },

    /** Actual bound address (`port` is the OS-assigned port after start). */
    get listen() {
      return { ...actual };
    },

    /** The underlying `http.Server` once started (optional accessor). */
    get server() {
      return server;
    },
  };
}
