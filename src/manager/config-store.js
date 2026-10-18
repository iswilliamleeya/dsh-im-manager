/**
 * Manager configuration store.
 *
 * Owns two kinds of files:
 *   - `manager.json` (default `~/.dsh-im-manager/manager.json`): the list of
 *     workspaces the manager knows about, plus the loopback listen address of
 *     the Web UI. Written atomically with mode 0600.
 *   - `<workspaceDir>/.dsh-im-manager/config.json`: one ordinary gateway config
 *     per workspace (same format as `docs/contracts.md`). Also 0600 + atomic.
 *
 * This module deliberately stays independent from the gateway runtime: it only
 * reads/writes configuration, generates a default config for new workspaces,
 * masks secrets for the Web UI, and validates a config before it is persisted.
 * Lifecycle (start/stop/restart) lives in `manager.js`.
 *
 * The contract is `docs/manager-contract.md` §1/§4/§5.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { CHANNEL_IDS, defaultConfig, expandHome, loadConfig, validate } from '../core/config.js';
import { loadAdapterModule } from '../adapters/registry.js';

const MANAGER_VERSION = 1;
const DEFAULT_LISTEN = Object.freeze({ host: '127.0.0.1', port: 8788 });
const DEFAULT_MANAGER_DIR = () => join(homedir(), '.dsh-im-manager');

/** Workspace ids are lowercase letters/digits with single `-` separators. */
const WORKSPACE_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_WORKSPACE_ID_LENGTH = 64;
const MAX_WORKSPACE_NAME_LENGTH = 200;

/**
 * Field names that hold a credential, wherever they appear in the config tree.
 * Keep in sync with the contract §4 list (snake_case tolerated for hand-written
 * configs). Case-insensitive.
 */
const SECRET_FIELD_RE = /^(appsecret|app_secret|clientsecret|client_secret|secret|token|encodingaeskey|encoding_aes_key|encryptkey|encrypt_key|verificationtoken|verification_token|password|apikey|api_key|signaturesecret|signature_secret)$/i;

/** `dsh.env` entries whose *name* looks like a credential are masked too. */
const SECRET_ENV_NAME_RE = /SECRET|TOKEN|KEY|PASSWORD/i;

/** `env:NAME` / `${NAME}` are indirection, never a literal secret. */
const PLACEHOLDER_RE = /^(?:env:[A-Za-z_][A-Za-z0-9_]*|\$\{[A-Za-z_][A-Za-z0-9_]*\})$/;
const PLACEHOLDER_INLINE_RE = /\$\{[A-Za-z_][A-Za-z0-9_]*\}/;

const MASK = '***';

// ── Small helpers ────────────────────────────────────────────────────────────

/** @param {unknown} value */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** @param {string} message @param {string} code */
function codedError(message, code) {
  const error = new Error(message);
  /** @type {any} */ (error).code = code;
  return error;
}

/** @param {string} message */
function invalidInput(message) {
  return codedError(message, 'INVALID_INPUT');
}

/** @param {string} message */
function invalidConfig(message) {
  return codedError(message, 'INVALID_CONFIG');
}

/** @param {string} id */
function workspaceNotFound(id) {
  return codedError(`workspace not found: ${id}`, 'WORKSPACE_NOT_FOUND');
}

/**
 * Deep merge plain objects; arrays and scalars from `override` win (same
 * semantics as the core config loader).
 * @param {any} base
 * @param {any} override
 * @returns {any}
 */
function deepMerge(base, override) {
  if (override === undefined) return base;
  if (Array.isArray(override) || override === null || typeof override !== 'object') return override;
  if (Array.isArray(base) || base === null || typeof base !== 'object') base = {};
  /** @type {Record<string, unknown>} */
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    out[key] = deepMerge(base[key], value);
  }
  return out;
}

/**
 * Replace `env:NAME` / `${NAME}` with the process environment, but only when
 * the variable is actually set. Unresolved references are left verbatim so
 * adapter validation treats them as opaque non-empty values instead of
 * rejecting a config that will be resolved at gateway start time.
 *
 * @param {unknown} value
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {unknown}
 */
function interpolateForValidation(value, env = process.env) {
  if (typeof value === 'string') {
    const exact = /^env:([A-Za-z_][A-Za-z0-9_]*)$/.exec(value);
    if (exact !== null) {
      const resolved = env[exact[1]];
      return resolved === undefined || resolved === '' ? value : resolved;
    }
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name) => {
      const resolved = env[name];
      return resolved === undefined || resolved === '' ? match : resolved;
    });
  }
  if (Array.isArray(value)) return value.map((item) => interpolateForValidation(item, env));
  if (isPlainObject(value)) {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = interpolateForValidation(item, env);
    return out;
  }
  return value;
}

/** Resolve `~`, relative stateDir/cwd and `dsh.home` like the core loader does. */
function normalizeConfigPaths(config) {
  config.gateway.stateDir = resolve(expandHome(String(config.gateway.stateDir)));
  config.dsh.cwd = resolve(expandHome(String(config.dsh.cwd)));
  config.dsh.home = config.dsh.home === '' ? '' : resolve(expandHome(String(config.dsh.home)));
  return config;
}

/**
 * Create the parent directory and write `value` as pretty JSON.
 * The temp file is created 0600 and renamed over the target, so readers never
 * observe a partial file and the final inode keeps 0600.
 *
 * @param {string} file
 * @param {unknown} value
 */
function writeJsonAtomic0600(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const body = `${JSON.stringify(value, null, 2)}\n`;
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // Best effort (the initial mode already applied).
  }
  renameSync(tmp, file);
  try {
    chmodSync(file, 0o600);
  } catch {
    // Best effort: FAT/external volumes may not support chmod.
  }
}

/**
 * Read and parse a JSON file, turning the usual file-system errors into
 * actionable messages that never leak file contents.
 * @param {string} file
 * @param {string} what
 * @returns {any}
 */
function readJsonFile(file, what) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    throw codedError(
      `cannot read ${what} ${file}: ${error instanceof Error ? error.message : String(error)}`,
      'INVALID_CONFIG',
    );
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw codedError(
      `${what} ${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      'INVALID_CONFIG',
    );
  }
}

// ── Workspace ids ────────────────────────────────────────────────────────────

/** @param {unknown} id */
export function isValidWorkspaceId(id) {
  return typeof id === 'string'
    && id.length > 0
    && id.length <= MAX_WORKSPACE_ID_LENGTH
    && WORKSPACE_ID_RE.test(id);
}

/**
 * Derive a stable, filesystem/URL-safe workspace id from a display name.
 * Names that contain no ASCII letters/digits (e.g. Chinese) fall back to
 * `workspace`; {@link createConfigStore} de-duplicates with a numeric suffix.
 *
 * @param {string} name
 * @returns {string}
 */
export function slugifyWorkspaceId(name) {
  const slug = String(name ?? '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return slug.length > 0 ? slug : 'workspace';
}

// ── Secret masking (contract §4) ─────────────────────────────────────────────

/**
 * True when a value is an indirection (`env:NAME`, `${NAME}`) that must be
 * returned untouched: masking it would destroy the user's configuration
 * intent rather than hide a secret.
 * @param {unknown} value
 */
export function isSecretPlaceholder(value) {
  if (typeof value !== 'string') return false;
  return PLACEHOLDER_RE.test(value) || PLACEHOLDER_INLINE_RE.test(value);
}

/**
 * Mask one credential value. Empty strings stay empty so the Web UI can tell
 * "not configured" from "configured"; indirections are preserved verbatim.
 * @param {unknown} value
 */
export function maskSecretValue(value) {
  if (typeof value !== 'string' || value.length === 0) return value;
  if (isSecretPlaceholder(value)) return value;
  return MASK;
}

/**
 * Deep-copy a gateway config with credentials masked (contract §4).
 * The result is structurally identical to the config file, so the Web UI can
 * render it directly and send it back on save.
 *
 * @template T
 * @param {T} config
 * @returns {T}
 */
export function maskConfig(config) {
  /** @param {unknown} value @param {string[]} path @returns {any} */
  function walk(value, path) {
    if (Array.isArray(value)) return value.map((item) => walk(item, path));
    if (!isPlainObject(value)) return value;
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (path.length === 1 && path[0] === 'dsh' && key === 'env' && isPlainObject(item)) {
        /** @type {Record<string, unknown>} */
        const env = {};
        for (const [name, envValue] of Object.entries(item)) {
          env[name] = SECRET_ENV_NAME_RE.test(name)
            ? maskSecretValue(envValue)
            : walk(envValue, [...path, key, name]);
        }
        out[key] = env;
      } else if (SECRET_FIELD_RE.test(key)) {
        out[key] = maskSecretValue(item);
      } else {
        out[key] = walk(item, [...path, key]);
      }
    }
    return out;
  }
  return /** @type {T} */ (walk(config, []));
}

/**
 * Replace `"***"` placeholders in an incoming (UI-edited) config with the
 * previously stored values. A placeholder without a previous value becomes an
 * empty string — never the literal `***`, which would be written to disk.
 *
 * @param {unknown} incoming
 * @param {unknown} previous
 * @returns {any}
 */
function resolveSecretPlaceholders(incoming, previous) {
  if (incoming === MASK) {
    return typeof previous === 'string' ? previous : '';
  }
  if (Array.isArray(incoming)) {
    const prior = Array.isArray(previous) ? previous : [];
    return incoming.map((item, index) => resolveSecretPlaceholders(item, prior[index]));
  }
  if (isPlainObject(incoming)) {
    const prior = isPlainObject(previous) ? previous : {};
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [key, value] of Object.entries(incoming)) {
      out[key] = resolveSecretPlaceholders(value, prior[key]);
    }
    return out;
  }
  return incoming;
}

// ── Manager data shape ───────────────────────────────────────────────────────

/** @param {unknown} raw */
function normalizeListen(raw) {
  const host = isPlainObject(raw) && typeof raw.host === 'string' && raw.host.length > 0
    ? raw.host
    : DEFAULT_LISTEN.host;
  const port = isPlainObject(raw) && Number.isInteger(raw.port) && Number(raw.port) >= 0 && Number(raw.port) <= 65535
    ? Number(raw.port)
    : DEFAULT_LISTEN.port;
  return { host, port };
}

/**
 * @param {unknown} raw
 * @param {number} index
 * @param {string} managerFile
 */
function normalizeWorkspaceEntry(raw, index, managerFile) {
  if (!isPlainObject(raw)) {
    throw invalidConfig(`manager file ${managerFile}: workspaces[${index}] must be an object`);
  }
  if (!isValidWorkspaceId(raw.id)) {
    throw invalidConfig(`manager file ${managerFile}: workspaces[${index}].id must match ${WORKSPACE_ID_RE}`);
  }
  const id = /** @type {string} */ (raw.id);
  const name = typeof raw.name === 'string' && raw.name.trim().length > 0
    ? raw.name.trim()
    : id;
  if (typeof raw.workspaceDir !== 'string' || raw.workspaceDir.trim().length === 0) {
    throw invalidConfig(`manager file ${managerFile}: workspaces[${index}].workspaceDir is required`);
  }
  const workspaceDir = resolve(expandHome(raw.workspaceDir.trim()));
  const configFile = typeof raw.configFile === 'string' && raw.configFile.trim().length > 0
    ? resolve(expandHome(raw.configFile.trim()))
    : join(workspaceDir, '.dsh-im-manager', 'config.json');
  return {
    id,
    name,
    workspaceDir,
    configFile,
    autoStart: raw.autoStart === true,
  };
}

/**
 * @param {unknown} raw
 * @param {string} managerFile
 */
function normalizeManagerData(raw, managerFile) {
  if (!isPlainObject(raw)) {
    throw invalidConfig(`manager file ${managerFile} must contain a JSON object`);
  }
  const workspaces = Array.isArray(raw.workspaces)
    ? raw.workspaces.map((entry, index) => normalizeWorkspaceEntry(entry, index, managerFile))
    : [];
  const seen = new Set();
  for (const entry of workspaces) {
    if (seen.has(entry.id)) {
      throw invalidConfig(`manager file ${managerFile}: duplicate workspace id "${entry.id}"`);
    }
    seen.add(entry.id);
  }
  return {
    version: Number.isInteger(raw.version) && raw.version > 0 ? raw.version : MANAGER_VERSION,
    listen: normalizeListen(raw.listen),
    workspaces,
  };
}

// ── Workspace config generation ──────────────────────────────────────────────

/**
 * Build a fresh gateway config for a new workspace.
 *
 * Contract §10.1 (v1.1): creating a workspace never enables a channel. The
 * `channels` selection only says which channel blocks the UI should surface;
 * enabling always goes through the channel card (QR connect or a manual config
 * save). All channels therefore start disabled.
 *
 * `gateway.http.port` is 0 so several workspaces can run side by side without a
 * port clash.
 *
 * @param {{
 *   workspaceDir: string,
 *   stateDir: string,
 *   channels?: string[],
 *   provider?: string,
 * }} input
 * @returns {Record<string, any>}
 */
export function createWorkspaceConfig(input) {
  const config = defaultConfig();
  config.dsh.cwd = input.workspaceDir;
  if (typeof input.provider === 'string' && input.provider.length > 0) {
    config.dsh.provider = input.provider;
  }
  config.gateway.stateDir = input.stateDir;
  config.gateway.http.port = 0;
  for (const id of CHANNEL_IDS) {
    config.channels[id].enabled = false;
  }
  return normalizeConfigPaths(config);
}

/** @param {unknown} channels */
function normalizeChannelSelection(channels) {
  if (channels === undefined || channels === null) return [];
  if (!Array.isArray(channels)) {
    throw invalidInput('channels must be an array of channel ids');
  }
  /** @type {string[]} */
  const selected = [];
  for (const item of channels) {
    if (typeof item !== 'string' || !CHANNEL_IDS.includes(item)) {
      throw invalidInput(`unknown channel "${String(item)}" (expected one of ${CHANNEL_IDS.join(', ')})`);
    }
    if (!selected.includes(item)) selected.push(item);
  }
  return selected;
}

// ── Store ────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} WorkspaceEntry
 * @property {string} id
 * @property {string} name
 * @property {string} workspaceDir
 * @property {string} configFile
 * @property {boolean} autoStart
 */

/**
 * Create the manager config store. No I/O happens until {@link load} is called.
 *
 * @param {{
 *   managerFile?: string,
 *   managerDataDir?: string,
 *   logger?: import('../core/types.js').Logger,
 *   now?: () => number,
 *   provider?: string,
 * }} [options]
 */
export function createConfigStore(options = {}) {
  const dataDir = resolve(expandHome(options.managerDataDir ?? DEFAULT_MANAGER_DIR()));
  const managerFile = options.managerFile === undefined
    ? join(dataDir, 'manager.json')
    : resolve(expandHome(options.managerFile));
  const logger = options.logger;
  const defaultProvider = options.provider;

  /** @type {{ version: number, listen: { host: string, port: number }, workspaces: WorkspaceEntry[] } | null} */
  let data = null;

  function ensureLoaded() {
    if (data === null) throw new Error('config store is not loaded: call load() first');
    return data;
  }

  async function save() {
    writeJsonAtomic0600(managerFile, ensureLoaded());
  }

  /** @param {string} id */
  function findEntry(id) {
    return ensureLoaded().workspaces.find((entry) => entry.id === id);
  }

  /** @param {string} id */
  function requireEntry(id) {
    const entry = findEntry(id);
    if (entry === undefined) throw workspaceNotFound(id);
    return entry;
  }

  /** @param {string} base */
  function uniqueWorkspaceId(base) {
    const taken = new Set(ensureLoaded().workspaces.map((entry) => entry.id));
    if (!taken.has(base)) return base;
    for (let suffix = 2; suffix < 1000; suffix += 1) {
      const candidate = `${base}-${suffix}`;
      if (!taken.has(candidate)) return candidate;
    }
    throw invalidInput(`cannot derive a unique workspace id from "${base}"`);
  }

  /**
   * Read the raw config file (no default merge, no env interpolation). Used for
   * placeholder preservation and as the base for display configs.
   * @param {WorkspaceEntry} entry
   * @returns {Record<string, any>}
   */
  function readRawConfig(entry) {
    if (!existsSync(entry.configFile)) {
      throw codedError(`workspace config not found: ${entry.configFile}`, 'INVALID_CONFIG');
    }
    const raw = readJsonFile(entry.configFile, 'workspace config');
    if (!isPlainObject(raw)) {
      throw invalidConfig(`workspace config ${entry.configFile} must contain a JSON object`);
    }
    return raw;
  }

  /**
   * Effective config for display/saving: defaults merged in, `~`-expanded and
   * paths resolved, but secrets and env references left untouched.
   * @param {WorkspaceEntry} entry
   * @returns {Record<string, any>}
   */
  function effectiveConfig(entry) {
    const raw = readRawConfig(entry);
    return normalizeConfigPaths(deepMerge(defaultConfig(), raw));
  }

  /**
   * Validate the shared config shape plus every enabled channel's own
   * `validateConfig()` (loaded lazily so a missing optional platform SDK only
   * disables that channel's validation). Environment references are resolved
   * for the validation call only; the file keeps the original placeholders.
   * @param {Record<string, any>} config
   */
  async function validateEnabledChannels(config) {
    for (const id of CHANNEL_IDS) {
      if (config.channels?.[id]?.enabled !== true) continue;
      /** @type {any} */
      let module;
      try {
        module = await loadAdapterModule(id);
      } catch (error) {
        logger?.debug?.('adapter module unavailable; skipping channel validation', {
          channel: id,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      const validator = module?.validateConfig ?? module?.default?.validateConfig;
      if (typeof validator !== 'function') continue;
      try {
        await validator(interpolateForValidation(config.channels[id]));
      } catch (error) {
        throw invalidConfig(
          `channels.${id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  const store = {
    get managerFile() {
      return managerFile;
    },
    get managerDataDir() {
      return dataDir;
    },

    /**
     * Read manager.json (creating a default one when missing) and return the
     * store for chaining. Idempotent.
     */
    async load() {
      if (data !== null) return store;
      if (!existsSync(managerFile)) {
        data = {
          version: MANAGER_VERSION,
          listen: { ...DEFAULT_LISTEN },
          workspaces: [],
        };
        mkdirSync(dataDir, { recursive: true });
        await save();
        logger?.info?.('created default manager file', { file: managerFile });
        return store;
      }
      const raw = readJsonFile(managerFile, 'manager file');
      data = normalizeManagerData(raw, managerFile);
      return store;
    },

    /** Persist manager.json atomically (0600). */
    async save() {
      await save();
    },

    /** @returns {{ host: string, port: number }} */
    getListen() {
      return { ...ensureLoaded().listen };
    },

    /** @param {{ host?: string, port?: number }} listen */
    async setListen(listen) {
      const current = ensureLoaded().listen;
      data.listen = normalizeListen({ ...current, ...listen });
      await save();
      return { ...data.listen };
    },

    /** @returns {WorkspaceEntry[]} */
    listWorkspaces() {
      return ensureLoaded().workspaces.map((entry) => ({ ...entry }));
    },

    /** @param {string} id @returns {WorkspaceEntry | undefined} */
    getWorkspace(id) {
      const entry = findEntry(String(id));
      return entry === undefined ? undefined : { ...entry };
    },

    /** Resolve an id or throw a coded WORKSPACE_NOT_FOUND error. @param {string} id */
    requireWorkspace(id) {
      return { ...requireEntry(String(id)) };
    },

    /**
     * Add a workspace: derive/validate its id, create the directory + gateway
     * config, and persist manager.json. Adapter-specific validation is
     * intentionally deferred to `saveWorkspaceConfig`, so the UI can create a
     * workspace first and fill in credentials afterwards.
     *
     * @param {{
     *   name: string,
     *   workspaceDir: string,
     *   channels?: string[],
     *   autoStart?: boolean,
     *   id?: string,
     *   configFile?: string,
     *   provider?: string,
     * }} input
     * @returns {Promise<WorkspaceEntry>}
     */
    async addWorkspace(input = /** @type {any} */ ({})) {
      await store.load();
      const name = typeof input.name === 'string' ? input.name.trim() : '';
      if (name.length === 0) throw invalidInput('workspace name is required');
      if (name.length > MAX_WORKSPACE_NAME_LENGTH) {
        throw invalidInput(`workspace name is too long (max ${MAX_WORKSPACE_NAME_LENGTH} characters)`);
      }
      const rawDir = typeof input.workspaceDir === 'string' ? input.workspaceDir.trim() : '';
      if (rawDir.length === 0) throw invalidInput('workspaceDir is required');
      const workspaceDir = resolve(expandHome(rawDir));
      const channels = normalizeChannelSelection(input.channels);
      const autoStart = input.autoStart === true;

      /** @type {string} */
      let id;
      if (input.id !== undefined) {
        if (!isValidWorkspaceId(input.id)) {
          throw invalidInput(`invalid workspace id "${String(input.id)}" (expected ${WORKSPACE_ID_RE})`);
        }
        id = String(input.id);
        if (findEntry(id) !== undefined) throw invalidInput(`workspace id already exists: ${id}`);
      } else {
        id = uniqueWorkspaceId(slugifyWorkspaceId(name));
      }

      const configFile = typeof input.configFile === 'string' && input.configFile.trim().length > 0
        ? resolve(expandHome(input.configFile.trim()))
        : join(workspaceDir, '.dsh-im-manager', 'config.json');
      const stateDir = join(dataDir, 'workspaces', id, 'state');
      const config = createWorkspaceConfig({
        workspaceDir,
        stateDir,
        channels,
        provider: typeof input.provider === 'string' && input.provider.length > 0 ? input.provider : defaultProvider,
      });
      try {
        validate(config);
      } catch (error) {
        throw invalidConfig(error instanceof Error ? error.message : String(error));
      }

      mkdirSync(workspaceDir, { recursive: true });
      mkdirSync(dirname(configFile), { recursive: true });
      writeJsonAtomic0600(configFile, config);

      const entry = { id, name, workspaceDir, configFile, autoStart };
      ensureLoaded().workspaces.push(entry);
      await save();
      logger?.info?.('workspace added', { id, workspaceDir, channels });
      return { ...entry };
    },

    /**
     * Update mutable metadata of a workspace. The id (and therefore the paths)
     * never changes.
     *
     * @param {string} id
     * @param {{ name?: string, autoStart?: boolean }} patch
     * @returns {Promise<WorkspaceEntry>}
     */
    async updateWorkspace(id, patch = {}) {
      await store.load();
      const entry = requireEntry(String(id));
      if (patch.name !== undefined) {
        const name = typeof patch.name === 'string' ? patch.name.trim() : '';
        if (name.length === 0) throw invalidInput('workspace name must be a non-empty string');
        if (name.length > MAX_WORKSPACE_NAME_LENGTH) {
          throw invalidInput(`workspace name is too long (max ${MAX_WORKSPACE_NAME_LENGTH} characters)`);
        }
        entry.name = name;
      }
      if (patch.autoStart !== undefined) {
        if (typeof patch.autoStart !== 'boolean') throw invalidInput('autoStart must be a boolean');
        entry.autoStart = patch.autoStart;
      }
      await save();
      return { ...entry };
    },

    /**
     * Remove a workspace entry from manager.json. The gateway config and state
     * directory are left on disk on purpose: removing a workspace must never
     * silently delete a user's channel credentials or DSH sessions.
     *
     * @param {string} id
     * @returns {Promise<WorkspaceEntry>}
     */
    async removeWorkspace(id) {
      await store.load();
      const current = ensureLoaded();
      const index = current.workspaces.findIndex((entry) => entry.id === String(id));
      if (index === -1) throw workspaceNotFound(String(id));
      const [removed] = current.workspaces.splice(index, 1);
      await save();
      return { ...removed };
    },

    /**
     * Masked config for the Web UI (contract §4).
     * @param {string} id
     * @returns {Record<string, any>}
     */
    getWorkspaceConfig(id) {
      const entry = requireEntry(String(id));
      return maskConfig(effectiveConfig(entry));
    },

    /**
     * Effective (unmasked, un-interpolated) config. Used by the manager for
     * display/state aggregation.
     * @param {string} id
     */
    readWorkspaceConfig(id) {
      return effectiveConfig(requireEntry(String(id)));
    },

    /**
     * Internal raw config write used by provider-driven flows (§10).
     *
     * The caller passes a full effective config (defaults already merged);
     * the shared shape is validated and the file written atomically (0600).
     * Adapter-specific validation is intentionally skipped here: the credential
     * was just issued by the provider, and a channel that still misbehaves is
     * reported through the gateway's own error state instead of rejecting the
     * connect result.
     *
     * @param {string} id
     * @param {Record<string, any>} config
     * @returns {Promise<Record<string, any>>} masked config now in effect
     */
    async writeWorkspaceConfig(id, config) {
      await store.load();
      const entry = requireEntry(String(id));
      if (!isPlainObject(config)) throw invalidInput('config must be a JSON object');
      const merged = normalizeConfigPaths(deepMerge(defaultConfig(), config));
      try {
        validate(merged);
      } catch (error) {
        throw invalidConfig(error instanceof Error ? error.message : String(error));
      }
      writeJsonAtomic0600(entry.configFile, merged);
      logger?.info?.('workspace config written', { id, file: entry.configFile });
      return maskConfig(merged);
    },

    /**
     * Fully loaded config for actually starting a gateway: the core loader
     * interpolates `env:` / `${}` and resolves paths exactly like the CLI does.
     * @param {string} id
     * @returns {Record<string, any>}
     */
    loadWorkspaceConfig(id) {
      const entry = requireEntry(String(id));
      if (!existsSync(entry.configFile)) {
        throw invalidConfig(`workspace config not found: ${entry.configFile}`);
      }
      let loaded;
      try {
        loaded = loadConfig({
          configPath: entry.configFile,
          warn: (message) => logger?.warn?.('workspace config warning', { id, detail: message }),
        });
      } catch (error) {
        throw invalidConfig(
          error instanceof Error ? error.message : String(error),
        );
      }
      return loaded.config;
    },

    /**
     * Validate, then atomically persist a UI-edited config. `"***"` keeps the
     * previously stored secret; the file is never written with masked values.
     * Returns the masked config that is now in effect.
     *
     * @param {string} id
     * @param {unknown} incoming
     * @returns {Promise<Record<string, any>>}
     */
    async saveWorkspaceConfig(id, incoming) {
      await store.load();
      const entry = requireEntry(String(id));
      if (!isPlainObject(incoming)) throw invalidInput('config must be a JSON object');

      const previous = effectiveConfig(entry);
      const patched = resolveSecretPlaceholders(incoming, previous);
      const merged = normalizeConfigPaths(deepMerge(previous, patched));

      try {
        validate(merged);
      } catch (error) {
        throw invalidConfig(error instanceof Error ? error.message : String(error));
      }
      await validateEnabledChannels(merged);

      writeJsonAtomic0600(entry.configFile, merged);
      logger?.info?.('workspace config saved', { id, file: entry.configFile });
      return maskConfig(merged);
    },
  };

  return store;
}
