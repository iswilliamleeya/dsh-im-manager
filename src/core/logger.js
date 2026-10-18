/**
 * Structured JSON-lines logger. Every line is one JSON object on stderr so a
 * supervisor (launchd/systemd/journald) can collect it without parsing prose.
 *
 * Secret-looking fields are redacted structurally; adapters must still avoid
 * passing raw credentials as free-text messages.
 */
import { format } from 'node:util';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
const SECRET_KEY = /^(authorization|token|access_token|accesstoken|appsecret|app_secret|secret|encodingaeskey|encoding_aes_key|clientsecret|client_secret|password|apikey|api_key|encryptkey|encrypt_key|verificationtoken|verification_token)$/i;

/**
 * @param {unknown} value
 * @param {number} depth
 * @returns {unknown}
 */
function sanitize(value, depth = 0) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'string' && /^Bearer\s+/i.test(value)) return '[redacted bearer]';
    return value;
  }
  if (depth > 4) return '[depth]';
  if (value instanceof Error) {
    return { name: value.name, message: value.message, code: value.code, stack: value.stack };
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitize(item, depth + 1));
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = SECRET_KEY.test(key) ? '***' : sanitize(item, depth + 1);
  }
  return out;
}

/**
 * Render one line payload.
 * @param {string} level
 * @param {string[]} scopes
 * @param {Record<string, unknown>} base
 * @param {unknown[]} args
 * @param {number} now
 */
function render(level, scopes, base, args, now) {
  /** @type {Record<string, unknown>} */
  const line = { time: new Date(now).toISOString(), level, ...base };
  if (scopes.length > 0) line.scope = scopes.join('/');
  const first = args[0];
  let rest = args;
  if (typeof first === 'string') {
    line.msg = first;
    rest = args.slice(1);
  } else if (first !== undefined) {
    line.msg = format(...args);
    rest = [];
  }
  if (rest.length === 1 && rest[0] !== null && typeof rest[0] === 'object' && !(rest[0] instanceof Error)) {
    Object.assign(line, sanitize(rest[0], 1));
  } else if (rest.length > 0) {
    line.args = rest.map((item) => sanitize(item, 1));
  }
  return `${JSON.stringify(line)}\n`;
}

/**
 * Create a logger.
 *
 * @param {{
 *   level?: 'debug'|'info'|'warn'|'error'|'silent',
 *   stream?: NodeJS.WritableStream,
 *   base?: Record<string, unknown>,
 *   scopes?: string[],
 *   now?: () => number,
 * }} [options]
 */
export function createLogger(options = {}) {
  const level = options.level ?? 'info';
  const threshold = LEVELS[level] ?? LEVELS.info;
  const stream = options.stream ?? process.stderr;
  const base = options.base ?? {};
  const scopes = options.scopes ?? [];
  const now = options.now ?? Date.now;

  /** @param {string} name */
  function at(name) {
    if ((LEVELS[name] ?? 0) < threshold) return () => {};
    return (...args) => {
      try {
        stream.write(render(name, scopes, base, args, now()));
      } catch {
        // Logging must never take the gateway down.
      }
    };
  }

  /** @type {import('./types.js').Logger} */
  const logger = {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    child(scope) {
      return createLogger({ level, stream, base, scopes: [...scopes, scope], now });
    },
  };
  return logger;
}

/** A logger that writes nothing, for tests. */
export const silentLogger = createLogger({ level: 'silent' });
