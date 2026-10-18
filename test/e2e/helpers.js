/**
 * Shared helpers for end-to-end tests.
 *
 * These tests boot the *real* gateway (`src/core/gateway.js` via `src/index.js`),
 * the real channel adapter, the real bridge and the real HTTP host. Only the
 * two edges are faked:
 *   - DSH runtime  -> `test/support/fake-dsh-runtime.js` (real child process,
 *                     real newline-delimited JSON-RPC on stdio);
 *   - IM platform  -> a local `node:http` server (for outbound API calls) and
 *                     real webhook POSTs into the gateway's HTTP host.
 */
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadConfig } from '../../src/core/config.js';
import { createGateway } from '../../src/core/gateway.js';
import { fakeRuntimePath, waitFor } from '../support/fake-dsh-runtime.js';

export { fakeRuntimePath, waitFor };

/** Absolute path of the package root (…/dsh-im-manager). */
export const PACKAGE_ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');

/**
 * Create a throwaway directory inside the workspace (sandbox-safe).
 * @param {string} label
 * @returns {{ dir: string, cleanup: () => void }}
 */
export function createRunDir(label = 'e2e') {
  const dir = mkdtempSync(join(PACKAGE_ROOT, `.tmp-${label}-`));
  return {
    dir,
    cleanup() {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Best effort: a failed cleanup must not fail the test.
      }
    },
  };
}

/**
 * @param {Record<string, unknown>} base
 * @param {Record<string, unknown>} override
 */
export function mergeConfig(base, override) {
  return deepMerge(base, override);
}

function deepMerge(base, override) {
  if (override === undefined) return base;
  if (Array.isArray(override) || override === null || typeof override !== 'object') return override;
  if (Array.isArray(base) || base === null || typeof base !== 'object') base = {};
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    out[key] = deepMerge(/** @type {any} */ (base)[key], value);
  }
  return out;
}

/**
 * Build a config object for the real gateway.
 *
 * `dsh.command` / `dsh.args` point at the fake runtime (a real child process),
 * `gateway.http.port=0` asks the OS for a free port, and every state path lives
 * under the throwaway run dir.
 *
 * @param {{
 *   runDir: string,
 *   env?: Record<string, string | undefined>,
 *   dshEnv?: Record<string, string>,
 *   overrides?: Record<string, any>,
 *   configPath?: string,
 * }} options
 */
export function writeTestConfig(options) {
  const { runDir, env = {}, dshEnv = {}, overrides = {} } = options;
  const stateDir = join(runDir, 'state');
  const base = {
    dsh: {
      command: process.execPath,
      args: [fakeRuntimePath],
      cwd: PACKAGE_ROOT,
      provider: 'deepseek-official',
      model: 'fake-model',
      initTimeoutMs: 5000,
      turnTimeoutMs: 10000,
      requestTimeoutMs: 5000,
      restart: { minDelayMs: 50, maxDelayMs: 300 },
      env: dshEnv,
    },
    gateway: {
      stateDir,
      concurrency: 2,
      log: { level: 'silent' },
      http: { enabled: true, host: '127.0.0.1', port: 0, publicBaseUrl: '' },
      access: {
        dmPolicy: 'allowlist',
        allowFrom: ['user-1'],
        pairingTtlSec: 600,
        groups: { enabled: false, requireMention: true, allowFrom: [] },
      },
      reply: {
        chunkChars: 1800,
        typing: false,
        format: 'auto',
        showErrorDetail: true,
        emptyText: '（本轮没有文本输出）',
        maxChunks: 6,
      },
    },
    channels: {},
  };
  const config = deepMerge(base, overrides);
  const configPath = options.configPath ?? join(runDir, 'config.json');
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  const loaded = loadConfig({ configPath, env: { ...process.env, ...env } });
  return { config: loaded.config, configPath, stateDir, warnings: loaded.warnings };
}

/**
 * Start the real gateway with the given config and wait until adapters + bridge
 * are ready.
 *
 * @param {Record<string, any>} config
 * @returns {Promise<{ gateway: ReturnType<typeof createGateway>, baseUrl: string, stop: () => Promise<void> }>}
 */
export async function startGateway(config) {
  const log = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    child() {
      return this;
    },
  };
  const gateway = createGateway({ config, logger: log });
  try {
    await gateway.start();
  } catch (error) {
    await gateway.stop().catch(() => {});
    throw error;
  }
  const bridge = gateway.bridge();
  if (bridge === null) throw new Error('gateway started without a bridge');
  await waitFor(() => bridge.state === 'ready', { timeoutMs: 5000, description: 'bridge ready' });
  const baseUrl = gateway.httpHost === null ? '' : (gateway.httpHost.publicBaseUrl() ?? '');
  return {
    gateway,
    baseUrl,
    async stop() {
      await gateway.stop();
    },
  };
}

/**
 * Minimal HTTP server with plan-object routing, used as a fake IM platform.
 *
 * `routes` is a map of `"METHOD /path"` (or `"*"` catch-all) to handlers:
 *   (ctx: { req, res, body, url, json }) => any
 * A handler return value is serialized as JSON with status 200; a handler that
 * writes the response itself should return `undefined`.
 *
 * @param {Record<string, (ctx: any) => any>} routes
 * @returns {Promise<{
 *   url: string,
 *   port: number,
 *   requests: Array<{ method: string, path: string, query: Record<string,string>, headers: Record<string, any>, body: string, json: any }>,
 *   close: () => Promise<void>,
 * }>}
 */
export async function startFakeServer(routes) {
  /** @type {Array<any>} */
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    let json = null;
    try {
      json = body.length > 0 ? JSON.parse(body) : null;
    } catch {
      json = null;
    }
    const record = {
      method: req.method ?? 'GET',
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: req.headers,
      body,
      json,
    };
    requests.push(record);
    const handler = routes[`${record.method} ${record.path}`] ?? routes['*'];
    if (handler === undefined) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    try {
      const result = await handler({ req, res, body, url, json: record.json });
      if (result !== undefined && !res.writableEnded) {
        res.writeHead(res.statusCode === 0 ? 200 : res.statusCode || 200, {
          'content-type': 'application/json; charset=utf-8',
        });
        res.end(JSON.stringify(result));
      } else if (!res.writableEnded) {
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('ok');
      }
    } catch (error) {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(`fake server error: ${error instanceof Error ? error.message : String(error)}`);
      } else if (!res.writableEnded) {
        res.end();
      }
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    async close() {
      await new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };
}

/**
 * @param {string} method
 * @param {string} url
 * @param {string | object} body
 * @param {Record<string, string>} [headers]
 */
export async function request(method, url, body, headers = {}) {
  const init = { method, headers: { ...headers } };
  if (body !== undefined) {
    const isString = typeof body === 'string';
    init.body = isString ? body : JSON.stringify(body);
    if (!isString) init.headers['content-type'] = 'application/json';
  }
  const response = await fetch(url, init);
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    text: await response.text(),
  };
}

/** Sleep helper (call sites prefer waitFor; this is for "must not happen" checks). */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
