/**
 * Single-instance lock for the multi-workspace manager.
 *
 * The manager must only be owned by one process at a time: two managers would
 * fight over the same IM channel accounts (long connections / polling), the
 * same HTTP port, and the same state directory. The DSH host plugin and the
 * standalone CLI both use this lock so one can attach to the other instead of
 * starting a second copy.
 *
 * The lock lives next to `manager.json` (`manager.lock`) and is written with
 * mode 0600. It records the owner pid, a random token (so a stale owner can
 * never remove a newer lock), the manager HTTP endpoint, and the manager file.
 */
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

/**
 * @typedef {object} ManagerLockRecord
 * @property {number} version
 * @property {number} pid
 * @property {string} token
 * @property {string} host
 * @property {number} port
 * @property {string} managerFile
 * @property {number} startedAt
 */

/** @param {string} managerFile */
export function managerLockPath(managerFile) {
  return join(dirname(managerFile), 'manager.lock');
}

/** @param {number} pid */
export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return /** @type {NodeJS.ErrnoException} */ (error).code === 'EPERM';
  }
}

/**
 * Read and validate the lock file. Returns null when missing/corrupt.
 * @param {string} managerFile
 * @returns {ManagerLockRecord | null}
 */
export function readManagerLock(managerFile) {
  const file = managerLockPath(managerFile);
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return null;
    if (!Number.isInteger(parsed.pid) || parsed.pid <= 0) return null;
    return {
      version: Number.isInteger(parsed.version) ? parsed.version : 1,
      pid: parsed.pid,
      token: typeof parsed.token === 'string' ? parsed.token : '',
      host: typeof parsed.host === 'string' && parsed.host.length > 0 ? parsed.host : '127.0.0.1',
      port: Number.isInteger(parsed.port) ? parsed.port : 0,
      managerFile: typeof parsed.managerFile === 'string' ? parsed.managerFile : managerFile,
      startedAt: Number.isFinite(parsed.startedAt) ? parsed.startedAt : 0,
    };
  } catch {
    return null;
  }
}

/**
 * @param {string} managerFile
 * @param {Partial<ManagerLockRecord>} record
 */
function writeLockFile(managerFile, record) {
  const file = managerLockPath(managerFile);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

/**
 * Acquire the manager lock.
 *
 * Returns `{ acquired: true, token, record }` on success, or
 * `{ acquired: false, existing }` when another live process owns it.
 *
 * @param {string} managerFile
 * @param {{ host?: string, port?: number, pid?: number, now?: number, token?: string }} [options]
 */
export function acquireManagerLock(managerFile, options = {}) {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 0;
  const pid = options.pid ?? process.pid;
  const now = options.now ?? Date.now();
  const token = options.token ?? randomUUID();
  const file = managerLockPath(managerFile);
  const record = { version: 1, pid, token, host, port, managerFile, startedAt: now };

  mkdirSync(dirname(file), { recursive: true });
  // Two attempts: the first may find a stale lock, which we remove and retry.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let fd;
    try {
      fd = openSync(file, 'wx', 0o600);
      writeSync(fd, `${JSON.stringify(record)}\n`);
      closeSync(fd);
      return { acquired: true, token, record, file };
    } catch (error) {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          // ignore
        }
      }
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'EEXIST') throw error;
      const existing = readManagerLock(managerFile);
      if (existing !== null && isPidAlive(existing.pid)) {
        return { acquired: false, existing, file };
      }
      // Stale/corrupt: remove and retry once.
      try {
        unlinkSync(file);
      } catch {
        // Someone else cleaned it up or the directory vanished; retry anyway.
      }
    }
  }
  return { acquired: false, existing: readManagerLock(managerFile), file };
}

/**
 * Update the lock with the actual HTTP listen endpoint after the API binds.
 * Only the owner token may update the file.
 *
 * @param {{ file: string, token: string, record: ManagerLockRecord }} handle
 * @param {{ host?: string, port?: number }} patch
 */
export function updateManagerLock(handle, patch = {}) {
  const current = readManagerLock(handle.record.managerFile);
  if (current === null || current.token !== handle.token) return false;
  const next = {
    ...current,
    host: patch.host ?? current.host,
    port: patch.port ?? current.port,
  };
  writeLockFile(handle.record.managerFile, next);
  handle.record = next;
  return true;
}

/**
 * Release the lock if (and only if) this handle still owns it.
 * @param {{ file: string, token: string }} handle
 */
export function releaseManagerLock(handle) {
  try {
    const current = JSON.parse(readFileSync(handle.file, 'utf8'));
    if (current?.token !== handle.token) return false;
    unlinkSync(handle.file);
    return true;
  } catch {
    return false;
  }
}
