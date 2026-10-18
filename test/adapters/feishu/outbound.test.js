/**
 * Outbound delivery tests against a local fake Feishu OpenAPI server.
 *
 * A real `@larksuiteoapi/node-sdk` Client is used with its `domain` pointed at
 * the fake server, so tenant_access_token acquisition, Authorization headers
 * and request bodies are exercised end-to-end without touching Feishu.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import * as lark from '@larksuiteoapi/node-sdk';

import { createFeishuAdapter } from '../../../src/adapters/feishu/index.js';
import { createHarness, startFakeFeishu, uniqueAppId } from './helpers.js';

/** The SDK's own logger would print expected token/card failures. */
const silentSdkLogger = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {}, trace: () => {} };

/** @param {string} baseUrl */
function createClientFor(baseUrl) {
  return ({ config }) => new lark.Client({
    appId: config.appId,
    appSecret: config.appSecret,
    domain: baseUrl,
    loggerLevel: lark.LoggerLevel.error,
    logger: silentSdkLogger,
  });
}

/**
 * @param {import('node:test').TestContext} t
 * @param {Awaited<ReturnType<typeof startFakeFeishu>>} fake
 */
async function startOutboundAdapter(t, fake) {
  const appId = uniqueAppId();
  const harness = createHarness({
    config: {
      mode: 'webhook',
      appId,
      appSecret: 'test-app-secret',
      accountId: 'feishu',
      webhookPath: '/webhook/feishu',
    },
  });
  const adapter = createFeishuAdapter({
    createClient: createClientFor(fake.baseUrl),
    now: () => 1_700_000_000_000,
  });
  await adapter.start(harness.ctx);
  t.after(async () => {
    await adapter.stop();
    await fake.close();
  });
  return { adapter, appId };
}

/** @param {'reply' | 'create'} kind @param {Awaited<ReturnType<typeof startFakeFeishu>>['requests']} requests */
function imRequests(requests) {
  return requests.filter((request) => request.path.startsWith('/open-apis/im/v1/messages'));
}

test('plain text with replyToMessageId uses im.message.reply with tenant token auth', async (t) => {
  const fake = await startFakeFeishu();
  const { adapter, appId } = await startOutboundAdapter(t, fake);

  const result = await adapter.send(
    {
      channel: 'feishu',
      accountId: 'feishu',
      conversationId: 'oc_chat_1',
      conversationType: 'dm',
      replyToMessageId: 'om_in_1',
    },
    { text: '你好', format: 'plain' },
  );

  assert.equal(result.messageId, 'om_reply_1');

  const tokenRequest = fake.requests.find((request) => request.path === '/open-apis/auth/v3/tenant_access_token/internal');
  assert.ok(tokenRequest !== undefined, 'adapter must obtain a tenant_access_token');
  assert.equal(tokenRequest.method, 'POST');
  assert.equal(tokenRequest.body.app_id, appId);
  assert.equal(tokenRequest.body.app_secret, 'test-app-secret');

  const [reply] = imRequests(fake.requests);
  assert.equal(reply.method, 'POST');
  assert.equal(reply.path, '/open-apis/im/v1/messages/om_in_1/reply');
  assert.equal(reply.headers.authorization, 'Bearer t-test-token');
  assert.deepEqual(reply.body, { msg_type: 'text', content: JSON.stringify({ text: '你好' }) });
  assert.equal(reply.query.receive_id_type, undefined, 'reply does not take receive_id_type');
});

test('without replyToMessageId the adapter creates a chat message', async (t) => {
  const fake = await startFakeFeishu();
  const { adapter } = await startOutboundAdapter(t, fake);

  const result = await adapter.send(
    {
      channel: 'feishu',
      accountId: 'feishu',
      conversationId: 'oc_chat_9',
      conversationType: 'group',
    },
    { text: '群里播报', format: 'plain' },
  );

  assert.equal(result.messageId, 'om_created_1');

  const [create] = imRequests(fake.requests);
  assert.equal(create.path, '/open-apis/im/v1/messages');
  assert.equal(create.query.receive_id_type, 'chat_id');
  assert.equal(create.headers.authorization, 'Bearer t-test-token');
  assert.deepEqual(create.body, {
    receive_id: 'oc_chat_9',
    msg_type: 'text',
    content: JSON.stringify({ text: '群里播报' }),
  });
});

test('markdown is delivered as an interactive card with a lark_md block', async (t) => {
  const fake = await startFakeFeishu();
  const { adapter } = await startOutboundAdapter(t, fake);

  const markdown = '**粗体**\n- 列表项\n[链接](https://example.com)';
  const result = await adapter.send(
    {
      channel: 'feishu',
      accountId: 'feishu',
      conversationId: 'oc_chat_1',
      conversationType: 'dm',
      replyToMessageId: 'om_in_2',
    },
    { text: markdown, format: 'markdown' },
  );

  assert.equal(result.messageId, 'om_reply_1');
  const [reply] = imRequests(fake.requests);
  assert.equal(reply.body.msg_type, 'interactive');
  const card = JSON.parse(reply.body.content);
  assert.equal(card.config.wide_screen_mode, true);
  assert.equal(card.elements[0].tag, 'div');
  assert.equal(card.elements[0].text.tag, 'lark_md');
  assert.equal(card.elements[0].text.content, markdown);
});

test('markdown degrades to a plain text message when the card is rejected', async (t) => {
  const fake = await startFakeFeishu({ failCard: 2 });
  const { adapter } = await startOutboundAdapter(t, fake);

  const result = await adapter.send(
    {
      channel: 'feishu',
      accountId: 'feishu',
      conversationId: 'oc_chat_1',
      conversationType: 'dm',
      replyToMessageId: 'om_in_3',
    },
    { text: '**重要** 结论', format: 'markdown' },
  );

  assert.match(result.messageId, /^om_reply_/);
  const messages = imRequests(fake.requests);
  // card via reply rejected, card via create rejected, then text via reply.
  assert.equal(messages.length, 3);
  assert.equal(messages[0].body.msg_type, 'interactive');
  assert.equal(messages[1].body.msg_type, 'interactive');
  assert.equal(messages[2].body.msg_type, 'text');
  assert.deepEqual(messages[2].body, {
    msg_type: 'text',
    content: JSON.stringify({ text: '**重要** 结论' }),
  });
});

test('reply failure falls back to creating a chat message', async (t) => {
  const fake = await startFakeFeishu({ failReply: 1 });
  const { adapter } = await startOutboundAdapter(t, fake);

  const result = await adapter.send(
    {
      channel: 'feishu',
      accountId: 'feishu',
      conversationId: 'oc_chat_1',
      conversationType: 'dm',
      replyToMessageId: 'om_deleted',
    },
    { text: 'fallback', format: 'plain' },
  );

  assert.match(result.messageId, /^om_created_/);
  const messages = imRequests(fake.requests);
  assert.equal(messages[0].path, '/open-apis/im/v1/messages/om_deleted/reply');
  assert.equal(messages[1].path, '/open-apis/im/v1/messages');
  assert.equal(messages[1].body.receive_id, 'oc_chat_1');
});

test('send() throws when the platform rejects the message', async (t) => {
  const fake = await startFakeFeishu({ failCreate: 1 });
  const { adapter } = await startOutboundAdapter(t, fake);

  await assert.rejects(
    adapter.send(
      { channel: 'feishu', accountId: 'feishu', conversationId: 'oc_chat_fail', conversationType: 'group' },
      { text: 'will fail', format: 'plain' },
    ),
    /feishu: failed to send message/,
  );
  assert.equal(imRequests(fake.requests).length, 1);
});

test('send() rejects empty text and unsupported outbound attachments', async (t) => {
  const fake = await startFakeFeishu();
  const { adapter } = await startOutboundAdapter(t, fake);
  const target = {
    channel: 'feishu',
    accountId: 'feishu',
    conversationId: 'oc_chat_1',
    conversationType: 'dm',
  };

  await assert.rejects(adapter.send(target, { text: '   ', format: 'plain' }), /empty message/);
  await assert.rejects(
    adapter.send(target, { text: 'x', attachments: [{ kind: 'image', url: 'https://example.com/a.png' }] }),
    /outbound attachments are not supported/,
  );
});

test('send() before start() fails with a clear error', async () => {
  const { createFeishuAdapter: create } = await import('../../../src/adapters/feishu/index.js');
  const adapter = create();
  await assert.rejects(
    adapter.send({ channel: 'feishu', accountId: 'feishu', conversationId: 'oc', conversationType: 'dm' }, { text: 'x' }),
    /not started/,
  );
});
