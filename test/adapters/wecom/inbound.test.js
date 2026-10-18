/**
 * WeCom inbound normalization tests: ws callback bodies and decrypted webhook
 * XML → InboundMessage contract (dm / group / mention / attachments / ids).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  detectMentioned,
  mapWebhookInbound,
  mapWsInbound,
  normalizeTimestamp,
  stripBotMention,
} from '../../../src/adapters/wecom/inbound.js';
import { parseWecomXml } from '../../../src/adapters/wecom/xml.js';

const ACCOUNT = 'wecom';

function wsText(overrides = {}) {
  return {
    msgid: 'msg-1001',
    aibotid: 'bot-1',
    chattype: 'single',
    from: { userid: 'zhangsan' },
    msgtype: 'text',
    text: { content: '你好' },
    create_time: 1_700_000_000,
    ...overrides,
  };
}

/** @param {string} xml */
function webhookMessage(xml) {
  const parsed = parseWecomXml(xml);
  assert.ok(parsed, 'fixture XML should parse');
  return parsed;
}

test('normalizeTimestamp converts seconds to ms and tolerates garbage', () => {
  assert.equal(normalizeTimestamp(1_700_000_000), 1_700_000_000_000);
  assert.equal(normalizeTimestamp('1700000000000'), 1_700_000_000_000);
  assert.ok(normalizeTimestamp('not-a-number') > 1_600_000_000_000);
});

test('mention helpers: configured bot name wins, no-name falls back to any @token', () => {
  const group = { conversationType: /** @type {'group'} */ ('group') };
  assert.equal(detectMentioned({ text: '@小助手 帮我查一下', ...group, botName: '小助手' }), true);
  assert.equal(detectMentioned({ text: '大家好', ...group, botName: '小助手' }), false);
  assert.equal(detectMentioned({ text: '大家好', ...group }), false);
  assert.equal(detectMentioned({ text: '@someone hi', ...group }), true);
  assert.equal(stripBotMention('@小助手 帮我查一下', { ...group, botName: '小助手' }), '帮我查一下');
  assert.equal(stripBotMention('@someone hi', group), 'hi');
  // DM text is never stripped.
  assert.equal(stripBotMention('@小助手 hi', { conversationType: 'dm', botName: '小助手' }), '@小助手 hi');
});

test('mapWsInbound maps a direct text message', () => {
  const inbound = mapWsInbound({ msg: wsText(), reqId: 'req-1', accountId: ACCOUNT, botName: '小助手' });
  assert.ok(inbound);
  assert.equal(inbound.channel, 'wecom');
  assert.equal(inbound.accountId, 'wecom');
  assert.equal(inbound.conversationId, 'zhangsan');
  assert.equal(inbound.conversationType, 'dm');
  assert.equal(inbound.messageId, 'msg-1001');
  assert.deepEqual(inbound.sender, { id: 'zhangsan' });
  assert.equal(inbound.text, '你好');
  assert.equal(inbound.mentioned, true); // DM is always mentioned
  assert.deepEqual(inbound.attachments, []);
  assert.equal(inbound.timestamp, 1_700_000_000_000);
  assert.equal(inbound.target.raw.reqId, 'req-1');
  assert.equal(inbound.target.raw.mode, 'ws');
  assert.equal(inbound.target.conversationId, 'zhangsan');
});

test('mapWsInbound maps a group message with @bot and strips the mention', () => {
  const msg = wsText({
    msgid: 'msg-2002',
    chattype: 'group',
    chatid: 'chat-9',
    text: { content: '@小助手 明天几点开会？' },
  });
  const inbound = mapWsInbound({ msg, reqId: 'req-2', accountId: ACCOUNT, botName: '小助手' });
  assert.ok(inbound);
  assert.equal(inbound.conversationType, 'group');
  assert.equal(inbound.conversationId, 'chat-9');
  assert.equal(inbound.mentioned, true);
  assert.equal(inbound.text, '明天几点开会？');
  assert.equal(inbound.target.raw.chatId, 'chat-9');
  assert.equal(inbound.target.raw.chatType, 'group');
});

test('mapWsInbound marks un-mentioned group messages as not mentioned', () => {
  const msg = wsText({ chattype: 'group', chatid: 'chat-9', text: { content: '随便聊聊' } });
  const inbound = mapWsInbound({ msg, reqId: 'req-3', accountId: ACCOUNT, botName: '小助手' });
  assert.ok(inbound);
  assert.equal(inbound.mentioned, false);
});

test('mapWsInbound maps image attachments with url + per-URL aeskey', () => {
  const msg = wsText({
    msgid: 'msg-image',
    msgtype: 'image',
    text: undefined,
    image: { url: 'https://example.invalid/img.enc', aeskey: 'A'.repeat(43) },
  });
  const inbound = mapWsInbound({ msg, reqId: 'req-4', accountId: ACCOUNT });
  assert.ok(inbound);
  assert.equal(inbound.text, '');
  assert.equal(inbound.attachments.length, 1);
  assert.equal(inbound.attachments[0].kind, 'image');
  assert.equal(inbound.attachments[0].url, 'https://example.invalid/img.enc');
  assert.equal(inbound.attachments[0].aesKey, 'A'.repeat(43));
});

test('mapWsInbound uses the voice transcription as text', () => {
  const msg = wsText({ msgid: 'msg-voice', msgtype: 'voice', text: undefined, voice: { content: '语音转文字内容' } });
  const inbound = mapWsInbound({ msg, reqId: 'req-5', accountId: ACCOUNT });
  assert.ok(inbound);
  assert.equal(inbound.text, '语音转文字内容');
  assert.deepEqual(inbound.attachments, []);
});

test('mapWsInbound generates a stable id when msgid is missing and skips events', () => {
  const msg = wsText({ msgid: undefined, text: { content: 'no id' } });
  const first = mapWsInbound({ msg, reqId: 'req-6', accountId: ACCOUNT });
  const second = mapWsInbound({ msg, reqId: 'req-7', accountId: ACCOUNT });
  assert.ok(first && second);
  assert.match(first.messageId, /^gen_[0-9a-f]{32}$/);
  assert.equal(first.messageId, second.messageId);
  assert.equal(mapWsInbound({ msg: { msgtype: 'event', from: { userid: 'u' } }, reqId: 'r', accountId: ACCOUNT }), null);
});

test('mapWebhookInbound maps a 自建应用 text callback', () => {
  const message = webhookMessage(`<xml>
    <ToUserName><![CDATA[ww-corp]]></ToUserName>
    <FromUserName><![CDATA[zhangsan]]></FromUserName>
    <CreateTime>1700000000</CreateTime>
    <MsgType><![CDATA[text]]></MsgType>
    <Content><![CDATA[你好，自建应用]]></Content>
    <MsgId>9000000000001</MsgId>
    <AgentID>1000002</AgentID>
  </xml>`);
  const inbound = mapWebhookInbound({ message, accountId: ACCOUNT, botName: '小助手' });
  assert.ok(inbound);
  assert.equal(inbound.conversationType, 'dm');
  assert.equal(inbound.conversationId, 'zhangsan');
  assert.equal(inbound.messageId, '9000000000001');
  assert.equal(inbound.text, '你好，自建应用');
  assert.equal(inbound.mentioned, true);
  assert.equal(inbound.timestamp, 1_700_000_000_000);
  assert.equal(inbound.target.raw.mode, 'webhook');
  assert.equal(inbound.target.raw.fromUserName, 'zhangsan');
  assert.equal(inbound.target.raw.agentId, '1000002');
});

test('mapWebhookInbound maps voice (Recognition), image (PicUrl/MediaId) and ignores events', () => {
  const voice = mapWebhookInbound({
    message: webhookMessage(`<xml>
      <FromUserName><![CDATA[zhangsan]]></FromUserName>
      <CreateTime>1700000000</CreateTime>
      <MsgType><![CDATA[voice]]></MsgType>
      <MediaId><![CDATA[media-voice]]></MediaId>
      <Format><![CDATA[amr]]></Format>
      <Recognition><![CDATA[识别出来的文字]]></Recognition>
      <MsgId>9001</MsgId>
    </xml>`),
    accountId: ACCOUNT,
  });
  assert.ok(voice);
  assert.equal(voice.text, '识别出来的文字');
  assert.equal(voice.attachments[0].kind, 'audio');
  assert.equal(voice.attachments[0].mediaId, 'media-voice');

  const image = mapWebhookInbound({
    message: webhookMessage(`<xml>
      <FromUserName><![CDATA[zhangsan]]></FromUserName>
      <CreateTime>1700000000</CreateTime>
      <MsgType><![CDATA[image]]></MsgType>
      <PicUrl><![CDATA[https://example.invalid/pic.jpg]]></PicUrl>
      <MediaId><![CDATA[media-image]]></MediaId>
      <MsgId>9002</MsgId>
    </xml>`),
    accountId: ACCOUNT,
  });
  assert.ok(image);
  assert.equal(image.text, '');
  assert.equal(image.attachments[0].kind, 'image');
  assert.equal(image.attachments[0].url, 'https://example.invalid/pic.jpg');
  assert.equal(image.attachments[0].picUrl, 'https://example.invalid/pic.jpg');
  assert.equal(image.attachments[0].mediaId, 'media-image');

  const event = mapWebhookInbound({
    message: webhookMessage(`<xml>
      <FromUserName><![CDATA[zhangsan]]></FromUserName>
      <CreateTime>1700000000</CreateTime>
      <MsgType><![CDATA[event]]></MsgType>
      <Event><![CDATA[subscribe]]></Event>
    </xml>`),
    accountId: ACCOUNT,
  });
  assert.equal(event, null);
});

test('mapWebhookInbound maps compatible 群机器人 XML with mention stripping', () => {
  const message = webhookMessage(`<xml>
    <From><UserId><![CDATA[zhangsan]]></UserId></From>
    <ChatId><![CDATA[chat-7]]></ChatId>
    <ChatType><![CDATA[group]]></ChatType>
    <MsgType><![CDATA[text]]></MsgType>
    <Text><Content><![CDATA[@小助手 看下这个]]></Content></Text>
    <MsgId>9100</MsgId>
    <WebhookUrl><![CDATA[https://example.invalid/hook]]></WebhookUrl>
  </xml>`);
  const inbound = mapWebhookInbound({ message, accountId: ACCOUNT, botName: '小助手' });
  assert.ok(inbound);
  assert.equal(inbound.conversationType, 'group');
  assert.equal(inbound.conversationId, 'chat-7');
  assert.equal(inbound.sender.id, 'zhangsan');
  assert.equal(inbound.mentioned, true);
  assert.equal(inbound.text, '看下这个');
  assert.equal(inbound.target.raw.chatId, 'chat-7');
  assert.equal(inbound.target.raw.responseUrl, 'https://example.invalid/hook');
});
