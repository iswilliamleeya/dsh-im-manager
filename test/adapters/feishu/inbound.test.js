/**
 * Inbound normalization tests: DM / group @mention / group without mention /
 * image / file / post parsing, bot self-message filtering, dedupe, stable
 * message ids and thread ids.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createFeishuAdapter } from '../../../src/adapters/feishu/index.js';
import { parseMessageEvent } from '../../../src/adapters/feishu/event.js';
import {
  createFakeWsFactory,
  createHarness,
  fakeApiClient,
  v2Message,
} from './helpers.js';

const APP_ID = 'cli_0123456789abcdef';

const baseConfig = {
  mode: 'ws',
  appId: APP_ID,
  appSecret: 'test-app-secret',
  accountId: 'feishu',
};

/** @param {import('node:test').TestContext} t @param {{ config?: Record<string, any>, client?: any }} [options] */
async function startAdapter(t, options = {}) {
  const fakeWs = createFakeWsFactory();
  const harness = createHarness({ config: { ...baseConfig, ...options.config } });
  const adapter = createFeishuAdapter({
    createWsClient: fakeWs.factory,
    client: options.client ?? fakeApiClient(),
    now: () => 1_700_000_000_000,
  });
  await adapter.start(harness.ctx);
  t.after(async () => {
    await adapter.stop();
    harness.abort.abort();
  });
  return { adapter, harness, fakeWs };
}

/** @param {{ ref: { client: any } }} fakeWs @param {unknown} payload */
async function inject(fakeWs, payload) {
  await fakeWs.ref.client.dispatcher.invoke(payload, { needCheck: false });
}

test('ws mode: DM text is normalized into an InboundMessage', async (t) => {
  const { harness, fakeWs } = await startAdapter(t);
  await inject(fakeWs, v2Message({ messageId: 'om_dm_1', text: '你好', createTime: '1700000000000' }));

  assert.equal(harness.emitted.length, 1);
  const message = harness.emitted[0];
  assert.equal(message.channel, 'feishu');
  assert.equal(message.accountId, 'feishu');
  assert.equal(message.conversationId, 'oc_chat_1');
  assert.equal(message.conversationType, 'dm');
  assert.equal(message.messageId, 'om_dm_1');
  assert.deepEqual(message.sender, { id: 'ou_user_1' });
  assert.equal(message.text, '你好');
  assert.equal(message.mentioned, true, 'DM messages are always addressed to the bot');
  assert.deepEqual(message.attachments, []);
  assert.equal(message.timestamp, 1_700_000_000_000);
  assert.equal(message.target.channel, 'feishu');
  assert.equal(message.target.conversationId, 'oc_chat_1');
  assert.equal(message.target.replyToMessageId, 'om_dm_1');
});

test('ws mode: group message that @-mentions the bot sets mentioned=true and strips the mention', async (t) => {
  const { harness, fakeWs } = await startAdapter(t);
  await inject(fakeWs, v2Message({
    chatType: 'group',
    messageId: 'om_group_1',
    text: '@_user_1 帮我总结一下',
    mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot_test' }, name: 'Test Bot' }],
  }));

  assert.equal(harness.emitted.length, 1);
  const message = harness.emitted[0];
  assert.equal(message.conversationType, 'group');
  assert.equal(message.mentioned, true);
  assert.equal(message.text, '帮我总结一下');
});

test('ws mode: group message without a bot mention is still emitted with mentioned=false', async (t) => {
  const { harness, fakeWs } = await startAdapter(t);
  await inject(fakeWs, v2Message({ chatType: 'group', messageId: 'om_group_2', text: '随便聊聊' }));

  assert.equal(harness.emitted.length, 1);
  assert.equal(harness.emitted[0].mentioned, false);
  assert.equal(harness.emitted[0].text, '随便聊聊');
});

test('ws mode: mentioning another user does not count as mentioning the bot', async (t) => {
  const { harness, fakeWs } = await startAdapter(t);
  await inject(fakeWs, v2Message({
    chatType: 'group',
    messageId: 'om_group_3',
    text: '@_user_1 你好',
    mentions: [{ key: '@_user_1', id: { open_id: 'ou_alice' }, name: 'Alice' }],
  }));

  assert.equal(harness.emitted.length, 1);
  const message = harness.emitted[0];
  assert.equal(message.mentioned, false);
  assert.equal(message.text, '@Alice 你好', 'other people keep their @name in the text');
});

test('ws mode: falls back to the @_user_1 convention when bot identity is unknown', async (t) => {
  const client = { request: async () => { throw new Error('bot info unavailable'); } };
  const { harness, fakeWs } = await startAdapter(t, { client });
  await inject(fakeWs, v2Message({
    chatType: 'group',
    messageId: 'om_group_4',
    text: '@_user_1 在吗',
    mentions: [{ key: '@_user_1', id: { open_id: 'ou_unknown' }, name: 'Someone' }],
  }));

  assert.equal(harness.emitted.length, 1);
  assert.equal(harness.emitted[0].mentioned, true);
  assert.equal(harness.emitted[0].text, '在吗');
});

test('ws mode: image message becomes an image attachment with empty text', async (t) => {
  const { harness, fakeWs } = await startAdapter(t);
  await inject(fakeWs, v2Message({
    messageId: 'om_img_1',
    messageType: 'image',
    content: JSON.stringify({ image_key: 'img_v2_deadbeef' }),
  }));

  assert.equal(harness.emitted.length, 1);
  const message = harness.emitted[0];
  assert.equal(message.text, '');
  assert.deepEqual(message.attachments, [
    { kind: 'image', name: 'img_v2_deadbeef', mediaId: 'img_v2_deadbeef' },
  ]);
});

test('ws mode: file message keeps file name and size', async (t) => {
  const { harness, fakeWs } = await startAdapter(t);
  await inject(fakeWs, v2Message({
    messageId: 'om_file_1',
    messageType: 'file',
    content: JSON.stringify({ file_key: 'file_v2_1', file_name: 'report.pdf', file_size: 2048 }),
  }));

  assert.equal(harness.emitted.length, 1);
  assert.deepEqual(harness.emitted[0].attachments, [
    { kind: 'file', name: 'report.pdf', mediaId: 'file_v2_1', size: 2048 },
  ]);
});

test('ws mode: post (rich text) is flattened to text plus attachments', async (t) => {
  const { harness, fakeWs } = await startAdapter(t);
  await inject(fakeWs, v2Message({
    messageId: 'om_post_1',
    messageType: 'post',
    content: JSON.stringify({
      title: '周报',
      content: [
        [
          { tag: 'text', text: '本周完成 ' },
          { tag: 'a', text: '文档', href: 'https://example.com/doc' },
        ],
        [{ tag: 'img', image_key: 'img_v2_post' }],
      ],
    }),
  }));

  assert.equal(harness.emitted.length, 1);
  assert.equal(harness.emitted[0].text, '周报本周完成 文档');
  assert.deepEqual(harness.emitted[0].attachments, [
    { kind: 'image', name: 'img_v2_post', mediaId: 'img_v2_post' },
  ]);
});

test('ws mode: messages sent by an app/bot are ignored', async (t) => {
  const { harness, fakeWs } = await startAdapter(t);
  await inject(fakeWs, v2Message({ messageId: 'om_app_1', senderType: 'app', text: 'bot says hi' }));
  await inject(fakeWs, v2Message({ messageId: 'om_self_1', openId: 'ou_bot_test', text: 'our own message' }));

  assert.equal(harness.emitted.length, 0);
});

test('ws mode: unsupported message types and unrelated events are ignored', async (t) => {
  const { harness, fakeWs } = await startAdapter(t);
  await inject(fakeWs, v2Message({
    messageId: 'om_share_1',
    messageType: 'share_chat',
    content: JSON.stringify({ chat_id: 'oc_other' }),
  }));
  await inject(fakeWs, v2Message({ messageId: 'om_evt_1', eventType: 'im.chat.updated' }));

  assert.equal(harness.emitted.length, 0);
});

test('ws mode: duplicate deliveries are dropped (messageId dedupe)', async (t) => {
  const { harness, fakeWs } = await startAdapter(t);
  const payload = v2Message({ messageId: 'om_dup_1', text: '只回复一次' });
  await inject(fakeWs, payload);
  await inject(fakeWs, payload);

  assert.equal(harness.emitted.length, 1);
});

test('messageId is stable when the platform omits message_id', async (t) => {
  const payload = v2Message({ messageId: '', eventId: '', text: '无 id 的消息' });
  const first = parseMessageEvent(payload, { accountId: 'feishu', bot: {} });
  const second = parseMessageEvent(payload, { accountId: 'feishu', bot: {} });
  assert.ok(first !== null);
  assert.ok(second !== null);
  assert.equal(first.messageId, second.messageId);
  assert.match(first.messageId, /^derived:[0-9a-f]{24}$/);
  assert.equal(first.target.replyToMessageId, undefined, 'no reply target for a synthesized message id');

  const withEventId = v2Message({ messageId: '', eventId: 'evt_stable_1', text: 'x' });
  const a = parseMessageEvent(withEventId, { accountId: 'feishu', bot: {} });
  const b = parseMessageEvent(withEventId, { accountId: 'feishu', bot: {} });
  assert.equal(a?.messageId, 'event:evt_stable_1');
  assert.equal(b?.messageId, 'event:evt_stable_1');
});

test('ws mode: thread_id / root_id populate target.threadId', async (t) => {
  const { harness, fakeWs } = await startAdapter(t);
  await inject(fakeWs, v2Message({
    messageId: 'om_thread_1',
    chatType: 'group',
    text: 'thread reply',
    rootId: 'om_root_1',
    threadId: 'omt_thread_1',
  }));
  await inject(fakeWs, v2Message({
    messageId: 'om_thread_2',
    chatType: 'group',
    text: 'root only',
    rootId: 'om_root_2',
  }));

  assert.equal(harness.emitted.length, 2);
  assert.equal(harness.emitted[0].target.threadId, 'omt_thread_1');
  assert.equal(harness.emitted[1].target.threadId, 'om_root_2');
});

test('health() reports the WebSocket connection state', async (t) => {
  const { adapter, harness, fakeWs } = await startAdapter(t);
  const health = await adapter.health();
  assert.equal(health.state, 'connected');
  assert.equal(typeof health.since, 'number');

  fakeWs.ref.client.connectionState = 'failed';
  const degraded = await adapter.health();
  assert.equal(degraded.state, 'degraded');

  await adapter.stop();
  assert.equal((await adapter.health()).state, 'disconnected');
  assert.equal(harness.emitted.length, 0);
});
