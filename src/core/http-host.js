/**
 * Shared HTTP host for webhook-based channels (Feishu webhook mode, DingTalk
 * webhook mode and the WeCom callback).
 *
 * One server, exact-path routing, a hard body limit, and per-route error
 * containment. Routes answer the platform themselves so they can control the
 * exact bytes and status the platform expects.
 */
import { createServer } from 'node:http';

const MAX_BODY_BYTES = 2 * 1024 * 1024;

/**
 * @param {{
 *   host?: string,
 *   port?: number,
 *   log?: import('./types.js').Logger,
 *   bodyLimitBytes?: number,
 * }} [options]
 */
export function createHttpHost(options = {}) {
  const log = options.log;
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 8787;
  const bodyLimitBytes = options.bodyLimitBytes ?? MAX_BODY_BYTES;
  /** @type {Map<string, (request: { req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, body: Buffer }) => Promise<void> | void>} */
  const routes = new Map();
  /** @type {import('node:http').Server | null} */
  let server = null;
  let actualPort = port;
  /** @type {string} */
  let publicBaseUrl = '';

  /**
   * @param {string} method
   * @param {string} path
   * @param {(request: { req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, body: Buffer }) => Promise<void> | void} handler
   */
  function route(method, path, handler) {
    const key = `${String(method).toUpperCase()} ${path}`;
    if (routes.has(key)) throw new Error(`duplicate HTTP route: ${key}`);
    routes.set(key, handler);
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  async function dispatch(req, res) {
    const started = Date.now();
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const key = `${req.method ?? 'GET'} ${url.pathname}`;
    const handler = routes.get(key);
    if (handler === undefined) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    try {
      for await (const chunk of req) {
        size += chunk.length;
        if (size > bodyLimitBytes) {
          res.writeHead(413, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('payload too large');
          return;
        }
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks);
      await handler({ req, res, body });
    } catch (error) {
      log?.warn('http route failed', { route: key, error });
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('internal error');
      } else if (!res.writableEnded) {
        res.end();
      }
    } finally {
      log?.debug('http request', { route: key, ms: Date.now() - started, status: res.statusCode });
    }
  }

  return {
    route,
    /** @param {(base: string) => void} base */
    setPublicBaseUrl(base) {
      publicBaseUrl = String(base ?? '').replace(/\/+$/, '');
    },
    /** @returns {string | null} */
    publicBaseUrl() {
      if (publicBaseUrl.length > 0) return publicBaseUrl;
      return actualPort > 0 ? `http://${host}:${actualPort}` : null;
    },
    /** @param {string} path @returns {string | null} */
    publicUrl(path) {
      const base = this.publicBaseUrl();
      return base === null ? null : `${base}${path.startsWith('/') ? path : `/${path}`}`;
    },
    get port() {
      return actualPort;
    },
    /** @returns {Promise<void>} */
    async start() {
      if (server !== null) return;
      server = createServer((req, res) => {
        void dispatch(req, res);
      });
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          server?.off('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          server?.off('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, host);
      });
      const address = server.address();
      actualPort = typeof address === 'object' && address !== null ? address.port : port;
      log?.info('http host listening', { host, port: actualPort, routes: routes.size });
    },
    /** @returns {Promise<void>} */
    async stop() {
      const current = server;
      if (current === null) return;
      server = null;
      await new Promise((resolve) => {
        current.close(() => resolve());
        current.closeAllConnections?.();
      });
    },
  };
}

/** @typedef {ReturnType<typeof createHttpHost>} HttpHost */
