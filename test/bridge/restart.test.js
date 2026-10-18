/**
 * Cross-process crash/restart and shutdown-escalation tests. A real fake-runtime
 * child process is killed (SIGTERM/SIGKILL) and respawned by the bridge.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  bridgeWithFakeRuntime,
  createCapturingLogger,
  waitFor,
} from '../support/fake-dsh-runtime.js';

/** @param {{ message: string }[]} lines @param {RegExp} pattern */
function hasMessage(lines, pattern) {
  return lines.some((line) => pattern.test(line.message));
}

/** @param {(error: Error) => boolean} predicate */
function isProcessGone(error) {
  return error.code === 'ESRCH';
}

/**
 * @param {import('node:test').TestContext} t
 * @param {object} overrides
 */
async function startBridge(t, overrides = {}) {
  const bridge = bridgeWithFakeRuntime(overrides);
  t.after(async () => {
    await bridge.stop().catch(() => {});
  });
  await bridge.start();
  return bridge;
}

test('auto-restarts after a crash and restores sessions with session/resume', async (t) => {
  const log = createCapturingLogger();
  const bridge = await startBridge(t, {
    log,
    env: { FAKE_DSH_TRACE: '1', FAKE_DSH_CRASH_ON_PROMPT: 'CRASH' },
    restart: { initialDelayMs: 20, maxDelayMs: 80, jitterRatio: 0 },
  });

  /** @type {string[]} */
  const states = [];
  bridge.onState((info) => states.push(info.state));

  // Start registered after start(); state is already 'ready'.
  assert.equal(bridge.state, 'ready');
  const firstPid = bridge.pid;
  assert.equal(typeof firstPid, 'number');
  await bridge.ensureSession('persisted-session');

  await waitFor(() => hasMessage(log.lines, /\[fake-dsh\] session\/resume/), {
    description: 'initial session/resume trace',
  });
  const resumeCount = () =>
    log.lines.filter((line) => line.message.includes('[fake-dsh] session/resume')).length;
  assert.equal(resumeCount(), 1);

  // The runtime dies while a prompt is in flight: the request must reject, not hang.
  await assert.rejects(
    bridge.prompt('persisted-session', [{ type: 'text', text: 'CRASH now' }]),
    /connection lost|lost the runtime|JSON-RPC/,
  );

  // The bridge respawns and re-initializes the runtime.
  await waitFor(
    () => bridge.state === 'ready' && bridge.pid !== null && bridge.pid !== firstPid,
    { description: 'restarted runtime to become ready', timeoutMs: 8000 },
  );
  assert.ok(states.includes('restarting'));
  assert.deepEqual(states.filter((state) => state === 'ready').length, 1, 'onState was registered late; only the restarted ready is observed');
  assert.ok(bridge.pid !== firstPid);

  // ensureSession() restores the known session via session/resume in the new process.
  await bridge.ensureSession('persisted-session');
  await waitFor(() => resumeCount() >= 2, {
    description: 'session/resume after restart',
    timeoutMs: 8000,
  });

  /** @type {any[]} */
  const events = [];
  // Subscribe BEFORE prompting: the restarted runtime can emit turn/end before
  // the await returns, so a late listener races and misses the turn.
  bridge.onEvent((payload) => events.push(payload));
  const receipt = await bridge.prompt('persisted-session', [{ type: 'text', text: 'hello again' }]);
  assert.match(receipt.messageId, /^msg_/);
  await bridge.wait('persisted-session');
  await waitFor(() => events.some((payload) => payload.event.type === 'turn/end'), {
    description: 'turn after restart',
    timeoutMs: 8000,
  });
});

test('stop() cancels a pending restart and the bridge can start again', async (t) => {
  const bridge = await startBridge(t, {
    env: { FAKE_DSH_CRASH_ON_PROMPT: '1' },
    restart: { initialDelayMs: 5000, maxDelayMs: 5000, jitterRatio: 0 },
  });

  await assert.rejects(bridge.prompt('restart-cancel', [{ type: 'text', text: 'crash' }]));
  await waitFor(() => bridge.state === 'restarting', { description: 'restarting state' });

  await bridge.stop();
  assert.equal(bridge.state, 'stopped');
  assert.equal(bridge.pid, null);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(bridge.state, 'stopped', 'cancelled restart must not fire after stop()');

  // A stopped bridge is startable again.
  await bridge.start();
  assert.equal(bridge.state, 'ready');
  assert.equal(typeof bridge.pid, 'number');
});

test('restart.enabled=false leaves the bridge stopped after a crash', async (t) => {
  const bridge = await startBridge(t, {
    env: { FAKE_DSH_CRASH_ON_PROMPT: '1' },
    restart: { enabled: false },
  });
  await assert.rejects(bridge.prompt('no-restart', [{ type: 'text', text: 'crash' }]));
  await waitFor(() => bridge.state === 'stopped', { description: 'stopped after crash' });
  assert.equal(bridge.pid, null);

  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(bridge.state, 'stopped');
  await assert.rejects(bridge.ensureSession('no-restart'), /not running/);
});

test('stop() escalates to SIGTERM when shutdown is ignored', async (t) => {
  const log = createCapturingLogger();
  const bridge = await startBridge(t, {
    log,
    env: { FAKE_DSH_IGNORE_SHUTDOWN: '1' },
    shutdownTimeoutMs: 100,
    sigtermTimeoutMs: 500,
  });
  const pid = bridge.pid;
  assert.equal(typeof pid, 'number');

  await bridge.stop();
  assert.equal(bridge.state, 'stopped');
  assert.equal(bridge.pid, null);
  assert.ok(hasMessage(log.lines, /did not exit after shutdown; sending SIGTERM/));
  await waitFor(
    () => {
      try {
        process.kill(pid, 0);
        return false;
      } catch (error) {
        return isProcessGone(error);
      }
    },
    { description: 'runtime process to exit after SIGTERM' },
  );
});

test('stop() escalates to SIGKILL when SIGTERM is ignored', async (t) => {
  const log = createCapturingLogger();
  const bridge = await startBridge(t, {
    log,
    env: { FAKE_DSH_IGNORE_SHUTDOWN: '1', FAKE_DSH_IGNORE_SIGTERM: '1' },
    shutdownTimeoutMs: 80,
    sigtermTimeoutMs: 80,
    killWaitMs: 2000,
  });
  const pid = bridge.pid;
  assert.equal(typeof pid, 'number');

  await bridge.stop();
  assert.equal(bridge.state, 'stopped');
  assert.equal(bridge.pid, null);
  assert.ok(hasMessage(log.lines, /did not exit after SIGTERM; sending SIGKILL/));
  await waitFor(
    () => {
      try {
        process.kill(pid, 0);
        return false;
      } catch (error) {
        return isProcessGone(error);
      }
    },
    { description: 'runtime process to exit after SIGKILL' },
  );
});

test('a second start() after a successful start shares the ready bridge', async (t) => {
  const bridge = await startBridge(t);
  const pid = bridge.pid;
  const info = await bridge.start();
  assert.equal(bridge.pid, pid, 'start() must not spawn a second runtime');
  assert.equal(info.serverInfo.name, 'deepseek-harness-sdk-runtime');
});
