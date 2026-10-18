/**
 * DM pairing store: unknown senders get a short code, an operator approves it
 * out-of-band (`dsh-im-manager pair <code>`), and the sender joins the
 * persistent allowlist. Mirrors OpenClaw's pairing UX without its runtime.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomInt } from 'node:crypto';

/**
 * @typedef {Object} ApprovedEntry
 * @property {string} channel
 * @property {string} senderId
 * @property {string} [name]
 * @property {number} addedAt
 */

/**
 * @typedef {Object} PendingEntry
 * @property {string} code
 * @property {string} channel
 * @property {string} senderId
 * @property {string} [name]
 * @property {number} createdAt
 */

/**
 * @param {{ file?: string | null, ttlSec?: number, now?: () => number }} [options]
 */
export function createPairingStore(options = {}) {
  const file = options.file ?? null;
  const ttlSec = options.ttlSec ?? 600;
  const now = options.now ?? Date.now;
  /** @type {ApprovedEntry[]} */
  let approved = [];
  /** @type {PendingEntry[]} */
  let pending = [];
  /** mtime of the last state we loaded/wrote, so an operator's CLI approval is
   *  observed by the running gateway without a restart. */
  let lastMtimeMs = 0;

  /** @param {string} raw */
  function adopt(raw) {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed?.approved)) {
      approved = parsed.approved.filter((entry) => typeof entry?.channel === 'string' && typeof entry?.senderId === 'string');
    }
    if (Array.isArray(parsed?.pending)) {
      pending = parsed.pending.filter((entry) => typeof entry?.code === 'string' && typeof entry?.channel === 'string' && typeof entry?.senderId === 'string');
    }
  }

  /**
   * Reload the on-disk state when another process (the `pair`/`allow` CLI)
   * rewrote it. The gateway is long-lived; approval must not require a restart.
   */
  function refreshFromDisk() {
    if (file === null) return;
    try {
      const stat = statSync(file);
      if (stat.mtimeMs <= lastMtimeMs) return;
      adopt(readFileSync(file, 'utf8'));
      lastMtimeMs = stat.mtimeMs;
    } catch {
      // Missing or transiently unreadable file: keep the in-memory state.
    }
  }

  if (file !== null && existsSync(file)) {
    try {
      adopt(readFileSync(file, 'utf8'));
      lastMtimeMs = statSync(file).mtimeMs;
    } catch {
      // Corrupt pairing state is dropped; pending codes are reissued on demand.
    }
  }

  function prunePending() {
    const cutoff = now() - ttlSec * 1000;
    pending = pending.filter((entry) => entry.createdAt >= cutoff);
  }

  function flush() {
    prunePending();
    if (file === null) return;
    mkdirSync(dirname(file), { recursive: true });
    const body = `${JSON.stringify({ version: 1, approved, pending }, null, 2)}\n`;
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, body, 'utf8');
    renameSync(tmp, file);
    try {
      lastMtimeMs = statSync(file).mtimeMs;
    } catch {
      lastMtimeMs = 0;
    }
  }

  /**
   * @param {string} channel
   * @param {string} senderId
   * @returns {PendingEntry | undefined}
   */
  function findPending(channel, senderId) {
    prunePending();
    return pending.find((entry) => entry.channel === channel && entry.senderId === senderId);
  }

  return {
    /**
     * Return an existing unexpired code or issue a new one.
     * @param {{ channel: string, senderId: string, name?: string }} input
     * @returns {{ code: string, created: boolean, expiresAt: number }}
     */
    request(input) {
      refreshFromDisk();
      prunePending();
      const existing = findPending(input.channel, input.senderId);
      if (existing !== undefined) {
        return { code: existing.code, created: false, expiresAt: existing.createdAt + ttlSec * 1000 };
      }
      const taken = new Set(pending.map((entry) => entry.code));
      let code = '';
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const candidate = String(randomInt(0, 1_000_000)).padStart(6, '0');
        if (!taken.has(candidate)) {
          code = candidate;
          break;
        }
      }
      if (code === '') code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      const entry = { code, channel: input.channel, senderId: input.senderId, name: input.name, createdAt: now() };
      pending.push(entry);
      flush();
      return { code, created: true, expiresAt: entry.createdAt + ttlSec * 1000 };
    },

    /**
     * Approve a pending code. The sender joins the allowlist.
     * @param {string} code
     * @returns {{ ok: true, entry: ApprovedEntry } | { ok: false, reason: string }}
     */
    approve(code) {
      refreshFromDisk();
      prunePending();
      const found = pending.find((entry) => entry.code === String(code).trim());
      if (found === undefined) {
        return { ok: false, reason: '配对码不存在或已过期' };
      }
      pending = pending.filter((entry) => entry !== found);
      const already = approved.some((entry) => entry.channel === found.channel && entry.senderId === found.senderId);
      if (!already) {
        approved.push({ channel: found.channel, senderId: found.senderId, name: found.name, addedAt: now() });
      }
      flush();
      return {
        ok: true,
        entry: { channel: found.channel, senderId: found.senderId, name: found.name, addedAt: now() },
      };
    },

    /**
     * Directly allow a sender (operator convenience).
     * @param {{ channel: string, senderId: string, name?: string }} input
     * @returns {ApprovedEntry}
     */
    allow(input) {
      refreshFromDisk();
      // A direct allow supersedes any pending pairing code for the same sender.
      pending = pending.filter((entry) => !(entry.channel === input.channel && entry.senderId === input.senderId));
      const existing = approved.find((entry) => entry.channel === input.channel && entry.senderId === input.senderId);
      if (existing !== undefined) {
        flush();
        return existing;
      }
      const entry = { channel: input.channel, senderId: input.senderId, name: input.name, addedAt: now() };
      approved.push(entry);
      flush();
      return entry;
    },

    /** @param {string} channel @param {string} senderId */
    revoke(channel, senderId) {
      refreshFromDisk();
      const before = approved.length;
      approved = approved.filter((entry) => !(entry.channel === channel && entry.senderId === senderId));
      if (approved.length !== before) flush();
      return approved.length !== before;
    },

    /** @param {string} channel @param {string} senderId */
    isApproved(channel, senderId) {
      refreshFromDisk();
      return approved.some((entry) => entry.channel === channel && entry.senderId === senderId);
    },

    /** @returns {ApprovedEntry[]} */
    listApproved() {
      refreshFromDisk();
      return [...approved];
    },

    /** @returns {PendingEntry[]} */
    listPending() {
      refreshFromDisk();
      prunePending();
      return [...pending];
    },

    get ttlSec() {
      return ttlSec;
    },

    flush,
  };
}
