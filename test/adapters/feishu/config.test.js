/**
 * Config validation and adapter lifecycle tests: actionable startup errors,
 * idempotent stop, abort-signal shutdown, secret-free logging.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeFeishuConfig } from '../../../src/adapters/feishu/config.js';
import { createFeishuAdapter } from '../../../src/adapters/feishu/index.js';
import {
  createFakeWsFactory,
  createHarness,
  fakeApiClient,
  silentLogger,
  waitFor,
} from './helpers.js';

const APP_ID = 'cli_0123456789abcdef';

/** @returns {{ lines: any[][], logger: import('../../../src/core/types.js').Logger }} */
function captureLogger() {
  /** @type {any[][]} */
  const lines = [];
  /** @type {any} */
  const logger = {
    debug: (...args) => lines.push(args),
    info: (...args) => lines.push(args),
    warn: (...args) => lines.push(args),
    error: (...args) => lines.push(args),
    child: () => logger,
  };
  return { lines, logger };
}

/** @param {Record<string, any>} config @param {{ client?: any, log?: any }} [options] */
function makeAdapter(config, options = {}) {
  const fakeWs = createFakeWsFactory();
  const harness = createHarness({ config, log: options.log });
  const adapter = createFeishuAdapter({
    createWsClient: fakeWs.factory,
    client: options.client ?? fakeApiClient(),
    now: () => 1_700_000_000_000,
  });
  return { adapter, harness, fakeWs };
}

test('config defaults: ws mode, default webhook path, markdown cards on, threads reply off', () => {
  const config = normalizeFeishuConfig({ appId: APP_ID, appSecret: 's' });
  assert.equal(config.mode, 'ws');
  assert.equal(config.accountId, 'feishu');
  assert.equal(config.domain, 'feishu');
  assert.equal(config.webhookPath, '/webhook/feishu');
  assert.equal(config.markdownAsCard, true);
  assert.equal(config.replyInThread, false);
  assert.equal(config.botOpenId, '');
  assert.equal(config.encryptKey, '');
});

test('config accepts connectionMode alias, custom webhookPath and markdownAsCard override', () => {
  const config = normalizeFeishuConfig({
    appId: APP_ID,
    appSecret: 's',
    connectionMode: 'webhook',
    webhookPath: '/hooks/feishu',
    sendMarkdownAsCard: false,
    accountId: 'lark-prod',
    domain: 'lark',
  });
  assert.equal(config.mode, 'webhook');
  assert.equal(config.webhookPath, '/hooks/feishu');
  assert.equal(config.markdownAsCard, false);
  assert.equal(config.accountId, 'lark-prod');
  assert.equal(config.domain, 'lark');
});

test('config rejects missing credentials with an actionable message', () => {
  assert.throws(
    () => normalizeFeishuConfig({ appSecret: 's' }),
    /missing appId.*env:FEISHU_APP_ID/,
  );
  assert.throws(
    () => normalizeFeishuConfig({ appId: APP_ID }),
    /missing appSecret/,
  );
  assert.throws(() => normalizeFeishuConfig(null), /must be an object/);
});

test('config rejects an invalid mode, domain, webhook path and ws appId', () => {
  assert.throws(() => normalizeFeishuConfig({ appId: APP_ID, appSecret: 's', mode: 'stream' }), /mode must be "ws" or "webhook"/);
  assert.throws(() => normalizeFeishuConfig({ appId: APP_ID, appSecret: 's', domain: 'dingtalk' }), /domain must be "feishu" or "lark"/);
  assert.throws(
    () => normalizeFeishuConfig({ appId: APP_ID, appSecret: 's', mode: 'webhook', webhookPath: 'webhook/feishu' }),
    /webhookPath must start with/,
  );
  assert.throws(
    () => normalizeFeishuConfig({ appId: 'not-a-feishu-id', appSecret: 's', mode: 'ws' }),
    /invalid appId "not-a-feishu-id" for mode=ws/,
  );
});

test('start() fails clearly when appId/appSecret are missing', async () => {
  const { adapter, harness } = makeAdapter({ mode: 'ws', appSecret: 'secret' });
  await assert.rejects(adapter.start(harness.ctx), /missing appId/);
  // A failed start must leave the adapter reusable/stopped.
  assert.equal((await adapter.health()).state, 'disconnected');
  await adapter.stop();
});

test('webhook mode without an HTTP host fails with a clear error', async () => {
  const { adapter, harness } = makeAdapter({ mode: 'webhook', appId: APP_ID, appSecret: 'secret' });
  harness.ctx.http = null;
  await assert.rejects(adapter.start(harness.ctx), /mode="webhook" requires the gateway HTTP host/);
});

test('start() twice throws, stop() is idempotent and abort signal stops the channel', async () => {
  const { adapter, harness } = makeAdapter({ mode: 'ws', appId: APP_ID, appSecret: 'secret' });
  await adapter.start(harness.ctx);
  await assert.rejects(adapter.start(harness.ctx), /already started/);

  await adapter.stop();
  await adapter.stop();
  assert.equal((await adapter.health()).state, 'disconnected');

  // A fresh adapter wired to the harness abort signal stops when the gateway aborts.
  const fakeWs = createFakeWsFactory();
  const secondHarness = createHarness({ config: { mode: 'ws', appId: APP_ID, appSecret: 'secret' } });
  const secondAdapter = createFeishuAdapter({
    createWsClient: fakeWs.factory,
    client: fakeApiClient(),
    now: () => 1_700_000_000_000,
  });
  await secondAdapter.start(secondHarness.ctx);
  assert.equal((await secondAdapter.health()).state, 'connected');
  secondHarness.abort.abort();
  await waitFor(() => fakeWs.ref.client.closed === true);
  await waitFor(async () => (await secondAdapter.health()).state === 'disconnected');
});

test('startup logs never contain the app secret', async () => {
  const captured = captureLogger();
  const secret = 'super-secret-app-secret';
  const { adapter, harness, fakeWs } = makeAdapter(
    { mode: 'ws', appId: APP_ID, appSecret: secret, encryptKey: 'ek', verificationToken: 'vt' },
    { log: captured.logger },
  );
  await adapter.start(harness.ctx);
  await fakeWs.ref.client.dispatcher.invoke(
    { schema: '2.0', header: { event_type: 'im.message.receive_v1' }, event: { sender: {}, message: {} } },
    { needCheck: false },
  );
  await adapter.stop();

  const rendered = JSON.stringify(captured.lines);
  assert.ok(!rendered.includes(secret), 'logs must not include appSecret');
  assert.ok(!rendered.includes('Bearer'), 'logs must not include authorization headers');
});

test('registry.loadAdapter() resolves the default export with the Adapter contract', async () => {
  const { loadAdapter } = await import('../../../src/adapters/registry.js');
  const adapter = await loadAdapter('feishu');
  assert.equal(adapter.id, 'feishu');
  assert.deepEqual(adapter.capabilities, {
    text: true,
    markdown: true,
    media: false,
    streaming: false,
    typing: false,
    threads: true,
  });
  assert.equal(typeof adapter.start, 'function');
  assert.equal(typeof adapter.stop, 'function');
  assert.equal(typeof adapter.send, 'function');
  assert.equal(typeof adapter.health, 'function');
});

test('SDK log adapter scrubs configured secrets from error payloads', async () => {
  const { createSdkLogger } = await import('../../../src/adapters/feishu/sdk.js');
  const captured = captureLogger();
  const sdkLogger = createSdkLogger(captured.logger, ['super-secret-value', 'enc-key-value', 'vt-value']);
  sdkLogger.error([
    {
      message: 'Request failed with status code 401',
      config: { data: { app_id: 'cli_x', app_secret: 'super-secret-value' }, url: '/open-apis/auth/v3/tenant_access_token/internal' },
    },
  ]);
  const rendered = JSON.stringify(captured.lines);
  assert.ok(!rendered.includes('super-secret-value'), 'appSecret must be scrubbed from SDK logs');
  assert.ok(rendered.includes('tenant_access_token'), 'non-secret diagnostics are kept');
});

test('module exports validateConfig for `dsh-im-manager doctor`', async () => {
  const module = await import('../../../src/adapters/feishu/index.js');
  assert.equal(typeof module.validateConfig, 'function');
  assert.doesNotThrow(() => module.validateConfig({ mode: 'ws', appId: APP_ID, appSecret: 's' }));
  assert.throws(() => module.validateConfig({ mode: 'ws', appId: 'bad', appSecret: 's' }), /invalid appId/);
  assert.doesNotThrow(() => module.validateConfig({ mode: 'webhook', appId: 'cli_anything', appSecret: 's' }));
});

test('webhook mode reports a clear error when the HTTP host cannot register routes', async () => {
  const { adapter, harness } = makeAdapter({ mode: 'webhook', appId: APP_ID, appSecret: 'secret' });
  harness.ctx.http = {
    route: () => {
      throw new Error('HTTP host is disabled (gateway.http.enabled=false)');
    },
    publicBaseUrl: () => null,
    publicUrl: () => null,
  };
  await assert.rejects(
    adapter.start(harness.ctx),
    /mode="webhook" requires the gateway HTTP host.*gateway.http.enabled=false/,
  );
});
