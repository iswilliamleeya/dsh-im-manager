/**
 * Shared test helpers for the Feishu adapter tests.
 *
 * Everything is local: a fake Feishu OpenAPI HTTP server (tenant token +
 * bot info + im/v1/messages create/reply), a fake WS client, event fixtures,
 * and a minimal AdapterContext. No test ever touches open.feishu.cn.
 */

import http from 'node:http';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * @returns {import('../../../src/core/types.js').Logger}
 */
export function silentLogger() {
  /** @type {any} */
  const logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => logger,
  };
  return logger;
}

/** Unique app id per test: the Lark SDK caches tenant tokens by appId. */
export function uniqueAppId() {
  return `cli_${randomBytes(8).toString('hex')}`;
}

/**
 * @typedef {Object} FakeFeishuRequest
 * @property {string} method
 * @property {string} path
 * @property {Record<string, string>} query
 * @property {Record<string, string>} headers
 * @property {string} rawBody
 * @property {any} body
 */

/**
 * Start a local fake of the subset of the Feishu OpenAPI used by the adapter.
 *
 * @param {{
 *   botOpenId?: string,
 *   botName?: string,
 *   failCard?: number,
 *   failReply?: number,
 *   failCreate?: number,
 *   token?: string,
 * }} [options]
 * @returns {Promise<{
 *   baseUrl: string,
 *   port: number,
 *   requests: FakeFeishuRequest[],
 *   state: Record<string, any>,
 *   close: () => Promise<void>,
 * }>}
 */
export async function startFakeFeishu(options = {}) {
  const state = {
    botOpenId: options.botOpenId ?? 'ou_bot_test',
    botName: options.botName ?? 'Test Bot',
    token: options.token ?? 't-test-token',
    failCard: options.failCard ?? 0,
    failReply: options.failReply ?? 0,
    failCreate: options.failCreate ?? 0,
    sequence: 0,
  };
  /** @type {FakeFeishuRequest[]} */
  const requests = [];

  const server = http.createServer(async (req, res) => {
    /** @type {Buffer[]} */
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    let body;
    try {
      body = rawBody.length > 0 ? JSON.parse(rawBody) : undefined;
    } catch {
      body = rawBody;
    }
    /** @type {FakeFeishuRequest} */
    const entry = {
      method: req.method ?? 'GET',
      path: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
      headers: /** @type {Record<string, string>} */ (req.headers),
      rawBody,
      body,
    };
    requests.push(entry);

    /** @param {number} status @param {any} payload */
    const send = (status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(payload));
    };

    if (url.pathname === '/open-apis/auth/v3/tenant_access_token/internal' && req.method === 'POST') {
      send(200, { code: 0, msg: 'ok', tenant_access_token: state.token, expire: 7200 });
      return;
    }
    if (url.pathname === '/open-apis/bot/v3/info' && req.method === 'GET') {
      send(200, { code: 0, msg: 'ok', bot: { open_id: state.botOpenId, app_name: state.botName } });
      return;
    }

    const isCard = body !== null && typeof body === 'object' && body.msg_type === 'interactive';
    if (state.failCard > 0 && isCard) {
      state.failCard -= 1;
      send(200, { code: 230001, msg: 'invalid card' });
      return;
    }

    const replyMatch = /^\/open-apis\/im\/v1\/messages\/([^/]+)\/reply$/.exec(url.pathname);
    if (replyMatch !== null && req.method === 'POST') {
      if (state.failReply > 0) {
        state.failReply -= 1;
        send(200, { code: 99991400, msg: 'reply failed' });
        return;
      }
      state.sequence += 1;
      send(200, {
        code: 0,
        msg: 'ok',
        data: { message_id: `om_reply_${state.sequence}`, chat_id: 'oc_chat_1', msg_type: body?.msg_type },
      });
      return;
    }
    if (url.pathname === '/open-apis/im/v1/messages' && req.method === 'POST') {
      if (state.failCreate > 0) {
        state.failCreate -= 1;
        send(200, { code: 99991400, msg: 'create failed' });
        return;
      }
      state.sequence += 1;
      send(200, {
        code: 0,
        msg: 'ok',
        data: { message_id: `om_created_${state.sequence}`, chat_id: body?.receive_id, msg_type: body?.msg_type },
      });
      return;
    }

    send(404, { code: 404, msg: `unexpected ${req.method} ${url.pathname}` });
  });

  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    requests,
    state,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/**
 * Build a Feishu v2 `im.message.receive_v1` event payload.
 *
 * @param {{
 *   openId?: string,
 *   senderType?: string,
 *   chatId?: string,
 *   chatType?: 'p2p' | 'group',
 *   messageId?: string,
 *   messageType?: string,
 *   text?: string,
 *   content?: string,
 *   mentions?: any[],
 *   rootId?: string,
 *   threadId?: string,
 *   createTime?: string,
 *   eventId?: string,
 *   eventType?: string,
 *   token?: string,
 * }} [options]
 * @returns {Record<string, any>}
 */
export function v2Message(options = {}) {
  const createTime = options.createTime ?? '1700000000000';
  const messageType = options.messageType ?? 'text';
  const content = options.content ?? JSON.stringify({ text: options.text ?? '你好' });
  const mentions = options.mentions ?? [];
  return {
    schema: '2.0',
    header: {
      event_id: options.eventId ?? 'evt_0001',
      event_type: options.eventType ?? 'im.message.receive_v1',
      create_time: String(Math.floor(Number(createTime) / 1000)),
      token: options.token ?? 'vt_token',
      app_id: 'cli_0123456789abcdef',
      tenant_key: 'tenant_1',
    },
    event: {
      sender: {
        sender_id: { open_id: options.openId ?? 'ou_user_1' },
        sender_type: options.senderType ?? 'user',
      },
      message: {
        message_id: options.messageId ?? 'om_msg_1',
        chat_id: options.chatId ?? 'oc_chat_1',
        chat_type: options.chatType ?? 'p2p',
        message_type: messageType,
        content,
        create_time: createTime,
        ...(mentions.length > 0 ? { mentions } : {}),
        ...(options.rootId !== undefined ? { root_id: options.rootId } : {}),
        ...(options.threadId !== undefined ? { thread_id: options.threadId } : {}),
      },
    },
  };
}

/**
 * A minimal AdapterContext plus captured emitted messages.
 *
 * @param {{
 *   config?: Record<string, any>,
 *   emit?: (inbound: any) => Promise<void>,
 *   signal?: AbortSignal,
 *   log?: import('../../../src/core/types.js').Logger,
 * }} [options]
 * @returns {{
 *   ctx: import('../../../src/core/types.js').AdapterContext,
 *   emitted: any[],
 *   httpRoutes: Map<string, Function>,
 *   abort: AbortController,
 * }}
 */
export function createHarness(options = {}) {
  /** @type {any[]} */
  const emitted = [];
  /** @type {Map<string, Function>} */
  const httpRoutes = new Map();
  const abort = new AbortController();
  const emit = options.emit ?? (async (inbound) => {
    emitted.push(inbound);
  });

  /** @type {import('../../../src/core/types.js').AdapterContext} */
  const ctx = {
    config: options.config ?? {},
    emit,
    log: options.log ?? silentLogger(),
    signal: options.signal ?? abort.signal,
    http: {
      route: (method, path, handler) => {
        httpRoutes.set(`${method.toUpperCase()} ${path}`, handler);
        return () => httpRoutes.delete(`${method.toUpperCase()} ${path}`);
      },
      publicBaseUrl: () => 'http://127.0.0.1:0',
      publicUrl: (path) => `http://127.0.0.1:0${path}`,
    },
    stateDir: '/tmp/dsh-im-manager-test',
    secret: () => undefined,
  };

  return { ctx, emitted, httpRoutes, abort };
}

/**
 * Fake Lark client for tests that only need inbound handling (no HTTP calls).
 *
 * @param {{ botOpenId?: string, botName?: string }} [options]
 * @returns {any}
 */
export function fakeApiClient(options = {}) {
  return {
    async request() {
      return { bot: { open_id: options.botOpenId ?? 'ou_bot_test', app_name: options.botName ?? 'Test Bot' } };
    },
    im: {
      v1: {
        message: {
          async create() {
            throw new Error('fakeApiClient does not implement im.message.create');
          },
          async reply() {
            throw new Error('fakeApiClient does not implement im.message.reply');
          },
        },
      },
    },
  };
}

/**
 * Fake WSClient factory. The adapter passes the real EventDispatcher; tests
 * inject events through it, exactly like the real WS client does.
 *
 * @returns {{ factory: Function, ref: { client: any } }}
 */
export function createFakeWsFactory() {
  /** @type {{ client: any }} */
  const ref = { client: null };
  const factory = ({ eventDispatcher, onState }) => {
    const client = {
      eventDispatcher,
      dispatcher: null,
      started: false,
      closed: false,
      /** @type {'connected' | 'connecting' | 'failed' | 'idle'} */
      connectionState: 'connected',
      async start({ eventDispatcher: dispatcher }) {
        this.started = true;
        this.dispatcher = dispatcher;
        onState?.('connected');
      },
      async close() {
        this.closed = true;
        onState?.('disconnected');
      },
      getConnectionStatus() {
        return { state: this.connectionState };
      },
    };
    ref.client = client;
    return client;
  };
  return { factory, ref };
}

/**
 * Serve routes registered through a harness' fake `ctx.http`.
 *
 * @param {Map<string, Function>} routes
 * @returns {Promise<{ baseUrl: string, post: (path: string, payload: unknown) => Promise<{ status: number, body: any }>, close: () => Promise<void> }>}
 */
export async function serveRoutes(routes) {
  const server = http.createServer(async (req, res) => {
    /** @type {Buffer[]} */
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const handler = routes.get(`${req.method} ${url.pathname}`);
    if (handler === undefined) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    await handler({ req, res, body: Buffer.concat(chunks) });
  });
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    baseUrl,
    async post(path, payload) {
      const response = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const text = await response.text();
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
      return { status: response.status, body };
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/**
 * Encrypt a payload the way Feishu does in safe mode (AES-256-CBC,
 * key = SHA-256(encryptKey), iv = first 16 bytes of the base64-decoded value).
 *
 * @param {unknown} payload
 * @param {string} encryptKey
 * @returns {string}
 */
export function encryptFeishuPayload(payload, encryptKey) {
  const key = createHash('sha256').update(encryptKey).digest();
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-cbc', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final(),
  ]);
  return Buffer.concat([iv, encrypted]).toString('base64');
}

/**
 * Poll until `predicate()` is truthy or the timeout elapses.
 *
 * @param {() => boolean | Promise<boolean>} predicate
 * @param {{ timeoutMs?: number, intervalMs?: number, label?: string }} [options]
 * @returns {Promise<void>}
 */
export async function waitFor(predicate, options = {}) {
  const timeoutMs = options.timeoutMs ?? 2000;
  const intervalMs = options.intervalMs ?? 5;
  const startedAt = Date.now();
  // Predicates may be async (e.g. polling adapter.health()).
  while (!(await predicate())) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`waitFor timed out${options.label !== undefined ? `: ${options.label}` : ''}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
