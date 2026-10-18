/**
 * End-to-end for the host-plugin "manager mode" backend: a real manager + API
 * started by `startEmbeddedManager`, one workspace with a fake DSH runtime, the
 * single-instance lock, and a clean dispose that stops everything.
 *
 * The DSH loader itself is covered separately by `install/verify-plugin.sh`
 * (isolated real profile); this test covers the embedded manager lifecycle.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { defaultConfig } from '../../src/core/config.js';
import { acquireManagerLock, readManagerLock } from '../../src/host/manager-lock.js';
import { startEmbeddedManager } from '../../src/host/embedded-manager.js';
import { createRunDir, fakeRuntimePath } from './helpers.js';

const silentLogger = { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } };

async function waitFor(check, { timeoutMs = 10000, description = 'condition' } = {}) {
  const started = Date.now();
  while (!(await check())) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test('embedded manager e2e: owns lock, starts workspace, serves API, stops cleanly', async (t) => {
  const runDir = createRunDir('embedded-manager');
  t.after(() => runDir.cleanup());

  const workspaceDir = join(runDir.dir, 'workspace');
  const stateDir = join(workspaceDir, '.dsh-im-manager', 'state');
  mkdirSync(join(workspaceDir, '.dsh-im-manager'), { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  const config = defaultConfig();
  config.dsh.command = process.execPath;
  config.dsh.args = [fakeRuntimePath];
  config.dsh.cwd = workspaceDir;
  config.dsh.provider = 'deepseek-official';
  config.dsh.model = 'fake-model';
  config.dsh.env = { FAKE_DSH_REPLY_TEXT: 'embedded e2e' };
  config.gateway.stateDir = stateDir;
  config.gateway.http.enabled = false;
  config.gateway.log.level = 'silent';
  for (const channel of Object.values(config.channels)) channel.enabled = false;
  const configFile = join(workspaceDir, '.dsh-im-manager', 'config.json');
  writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });

  const managerFile = join(runDir.dir, 'manager.json');
  writeFileSync(managerFile, `${JSON.stringify({
    version: 1,
    listen: { host: '127.0.0.1', port: 0 },
    workspaces: [{ id: 'embedded-ws', name: 'Embedded', workspaceDir, configFile, autoStart: true }],
  }, null, 2)}\n`, { mode: 0o600 });

  const embedded = await startEmbeddedManager({
    managerFile,
    port: 0,
    logger: silentLogger,
    startAllWorkspaces: true,
  });
  assert.equal(embedded.mode, 'owned');
  assert.match(embedded.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);

  const lock = readManagerLock(managerFile);
  assert.equal(lock.pid, process.pid);
  assert.equal(lock.port, embedded.port);

  await waitFor(async () => {
    const response = await fetch(`${embedded.baseUrl}/api/state`);
    const state = await response.json();
    return state.workspaces.some((workspace) => workspace.id === 'embedded-ws' && workspace.state === 'running');
  }, { description: 'embedded workspace running' });

  const health = await (await fetch(`${embedded.baseUrl}/api/health`)).json();
  assert.deepEqual(health, { ok: true });

  await embedded.stop();
  assert.equal(readManagerLock(managerFile), null);
  // The workspace gateway must be stopped with the manager.
  const stoppedState = embedded.manager.getState();
  assert.equal(stoppedState.workspaces[0].state, 'stopped');

  // A second embedded start after dispose owns the lock again.
  const second = await startEmbeddedManager({ managerFile, port: 0, logger: silentLogger });
  assert.equal(second.mode, 'owned');
  await second.stop();
  assert.equal(readManagerLock(managerFile), null);

  // Leaving a foreign live lock in place must be respected by a new attempt.
  const owner = acquireManagerLock(managerFile);
  const attached = await startEmbeddedManager({ managerFile, port: 0, logger: silentLogger });
  assert.equal(attached.mode, 'attach');
  assert.equal(readManagerLock(managerFile).token, owner.token);
  await attached.stop();
  const { releaseManagerLock } = await import('../../src/host/manager-lock.js');
  releaseManagerLock(owner);
});

test('embedded manager e2e: attach uses the running API without a second manager', async (t) => {
  const runDir = createRunDir('embedded-attach');
  t.after(() => runDir.cleanup());
  const managerFile = join(runDir.dir, 'manager.json');
  writeFileSync(managerFile, `${JSON.stringify({ version: 1, listen: { host: '127.0.0.1', port: 0 }, workspaces: [] }, null, 2)}\n`);

  const owner = acquireManagerLock(managerFile, { host: '127.0.0.1', port: 49999 });
  const attached = await startEmbeddedManager({ managerFile, port: 0, logger: silentLogger });
  assert.equal(attached.mode, 'attach');
  assert.equal(attached.baseUrl, 'http://127.0.0.1:49999');
  await attached.stop();
  const { releaseManagerLock } = await import('../../src/host/manager-lock.js');
  releaseManagerLock(owner);
});
