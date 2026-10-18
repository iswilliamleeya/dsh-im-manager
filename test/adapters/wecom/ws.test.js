/**
 * WeCom ws-mode tests: pure frame builders/parsers plus an end-to-end adapter
 * run against a fake local WebSocket server (no real 企业微信).
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';

import { WebSocket, WebSocketServer } from 'ws';

import { createWecomAdapter } from '../../../src/adapters/wecom/index.js';
import {
  buildPingFrame,
  buildSendMarkdownFrame,
  buildStreamReplyFrame,
  buildSubscribeFrame,
  isDisconnectedEvent,
  normalizeWsCallback,
  parseWsFrame,
  WsCmd,
} from '../../../src/adapters/wecom/ws-protocol.js';

const noopLog = { debug() {}, info() {}, warn() {}, error() {}, child() { return noopLog; } };

// ---------------------------------------------------------------------------
// Pure protocol tests
// ---------------------------------------------------------------------------

test('subscribe/ping frame builders use the documented shape and req_id prefixes', () => {
  const subscribe = buildSubscribeFrame({ botId: 'bot-1', secret: 'sec-1' });
  assert.equal(subscribe.cmd, WsCmd.SUBSCRIBE);
  assert.equal(subscribe.body.bot_id, 'bot-1');
  assert.equal(subscribe.body.secret, 'sec-1');
  assert.match(subscribe.headers.req_id, /^aibot_subscribe_\d+_[A-Za-z0-9]+$/);

  const ping = buildPingFrame();
  assert.equal(ping.cmd, 'ping');
  assert.match(ping.headers.req_id, /^ping_\d+_[A-Za-z0-9]+$/);
});

test('stream reply frame targets the inbound req_id and can be a final message', () => {
  const frame = buildStreamReplyFrame({
    reqId: 'req-abc',
    streamId: 'stream-1',
    content: '**bold** 回复',
    finish: true,
  });
  assert.equal(frame.cmd, 'aibot_respond_msg');
  assert.equal(frame.headers.req_id, 'req-abc');
  assert.deepEqual(frame.body, {
    msgtype: 'stream',
    stream: { id: 'stream-1', finish: true, content: '**bold** 回复' },
  });

  const openFrame = buildStreamReplyFrame({ reqId: 'req-abc', streamId: 'stream-1', finish: false });
  assert.equal(openFrame.body.stream.finish, false);
  assert.equal('content' in openFrame.body.stream, false);
});

test('stream reply content is truncated to 20480 UTF-8 bytes without splitting code points', () => {
  const frame = buildStreamReplyFrame({
    reqId: 'req-big',
    streamId: 's',
    content: '你'.repeat(10_000),
  });
  const content = frame.body.stream.content;
  assert.ok(Buffer.byteLength(content, 'utf8') <= 20_480);
  assert.ok(content.length > 6_000);
  assert.ok(content.endsWith('你'));
});

test('proactive send uses aibot_send_msg with markdown body and chatid', () => {
  const frame = buildSendMarkdownFrame({ chatId: 'chat-1', content: 'hi' });
  assert.equal(frame.cmd, 'aibot_send_msg');
  assert.match(frame.headers.req_id, /^aibot_send_msg_/);
  assert.deepEqual(frame.body, { chatid: 'chat-1', msgtype: 'markdown', markdown: { content: 'hi' } });
});

test('parseWsFrame strips control characters and rejects invalid frames', () => {
  const frame = parseWsFrame('\u0000{"cmd":"aibot_msg_callback","headers":{"req_id":"r"}}\u0007');
  assert.equal(frame.cmd, 'aibot_msg_callback');
  assert.equal(parseWsFrame('not json'), null);
  assert.equal(parseWsFrame(''), null);
});

test('normalizeWsCallback splits message and event callbacks', () => {
  const message = normalizeWsCallback({
    cmd: 'aibot_msg_callback',
    headers: { req_id: 'req-1' },
    body: { msgid: 'm1', msgtype: 'text' },
  });
  assert.ok(message);
  assert.equal(message.kind, 'message');
  assert.equal(message.reqId, 'req-1');
  assert.equal(message.msgId, 'm1');

  const event = normalizeWsCallback({
    cmd: 'aibot_event_callback',
    headers: { req_id: 'req-2' },
    body: { event: { eventtype: 'disconnected_event' } },
  });
  assert.ok(event);
  assert.equal(event.kind, 'event');
  assert.equal(event.eventType, 'disconnected_event');
  assert.equal(isDisconnectedEvent({
    cmd: 'aibot_event_callback',
    body: { event: { eventtype: 'disconnected_event' } },
  }), true);
  assert.equal(normalizeWsCallback({ cmd: 'unknown', headers: { req_id: 'r' }, body: {} }), null);
});

// ---------------------------------------------------------------------------
// Fake platform helpers
// ---------------------------------------------------------------------------

/**
 * @param {(socket: WebSocket, context: { connections: number, close: () => void }) => void} onConnection
 */
async function startFakePlatform(onConnection) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(wss, 'listening');
  const address = wss.address();
  assert.ok(address && typeof address === 'object');
  /** @type {Set<WebSocket>} */
  const sockets = new Set();
  let connections = 0;
  wss.on('connection', (socket) => {
    sockets.add(socket);
    connections += 1;
    socket.addEventListener('close', () => sockets.delete(socket));
    onConnection(socket, { connections, close: () => socket.close(1001, 'test-close') });
  });
  return {
    port: address.port,
    get connections() {
      return connections;
    },
    /** @param {WebSocket} socket @returns {Record<string, any>} */
    close: async () => {
      for (const socket of sockets) {
        try {
          socket.terminate();
        } catch {
          // ignore
        }
      }
      await new Promise((resolve) => wss.close(() => resolve()));
    },
  };
}

/**
 * @param {{ mode?: string, wsUrl: string, extra?: Record<string, any> }} options
 */
function makeWsConfig(options) {
  return {
    mode: options.mode ?? 'ws',
    accountId: 'wecom',
    botId: 'bot-test',
    secret: 'secret-test',
    wsUrl: options.wsUrl,
    heartbeatIntervalMs: 60_000,
    reconnectInitialDelayMs: 20,
    reconnectMaxDelayMs: 100,
    authTimeoutMs: 2_000,
    replyAckTimeoutMs: 1_000,
    botName: '小助手',
    ...options.extra,
  };
}

/**
 * @param {{ config: Record<string, any>, emit: (inbound: any) => Promise<void> }} options
 */
function makeCtx(options) {
  const controller = new AbortController();
  return {
    config: options.config,
    emit: options.emit,
    log: noopLog,
    signal: controller.signal,
    http: {
      route() {
        throw new Error('ws mode must not register HTTP routes');
      },
      publicUrl() {
        return null;
      },
    },
    stateDir: '/tmp/wecom-test-state',
    secret: () => undefined,
    controller,
  };
}

/**
 * @param {() => boolean | Promise<boolean>} predicate
 * @param {{ timeoutMs?: number, label?: string }} [options]
 */
async function waitFor(predicate, options = {}) {
  const timeoutMs = options.timeoutMs ?? 3_000;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${options.label ?? 'condition'}`);
}

// ---------------------------------------------------------------------------
// End-to-end against the fake platform
// ---------------------------------------------------------------------------

test('ws mode: handshake, inbound callback, reply over the same req_id', async (t) => {
  /** @type {Record<string, any>[]} */
  const received = [];
  const platform = await startFakePlatform((socket) => {
    socket.addEventListener('message', (event) => {
      const frame = JSON.parse(String(event.data));
      received.push(frame);
      if (frame.cmd === WsCmd.SUBSCRIBE) {
        socket.send(JSON.stringify({ headers: { req_id: frame.headers.req_id }, errcode: 0, errmsg: 'ok' }));
        const callbackFrame = {
          cmd: WsCmd.CALLBACK,
          headers: { req_id: 'req-msg-1' },
          body: {
            msgid: 'm1',
            msgtype: 'text',
            chattype: 'single',
            from: { userid: 'u1' },
            text: { content: 'hello gateway' },
            create_time: 1_700_000_000,
          },
        };
        setTimeout(() => socket.send(JSON.stringify(callbackFrame)), 10);
        // Same msgid again: the platform may re-deliver; adapter must emit once.
        setTimeout(() => socket.send(JSON.stringify(callbackFrame)), 25);
      } else if (frame.cmd === WsCmd.RESPONSE) {
        // Platform ack for the reply.
        socket.send(JSON.stringify({ headers: { req_id: frame.headers.req_id }, errcode: 0, errmsg: 'ok' }));
      }
    });
  });
  t.after(() => platform.close());

  /** @type {any[]} */
  const emitted = [];
  const adapter = createWecomAdapter({ webSocketFactory: ({ url }) => new WebSocket(url) });
  const ctx = makeCtx({
    config: makeWsConfig({ wsUrl: `ws://127.0.0.1:${platform.port}` }),
    emit: async (inbound) => emitted.push(inbound),
  });
  await adapter.start(ctx);
  t.after(() => adapter.stop());

  await waitFor(() => emitted.length === 1, { label: 'inbound emit' });
  assert.equal(emitted[0].text, 'hello gateway');
  assert.equal(emitted[0].sender.id, 'u1');
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(emitted.length, 1, 'duplicate platform re-delivery must be dropped');

  const health = await adapter.health();
  assert.equal(health.state, 'connected');

  const result = await adapter.send(emitted[0].target, { text: '收到', format: 'plain' });
  assert.deepEqual(result, {});

  const reply = received.find((frame) => frame.cmd === WsCmd.RESPONSE);
  assert.ok(reply, 'expected an aibot_respond_msg frame');
  assert.equal(reply.headers.req_id, 'req-msg-1');
  assert.equal(reply.body.msgtype, 'stream');
  assert.equal(reply.body.stream.finish, true);
  assert.equal(reply.body.stream.content, '收到');
});

test('ws mode: heartbeat pings are sent and acked', async (t) => {
  /** @type {Record<string, any>[]} */
  const received = [];
  const platform = await startFakePlatform((socket) => {
    socket.addEventListener('message', (event) => {
      const frame = JSON.parse(String(event.data));
      received.push(frame);
      if (frame.cmd === WsCmd.SUBSCRIBE || frame.cmd === WsCmd.HEARTBEAT) {
        socket.send(JSON.stringify({ headers: { req_id: frame.headers.req_id }, errcode: 0, errmsg: 'ok' }));
      }
    });
  });
  t.after(() => platform.close());

  const adapter = createWecomAdapter({ webSocketFactory: ({ url }) => new WebSocket(url) });
  const ctx = makeCtx({
    config: makeWsConfig({
      wsUrl: `ws://127.0.0.1:${platform.port}`,
      extra: { heartbeatIntervalMs: 40 },
    }),
    emit: async () => {},
  });
  await adapter.start(ctx);
  t.after(() => adapter.stop());

  await waitFor(() => received.filter((frame) => frame.cmd === WsCmd.HEARTBEAT).length >= 2, {
    label: 'heartbeat pings',
  });
  const pings = received.filter((frame) => frame.cmd === WsCmd.HEARTBEAT);
  assert.match(pings[0].headers.req_id, /^ping_/);
  assert.equal((await adapter.health()).state, 'connected');
});

test('ws mode: reconnects with backoff after the socket drops', async (t) => {
  /** @type {any[]} */
  const emitted = [];
  /** @type {Record<string, any>[]} */
  const subscribes = [];
  const platform = await startFakePlatform((socket, context) => {
    socket.addEventListener('message', (event) => {
      const frame = JSON.parse(String(event.data));
      if (frame.cmd !== WsCmd.SUBSCRIBE) return;
      subscribes.push(frame);
      socket.send(JSON.stringify({ headers: { req_id: frame.headers.req_id }, errcode: 0, errmsg: 'ok' }));
      if (context.connections === 1) {
        // Drop the first connection shortly after auth to force a reconnect.
        setTimeout(() => socket.close(1011, 'drop-for-test'), 20);
      } else {
        setTimeout(() => {
          socket.send(JSON.stringify({
            cmd: WsCmd.CALLBACK,
            headers: { req_id: 'req-after-reconnect' },
            body: { msgid: 'm2', msgtype: 'text', chattype: 'single', from: { userid: 'u2' }, text: { content: 'back' } },
          }));
        }, 10);
      }
    });
  });
  t.after(() => platform.close());

  const adapter = createWecomAdapter({ webSocketFactory: ({ url }) => new WebSocket(url) });
  const ctx = makeCtx({
    config: makeWsConfig({ wsUrl: `ws://127.0.0.1:${platform.port}` }),
    emit: async (inbound) => emitted.push(inbound),
  });
  await adapter.start(ctx);
  t.after(() => adapter.stop());

  await waitFor(() => platform.connections >= 2, { label: 'reconnection' });
  await waitFor(() => emitted.length >= 1, { label: 'inbound after reconnect' });
  assert.equal(emitted[0].text, 'back');
  assert.equal(subscribes.length >= 2, true);
  assert.equal((await adapter.health()).state, 'connected');
});

test('ws mode: disconnected_event (kicked) stops reconnecting by default', async (t) => {
  const platform = await startFakePlatform((socket) => {
    socket.addEventListener('message', (event) => {
      const frame = JSON.parse(String(event.data));
      if (frame.cmd !== WsCmd.SUBSCRIBE) return;
      socket.send(JSON.stringify({ headers: { req_id: frame.headers.req_id }, errcode: 0, errmsg: 'ok' }));
      setTimeout(() => {
        socket.send(JSON.stringify({
          cmd: WsCmd.EVENT_CALLBACK,
          headers: { req_id: 'req-event' },
          body: { event: { eventtype: 'disconnected_event' }, from: { userid: 'u1' } },
        }));
      }, 10);
    });
  });
  t.after(() => platform.close());

  const adapter = createWecomAdapter({ webSocketFactory: ({ url }) => new WebSocket(url) });
  const ctx = makeCtx({
    config: makeWsConfig({ wsUrl: `ws://127.0.0.1:${platform.port}` }),
    emit: async () => {},
  });
  await adapter.start(ctx);
  t.after(() => adapter.stop());

  await waitFor(() => platform.connections === 1, { label: 'first connection' });
  await waitFor(async () => (await adapter.health()).state === 'disconnected', { label: 'kicked health' });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(platform.connections, 1, 'must not fight another instance for the connection');
});

test('ws mode: send without a reply context rejects with a clear error', async (t) => {
  const platform = await startFakePlatform((socket) => {
    socket.addEventListener('message', (event) => {
      const frame = JSON.parse(String(event.data));
      if (frame.cmd === WsCmd.SUBSCRIBE) {
        socket.send(JSON.stringify({ headers: { req_id: frame.headers.req_id }, errcode: 0, errmsg: 'ok' }));
      }
    });
  });
  t.after(() => platform.close());

  const adapter = createWecomAdapter({ webSocketFactory: ({ url }) => new WebSocket(url) });
  const ctx = makeCtx({
    config: makeWsConfig({ wsUrl: `ws://127.0.0.1:${platform.port}` }),
    emit: async () => {},
  });
  await adapter.start(ctx);
  t.after(() => adapter.stop());

  await waitFor(async () => (await adapter.health()).state === 'connected', { label: 'connected' });
  await assert.rejects(
    adapter.send(
      { channel: 'wecom', accountId: 'wecom', conversationId: 'u1', conversationType: 'dm', raw: {} },
      { text: 'no context' },
    ),
    /no reply context/,
  );
});
