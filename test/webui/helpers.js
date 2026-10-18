/**
 * Minimal static file server used by the Web UI tests.
 *
 * It mirrors what the manager's static handler must guarantee
 * (docs/manager-contract.md §5): serve `src/webui/` over GET/HEAD, map the
 * three asset types to the right content-type, and reject any path that would
 * escape the webui root.
 */
import { createServer, request as httpRequest } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const WEBUI_ROOT = fileURLToPath(new URL('../../src/webui/', import.meta.url));

const MIME_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
]);

/**
 * @param {string} [root]
 * @returns {import('node:http').Server}
 */
export function createStaticServer(root = WEBUI_ROOT) {
  const rootPath = resolve(root);

  return createServer(async (req, res) => {
    const notFound = () => {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
    };

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      notFound();
      return;
    }

    const rawPath = (req.url || '/').split('?')[0];

    let pathname;
    try {
      pathname = decodeURIComponent(rawPath);
    } catch {
      notFound();
      return;
    }

    if (pathname.includes('\0')) {
      notFound();
      return;
    }

    if (pathname === '/') pathname = '/index.html';

    // Reject any traversal segment before touching the filesystem.
    if (pathname.split('/').includes('..')) {
      notFound();
      return;
    }

    const filePath = resolve(rootPath, `.${normalize(pathname)}`);
    if (filePath !== rootPath && !filePath.startsWith(rootPath + sep)) {
      notFound();
      return;
    }

    let body;
    try {
      body = await readFile(filePath);
    } catch {
      notFound();
      return;
    }

    const contentType = MIME_TYPES.get(extname(filePath).toLowerCase()) || 'application/octet-stream';
    res.writeHead(200, {
      'content-type': contentType,
      'content-length': body.byteLength,
      'cache-control': 'no-store',
    });
    if (req.method === 'HEAD') res.end();
    else res.end(body);
  });
}

/**
 * @param {import('node:http').Server} server
 * @returns {Promise<void>}
 */
export function listen(server) {
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolvePromise());
  });
}

/**
 * @param {import('node:http').Server} server
 * @returns {Promise<void>}
 */
export function close(server) {
  return new Promise((resolvePromise, reject) => {
    server.closeAllConnections?.();
    server.close((error) => (error ? reject(error) : resolvePromise()));
  });
}

/**
 * Raw HTTP request (no WHATWG URL normalization) so traversal attempts arrive
 * at the server verbatim.
 *
 * @param {import('node:http').Server} server
 * @param {string} path
 * @param {{ method?: string }} [options]
 * @returns {Promise<{ status: number, headers: import('node:http').IncomingHttpHeaders, body: string }>}
 */
export function request(server, path, options = {}) {
  const { method = 'GET' } = options;
  const address = server.address();
  if (!address || typeof address === 'string') {
    return Promise.reject(new Error('server is not listening'));
  }

  return new Promise((resolvePromise, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: address.port,
        path,
        method,
        headers: { connection: 'close' },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolvePromise({
            status: res.statusCode || 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}
