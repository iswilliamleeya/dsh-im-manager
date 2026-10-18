/**
 * Cross-process prompt / notification tests against the fake runtime.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { JsonRpcResponseError } from '../../src/bridge/jsonrpc.js';
import {
  bridgeWithFakeRuntime,
  createCapturingLogger,
  waitFor,
} from '../support/fake-dsh-runtime.js';

/**
 * @param {import('node:test').TestContext} t
 * @param {object} [overrides]
 */
async function startBridge(t, overrides = {}) {
  const bridge = bridgeWithFakeRuntime(overrides);
  t.after(async () => {
    await bridge.stop().catch(() => {});
  });
  await bridge.start();
  return bridge;
}

test('prompt() returns a messageId and streams the turn as events', async (t) => {
  const bridge = await startBridge(t, { env: { FAKE_DSH_ECHO: '1' } });
  await bridge.ensureSession('session-1');

  /** @type {{ sessionId: string, event: any }[]} */
  const events = [];
  /** @type {{ sessionId: string, status: string }[]} */
  const statuses = [];
  const unsubscribeEvents = bridge.onEvent((payload) => events.push(payload));
  const unsubscribeStatus = bridge.onStatus((payload) => statuses.push(payload));

  const receipt = await bridge.prompt('session-1', [{ type: 'text', text: 'hello world' }]);
  assert.equal(typeof receipt.messageId, 'string');
  assert.match(receipt.messageId, /^msg_/);

  // session/wait resolves after the runtime reports idle again.
  await bridge.wait('session-1');
  await waitFor(() => events.some((payload) => payload.event.type === 'turn/end'), {
    description: 'turn/end event',
  });

  assert.deepEqual(
    events.map((payload) => payload.event.type),
    ['turn/start', 'assistant/message', 'turn/end'],
  );
  assert.ok(events.every((payload) => payload.sessionId === 'session-1'));
  const turnStart = events.find((payload) => payload.event.type === 'turn/start');
  const assistant = events.find((payload) => payload.event.type === 'assistant/message');
  const turnEnd = events.find((payload) => payload.event.type === 'turn/end');
  assert.deepEqual(assistant.event.data.message.content, [{ type: 'text', text: 'hello world' }]);
  // Mirror the real dsh shape core relies on: one numeric turn id across the turn.
  assert.equal(typeof turnStart.event.data.turn, 'number');
  assert.equal(assistant.event.data.turn, turnStart.event.data.turn);
  assert.equal(turnEnd.event.data.turn, turnStart.event.data.turn);
  assert.equal(turnEnd.event.data.reason.kind, 'completed');
  assert.equal(typeof turnEnd.event.seq, 'number');
  assert.equal(typeof turnEnd.event.time, 'number');

  // `ensureSession()` may emit an extra idle status from session/resume; the
  // turn itself must be exactly running → idle.
  await waitFor(
    () => {
      const firstRunning = statuses.findIndex((payload) => payload.status === 'running');
      return firstRunning >= 0 && statuses.slice(firstRunning).some((payload) => payload.status === 'idle');
    },
    { description: 'turn status transitions' },
  );
  const firstRunning = statuses.findIndex((payload) => payload.status === 'running');
  assert.deepEqual(
    statuses.slice(firstRunning).map((payload) => payload.status),
    ['running', 'idle'],
  );
  assert.ok(statuses.every((payload) => payload.sessionId === 'session-1'));

  // Unsubscribe stops delivery.
  unsubscribeEvents();
  unsubscribeStatus();
  events.length = 0;
  statuses.length = 0;
  await bridge.prompt('session-1', [{ type: 'text', text: 'second' }]);
  await bridge.wait('session-1');
  assert.equal(events.length, 0);
  assert.equal(statuses.length, 0);
});

test('multiple prompts on one session each produce an independent turn', async (t) => {
  const bridge = await startBridge(t, { env: { FAKE_DSH_REPLY_TEXT: 'fixed reply' } });
  await bridge.ensureSession('multi');

  /** @type {any[]} */
  const events = [];
  bridge.onEvent((payload) => events.push(payload));
  /** @type {string[]} */
  const receipts = [];

  for (const text of ['first', 'second', 'third']) {
    const receipt = await bridge.prompt('multi', [{ type: 'text', text }]);
    receipts.push(receipt.messageId);
    await bridge.wait('multi');
  }
  await waitFor(() => events.filter((payload) => payload.event.type === 'turn/end').length === 3, {
    description: 'three completed turns',
  });
  assert.equal(new Set(receipts).size, 3);
  const replies = events
    .filter((payload) => payload.event.type === 'assistant/message')
    .map((payload) => payload.event.data.message.content[0].text);
  assert.deepEqual(replies, ['fixed reply', 'fixed reply', 'fixed reply']);
});

test('prompt() before start() rejects instead of hanging', async () => {
  const bridge = bridgeWithFakeRuntime({});
  await assert.rejects(
    bridge.prompt('s1', [{ type: 'text', text: 'hi' }]),
    /not running.*call start\(\) first/,
  );
  await bridge.stop();
});

test('prompt() rejects with the runtime JSON-RPC error', async (t) => {
  const bridge = await startBridge(t, { env: { FAKE_DSH_PROMPT_ERROR: '1' } });
  await bridge.ensureSession('error-session');

  await assert.rejects(
    bridge.prompt('error-session', [{ type: 'text', text: 'boom' }]),
    (error) => {
      assert.ok(error instanceof JsonRpcResponseError);
      assert.equal(error.name, 'JsonRpcResponseError');
      assert.equal(error.code, -32001);
      assert.match(error.message, /FAKE_DSH_PROMPT_ERROR/);
      return true;
    },
  );
  assert.equal(bridge.state, 'ready');
});

test('wait() rejects for an unknown session with a JSON-RPC error', async (t) => {
  const bridge = await startBridge(t);
  await assert.rejects(bridge.wait('never-created'), (error) => {
    assert.ok(error instanceof JsonRpcResponseError);
    assert.equal(error.code, -32006);
    assert.match(error.message, /unknown SDK session: never-created/);
    return true;
  });
});

test('validates arguments before touching the runtime', async (t) => {
  const bridge = await startBridge(t);
  await assert.rejects(bridge.ensureSession(''), TypeError);
  await assert.rejects(bridge.ensureSession(42), TypeError);
  await assert.rejects(bridge.prompt('s1', []), TypeError);
  await assert.rejects(bridge.prompt('s1', 'not-blocks'), TypeError);
  await assert.rejects(bridge.prompt('', [{ type: 'text', text: 'x' }]), TypeError);
  await assert.rejects(bridge.wait(''), TypeError);
  assert.throws(() => bridge.onEvent('not-a-function'), TypeError);
});

test('working-directory get/set round-trips through the runtime', async (t) => {
  const bridge = await startBridge(t);
  const initial = await bridge.getWorkingDirectory('wd-session');
  assert.equal(typeof initial, 'string');
  assert.ok(initial.length > 0);

  const updated = await bridge.setWorkingDirectory('wd-session', 'nested/dir');
  assert.ok(updated.endsWith('nested/dir'));
  assert.equal(await bridge.getWorkingDirectory('wd-session'), updated);
});

test('stderr diagnostics are forwarded through the supplied logger', async (t) => {
  const log = createCapturingLogger();
  const bridge = await startBridge(t, { log, env: { FAKE_DSH_TRACE: '1' } });
  await bridge.ensureSession('logged');
  await bridge.prompt('logged', [{ type: 'text', text: 'hi' }]);
  await bridge.wait('logged');
  await waitFor(() => log.lines.some((line) => /\[fake-dsh\] session\/prompt/.test(line.message)), {
    description: 'request trace forwarded from stderr',
  });
  assert.ok(
    log.lines.some((line) => line.level === 'info' && line.message.startsWith('[dsh stderr]')),
  );
});
