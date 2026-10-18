import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import {
  acquireManagerLock,
  isPidAlive,
  managerLockPath,
  readManagerLock,
  releaseManagerLock,
  updateManagerLock,
} from '../../src/host/manager-lock.js';

const dirs = [];
function tempManagerFile() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-im-manager-lock-'));
  dirs.push(dir);
  return join(dir, 'manager.json');
}
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

test('acquire writes a 0600 lock and a second live acquire is refused', () => {
  const managerFile = tempManagerFile();
  const handle = acquireManagerLock(managerFile, { host: '127.0.0.1', port: 8788 });
  assert.equal(handle.acquired, true);
  const record = readManagerLock(managerFile);
  assert.equal(record.pid, process.pid);
  assert.equal(record.port, 8788);
  assert.equal(record.token, handle.token);
  assert.equal(isPidAlive(record.pid), true);
  assert.equal(statSync(managerLockPath(managerFile)).mode & 0o777, 0o600);

  const second = acquireManagerLock(managerFile, { port: 9999 });
  assert.equal(second.acquired, false);
  assert.equal(second.existing.pid, process.pid);
  assert.equal(second.existing.port, 8788);

  // Only the owner token may release.
  assert.equal(releaseManagerLock({ file: handle.file, token: 'wrong' }), false);
  assert.equal(releaseManagerLock(handle), true);
  assert.equal(readManagerLock(managerFile), null);
});

test('a stale lock is replaced after the previous pid is gone', () => {
  const managerFile = tempManagerFile();
  const lockFile = managerLockPath(managerFile);
  writeFileSync(lockFile, `${JSON.stringify({
    version: 1,
    pid: 999999,
    token: 'stale',
    host: '127.0.0.1',
    port: 8788,
    managerFile,
    startedAt: 0,
  })}\n`, { mode: 0o600 });
  assert.equal(isPidAlive(999999), false);
  const handle = acquireManagerLock(managerFile);
  assert.equal(handle.acquired, true);
  assert.equal(readManagerLock(managerFile).token, handle.token);
  releaseManagerLock(handle);
});

test('corrupt lock is treated as stale', () => {
  const managerFile = tempManagerFile();
  writeFileSync(managerLockPath(managerFile), 'not json\n');
  assert.equal(readManagerLock(managerFile), null);
  const handle = acquireManagerLock(managerFile);
  assert.equal(handle.acquired, true);
  releaseManagerLock(handle);
});

test('updateManagerLock records the actual API port and rejects foreign tokens', () => {
  const managerFile = tempManagerFile();
  const handle = acquireManagerLock(managerFile, { port: 0 });
  assert.equal(updateManagerLock(handle, { host: '127.0.0.1', port: 43210 }), true);
  assert.equal(readManagerLock(managerFile).port, 43210);
  assert.equal(updateManagerLock({ file: handle.file, token: 'other', record: handle.record }, { port: 1 }), false);
  assert.equal(readManagerLock(managerFile).port, 43210);
  releaseManagerLock(handle);
  assert.equal(existsSync(managerLockPath(managerFile)), false);
});
