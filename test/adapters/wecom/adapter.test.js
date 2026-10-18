/**
 * WeCom adapter-level tests: startup validation, webhook route registration,
 * outbound app-message API shape/token refresh, and "never log secrets".
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import adapterDefault, { createWecomAdapter } from '../../../src/adapters/wecom/index.js';

const ENCODING_KEY = Buffer.alloc(32, 9).toString('base64').replace(/=+$/, '');

/** @returns {{ calls: { url: string, init: any }[], fetchImpl: typeof fetch }} */
function makeFetch(responder) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    const response = await responder(String(url), init, calls.length);
    return {
      status: 200,
      text: async () => JSON.stringify(response),
    };
  };
  return { calls, fetchImpl };
}

function makeLogger() {
  const lines = [];
  const log = {
    debug: (...args) => lines.push(['debug', ...args]),
    info: (...args) => lines.push(['info', ...args]),
    warn: (...args) => lines.push(['warn', ...args]),
    error: (...args) => lines.push(['error', ...args]),
  };
  log.child = () => log;
  return { log, lines, dump: () => JSON.stringify(lines) };
}

function makeWebhookCtx({ config, routes, controller }) {
  const { log } = makeLogger();
  return {
    config,
    emit: async () => {},
    log,
    signal: controller.signal,
    http: {
      route: (method, path, handler) => routes.push({ method, path, handler }),
      publicUrl: () => null,
      publicBaseUrl: () => null,
    },
    stateDir: '/tmp/wecom-adapter-test',
    secret: () => undefined,
  };
}

function webhookConfig(overrides = {}) {
  return {
    enabled: true,
    accountId: 'wecom',
    mode: 'webhook',
    webhookPath: '/webhook/wecom',
    token: 'test-token',
    encodingAESKey: ENCODING_KEY,
    corpId: 'ww-corp-demo',
    agentId: '1000002',
    secret: 'test-secret',
    ...overrides,
  };
}

test('default export satisfies the adapter contract shape', () => {
  assert.equal(adapterDefault.id, 'wecom');
  assert.equal(typeof adapterDefault.start, 'function');
  assert.equal(typeof adapterDefault.stop, 'function');
  assert.equal(typeof adapterDefault.send, 'function');
  assert.equal(typeof adapterDefault.health, 'function');
  assert.deepEqual(adapterDefault.capabilities, {
    text: true,
    markdown: true,
    media: false,
    streaming: false,
    typing: false,
    threads: false,
  });
});

test('ws mode start rejects missing credentials and invalid mode without leaking values', async () => {
  const adapter = createWecomAdapter({ webSocketFactory: () => ({ addEventListener() {}, send() {}, close() {} }) });
  const controller = new AbortController();
  const routes = [];
  const ctx = makeWebhookCtx({
    config: { enabled: true, accountId: 'wecom', mode: 'ws', botId: '', secret: 'super-secret-value' },
    routes,
    controller,
  });
  await assert.rejects(adapter.start(ctx), (error) => {
    assert.match(error.message, /botId is required/);
    assert.ok(!error.message.includes('super-secret-value'));
    return true;
  });

  const badModeAdapter = createWecomAdapter();
  await assert.rejects(
    badModeAdapter.start(
      makeWebhookCtx({
        config: { mode: 'stream', accountId: 'wecom' },
        routes,
        controller,
      }),
    ),
    /mode must be/,
  );
});

test('webhook mode registers GET/POST routes, reports health and stops idempotently', async () => {
  const controller = new AbortController();
  const routes = [];
  const adapter = createWecomAdapter({ fetchImpl: async () => ({ text: async () => '{}', status: 200 }) });
  await adapter.start(makeWebhookCtx({ config: webhookConfig(), routes, controller }));

  assert.deepEqual(
    routes.map((route) => `${route.method} ${route.path}`),
    ['GET /webhook/wecom', 'POST /webhook/wecom'],
  );
  for (const route of routes) assert.equal(typeof route.handler, 'function');

  const health = await adapter.health();
  assert.equal(health.state, 'connected');
  assert.match(health.detail, /webhook/);

  await adapter.stop();
  await adapter.stop(); // idempotent
  assert.equal((await adapter.health()).state, 'disconnected');
});

test('webhook outbound sends a text app message with touser/agentid', async () => {
  const { calls, fetchImpl } = makeFetch((url) => {
    if (url.includes('/cgi-bin/gettoken')) return { errcode: 0, access_token: 'token-1', expires_in: 7200 };
    if (url.includes('/cgi-bin/message/send')) return { errcode: 0, errmsg: 'ok' };
    throw new Error(`unexpected url: ${url}`);
  });
  const controller = new AbortController();
  const adapter = createWecomAdapter({ fetchImpl });
  await adapter.start(makeWebhookCtx({ config: webhookConfig(), routes: [], controller }));
  try {
    const result = await adapter.send(
      { channel: 'wecom', accountId: 'wecom', conversationId: 'zhangsan', conversationType: 'dm', raw: { fromUserName: 'zhangsan' } },
      { text: '普通文本', format: 'plain' },
    );
    assert.deepEqual(result, {});
    const sendCall = calls.find((call) => call.url.includes('/cgi-bin/message/send'));
    assert.ok(sendCall);
    assert.equal(sendCall.url.includes('access_token=token-1'), true);
    const body = JSON.parse(sendCall.init.body);
    assert.equal(body.touser, 'zhangsan');
    assert.equal(body.agentid, 1000002);
    assert.equal(body.msgtype, 'text');
    assert.deepEqual(body.text, { content: '普通文本' });
  } finally {
    await adapter.stop();
  }
});

test('webhook outbound supports markdown and reuses the cached token', async () => {
  let tokenCalls = 0;
  const { calls, fetchImpl } = makeFetch((url) => {
    if (url.includes('/cgi-bin/gettoken')) {
      tokenCalls += 1;
      return { errcode: 0, access_token: 'token-cache', expires_in: 7200 };
    }
    return { errcode: 0, errmsg: 'ok' };
  });
  const controller = new AbortController();
  const adapter = createWecomAdapter({ fetchImpl });
  await adapter.start(makeWebhookCtx({ config: webhookConfig(), routes: [], controller }));
  try {
    const target = { channel: 'wecom', accountId: 'wecom', conversationId: 'u1', conversationType: 'dm', raw: { fromUserName: 'u1' } };
    await adapter.send(target, { text: '**md**', format: 'markdown' });
    await adapter.send(target, { text: 'again', format: 'markdown' });
    const sends = calls.filter((call) => call.url.includes('/cgi-bin/message/send'));
    assert.equal(sends.length, 2);
    assert.equal(JSON.parse(sends[0].init.body).msgtype, 'markdown');
    assert.deepEqual(JSON.parse(sends[0].init.body).markdown, { content: '**md**' });
    assert.equal(tokenCalls, 1, 'access_token should be cached');
  } finally {
    await adapter.stop();
  }
});

test('webhook outbound refreshes an expired access_token once, then throws on real errors', async () => {
  let tokenCalls = 0;
  const { fetchImpl } = makeFetch((url) => {
    if (url.includes('/cgi-bin/gettoken')) {
      tokenCalls += 1;
      return { errcode: 0, access_token: `token-${tokenCalls}`, expires_in: 7200 };
    }
    if (url.includes('access_token=token-1')) return { errcode: 42001, errmsg: 'access_token expired' };
    return { errcode: 0, errmsg: 'ok' };
  });
  const controller = new AbortController();
  const adapter = createWecomAdapter({ fetchImpl });
  await adapter.start(makeWebhookCtx({ config: webhookConfig(), routes: [], controller }));
  try {
    const target = { channel: 'wecom', accountId: 'wecom', conversationId: 'u1', conversationType: 'dm', raw: { fromUserName: 'u1' } };
    await adapter.send(target, { text: 'retry', format: 'plain' });
    assert.equal(tokenCalls, 2);
  } finally {
    await adapter.stop();
  }

  const failing = makeFetch(() => ({ errcode: 40003, errmsg: 'invalid userid' }));
  const failingAdapter = createWecomAdapter({ fetchImpl: failing.fetchImpl });
  await failingAdapter.start(makeWebhookCtx({ config: webhookConfig(), routes: [], controller: new AbortController() }));
  try {
    await assert.rejects(
      failingAdapter.send(
        { channel: 'wecom', accountId: 'wecom', conversationId: 'u1', conversationType: 'dm', raw: { fromUserName: 'u1' } },
        { text: 'boom', format: 'plain' },
      ),
      /errcode=40003/,
    );
  } finally {
    await failingAdapter.stop();
  }
});

test('webhook outbound refuses group chats (use ws mode) and empty text is a no-op', async () => {
  const controller = new AbortController();
  const adapter = createWecomAdapter({ fetchImpl: makeFetch(() => ({ errcode: 0 })).fetchImpl });
  await adapter.start(makeWebhookCtx({ config: webhookConfig(), routes: [], controller }));
  try {
    await assert.rejects(
      adapter.send(
        { channel: 'wecom', accountId: 'wecom', conversationId: 'chat-1', conversationType: 'group', raw: { chatId: 'chat-1' } },
        { text: 'group message', format: 'plain' },
      ),
      /group chat/,
    );
    const result = await adapter.send(
      { channel: 'wecom', accountId: 'wecom', conversationId: 'u1', conversationType: 'dm', raw: {} },
      { text: '   ', format: 'plain' },
    );
    assert.deepEqual(result, {});
  } finally {
    await adapter.stop();
  }
});

test('secrets and tokens never appear in adapter logs', async () => {
  const { log, lines } = makeLogger();
  const controller = new AbortController();
  const ctx = makeWebhookCtx({ config: webhookConfig(), routes: [], controller });
  ctx.log = log;
  const { fetchImpl } = makeFetch((url) => {
    if (url.includes('/cgi-bin/gettoken')) return { errcode: 42001, errmsg: 'bad token' };
    return { errcode: 40001, errmsg: 'invalid credential' };
  });
  const adapter = createWecomAdapter({ fetchImpl });
  await adapter.start(ctx);
  try {
    await assert.rejects(
      adapter.send(
        { channel: 'wecom', accountId: 'wecom', conversationId: 'u1', conversationType: 'dm', raw: { fromUserName: 'u1' } },
        { text: 'x', format: 'plain' },
      ),
    );
  } finally {
    await adapter.stop();
  }
  const dump = lines.map((line) => line.map((entry) => JSON.stringify(entry)).join(' ')).join('\n');
  for (const secret of ['test-secret', 'test-token', ENCODING_KEY, 'ww-corp-demo']) {
    // corpId is not a secret, but we assert it too: none of these values should be logged.
    assert.ok(!dump.includes(secret), `log output leaked ${secret.slice(0, 6)}…`);
  }
});
