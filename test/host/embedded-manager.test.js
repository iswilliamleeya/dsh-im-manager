import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { acquireManagerLock, readManagerLock } from '../../src/host/manager-lock.js';
import { startEmbeddedManager } from '../../src/host/embedded-manager.js';

const dirs = [];
function tempManagerFile() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-im-manager-embedded-'));
  dirs.push(dir);
  return join(dir, 'manager.json');
}
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const noopLogger = { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } };

function fakeManagerFactory(record) {
  return () => ({
    async init() {
      record.managerInit = true;
    },
    async start() {
      record.managerStarted = true;
    },
    getState() {
      return {
        workspaces: record.workspaces ?? [
          { id: 'stopped-ws', state: 'stopped' },
          { id: 'running-ws', state: 'running' },
        ],
      };
    },
    async startWorkspace(id) {
      record.startedIds.push(id);
    },
    async stop() {
      record.managerStopped = true;
    },
  });
}

function fakeApiFactory(record, { port = 43210, failure = null } = {}) {
  return () => ({
    async start() {
      if (failure !== null) throw failure;
      record.apiStarted = true;
      return { host: '127.0.0.1', port };
    },
    async stop() {
      record.apiStopped = true;
    },
  });
}

test('starts an owned manager, updates the lock with the real port, and stops cleanly', async () => {
  const managerFile = tempManagerFile();
  const record = { startedIds: [] };
  const embedded = await startEmbeddedManager({
    managerFile,
    port: 0,
    logger: noopLogger,
    managerFactory: fakeManagerFactory(record),
    apiFactory: fakeApiFactory(record),
    sdkRuntimeCheck: () => false,
  });

  assert.equal(embedded.mode, 'owned');
  assert.equal(record.managerStarted, true);
  assert.equal(record.apiStarted, true);
  assert.equal(readManagerLock(managerFile).port, 43210);
  assert.equal(embedded.baseUrl, 'http://127.0.0.1:43210');

  await embedded.stop();
  assert.equal(record.apiStopped, true);
  assert.equal(record.managerStopped, true);
  assert.equal(readManagerLock(managerFile), null);
  // stop is idempotent
  await embedded.stop();
});

test('startAllWorkspaces starts every non-running workspace', async () => {
  const managerFile = tempManagerFile();
  const record = { startedIds: [] };
  const embedded = await startEmbeddedManager({
    managerFile,
    startAllWorkspaces: true,
    logger: noopLogger,
    managerFactory: fakeManagerFactory(record),
    apiFactory: fakeApiFactory(record),
    sdkRuntimeCheck: () => false,
  });
  assert.deepEqual(record.startedIds, ['stopped-ws']);
  await embedded.stop();
});

test('attaches to a live lock without creating a manager', async () => {
  const managerFile = tempManagerFile();
  const owner = acquireManagerLock(managerFile, { host: '127.0.0.1', port: 43211 });
  let factoryCalled = false;
  const embedded = await startEmbeddedManager({
    managerFile,
    logger: noopLogger,
    managerFactory: () => {
      factoryCalled = true;
      throw new Error('must not create a second manager');
    },
    apiFactory: () => ({ async start() { return { host: '127.0.0.1', port: 1 }; }, async stop() {} }),
    sdkRuntimeCheck: () => false,
  });
  assert.equal(embedded.mode, 'attach');
  assert.equal(factoryCalled, false);
  assert.equal(embedded.baseUrl, 'http://127.0.0.1:43211');
  await embedded.stop(); // must not stop the attached owner
  assert.equal(readManagerLock(managerFile).token, owner.token);
  const { releaseManagerLock } = await import('../../src/host/manager-lock.js');
  releaseManagerLock(owner);
});

test('replaces a stale lock and starts a new manager', async () => {
  const managerFile = tempManagerFile();
  const { managerLockPath } = await import('../../src/host/manager-lock.js');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(managerLockPath(managerFile), `${JSON.stringify({
    version: 1, pid: 999999, token: 'stale', host: '127.0.0.1', port: 8788, managerFile, startedAt: 0,
  })}\n`);
  const record = { startedIds: [] };
  const embedded = await startEmbeddedManager({
    managerFile,
    logger: noopLogger,
    managerFactory: fakeManagerFactory(record),
    apiFactory: fakeApiFactory(record),
    sdkRuntimeCheck: () => false,
  });
  assert.equal(embedded.mode, 'owned');
  await embedded.stop();
});

test('attaches when the port is already serving a healthy manager', async () => {
  const managerFile = tempManagerFile();
  const record = { startedIds: [] };
  const failure = Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' });
  const embedded = await startEmbeddedManager({
    managerFile,
    logger: noopLogger,
    managerFactory: fakeManagerFactory(record),
    apiFactory: fakeApiFactory(record, { failure }),
    fetchImpl: async () => ({ ok: true }),
    sdkRuntimeCheck: () => false,
  });
  assert.equal(embedded.mode, 'attach');
  assert.equal(readManagerLock(managerFile), null);
});

test('refuses to start inside an SDK runtime', async () => {
  const managerFile = tempManagerFile();
  await assert.rejects(
    startEmbeddedManager({
      managerFile,
      logger: noopLogger,
      sdkRuntimeCheck: () => true,
    }),
    /cannot start inside a DSH SDK runtime/,
  );
  assert.equal(readManagerLock(managerFile), null);
});
