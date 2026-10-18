/**
 * Small helpers around the optional `@larksuiteoapi/node-sdk` dependency.
 *
 * The SDK is loaded lazily so that:
 *   - the adapter module itself can be imported without the dependency
 *     (registry import only fails the feishu channel, not the whole gateway);
 *   - tests can inject a fake SDK/client without touching the network.
 */

/** @type {Promise<any> | null} */
let sdkPromise = null;

/**
 * @param {any} [injected]
 * @returns {Promise<any>}
 */
export async function loadLarkSdk(injected) {
  if (injected !== undefined && injected !== null) return injected;
  if (sdkPromise === null) {
    sdkPromise = import('@larksuiteoapi/node-sdk').catch((error) => {
      sdkPromise = null;
      throw new Error(
        'feishu: @larksuiteoapi/node-sdk is required but not installed — '
          + 'run `npm install` in the dsh-im-manager directory',
        { cause: error },
      );
    });
  }
  return sdkPromise;
}

/**
 * Map our config `domain` onto the SDK's Domain enum (or pass a custom
 * base URL through unchanged — useful for local fake platforms in tests).
 *
 * @param {string} domain
 * @param {any} lark
 * @returns {unknown}
 */
export function resolveSdkDomain(domain, lark) {
  if (domain === 'lark') return lark?.Domain?.Lark ?? 'lark';
  if (domain === 'feishu' || domain === undefined || domain === '') {
    return lark?.Domain?.Feishu ?? 'feishu';
  }
  return domain;
}

/**
 * Adapt the gateway logger to the shape the Lark SDK expects.
 *
 * The SDK's `LoggerProxy` calls `logger.error(msgArray)` etc. We forward only
 * SDK errors/warnings (as warn/debug) — the SDK is chatty at info level and its
 * messages are never worth the noise in gateway logs.
 *
 * The SDK's axios error formatter includes the request body of failed calls;
 * for a failed `tenant_access_token` request that body contains `app_secret`.
 * Every configured secret is therefore scrubbed out of the rendered text
 * before it reaches the gateway logger.
 *
 * @param {import('../../core/types.js').Logger | undefined} log
 * @param {unknown[]} [redactValues]  Secrets to scrub from SDK log lines.
 * @returns {{ error: (...args: unknown[]) => void, warn: (...args: unknown[]) => void, info: () => void, debug: () => void, trace: () => void }}
 */
export function createSdkLogger(log, redactValues = []) {
  const secrets = redactValues.filter((value) => typeof value === 'string' && value.length >= 4);
  /** @param {string} text */
  const scrub = (text) => secrets.reduce((out, secret) => out.split(secret).join('***'), text);
  /** @param {unknown[]} args */
  const stringify = (args) => args
    .map((arg) => {
      if (typeof arg === 'string') return arg;
      if (arg instanceof Error) return arg.message;
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    })
    .join(' ');
  return {
    error: (...args) => log?.warn?.(`lark sdk: ${scrub(stringify(args))}`),
    warn: (...args) => log?.debug?.(`lark sdk: ${scrub(stringify(args))}`),
    info: () => {},
    debug: () => {},
    trace: () => {},
  };
}

/**
 * @param {{ lark: any, config: Record<string, any>, log?: import('../../core/types.js').Logger }} options
 * @returns {any}
 */
export function createSdkClient({ lark, config, log }) {
  return new lark.Client({
    appId: config.appId,
    appSecret: config.appSecret,
    domain: resolveSdkDomain(config.domain, lark),
    loggerLevel: lark.LoggerLevel?.error ?? 1,
    logger: createSdkLogger(log, [config.appSecret, config.encryptKey, config.verificationToken]),
  });
}
