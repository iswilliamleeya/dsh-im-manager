/**
 * Personal WeChat (个人微信) channel adapter — mode `ilink`.
 *
 * Protocol: Tencent official `openclaw-weixin` / iLink HTTP long-poll
 * (QR-code login, `getupdates`, `sendmessage`, `getconfig`/`sendtyping`,
 * `msg/notifystart|stop`). This is a different platform from the existing
 * 公众号 channel (`wechat`), which stays untouched.
 *
 * Lifecycle:
 *   - `start()` NEVER fails because no credential exists yet: it reports
 *     `health = disconnected` with a `weixin login` hint and polls the
 *     credential file every 3 seconds. A QR login performed while `serve` is
 *     running is picked up automatically (monitor starts, receive loop runs).
 *   - `-14` (stale token) stops the monitor and reports `disconnected` with a
 *     re-login hint; the gateway process keeps running.
 *   - `stop()` is idempotent: aborts the loop, sends `notifystop`, clears the
 *     credential watcher timer.
 *
 * Credential layout (written by `login.js`, mode 0600, atomic rename):
 * `<stateDir>/credentials.json` → `{version:1, token, ilinkBotId, userId?,
 * baseUrl, savedAt}`. `credentialsFile` in config overrides the path.
 *
 * @see docs/contracts.md §2, §5
 * @see docs/channels/weixin.md
 */
import { markdownToPlain } from '../../core/text.js';
import { ILinkClient } from './client.js';
import { normalizeWeixinConfig, validateWeixinConfig } from './config.js';
import { credentialFileSignature, credentialPath, readCredentialFile } from './credentials.js';
import { createWeixinMonitor } from './monitor.js';
import { createMediaDownloader, hydrateInboundMedia } from './media.js';
import { createContextTokenStore } from './storage.js';
import { createOutboundSender } from './outbound.js';
import { createTypingController } from './typing.js';
import { DEFAULT_CREDENTIAL_CHECK_INTERVAL_MS, describeError } from './protocol.js';

const NOOP_LOG = Object.freeze({
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return NOOP_LOG;
  },
});

/** Health detail shown while no credential file exists. */
const LOGIN_HINT = '未登录，运行 dsh-im-manager weixin login';

/**
 * Resolve the logger from an AdapterContext (tolerates partial fakes in tests).
 * @param {unknown} candidate
 * @param {string} [scope]
 */
function resolveLogger(candidate, scope) {
  const base = candidate !== null && typeof candidate === 'object' ? candidate : NOOP_LOG;
  if (typeof base.child !== 'function') return base;
  try {
    return base.child(scope);
  } catch {
    return base;
  }
}

/**
 * @param {unknown} value
 * @param {number} fallback
 */
function positiveInt(value, fallback) {
  return Number.isFinite(value) && value > 0 ? Math.max(1, Math.floor(Number(value))) : fallback;
}

/**
 * Create a personal-WeChat adapter instance.
 *
 * The default export is one such instance; tests and the CLI use the factory so
 * each run gets isolated state and injectable I/O.
 *
 * @param {{
 *   fetch?: typeof fetch,
 *   mediaFetch?: typeof fetch,
 *   transport?: unknown,
 *   now?: () => number,
 *   rand?: () => number,
 *   sleep?: (ms: number, signal?: AbortSignal) => Promise<void>,
 *   uuid?: () => string,
 *   credentialsPath?: (stateDir: string, config: Record<string, any>) => string,
 *   credentialsCheckIntervalMs?: number,
 * }} [deps]
 * @returns {import('../../core/types.js').Adapter & {
 *   whenIdle: () => Promise<void>,
 *   credentialPath: () => string | null,
 * }}
 */
export function createWeixinAdapter(deps = {}) {
  const clock = typeof deps.now === 'function' ? deps.now : Date.now;
  const overrideCredentialsPath = typeof deps.credentialsPath === 'function' ? deps.credentialsPath : null;
  const checkIntervalMs = positiveInt(deps.credentialsCheckIntervalMs, DEFAULT_CREDENTIAL_CHECK_INTERVAL_MS);

  /** @type {null | Record<string, any>} */
  let runtime = null;

  /**
   * @param {string} stateDir
   * @param {Record<string, any>} config
   * @returns {string}
   */
  function pathFor(stateDir, config) {
    if (overrideCredentialsPath !== null) return overrideCredentialsPath(stateDir, config);
    return credentialPath(stateDir, config);
  }

  /**
   * @param {Record<string, any>} state
   * @param {string} connection
   * @param {string} [detail]
   */
  function setConnection(state, connection, detail) {
    state.connection = connection;
    state.connectionDetail = detail ?? '';
  }

  /**
   * Poll the credential file; start/stop/reload the monitor accordingly.
   * Serialized through `state.checkChain` so overlapping timer ticks cannot
   * start two monitors.
   *
   * @param {Record<string, any>} state
   * @param {{ force?: boolean }} [options]
   * @returns {Promise<void>}
   */
  function checkCredential(state, options = {}) {
    state.checkChain = state.checkChain
      .then(() => checkCredentialOnce(state, options))
      .catch((error) => {
        state.log?.warn?.('weixin credential check failed', { error: describeError(error) });
      });
    return state.checkChain;
  }

  /**
   * @param {Record<string, any>} state
   * @param {{ force?: boolean }} options
   */
  async function checkCredentialOnce(state, options = {}) {
    if (state.stopped) return;
    const file = pathFor(state.ctx.stateDir, state.config);
    const signature = credentialFileSignature(file);
    if (options.force !== true && signature === state.credentialSignature) return;
    state.credentialSignature = signature;

    const credential = readCredentialFile(file);
    if (credential === undefined) {
      if (state.credential !== null || state.monitor !== null) {
        await stopMonitor(state, 'credentials removed');
        state.credential = null;
        state.staleToken = false;
        setConnection(state, 'disconnected', LOGIN_HINT);
        state.log?.info?.('weixin credential removed; long-poll stopped');
      } else {
        setConnection(state, 'disconnected', LOGIN_HINT);
      }
      return;
    }

    const previous = state.credential;
    const unchanged =
      previous !== null &&
      previous.token === credential.token &&
      previous.baseUrl === credential.baseUrl &&
      state.monitor !== null;
    state.credential = credential;
    if (unchanged) {
      state.log?.debug?.('weixin credential metadata refreshed');
      return;
    }

    state.staleToken = false;
    await stopMonitor(state, 'credentials changed');
    if (state.stopped) return;
    try {
      await startMonitor(state);
    } catch (error) {
      state.log?.error?.('weixin monitor failed to start', { error: describeError(error) });
      setConnection(state, 'disconnected', `微信长轮询启动失败：${describeError(error)}`);
    }
  }

  /**
   * Build the client + monitor + sender for the current credential.
   * @param {Record<string, any>} state
   */
  async function startMonitor(state) {
    const credential = state.credential;
    if (credential === null || state.stopped) return;
    const config = state.config;
    const client = new ILinkClient({
      baseUrl: credential.baseUrl !== '' ? credential.baseUrl : config.baseUrl,
      cdnBaseUrl: config.cdnBaseUrl,
      token: credential.token,
      requestTimeoutMs: config.requestTimeoutMs,
      longPollTimeoutMs: config.longPollTimeoutMs,
      botAgent: config.botAgent,
      ...(config.routeTag ? { routeTag: config.routeTag } : {}),
      ...(typeof deps.fetch === 'function' ? { fetch: deps.fetch } : {}),
      ...(deps.transport !== undefined ? { transport: deps.transport } : {}),
      ...(typeof deps.rand === 'function' ? { rand: deps.rand } : {}),
      now: clock,
    });

    const contextTokens = createContextTokenStore({
      file: `${state.ctx.stateDir}/context-tokens.json`,
      now: clock,
    });
    const typing = createTypingController({ client, enabled: config.typing, log: state.log, now: clock });
    const outbound = createOutboundSender({
      client,
      contextTokens,
      log: state.log,
      now: clock,
      ...(typeof deps.uuid === 'function' ? { uuid: deps.uuid } : {}),
    });
    const mediaConfig = state.config.media;
    const mediaDownloader =
      mediaConfig.download === false
        ? null
        : createMediaDownloader({
            ...(typeof deps.mediaFetch === 'function'
              ? { fetch: deps.mediaFetch }
              : typeof deps.fetch === 'function'
                ? { fetch: deps.fetch }
                : {}),
            cdnBaseUrl: config.cdnBaseUrl,
            stateDir: state.ctx.stateDir,
            maxBytes: mediaConfig.maxBytes,
            timeoutMs: mediaConfig.timeoutMs,
            ...(state.ctx.signal ? { signal: state.ctx.signal } : {}),
            log: state.log,
            now: clock,
          });
    const monitor = createWeixinMonitor({
      client,
      stateDir: state.ctx.stateDir,
      config,
      log: state.log,
      emit: (inbound) => state.ctx.emit(inbound),
      contextTokens,
      ilinkBotId: credential.ilinkBotId,
      ...(state.ctx.signal ? { signal: state.ctx.signal } : {}),
      now: clock,
      ...(typeof deps.sleep === 'function' ? { sleep: deps.sleep } : {}),
      onConnectionChange: (change) => {
        const previous = state.connection;
        setConnection(state, change.state, change.detail);
        if (change.state === 'connected' && previous !== 'connected') {
          state.log?.info?.('weixin long-poll connected', { ilinkBotId: credential.ilinkBotId });
        } else if (change.state === 'reconnecting') {
          state.log?.warn?.('weixin long-poll reconnecting', { detail: change.detail });
        }
      },
      onStaleToken: () => {
        state.staleToken = true;
        state.log?.warn?.('weixin bot token is stale (-14); re-login required');
        setConnection(state, 'disconnected', '微信登录已失效（-14），运行 dsh-im-manager weixin login 重新扫码');
      },
      ...(mediaDownloader !== null
        ? {
            hydrateInbound: (inbound) =>
              hydrateInboundMedia(inbound, {
                downloader: mediaDownloader,
                maxItems: mediaConfig.maxItemsPerMessage,
                log: state.log,
              }),
          }
        : {}),
    });

    state.client = client;
    state.contextTokens = contextTokens;
    state.typing = typing;
    state.outbound = outbound;
    state.monitor = monitor;

    setConnection(state, 'connecting', `正在连接微信（${credential.ilinkBotId}）…`);
    await monitor.start();
    state.log?.info?.('weixin adapter: long-poll started', {
      ilinkBotId: credential.ilinkBotId,
      baseUrl: client.baseUrl,
      mediaDownload: mediaConfig.download,
    });
  }

  /**
   * Stop the monitor and drop its client/sender wiring.
   * @param {Record<string, any>} state
   * @param {string} [reason]
   */
  async function stopMonitor(state, reason) {
    const monitor = state.monitor;
    state.monitor = null;
    state.client = null;
    state.outbound = null;
    state.typing = null;
    state.contextTokens = null;
    if (monitor !== null) {
      try {
        await monitor.stop();
      } catch (error) {
        state.log?.warn?.('weixin monitor stop failed', { error: describeError(error) });
      }
    }
    if (reason !== undefined) state.log?.debug?.(`weixin monitor stopped (${reason})`);
  }

  /**
   * @param {import('../../core/types.js').AdapterContext} ctx
   * @returns {Promise<void>}
   */
  async function start(ctx) {
    if (runtime !== null) return; // start() is idempotent
    if (ctx === null || typeof ctx !== 'object') {
      throw new Error('weixin: start(ctx) requires an AdapterContext');
    }
    if (typeof ctx.emit !== 'function') {
      throw new Error('weixin: ctx.emit must be a function (core contract)');
    }
    if (typeof ctx.stateDir !== 'string' || ctx.stateDir === '') {
      throw new Error('weixin: ctx.stateDir is required (core creates <gateway.stateDir>/channels/weixin)');
    }

    const config = validateWeixinConfig(normalizeWeixinConfig(/** @type {Record<string, any>} */ (ctx.config ?? {})));
    const log = resolveLogger(ctx.log, 'weixin');
    const state = {
      ctx,
      config,
      log,
      startedAt: clock(),
      stopped: false,
      credential: null,
      credentialSignature: undefined,
      client: null,
      monitor: null,
      outbound: null,
      typing: null,
      contextTokens: null,
      connection: 'disconnected',
      connectionDetail: LOGIN_HINT,
      staleToken: false,
      watcher: null,
      onAbort: null,
      checkChain: Promise.resolve(),
      lastInboundAt: null,
    };
    runtime = state;

    state.onAbort = () => {
      void stop();
    };
    if (ctx.signal && typeof ctx.signal.addEventListener === 'function') {
      if (ctx.signal.aborted) {
        ctx.signal.addEventListener('abort', state.onAbort, { once: true });
        await stop();
        return;
      }
      ctx.signal.addEventListener('abort', state.onAbort, { once: true });
    }

    // Credential watcher: a QR login can happen at any time while the gateway runs.
    const interval = positiveInt(deps.credentialsCheckIntervalMs, positiveInt(state.config.credentialsCheckIntervalMs, checkIntervalMs));
    state.watcher = setInterval(() => {
      void checkCredential(state);
    }, interval);
    state.watcher.unref?.();

    await checkCredential(state, { force: true });

    log.info?.('weixin adapter started', {
      mode: config.mode,
      credentialsFile: pathFor(ctx.stateDir, config),
    });
    if (state.credential === null) {
      log.info?.('weixin: not logged in; waiting for QR login credentials', { hint: LOGIN_HINT });
    }
  }

  /** Idempotent shutdown: abort the loop, notifystop, clear the watcher. */
  async function stop() {
    const state = runtime;
    if (state === null) return;
    runtime = null; // publish "never started" to concurrent health/stop callers
    if (state.stopped) return;
    state.stopped = true;

    try {
      state.ctx?.signal?.removeEventListener?.('abort', state.onAbort);
    } catch {
      // ignore polyfills that reject unknown listeners
    }
    if (state.watcher !== null) {
      clearInterval(state.watcher);
      state.watcher = null;
    }
    try {
      await state.checkChain;
    } catch {
      // checkCredential swallows its own errors
    }
    await stopMonitor(state, 'adapter stopped');
    state.log?.info?.('weixin adapter stopped');
  }

  /**
   * @param {import('../../core/types.js').ReplyTarget} target
   * @param {import('../../core/types.js').OutboundMessage} message
   * @returns {Promise<import('../../core/types.js').SendResult>}
   */
  async function send(target, message) {
    const state = runtime;
    if (state === null || state.stopped) throw new Error('weixin adapter is not started');
    if (state.credential === null) throw new Error(`weixin ${LOGIN_HINT}`);
    if (state.staleToken) {
      throw new Error('weixin 登录已失效（-14），运行 dsh-im-manager weixin login 重新扫码后再发送');
    }
    if (state.outbound === null) {
      throw new Error('weixin 长轮询尚未就绪，暂时无法发送消息，请稍后重试');
    }
    const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
    if (attachments.length > 0) {
      state.log?.warn?.('weixin 出站附件在 v1 不支持，仅发送文本', { count: attachments.length });
    }
    let text = String(message?.text ?? '');
    if (message?.format === 'markdown') text = markdownToPlain(text);
    if (text.trim() === '') return {};
    return state.outbound.send(target ?? {}, { ...message, text });
  }

  /**
   * Best-effort typing indicator (never throws to core).
   * @param {import('../../core/types.js').ReplyTarget} target
   */
  async function startTyping(target) {
    const state = runtime;
    if (state === null || state.typing === null) return;
    const peer = String(target?.conversationId ?? '');
    if (peer === '') return;
    const contextToken = state.contextTokens?.get(peer);
    await state.typing.start(peer, contextToken);
  }

  /**
   * @param {import('../../core/types.js').ReplyTarget} target
   */
  async function stopTyping(target) {
    const state = runtime;
    if (state === null || state.typing === null) return;
    const peer = String(target?.conversationId ?? '');
    if (peer === '') return;
    const contextToken = state.contextTokens?.get(peer);
    await state.typing.stop(peer, contextToken);
  }

  /** @returns {Promise<import('../../core/types.js').ChannelHealth>} */
  async function health() {
    const state = runtime;
    if (state === null) return { state: 'disconnected', detail: 'weixin adapter 未启动' };
    if (state.stopped) return { state: 'disconnected', detail: 'weixin adapter 已停止', since: state.startedAt };
    if (state.staleToken) {
      const botId = state.credential !== null ? `（ilinkBotId: ${state.credential.ilinkBotId}）` : '';
      return {
        state: 'disconnected',
        detail: `微信登录已失效（-14），运行 dsh-im-manager weixin login 重新扫码${botId}`,
        since: state.startedAt,
      };
    }
    if (state.credential === null) {
      return { state: 'disconnected', detail: LOGIN_HINT, since: state.startedAt };
    }
    const monitorHealth = state.monitor?.health;
    const monitorState = monitorHealth?.state ?? state.connection;
    const stateValue = ['connected', 'reconnecting', 'connecting'].includes(monitorState) ? monitorState : 'disconnected';
    const parts = [`ilinkBotId: ${state.credential.ilinkBotId}`];
    if (stateValue === 'connected') parts.push('长轮询已连接');
    else if (stateValue === 'reconnecting') parts.push('断线重连中');
    else if (stateValue === 'connecting') parts.push('连接中');
    else parts.push('长轮询未连接');
    const lastInboundAt = monitorHealth?.lastInboundAt ?? state.lastInboundAt;
    if (lastInboundAt) parts.push(`最后入站 ${new Date(lastInboundAt).toISOString()}`);
    const extraDetail =
      typeof monitorHealth?.detail === 'string' && monitorHealth.detail !== ''
        ? monitorHealth.detail
        : typeof state.connectionDetail === 'string'
          ? state.connectionDetail
          : '';
    if (
      (stateValue === 'reconnecting' || stateValue === 'disconnected') &&
      extraDetail !== '' &&
      extraDetail !== LOGIN_HINT &&
      extraDetail !== '长轮询已连接' &&
      extraDetail !== '已停止' &&
      !parts.includes(extraDetail)
    ) {
      parts.push(extraDetail);
    }
    return {
      state: stateValue,
      detail: parts.join('；'),
      since: state.startedAt,
    };
  }

  /** Test hook: resolves once pending credential checks/monitor starts settle. */
  async function whenIdle() {
    const state = runtime;
    if (state === null) return;
    await state.checkChain;
  }

  /** Test/CLI helper: the absolute credential path in use. */
  function currentCredentialPath() {
    const state = runtime;
    if (state === null) return null;
    return pathFor(state.ctx.stateDir, state.config);
  }

  return {
    id: 'weixin',
    capabilities: Object.freeze({
      text: true,
      markdown: false, // personal WeChat renders plain text; core degrades
      media: false, // outbound media not sent in v1; inbound media IS downloaded (see media.js)
      streaming: false,
      typing: true,
      threads: false,
    }),
    start,
    stop,
    send,
    startTyping,
    stopTyping,
    health,
    whenIdle,
    credentialPath: currentCredentialPath,
  };
}

/** Default adapter instance used by the core adapter registry. */
export default createWeixinAdapter();

/**
 * Doctor entry point: validate a raw `channels.weixin` config without starting
 * the adapter or performing any network I/O.
 * @param {Record<string, unknown>} [raw]
 */
export function validateConfig(raw = {}) {
  validateWeixinConfig(normalizeWeixinConfig(raw));
}

export { createWeixinAdapter as createAdapter };
export { runWeixinLogin } from './login.js';
export { credentialPath, readCredential, writeCredential, deleteCredential, redactCredential } from './credentials.js';
export { normalizeWeixinConfig, validateWeixinConfig } from './config.js';
export { mapInbound, mapItemAttachment, resolveMessageId, stableHash } from './inbound.js';
export { ILinkClient, StaleTokenError, WeixinError } from './client.js';
export { buildHeaders, buildApplicationHeaders, buildBaseInfo, encodeClientVersion } from './protocol.js';
