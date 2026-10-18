/**
 * WeCom 智能机器人 long-connection client.
 *
 * Implements the transport only: connect, `aibot_subscribe` handshake,
 * heartbeat (`ping` + ack), exponential-backoff reconnect, server-push frame
 * dispatch, and ack-tracked replies. Inbound normalization lives in
 * `inbound.js`; the adapter uses this class in `mode: "ws"`.
 *
 * Dependency-free: uses Node's global `WebSocket` (Node >= 22) by default, or
 * an injected `webSocketFactory` for tests.
 */
import { randomBytes } from 'node:crypto';

import {
  buildPingFrame,
  buildSendMarkdownFrame,
  buildStreamReplyFrame,
  buildSubscribeFrame,
  isDisconnectedEvent,
  normalizeWsCallback,
  parseWsFrame,
  WsCmd,
} from './ws-protocol.js';

/** @typedef {{ state: 'connected'|'connecting'|'degraded'|'disconnected', detail?: string, since?: number }} ChannelHealth */

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
 * @param {unknown} error
 * @returns {string}
 */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error ?? 'unknown error');
}

export class WecomWsConnection {
  /**
   * @param {{
   *   url: string,
   *   botId: string,
   *   secret: string,
   *   heartbeatIntervalMs?: number,
   *   reconnectInitialDelayMs?: number,
   *   reconnectMaxDelayMs?: number,
   *   maxReconnectAttempts?: number,
   *   authTimeoutMs?: number,
   *   connectTimeoutMs?: number,
   *   replyAckTimeoutMs?: number,
   *   maxMissedPong?: number,
   *   reconnectOnKicked?: boolean,
   *   webSocketFactory?: (options: { url: string }) => any,
   *   log?: { debug?: Function, info?: Function, warn?: Function, error?: Function },
   *   onMessage?: (callback: { kind: 'message'|'event', reqId: string, msg: Record<string, any>, msgId?: string, eventType?: string }) => void,
   *   onStateChange?: (health: ChannelHealth) => void,
   *   onKicked?: (reason: string) => void,
   * }} options
   */
  constructor(options) {
    this.url = options.url;
    this.botId = options.botId;
    this.secret = options.secret;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 30_000;
    this.reconnectInitialDelayMs = options.reconnectInitialDelayMs ?? 1_000;
    this.reconnectMaxDelayMs = options.reconnectMaxDelayMs ?? 30_000;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? Number.POSITIVE_INFINITY;
    this.authTimeoutMs = options.authTimeoutMs ?? 15_000;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 15_000;
    this.replyAckTimeoutMs = options.replyAckTimeoutMs ?? 10_000;
    this.maxMissedPong = options.maxMissedPong ?? 2;
    this.reconnectOnKicked = options.reconnectOnKicked === true;
    this.webSocketFactory = options.webSocketFactory ?? ((factoryOptions) => new globalThis.WebSocket(factoryOptions.url));
    this.log = options.log ?? NOOP_LOG;
    this.onMessage = options.onMessage;
    this.onStateChange = options.onStateChange;
    this.onKicked = options.onKicked;

    /** @type {'idle'|'connecting'|'connected'|'reconnecting'|'disconnected'|'kicked'} */
    this.state = 'idle';
    this.detail = 'not connected';
    this.since = Date.now();
    this.connectionAttempts = 0;
    this.manualStop = false;
    this.authenticated = false;
    this.missedPong = 0;

    /** @type {any} */
    this.socket = null;
    /** @type {ReturnType<typeof setTimeout> | null} */
    this.reconnectTimer = null;
    /** @type {ReturnType<typeof setInterval> | null} */
    this.heartbeatTimer = null;
    /** @type {ReturnType<typeof setTimeout> | null} */
    this.authTimer = null;
    /** @type {ReturnType<typeof setTimeout> | null} */
    this.connectTimer = null;
    /** @type {Map<string, { resolve: (frame: any) => void, reject: (error: Error) => void, timer: ReturnType<typeof setTimeout> }>} */
    this.pendingAcks = new Map();
    /** @type {Map<string, Promise<void>>} */
    this.replyQueues = new Map();
  }

  /** @returns {boolean} */
  get isConnected() {
    return this.state === 'connected';
  }

  /** @returns {ChannelHealth} */
  health() {
    const map = {
      idle: 'disconnected',
      connecting: 'connecting',
      connected: 'connected',
      reconnecting: 'connecting',
      disconnected: 'disconnected',
      kicked: 'disconnected',
    };
    return { state: map[this.state] ?? 'disconnected', detail: this.detail, since: this.since };
  }

  /** Open the connection (idempotent). Resolves immediately; state is async. */
  start() {
    if (this.state === 'connected' || this.state === 'connecting' || this.state === 'reconnecting') return;
    this.manualStop = false;
    this.setState('connecting', 'connecting');
    this.connect();
  }

  /** Close the connection and stop timers. Idempotent. */
  stop() {
    this.manualStop = true;
    this.clearTimers();
    this.rejectPending(new Error('wecom ws connection closed'));
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      try {
        socket.close();
      } catch {
        // ignore
      }
    }
    this.setState('disconnected', 'stopped');
  }

  /**
   * Send a final stream reply for an inbound `req_id`.
   * @param {{ reqId: string, content: string, streamId?: string }} params
   */
  async replyStream(params) {
    const frame = buildStreamReplyFrame({
      reqId: params.reqId,
      streamId: params.streamId ?? randomBytes(16).toString('hex'),
      content: params.content,
      finish: true,
    });
    await this.enqueue(params.reqId, () => this.sendAndWaitAck(frame));
  }

  /**
   * Proactive markdown message to a conversation that is already activated
   * (the user/group must have messaged the bot at least once).
   * @param {{ chatId: string, content: string }} params
   */
  async sendMarkdown(params) {
    const frame = buildSendMarkdownFrame({ chatId: params.chatId, content: params.content });
    await this.sendAndWaitAck(frame);
  }

  /**
   * @param {string} key
   * @param {() => Promise<void>} task
   * @returns {Promise<void>}
   */
  enqueue(key, task) {
    const previous = this.replyQueues.get(key) ?? Promise.resolve();
    const run = previous.then(task, task);
    const tail = run.catch(() => {});
    this.replyQueues.set(key, tail);
    void tail.finally(() => {
      if (this.replyQueues.get(key) === tail) this.replyQueues.delete(key);
    });
    return run;
  }

  /**
   * @param {Record<string, any>} frame
   * @returns {Promise<void>}
   */
  sendAndWaitAck(frame) {
    if (this.state !== 'connected' || this.socket === null) {
      return Promise.reject(new Error('wecom ws is not connected'));
    }
    const reqId = String(frame?.headers?.req_id ?? '');
    if (!reqId) return Promise.reject(new Error('wecom ws frame is missing req_id'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingAcks.delete(reqId);
        reject(new Error(`wecom ws ${frame.cmd} was not acked within ${this.replyAckTimeoutMs}ms`));
      }, this.replyAckTimeoutMs);
      timer.unref?.();
      this.pendingAcks.set(reqId, { resolve, reject, timer });
      try {
        this.sendFrame(frame);
      } catch (error) {
        clearTimeout(timer);
        this.pendingAcks.delete(reqId);
        reject(new Error(`wecom ws send failed: ${errorMessage(error)}`));
      }
    });
  }

  /**
   * @param {Record<string, any>} frame
   */
  sendFrame(frame) {
    if (this.socket === null) throw new Error('socket is not open');
    this.log.debug?.('ws send', { cmd: frame.cmd, reqId: frame?.headers?.req_id });
    this.socket.send(JSON.stringify(frame));
  }

  /** @param {'connecting'|'connected'|'reconnecting'|'disconnected'|'kicked'|'idle'} state @param {string} detail */
  setState(state, detail) {
    if (this.state === state && this.detail === detail) return;
    this.state = state;
    this.detail = detail;
    this.since = Date.now();
    this.onStateChange?.(this.health());
  }

  connect() {
    if (this.manualStop) return;
    this.clearConnectTimers();
    this.authenticated = false;
    this.missedPong = 0;
    this.setState('connecting', this.connectionAttempts > 0 ? `reconnecting (attempt ${this.connectionAttempts})` : 'connecting');
    /** @type {any} */
    let socket;
    try {
      socket = this.webSocketFactory({ url: this.url });
    } catch (error) {
      this.log.warn?.(`ws connect failed: ${errorMessage(error)}`);
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    this.attachHandlers(socket);
    if (this.connectTimeoutMs > 0) {
      this.connectTimer = setTimeout(() => {
        if (this.authenticated || this.socket !== socket) return;
        this.log.warn?.('ws connect timed out');
        this.discardSocket();
      }, this.connectTimeoutMs);
      this.connectTimer.unref?.();
    }
  }

  /** @param {any} socket */
  attachHandlers(socket) {
    const on = (event, handler) => {
      if (typeof socket.addEventListener === 'function') socket.addEventListener(event, handler);
      else if (typeof socket.on === 'function') socket.on(event, handler);
    };
    on('open', () => this.handleOpen(socket));
    on('message', (event) => {
      void this.handleMessage(event).catch((error) => {
        this.log.warn?.(`ws message handling failed: ${errorMessage(error)}`);
      });
    });
    on('close', (event) => this.handleClose(socket, event));
    on('error', (event) => {
      this.log.warn?.(`ws error: ${errorMessage(event?.error ?? event)}`);
    });
  }

  /** @param {any} socket */
  handleOpen(socket) {
    if (this.socket !== socket || this.manualStop) return;
    this.kicked = false;
    this.log.info?.('ws connected, sending subscribe');
    this.clearConnectTimers();
    this.setState('connecting', 'authenticating');
    try {
      this.sendFrame(buildSubscribeFrame({ botId: this.botId, secret: this.secret }));
    } catch (error) {
      this.log.warn?.(`ws subscribe send failed: ${errorMessage(error)}`);
      this.discardSocket();
      return;
    }
    if (this.authTimeoutMs > 0) {
      this.authTimer = setTimeout(() => {
        if (this.authenticated) return;
        this.log.warn?.('ws authentication timed out');
        this.discardSocket();
      }, this.authTimeoutMs);
      this.authTimer.unref?.();
    }
  }

  /** @param {MessageEvent | { data?: unknown } | unknown} event */
  async handleMessage(event) {
    const data = event && typeof event === 'object' && 'data' in event ? event.data : event;
    const text = await readFrameText(data);
    const frame = parseWsFrame(text);
    if (frame === null) return;
    this.handleFrame(frame);
  }

  /** @param {Record<string, any>} frame */
  handleFrame(frame) {
    if (isDisconnectedEvent(frame)) {
      this.log.warn?.('ws disconnected_event: a new connection replaced this one; not reconnecting');
      this.kicked = true;
      this.clearTimers();
      this.rejectPending(new Error('wecom ws was disconnected by the server (new connection)'));
      this.setState('kicked', 'kicked by a new connection (only one long connection per bot)');
      this.onKicked?.('new connection established');
      this.discardSocket();
      if (this.reconnectOnKicked) this.scheduleReconnect();
      return;
    }

    const callback = normalizeWsCallback(frame);
    if (callback !== null) {
      try {
        this.onMessage?.(callback);
      } catch (error) {
        this.log.warn?.(`ws inbound dispatch failed: ${errorMessage(error)}`);
      }
      return;
    }

    const reqId = String(frame?.headers?.req_id ?? '');
    if (!reqId) {
      this.log.debug?.('ws frame without req_id ignored');
      return;
    }
    // Command names contain underscores (`aibot_subscribe`), so match by prefix
    // instead of splitting on "_".
    if (reqId.startsWith(WsCmd.SUBSCRIBE)) {
      if (frame.errcode !== 0) {
        this.log.error?.(`ws authentication failed: errcode=${frame.errcode} errmsg=${String(frame.errmsg ?? '')}`);
        this.clearTimers();
        this.authenticated = false;
        this.discardSocket();
        return;
      }
      this.authenticated = true;
      this.connectionAttempts = 0;
      this.missedPong = 0;
      this.clearTimers();
      this.startHeartbeat();
      this.setState('connected', 'authenticated');
      this.log.info?.('ws authenticated');
      return;
    }
    if (reqId.startsWith(WsCmd.HEARTBEAT)) {
      if (frame.errcode === 0) this.missedPong = 0;
      else this.log.warn?.(`ws heartbeat ack error: errcode=${frame.errcode} errmsg=${String(frame.errmsg ?? '')}`);
      return;
    }
    this.settleAck(reqId, frame);
  }

  /** @param {string} reqId @param {Record<string, any>} frame */
  settleAck(reqId, frame) {
    const pending = this.pendingAcks.get(reqId);
    if (pending === undefined) {
      this.log.debug?.('ws ack for unknown req_id ignored', { reqId });
      return;
    }
    this.pendingAcks.delete(reqId);
    clearTimeout(pending.timer);
    if (typeof frame.errcode === 'number' && frame.errcode !== 0) {
      pending.reject(new Error(`wecom ws ${frame.cmd || 'reply'} failed: errcode=${frame.errcode} errmsg=${String(frame.errmsg ?? '')}`));
      return;
    }
    pending.resolve(frame);
  }

  startHeartbeat() {
    this.stopHeartbeat();
    if (this.heartbeatIntervalMs <= 0) return;
    this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), this.heartbeatIntervalMs);
    this.heartbeatTimer.unref?.();
  }

  stopHeartbeat() {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  sendHeartbeat() {
    if (this.state !== 'connected') return;
    if (this.missedPong >= this.maxMissedPong) {
      this.log.warn?.(`ws heartbeat lost ${this.missedPong} consecutive pings, reconnecting`);
      this.discardSocket();
      return;
    }
    this.missedPong += 1;
    try {
      this.sendFrame(buildPingFrame());
    } catch (error) {
      this.log.warn?.(`ws heartbeat send failed: ${errorMessage(error)}`);
      this.discardSocket();
    }
  }

  /** @param {any} socket @param {any} event */
  handleClose(socket, event) {
    if (this.socket !== socket) return;
    const reason = String(event?.reason ?? event?.message ?? '') || `code: ${event?.code ?? 'unknown'}`;
    this.socket = null;
    this.authenticated = false;
    this.clearTimers();
    this.rejectPending(new Error(`wecom ws connection closed (${reason})`));
    this.log.warn?.(`ws closed: ${reason}`);
    if (this.manualStop) {
      this.setState('disconnected', 'stopped');
      return;
    }
    if (this.kicked && !this.reconnectOnKicked) {
      this.setState('disconnected', 'kicked by a new connection');
      return;
    }
    this.scheduleReconnect();
  }

  scheduleReconnect() {
    if (this.manualStop) return;
    if (this.reconnectTimer !== null) return;
    this.connectionAttempts += 1;
    if (this.connectionAttempts > this.maxReconnectAttempts) {
      this.setState('disconnected', 'reconnect attempts exhausted');
      this.log.error?.('ws reconnect attempts exhausted');
      return;
    }
    const exponential = Math.min(
      this.reconnectInitialDelayMs * 2 ** (this.connectionAttempts - 1),
      this.reconnectMaxDelayMs,
    );
    const jittered = Math.max(1, Math.round(exponential * (0.5 + Math.random() * 0.5)));
    this.setState('reconnecting', `reconnecting in ${jittered}ms (attempt ${this.connectionAttempts})`);
    this.log.info?.(`ws reconnecting in ${jittered}ms (attempt ${this.connectionAttempts})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, jittered);
    this.reconnectTimer.unref?.();
  }

  /** Silently close the current socket; the close handler decides on reconnect. */
  discardSocket() {
    const socket = this.socket;
    if (socket === null || socket === undefined) return;
    // Keep `this.socket` until the close event arrives so `handleClose` can
    // tell that this is the current connection and schedule a reconnect.
    try {
      socket.close();
    } catch {
      // ignore
    }
  }

  clearConnectTimers() {
    if (this.connectTimer !== null) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
    if (this.authTimer !== null) {
      clearTimeout(this.authTimer);
      this.authTimer = null;
    }
  }

  clearTimers() {
    this.clearConnectTimers();
    this.stopHeartbeat();
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /** @param {Error} error */
  rejectPending(error) {
    for (const [reqId, pending] of this.pendingAcks) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pendingAcks.delete(reqId);
    }
  }
}

/**
 * Read a WebSocket message payload as UTF-8 text (string / Buffer / ArrayBuffer /
 * Blob-like).
 * @param {unknown} data
 * @returns {Promise<string>}
 */
export async function readFrameText(data) {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
  if (data && typeof (/** @type {any} */ (data).text) === 'function') return await /** @type {any} */ (data).text();
  return '';
}

/**
 * @param {{
 *   url: string, botId: string, secret: string,
 *   webSocketFactory: (options: { url: string }) => any,
 *   log?: any,
 * }} options
 * @returns {WecomWsConnection}
 */
export function createWecomWsConnection(options) {
  return new WecomWsConnection(options);
}

export { WsCmd };
