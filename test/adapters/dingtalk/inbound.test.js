import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  detectMentioned,
  normalizeTimestamp,
  parseInbound,
  resolveConversationId,
  resolveConversationType,
  resolveMessageId,
  stripMentionPrefix,
} from '../../../src/adapters/dingtalk/inbound.js';
import { dmPayload, robotPayload } from './helpers.js';

const CONFIG = { clientId: 'ding_client_id', robotCode: 'ding_client_id' };

test('DM text message maps to a dm InboundMessage keyed by the sender', () => {
  const inbound = parseInbound(dmPayload(), { config: CONFIG, now: 1_700_000_000_000 });
  assert.ok(inbound);
  assert.equal(inbound.channel, 'dingtalk');
  assert.equal(inbound.accountId, 'dingtalk');
  assert.equal(inbound.conversationType, 'dm');
  // DM conversation id is the human, not the platform chat id.
  assert.equal(inbound.conversationId, 'staff_001');
  assert.equal(inbound.messageId, 'msg-1001');
  assert.deepEqual(inbound.sender, { id: 'staff_001', name: 'Alice' });
  assert.equal(inbound.text, '你好');
  assert.equal(inbound.mentioned, true); // DM is always "mentioned"
  assert.deepEqual(inbound.attachments, []);
  assert.equal(inbound.timestamp, 1_700_000_000_000);
  assert.equal(inbound.target.channel, 'dingtalk');
  assert.equal(inbound.target.conversationType, 'dm');
  assert.equal(inbound.target.replyToMessageId, 'msg-1001');
  assert.equal(inbound.target.raw.sessionWebhook, dmPayload().sessionWebhook);
  assert.equal(inbound.target.raw.sessionWebhookExpiredTime, 4_000_000_000_000);
  assert.equal(inbound.target.raw.robotCode, 'ding_client_id');
  assert.equal(inbound.raw.msgtype, 'text');
});

test('group text message strips the leading @机器人 mention', () => {
  const inbound = parseInbound(robotPayload(), { config: CONFIG, now: 1_700_000_000_000 });
  assert.ok(inbound);
  assert.equal(inbound.conversationType, 'group');
  assert.equal(inbound.conversationId, 'cid_group_1');
  assert.equal(inbound.mentioned, true);
  assert.equal(inbound.text, '帮我看看这个报错');
});

test('group message without an @ mention keeps its text verbatim', () => {
  const inbound = parseInbound(
    robotPayload({ text: { content: '大家好' }, atUsers: [], isInAtList: false }),
    { config: CONFIG },
  );
  assert.ok(inbound);
  assert.equal(inbound.mentioned, false);
  assert.equal(inbound.text, '大家好');
});

test('isInAtList=true counts as a mention even without atUsers', () => {
  const inbound = parseInbound(
    robotPayload({ atUsers: undefined, isInAtList: true }),
    { config: CONFIG },
  );
  assert.ok(inbound);
  assert.equal(inbound.mentioned, true);
  assert.equal(inbound.text, '帮我看看这个报错');
});

test('richText content becomes text plus image attachments', () => {
  const content = JSON.stringify({
    richText: [
      { text: '看这张图' },
      { type: 'picture', downloadCode: 'code_img_1' },
      { type: 'at', userId: 'bot_dingtalk_id' },
    ],
  });
  const inbound = parseInbound(
    robotPayload({ msgtype: 'richText', content, text: undefined, atUsers: [] }),
    { config: CONFIG },
  );
  assert.ok(inbound);
  assert.equal(inbound.text, '看这张图');
  assert.deepEqual(inbound.attachments, [{ kind: 'image', mediaId: 'code_img_1' }]);
  assert.equal(inbound.mentioned, true);
});

test('picture message becomes an image attachment carrying the downloadCode', () => {
  const inbound = parseInbound(
    robotPayload({
      msgtype: 'picture',
      text: undefined,
      content: JSON.stringify({ downloadCode: 'code_pic_1', pictureDownloadCode: 'code_pic_1' }),
    }),
    { config: CONFIG },
  );
  assert.ok(inbound);
  assert.equal(inbound.text, '');
  assert.deepEqual(inbound.attachments, [{ kind: 'image', mediaId: 'code_pic_1' }]);
});

test('file message keeps name/size and the downloadCode as mediaId', () => {
  const inbound = parseInbound(
    robotPayload({
      msgtype: 'file',
      text: undefined,
      content: JSON.stringify({ downloadCode: 'code_file_1', fileName: 'report.pdf', fileSize: 1234 }),
    }),
    { config: CONFIG },
  );
  assert.ok(inbound);
  assert.deepEqual(inbound.attachments, [
    { kind: 'file', name: 'report.pdf', size: 1234, mediaId: 'code_file_1' },
  ]);
});

test('audio message uses the speech recognition text', () => {
  const inbound = parseInbound(
    robotPayload({
      msgtype: 'audio',
      text: undefined,
      content: JSON.stringify({ downloadCode: 'code_audio_1', recognition: '明天几点开会' }),
    }),
    { config: CONFIG },
  );
  assert.ok(inbound);
  assert.equal(inbound.text, '明天几点开会');
  assert.deepEqual(inbound.attachments, [{ kind: 'audio', mediaId: 'code_audio_1' }]);
});

test('video message becomes a video attachment', () => {
  const inbound = parseInbound(
    robotPayload({
      msgtype: 'video',
      text: undefined,
      content: JSON.stringify({ downloadCode: 'code_video_1', videoDownloadCode: 'code_video_1' }),
    }),
    { config: CONFIG },
  );
  assert.ok(inbound);
  assert.deepEqual(inbound.attachments, [{ kind: 'video', mediaId: 'code_video_1' }]);
});

test('missing msgId falls back to a stable deterministic id', () => {
  const first = robotPayload({ msgId: undefined });
  const second = robotPayload({ msgId: undefined });
  const a = parseInbound(first, { config: CONFIG });
  const b = parseInbound(second, { config: CONFIG });
  assert.ok(a && b);
  assert.match(a.messageId, /^dt_[0-9a-f]{24}$/);
  assert.equal(a.messageId, b.messageId); // same payload redelivered -> same id

  const changed = parseInbound(robotPayload({ msgId: undefined, createAt: 1_700_000_000_001 }), { config: CONFIG });
  assert.ok(changed);
  assert.notEqual(changed.messageId, a.messageId); // distinct message -> distinct id
});

test('msgId takes precedence over the stream delivery id', () => {
  const inbound = parseInbound(robotPayload(), { config: CONFIG, streamMessageId: 'stream-msg-9' });
  assert.ok(inbound);
  assert.equal(inbound.messageId, 'msg-1001');
});

test('stream delivery id is used when the payload has no msgId', () => {
  const inbound = parseInbound(robotPayload({ msgId: undefined }), {
    config: CONFIG,
    streamMessageId: 'stream-msg-9',
  });
  assert.ok(inbound);
  assert.equal(inbound.messageId, 'stream-msg-9');
});

test('messages sent by the bot itself are ignored', () => {
  const echoed = dmPayload({ senderId: '$:LWCP_v1:$bot_user_id', senderStaffId: undefined });
  assert.equal(parseInbound(echoed, { config: CONFIG }), null);
});

test('unsupported message types without content are ignored', () => {
  assert.equal(parseInbound(robotPayload({ msgtype: 'actionCard', text: undefined, content: undefined }), { config: CONFIG }), null);
  assert.equal(parseInbound(null, { config: CONFIG }), null);
});

test('webhook fields are preserved on target.raw for the outbound path', () => {
  const inbound = parseInbound(
    robotPayload({ senderOpenDingTalkId: 'open_sender_1', sessionWebhook: 'https://example.test/hook?token=x' }),
    { config: CONFIG },
  );
  assert.ok(inbound);
  assert.equal(inbound.target.raw.sessionWebhook, 'https://example.test/hook?token=x');
  assert.equal(inbound.target.raw.senderOpenDingTalkId, 'open_sender_1');
});

test('helpers: conversation type/id, timestamp and mention/prefix parsing', () => {
  assert.equal(resolveConversationType({ conversationType: '2' }), 'group');
  assert.equal(resolveConversationType({ conversationType: '1' }), 'dm');
  assert.equal(resolveConversationType({}), 'dm');

  assert.equal(resolveConversationId({ conversationId: 'cid', senderStaffId: 's1' }, 'group'), 'cid');
  assert.equal(resolveConversationId({ conversationId: 'cid', senderStaffId: 's1' }, 'dm'), 's1');

  assert.equal(normalizeTimestamp(1_700_000_000, 0), 1_700_000_000_000); // seconds
  assert.equal(normalizeTimestamp(1_700_000_000_000, 0), 1_700_000_000_000); // ms
  assert.equal(normalizeTimestamp(undefined, 42), 42);

  assert.equal(detectMentioned({ atUsers: [{ dingtalkId: 'x' }] }, 'group'), true);
  assert.equal(detectMentioned({ atUsers: [] }, 'group'), false);
  assert.equal(detectMentioned({}, 'dm'), true);

  assert.equal(stripMentionPrefix('@机器人 你好'), '你好');
  assert.equal(stripMentionPrefix('  @机器人   你好  '), '你好');
  assert.equal(stripMentionPrefix('你好'), '你好');
  assert.equal(stripMentionPrefix('@'), '@');

  assert.equal(resolveMessageId({ msgId: 'm1' }, { conversationId: 'c', senderId: 's' }), 'm1');
});
