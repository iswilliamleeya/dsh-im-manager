/**
 * Webhook mode tests: URL verification (challenge), Encrypt Key decryption,
 * verification token checks, 3-second acknowledgement ordering, custom paths.
 *
 * The webhook handler is served through a real local node:http server that
 * dispatches to the route registered on the fake `ctx.http`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createFeishuAdapter } from '../../../src/adapters/feishu/index.js';
import {
  createHarness,
  encryptFeishuPayload,
  fakeApiClient,
  serveRoutes,
  uniqueAppId,
  v2Message,
  waitFor,
} from './helpers.js';

const baseConfig = {
  mode: 'webhook',
  appSecret: 'test-app-secret',
  accountId: 'feishu',
  verificationToken: 'vt_token',
  webhookPath: '/webhook/feishu',
};

/**
 * @param {import('node:test').TestContext} t
 * @param {{ config?: Record<string, any>, emit?: (inbound: any) => Promise<void> }} [options]
 */
async function startWebhook(t, options = {}) {
  const harness = createHarness({
    config: { ...baseConfig, appId: uniqueAppId(), ...options.config },
    ...(options.emit !== undefined ? { emit: options.emit } : {}),
  });
  const adapter = createFeishuAdapter({ client: fakeApiClient(), now: () => 1_700_000_000_000 });
  await adapter.start(harness.ctx);
  const server = await serveRoutes(harness.httpRoutes);
  t.after(async () => {
    await adapter.stop();
    await server.close();
    harness.abort.abort();
  });
  return { adapter, harness, server };
}

test('webhook mode registers the configured path and answers URL verification synchronously', async (t) => {
  const { harness, server } = await startWebhook(t);
  assert.ok(harness.httpRoutes.has('POST /webhook/feishu'));

  const response = await server.post('/webhook/feishu', {
    type: 'url_verification',
    challenge: 'challenge-abc',
    token: 'vt_token',
  });

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { challenge: 'challenge-abc' });
  assert.equal(harness.emitted.length, 0, 'challenge must not be emitted as a message');
});

test('webhook mode answers an encrypted URL verification challenge', async (t) => {
  const encryptKey = 'test-encrypt-key';
  const { server } = await startWebhook(t, { config: { encryptKey } });
  const encrypted = encryptFeishuPayload({
    type: 'url_verification',
    challenge: 'encrypted-challenge',
    token: 'vt_token',
  }, encryptKey);

  const response = await server.post('/webhook/feishu', { encrypt: encrypted });

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { challenge: 'encrypted-challenge' });
});

test('webhook mode emits a normalized message for a plain event callback', async (t) => {
  const { harness, server } = await startWebhook(t);

  const response = await server.post('/webhook/feishu', v2Message({ messageId: 'om_webhook_1', text: '走 webhook' }));

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { code: 0, msg: 'success' });
  await waitFor(() => harness.emitted.length === 1);
  assert.equal(harness.emitted[0].messageId, 'om_webhook_1');
  assert.equal(harness.emitted[0].text, '走 webhook');
});

test('webhook mode decrypts an encrypted event callback before emitting', async (t) => {
  const encryptKey = 'test-encrypt-key';
  const { harness, server } = await startWebhook(t, { config: { encryptKey } });
  const encrypted = encryptFeishuPayload(
    v2Message({ messageId: 'om_webhook_enc_1', text: '加密消息', chatType: 'group', mentions: [
      { key: '@_user_1', id: { open_id: 'ou_bot_test' }, name: 'Test Bot' },
    ], content: JSON.stringify({ text: '@_user_1 加密消息' }) }),
    encryptKey,
  );

  const response = await server.post('/webhook/feishu', { encrypt: encrypted });

  assert.equal(response.status, 200);
  await waitFor(() => harness.emitted.length === 1);
  assert.equal(harness.emitted[0].text, '加密消息');
  assert.equal(harness.emitted[0].mentioned, true);
});

test('webhook mode acknowledges within 3s and emits asynchronously', async (t) => {
  /** @type {any[]} */
  const emitted = [];
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = () => resolve(undefined);
  });
  const { server } = await startWebhook(t, {
    emit: async (inbound) => {
      await gate;
      emitted.push(inbound);
    },
  });

  const startedAt = Date.now();
  const response = await server.post('/webhook/feishu', v2Message({ messageId: 'om_slow_agent' }));
  const elapsedMs = Date.now() - startedAt;

  assert.equal(response.status, 200);
  assert.ok(elapsedMs < 3000, `webhook must answer fast (took ${elapsedMs}ms)`);
  assert.equal(emitted.length, 0, 'platform response must not wait for the agent-facing emit');

  release();
  await waitFor(() => emitted.length === 1);
});

test('webhook mode rejects a mismatched verification token', async (t) => {
  const { harness, server } = await startWebhook(t);
  const payload = v2Message({ messageId: 'om_bad_token' });
  payload.header.token = 'wrong-token';

  const response = await server.post('/webhook/feishu', payload);

  assert.equal(response.status, 403);
  assert.deepEqual(response.body, { code: -1, msg: 'verification token mismatch' });
  assert.equal(harness.emitted.length, 0);
});

test('webhook mode rejects malformed JSON', async (t) => {
  const { server } = await startWebhook(t);
  const response = await fetch(`${server.baseUrl}/webhook/feishu`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: 'not-json',
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { code: -1, msg: 'invalid json' });
});

test('webhook mode rejects an encrypted body when encryptKey is not configured', async (t) => {
  const { server } = await startWebhook(t);
  const response = await server.post('/webhook/feishu', { encrypt: 'c29tZS1jaXBoZXI=' });
  assert.equal(response.status, 400);
  assert.deepEqual(response.body, { code: -1, msg: 'encryptKey not configured' });
});

test('webhook mode rejects a body that cannot be decrypted', async (t) => {
  const { server } = await startWebhook(t, { config: { encryptKey: 'right-key' } });
  const encrypted = encryptFeishuPayload({ type: 'event_callback' }, 'wrong-key');
  const response = await server.post('/webhook/feishu', { encrypt: encrypted });
  assert.equal(response.status, 400);
  assert.deepEqual(response.body, { code: -1, msg: 'decrypt failed' });
});

test('webhook mode supports a custom webhookPath and ignores events after stop()', async (t) => {
  const { adapter, harness, server } = await startWebhook(t, { config: { webhookPath: '/hooks/feishu' } });
  assert.ok(harness.httpRoutes.has('POST /hooks/feishu'));

  const response = await server.post('/hooks/feishu', v2Message({ messageId: 'om_custom_path' }));
  assert.equal(response.status, 200);
  await waitFor(() => harness.emitted.length === 1);

  await adapter.stop();
  // After stop the route is disposed; only the handler's own state matters here.
  assert.equal((await adapter.health()).state, 'disconnected');
});

test('webhook handler also accepts the documented (req, res, body) call signature', async () => {
  const { createWebhookHandler } = await import('../../../src/adapters/feishu/webhook.js');
  const calls = [];
  const handler = createWebhookHandler({
    config: { encryptKey: '', verificationToken: 'vt_token', webhookPath: '/webhook/feishu' },
    onEvent: async () => { calls.push('event'); },
  });

  /** @type {any} */
  const req = { method: 'POST', url: '/webhook/feishu', headers: {} };
  /** @type {any} */
  let status;
  let ended;
  const res = {
    headersSent: false,
    writableEnded: false,
    writeHead(nextStatus) { status = nextStatus; this.headersSent = true; return this; },
    end(payload) { ended = payload; this.writableEnded = true; },
  };

  await handler(req, res, Buffer.from(JSON.stringify({ type: 'url_verification', challenge: 'legacy', token: 'vt_token' })));

  assert.equal(status, 200);
  assert.deepEqual(JSON.parse(ended), { challenge: 'legacy' });
  assert.equal(calls.length, 0);
});

test('integrates with the real core HTTP host (single-object route handler)', async (t) => {
  const [{ createHttpHost }, { createHarness: makeHarness }] = await Promise.all([
    import('../../../src/core/http-host.js'),
    import('./helpers.js'),
  ]);
  const host = createHttpHost({ host: '127.0.0.1', port: 0 });
  const harness = makeHarness({
    config: { ...baseConfig, appId: uniqueAppId() },
  });
  harness.ctx.http = host;
  const adapter = createFeishuAdapter({ client: fakeApiClient(), now: () => 1_700_000_000_000 });
  await adapter.start(harness.ctx);
  await host.start();
  t.after(async () => {
    await adapter.stop();
    await host.stop();
    harness.abort.abort();
  });

  const response = await fetch(`http://127.0.0.1:${host.port}/webhook/feishu`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(v2Message({ messageId: 'om_core_http_1', text: '真实 core HTTP host' })),
  });

  assert.equal(response.status, 200);
  await waitFor(() => harness.emitted.length === 1);
  assert.equal(harness.emitted[0].messageId, 'om_core_http_1');
  assert.equal(harness.emitted[0].text, '真实 core HTTP host');
});
