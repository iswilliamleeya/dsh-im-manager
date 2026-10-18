/**
 * `getupdates` long-poll receive loop for the personal WeChat channel.
 *
 * One round:
 *   1. load the persisted cursor (`<stateDir>/cursor.json`, bot-id scoped)
 *   2. `POST ilink/bot/getupdates` with the cursor (server long-polls)
 *   3. for each message: capture `context_token` (persisted per peer), map to
 *      the contract `InboundMessage`, `await emit()`
 *   4. only then commit the returned `get_updates_buf` cursor
 *
 * Reconnect policy: any non-`-14` failure is retried with exponential backoff
 * (`reconnect.baseDelayMs` → `maxDelayMs`), staying inside the gateway process.
 * A client-side long-poll timeout is normal (empty round, retry immediately).
 *
 * `-14` (stale bot token) is terminal for the loop: it stops, health becomes
 * `disconnected` with a re-login hint, and the gateway process keeps running.
 *
 * @see docs/channels/weixin.md §6
 */
import { join } from 'node:path';

import { StaleTokenError } from './client.js';
import { mapInbound } from './inbound.js';
import { createCursorStore } from './storage.js';
import { describeError } from './protocol.js';

const NOOP_LOG = Object.freeze({
  debug() {},
  info() {},
  warn() {},
  error() {},
});

/**
 * Sleep that resolves early when the signal aborts.
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
export function sleepAbortable(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(onDone, Math.max(0, ms));
    timer.unref?.();
    function onDone() {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    function onAbort() {
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isStaleToken(error) {
  if (error instanceof StaleTokenError) return true;
  const code = /** @type {{ ret?: unknown, errcode?: unknown, code?: unknown }} */ (error)?.code;
  const ret = /** @type {{ ret?: unknown }} */ (error)?.ret;
  const errcode = /** @type {{ errcode?: unknown }} */ (error)?.errcode;
  return code === 'WEIXIN_STALE_TOKEN' || ret === -14 || errcode === -14;
}

/**
 * @param {{
 *   client: import('./client.js').ILinkClient,
 *   stateDir: string,
 *   config: import('./config.js').WeixinConfig | Record<string, any>,
 *   emit: (inbound: import('../../core/types.js').InboundMessage) => Promise<void>,
 *   contextTokens?: { set: (peerId: string, token: string) => void, get?: (peerId: string) => string | undefined },
 *   ilinkBotId?: string,
 *   log?: import('../../core/types.js').Logger,
 *   signal?: AbortSignal,
 *   now?: () => number,
 *   sleep?: (ms: number, signal?: AbortSignal) => Promise<void>,
 *   onConnectionChange?: (change: { state: string, detail?: string }) => void,
 *   onStaleToken?: (error: unknown) => void | Promise<void>,
 *   hydrateInbound?: (inbound: import('../../core/types.js').InboundMessage) => Promise<import('../../core/types.js').InboundMessage>,
 * }} options
 */
export function createWeixinMonitor(options) {
  const client = options.client;
  const stateDir = String(options.stateDir ?? '.');
  const config = options.config ?? {};
  const emit = options.emit;
  if (typeof emit !== 'function') throw new Error('weixin monitor: emit must be a function');
  const contextTokens = options.contextTokens;
  const ilinkBotId = typeof options.ilinkBotId === 'string' ? options.ilinkBotId : '';
  const log = options.log ?? NOOP_LOG;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const sleep = typeof options.sleep === 'function' ? options.sleep : sleepAbortable;
  const onConnectionChange = typeof options.onConnectionChange === 'function' ? options.onConnectionChange : undefined;
  const onStaleToken = typeof options.onStaleToken === 'function' ? options.onStaleToken : undefined;
  const hydrateInbound = typeof options.hydrateInbound === 'function' ? options.hydrateInbound : null;

  const reconnect = {
    enabled: config.reconnect?.enabled !== false,
    baseDelayMs: Number.isFinite(config.reconnect?.baseDelayMs) && config.reconnect.baseDelayMs > 0
      ? Math.floor(config.reconnect.baseDelayMs)
      : 2_000,
    maxDelayMs: Number.isFinite(config.reconnect?.maxDelayMs) && config.reconnect.maxDelayMs > 0
      ? Math.floor(config.reconnect.maxDelayMs)
      : 30_000,
  };
  const initialLongPollTimeoutMs =
    Number.isFinite(config.longPollTimeoutMs) && config.longPollTimeoutMs > 0
      ? Math.floor(config.longPollTimeoutMs)
      : 35_000;

  const cursor = createCursorStore({ file: join(stateDir, 'cursor.json'), ilinkBotId, now });

  let running = false;
  let loopPromise = null;
  let controller = new AbortController();
  let connectionState = 'disconnected';
  let connectionDetail = '尚未启动';
  let startedAt = 0;
  let lastInboundAt = 0;
  let staleToken = false;
  let attempt = 0;
  let nextLongPollTimeoutMs = initialLongPollTimeoutMs;
  let externalSignal = options.signal;
  let onExternalAbort = null;

  /**
   * @param {string} state
   * @param {string} [detail]
   */
  function setConnection(state, detail) {
    connectionState = state;
    connectionDetail = detail ?? '';
    try {
      onConnectionChange?.({ state: connectionState, ...(connectionDetail !== '' ? { detail: connectionDetail } : {}) });
    } catch {
      // health observers must never break the loop
    }
  }

  /**
   * @param {number} currentAttempt
   * @returns {number}
   */
  function backoffDelay(currentAttempt) {
    const exponent = Math.min(Math.max(currentAttempt - 1, 0), 8);
    return Math.min(reconnect.baseDelayMs * 2 ** exponent, reconnect.maxDelayMs);
  }

  /**
   * Handle one raw message: context token first (so a reply can correlate even
   * if the mapper rejects the message), then map + emit.
   * @param {unknown} raw
   */
  async function handleMessage(raw) {
    const message = raw !== null && typeof raw === 'object' ? /** @type {Record<string, any>} */ (raw) : {};
    const fromUserId = typeof message.from_user_id === 'string' ? message.from_user_id : '';
    if (fromUserId !== '' && typeof message.context_token === 'string' && message.context_token !== '') {
      try {
        contextTokens?.set(fromUserId, message.context_token);
      } catch (error) {
        log.warn?.('weixin context token persist failed', { error: describeError(error) });
      }
    }
    let inbound = mapInbound(message, {
      accountId: config.accountId,
      cdnBaseUrl: config.cdnBaseUrl,
      now: now(),
    });
    if (inbound === null) {
      log.debug?.('weixin inbound ignored (bot echo / unsupported / empty)', {
        messageId: message.message_id,
        messageType: message.message_type,
      });
      return;
    }
    // Download + decrypt inbound media before handing the message to core.
    // Hydration never throws (per-item failures fall back to URL-only).
    if (hydrateInbound !== null) {
      try {
        const hydrated = await hydrateInbound(inbound);
        if (hydrated !== null && hydrated !== undefined) inbound = hydrated;
      } catch (error) {
        log.warn?.('weixin inbound media hydration failed (ignored)', { error: describeError(error) });
      }
    }
    lastInboundAt = now();
    log.info?.('weixin inbound message', {
      messageId: inbound.messageId,
      from: inbound.sender.id,
      chars: inbound.text.length,
      attachments: inbound.attachments.length,
    });
    await emit(inbound);
  }

  async function runLoop() {
    let getUpdatesBuf = '';
    try {
      getUpdatesBuf = await cursor.load();
    } catch (error) {
      log.warn?.('weixin cursor load failed; starting from empty cursor', { error: describeError(error) });
      getUpdatesBuf = '';
    }
    setConnection('connected', '长轮询已连接');

    while (running && !controller.signal.aborted) {
      let result;
      try {
        result = await client.getUpdates({
          getUpdatesBuf,
          longPollTimeoutMs: nextLongPollTimeoutMs,
          signal: controller.signal,
        });
      } catch (error) {
        if (controller.signal.aborted || !running) break;
        if (isStaleToken(error)) {
          staleToken = true;
          running = false;
          setConnection('disconnected', '微信登录已失效（-14），运行 dsh-im-manager weixin login 重新扫码');
          log.warn?.('weixin bot token is stale (-14); long-poll stopped, re-login required');
          try {
            await onStaleToken?.(error);
          } catch (hookError) {
            log.debug?.('weixin stale-token hook failed (ignored)', { error: describeError(hookError) });
          }
          break;
        }
        attempt += 1;
        const delay = backoffDelay(attempt);
        if (!reconnect.enabled) {
          running = false;
          setConnection('disconnected', `getupdates 失败且未启用重连：${describeError(error)}`);
          log.error?.('weixin getupdates failed and reconnect is disabled', { error: describeError(error) });
          break;
        }
        setConnection('reconnecting', `${describeError(error)}；${delay}ms 后重试（第 ${attempt} 次）`);
        log.warn?.('weixin getupdates failed; retrying with backoff', {
          attempt,
          delay,
          error: describeError(error),
        });
        await sleep(delay, controller.signal);
        continue;
      }

      if (!running || controller.signal.aborted) break;

      if (result !== null && typeof result === 'object' && result.timedOut === true) {
        // Normal long-poll client timeout: no messages, just poll again.
        attempt = 0;
        continue;
      }

      attempt = 0;
      setConnection('connected', '长轮询已连接');
      const serverTimeout = Number(result?.longpolling_timeout_ms);
      if (Number.isFinite(serverTimeout) && serverTimeout > 0) {
        nextLongPollTimeoutMs = Math.min(Math.max(Math.floor(serverTimeout), 1_000), 120_000);
      }

      const messages = Array.isArray(result?.msgs) ? result.msgs : [];
      /** @type {unknown} */
      let processingError = null;
      try {
        for (const message of messages) {
          if (!running || controller.signal.aborted) break;
          await handleMessage(message);
        }
      } catch (error) {
        processingError = error;
      }
      if (processingError !== null) {
        if (controller.signal.aborted || !running) break;
        // Do NOT commit the cursor: replay this round so a failed emit does not
        // silently drop a message (core dedupe absorbs the duplicates).
        attempt += 1;
        const delay = backoffDelay(attempt);
        if (!reconnect.enabled) {
          running = false;
          setConnection('disconnected', `入站消息处理失败且未启用重连：${describeError(processingError)}`);
          log.error?.('weixin inbound processing failed and reconnect is disabled', {
            error: describeError(processingError),
          });
          break;
        }
        setConnection('reconnecting', `处理入站消息失败：${describeError(processingError)}；${delay}ms 后重试`);
        log.warn?.('weixin inbound processing failed; replaying round after backoff', {
          attempt,
          delay,
          error: describeError(processingError),
        });
        await sleep(delay, controller.signal);
        continue;
      }

      const nextCursor = result?.get_updates_buf;
      if (typeof nextCursor === 'string' && nextCursor !== '' && nextCursor !== getUpdatesBuf) {
        getUpdatesBuf = nextCursor;
        try {
          await cursor.save(nextCursor);
        } catch (error) {
          // Retry the round with the previous cursor: duplicates are expected
          // and absorbed by core dedupe, losing messages is not acceptable.
          log.warn?.('weixin cursor persist failed; will replay the round', { error: describeError(error) });
          getUpdatesBuf = '';
          try {
            getUpdatesBuf = await cursor.load();
          } catch {
            getUpdatesBuf = '';
          }
        }
      }
    }

    if (!staleToken && connectionState !== 'disconnected') {
      setConnection('disconnected', '长轮询已停止');
    }
  }

  return {
    /** Start the long-poll loop (does not block). */
    async start() {
      if (running) return;
      running = true;
      staleToken = false;
      attempt = 0;
      startedAt = now();
      controller = new AbortController();
      externalSignal = options.signal;
      if (externalSignal) {
        onExternalAbort = () => {
          running = false;
          controller.abort();
        };
        if (externalSignal.aborted) {
          onExternalAbort();
        } else {
          externalSignal.addEventListener('abort', onExternalAbort, { once: true });
        }
      }
      setConnection('connecting', '正在连接微信长轮询…');
      if (!running || controller.signal.aborted) return;
      // Best effort, mirrors the upstream lifecycle notify.
      try {
        await client.notifyStart({ timeoutMs: Math.min(config.requestTimeoutMs ?? 5_000, 5_000) });
      } catch (error) {
        if (isStaleToken(error)) {
          log.debug?.('weixin notifystart reported a stale token; the loop will confirm it');
        } else {
          log.debug?.('weixin notifystart failed (ignored)', { error: describeError(error) });
        }
      }
      loopPromise = runLoop().catch((error) => {
        log.error?.('weixin monitor loop crashed', { error: describeError(error) });
        setConnection('disconnected', describeError(error));
        running = false;
      });
    },

    /** Stop the loop, send notifystop (best effort), wait for the loop to exit. */
    async stop() {
      if (!running && loopPromise === null) return;
      running = false;
      try {
        controller.abort();
      } catch {
        // ignore
      }
      if (externalSignal && onExternalAbort) {
        try {
          externalSignal.removeEventListener('abort', onExternalAbort);
        } catch {
          // ignore
        }
      }
      onExternalAbort = null;
      try {
        await Promise.race([
          client.notifyStop({ timeoutMs: 3_000 }),
          sleep(3_000),
        ]);
      } catch (error) {
        log.debug?.('weixin notifystop failed (ignored)', { error: describeError(error) });
      }
      if (loopPromise !== null) {
        try {
          await loopPromise;
        } catch {
          // runLoop never rejects; defensive
        }
        loopPromise = null;
      }
      if (!staleToken) setConnection('disconnected', '已停止');
    },

    /** Wait for the loop to finish (tests / teardown). */
    async join() {
      if (loopPromise !== null) {
        try {
          await loopPromise;
        } catch {
          // ignore
        }
      }
    },

    /** @returns {{ state: string, detail: string, since: number, lastInboundAt?: number }} */
    get health() {
      return {
        state: connectionState,
        detail: connectionDetail,
        since: startedAt,
        ...(lastInboundAt > 0 ? { lastInboundAt } : {}),
      };
    },

    get running() {
      return running;
    },
    get staleToken() {
      return staleToken;
    },
    get lastInboundAt() {
      return lastInboundAt || undefined;
    },
    get longPollTimeout() {
      return nextLongPollTimeoutMs;
    },
    get cursorStore() {
      return cursor;
    },
  };
}

/** @typedef {ReturnType<typeof createWeixinMonitor>} WeixinMonitor */
