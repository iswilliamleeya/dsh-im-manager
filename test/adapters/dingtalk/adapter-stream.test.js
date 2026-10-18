import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { createAdapter, TOPIC_ROBOT } from '../../../src/adapters/dingtalk/index.js';
import {
  createAdapterContext,
  createFakeStreamClient,
  dmPayload,
  flush,
  robotPayload,
  streamEnvelope,
} from './helpers.js';

const BASE_CONFIG = {
  mode: 'stream',
  clientId: 'ding_client_id',
  clientSecret: 'ding_client_secret',
  accountId: 'dingtalk',
};

/** Start an adapter with a fake Stream client and a fake emit sink. */
async function startStreamAdapter(overrides = {}) {
  const client = overrides.client ?? createFakeStreamClient();
  const { ctx, controller, emitted } = createAdapterContext({
    config: { ...BASE_CONFIG, ...(overrides.config ?? {}) },
    ...overrides.context,
  });
  /** @type {number} */
  let ackedWhenEmitted = -1;
  const userEmit = ctx.emit;
  ctx.emit = async (inbound) => {
    ackedWhenEmitted = client.acked.length;
    await userEmit(inbound);
  };
  const adapter = createAdapter({
    streamClientFactory: (config) => {
      overrides.onFactory?.(config);
      return client;
    },
    now: overrides.now,
  });
  await adapter.start(ctx);
  return { adapter, client, ctx, emitted, controller, getAckedWhenEmitted: () => ackedWhenEmitted };
}

test('stream mode registers the robot topic, ACKs then emits a normalized message', async () => {
  const { adapter, client, emitted, getAckedWhenEmitted } = await startStreamAdapter();
  try {
    assert.equal(client.listeners.has(TOPIC_ROBOT), true);
    assert.equal(TOPIC_ROBOT, '/v1.0/im/bot/messages/get');
    assert.equal(client.calls.connect, 1);
    assert.equal((await adapter.health()).state, 'connected');

    client.dispatch(streamEnvelope(robotPayload()));
    await flush();

    assert.equal(emitted.length, 1);
    // ACK must happen before the async emit so DingTalk does not redeliver.
    assert.equal(getAckedWhenEmitted(), 1);
    assert.deepEqual(client.acked, [{ messageId: 'stream-msg-1', result: { success: true } }]);
    const inbound = emitted[0];
    assert.equal(inbound.channel, 'dingtalk');
    assert.equal(inbound.accountId, 'dingtalk');
    assert.equal(inbound.conversationType, 'group');
    assert.equal(inbound.messageId, 'msg-1001');
    assert.equal(inbound.text, '帮我看看这个报错');
    assert.equal(inbound.mentioned, true);
    assert.equal(inbound.target.raw.sessionWebhook, robotPayload().sessionWebhook);
  } finally {
    await adapter.stop();
  }
});

test('duplicate platform redeliveries are dropped by the adapter dedupe guard', async () => {
  const { adapter, client, emitted } = await startStreamAdapter();
  try {
    const raw = robotPayload();
    client.dispatch(streamEnvelope(raw, { messageId: 'delivery-1' }));
    client.dispatch(streamEnvelope(raw, { messageId: 'delivery-2' }));
    await flush();
    assert.equal(emitted.length, 1);
    assert.equal(client.acked.length, 2); // both deliveries acknowledged
  } finally {
    await adapter.stop();
  }
});

test('unparseable callback payload is ACKed but never emitted', async () => {
  const { adapter, client, emitted } = await startStreamAdapter();
  try {
    client.dispatch(streamEnvelope('this-is-not-json', { messageId: 'bad-delivery' }));
    await flush();
    assert.equal(client.acked.length, 1);
    assert.equal(client.acked[0].messageId, 'bad-delivery');
    assert.equal(emitted.length, 0);
  } finally {
    await adapter.stop();
  }
});

test('bot self-echoes are ignored', async () => {
  const { adapter, client, emitted } = await startStreamAdapter();
  try {
    client.dispatch(streamEnvelope(dmPayload({ senderId: '$:LWCP_v1:$bot_user_id', senderStaffId: undefined })));
    await flush();
    assert.equal(emitted.length, 0);
  } finally {
    await adapter.stop();
  }
});

test('stop() is idempotent and flips health to disconnected', async () => {
  const { adapter, client } = await startStreamAdapter();
  assert.equal((await adapter.health()).state, 'connected');
  await adapter.stop();
  await adapter.stop();
  assert.equal(client.calls.disconnect, 1);
  assert.equal((await adapter.health()).state, 'disconnected');
});

test('aborting ctx.signal stops the stream client automatically', async () => {
  const { adapter, client, controller } = await startStreamAdapter();
  assert.equal((await adapter.health()).state, 'connected');
  controller.abort();
  await flush();
  assert.equal(client.calls.disconnect, 1);
  assert.equal((await adapter.health()).state, 'disconnected');
  await adapter.stop(); // still idempotent after signal-driven stop
});

test('missing credentials fail start with an actionable config error', async () => {
  const adapter = createAdapter({ streamClientFactory: () => createFakeStreamClient() });
  const { ctx } = createAdapterContext({ config: { mode: 'stream', clientId: 'id' } });
  await assert.rejects(adapter.start(ctx), /clientSecret/);

  const second = createAdapter({ streamClientFactory: () => createFakeStreamClient() });
  const missingId = createAdapterContext({ config: { mode: 'stream', clientSecret: 'secret' } });
  await assert.rejects(second.start(missingId.ctx), /clientId/);
});

test('env: prefixed credentials are resolved through ctx.secret', async () => {
  const { ctx } = createAdapterContext({
    config: { mode: 'stream', clientId: 'env:DINGTALK_CLIENT_ID', clientSecret: 'env:DINGTALK_CLIENT_SECRET' },
    secret: (name) => ({
      DINGTALK_CLIENT_ID: 'resolved_client_id',
      DINGTALK_CLIENT_SECRET: 'resolved_client_secret',
    })[name],
  });
  let seen = null;
  const adapter = createAdapter({
    streamClientFactory: (config) => {
      seen = config;
      return createFakeStreamClient();
    },
  });
  await adapter.start(ctx);
  try {
    assert.equal(seen.clientId, 'resolved_client_id');
    assert.equal(seen.clientSecret, 'resolved_client_secret');
    assert.equal(adapter.__testing.config().clientSecret, 'resolved_client_secret');
  } finally {
    await adapter.stop();
  }
});

test('adapter.send() posts replies through the inbound sessionWebhook', async () => {
  /** @type {any[]} */
  const requests = [];
  const server = createServer((req, res) => {
    /** @type {Buffer[]} */
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ errcode: 0, errmsg: 'ok' }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  const { adapter, client, emitted } = await startStreamAdapter();
  try {
    client.dispatch(streamEnvelope(robotPayload({ sessionWebhook: `http://127.0.0.1:${port}/hook?token=t` })));
    await flush();
    assert.equal(emitted.length, 1);
    const result = await adapter.send(emitted[0].target, { text: '收到', format: 'markdown' });
    assert.equal(typeof result.messageId, 'string');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].msgtype, 'markdown');
    assert.equal(requests[0].markdown.text, '收到');
  } finally {
    await adapter.stop();
    await new Promise((resolve) => server.close(resolve));
  }
});
