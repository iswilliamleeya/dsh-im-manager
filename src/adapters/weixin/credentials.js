/**
 * Credential store for the personal WeChat channel.
 *
 * The QR login flow writes a single JSON file (`credentials.json` by default,
 * override with `channels.weixin.credentialsFile`):
 *
 * ```json
 * {
 *   "version": 1,
 *   "token": "<bot token — secret>",
 *   "ilinkBotId": "<bot account id>",
 *   "userId": "<scanning user id, optional>",
 *   "baseUrl": "https://<api host>",
 *   "savedAt": "2026-01-01T00:00:00.000Z"
 * }
 * ```
 *
 * Security rules:
 *   - file mode `0600`, directory `0700`
 *   - atomic write (temp file + rename) so a crash never leaves a partial file
 *   - the token is never printed, logged, or embedded in an Error message;
 *     `redactCredential()` is the only supported way to display a credential
 *
 * @see docs/channels/weixin.md §4
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { normalizeBaseUrl } from './protocol.js';

/** On-disk credential schema version. */
export const CREDENTIAL_VERSION = 1;

/**
 * Expand a leading `~` (the gateway expands `~` for its own paths, but a
 * `credentialsFile` may be hand-written too).
 * @param {string} value
 * @returns {string}
 */
export function expandUserPath(value) {
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return join(homedir(), value.slice(2));
  return value;
}

/**
 * Absolute credential file path for a channel state dir + config.
 *
 * - empty `credentialsFile` → `<stateDir>/credentials.json`
 * - absolute path → used as-is (`~` expanded)
 * - relative path → resolved against `<stateDir>`
 *
 * @param {string} stateDir channel state directory (`ctx.stateDir`)
 * @param {{ credentialsFile?: string } | undefined} [config]
 * @returns {string} absolute path
 */
export function credentialPath(stateDir, config = {}) {
  const baseDir = resolve(String(stateDir ?? '.'));
  const configured = typeof config?.credentialsFile === 'string' ? config.credentialsFile.trim() : '';
  if (configured === '') return join(baseDir, 'credentials.json');
  const expanded = expandUserPath(configured);
  return isAbsolute(expanded) ? resolve(expanded) : resolve(baseDir, expanded);
}

/**
 * Validate + canonicalize a credential object before it is written.
 * Throws a TypeError (never containing the token) on malformed input.
 *
 * @param {Record<string, unknown>} credential
 * @param {{ now?: () => number }} [options]
 * @returns {{ version: 1, token: string, ilinkBotId: string, userId?: string, baseUrl: string, savedAt: string }}
 */
export function normalizeCredential(credential, options = {}) {
  if (credential === null || typeof credential !== 'object' || Array.isArray(credential)) {
    throw new TypeError('weixin credential must be an object');
  }
  const token = typeof credential.token === 'string' ? credential.token.trim() : '';
  if (token === '') throw new TypeError('weixin credential is missing its token');
  const ilinkBotId = typeof credential.ilinkBotId === 'string' ? credential.ilinkBotId.trim() : '';
  if (ilinkBotId === '') throw new TypeError('weixin credential is missing ilinkBotId');
  let baseUrl;
  try {
    baseUrl = normalizeBaseUrl(credential.baseUrl);
  } catch (error) {
    throw new TypeError(`weixin credential has an invalid baseUrl: ${error instanceof Error ? error.message : String(error)}`);
  }
  const userId =
    typeof credential.userId === 'string' && credential.userId.trim() !== '' ? credential.userId.trim() : undefined;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  let savedAt;
  if (typeof credential.savedAt === 'string' && credential.savedAt.trim() !== '') {
    savedAt = credential.savedAt.trim();
  } else if (Number.isFinite(credential.savedAt)) {
    savedAt = new Date(Number(credential.savedAt)).toISOString();
  } else {
    savedAt = new Date(now()).toISOString();
  }
  return {
    version: CREDENTIAL_VERSION,
    token,
    ilinkBotId,
    ...(userId ? { userId } : {}),
    baseUrl,
    savedAt,
  };
}

/**
 * Read + validate a credential file. Returns `undefined` when the file is
 * absent, unreadable, corrupt, or structurally invalid (treated as logged out).
 *
 * @param {string} file absolute path
 * @returns {{ version: 1, token: string, ilinkBotId: string, userId?: string, baseUrl: string, savedAt: string } | undefined}
 */
export function readCredentialFile(file) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  if (parsed.version !== CREDENTIAL_VERSION) return undefined;
  try {
    return normalizeCredential(parsed);
  } catch {
    return undefined;
  }
}

/**
 * Atomically write a credential file with mode `0600`.
 * @param {string} file absolute path
 * @param {Record<string, unknown>} credential
 * @param {{ now?: () => number }} [options]
 * @returns {string} the file path
 */
export function writeCredentialFile(file, credential, options = {}) {
  const normalized = normalizeCredential(credential, options);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  // Unique temp name: concurrent login/CLI invocations must not clobber each other.
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, file);
    try {
      chmodSync(file, 0o600);
    } catch {
      // chmod can be unsupported on exotic filesystems; the create mode still applies.
    }
  } catch (error) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // best effort cleanup
    }
    throw error;
  }
  return file;
}

/**
 * Delete a credential file.
 * @param {string} file absolute path
 * @returns {boolean} true when a file was removed
 */
export function deleteCredentialFile(file) {
  if (!existsSync(file)) return false;
  try {
    rmSync(file, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the credential for a channel state dir + config.
 * @param {string} stateDir
 * @param {{ credentialsFile?: string }} [config]
 */
export function readCredential(stateDir, config) {
  return readCredentialFile(credentialPath(stateDir, config));
}

/**
 * Write the credential for a channel state dir + config.
 * @param {string} stateDir
 * @param {{ credentialsFile?: string }} [config]
 * @param {Record<string, unknown>} credential
 * @param {{ now?: () => number }} [options]
 */
export function writeCredential(stateDir, config, credential, options = {}) {
  return writeCredentialFile(credentialPath(stateDir, config), credential, options);
}

/**
 * Delete the credential for a channel state dir + config.
 * @param {string} stateDir
 * @param {{ credentialsFile?: string }} [config]
 * @returns {boolean}
 */
export function deleteCredential(stateDir, config) {
  return deleteCredentialFile(credentialPath(stateDir, config));
}

/**
 * Redacted, token-free summary of a credential for CLI/diagnostics output.
 * @param {{ token?: unknown, ilinkBotId?: unknown, userId?: unknown, baseUrl?: unknown, savedAt?: unknown } | undefined} credential
 * @returns {{ ilinkBotId: string, userId?: string, baseUrl: string, savedAt: string }}
 */
export function redactCredential(credential) {
  const source = credential !== null && typeof credential === 'object' ? credential : {};
  const ilinkBotId = typeof source.ilinkBotId === 'string' ? source.ilinkBotId : '';
  const userId = typeof source.userId === 'string' && source.userId !== '' ? source.userId : undefined;
  const baseUrl = typeof source.baseUrl === 'string' ? source.baseUrl : '';
  const savedAt = typeof source.savedAt === 'string' ? source.savedAt : '';
  return {
    ilinkBotId,
    ...(userId ? { userId } : {}),
    baseUrl,
    savedAt,
  };
}

/**
 * Cheap change-detection signature for the credential file (`mtimeMs:size`).
 * Returns `''` when the file does not exist. The adapter polls this every few
 * seconds so a QR login performed while the gateway is running is picked up
 * automatically.
 *
 * @param {string} file absolute path
 * @returns {string}
 */
export function credentialFileSignature(file) {
  try {
    const stat = statSync(file);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return '';
  }
}
