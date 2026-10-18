/**
 * Small JSON persistence helpers for the Weixin adapter state dir.
 *
 * Files written here:
 *   - `<stateDir>/cursor.json`           getUpdates cursor (long-poll resume)
 *   - `<stateDir>/context-tokens.json`   per-peer `context_token` for replies
 *
 * Both are written atomically and with mode `0600` (context tokens are
 * credentials-adjacent material; the cursor is not secret but same treatment
 * keeps the state dir consistent).
 *
 * @see docs/channels/weixin.md §4
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';

import { isPlainObject } from './protocol.js';

export const STATE_FILE_VERSION = 1;

/**
 * Read a JSON file; `undefined` when missing or corrupt.
 * @param {string} file
 * @returns {unknown}
 */
export function readJsonFile(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * Atomically write a JSON file (unique temp + rename) with the given mode.
 * @param {string} file
 * @param {unknown} value
 * @param {{ mode?: number }} [options]
 */
export function writeJsonFileAtomic(file, value, options = {}) {
  const mode = options.mode ?? 0o600;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode });
    renameSync(tmp, file);
    try {
      chmodSync(file, mode);
    } catch {
      // chmod unsupported on some filesystems; create mode still applies.
    }
  } catch (error) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // best effort
    }
    throw error;
  }
}

/**
 * Cursor store for `getupdates`.
 *
 * The cursor is committed only after a round's messages have been handed to
 * core. A crash before the commit replays the round; core dedupe absorbs that.
 * The stored `ilinkBotId` guards against reusing a cursor across a re-login
 * (different bot account → different server-side context).
 *
 * @param {{ file: string, ilinkBotId?: string, now?: () => number }} options
 */
export function createCursorStore(options) {
  const file = options.file;
  const ilinkBotId = typeof options.ilinkBotId === 'string' ? options.ilinkBotId : '';
  const now = typeof options.now === 'function' ? options.now : Date.now;

  return {
    /** @returns {Promise<string>} persisted cursor, or '' when none/mismatched */
    async load() {
      const data = readJsonFile(file);
      if (!isPlainObject(data) || data.version !== STATE_FILE_VERSION) return '';
      if (typeof data.getUpdatesBuf !== 'string') return '';
      const storedBotId = typeof data.ilinkBotId === 'string' ? data.ilinkBotId : '';
      if (ilinkBotId !== '' && storedBotId !== '' && storedBotId !== ilinkBotId) return '';
      return data.getUpdatesBuf;
    },
    /**
     * @param {string} getUpdatesBuf
     * @returns {Promise<string>}
     */
    async save(getUpdatesBuf) {
      const cursor = String(getUpdatesBuf ?? '');
      writeJsonFileAtomic(file, {
        version: STATE_FILE_VERSION,
        ilinkBotId,
        getUpdatesBuf: cursor,
        updatedAt: now(),
      });
      return cursor;
    },
    /** Remove the persisted cursor (e.g. explicit logout). */
    async clear() {
      try {
        rmSync(file, { force: true });
      } catch {
        // best effort
      }
    },
  };
}

/**
 * Per-peer `context_token` store.
 *
 * iLink expects the reply to `sendmessage` to carry the `context_token` from
 * the inbound message of that conversation, so every inbound message updates
 * this store (keyed by `from_user_id`) and `send()` reads it back.
 *
 * @param {{ file: string, now?: () => number, maxEntries?: number }} options
 */
export function createContextTokenStore(options) {
  const file = options.file;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const maxEntries = Number.isFinite(options.maxEntries) && options.maxEntries > 0 ? Math.floor(options.maxEntries) : 500;
  /** @type {Map<string, { token: string, updatedAt: number }> | null} */
  let entries = null;

  function load() {
    if (entries !== null) return;
    entries = new Map();
    const data = readJsonFile(file);
    if (!isPlainObject(data) || data.version !== STATE_FILE_VERSION || !isPlainObject(data.tokens)) return;
    for (const [peerId, value] of Object.entries(data.tokens)) {
      if (!isPlainObject(value)) continue;
      const token = typeof value.token === 'string' ? value.token : '';
      if (peerId === '' || token === '') continue;
      entries.set(peerId, { token, updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : 0 });
    }
  }

  function persist() {
    /** @type {Record<string, { token: string, updatedAt: number }>} */
    const tokens = {};
    for (const [peerId, value] of entries ?? []) tokens[peerId] = { token: value.token, updatedAt: value.updatedAt };
    writeJsonFileAtomic(file, { version: STATE_FILE_VERSION, updatedAt: now(), tokens });
  }

  function prune() {
    while ((entries?.size ?? 0) > maxEntries) {
      let oldestKey;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [peerId, value] of entries ?? []) {
        if (value.updatedAt < oldestAt) {
          oldestAt = value.updatedAt;
          oldestKey = peerId;
        }
      }
      if (oldestKey === undefined) break;
      entries?.delete(oldestKey);
    }
  }

  return {
    /**
     * @param {string} peerId
     * @returns {string | undefined}
     */
    get(peerId) {
      load();
      return entries?.get(String(peerId))?.token;
    },
    /**
     * @param {string} peerId
     * @param {string} token
     */
    set(peerId, token) {
      load();
      const peer = String(peerId ?? '');
      const value = String(token ?? '');
      if (peer === '' || value === '') return;
      entries?.set(peer, { token: value, updatedAt: now() });
      prune();
      persist();
    },
    /**
     * Remove one peer's token, or all tokens when `peerId` is omitted.
     * @param {string} [peerId]
     */
    clear(peerId) {
      load();
      if (peerId === undefined) {
        entries?.clear();
        persist();
        return;
      }
      if (entries?.delete(String(peerId)) === true) persist();
    },
    /** Persist a loaded snapshot without changes (flush). */
    flush() {
      load();
      persist();
    },
    get size() {
      load();
      return entries?.size ?? 0;
    },
  };
}
