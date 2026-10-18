/**
 * Pure inbound mapping: text/image/voice/file/video items, bot echo filtering,
 * stable message ids, context-token scrubbing.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  extractText,
  mapInbound,
  mapItemAttachment,
  resolveMessageId,
  stableHash,
} from '../../../src/adapters/weixin/inbound.js';

const ACCOUNT = { accountId: 'weixin', cdnBaseUrl: 'https://novac2c.cdn.weixin.qq.com/c2c' };

/** Base user message. */
function message(overrides = {}) {
  return {
    seq: 1,
    message_id: 1_234_567,
    from_user_id: 'wxid-alice@im.wechat',
    to_user_id: 'bot@im.bot',
    create_time_ms: 1_700_000_000_000,
    message_type: 1,
    message_state: 2,
    context_token: 'ctx-secret-token',
    item_list: [{ type: 1, text_item: { text: '你好' } }],
    ...overrides,
  };
}

test('maps a user text message to a dm InboundMessage keyed by from_user_id', () => {
  const inbound = mapInbound(message(), ACCOUNT);
  assert.ok(inbound);
  assert.equal(inbound.channel, 'weixin');
  assert.equal(inbound.accountId, 'weixin');
  assert.equal(inbound.conversationId, 'wxid-alice@im.wechat');
  assert.equal(inbound.conversationType, 'dm');
  assert.equal(inbound.messageId, 'wx-1234567');
  assert.deepEqual(inbound.sender, { id: 'wxid-alice@im.wechat' });
  assert.equal(inbound.text, '你好');
  assert.equal(inbound.mentioned, true);
  assert.deepEqual(inbound.attachments, []);
  assert.equal(inbound.timestamp, 1_700_000_000_000);
  assert.equal(inbound.target.channel, 'weixin');
  assert.equal(inbound.target.accountId, 'weixin');
  assert.equal(inbound.target.conversationId, 'wxid-alice@im.wechat');
  assert.equal(inbound.target.conversationType, 'dm');
  assert.equal(inbound.target.replyToMessageId, 'wx-1234567');
});

test('drops bot echoes (message_type 2) and messages without a type', () => {
  assert.equal(mapInbound(message({ message_type: 2 }), ACCOUNT), null);
  assert.equal(mapInbound(message({ message_type: undefined }), ACCOUNT), null);
  assert.equal(mapInbound(message({ message_type: 0 }), ACCOUNT), null);
});

test('drops messages without from_user_id', () => {
  assert.equal(mapInbound(message({ from_user_id: '' }), ACCOUNT), null);
  assert.equal(mapInbound(message({ from_user_id: 42 }), ACCOUNT), null);
});

test('message id is prefixed and stable for numeric, string and missing ids', () => {
  assert.equal(resolveMessageId({ message_id: 42 }, 'u'), 'wx-42');
  assert.equal(resolveMessageId({ message_id: 'abc-def' }, 'u'), 'wx-abc-def');
  const seed = { from_user_id: 'u', create_time_ms: 123, seq: 7 };
  const first = resolveMessageId(seed, 'u');
  const second = resolveMessageId({ ...seed }, 'u');
  assert.equal(first, second);
  assert.match(first, /^wx-[0-9a-f]{8}$/);
  assert.notEqual(resolveMessageId({ ...seed, seq: 8 }, 'u'), first);
  assert.equal(stableHash('same'), stableHash('same'));
  assert.notEqual(stableHash('a'), stableHash('b'));
});

test('joins multiple text items with newlines', () => {
  const inbound = mapInbound(
    message({
      item_list: [
        { type: 1, text_item: { text: '第一行' } },
        { type: 1, text_item: { text: '第二行' } },
      ],
    }),
    ACCOUNT,
  );
  assert.ok(inbound);
  assert.equal(inbound.text, '第一行\n第二行');
});

test('extracts the voice transcript as text when there is no text item', () => {
  const items = [
    { type: 3, voice_item: { text: '语音转写内容', playtime: 3500, media: { full_url: 'https://cdn/voice' } } },
  ];
  assert.equal(extractText(items), '语音转写内容');
});

test('maps an image with full_url to an image attachment', () => {
  const inbound = mapInbound(
    message({
      item_list: [
        {
          type: 2,
          image_item: {
            media: {
              full_url: 'https://cdn.example/full-image',
              encrypt_query_param: 'enc-param',
              aes_key: 'base64-key',
              encrypt_type: 1,
            },
            aeskey: 'hex-aes-key',
            mid_size: 2048,
          },
        },
      ],
    }),
    ACCOUNT,
  );
  assert.ok(inbound);
  assert.equal(inbound.text, '');
  assert.equal(inbound.attachments.length, 1);
  const [attachment] = inbound.attachments;
  assert.equal(attachment.kind, 'image');
  assert.equal(attachment.url, 'https://cdn.example/full-image');
  assert.equal(attachment.size, 2048);
  // image_item.aeskey takes precedence over media.aes_key
  assert.equal(attachment.aesKey, 'hex-aes-key');
  assert.equal(attachment.mediaId, 'enc-param');
  assert.equal(attachment.raw.type, 2);
});

test('builds a CDN download URL when image media has only encrypt_query_param', () => {
  const inbound = mapInbound(
    message({
      item_list: [
        {
          type: 2,
          image_item: {
            media: { encrypt_query_param: 'a+b/c=', aes_key: 'k' },
          },
        },
      ],
    }),
    ACCOUNT,
  );
  assert.ok(inbound);
  assert.equal(
    inbound.attachments[0].url,
    'https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=a%2Bb%2Fc%3D',
  );
  assert.equal(inbound.attachments[0].mediaId, 'a+b/c=');
  assert.equal(inbound.attachments[0].aesKey, 'k');
});

test('falls back to image_item.url when no media reference exists', () => {
  const inbound = mapInbound(
    message({ item_list: [{ type: 2, image_item: { url: 'https://cdn.example/legacy-image' } }] }),
    ACCOUNT,
  );
  assert.ok(inbound);
  assert.equal(inbound.attachments[0].url, 'https://cdn.example/legacy-image');
});

test('maps voice (with transcript) to text plus an audio attachment', () => {
  const inbound = mapInbound(
    message({
      item_list: [
        {
          type: 3,
          voice_item: {
            text: '帮我查一下明天的天气',
            playtime: 4200,
            media: { full_url: 'https://cdn.example/voice.silk' },
          },
        },
      ],
    }),
    ACCOUNT,
  );
  assert.ok(inbound);
  assert.equal(inbound.text, '帮我查一下明天的天气');
  assert.equal(inbound.attachments.length, 1);
  assert.equal(inbound.attachments[0].kind, 'audio');
  assert.equal(inbound.attachments[0].url, 'https://cdn.example/voice.silk');
  assert.equal(inbound.attachments[0].durationMs, 4200);
});

test('maps a file item with name, size and CDN URL', () => {
  const inbound = mapInbound(
    message({
      item_list: [
        {
          type: 4,
          file_item: {
            file_name: '报告.pdf',
            len: '10240',
            media: { encrypt_query_param: 'file-param' },
          },
        },
      ],
    }),
    ACCOUNT,
  );
  assert.ok(inbound);
  assert.equal(inbound.attachments.length, 1);
  const [attachment] = inbound.attachments;
  assert.equal(attachment.kind, 'file');
  assert.equal(attachment.name, '报告.pdf');
  assert.equal(attachment.size, 10240);
  assert.match(attachment.url, /file-param/);
});

test('maps a video item with size and duration', () => {
  const inbound = mapInbound(
    message({
      item_list: [
        {
          type: 5,
          video_item: {
            video_size: 40960,
            play_length: 8000,
            media: { full_url: 'https://cdn.example/video.mp4' },
          },
        },
      ],
    }),
    ACCOUNT,
  );
  assert.ok(inbound);
  const [attachment] = inbound.attachments;
  assert.equal(attachment.kind, 'video');
  assert.equal(attachment.size, 40960);
  assert.equal(attachment.durationMs, 8000);
});

test('ignores tool-call items and returns null when nothing else remains', () => {
  const inbound = mapInbound(
    message({
      item_list: [
        { type: 11, tool_call_start_item: { tool_name: 'search', tool_call_id: 'call-1' } },
        { type: 12, tool_call_result_item: { tool_call_id: 'call-1', status: 'ok' } },
      ],
    }),
    ACCOUNT,
  );
  assert.equal(inbound, null);
  assert.equal(mapItemAttachment({ type: 11 }), null);
  assert.equal(mapItemAttachment({ type: 99 }), null);
});

test('unknown item types do not prevent text mapping', () => {
  const inbound = mapInbound(
    message({
      item_list: [
        { type: 99, weird_item: {} },
        { type: 1, text_item: { text: '仍然有文本' } },
      ],
    }),
    ACCOUNT,
  );
  assert.ok(inbound);
  assert.equal(inbound.text, '仍然有文本');
});

test('a message with empty item_list maps to null', () => {
  assert.equal(mapInbound(message({ item_list: [] }), ACCOUNT), null);
  assert.equal(mapInbound(message({ item_list: undefined }), ACCOUNT), null);
});

test('context_token never appears in raw/target.raw', () => {
  const inbound = mapInbound(message(), ACCOUNT);
  assert.ok(inbound);
  assert.equal(JSON.stringify(inbound.raw).includes('ctx-secret-token'), false);
  assert.equal(JSON.stringify(inbound.target.raw).includes('ctx-secret-token'), false);
});

test('timestamp falls back to now() when create_time_ms is missing', () => {
  const inbound = mapInbound(message({ create_time_ms: undefined }), { ...ACCOUNT, now: 1_600_000_000_000 });
  assert.ok(inbound);
  assert.equal(inbound.timestamp, 1_600_000_000_000);
});

test('multiple attachments map in order with their kinds', () => {
  const inbound = mapInbound(
    message({
      item_list: [
        { type: 1, text_item: { text: '看看这些' } },
        { type: 2, image_item: { media: { full_url: 'https://cdn/1' } } },
        { type: 4, file_item: { file_name: 'a.txt', media: { full_url: 'https://cdn/2' } } },
      ],
    }),
    ACCOUNT,
  );
  assert.ok(inbound);
  assert.equal(inbound.text, '看看这些');
  assert.deepEqual(inbound.attachments.map((item) => item.kind), ['image', 'file']);
  assert.equal(inbound.attachments[1].name, 'a.txt');
});

test('size fields accept numeric strings and ignore garbage', () => {
  const file = mapInbound(
    message({ item_list: [{ type: 4, file_item: { len: 'not-a-number', media: { full_url: 'https://cdn/f' } } }] }),
    ACCOUNT,
  );
  assert.ok(file);
  assert.equal(file.attachments[0].size, undefined);

  const numeric = mapInbound(
    message({ item_list: [{ type: 4, file_item: { len: 42, media: { full_url: 'https://cdn/f' } } }] }),
    ACCOUNT,
  );
  assert.ok(numeric);
  assert.equal(numeric.attachments[0].size, 42);
});
