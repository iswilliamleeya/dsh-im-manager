/**
 * Durable conversation -> DSH session mapping.
 *
 * Scope model (see docs/architecture.md「生效范围」):
 * - one gateway instance owns exactly ONE workspace (`dsh.cwd`);
 * - inside that workspace, every IM conversation (channel/account/chat/topic)
 *   gets its own DSH session;
 * - the mapping file records the workspace fingerprint so a state directory
 *   accidentally shared by two workspaces cannot resume a session that belongs
 *   to another project (which would point the agent at the wrong files).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';

/**
 * @typedef {Object} SessionEntry
 * @property {string} sessionId
 * @property {number} createdAt
 * @property {number} lastUsedAt
 */

/**
 * @typedef {Object} WorkspaceFingerprint
 * @property {string} cwd
 * @property {string} [dshHome]
 */

/**
 * Compare two workspace fingerprints. A missing dshHome means "default home
 * resolved by the child process", which is compatible with an explicitly empty
 * one.
 * @param {WorkspaceFingerprint | undefined} a
 * @param {WorkspaceFingerprint | undefined} b
 * @returns {boolean}
 */
export function sameWorkspace(a, b) {
  if (a === undefined || b === undefined) return true;
  return a.cwd === b.cwd && (a.dshHome ?? '') === (b.dshHome ?? '');
}

/**
 * @param {{
 *   file?: string | null,
 *   now?: () => number,
 *   uuid?: () => string,
 *   workspace?: WorkspaceFingerprint | null,
 * }} [options]
 */
export function createSessionStore(options = {}) {
  const now = options.now ?? Date.now;
  const uuid = options.uuid ?? randomUUID;
  const file = options.file ?? null;
  const workspace = options.workspace ?? null;
  /** @type {Map<string, SessionEntry>} */
  const sessions = new Map();
  /** @type {{ stored: WorkspaceFingerprint, current: WorkspaceFingerprint } | null} */
  let workspaceMismatch = null;

  if (file !== null && existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      const storedWorkspace = parsed?.workspace;
      if (
        workspace !== null
        && storedWorkspace !== undefined
        && storedWorkspace !== null
        && typeof storedWorkspace === 'object'
        && !sameWorkspace(storedWorkspace, workspace)
      ) {
        // Never reuse conversation -> session bindings across workspaces.
        workspaceMismatch = {
          stored: { cwd: String(storedWorkspace.cwd ?? ''), dshHome: storedWorkspace.dshHome },
          current: workspace,
        };
      } else {
        const stored = parsed?.sessions;
        if (stored !== null && typeof stored === 'object') {
          for (const [key, entry] of Object.entries(stored)) {
            if (typeof entry?.sessionId === 'string' && entry.sessionId.length > 0) {
              sessions.set(key, {
                sessionId: entry.sessionId,
                createdAt: Number(entry.createdAt) || now(),
                lastUsedAt: Number(entry.lastUsedAt) || now(),
              });
            }
          }
        }
      }
    } catch {
      // A corrupt map starts empty; the user can /new to recover.
    }
  }

  function flush() {
    if (file === null) return;
    mkdirSync(dirname(file), { recursive: true });
    /** @type {Record<string, SessionEntry>} */
    const out = {};
    for (const [key, entry] of sessions) out[key] = entry;
    const body = `${JSON.stringify({
      version: 2,
      ...(workspace === null ? {} : { workspace }),
      sessions: out,
    }, null, 2)}\n`;
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, body, 'utf8');
    renameSync(tmp, file);
  }

  return {
    /**
     * @param {string} key
     * @returns {SessionEntry | undefined}
     */
    get(key) {
      return sessions.get(key);
    },
    /**
     * Return the existing session id, creating one on first contact.
     * @param {string} key
     * @returns {{ sessionId: string, created: boolean }}
     */
    ensure(key) {
      const existing = sessions.get(key);
      if (existing !== undefined) {
        existing.lastUsedAt = now();
        return { sessionId: existing.sessionId, created: false };
      }
      const entry = { sessionId: uuid(), createdAt: now(), lastUsedAt: now() };
      sessions.set(key, entry);
      flush();
      return { sessionId: entry.sessionId, created: true };
    },
    /**
     * Allocate a fresh session id and replace the binding.
     * @param {string} key
     * @returns {SessionEntry}
     */
    reset(key) {
      const entry = { sessionId: uuid(), createdAt: now(), lastUsedAt: now() };
      sessions.set(key, entry);
      flush();
      return entry;
    },
    /** @param {string} key */
    touch(key) {
      const entry = sessions.get(key);
      if (entry !== undefined) {
        entry.lastUsedAt = now();
        flush();
      }
    },
    /** @param {string} key */
    remove(key) {
      const removed = sessions.delete(key);
      if (removed) flush();
      return removed;
    },
    /** @returns {Array<{ key: string } & SessionEntry>} */
    list() {
      return [...sessions.entries()].map(([key, entry]) => ({ key, ...entry }));
    },
    /** Workspace mismatch detected while loading (bindings were discarded). */
    get workspaceMismatch() {
      return workspaceMismatch;
    },
    /** Workspace fingerprint written by this store. */
    get workspace() {
      return workspace;
    },
    get size() {
      return sessions.size;
    },
    flush,
  };
}
