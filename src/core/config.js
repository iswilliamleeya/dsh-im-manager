/**
 * Configuration loading, env interpolation, defaults, and validation.
 *
 * Precedence: explicit `--config` path > `DSH_IM_MANAGER_CONFIG` >
 * `$DSH_HOME/im-manager/config.json` > `./config/config.json`.
 *
 * Two interpolation forms are supported inside string values:
 *   - `env:NAME`   -> the environment variable is required (empty + warning if missing)
 *   - `${NAME}`    -> inline substitution (empty string when missing)
 * Values are never printed by the gateway; `doctor` reports missing variables by name.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';

const CHANNEL_IDS = ['feishu', 'dingtalk', 'wecom', 'weixin'];

/** @returns {Record<string, unknown>} */
export function defaultConfig() {
  return {
    dsh: {
      command: 'dsh',
      args: ['--profile', 'sdk'],
      cwd: process.cwd(),
      home: '',
      env: {},
      provider: 'deepseek-official',
      model: 'deepseek-chat',
      reasoningEffort: '',
      maxTokens: null,
      initTimeoutMs: 60000,
      turnTimeoutMs: 600000,
      requestTimeoutMs: 60000,
      restart: { minDelayMs: 1000, maxDelayMs: 30000 },
    },
    gateway: {
      stateDir: '~/.dsh-im-manager',
      concurrency: 4,
      log: { level: 'info' },
      http: { enabled: true, host: '127.0.0.1', port: 8787, publicBaseUrl: '' },
      access: {
        dmPolicy: 'pairing',
        allowFrom: [],
        pairingTtlSec: 600,
        groups: { enabled: false, requireMention: true, allowFrom: [] },
      },
      reply: {
        chunkChars: 1800,
        typing: true,
        format: 'auto',
        showErrorDetail: false,
        emptyText: '（本轮没有文本输出）',
        maxChunks: 6,
      },
    },
    channels: {
      feishu: {
        enabled: false,
        accountId: 'feishu',
        mode: 'ws',
        appId: '',
        appSecret: '',
        domain: 'feishu',
        encryptKey: '',
        verificationToken: '',
        webhookPath: '/webhook/feishu',
        allowFrom: [],
        groups: {},
      },
      dingtalk: {
        enabled: false,
        accountId: 'dingtalk',
        mode: 'stream',
        clientId: '',
        clientSecret: '',
        robotCode: '',
        webhookPath: '/webhook/dingtalk',
        allowFrom: [],
        groups: {},
      },
      wecom: {
        enabled: false,
        accountId: 'wecom',
        mode: 'ws',
        botId: '',
        secret: '',
        token: '',
        encodingAESKey: '',
        corpId: '',
        agentId: '',
        webhookPath: '/webhook/wecom',
        allowFrom: [],
        groups: {},
      },
      weixin: {
        enabled: false,
        accountId: 'weixin',
        mode: 'ilink',
        baseUrl: 'https://ilinkai.weixin.qq.com',
        cdnBaseUrl: 'https://novac2c.cdn.weixin.qq.com/c2c',
        credentialsFile: '',
        requestTimeoutMs: 15000,
        longPollTimeoutMs: 35000,
        reconnect: { enabled: true, baseDelayMs: 2000, maxDelayMs: 30000 },
        typing: true,
        botAgent: 'dsh-im-manager',
        media: { download: true, maxBytes: 26214400, timeoutMs: 30000, maxItemsPerMessage: 8 },
        allowFrom: [],
        groups: {},
      },
    },
  };
}

/** Expand a leading `~` to the user's home directory. */
export function expandHome(value) {
  if (typeof value !== 'string' || value.length === 0) return value;
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return resolve(homedir(), value.slice(2));
  return value;
}

/** Deep merge plain objects; arrays and scalars from `override` win. */
function merge(base, override) {
  if (override === undefined) return base;
  if (Array.isArray(override) || override === null || typeof override !== 'object') return override;
  if (Array.isArray(base) || base === null || typeof base !== 'object') base = {};
  /** @type {Record<string, unknown>} */
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    out[key] = merge(/** @type {any} */ (base)[key], value);
  }
  return out;
}

/**
 * Replace `env:NAME` and `${NAME}` tokens.
 *
 * @param {unknown} value
 * @param {NodeJS.ProcessEnv} env
 * @param {(message: string) => void} warn
 * @returns {unknown}
 */
function interpolate(value, env, warn, path = [], shouldWarn = () => true) {
  if (typeof value === 'string') {
    const exact = /^env:([A-Za-z_][A-Za-z0-9_]*)$/.exec(value);
    if (exact !== null) {
      const name = exact[1];
      const resolved = env[name];
      if (resolved === undefined || resolved === '') {
        if (shouldWarn(path)) warn(`environment variable ${name} is required but not set`);
        return '';
      }
      return resolved;
    }
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name) => {
      const resolved = env[name];
      if (resolved === undefined) {
        if (shouldWarn(path)) warn(`environment variable ${name} referenced by \${${name}} is not set`);
        return '';
      }
      return resolved;
    });
  }
  if (Array.isArray(value)) return value.map((item) => interpolate(item, env, warn, path, shouldWarn));
  if (value !== null && typeof value === 'object') {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = interpolate(item, env, warn, [...path, key], shouldWarn);
    return out;
  }
  return value;
}

/**
 * Resolve a configuration file path.
 * @param {{ configPath?: string, env?: NodeJS.ProcessEnv }} [options]
 * @returns {string | null}
 */
export function resolveConfigPath(options = {}) {
  const env = options.env ?? process.env;
  if (options.configPath) return resolve(expandHome(options.configPath));
  if (env.DSH_IM_MANAGER_CONFIG) return resolve(expandHome(env.DSH_IM_MANAGER_CONFIG));
  const dshHome = env.DSH_HOME ? resolve(expandHome(env.DSH_HOME)) : resolve(homedir(), '.dsh');
  const candidates = [
    // Workspace-local config wins over the machine-wide one: `cd <workspace>` +
    // `dsh-im-manager pair <code>` therefore pairs the workspace's own instance.
    resolve(process.cwd(), '.dsh-im-manager', 'config.json'),
    // Machine-wide / previous convention.
    resolve(dshHome, 'im-manager', 'config.json'),
    // Legacy: config inside this repository checkout.
    resolve(process.cwd(), 'config/config.json'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Load, interpolate, default, and validate the config.
 *
 * @param {{ configPath?: string, env?: NodeJS.ProcessEnv, warn?: (message: string) => void, allowMissingConfig?: boolean, skipValidation?: boolean }} [options]
 * @returns {{ config: Record<string, any>, path: string | null, warnings: string[] }}
 */
export function loadConfig(options = {}) {
  const env = options.env ?? process.env;
  /** @type {string[]} */
  const warnings = [];
  const warn = options.warn ?? ((message) => warnings.push(message));
  const path = resolveConfigPath({ configPath: options.configPath, env });
  let raw = {};
  if (path !== null) {
    let text;
    try {
      text = readFileSync(path, 'utf8');
    } catch (error) {
      throw new Error(`cannot read config file ${path}: ${error.message}`);
    }
    try {
      raw = JSON.parse(text);
    } catch (error) {
      throw new Error(`config file ${path} is not valid JSON: ${error.message}`);
    }
  } else if (options.allowMissingConfig !== true) {
    throw new Error(
      'no config file found: pass --config <path>, set DSH_IM_MANAGER_CONFIG, or create ~/.dsh/im-manager/config.json',
    );
  }

  // A disabled channel's placeholder secrets must not fail `doctor`: only warn
  // about missing environment variables for channels the user actually enabled.
  const rawChannels = raw !== null && typeof raw === 'object' ? raw.channels : undefined;
  const shouldWarn = (path) => {
    if (path[0] === 'channels' && path.length > 1) {
      const channel = rawChannels?.[path[1]];
      return channel !== null && typeof channel === 'object' && channel.enabled === true;
    }
    return true;
  };
  const interpolated = /** @type {Record<string, any>} */ (interpolate(raw, env, warn, [], shouldWarn));
  const config = /** @type {Record<string, any>} */ (merge(defaultConfig(), interpolated));

  config.gateway.stateDir = resolve(expandHome(String(config.gateway.stateDir)));
  config.dsh.cwd = resolve(expandHome(String(config.dsh.cwd)));
  config.dsh.home = config.dsh.home === '' ? '' : resolve(expandHome(String(config.dsh.home)));

  if (options.skipValidation !== true) validate(config);
  return { config, path, warnings };
}

/**
 * Throw on structurally invalid configuration. Channel-specific completeness is
 * validated by each adapter at start time (so `doctor` can report all channels).
 * @param {Record<string, any>} config
 */
export function validate(config) {
  const fail = (message) => {
    throw new Error(`invalid config: ${message}`);
  };
  if (typeof config?.dsh?.command !== 'string' || config.dsh.command.length === 0) fail('dsh.command must be a non-empty string');
  if (!Array.isArray(config.dsh.args)) fail('dsh.args must be an array of strings');
  if (typeof config.dsh.cwd !== 'string' || !isAbsolute(config.dsh.cwd)) fail('dsh.cwd must be an absolute path');
  if (typeof config.dsh.provider !== 'string' || config.dsh.provider.length === 0) fail('dsh.provider must be a non-empty string');
  if (typeof config.dsh.model !== 'string' || config.dsh.model.length === 0) fail('dsh.model must be a non-empty string');
  if (!(config.dsh.maxTokens === null || (Number.isSafeInteger(config.dsh.maxTokens) && config.dsh.maxTokens > 0))) fail('dsh.maxTokens must be null or a positive integer');
  for (const field of ['initTimeoutMs', 'turnTimeoutMs', 'requestTimeoutMs']) {
    if (!(Number.isFinite(config.dsh[field]) && config.dsh[field] > 0)) fail(`dsh.${field} must be a positive number`);
  }
  if (!['debug', 'info', 'warn', 'error', 'silent'].includes(config.gateway.log.level)) fail('gateway.log.level is invalid');
  if (!Number.isInteger(config.gateway.concurrency) || config.gateway.concurrency < 1) fail('gateway.concurrency must be a positive integer');
  if (typeof config.gateway.stateDir !== 'string' || config.gateway.stateDir.length === 0) fail('gateway.stateDir must be a non-empty path');
  if (!Number.isInteger(config.gateway.http.port) || config.gateway.http.port < 0 || config.gateway.http.port > 65535) fail('gateway.http.port must be 0-65535');
  if (!['open', 'allowlist', 'pairing'].includes(config.gateway.access.dmPolicy)) fail('gateway.access.dmPolicy must be open|allowlist|pairing');
  if (!Array.isArray(config.gateway.access.allowFrom)) fail('gateway.access.allowFrom must be an array');
  if (!(Number.isFinite(config.gateway.access.pairingTtlSec) && config.gateway.access.pairingTtlSec > 0)) fail('gateway.access.pairingTtlSec must be positive');
  if (!Number.isFinite(config.gateway.reply.chunkChars) || config.gateway.reply.chunkChars < 100) fail('gateway.reply.chunkChars must be >= 100');
  if (!(config.gateway.reply.maxChunks === 0 || (Number.isInteger(config.gateway.reply.maxChunks) && config.gateway.reply.maxChunks > 0))) fail('gateway.reply.maxChunks must be 0 or a positive integer');
  if (!['auto', 'plain', 'markdown'].includes(config.gateway.reply.format)) fail('gateway.reply.format must be auto|plain|markdown');
  for (const key of Object.keys(config.channels ?? {})) {
    if (!CHANNEL_IDS.includes(key)) fail(`unknown channel "${key}" (expected one of ${CHANNEL_IDS.join(', ')})`);
  }
  for (const id of CHANNEL_IDS) {
    const channel = config.channels?.[id];
    if (channel === undefined) continue;
    if (typeof channel.enabled !== 'boolean') fail(`channels.${id}.enabled must be a boolean`);
    if (typeof channel.accountId !== 'string' || channel.accountId.length === 0) fail(`channels.${id}.accountId must be a non-empty string`);
    if (!Array.isArray(channel.allowFrom)) fail(`channels.${id}.allowFrom must be an array`);
  }
}

/**
 * Resolve merged access settings for one channel: channel-level values win over
 * gateway-level values, allowlists are unioned.
 *
 * @param {Record<string, any>} config
 * @param {string} channelId
 * @returns {{
 *   dmPolicy: 'open'|'allowlist'|'pairing',
 *   allowFrom: string[],
 *   pairingTtlSec: number,
 *   groups: { enabled: boolean, requireMention: boolean, allowFrom: string[] },
 * }}
 */
export function resolveAccess(config, channelId) {
  const global = config.gateway.access;
  const channel = config.channels?.[channelId] ?? {};
  const allowFrom = [...new Set([...(global.allowFrom ?? []), ...(channel.allowFrom ?? [])])];
  const globalGroups = global.groups ?? {};
  const channelGroups = channel.groups ?? {};
  const groups = {
    enabled: channelGroups.enabled ?? globalGroups.enabled ?? false,
    requireMention: channelGroups.requireMention ?? globalGroups.requireMention ?? true,
    allowFrom: Array.isArray(channelGroups.allowFrom) ? channelGroups.allowFrom : (globalGroups.allowFrom ?? []),
  };
  return {
    dmPolicy: channel.dmPolicy ?? global.dmPolicy ?? 'pairing',
    allowFrom,
    pairingTtlSec: Number(global.pairingTtlSec) || 600,
    groups,
  };
}

/** Channel ids with `enabled: true`. */
export function enabledChannels(config) {
  return CHANNEL_IDS.filter((id) => config.channels?.[id]?.enabled === true);
}

export { CHANNEL_IDS };
