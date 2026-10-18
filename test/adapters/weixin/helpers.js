/**
 * Shared helpers for the personal-WeChat (weixin) adapter tests.
 *
 * Everything is local: fake `fetch`/`transport` responders, a temp state dir,
 * and a capturing logger. No test ever reaches the real WeChat backend.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeCredential } from '../../../src/adapters/weixin/credentials.js';

/** Create an isolated temp directory. */
export function makeTempDir(prefix = 'weixin-test-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Remove a temp directory tree. */
export function cleanupDir(dir) {
  if (typeof dir === 'string' && dir !== '') {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Build a Response-like object for the fetch transport. */
export function jsonResponse(body, status = 200) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
  };
}

/**
 * Fake global `fetch`: records every call and returns the responder's value.
 *
 * @param {(call: { url: string, method: string, headers: Record<string, string>, body?: any, signal?: AbortSignal }, index: number) => any} responder
 */
export function makeFetch(responder) {
  /** @type {{ url: string, method: string, headers: Record<string, string>, body?: any, signal?: AbortSignal }[]} */
  const calls = [];
  /** @type {typeof fetch} */
  const fetchImpl = async (url, init = {}) => {
    const call = {
      url: String(url),
      method: String(init.method ?? 'GET'),
      headers: /** @type {Record<string, string>} */ ({ ...(init.headers ?? {}) }),
      body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body,
      signal: init.signal,
    };
    calls.push(call);
    const result = await responder(call, calls.length);
    if (result instanceof Error) throw result;
    if (result !== null && typeof result === 'object' && typeof result.text === 'function') return result;
    return jsonResponse(result ?? {});
  };
  return { calls, fetchImpl };
}

/**
 * Fake transport (parsed JSON boundary) for `ILinkClient`.
 * @param {(call: { url: string, method: string, headers: Record<string, string>, body?: any, signal?: AbortSignal }, index: number) => any} responder
 */
export function makeTransport(responder) {
  /** @type {{ url: string, method: string, headers: Record<string, string>, body?: any, signal?: AbortSignal }[]} */
  const calls = [];
  const transport = {
    async request(url, init = {}) {
      const call = {
        url: String(url),
        method: String(init.method ?? 'GET'),
        headers: /** @type {Record<string, string>} */ ({ ...(init.headers ?? {}) }),
        body: init.body,
        signal: init.signal,
        timeoutMs: init.timeoutMs,
      };
      calls.push(call);
      const result = await responder(call, calls.length);
      if (result instanceof Error) throw result;
      return result;
    },
  };
  return { calls, transport };
}

/** A transport/promise that only rejects when its abort signal fires. */
export function pendingUntilAborted(call) {
  return new Promise((_resolve, reject) => {
    const fail = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    if (call.signal?.aborted) {
      fail();
      return;
    }
    call.signal?.addEventListener('abort', fail, { once: true });
  });
}

/** Capturing logger compatible with the AdapterContext Logger contract. */
export function makeLogger() {
  const lines = [];
  const log = {
    debug: (...args) => lines.push(['debug', ...args]),
    info: (...args) => lines.push(['info', ...args]),
    warn: (...args) => lines.push(['warn', ...args]),
    error: (...args) => lines.push(['error', ...args]),
    child() {
      return log;
    },
  };
  return {
    log,
    lines,
    dump: () => JSON.stringify(lines),
    has: (level, pattern) =>
      lines.some(([lineLevel, ...rest]) => lineLevel === level && rest.some((item) => pattern.test(String(item)))),
  };
}

/** Minimal AdapterContext for adapter-level tests. */
export function makeAdapterCtx({ config, stateDir, controller = new AbortController(), emit, log } = {}) {
  const captured = [];
  const emitter = typeof emit === 'function' ? emit : async (inbound) => captured.push(inbound);
  const logger = log ?? makeLogger().log;
  return {
    ctx: {
      config: config ?? {},
      emit: emitter,
      log: logger,
      signal: controller.signal,
      http: {
        route() {
          throw new Error('weixin adapter must not register HTTP routes');
        },
        publicUrl: () => null,
        publicBaseUrl: () => null,
      },
      stateDir,
      secret: () => undefined,
    },
    controller,
    emitted: captured,
  };
}

/** Write a valid credential file for a temp state dir. */
export function seedCredential(stateDir, config, overrides = {}) {
  return writeCredential(stateDir, config, {
    version: 1,
    token: 'test-bot-token-0123456789',
    ilinkBotId: 'bot-abc@im.bot',
    userId: 'wxid-user@im.wechat',
    baseUrl: 'https://ilinkai.weixin.qq.com',
    savedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  });
}

/**
 * Poll until `predicate()` is truthy; throws with a helpful message on timeout.
 * @template T
 * @param {() => T | Promise<T>} predicate
 * @param {{ timeoutMs?: number, intervalMs?: number, label?: string }} [options]
 * @returns {Promise<T>}
 */
export async function waitFor(predicate, options = {}) {
  const timeoutMs = options.timeoutMs ?? 2_000;
  const intervalMs = options.intervalMs ?? 5;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms${options.label ? ` (${options.label})` : ''}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** Let pending microtasks/timers run for a moment. */
export function tick(ms = 10) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A minimal iLink user text message payload. */
export function textMessage(overrides = {}) {
  return {
    seq: 1,
    message_id: 1_000_001,
    from_user_id: 'wxid-alice@im.wechat',
    to_user_id: 'bot-abc@im.bot',
    create_time_ms: 1_700_000_000_000,
    message_type: 1,
    message_state: 2,
    context_token: 'ctx-token-secret',
    item_list: [{ type: 1, text_item: { text: '你好，帮我看看这个报错' } }],
    ...overrides,
  };
}
