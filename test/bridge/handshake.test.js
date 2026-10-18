/**
 * Cross-process handshake / lifecycle tests: every bridge here spawns
 * `node test/support/fake-dsh-runtime.js` as a real child process.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createDshBridge } from '../../src/bridge/dsh-sdk.js';
import {
  bridgeWithFakeRuntime,
  createCapturingLogger,
  waitFor,
} from '../support/fake-dsh-runtime.js';

/**
 * Start a fake-runtime-backed bridge and guarantee cleanup.
 *
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

/** @param {{ message: string }[]} lines @param {RegExp} pattern */
function hasMessage(lines, pattern) {
  return lines.some((line) => pattern.test(line.message));
}

test('start() spawns, initializes, forwards stderr, and reports ready', async (t) => {
  const log = createCapturingLogger();
  const states = [];
  const bridge = bridgeWithFakeRuntime({ log, env: { FAKE_DSH_TRACE: '1' } });
  t.after(async () => {
    await bridge.stop().catch(() => {});
  });
  bridge.onState((info) => states.push(info.state));

  assert.equal(bridge.state, 'stopped');
  assert.equal(bridge.pid, null);

  const info = await bridge.start();

  assert.equal(bridge.state, 'ready');
  assert.equal(typeof bridge.pid, 'number');
  assert.ok(Number.isInteger(bridge.pid) && bridge.pid > 0);
  assert.equal(info.serverInfo.name, 'deepseek-harness-sdk-runtime');
  assert.equal(typeof info.serverInfo.version, 'string');
  assert.deepEqual(states, ['starting', 'ready']);
  assert.equal(bridge.serverInfo, info);

  // stderr is forwarded to the injected logger, never parsed as protocol.
  await waitFor(() => hasMessage(log.lines, /\[fake-dsh\] ready pid=\d+/), {
    description: 'fake runtime stderr forwarded to the logger',
  });
  assert.ok(log.lines.some((line) => line.message.startsWith('[dsh stderr]')));

  // The handshake carried the configured route and cwd.
  await waitFor(() => hasMessage(log.lines, /\[fake-dsh\] initialize /), {
    description: 'initialize trace line',
  });
  const initializeLine = log.lines.find((line) => line.message.includes('[fake-dsh] initialize '));
  assert.match(initializeLine.message, /"provider":"deepseek-official"/);
  assert.match(initializeLine.message, /"model":"fake-model"/);
  assert.match(initializeLine.message, /"cwd":/);
});

test('normalizes config-style unset reasoningEffort/maxTokens', async (t) => {
  const log = createCapturingLogger();
  const bridge = bridgeWithFakeRuntime({
    log,
    reasoningEffort: '',
    maxTokens: null,
    env: { FAKE_DSH_TRACE: '1' },
  });
  t.after(async () => {
    await bridge.stop().catch(() => {});
  });
  const info = await bridge.start();
  assert.equal(info.serverInfo.name, 'deepseek-harness-sdk-runtime');
  await waitFor(() => hasMessage(log.lines, /\[fake-dsh\] initialize /), {
    description: 'initialize trace line',
  });
  const initializeLine = log.lines.find((line) => line.message.includes('[fake-dsh] initialize '));
  assert.ok(!initializeLine.message.includes('reasoningEffort'));
  assert.ok(!initializeLine.message.includes('maxTokens'));
});

test('stop() is idempotent and reports stopped', async (t) => {
  const bridge = await startBridge(t);
  const pid = bridge.pid;
  assert.ok(pid !== null);

  await Promise.all([bridge.stop(), bridge.stop()]);
  assert.equal(bridge.state, 'stopped');
  assert.equal(bridge.pid, null);
  await bridge.stop(); // repeated call after stopped is still a no-op

  await waitFor(
    () => {
      try {
        process.kill(pid, 0);
        return false;
      } catch (error) {
        return error.code === 'ESRCH';
      }
    },
    { description: 'runtime process to be reaped' },
  );
});

test('stop() before start() resolves without spawning', async () => {
  const bridge = bridgeWithFakeRuntime({});
  await bridge.stop();
  assert.equal(bridge.state, 'stopped');
  assert.equal(bridge.pid, null);
});

test('start() rejects when initialize fails and leaves no child behind', async () => {
  const log = createCapturingLogger();
  const bridge = bridgeWithFakeRuntime({ log, env: { FAKE_DSH_INIT_FAIL: '1' } });
  await assert.rejects(bridge.start(), /initialize failed.*FAKE_DSH_INIT_FAIL/s);
  assert.equal(bridge.state, 'stopped');
  assert.equal(bridge.pid, null);
  await bridge.stop();
});

test('start() requires provider and model options', async () => {
  const missingProvider = createDshBridge({ model: 'some-model' });
  await assert.rejects(missingProvider.start(), /options\.provider is required/);
  assert.equal(missingProvider.state, 'stopped');

  const missingModel = createDshBridge({ provider: 'deepseek-official' });
  await assert.rejects(missingModel.start(), /options\.model is required/);
  assert.equal(missingModel.state, 'stopped');
});

test('ensureSession() treats a failed resume as a missing session', async (t) => {
  const log = createCapturingLogger();
  const bridge = await startBridge(t, {
    log,
    env: { FAKE_DSH_TRACE: '1', FAKE_DSH_RESUME_MISSING: '*' },
  });

  await bridge.ensureSession('not-persisted');
  await waitFor(() => hasMessage(log.lines, /session\/resume/), {
    description: 'session/resume attempt in stderr trace',
  });

  // prompt() creates the session instead.
  const receipt = await bridge.prompt('not-persisted', [{ type: 'text', text: 'hello' }]);
  assert.match(receipt.messageId, /^msg_/);
  await bridge.wait('not-persisted');
});

test('ensureSession() without start() rejects with a readable error', async () => {
  const bridge = bridgeWithFakeRuntime({});
  await assert.rejects(bridge.ensureSession('s1'), /not running.*call start\(\) first/);
  await bridge.stop();
});

test('ignores malformed stdout frames and keeps the protocol channel usable', async (t) => {
  const log = createCapturingLogger();
  const bridge = await startBridge(t, {
    log,
    env: { FAKE_DSH_STDOUT_GARBAGE: '1' },
  });
  await waitFor(
    () => hasMessage(log.lines, /ignoring malformed JSON-RPC frame from runtime stdout/),
    { description: 'malformed frame warning' },
  );
  const receipt = await bridge.prompt('garbage-session', [{ type: 'text', text: 'still works' }]);
  assert.match(receipt.messageId, /^msg_/);
});

test('accepts an injectable spawn function (real child process)', async (t) => {
  const { spawn } = await import('node:child_process');
  /** @type {any[]} */
  const calls = [];
  const bridge = bridgeWithFakeRuntime({
    spawn: (command, args, options) => {
      calls.push({ command, args, options });
      return spawn(command, args, options);
    },
    env: { FAKE_DSH_REPLY_TEXT: 'injected-spawn' },
  });
  t.after(async () => {
    await bridge.stop().catch(() => {});
  });
  await bridge.start();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, process.execPath);
  assert.ok(calls[0].args.some((arg) => arg.endsWith('fake-dsh-runtime.js')));
  assert.deepEqual(calls[0].options.stdio, ['pipe', 'pipe', 'pipe']);
  assert.equal(calls[0].options.env.FAKE_DSH_REPLY_TEXT, 'injected-spawn');
  assert.ok(calls[0].options.cwd.length > 0);
});
