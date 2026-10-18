/**
 * getUpdates loop: cursor commit ordering, context-token capture, replay on
 * emit failure, exponential backoff, -14 terminal handling, abort.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { StaleTokenError } from '../../../src/adapters/weixin/client.js';
import { createWeixinMonitor } from '../../../src/adapters/weixin/monitor.js';
import { createContextTokenStore } from '../../../src/adapters/weixin/storage.js';
import {
  cleanupDir,
  makeTempDir,
  pendingUntilAborted,
  textMessage,
  waitFor,
} from './helpers.js';

const CDN = 'https://novac2c.cdn.weixin.qq.com/c2c';

/** @param {number} baseDelayMs */
function monitorConfig(baseDelayMs = 30) {
  return {
    accountId: 'weixin',
    cdnBaseUrl: CDN,
    requestTimeoutMs: 5_000,
    longPollTimeoutMs: 35_000,
    reconnect: { enabled: true, baseDelayMs, maxDelayMs: 500 },
  };
}

/**
 * Fake ILinkClient whose `getUpdates` follows a script; once the script is
 * exhausted it stays pending until aborted (long-poll semantics).
 * @param {any[]} script
 */
function makeFakeClient(script = []) {
  const calls = { getUpdates: [], notifyStart: 0, notifyStop: 0 };
  const client = {
    async notifyStart() {
      calls.notifyStart += 1;
      return {};
    },
    async notifyStop() {
      calls.notifyStop += 1;
      return {};
    },
    async getUpdates(params) {
      calls.getUpdates.push(params);
      const step = script.length > 0 ? script.shift() : undefined;
      if (step instanceof Error) throw step;
      if (step !== undefined) return step;
      return pendingUntilAborted({ signal: params?.signal });
    },
  };
  return { client, calls };
}

test('processes a round, emits, persists cursor + context token, then polls with the cursor', async () => {
  const dir = makeTempDir();
  const contextTokens = createContextTokenStore({ file: join(dir, 'context-tokens.json') });
  const rawMessage = textMessage({ message_id: 7001, context_token: 'ctx-abc' });
  const { client, calls } = makeFakeClient([
    { ret: 0, msgs: [rawMessage], get_updates_buf: 'cursor-1', longpolling_timeout_ms: 4000 },
  ]);
  const emitted = [];
  const changes = [];
  const monitor = createWeixinMonitor({
    client,
    stateDir: dir,
    config: monitorConfig(),
    log: { debug() {}, info() {}, warn() {}, error() {} },
    emit: async (inbound) => emitted.push(inbound),
    contextTokens,
    ilinkBotId: 'bot-abc@im.bot',
    onConnectionChange: (change) => changes.push(change),
  });
  try {
    await monitor.start();
    await waitFor(() => emitted.length === 1, { label: 'first emit' });
    assert.equal(emitted[0].messageId, 'wx-7001');
    assert.equal(emitted[0].text, '你好，帮我看看这个报错');
    await waitFor(() => calls.getUpdates.length >= 2, { label: 'second getUpdates' });

    // Cursor is committed only after the round succeeds, and passed on next call.
    assert.equal(calls.getUpdates[0].getUpdatesBuf, '');
    assert.equal(calls.getUpdates[1].getUpdatesBuf, 'cursor-1');
    // Server-suggested long-poll timeout is adopted for the next request.
    assert.equal(calls.getUpdates[1].longPollTimeoutMs, 4000);

    const cursorFile = JSON.parse(readFileSync(join(dir, 'cursor.json'), 'utf8'));
    assert.deepEqual(cursorFile, {
      version: 1,
      ilinkBotId: 'bot-abc@im.bot',
      getUpdatesBuf: 'cursor-1',
      updatedAt: cursorFile.updatedAt,
    });
    assert.ok(Number.isFinite(cursorFile.updatedAt));

    // context_token is persisted for the reply path, not kept in raw.
    assert.equal(contextTokens.get('wxid-alice@im.wechat'), 'ctx-abc');
    const tokenFile = JSON.parse(readFileSync(join(dir, 'context-tokens.json'), 'utf8'));
    assert.equal(tokenFile.tokens['wxid-alice@im.wechat'].token, 'ctx-abc');
    assert.equal(JSON.stringify(emitted[0].raw).includes('ctx-abc'), false);

    assert.ok(changes.some((change) => change.state === 'connected'));
    assert.equal(monitor.health.state, 'connected');
  } finally {
    await monitor.stop();
    cleanupDir(dir);
  }
});

test('ignores bot echoes but still advances the cursor', async () => {
  const dir = makeTempDir();
  const { client, calls } = makeFakeClient([
    {
      ret: 0,
      msgs: [textMessage({ message_type: 2, message_id: 1 }), { message_id: 2, message_type: 2, item_list: [] }],
      get_updates_buf: 'cursor-bot',
    },
  ]);
  const emitted = [];
  const monitor = createWeixinMonitor({
    client,
    stateDir: dir,
    config: monitorConfig(),
    emit: async (inbound) => emitted.push(inbound),
    ilinkBotId: 'bot-1',
  });
  try {
    await monitor.start();
    await waitFor(() => calls.getUpdates.length >= 2, { label: 'cursor committed' });
    assert.equal(emitted.length, 0);
    const cursorFile = JSON.parse(readFileSync(join(dir, 'cursor.json'), 'utf8'));
    assert.equal(cursorFile.getUpdatesBuf, 'cursor-bot');
  } finally {
    await monitor.stop();
    cleanupDir(dir);
  }
});

test('a stale token (-14) stops the loop and surfaces a re-login hint', async () => {
  const dir = makeTempDir();
  const { client, calls } = makeFakeClient([new StaleTokenError('getUpdates')]);
  let staleHook = 0;
  const monitor = createWeixinMonitor({
    client,
    stateDir: dir,
    config: monitorConfig(),
    emit: async () => {},
    ilinkBotId: 'bot-1',
    onStaleToken: () => {
      staleHook += 1;
    },
  });
  try {
    await monitor.start();
    await waitFor(() => monitor.staleToken, { label: 'stale token' });
    assert.equal(monitor.health.state, 'disconnected');
    assert.match(monitor.health.detail, /-14/);
    assert.equal(staleHook, 1);
    assert.equal(calls.getUpdates.length, 1);
    assert.equal(monitor.running, false);
  } finally {
    await monitor.stop();
    cleanupDir(dir);
  }
  assert.equal(calls.notifyStop, 1);
});

test('retries with exponential backoff and then recovers', async () => {
  const dir = makeTempDir();
  const delays = [];
  const { client, calls } = makeFakeClient([
    new Error('network down'),
    new Error('network down again'),
    new Error('still down'),
    { ret: 0, msgs: [], get_updates_buf: '', longpolling_timeout_ms: 3000 },
  ]);
  const monitor = createWeixinMonitor({
    client,
    stateDir: dir,
    config: monitorConfig(30),
    emit: async () => {},
    ilinkBotId: 'bot-1',
    sleep: async (ms) => {
      delays.push(ms);
    },
  });
  try {
    await monitor.start();
    await waitFor(() => calls.getUpdates.length >= 4, { label: 'recovery poll' });
    assert.deepEqual(delays.slice(0, 3), [30, 60, 120]);
    await waitFor(() => monitor.health.state === 'connected', { label: 'connected again' });
  } finally {
    await monitor.stop();
    cleanupDir(dir);
  }
});

test('stops retrying when reconnect is disabled', async () => {
  const dir = makeTempDir();
  const { client, calls } = makeFakeClient([new Error('network down')]);
  const config = monitorConfig();
  config.reconnect = { enabled: false, baseDelayMs: 10, maxDelayMs: 20 };
  const monitor = createWeixinMonitor({
    client,
    stateDir: dir,
    config,
    emit: async () => {},
    ilinkBotId: 'bot-1',
  });
  try {
    await monitor.start();
    await waitFor(() => monitor.running === false, { label: 'loop stopped' });
    assert.equal(monitor.health.state, 'disconnected');
    assert.match(monitor.health.detail, /未启用重连/);
    assert.equal(calls.getUpdates.length, 1);
  } finally {
    await monitor.stop();
    cleanupDir(dir);
  }
});

test('replays the round when emit fails, then commits the cursor', async () => {
  const dir = makeTempDir();
  const rawMessage = textMessage({ message_id: 8001 });
  const { client, calls } = makeFakeClient([
    { ret: 0, msgs: [rawMessage], get_updates_buf: 'cursor-replay' },
    { ret: 0, msgs: [rawMessage], get_updates_buf: 'cursor-replay' },
  ]);
  const delays = [];
  let attempts = 0;
  const monitor = createWeixinMonitor({
    client,
    stateDir: dir,
    config: monitorConfig(25),
    emit: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('core emit failed');
    },
    ilinkBotId: 'bot-1',
    sleep: async (ms) => {
      delays.push(ms);
    },
  });
  try {
    await monitor.start();
    await waitFor(() => existsSync(join(dir, 'cursor.json')), { label: 'cursor committed after replay' });
    assert.equal(attempts, 2); // first emit failed, replay succeeded
    assert.deepEqual(delays.slice(0, 1), [25]);
    const cursorFile = JSON.parse(readFileSync(join(dir, 'cursor.json'), 'utf8'));
    assert.equal(cursorFile.getUpdatesBuf, 'cursor-replay');
    assert.equal(calls.getUpdates[1].getUpdatesBuf, '');
  } finally {
    await monitor.stop();
    cleanupDir(dir);
  }
});

test('external abort stops the loop without a notifystop', async () => {
  const dir = makeTempDir();
  const controller = new AbortController();
  const { client, calls } = makeFakeClient([]);
  const monitor = createWeixinMonitor({
    client,
    stateDir: dir,
    config: monitorConfig(),
    emit: async () => {},
    ilinkBotId: 'bot-1',
    signal: controller.signal,
  });
  try {
    await monitor.start();
    await waitFor(() => calls.getUpdates.length >= 1, { label: 'first poll' });
    controller.abort();
    await waitFor(() => monitor.running === false, { label: 'aborted loop' });
    assert.equal(monitor.health.state, 'disconnected');
    assert.equal(calls.notifyStop, 0);
  } finally {
    await monitor.stop();
    cleanupDir(dir);
  }
});

test('stop() interrupts a backoff sleep promptly', async () => {
  const dir = makeTempDir();
  /** @type {AbortSignal | undefined} */
  let sleepSignal;
  const { client } = makeFakeClient([new Error('boom')]);
  const monitor = createWeixinMonitor({
    client,
    stateDir: dir,
    config: monitorConfig(10_000),
    emit: async () => {},
    ilinkBotId: 'bot-1',
    sleep: (ms, signal) =>
      new Promise((resolve) => {
        sleepSignal = signal;
        signal?.addEventListener('abort', resolve, { once: true });
      }),
  });
  try {
    await monitor.start();
    await waitFor(() => sleepSignal !== undefined, { label: 'backoff sleep' });
    const startedAt = Date.now();
    await monitor.stop();
    assert.ok(Date.now() - startedAt < 1_000, 'stop must not wait for the backoff delay');
    assert.equal(monitor.health.state, 'disconnected');
  } finally {
    cleanupDir(dir);
  }
});

test('cursor is reset when the stored bot id does not match the current one', async () => {
  const dir = makeTempDir();
  const { client, calls } = makeFakeClient([]);
  const { writeFileSync } = await import('node:fs');
  writeFileSync(
    join(dir, 'cursor.json'),
    JSON.stringify({ version: 1, ilinkBotId: 'old-bot', getUpdatesBuf: 'stale-cursor', updatedAt: 1 }),
  );
  const monitor = createWeixinMonitor({
    client,
    stateDir: dir,
    config: monitorConfig(),
    emit: async () => {},
    ilinkBotId: 'new-bot',
  });
  try {
    await monitor.start();
    await waitFor(() => calls.getUpdates.length >= 1, { label: 'first poll' });
    assert.equal(calls.getUpdates[0].getUpdatesBuf, '');
  } finally {
    await monitor.stop();
    cleanupDir(dir);
  }
});
