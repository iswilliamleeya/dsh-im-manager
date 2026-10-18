/**
 * Shared fixtures/helpers for the DingTalk adapter tests. Not a test file.
 */

/** @returns {Record<string, any>} A group text robot-callback payload. */
export function robotPayload(overrides = {}) {
  const base = {
    conversationId: 'cid_group_1',
    chatbotCorpId: 'ding_corp',
    chatbotUserId: '$:LWCP_v1:$bot_user_id',
    msgId: 'msg-1001',
    senderNick: 'Alice',
    isAdmin: false,
    senderStaffId: 'staff_001',
    sessionWebhookExpiredTime: 4_000_000_000_000,
    createAt: 1_700_000_000_000,
    senderCorpId: 'corp_1',
    conversationType: '2',
    senderId: 'sender_001',
    sessionWebhook: 'https://oapi.dingtalk.com/robot/sendBySession?session=token_value',
    robotCode: 'ding_client_id',
    msgtype: 'text',
    text: { content: '@机器人 帮我看看这个报错' },
    atUsers: [{ dingtalkId: 'bot_dingtalk_id' }],
  };
  return { ...base, ...overrides };
}

/** @returns {Record<string, any>} A single-chat (DM) text payload. */
export function dmPayload(overrides = {}) {
  return robotPayload({
    conversationId: 'cid_dm_1',
    conversationType: '1',
    text: { content: '你好' },
    atUsers: undefined,
    ...overrides,
  });
}

/** Collects log calls so tests can assert on them without writing stderr. */
export function createFakeLogger() {
  /** @type {{ level: string, args: unknown[] }[]} */
  const lines = [];
  const make = (level) => (...args) => {
    lines.push({ level, args });
  };
  const logger = {
    lines,
    debug: make('debug'),
    info: make('info'),
    warn: make('warn'),
    error: make('error'),
    child() {
      return logger;
    },
  };
  return logger;
}

/** Minimal `ServerResponse` stand-in for handler-level tests. */
export function createFakeResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    headersSent: false,
    writableEnded: false,
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers ?? {};
      this.headersSent = true;
      return this;
    },
    end(chunk) {
      if (chunk !== undefined && chunk !== null) this.body += String(chunk);
      this.writableEnded = true;
      return this;
    },
  };
}

/**
 * Build a fake AdapterContext. `http.route` is captured into `routes`, keyed by
 * `"POST /path"`, just like the real HttpHost.
 */
export function createAdapterContext(overrides = {}) {
  /** @type {Map<string, Function>} */
  const routes = new Map();
  /** @type {Array<Record<string, any>>} */
  const emitted = [];
  const logger = overrides.log ?? createFakeLogger();
  const controller = new AbortController();
  const ctx = {
    config: overrides.config ?? {},
    emit: async (inbound) => {
      emitted.push(inbound);
      if (typeof overrides.onEmit === 'function') await overrides.onEmit(inbound);
    },
    log: logger,
    signal: overrides.signal ?? controller.signal,
    http: overrides.http ?? {
      route(method, path, handler) {
        routes.set(`${String(method).toUpperCase()} ${path}`, handler);
      },
      publicUrl(path) {
        return `http://127.0.0.1:8787${path}`;
      },
    },
    stateDir: overrides.stateDir ?? '/tmp/dsh-im-manager-test',
    secret: overrides.secret,
  };
  return { ctx, routes, emitted, logger, controller };
}

/**
 * Fully injectable fake `dingtalk-stream` client: records the callback
 * listener, dispatches callbacks, and records ACKs.
 *
 * @param {{ connectError?: Error }} [options]
 */
export function createFakeStreamClient(options = {}) {
  /** @type {Map<string, Function>} */
  const listeners = new Map();
  /** @type {Array<{ messageId: string, result: unknown }>} */
  const acked = [];
  const calls = { connect: 0, disconnect: 0 };
  const client = {
    connected: false,
    registered: false,
    listeners,
    acked,
    calls,
    registerCallbackListener(topic, callback) {
      listeners.set(topic, callback);
      client.registered = true;
      return client;
    },
    async connect() {
      calls.connect += 1;
      if (options.connectError instanceof Error) throw options.connectError;
      client.connected = true;
      return client;
    },
    disconnect() {
      calls.disconnect += 1;
      client.connected = false;
      client.registered = false;
    },
    socketCallBackResponse(messageId, result) {
      acked.push({ messageId, result });
    },
    /** @param {unknown} payload */
    dispatch(payload) {
      const callback = listeners.get('/v1.0/im/bot/messages/get');
      if (typeof callback !== 'function') throw new Error('no callback listener registered');
      return callback(payload);
    },
  };
  return client;
}

/** Wrap a raw robot message in the Stream SDK's `{ headers, data }` envelope. */
export function streamEnvelope(raw, headers = {}) {
  return {
    specVersion: '1.0',
    type: 'CALLBACK',
    headers: {
      appId: 'ding_client_id',
      connectionId: 'conn-1',
      contentType: 'application/json',
      messageId: headers.messageId ?? 'stream-msg-1',
      time: String(Date.now()),
      topic: '/v1.0/im/bot/messages/get',
      ...headers,
    },
    data: typeof raw === 'string' ? raw : JSON.stringify(raw),
  };
}

/** Let queued promise chains run (handler -> onPayload -> emit). */
export async function flush(count = 3) {
  for (let index = 0; index < count; index += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setImmediate(resolve));
  }
}
