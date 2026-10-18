/**
 * Persistent inbound-message dedupe. IM platforms retry callbacks aggressively
 * (Feishu 3s, DingTalk stream ACK, WeCom 5s); the gateway must collapse replays
 * before they reach the Agent.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * @param {{
 *   file?: string | null,
 *   ttlMs?: number,
 *   maxEntries?: number,
 *   now?: () => number,
 *   persistDebounceMs?: number,
 * }} [options]
 */
export function createDedupe(options = {}) {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1000;
  const maxEntries = options.maxEntries ?? 5000;
  const file = options.file ?? null;
  const persistDebounceMs = options.persistDebounceMs ?? 1500;
  /** @type {Map<string, number>} */
  const seen = new Map();
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;

  if (file !== null && existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
      for (const entry of entries) {
        if (typeof entry?.key === 'string' && Number.isFinite(entry?.at)) seen.set(entry.key, entry.at);
      }
    } catch {
      // A corrupt dedupe cache is safe to drop; worst case a retried message is replayed once.
    }
  }

  function prune() {
    const cutoff = now() - ttlMs;
    for (const [key, at] of seen) {
      if (at < cutoff) seen.delete(key);
    }
    if (seen.size > maxEntries) {
      const sorted = [...seen.entries()].sort((a, b) => a[1] - b[1]);
      for (const [key] of sorted.slice(0, seen.size - maxEntries)) seen.delete(key);
    }
  }

  function scheduleSave() {
    if (file === null || timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      flush();
    }, persistDebounceMs);
    timer.unref?.();
  }

  function flush() {
    if (file === null) return;
    prune();
    mkdirSync(dirname(file), { recursive: true });
    const body = `${JSON.stringify({
      version: 1,
      entries: [...seen.entries()].map(([key, at]) => ({ key, at })),
    })}\n`;
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, body, 'utf8');
    renameSync(tmp, file);
  }

  return {
    /**
     * Record a message id and report whether it was new.
     * @param {string} key
     * @returns {boolean} true when the caller may proceed, false for a replay
     */
    checkAndAdd(key) {
      prune();
      if (seen.has(key)) return false;
      seen.set(key, now());
      scheduleSave();
      return true;
    },
    /** @param {string} key */
    has(key) {
      prune();
      return seen.has(key);
    },
    /** @param {string} key */
    delete(key) {
      return seen.delete(key);
    },
    get size() {
      prune();
      return seen.size;
    },
    flush,
    close() {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      flush();
    },
  };
}
