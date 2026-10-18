/** Test doubles for the gateway core tests (no network, no DSH process). */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig } from '../../src/core/config.js';

/** @returns {string} */
export function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-im-manager-test-'));
}

/** @param {string} dir */
export function removeDir(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
}

/**
 * @param {(overrides: Record<string, any>) => void} [mutate]
 * @param {{ stateDir: string }} input
 */
export function makeConfig(stateDir, mutate) {
  const config = defaultConfig();
  config.gateway.stateDir = stateDir;
  config.gateway.http.enabled = false;
  config.gateway.concurrency = 2;
  config.gateway.log.level = 'silent';
  config.dsh.turnTimeoutMs = 2000;
  config.channels.feishu.enabled = true;
  config.channels.feishu.allowFrom = ['u1'];
  config.channels.feishu.mode = 'ws';
  mutate?.(config);
  return config;
}

/**
 * @param {Partial<import('../../src/core/types.js').InboundMessage>} [overrides]
 * @returns {import('../../src/core/types.js').InboundMessage}
 */
export function inbound(overrides = {}) {
  return {
    channel: 'feishu',
    accountId: 'feishu',
    conversationId: 'chat-1',
    conversationType: 'dm',
    messageId: `msg-${Math.random().toString(36).slice(2)}`,
    sender: { id: 'u1', name: 'User One' },
    text: 'hello',
    mentioned: true,
    attachments: [],
    target: {
      channel: 'feishu',
      accountId: 'feishu',
      conversationId: 'chat-1',
      conversationType: 'dm',
      replyToMessageId: 'msg-1',
    },
    timestamp: Date.now(),
    ...overrides,
  };
}

/**
 * A controllable bridge implementing the DSH bridge contract (docs/contracts.md §4).
 * @param {{
 *   reply?: string,
 *   reason?: { kind: string, error?: unknown },
 *   emitEvents?: boolean,
 *   promptDelayMs?: number,
 * }} [options]
 */
export function createFakeBridge(options = {}) {
  const eventListeners = new Set();
  const statusListeners = new Set();
  const stateListeners = new Set();
  /** @type {Set<string>} */
  const opened = new Set();
  /** @type {Array<{ sessionId: string, blocks: any[] }>} */
  const prompts = [];
  let state = 'idle';
  /** @type {Set<string>} */
  const materialized = new Set();

  function emitState(next, detail) {
    state = next;
    for (const listener of stateListeners) listener({ state: next, detail });
  }

  function emitEvent(sessionId, event) {
    for (const listener of eventListeners) listener({ sessionId, event });
  }

  function emitTurn(sessionId, text = options.reply ?? '你好，我是 Agent。', reason = options.reason ?? { kind: 'completed' }) {
    emitEvent(sessionId, { type: 'turn/start', seq: 1, time: Date.now(), data: { turn: 1 } });
    if (text !== null) {
      emitEvent(sessionId, {
        type: 'assistant/message',
        seq: 2,
        time: Date.now(),
        data: {
          turn: 1,
          step: 1,
          message: { id: 'assistant-1', role: 'assistant', content: [{ type: 'text', text }] },
        },
      });
    }
    emitEvent(sessionId, { type: 'turn/end', seq: 3, time: Date.now(), data: { turn: 1, reason } });
  }

  const bridge = {
    async start() {
      emitState('starting');
      emitState('ready');
    },
    async stop() {
      emitState('stopped');
    },
    async ensureSession(sessionId) {
      opened.add(sessionId);
    },
    async prompt(sessionId, blocks) {
      prompts.push({ sessionId, blocks });
      if (options.emitEvents !== false) {
        const delay = options.promptDelayMs ?? 0;
        setTimeout(() => emitTurn(sessionId), delay).unref?.();
      }
      return { messageId: `prompt-${prompts.length}` };
    },
    async wait() {
      return {};
    },
    async getWorkingDirectory(sessionId) {
      materialized.add(sessionId);
      return { cwd: process.cwd() };
    },
    onEvent(listener) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    onStatus(listener) {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
    onState(listener) {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
    get state() {
      return state;
    },
    get pid() {
      return 4321;
    },
    // test controls
    emitEvent,
    emitTurn,
    setState: emitState,
    emitStatus(sessionId, status) {
      for (const listener of statusListeners) listener({ sessionId, status });
    },
    prompts,
    opened,
    materialized,
  };
  return bridge;
}

/**
 * A fake adapter that records everything the gateway sends.
 * @param {{
 *   id?: string,
 *   capabilities?: Partial<import('../../src/core/types.js').AdapterCapabilities>,
 *   startError?: Error,
 *   failFirstSend?: boolean,
 * }} [options]
 */
export function createFakeAdapter(options = {}) {
  const id = options.id ?? 'feishu';
  const sent = [];
  const typing = [];
  let started = false;
  let failOnce = options.failFirstSend === true;

  const adapter = {
    id,
    capabilities: {
      text: true,
      markdown: true,
      media: false,
      streaming: false,
      typing: true,
      threads: false,
      ...options.capabilities,
    },
    async start(ctx) {
      if (options.startError) throw options.startError;
      adapter.ctx = ctx;
      started = true;
    },
    async stop() {
      started = false;
    },
    async send(target, message) {
      if (failOnce) {
        failOnce = false;
        throw new Error('simulated send failure');
      }
      sent.push({ target, message });
      return { messageId: `sent-${sent.length}` };
    },
    async startTyping(target) {
      typing.push({ type: 'start', conversationId: target.conversationId });
    },
    async stopTyping(target) {
      typing.push({ type: 'stop', conversationId: target.conversationId });
    },
    async health() {
      return { state: started ? 'connected' : 'disconnected' };
    },
    // test controls
    sent,
    typing,
    get started() {
      return started;
    },
  };
  return adapter;
}
