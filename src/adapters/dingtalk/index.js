/**
 * DingTalk channel adapter (钉钉).
 *
 * Implements the Adapter contract from docs/contracts.md §2:
 *   - mode 'stream'  (default): DingTalk Stream Mode via the `dingtalk-stream` SDK;
 *     no public URL required.
 *   - mode 'webhook': HTTP callback registered on the gateway HTTP host with
 *     timestamp/HMAC-SHA256 signature verification.
 *
 * Inbound messages are normalized to InboundMessage; replies go out through the
 * per-message `sessionWebhook` carried by every robot callback (markdown or
 * text). See docs/channels/dingtalk.md for setup.
 *
 * Test seams: `createAdapter({ streamClientFactory, fetch, now })` plus the
 * named pure helpers re-exported below. Nothing in this module performs network
 * I/O at import time, so it is safe to import when credentials are absent.
 */
import { ADAPTER_ID, normalizeConfig, validateConfig } from './config.js';
import { parseInbound } from './inbound.js';
import {
  buildOutboundPayload,
  deriveMarkdownTitle,
  resolveSessionWebhook,
  sendViaSessionWebhook,
} from './outbound.js';
import { createDefaultStreamClient, startStreamTransport, TOPIC_ROBOT } from './stream.js';
import {
  computeWebhookSign,
  createWebhookHandler,
  extractWebhookSignature,
  normalizeWebhookPayload,
  verifyWebhookSignature,
} from './webhook.js';

/** Platform redelivery guard: drop duplicate message ids within this window. */
export const DEDUPE_TTL_MS = 60_000;
/** Upper bound on the dedupe map (oldest entries are evicted first). */
export const DEDUPE_MAX_ENTRIES = 10_000;

const NOOP = () => {};
const SILENT_LOG = Object.freeze({
  debug: NOOP,
  info: NOOP,
  warn: NOOP,
  error: NOOP,
  child: () => SILENT_LOG,
});

/**
 * @param {unknown} log
 * @returns {import('../../core/types.js').Logger}
 */
function resolveLogger(log) {
  if (log !== null && typeof log === 'object' && typeof log.info === 'function') {
    return /** @type {import('../../core/types.js').Logger} */ (log);
  }
  return SILENT_LOG;
}

/**
 * @param {{ ttlMs: number, maxEntries: number, now: () => number }} options
 * @returns {{ add: (key: string) => boolean, clear: () => void, size: number }}
 */
export function createDedupe(options) {
  /** @type {Map<string, number>} */
  const seen = new Map();
  /** @param {number} now */
  function prune(now) {
    for (const [key, timestamp] of seen) {
      if (now - timestamp > options.ttlMs) seen.delete(key);
    }
    while (seen.size > options.maxEntries) {
      const oldest = seen.keys().next().value;
      if (oldest === undefined) break;
      seen.delete(oldest);
    }
  }
  return {
    /** @param {string} key @returns {boolean} true when the key was not seen before. */
    add(key) {
      const now = options.now();
      prune(now);
      const previous = seen.get(key);
      if (previous !== undefined && now - previous < options.ttlMs) return false;
      seen.set(key, now);
      return true;
    },
    clear() {
      seen.clear();
    },
    get size() {
      return seen.size;
    },
  };
}

/**
 * @param {unknown} payload Stream callback envelope (`{ headers, data }`) or a
 *   plain robot message object (webhook mode).
 * @returns {Record<string, unknown> | null}
 */
export function extractRobotMessage(payload) {
  if (payload === null || typeof payload !== 'object') return null;
  const record = /** @type {Record<string, unknown>} */ (payload);
  if (
    typeof record.data === 'string'
    && record.headers !== null
    && typeof record.headers === 'object'
  ) {
    try {
      const parsed = JSON.parse(record.data);
      return parsed !== null && typeof parsed === 'object' ? /** @type {Record<string, unknown>} */ (parsed) : null;
    } catch {
      return null;
    }
  }
  return record;
}

/**
 * Create a DingTalk adapter instance.
 *
 * @param {{
 *   streamClientFactory?: (config: Record<string, unknown>) => Promise<any> | any,
 *   fetch?: typeof fetch,
 *   now?: () => number,
 * }} [dependencies] Injectable seams for tests (the real SDK/fetch/clock are defaults).
 * @returns {import('../../core/types.js').Adapter & {
 *   __testing: { config: () => Record<string, unknown> | null, dedupeSize: () => number },
 * }}
 */
export function createAdapter(dependencies = {}) {
  const streamClientFactory = typeof dependencies.streamClientFactory === 'function'
    ? dependencies.streamClientFactory
    : createDefaultStreamClient;
  const fetchImpl = typeof dependencies.fetch === 'function' ? dependencies.fetch : globalThis.fetch;
  const clock = typeof dependencies.now === 'function' ? dependencies.now : Date.now;
  const dedupe = createDedupe({ ttlMs: DEDUPE_TTL_MS, maxEntries: DEDUPE_MAX_ENTRIES, now: clock });

  /** @type {'stopped'|'starting'|'running'|'stopping'} */
  let state = 'stopped';
  /** @type {null | { config: any, log: any, client: any, transport: any, startedAt: number, mode: 'stream'|'webhook', abortListener?: () => void, signal?: AbortSignal }} */
  let runtime = null;
  /** @type {Promise<void> | null} */
  let stopPromise = null;

  /**
   * @param {any} session
   * @param {unknown} payload
   * @param {(inbound: import('../../core/types.js').InboundMessage) => Promise<void>} emit
   */
  async function handlePayload(session, payload, emit) {
    const streamMessageId = payload !== null
      && typeof payload === 'object'
      && payload.headers !== null
      && typeof payload.headers === 'object'
      && typeof payload.headers.messageId === 'string'
      ? payload.headers.messageId
      : undefined;
    const raw = extractRobotMessage(payload);
    if (raw === null) {
      session.log.debug('dingtalk payload ignored: unparseable message body');
      return;
    }
    const inbound = parseInbound(raw, {
      channel: ADAPTER_ID,
      accountId: session.config.accountId,
      config: session.config,
      now: clock(),
      streamMessageId,
    });
    if (inbound === null) {
      session.log.debug('dingtalk payload ignored: not a user message', {
        msgtype: raw.msgtype,
        conversationType: raw.conversationType,
      });
      return;
    }
    if (!dedupe.add(`${inbound.accountId}:${inbound.messageId}`)) {
      session.log.debug('dingtalk duplicate message dropped', {
        messageId: inbound.messageId,
        conversationId: inbound.conversationId,
      });
      return;
    }
    session.log.info('dingtalk inbound message', {
      conversationType: inbound.conversationType,
      conversationId: inbound.conversationId,
      messageId: inbound.messageId,
      senderId: inbound.sender.id,
      mentioned: inbound.mentioned,
      textLength: inbound.text.length,
      attachments: inbound.attachments.length,
    });
    try {
      await emit(inbound);
    } catch (error) {
      session.log.error('dingtalk emit failed', { error });
    }
  }

  /**
   * @param {import('../../core/types.js').AdapterContext} ctx
   * @returns {Promise<void>}
   */
  async function start(ctx) {
    if (runtime !== null) {
      if (state === 'running') return;
      throw new Error('[dingtalk] start() called while the adapter is already starting/stopping');
    }
    const log = resolveLogger(ctx?.log);
    const config = validateConfig(normalizeConfig(ctx?.config ?? {}, { secret: ctx?.secret }));
    const session = {
      config,
      log,
      client: null,
      transport: null,
      startedAt: clock(),
      mode: config.mode,
      /** @type {AbortSignal | undefined} */
      signal: ctx?.signal,
      /** @type {(() => void) | undefined} */
      abortListener: undefined,
    };
    runtime = session;
    state = 'starting';
    dedupe.clear();

    /** @param {unknown} payload */
    const onPayload = async (payload) => {
      await handlePayload(session, payload, async (inbound) => {
        if (typeof ctx?.emit === 'function') await ctx.emit(inbound);
      });
    };

    try {
      if (config.mode === 'stream') {
        const client = await streamClientFactory({
          clientId: config.clientId,
          clientSecret: config.clientSecret,
          robotCode: config.robotCode,
          accountId: config.accountId,
          ua: config.ua,
          keepAlive: config.keepAlive,
          log,
        });
        if (client === null || typeof client !== 'object') {
          throw new Error('[dingtalk] streamClientFactory did not return a client');
        }
        session.client = client;
        session.transport = await startStreamTransport({ client, log, onPayload, topic: TOPIC_ROBOT });
        log.info('dingtalk stream connected', {
          accountId: config.accountId,
          topic: TOPIC_ROBOT,
          keepAlive: config.keepAlive,
        });
      } else {
        if (ctx?.http === undefined || ctx.http === null || typeof ctx.http.route !== 'function') {
          throw new Error(
            '[dingtalk] webhook 模式需要 gateway.http.enabled=true（ctx.http 不可用）；'
              + '或把 channels.dingtalk.mode 改为 "stream"',
          );
        }
        const handler = createWebhookHandler({ config, log, now: clock, onPayload });
        ctx.http.route('POST', config.webhookPath, handler);
        log.info('dingtalk webhook route registered', {
          accountId: config.accountId,
          path: config.webhookPath,
          publicUrl: typeof ctx.http.publicUrl === 'function' ? ctx.http.publicUrl(config.webhookPath) : null,
        });
      }
    } catch (error) {
      runtime = null;
      state = 'stopped';
      try {
        await session.transport?.disconnect?.();
      } catch {
        // Ignore cleanup errors; the original start error is what matters.
      }
      throw error;
    }

    state = 'running';
    log.info('dingtalk channel started', { accountId: config.accountId, mode: config.mode });

    const signal = ctx?.signal;
    if (signal !== undefined && signal !== null) {
      if (signal.aborted) {
        await stop();
      } else if (typeof signal.addEventListener === 'function') {
        const listener = () => {
          void stop();
        };
        signal.addEventListener('abort', listener, { once: true });
        session.abortListener = listener;
      }
    }
  }

  /** @returns {Promise<void>} */
  async function stop() {
    if (stopPromise !== null) return stopPromise;
    if (runtime === null) {
      state = 'stopped';
      return;
    }
    state = 'stopping';
    const session = runtime;
    stopPromise = (async () => {
      try {
        if (session.signal !== undefined && session.abortListener !== undefined) {
          session.signal.removeEventListener?.('abort', session.abortListener);
        }
        await session.transport?.disconnect?.();
        if (session.transport === null && session.client !== null && typeof session.client.disconnect === 'function') {
          session.client.disconnect();
        }
      } catch (error) {
        session.log.warn('dingtalk stop failed', { error });
      } finally {
        dedupe.clear();
        runtime = null;
        state = 'stopped';
        stopPromise = null;
      }
    })();
    return stopPromise;
  }

  /**
   * @param {import('../../core/types.js').ReplyTarget} target
   * @param {import('../../core/types.js').OutboundMessage} message
   * @returns {Promise<import('../../core/types.js').SendResult>}
   */
  async function send(target, message) {
    const config = runtime?.config ?? normalizeConfig({});
    const log = runtime?.log ?? SILENT_LOG;
    const result = await sendViaSessionWebhook({
      target,
      message,
      config,
      fetchImpl,
      now: clock,
    });
    log.debug('dingtalk reply sent', {
      conversationType: target?.conversationType,
      conversationId: target?.conversationId,
      format: message?.format ?? 'plain',
      messageId: result.messageId,
    });
    return result;
  }

  /** @returns {Promise<import('../../core/types.js').ChannelHealth>} */
  async function health() {
    if (runtime === null) return { state: 'disconnected' };
    const since = runtime.startedAt;
    if (runtime.mode === 'webhook') {
      return { state: 'connected', detail: `webhook ${runtime.config.webhookPath}`, since };
    }
    const client = runtime.client;
    if (client !== null && typeof client === 'object' && client.connected === true) {
      return { state: 'connected', detail: 'stream connected', since };
    }
    return {
      state: 'connecting',
      detail: 'stream socket not connected — the SDK reconnects automatically',
      since,
    };
  }

  return {
    id: ADAPTER_ID,
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
    __testing: {
      config: () => runtime?.config ?? null,
      dedupeSize: () => dedupe.size,
    },
  };
}

export {
  ADAPTER_ID,
  TOPIC_ROBOT,
  normalizeConfig,
  validateConfig,
  parseInbound,
  buildOutboundPayload,
  deriveMarkdownTitle,
  resolveSessionWebhook,
  computeWebhookSign,
  verifyWebhookSignature,
  extractWebhookSignature,
  normalizeWebhookPayload,
  createWebhookHandler,
  createDefaultStreamClient,
  startStreamTransport,
};

/** Default export used by `src/adapters/registry.js`. */
const adapter = createAdapter();
export default adapter;
