/**
 * Feishu / Lark channel adapter.
 *
 * Implements the Adapter contract in docs/contracts.md §2:
 *
 *   const adapter = createFeishuAdapter(deps?)
 *   adapter.id / adapter.capabilities
 *   adapter.start(ctx) / adapter.stop() / adapter.send(target, message)
 *   adapter.health()
 *
 * Modes:
 *   - 'ws' (default): Lark SDK WSClient long connection — no public URL needed;
 *   - 'webhook':      `ctx.http.route('POST', config.webhookPath, handler)`,
 *                     challenge/verification token/encryptKey handling, answers
 *                     Feishu within 3s and emits asynchronously.
 *
 * `createFeishuAdapter(deps)` exists so tests (and e2e fake platforms) can
 * inject a fake SDK / client / WebSocket client / clock without touching the
 * network. The default export is a ready-to-use adapter instance.
 */

import { normalizeFeishuConfig } from './config.js';
import { parseMessageEvent } from './event.js';
import { sendOutbound } from './outbound.js';
import { createSdkClient, loadLarkSdk } from './sdk.js';
import { createWebhookHandler } from './webhook.js';
import { readWsConnectionState, startWebSocket, stopWebSocket } from './ws.js';

/** In-memory guard against platform re-delivery, on top of core's dedupe. */
const DEDUPE_TTL_MS = 5 * 60_000;
const DEDUPE_MAX_ENTRIES = 1000;
/** Bot-info lookup must never block channel startup on a black-holed network. */
const BOT_INFO_TIMEOUT_MS = 3_000;

const CAPABILITIES = Object.freeze({
  text: true,
  // markdown is delivered as an interactive card with a lark_md block;
  // the adapter falls back to a plain text message when the card is rejected.
  markdown: true,
  media: false,
  streaming: false,
  typing: false,
  threads: true,
});

/**
 * @param {unknown} error
 * @returns {string}
 */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * @typedef {Object} FeishuAdapterDeps
 * @property {any} [lark]                       Pre-imported @larksuiteoapi/node-sdk module.
 * @property {any} [client]                     Pre-built Lark SDK Client (wins over createClient).
 * @property {(options: { config: Record<string, any>, lark: any, log?: any }) => any} [createClient]
 * @property {(options: { config: Record<string, any>, eventDispatcher: any, sdkOptions: Record<string, any>, log?: any, onState: Function }) => any} [createWsClient]
 * @property {() => number} [now]               Clock injection for tests.
 */

/**
 * @param {FeishuAdapterDeps} [deps]
 * @returns {import('../../core/types.js').Adapter}
 */
export function createFeishuAdapter(deps = {}) {
  const now = typeof deps.now === 'function' ? deps.now : Date.now;

  let started = false;
  let starting = false;
  /** @type {Record<string, any> | null} */
  let config = null;
  /** @type {import('../../core/types.js').AdapterContext | null} */
  let ctx = null;
  /** @type {import('../../core/types.js').Logger | undefined} */
  let log;
  /** @type {any} */
  let lark;
  /** @type {any} */
  let client;
  /** @type {any} */
  let wsClient;
  /** @type {(() => void) | null} */
  let routeDispose = null;
  /** @type {(state: 'connected' | 'connecting' | 'degraded' | 'disconnected', detail?: string) => void} */
  let setWsState = () => {};
  /** @type {'connected' | 'connecting' | 'degraded' | 'disconnected'} */
  let wsState = 'disconnected';
  /** @type {string | undefined} */
  let wsDetail;
  /** @type {(() => void) | undefined} */
  let abortHandler;
  /** @type {import('./event.js').BotIdentity} */
  let bot = {};
  let startedAt = 0;
  /** @type {Map<string, number>} */
  const seen = new Map();

  setWsState = (next, detail) => {
    wsState = next;
    wsDetail = detail;
  };

  /** @param {string} messageId @returns {boolean} */
  function isDuplicate(messageId) {
    const at = now();
    if (seen.has(messageId)) return true;
    seen.set(messageId, at);
    if (seen.size > DEDUPE_MAX_ENTRIES) {
      for (const [key, timestamp] of seen) {
        if (at - timestamp > DEDUPE_TTL_MS) seen.delete(key);
      }
      if (seen.size > DEDUPE_MAX_ENTRIES) {
        const excess = [...seen.entries()]
          .sort((left, right) => left[1] - right[1])
          .slice(0, seen.size - DEDUPE_MAX_ENTRIES);
        for (const [key] of excess) seen.delete(key);
      }
    }
    return false;
  }

  /**
   * Best-effort lookup of the bot's own open_id so that @-mentions can be
   * matched exactly. Falls back to Feishu's `@_user_1` placeholder convention
   * when the API is not reachable (e.g. permission missing).
   *
   * @returns {Promise<void>}
   */
  async function resolveBotIdentity() {
    if (config !== null && config.botOpenId.length > 0) {
      bot = { openId: config.botOpenId, ...(config.botName.length > 0 ? { name: config.botName } : {}) };
      return;
    }
    if (config !== null && config.botName.length > 0) bot = { name: config.botName };
    if (client === null || client === undefined || typeof client.request !== 'function') return;
    /** @type {NodeJS.Timeout | undefined} */
    let timer;
    try {
      const response = await Promise.race([
        client.request({ method: 'GET', url: '/open-apis/bot/v3/info' }),
        new Promise((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`bot info timed out after ${BOT_INFO_TIMEOUT_MS}ms`)), BOT_INFO_TIMEOUT_MS);
          timer.unref?.();
        }),
      ]);
      const info = response?.bot ?? response?.data?.bot;
      if (info !== null && typeof info === 'object' && typeof info.open_id === 'string' && info.open_id.length > 0) {
        bot = {
          openId: info.open_id,
          ...(config !== null && config.botName.length > 0
            ? { name: config.botName }
            : (typeof info.app_name === 'string' && info.app_name.length > 0 ? { name: info.app_name } : {})),
        };
        log?.debug?.('feishu bot identity resolved', { openId: info.open_id });
      }
    } catch (error) {
      log?.debug?.('feishu bot identity unavailable; using @_user_1 mention convention', {
        error: errorMessage(error),
      });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * Normalize + emit one platform event. Never rejects: SDK/webhook callers
   * must not crash on a malformed event.
   *
   * @param {unknown} payload
   * @param {'ws' | 'webhook'} source
   * @returns {Promise<void>}
   */
  async function handleEvent(payload, source) {
    const activeConfig = config;
    const activeCtx = ctx;
    if (activeConfig === null || activeCtx === null) return;

    let inbound;
    try {
      inbound = parseMessageEvent(payload, { accountId: activeConfig.accountId, bot, now });
    } catch (error) {
      log?.warn?.('feishu inbound parse failed', { source, error: errorMessage(error) });
      return;
    }
    if (inbound === null) {
      log?.debug?.('feishu event ignored', { source });
      return;
    }
    if (isDuplicate(inbound.messageId)) {
      log?.debug?.('feishu duplicate event ignored', {
        source,
        messageId: inbound.messageId,
      });
      return;
    }
    try {
      await activeCtx.emit(inbound);
    } catch (error) {
      log?.error?.('feishu emit failed', { error: errorMessage(error) });
    }
  }

  /** Release everything acquired by start(). Safe to call on partial state. */
  async function cleanup() {
    if (abortHandler !== undefined) {
      const handler = abortHandler;
      abortHandler = undefined;
      const signal = ctx?.signal;
      if (signal !== null && signal !== undefined && typeof signal.removeEventListener === 'function') {
        try {
          signal.removeEventListener('abort', handler);
        } catch {
          // ignore
        }
      }
    }
    if (routeDispose !== null) {
      const dispose = routeDispose;
      routeDispose = null;
      try {
        dispose();
      } catch (error) {
        log?.debug?.('feishu webhook route dispose failed', { error: errorMessage(error) });
      }
    }
    const pendingWs = wsClient;
    wsClient = null;
    try {
      if (pendingWs !== null && pendingWs !== undefined) {
        await stopWebSocket(pendingWs, log);
      }
    } catch (error) {
      // A failed socket teardown must not leave the singleton-looking adapter
      // marked as started: startup would then fail with "already started".
      log?.debug?.('feishu websocket stop failed', { error: errorMessage(error) });
    } finally {
      wsState = 'disconnected';
      wsDetail = undefined;
      started = false;
      starting = false;
      startedAt = 0;
      seen.clear();
      client = null;
      ctx = null;
      bot = {};
    }
  }

  const adapter = {
    id: 'feishu',
    capabilities: CAPABILITIES,

    /**
     * @param {import('../../core/types.js').AdapterContext} context
     * @returns {Promise<void>}
     */
    async start(context) {
      if (started) throw new Error('feishu: adapter already started');
      if (starting) throw new Error('feishu: adapter is already starting');
      starting = true;
      try {
        if (context === null || typeof context !== 'object' || typeof context.emit !== 'function') {
          throw new TypeError('feishu: start(ctx) requires an AdapterContext with emit()');
        }
        ctx = context;
        log = context.log?.child !== undefined ? context.log.child('feishu') : context.log;
        config = normalizeFeishuConfig(context.config ?? {});
        lark = await loadLarkSdk(deps.lark);
        client = deps.client
          ?? (typeof deps.createClient === 'function'
            ? deps.createClient({ config, lark, log })
            : createSdkClient({ lark, config, log }));
        if (client === null || client === undefined) {
          throw new Error('feishu: failed to create the Lark API client');
        }

        await resolveBotIdentity();

        if (config.mode === 'webhook') {
          if (context.http === null || context.http === undefined || typeof context.http.route !== 'function') {
            throw new Error(
              'feishu: mode="webhook" requires the gateway HTTP host — '
                + 'set gateway.http.enabled=true and expose the public base URL',
            );
          }
          const handler = createWebhookHandler({ config, log, onEvent: handleEvent });
          /** @type {unknown} */
          let dispose;
          try {
            dispose = context.http.route('POST', config.webhookPath, handler);
          } catch (error) {
            throw new Error(
              'feishu: mode="webhook" requires the gateway HTTP host — '
                + `cannot register POST ${config.webhookPath}: ${errorMessage(error)}. `
                + 'Set gateway.http.enabled=true and expose the public base URL.',
              { cause: error },
            );
          }
          routeDispose = typeof dispose === 'function' ? dispose : null;
        } else {
          wsState = 'connecting';
          const startedWs = await startWebSocket({
            lark,
            config,
            log,
            createWsClient: deps.createWsClient,
            onEvent: handleEvent,
            onState: setWsState,
          });
          wsClient = startedWs.wsClient;
        }

        startedAt = now();
        started = true;
        if (context.signal !== null && context.signal !== undefined && typeof context.signal.addEventListener === 'function') {
          const onAbort = () => {
            void adapter.stop().catch((error) => {
              log?.warn?.('feishu stop after abort failed', { error: errorMessage(error) });
            });
          };
          abortHandler = onAbort;
          if (context.signal.aborted === true) {
            onAbort();
          } else {
            context.signal.addEventListener('abort', onAbort, { once: true });
          }
        }
        log?.info?.('feishu channel started', {
          mode: config.mode,
          domain: config.domain === 'feishu' || config.domain === 'lark' ? config.domain : 'custom',
          webhookPath: config.mode === 'webhook' ? config.webhookPath : undefined,
        });
      } catch (error) {
        await cleanup();
        throw error;
      } finally {
        starting = false;
      }
    },

    /** Idempotent. */
    async stop() {
      if (!started && !starting) return;
      await cleanup();
      log?.info?.('feishu channel stopped');
    },

    /**
     * @param {import('../../core/types.js').ReplyTarget} target
     * @param {import('../../core/types.js').OutboundMessage} message
     * @returns {Promise<import('../../core/types.js').SendResult>}
     */
    async send(target, message) {
      if (!started || config === null) {
        throw new Error('feishu: adapter is not started; call start(ctx) before send()');
      }
      return sendOutbound({ client, config, target, message, log });
    },

    /** @returns {Promise<import('../../core/types.js').ChannelHealth>} */
    async health() {
      if (!started) return { state: 'disconnected', detail: 'not started' };
      if (config !== null && config.mode === 'webhook') {
        return {
          state: 'connected',
          detail: `webhook ${config.webhookPath}`,
          since: startedAt,
        };
      }
      const fromSdk = readWsConnectionState(wsClient);
      const state = fromSdk?.state ?? wsState;
      const detail = fromSdk?.detail ?? wsDetail;
      return { state, ...(detail !== undefined ? { detail } : {}), since: startedAt };
    },
  };

  return adapter;
}

/**
 * Config validator used by `dsh-im-manager doctor` (see src/cli.js): throws a
 * clear error for missing/invalid Feishu fields without starting the channel.
 *
 * @param {Record<string, unknown>} raw
 * @returns {void}
 */
export function validateConfig(raw) {
  normalizeFeishuConfig(raw ?? {});
}

const defaultAdapter = createFeishuAdapter();

export default defaultAdapter;
