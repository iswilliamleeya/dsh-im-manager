/**
 * WeCom (企业微信) channel adapter.
 *
 * Modes:
 *  - `ws` (default): 智能机器人 long connection. `botId` + `secret`; replies go
 *    back over the same socket via `aibot_respond_msg` using the inbound
 *    `req_id` (see `ws-client.js` / `ws-protocol.js`).
 *  - `webhook`: 自建应用 callback. `token` + `encodingAESKey` + `corpId` +
 *    `agentId` + `secret`; GET verification and encrypted POST callbacks are
 *    answered immediately, outbound uses `cgi-bin/message/send`.
 *
 * Adapter contract: docs/contracts.md §2 / §5. No core/bridge imports; only
 * Node built-ins, `fast-xml-parser`, and the platform HTTP APIs.
 */
import { WecomAppApi } from './api.js';
import { normalizeWecomConfig, validateWecomConfig } from './config.js';
import { mapWsInbound } from './inbound.js';
import { createWebhookHandler } from './webhook.js';
import { WecomWsConnection } from './ws-client.js';

const NOOP_LOG = Object.freeze({
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return NOOP_LOG;
  },
});

/**
 * @param {{ fetchImpl?: typeof fetch, webSocketFactory?: (options: { url: string }) => any, now?: () => number }} [deps]
 * @returns {import('../../core/types.js').Adapter}
 */
const DUPLICATE_TTL_MS = 10 * 60 * 1000;
const DUPLICATE_MAX_ENTRIES = 5_000;

export function createWecomAdapter(deps = {}) {
  /** @type {null | Record<string, any>} */
  let runtime = null;

  /**
   * @param {import('../../core/types.js').AdapterContext} ctx
   */
  async function start(ctx) {
    if (runtime !== null) throw new Error('wecom adapter has already been started');
    const config = normalizeWecomConfig(/** @type {Record<string, any>} */ (ctx.config));
    validateWecomConfig(config);
    const log = typeof ctx.log === 'object' && ctx.log !== null ? ctx.log : NOOP_LOG;
    const startedAt = Date.now();
    const state = {
      ctx,
      config,
      log,
      startedAt,
      stopped: false,
      mode: config.mode,
      /** @type {WecomWsConnection | null} */
      ws: null,
      /** @type {WecomAppApi | null} */
      api: null,
      /** conversationId → { chatId, chatType, lastInboundAt } for proactive sends */
      activatedChats: new Map(),
      /** platform may re-deliver callbacks; core dedupes too, this is a cheap first line */
      seenMessages: new Map(),
      webhookPath: config.webhookPath,
    };
    runtime = state;

    const onAbort = () => {
      void stop();
    };
    state.onAbort = onAbort;

    if (ctx.signal?.aborted) {
      ctx.signal.addEventListener('abort', onAbort, { once: true });
      await stop();
      return;
    }
    ctx.signal?.addEventListener('abort', onAbort, { once: true });

    if (config.mode === 'ws') {
      state.ws = new WecomWsConnection({
        url: config.wsUrl,
        botId: config.botId,
        secret: config.secret,
        heartbeatIntervalMs: config.heartbeatIntervalMs,
        reconnectInitialDelayMs: config.reconnectInitialDelayMs,
        reconnectMaxDelayMs: config.reconnectMaxDelayMs,
        authTimeoutMs: config.authTimeoutMs,
        replyAckTimeoutMs: config.replyAckTimeoutMs,
        maxMissedPong: config.maxMissedPong,
        reconnectOnKicked: config.reconnectOnKicked,
        ...(typeof deps.webSocketFactory === 'function' ? { webSocketFactory: deps.webSocketFactory } : {}),
        log,
        onMessage: (callback) => {
          void handleWsCallback(state, callback);
        },
        onStateChange: (health) => {
          log.debug?.('wecom ws state changed', health);
        },
        onKicked: (reason) => {
          log.warn?.(`wecom ws was kicked by another connection: ${reason}`);
        },
      });
      state.ws.start();
    } else {
      state.api = new WecomAppApi({
        corpId: config.corpId,
        agentId: config.agentId,
        secret: config.secret,
        apiBaseUrl: config.apiBaseUrl,
        requestTimeoutMs: config.requestTimeoutMs,
        ...(typeof deps.fetchImpl === 'function' ? { fetchImpl: deps.fetchImpl } : {}),
        log,
      });
      const handler = createWebhookHandler({
        config: {
          token: config.token,
          encodingAESKey: config.encodingAESKey,
          corpId: config.corpId,
          botName: config.botName,
          accountId: config.accountId,
        },
        emit: (inbound) => handleInbound(state, inbound),
        log,
      });
      ctx.http.route('GET', config.webhookPath, (request) => handler.handleGet(request));
      ctx.http.route('POST', config.webhookPath, (request) => handler.handlePost(request));
    }

    log.info?.('wecom adapter started', {
      mode: config.mode,
      ...(config.mode === 'webhook' ? { webhookPath: config.webhookPath } : {}),
    });
  }

  /**
   * @param {Record<string, any>} state
   * @param {{ kind: 'message'|'event', reqId: string, msg: Record<string, any>, msgId?: string, eventType?: string }} callback
   */
  async function handleWsCallback(state, callback) {
    if (state.stopped) return;
    if (callback.kind !== 'message') {
      state.log.debug?.('wecom ws event callback ignored (v1)', { eventType: callback.eventType });
      return;
    }
    try {
      const inbound = mapWsInbound({
        msg: callback.msg,
        reqId: callback.reqId,
        accountId: state.config.accountId,
        botName: state.config.botName,
      });
      if (inbound === null) {
        state.log.debug?.('wecom ws callback ignored (event/unsupported/empty)', { msgId: callback.msgId });
        return;
      }
      const raw = /** @type {Record<string, any>} */ (inbound.target.raw ?? {});
      if (raw.chatId) {
        state.activatedChats.set(inbound.conversationId, {
          chatId: raw.chatId,
          chatType: raw.chatType,
          lastInboundAt: Date.now(),
        });
      }
      await handleInbound(state, inbound);
    } catch (error) {
      state.log.warn?.(`wecom ws inbound dispatch failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Drop platform re-deliveries (same conversation + messageId within TTL), then
   * hand the message to core. Core performs its own dedupe as well.
   * @param {Record<string, any>} state
   * @param {import('../../core/types.js').InboundMessage} inbound
   */
  async function handleInbound(state, inbound) {
    const now = Date.now();
    for (const [key, seenAt] of state.seenMessages) {
      if (now - seenAt > DUPLICATE_TTL_MS) state.seenMessages.delete(key);
    }
    const key = `${inbound.conversationId}\u0000${inbound.messageId}`;
    if (state.seenMessages.has(key)) {
      state.log.debug?.('wecom duplicate callback skipped', { messageId: inbound.messageId });
      return;
    }
    state.seenMessages.set(key, now);
    if (state.seenMessages.size > DUPLICATE_MAX_ENTRIES) {
      const oldest = state.seenMessages.keys().next().value;
      if (oldest !== undefined) state.seenMessages.delete(oldest);
    }
    await state.ctx.emit(inbound);
  }

  /** Idempotent shutdown. */
  async function stop() {
    const state = runtime;
    if (state === null || state.stopped) return;
    state.stopped = true;
    try {
      state.ctx?.signal?.removeEventListener('abort', state.onAbort);
    } catch {
      // ignore
    }
    try {
      state.ws?.stop();
    } catch (error) {
      state.log.warn?.(`wecom ws stop failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    state.ws = null;
    state.api = null;
    state.activatedChats.clear();
    state.seenMessages.clear();
    runtime = null;
    state.log.info?.('wecom adapter stopped');
  }

  /**
   * @param {import('../../core/types.js').ReplyTarget} target
   * @param {import('../../core/types.js').OutboundMessage} message
   * @returns {Promise<import('../../core/types.js').SendResult>}
   */
  async function send(target, message) {
    const state = runtime;
    if (state === null || state.stopped) throw new Error('wecom adapter is not running');
    const text = String(message?.text ?? '');
    if (text.trim() === '') return {};

    if (state.mode === 'ws') {
      const raw = /** @type {Record<string, any>} */ (target?.raw ?? {});
      const reqId = String(raw.reqId ?? raw.ws?.reqId ?? '').trim();
      if (reqId !== '') {
        await state.ws.replyStream({ reqId, content: text });
        return {};
      }
      const activated = state.activatedChats.get(String(target?.conversationId ?? ''));
      if (activated?.chatId) {
        // Proactive push is quota-limited by WeCom and only allowed for
        // conversations that already messaged the bot; never invent one.
        await state.ws.sendMarkdown({ chatId: activated.chatId, content: text });
        return {};
      }
      throw new Error('wecom ws: no reply context (req_id) and no activated conversation for a proactive send');
    }

    return state.api.sendMessage({ target, text, format: message?.format ?? 'plain' });
  }

  /** @returns {Promise<import('../../core/types.js').ChannelHealth>} */
  async function health() {
    const state = runtime;
    if (state === null) return { state: 'disconnected', detail: 'not started' };
    if (state.mode === 'ws') {
      if (state.stopped) return { state: 'disconnected', detail: 'stopped', since: state.startedAt };
      return state.ws.health();
    }
    return {
      state: state.stopped ? 'disconnected' : 'connected',
      detail: state.stopped ? 'stopped' : `webhook listening on ${state.webhookPath}`,
      since: state.startedAt,
    };
  }

  return {
    id: 'wecom',
    capabilities: {
      text: true,
      markdown: true,
      media: false,
      streaming: false,
      typing: false,
      threads: false,
    },
    start,
    stop,
    send,
    health,
  };
}

/** Default adapter instance used by the core adapter registry. */
export default createWecomAdapter();

export { createWebhookHandler } from './webhook.js';
export { WecomAppApi } from './api.js';
export { WecomWsConnection } from './ws-client.js';
export { mapWsInbound, mapWebhookInbound } from './inbound.js';
export { normalizeWecomConfig, validateWecomConfig } from './config.js';

/**
 * Doctor entry point: validate a raw `channels.wecom` config without starting
 * the adapter or performing any network I/O.
 * @param {Record<string, unknown>} [raw]
 */
export function validateConfig(raw = {}) {
  validateWecomConfig(normalizeWecomConfig(raw));
}
