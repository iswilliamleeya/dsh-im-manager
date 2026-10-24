/**
 * Version updater for the dsh-im-manager host plugin.
 *
 * Framework-free and dependency-injected so it can be unit-tested without a
 * DSH host: the only host-specific pieces are `ctx.get('pluginManager')` (used
 * lazily, at install time) and the `$DSH_HOME` state file.
 *
 * Discovery does **not** use the GitHub REST API (shared egress IPs are often
 * rate-limited with 403 and no token is available). Instead, in order:
 *
 *   1. `https://github.com/<slug>/tags.atom`      (authoritative tag list)
 *   2. `git ls-remote --tags https://github.com/<slug>.git`
 *   3. `https://github.com/<slug>/releases.atom`  (fallback; occasionally 000)
 *
 * Tag names must come from `<id>` (`tag:github.com,2008:Repository/<n>/<tag>`)
 * or the entry `<link href>`; GitHub writes release titles into `<title>` for
 * older tags, so `<title>` is display-only and must never be parsed as a tag.
 * Once a tag is chosen, `releases.atom` is fetched once more (best effort) for
 * release notes.
 *
 * @module dsh-im-manager/src/host/update
 */

import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** The plugin's own manifest; never hardcode version/repository. */
export const PACKAGE_JSON_URL = new URL('../../package.json', import.meta.url);

/** Timeout for one Atom HTTP request. */
export const FETCH_TIMEOUT_MS = 8_000;
/** Timeout for the `git ls-remote` fallback. */
export const LS_REMOTE_TIMEOUT_MS = 15_000;
/** An `available` check may only be installed within this window. */
export const CHECK_TTL_MS = 10 * 60 * 1000;
/** After this age an `installing` state left behind by an HMR reload is reconciled. */
export const STALE_INSTALL_MS = 5 * 60 * 1000;
/** State file name under `$DSH_HOME`. */
export const STATE_FILE_NAME = 'im-manager-update.json';

const NOTES_LIMIT = 600;
const OUTPUT_LIMIT = 800;
const IGNORED_BUILDS_HINT = '依赖需要允许构建脚本：请到 DSH『插件』页允许这些脚本后重试检查更新';
const FETCH_UA = 'dsh-im-manager-updater';
const ATOM_ACCEPT = 'application/atom+xml, application/xml, text/xml';
const VERSION_RE = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;
const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
const SOURCE_LABELS = { tag: 'tags.atom', git: 'git ls-remote', release: 'releases.atom' };
const STATUSES = new Set([
  'idle', 'checking', 'available', 'up_to_date', 'installing', 'installed', 'restart_required', 'error',
]);

// ── Pure helpers (exported and unit-tested) ─────────────────────────────────

/**
 * Extract `owner/repo` from a package.json `repository` field.
 *
 * Accepted shapes: `git+https://github.com/o/r.git`, `https://github.com/o/r`,
 * `git@github.com:o/r.git`, plain strings, and `{ url }` objects.
 *
 * @param {any} packageJson
 * @returns {string | null}
 */
export function parseRepoSlug(packageJson) {
  if (packageJson === null || typeof packageJson !== 'object') return null;
  const repository = packageJson.repository;
  let raw;
  if (typeof repository === 'string') raw = repository;
  else if (repository instanceof URL) raw = repository.href;
  else if (repository !== null && typeof repository === 'object' && typeof repository.url === 'string') raw = repository.url;
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  let text = raw.trim().replace(/^git\+/, '');
  text = text.replace(/^git@([^:]+):/, 'https://$1/');
  const match = /(?:www\.)?github\.com\/([^/\s#?]+)\/([^/\s#?]+?)(?:\.git)?(?:[#?].*)?$/i.exec(text);
  if (match === null) return null;
  const owner = match[1];
  const repo = match[2];
  if (owner.length === 0 || repo.length === 0) return null;
  return `${owner}/${repo}`;
}

/**
 * Normalize a tag into a bare semver string (`v0.3.3` → `0.3.3`).
 * Returns null for anything outside `^v?\d+\.\d+\.\d+(-prerelease)?$`.
 *
 * @param {unknown} tag
 * @returns {string | null}
 */
export function normalizeVersion(tag) {
  if (typeof tag !== 'string') return null;
  const match = VERSION_RE.exec(tag.trim());
  return match === null ? null : match[1];
}

/** @param {string} version @returns {boolean} */
function isPrerelease(version) {
  return typeof version === 'string' && version.includes('-');
}

/** @param {string} value */
function parseSemver(value) {
  if (typeof value !== 'string') return null;
  const match = SEMVER_RE.exec(value.trim());
  if (match === null) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
  };
}

/**
 * Semver comparison (numeric core + prerelease precedence).
 * `compareVersions('0.10.0', '0.9.0') === 1`, `compareVersions('0.4.0-rc.1', '0.4.0') === -1`.
 *
 * @param {string} a
 * @param {string} b
 * @returns {-1 | 0 | 1}
 */
export function compareVersions(a, b) {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (left === null) throw new TypeError(`compareVersions: invalid version ${JSON.stringify(a)}`);
  if (right === null) throw new TypeError(`compareVersions: invalid version ${JSON.stringify(b)}`);
  for (let index = 0; index < 3; index += 1) {
    if (left.core[index] !== right.core[index]) return left.core[index] > right.core[index] ? 1 : -1;
  }
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0;
  if (left.prerelease.length === 0) return 1;
  if (right.prerelease.length === 0) return -1;
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const lhs = left.prerelease[index];
    const rhs = right.prerelease[index];
    if (lhs === undefined) return -1;
    if (rhs === undefined) return 1;
    const lhsNumeric = /^\d+$/.test(lhs);
    const rhsNumeric = /^\d+$/.test(rhs);
    if (lhsNumeric && rhsNumeric) {
      const lhsValue = Number(lhs);
      const rhsValue = Number(rhs);
      if (lhsValue !== rhsValue) return lhsValue > rhsValue ? 1 : -1;
    } else if (lhsNumeric) {
      return -1;
    } else if (rhsNumeric) {
      return 1;
    } else if (lhs !== rhs) {
      return lhs > rhs ? 1 : -1;
    }
  }
  return 0;
}

/** @param {string} value */
function decodeEntities(value) {
  /** @param {number} code */
  const fromCode = (code) => (Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '');
  return String(value)
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex) => fromCode(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, decimal) => fromCode(Number(decimal)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** @param {string} body @param {string} tag */
function pickTag(body, tag) {
  const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(body);
  if (match === null) return null;
  return decodeEntities(match[1].replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '')).trim();
}

/** @param {string} attrs @param {string} name */
function pickAttribute(attrs, name) {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(attrs);
  if (match === null) return null;
  return decodeEntities(match[1] ?? match[2] ?? '').trim();
}

/**
 * Tag from an Atom entry `<id>`: `tag:github.com,2008:Repository/1424550688/v0.2.2`.
 * @param {string | null} id
 */
function tagFromId(id) {
  if (typeof id !== 'string' || id.length === 0) return null;
  const match = /Repository\/\d+\/([^/\s]+)\s*$/.exec(id);
  return match === null ? null : match[1];
}

/**
 * Tag from an entry link: `…/releases/tag/v0.2.2` or `…/tags/v0.2.2`.
 * @param {string | null} url
 */
function tagFromLink(url) {
  if (typeof url !== 'string' || url.length === 0) return null;
  const match = /\/(?:releases\/tag|tags)\/([^/?#\s]+)\/?$/.exec(url);
  if (match === null) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

/** @param {string | null} content */
function cleanNotes(content) {
  if (typeof content !== 'string' || content.length === 0) return '';
  let text = decodeEntities(content);
  text = text
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(?:p|div|li|ul|ol|pre|blockquote|h[1-6])>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\s*\n\s*/g, ' ')
    .trim();
  return text.length > NOTES_LIMIT ? text.slice(0, NOTES_LIMIT) : text;
}

/**
 * Parse a GitHub Atom feed into version entries without third-party parsers.
 *
 * `<title>` is deliberately only used as a last resort when it is itself a
 * version: GitHub writes release titles into it for old tags.
 *
 * @param {string} xml
 * @returns {{ tag: string, version: string | null, url: string | null, updatedAt: string | null, notes: string }[]}
 */
export function parseAtomEntries(xml) {
  if (typeof xml !== 'string' || xml.length === 0) return [];
  const entries = [];
  for (const match of xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)) {
    const body = match[1];
    const id = pickTag(body, 'id');
    const links = [...body.matchAll(/<link\b([^>]*?)\/?>/gi)]
      .map((link) => pickAttribute(link[1], 'href'))
      .filter((href) => typeof href === 'string' && href.length > 0);
    const url = links.find((href) => /\/(?:releases\/tag|tags)\//.test(href)) ?? links[0] ?? null;
    const title = pickTag(body, 'title');
    const tag = tagFromId(id) ?? tagFromLink(url) ?? (normalizeVersion(title) === null ? null : title.trim());
    if (tag === null || tag.length === 0) continue;
    entries.push({
      tag,
      version: normalizeVersion(tag),
      url,
      updatedAt: pickTag(body, 'updated'),
      notes: cleanNotes(pickTag(body, 'content')),
    });
  }
  return entries;
}

/**
 * Pick the greatest version from parsed Atom entries.
 * Prereleases are skipped unless `includePrerelease` is true (the installed
 * version itself is a prerelease).
 *
 * @param {any[]} entries
 * @param {{ includePrerelease?: boolean }} [options]
 * @returns {{ tag: string, version: string, url: string | null, updatedAt: string | null, notes: string } | null}
 */
export function selectLatest(entries, options = {}) {
  const includePrerelease = options.includePrerelease === true;
  let best = null;
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry === null || typeof entry !== 'object') continue;
    const version = typeof entry.version === 'string' ? entry.version : normalizeVersion(entry.tag);
    if (version === null) continue;
    if (!includePrerelease && isPrerelease(version)) continue;
    if (best === null || compareVersions(version, best.version) > 0) best = { ...entry, version };
  }
  return best;
}

/**
 * Build the plugin-manager install spec (`github:owner/repo#vX.Y.Z`).
 *
 * @param {string} slug
 * @param {string} tag
 * @returns {string}
 */
export function buildGithubSpec(slug, tag) {
  if (typeof slug !== 'string' || slug.trim().length === 0) throw new TypeError('buildGithubSpec: slug is required');
  if (typeof tag !== 'string' || tag.trim().length === 0) throw new TypeError('buildGithubSpec: tag is required');
  return `github:${slug.trim()}#${tag.trim()}`;
}

/** @param {string} text @param {number} limit */
function clip(text, limit) {
  const value = String(text ?? '');
  return value.length > limit ? value.slice(0, limit) : value;
}

/** @param {unknown} cause */
function shortReason(cause) {
  const message = cause instanceof Error ? cause.message : String(cause ?? '');
  return clip(message.replace(/\s+/g, ' ').trim() || '请求失败', 120);
}

/** @param {string} value */
function stripAnsi(value) {
  return String(value).replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, ' ');
}

/** @param {string} value */
function squeezeWhitespace(value) {
  return String(value)
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\s*\n\s*/g, ' ')
    .trim();
}

/**
 * Extract the actionable pnpm error lines from install output. pnpm prints
 * `[ERR_PNPM_*]` / `ERROR` lines among `Progress:` noise; taking the tail of the
 * whole log can start mid-word or mid-Progress-line.
 *
 * @param {string} output
 * @returns {string} joined error lines, or `''` when none match
 */
function extractPnpmErrorLines(output) {
  // pnpm prints progress with bare carriage returns, so treat \r as a line break too.
  const lines = stripAnsi(output).split(/\r\n|\r|\n/).map((line) => squeezeWhitespace(line)).filter(Boolean);
  const matched = [];
  for (const line of lines) {
    if (/ERR_PNPM_[A-Z0-9_]+/.test(line) || /^ERROR\b/.test(line)) matched.push(line);
  }
  if (matched.length === 0) return '';
  return clip([...new Set(matched)].join('；'), OUTPUT_LIMIT);
}

/**
 * Fallback for installs whose log has no recognizable pnpm error line: keep the
 * last 800 characters (the existing behavior).
 *
 * @param {string} output
 * @returns {string}
 */
function pnpmOutputFallback(output) {
  const plain = squeezeWhitespace(stripAnsi(output));
  return plain.length > OUTPUT_LIMIT ? plain.slice(-OUTPUT_LIMIT) : plain;
}

/**
 * pnpm refuses to run dependency build scripts unless the user allows them.
 * Detect it so the message can point at the DSH Plugins page instead of only
 * dumping the raw pnpm log.
 *
 * @param {unknown} output
 * @returns {boolean}
 */
function hasIgnoredBuilds(output) {
  if (typeof output !== 'string' || output.length === 0) return false;
  return output.includes('ERR_PNPM_IGNORED_BUILDS') || output.includes('Ignored build scripts');
}

/** @param {unknown} error */
function updateError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// ── Default (production) implementations ────────────────────────────────────

/** @returns {any} */
function defaultReadManifest() {
  return JSON.parse(readFileSync(PACKAGE_JSON_URL, 'utf8'));
}

/** @returns {string} */
function defaultReadVersion() {
  const manifest = defaultReadManifest();
  return typeof manifest?.version === 'string' ? manifest.version : '';
}

/** @returns {string} */
function defaultStatePath() {
  const configured = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : '';
  const home = configured.length > 0 ? configured : join(homedir(), '.dsh');
  return join(home, STATE_FILE_NAME);
}

/**
 * Fetch one URL as text with the updater's timeout/headers.
 * @param {string} url
 * @returns {Promise<string>}
 */
async function defaultFetch(url) {
  if (typeof globalThis.fetch !== 'function') throw new Error('fetch is not available in this runtime');
  const response = await globalThis.fetch(url, {
    headers: { 'user-agent': FETCH_UA, accept: ATOM_ACCEPT },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    redirect: 'follow',
  });
  if (response === null || response === undefined || response.ok !== true) {
    throw new Error(`HTTP ${response?.status ?? 'unknown'}`);
  }
  return response.text();
}

/**
 * Run `git ls-remote --tags https://github.com/<slug>.git` and return stdout.
 * The caller treats a missing git binary (ENOENT) like any other failure.
 *
 * @param {string} slug
 * @returns {Promise<string>}
 */
export function defaultLsRemote(slug) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn('git', ['ls-remote', '--tags', `https://github.com/${slug}.git`], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: LS_REMOTE_TIMEOUT_MS,
      });
    } catch (error) {
      reject(error);
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    /** @param {Error} error */
    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (error === null) resolve(stdout);
      else reject(error);
    };
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => finish(error));
    child.on('close', (code, signal) => {
      if (code === 0) finish(null);
      else finish(new Error(signal === null || signal === undefined
        ? (stderr.trim() || `git exited with code ${code}`)
        : `git terminated by ${signal}`));
    });
  });
}

// ── Service ────────────────────────────────────────────────────────────────

/** @returns {any} */
function emptyState() {
  return {
    version: 1,
    status: 'idle',
    currentVersion: null,
    latestVersion: null,
    tag: null,
    releaseUrl: null,
    source: null,
    notes: '',
    checkedAt: null,
    startedAt: null,
    finishedAt: null,
    message: '',
    error: null,
  };
}

/** @param {any} raw */
function normalizeState(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return emptyState();
  const state = { ...emptyState(), ...raw, version: 1 };
  if (!STATUSES.has(state.status)) state.status = 'idle';
  if (state.error !== null && (typeof state.error !== 'object' || typeof state.error?.message !== 'string')) state.error = null;
  return state;
}

/**
 * Create the updater service used by the host RPC surface.
 *
 * Everything the service touches is injectable so tests never hit the network
 * or the real `$DSH_HOME`:
 *
 * @param {{
 *   ctx?: any,
 *   pluginManager?: any,
 *   fetchImpl?: (url: string) => Promise<string>,
 *   lsRemote?: (slug: string) => Promise<string>,
 *   readVersion?: () => string | Promise<string>,
 *   readPackage?: () => any,
 *   statePath?: string,
 *   now?: () => Date | string | number,
 *   packageName?: string,
 *   repo?: string | null,
 * }} [options]
 */
export function createUpdateService(options = {}) {
  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : defaultFetch;
  const lsRemote = typeof options.lsRemote === 'function' ? options.lsRemote : defaultLsRemote;
  const readVersion = typeof options.readVersion === 'function' ? options.readVersion : defaultReadVersion;
  const readPackage = typeof options.readPackage === 'function' ? options.readPackage : defaultReadManifest;
  const statePath = typeof options.statePath === 'string' && options.statePath.length > 0
    ? options.statePath
    : defaultStatePath();
  const now = typeof options.now === 'function' ? options.now : () => new Date();

  /** @type {string | null} */
  let active = null;
  /** @type {any} */
  let memoryState = null;

  /** @returns {Date} */
  const clock = () => {
    const value = now();
    return value instanceof Date ? value : new Date(value);
  };
  const iso = () => clock().toISOString();
  const nowMs = () => clock().getTime();

  /** @returns {any} */
  function readManifest() {
    try {
      const manifest = readPackage();
      return manifest !== null && typeof manifest === 'object' ? manifest : {};
    } catch {
      return {};
    }
  }

  /** @param {any} manifest */
  function resolvePackageName(manifest) {
    if (Object.prototype.hasOwnProperty.call(options, 'packageName')) return options.packageName ?? '';
    return typeof manifest?.name === 'string' ? manifest.name : '';
  }

  /** @param {any} manifest @returns {string | null} */
  function resolveRepo(manifest) {
    if (Object.prototype.hasOwnProperty.call(options, 'repo')) return options.repo ?? null;
    return parseRepoSlug(manifest);
  }

  /** @param {string} [fallback] @returns {Promise<string>} */
  async function resolveCurrentVersion(fallback = '') {
    try {
      const value = await readVersion();
      if (typeof value === 'string' && value.trim().length > 0) return value.trim();
    } catch {
      // unreadable manifest: fall back to the persisted value
    }
    return typeof fallback === 'string' ? fallback : '';
  }

  /** @returns {any | null} */
  function findPluginManager() {
    const injected = options.pluginManager;
    if (injected !== null && injected !== undefined) {
      if (typeof injected.installBundle === 'function') return injected;
      if (typeof injected.get === 'function') {
        try {
          const value = injected.get('pluginManager');
          if (value !== null && value !== undefined) return value;
        } catch {
          return null;
        }
      }
    }
    if (options.ctx !== null && options.ctx !== undefined && typeof options.ctx.get === 'function') {
      try {
        return options.ctx.get('pluginManager') ?? null;
      } catch {
        return null;
      }
    }
    return null;
  }

  const autoInstallAvailable = () => {
    const pluginManager = findPluginManager();
    return pluginManager !== null && typeof pluginManager.installBundle === 'function';
  };

  /** @returns {any} */
  function readStateSync() {
    try {
      memoryState = normalizeState(JSON.parse(readFileSync(statePath, 'utf8')));
    } catch {
      if (memoryState === null) memoryState = emptyState();
    }
    return memoryState;
  }

  /** @param {any} next @returns {any} */
  function persistState(next) {
    const state = normalizeState(next);
    memoryState = state;
    try {
      mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });
      const temp = `${statePath}.${process.pid}.${clock().getTime()}.${Math.random().toString(16).slice(2)}.tmp`;
      writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      try {
        chmodSync(temp, 0o600);
      } catch {
        // best effort: the umask may already allow it
      }
      renameSync(temp, statePath);
      try {
        chmodSync(statePath, 0o600);
      } catch {
        // best effort
      }
    } catch {
      // Persistence is best effort; memoryState still keeps this instance consistent.
    }
    return state;
  }

  /** @param {string} source @param {string} repo @returns {Promise<any[]>} */
  async function fetchAtomEntries(source, repo) {
    const url = source === 'tag'
      ? `https://github.com/${repo}/tags.atom`
      : `https://github.com/${repo}/releases.atom`;
    const xml = await fetchImpl(url);
    const entries = parseAtomEntries(typeof xml === 'string' ? xml : String(xml ?? ''));
    if (entries.length === 0) throw new Error('响应中没有可解析的 tag');
    return entries;
  }

  /** @param {string} text @returns {any[]} */
  function parseLsRemoteOutput(text) {
    const entries = [];
    for (const line of String(text ?? '').split(/\r?\n/)) {
      const ref = line.trim().split(/\s+/).pop();
      if (typeof ref !== 'string' || !ref.startsWith('refs/tags/')) continue;
      if (ref.endsWith('^{}')) continue;
      const tag = ref.slice('refs/tags/'.length);
      if (tag.length === 0) continue;
      entries.push({
        tag,
        version: normalizeVersion(tag),
        url: null,
        updatedAt: null,
        notes: '',
      });
    }
    return entries;
  }

  /** @param {string} repo @param {any} candidate @returns {Promise<string>} */
  async function fetchReleaseNotes(repo, candidate) {
    try {
      const entries = await fetchAtomEntries('release', repo);
      const match = entries.find((entry) => entry.tag === candidate.tag
        || (entry.version !== null && candidate.version !== null && entry.version === candidate.version));
      return match?.notes ?? '';
    } catch {
      return '';
    }
  }

  /** @param {any} state @param {string} currentVersion @returns {any} */
  function reconcileStaleInstall(state, currentVersion) {
    if (state.status !== 'installing') return state;
    const started = Date.parse(state.startedAt ?? '');
    if (!Number.isFinite(started) || nowMs() - started <= STALE_INSTALL_MS) return state;
    const target = normalizeVersion(state.latestVersion ?? '');
    const fresh = normalizeVersion(currentVersion) ?? normalizeVersion(state.currentVersion ?? '');
    if (target !== null && fresh !== null && compareVersions(fresh, target) >= 0) {
      return persistState({
        ...state,
        status: 'installed',
        currentVersion,
        finishedAt: iso(),
        message: `已更新到 v${target}，刷新页面后生效`,
        error: null,
      });
    }
    const message = '安装结果未知，请重新检查更新';
    return persistState({
      ...state,
      status: 'error',
      finishedAt: iso(),
      message,
      error: { code: 'INSTALL_INTERRUPTED', message },
    });
  }

  // ── update.state ─────────────────────────────────────────────────────────

  /** @returns {Promise<any>} */
  async function getState() {
    const manifest = readManifest();
    let state = readStateSync();
    const currentVersion = await resolveCurrentVersion(typeof state.currentVersion === 'string' ? state.currentVersion : '');
    state = reconcileStaleInstall(state, currentVersion);
    return {
      packageName: resolvePackageName(manifest),
      currentVersion,
      repo: resolveRepo(manifest),
      autoInstall: autoInstallAvailable(),
      state,
    };
  }

  // ── update.check ─────────────────────────────────────────────────────────

  /** @returns {Promise<any>} */
  async function runCheck() {
    const manifest = readManifest();
    const packageName = resolvePackageName(manifest);
    const currentVersion = await resolveCurrentVersion('');
    const repo = resolveRepo(manifest);
    if (typeof repo !== 'string' || repo.length === 0) {
      const message = '无法从 package.json 的 repository.url 解析 GitHub 仓库';
      persistState({ ...emptyState(), status: 'error', currentVersion, checkedAt: iso(), message, error: { code: 'REPO_UNKNOWN', message } });
      throw updateError('REPO_UNKNOWN', message);
    }

    persistState({ ...emptyState(), status: 'checking', currentVersion, message: '正在检查更新…', checkedAt: iso() });
    const includePrerelease = isPrerelease(normalizeVersion(currentVersion) ?? '');
    const reasons = [];
    /** @type {any | null} */
    let chosen = null;
    for (const source of ['tag', 'git', 'release']) {
      try {
        const entries = source === 'git'
          ? parseLsRemoteOutput(await lsRemote(repo))
          : await fetchAtomEntries(source, repo);
        const candidate = selectLatest(entries, { includePrerelease });
        if (candidate !== null) {
          chosen = { ...candidate, source };
          break;
        }
        reasons.push(`${SOURCE_LABELS[source]}: 未找到可用版本`);
      } catch (error) {
        reasons.push(`${SOURCE_LABELS[source]}: ${shortReason(error)}`);
      }
    }
    if (chosen === null) {
      const message = clip(`检查更新失败：${reasons.join('；')}`, 300);
      persistState({ ...emptyState(), status: 'error', currentVersion, checkedAt: iso(), message, error: { code: 'UPDATE_CHECK_FAILED', message } });
      throw updateError('UPDATE_CHECK_FAILED', message);
    }

    const latestVersion = chosen.version;
    const normalizedCurrent = normalizeVersion(currentVersion) ?? '0.0.0';
    const hasUpdate = compareVersions(latestVersion, normalizedCurrent) > 0;
    const releaseUrl = typeof chosen.url === 'string' && chosen.url.length > 0
      ? chosen.url
      : `https://github.com/${repo}/releases/tag/${chosen.tag}`;
    const notes = chosen.source === 'release' ? (chosen.notes ?? '') : await fetchReleaseNotes(repo, chosen);
    const checkedAt = iso();
    const status = hasUpdate ? 'available' : 'up_to_date';
    const message = hasUpdate ? `发现新版本 v${latestVersion}` : `已是最新版本（v${currentVersion}）`;
    const state = persistState({
      version: 1,
      status,
      currentVersion,
      latestVersion,
      tag: chosen.tag,
      releaseUrl,
      source: chosen.source,
      notes,
      checkedAt,
      startedAt: null,
      finishedAt: null,
      message,
      error: null,
    });
    return {
      packageName,
      currentVersion,
      repo,
      latestVersion,
      hasUpdate,
      tag: chosen.tag,
      releaseUrl,
      source: chosen.source,
      notes,
      checkedAt,
      state,
    };
  }

  /** @returns {Promise<any>} */
  async function check() {
    if (active !== null) throw updateError('UPDATE_BUSY', '更新操作正在进行中，请稍候');
    active = 'check';
    try {
      return await runCheck();
    } finally {
      active = null;
    }
  }

  // ── update.install ───────────────────────────────────────────────────────

  /** @returns {Promise<any | null>} */
  async function persistedCandidate() {
    const state = readStateSync();
    if (state.status !== 'available') return null;
    if (typeof state.tag !== 'string' || state.tag.length === 0) return null;
    const latestVersion = normalizeVersion(state.latestVersion ?? '');
    if (latestVersion === null) return null;
    const checked = Date.parse(state.checkedAt ?? '');
    if (!Number.isFinite(checked) || nowMs() - checked > CHECK_TTL_MS) return null;
    const currentVersion = await resolveCurrentVersion(state.currentVersion ?? '');
    const normalizedCurrent = normalizeVersion(currentVersion);
    if (normalizedCurrent === null || compareVersions(latestVersion, normalizedCurrent) <= 0) return null;
    return {
      tag: state.tag,
      latestVersion,
      releaseUrl: state.releaseUrl ?? null,
      source: state.source ?? null,
      notes: state.notes ?? '',
      checkedAt: state.checkedAt ?? null,
      currentVersion,
    };
  }

  /** @param {string} repo @param {string} tag */
  function resolveInstallManager(repo, tag) {
    const pluginManager = findPluginManager();
    if (pluginManager === null || typeof pluginManager.installBundle !== 'function') {
      const spec = buildGithubSpec(repo, tag);
      throw updateError(
        'AUTO_INSTALL_UNAVAILABLE',
        `当前 DSH 未提供插件管理器（pluginManager），无法自动安装；请手动执行 \`dsh plugin --profile <profile> add ${spec}\``,
      );
    }
    return pluginManager;
  }

  /** @param {unknown} source @returns {string} */
  function describeInstallError(source) {
    const errorCode = typeof source?.error?.code === 'string'
      ? source.error.code
      : (typeof source?.code === 'string' ? source.code : '');
    const output = typeof source?.packageResult?.output === 'string' ? source.packageResult.output : '';
    let message = '';
    if (typeof source?.error?.message === 'string' && source.error.message.trim().length > 0) {
      // Structured plugin-manager error wins (e.g. incompatible-version).
      message = source.error.message;
    } else if (output.length > 0) {
      // Prefer the actionable pnpm error line; tail-800 is only a fallback.
      message = extractPnpmErrorLines(output) || pnpmOutputFallback(output);
    } else if (source instanceof Error) {
      message = source.message;
    } else if (typeof source === 'string') {
      message = source;
    }
    message = squeezeWhitespace(stripAnsi(message));
    if (message.length === 0) message = '自动安装失败';
    message = clip(message, OUTPUT_LIMIT);
    if (errorCode === 'incompatible-version') {
      message = `${message}；该版本与当前 DSH 不兼容；请升级插件版本或授予版本豁免`;
    }
    if (hasIgnoredBuilds(output) || hasIgnoredBuilds(source?.error?.message) || hasIgnoredBuilds(message)) {
      // Never auto-approve builds here: `installBundle` is called with `{}` and
      // the user explicitly allows build scripts on the DSH Plugins page.
      message = `${message}；${IGNORED_BUILDS_HINT}`;
    }
    return message;
  }

  /** @param {unknown} source */
  function persistInstallFailure(source) {
    const message = describeInstallError(source);
    persistState({
      ...readStateSync(),
      status: 'error',
      finishedAt: iso(),
      message,
      error: { code: 'AUTO_INSTALL_FAILED', message },
    });
  }

  /** @param {{ pluginManager: any, spec: string, candidate: any }} job */
  async function runInstall(job) {
    let result = null;
    try {
      result = await job.pluginManager.installBundle(job.spec, {});
    } catch (error) {
      persistInstallFailure(error);
      return;
    }
    if (result === null || typeof result !== 'object' || result.error) {
      persistInstallFailure(result ?? new Error('安装结果未知'));
      return;
    }
    const application = result.application;
    if (application !== 'applied' && application !== 'restart-required') {
      persistInstallFailure(result);
      return;
    }
    const installedVersion = (await resolveCurrentVersion(job.candidate.latestVersion)) || job.candidate.latestVersion;
    const restart = application === 'restart-required';
    const message = restart
      ? `已安装 v${installedVersion}，重启 DSH 后生效`
      : `已更新到 v${installedVersion}，刷新页面后生效`;
    persistState({
      ...readStateSync(),
      status: restart ? 'restart_required' : 'installed',
      currentVersion: installedVersion,
      finishedAt: iso(),
      message,
      error: null,
    });
  }

  /** @returns {Promise<any>} */
  async function install() {
    if (active !== null) {
      const state = (await getState()).state;
      return { started: false, alreadyRunning: true, state };
    }
    active = 'install';
    let backgroundStarted = false;
    try {
      const persisted = readStateSync();
      let candidate = await persistedCandidate();
      if (candidate === null) {
        const checked = await runCheck();
        if (!checked.hasUpdate) throw updateError('NO_UPDATE', '当前没有可安装的更新');
        candidate = {
          tag: checked.tag,
          latestVersion: checked.latestVersion,
          releaseUrl: checked.releaseUrl,
          source: checked.source,
          notes: checked.notes,
          checkedAt: checked.checkedAt,
          currentVersion: checked.currentVersion,
        };
      }
      const manifest = readManifest();
      const repo = resolveRepo(manifest);
      if (typeof repo !== 'string' || repo.length === 0) {
        const message = '无法从 package.json 的 repository.url 解析 GitHub 仓库';
        persistState({ ...persisted, status: 'error', finishedAt: iso(), message, error: { code: 'REPO_UNKNOWN', message } });
        throw updateError('REPO_UNKNOWN', message);
      }
      const pluginManager = resolveInstallManager(repo, candidate.tag);
      const currentVersion = (await resolveCurrentVersion(candidate.currentVersion ?? '')) || (persisted.currentVersion ?? '');
      const spec = buildGithubSpec(repo, candidate.tag);
      const installing = persistState({
        version: 1,
        status: 'installing',
        currentVersion,
        latestVersion: candidate.latestVersion,
        tag: candidate.tag,
        releaseUrl: candidate.releaseUrl ?? null,
        source: candidate.source ?? null,
        notes: candidate.notes ?? '',
        checkedAt: candidate.checkedAt ?? null,
        startedAt: iso(),
        finishedAt: null,
        message: `发现新版本 v${candidate.latestVersion}，正在自动下载安装…`,
        error: null,
      });
      backgroundStarted = true;
      void runInstall({ pluginManager, spec, candidate }).finally(() => {
        active = null;
      });
      return { started: true, alreadyRunning: false, state: installing };
    } finally {
      if (!backgroundStarted) active = null;
    }
  }

  return { getState, check, install };
}
