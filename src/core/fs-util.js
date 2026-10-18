/** Small filesystem helpers shared by the gateway state stores. */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Write JSON atomically (temp file + rename) and return the path.
 * @param {string} file
 * @param {unknown} value
 * @param {number} [indent]
 */
export function writeJsonAtomic(file, value, indent = 2) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, indent)}\n`, 'utf8');
  renameSync(tmp, file);
  return file;
}

/** Create a directory (idempotent) and return it. */
export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
  return dir;
}
