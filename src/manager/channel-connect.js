/**
 * Channel QR connect flows (contract §10, v1.1).
 *
 * Two layers live here:
 *
 * 1. **Providers** (`createChannelConnectProviders`) — protocol adapters for
 *    `weixin` (reuses `runWeixinLogin`) and `feishu` (device-code app
 *    registration via `@larksuiteoapi/node-sdk`'s `registerApp`). Both accept a
 *    raw QR payload through `onQr({ content, expiresAt })` and report progress
 *    through `onStatus({ state: 'pending'|'scanned' })`. They own credential
 *    persistence (weixin writes `<stateDir>/credentials.json`; feishu returns
 *    app credentials to the manager for the config file).
 *
 * 2. **Flow state machine** (`createChannelConnectService`) — one flow per
 *    workspace+channel, with `pending → scanned → confirmed` and the terminal
 *    `expired / failed / cancelled` states. QR payloads are turned into 640×640
 *    PNG data URLs with the `qrcode` package. Terminal flows are retained for
 *    10 minutes so the UI can poll the final state.
 *
 * No credential is ever exposed through a flow snapshot: `result` only carries
 * {@link sanitizeConnectResult}'s whitelist (weixin `ilinkBotId`/`userId`,
 * feishu `appId`/`domain`). The feishu app secret is handed to the manager's
 * success handler and written to the 0600 config file, never returned.
 */
import { randomUUID } from 'node:crypto';

import QRCode from 'qrcode';

import { sanitizeErrorMessage } from './sanitize.js';

const CONNECT_CHANNELS = Object.freeze(['weixin', 'feishu']);
const DEFAULT_INTERVAL_MS = 1500;
const DEFAULT_TERMINAL_TTL_MS = 10 * 60 * 1000;
const QR_WIDTH = 640;

const FEISHU_ACCOUNTS_DOMAIN = 'accounts.feishu.cn';
const LARK_ACCOUNTS_DOMAIN = 'accounts.larksuite.com';

/** @param {unknown} channel */
export function isConnectSupportedChannel(channel) {
  return typeof channel === 'string' && CONNECT_CHANNELS.includes(channel);
}

export { CONNECT_CHANNELS };

/** @param {string} message @param {string} code */
function codedError(message, code) {
  const error = new Error(message);
  /** @type {any} */ (error).code = code;
  return error;
}

/** @param {unknown} error */
function errorText(error) {
  if (error instanceof Error) return error.message;
  if (error !== null && typeof error === 'object' && typeof /** @type {any} */ (error).message === 'string') {
    return /** @type {any} */ (error).message;
  }
  return String(error);
}

/**
 * Render a QR payload as a PNG data URL (640×640) with the `qrcode` package.
 * @param {unknown} content
 * @param {any} [qrcodeModule]
 * @returns {Promise<string>}
 */
export async function toQrDataUrl(content, qrcodeModule = QRCode) {
  const encoder = qrcodeModule?.toDataURL ?? qrcodeModule?.default?.toDataURL;
  if (typeof encoder !== 'function') throw new Error('qrcode encoder is unavailable');
  const dataUrl = await encoder(String(content), { width: QR_WIDTH, margin: 2, errorCorrectionLevel: 'M' });
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
    throw new Error('qrcode encoder did not return a data URL');
  }
  return dataUrl;
}

/**
 * Convert a raw provider result into the public (secret-free) flow result.
 * @param {string} channel
 * @param {unknown} result
 * @returns {Record<string, string> | null}
 */
export function sanitizeConnectResult(channel, result) {
  if (result === null || typeof result !== 'object') return null;
  if (channel === 'weixin') {
    const ilinkBotId = typeof /** @type {any} */ (result).ilinkBotId === 'string'
      ? /** @type {any} */ (result).ilinkBotId
      : '';
    if (ilinkBotId === '') return null;
    const userId = typeof /** @type {any} */ (result).userId === 'string'
      ? /** @type {any} */ (result).userId
      : '';
    return { ilinkBotId, ...(userId !== '' ? { userId } : {}) };
  }
  if (channel === 'feishu') {
    const appId = typeof /** @type {any} */ (result).appId === 'string'
      ? /** @type {any} */ (result).appId
      : '';
    if (appId === '') return null;
    return { appId, domain: /** @type {any} */ (result).domain === 'lark' ? 'lark' : 'feishu' };
  }
  return null;
}

/**
 * Classify a provider failure into a flow terminal state.
 * @param {unknown} error
 * @returns {'cancelled'|'expired'|'failed'}
 */
export function classifyConnectError(error) {
  const code = typeof /** @type {any} */ (error)?.code === 'string' ? /** @type {any} */ (error).code : '';
  const message = errorText(error);
  if (code === 'CANCELLED' || code === 'ABORT_ERR' || code === 'abort' || code === 'access_denied') {
    return 'cancelled';
  }
  if (
    code === 'EXPIRED'
    || code === 'expired'
    || code === 'expired_token'
    || code === 'expired_device_code'
    || /\bexpired\b/i.test(code)
    || /过期|expired_token|二维码已失效|二维码已过期/i.test(message)
  ) {
    return 'expired';
  }
  return 'failed';
}

/** @param {unknown} value */
function safeCallback(callback, payload) {
  if (typeof callback !== 'function') return;
  try {
    callback(payload);
  } catch {
    // UI callbacks must never fail a flow.
  }
}

/**
 * Encode `content` and hand `{ content, expiresAt, dataUrl }` to the flow
 * callback. Encoding happens off the provider's hot path (login.js does not
 * await `onQr`).
 */
function emitQr(onQr, content, expiresAt, qrcodeModule) {
  const text = String(content ?? '');
  if (text.length === 0) return;
  const payload = { content: text, expiresAt: Number(expiresAt) || 0 };
  void toQrDataUrl(text, qrcodeModule)
    .then((dataUrl) => safeCallback(onQr, { ...payload, dataUrl }))
    .catch(() => safeCallback(onQr, payload));
}

/**
 * @param {{
 *   registerApp?: Function,
 *   runWeixinLogin?: Function,
 *   qrcode?: any,
 * }} [deps]
 * @returns {{
 *   weixin: { begin: (input: Record<string, any>) => Promise<Record<string, any>> },
 *   feishu: { begin: (input: Record<string, any>) => Promise<Record<string, any>> },
 * }}
 */
export function createChannelConnectProviders(deps = {}) {
  const injectedRegisterApp = deps.registerApp;
  const injectedRunWeixinLogin = deps.runWeixinLogin;
  const qrcodeModule = deps.qrcode ?? QRCode;

  return {
    weixin: {
      /**
       * @param {{
       *   channelConfig: Record<string, any>,
       *   stateDir: string,
       *   onQr: Function,
       *   onStatus: Function,
       *   signal?: AbortSignal,
       * }} input
       */
      async begin({ channelConfig, stateDir, onQr, onStatus, signal }) {
        const runWeixinLogin = injectedRunWeixinLogin
          ?? (await import('../adapters/weixin/login.js')).runWeixinLogin;
        const resolvedStateDir = String(stateDir ?? '');
        let sawExpired = false;
        try {
          const result = await runWeixinLogin({
            stateDir: resolvedStateDir,
            config: channelConfig ?? {},
            ...(signal === undefined ? {} : { signal }),
            onQr: ({ qrcode: content, imageContent, expiresAt }) => {
              emitQr(onQr, imageContent || content, expiresAt, qrcodeModule);
            },
            onStatus: ({ status, detail }) => {
              if (status === 'wait') safeCallback(onStatus, { state: 'pending', ...(detail ? { detail } : {}) });
              else if (status === 'scaned') safeCallback(onStatus, { state: 'scanned', ...(detail ? { detail } : {}) });
              else if (status === 'expired') sawExpired = true;
            },
          });
          if (signal?.aborted) throw codedError('登录已取消', 'CANCELLED');
          const ilinkBotId = typeof result?.ilinkBotId === 'string' ? result.ilinkBotId : '';
          if (ilinkBotId === '') throw new Error('weixin login returned no ilinkBotId');
          return {
            ilinkBotId,
            ...(typeof result?.userId === 'string' && result.userId !== '' ? { userId: result.userId } : {}),
          };
        } catch (error) {
          if (signal?.aborted) throw codedError('登录已取消', 'CANCELLED');
          if (sawExpired || /过期|expired|登录超时/i.test(errorText(error))) {
            throw codedError(`weixin connect expired: ${errorText(error)}`, 'EXPIRED');
          }
          throw error;
        }
      },
    },

    feishu: {
      /**
       * @param {{
       *   channelConfig: Record<string, any>,
       *   onQr: Function,
       *   onStatus: Function,
       *   signal?: AbortSignal,
       * }} input
       */
      async begin({ channelConfig, onQr, onStatus, signal }) {
        const registerApp = injectedRegisterApp
          ?? (await import('@larksuiteoapi/node-sdk')).registerApp;
        const domain = resolveFeishuConnectDomain(channelConfig);
        try {
          const result = await registerApp({
            domain: domain.accountsDomain,
            ...(signal === undefined ? {} : { signal }),
            onQRCodeReady: (info) => {
              const expireIn = Number(info?.expireIn);
              emitQr(
                onQr,
                info?.url,
                Number.isFinite(expireIn) && expireIn > 0 ? Date.now() + expireIn * 1000 : 0,
                qrcodeModule,
              );
            },
            onStatusChange: (info) => {
              // 'polling' | 'slow_down' | 'domain_switched' — the SDK keeps
              // polling; the UI only needs pending. Surface slow_down as a
              // pending tick so a long poll keeps the flow's updatedAt fresh.
              if (info?.status === 'slow_down') safeCallback(onStatus, { state: 'pending', detail: 'slow_down' });
            },
          });
          if (signal?.aborted) throw codedError('登录已取消', 'CANCELLED');
          const appId = typeof result?.client_id === 'string' ? result.client_id : '';
          const appSecret = typeof result?.client_secret === 'string' ? result.client_secret : '';
          if (appId === '' || appSecret === '') {
            throw new Error('feishu app registration returned incomplete credentials');
          }
          return { appId, appSecret, domain: domain.domain };
        } catch (error) {
          if (signal?.aborted) throw codedError('登录已取消', 'CANCELLED');
          throw error;
        }
      },
    },
  };
}

/**
 * Map the channel's configured domain to the accounts host used by the
 * device-code registration.
 * @param {Record<string, any>} channelConfig
 * @returns {{ accountsDomain: string, domain: 'feishu'|'lark' }}
 */
export function resolveFeishuConnectDomain(channelConfig) {
  const raw = typeof channelConfig?.domain === 'string' ? channelConfig.domain.trim().toLowerCase() : '';
  if (raw === 'lark' || raw.includes('larksuite')) {
    return { accountsDomain: LARK_ACCOUNTS_DOMAIN, domain: 'lark' };
  }
  return { accountsDomain: FEISHU_ACCOUNTS_DOMAIN, domain: 'feishu' };
}

// ── flow state machine ───────────────────────────────────────────────────────

/**
 * @typedef {Object} ConnectFlowSnapshot
 * @property {string} flowId
 * @property {string} channel
 * @property {'pending'|'scanned'|'confirmed'|'expired'|'failed'|'cancelled'} state
 * @property {{ dataUrl: string, expiresAt: number } | null} qr
 * @property {number} intervalMs
 * @property {string | null} error
 * @property {Record<string, string> | null} result
 * @property {number} updatedAt
 */

const FLOW_STATE = Object.freeze({
  PENDING: 'pending',
  SCANNED: 'scanned',
  CONFIRMED: 'confirmed',
  EXPIRED: 'expired',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
});

/** @param {string} state */
function isTerminalState(state) {
  return state === FLOW_STATE.CONFIRMED
    || state === FLOW_STATE.EXPIRED
    || state === FLOW_STATE.FAILED
    || state === FLOW_STATE.CANCELLED;
}

/**
 * Create the per-workspace+channel connect flow store.
 *
 * @param {{
 *   providers?: { weixin?: { begin: Function }, feishu?: { begin: Function } },
 *   now?: () => number,
 *   qrcode?: any,
 *   intervalMs?: number,
 *   terminalTtlMs?: number,
 *   qrWaitMs?: number,
 *   onConfirmed?: (record: any, rawResult: any) => Promise<void> | void,
 *   onInactive?: (record: any) => Promise<void> | void,
 * }} [options]
 */
export function createChannelConnectService(options = {}) {
  const providers = options.providers ?? createChannelConnectProviders();
  const now = options.now ?? Date.now;
  const qrcodeModule = options.qrcode ?? QRCode;
  const intervalMs = Number.isFinite(options.intervalMs) ? Number(options.intervalMs) : DEFAULT_INTERVAL_MS;
  const terminalTtlMs = Number.isFinite(options.terminalTtlMs)
    ? Number(options.terminalTtlMs)
    : DEFAULT_TERMINAL_TTL_MS;
  // `begin()` resolves the HTTP POST only after the first QR is encoded, so the
  // UI receives `qr.dataUrl` without an extra poll. Never block forever: a
  // provider that stays silent returns a `pending` flow after this grace.
  const qrWaitMs = Number.isFinite(options.qrWaitMs) ? Math.max(0, Number(options.qrWaitMs)) : 1500;
  const onConfirmed = typeof options.onConfirmed === 'function' ? options.onConfirmed : null;
  const onInactive = typeof options.onInactive === 'function' ? options.onInactive : null;

  /** @type {Map<string, any>} */
  const flows = new Map();

  /** @param {string} workspaceId @param {string} channel */
  function flowKey(workspaceId, channel) {
    return `${workspaceId}:${channel}`;
  }

  /** @param {any} record @returns {ConnectFlowSnapshot} */
  function snapshot(record) {
    return {
      flowId: record.flowId,
      channel: record.channel,
      state: record.state,
      qr: record.qr === null ? null : { dataUrl: record.qr.dataUrl, expiresAt: record.qr.expiresAt },
      intervalMs,
      error: record.error,
      result: record.result,
      updatedAt: record.updatedAt,
    };
  }

  /** @param {any} record */
  function pruneIfStale(record) {
    if (!isTerminalState(record.state)) return false;
    if (now() - record.terminalAt <= terminalTtlMs) return false;
    flows.delete(flowKey(record.workspaceId, record.channel));
    return true;
  }

  /** @param {any} record @param {string} state @param {string | null} error */
  function markTerminal(record, state, error) {
    record.state = state;
    record.error = error;
    if (state !== FLOW_STATE.CONFIRMED) record.result = null;
    record.terminalAt = now();
    record.updatedAt = now();
    record.qr = state === FLOW_STATE.CONFIRMED ? record.qr : null;
    record.firstQr?.resolve();
    record.settled?.resolve();
  }

  /** @param {any} record */
  function cancelRecord(record) {
    if (isTerminalState(record.state)) return;
    try {
      record.controller.abort();
    } catch {
      // Already aborted.
    }
    markTerminal(record, FLOW_STATE.CANCELLED, null);
  }

  /** @param {any} record @param {{ content?: unknown, dataUrl?: unknown, expiresAt?: unknown }} payload */
  async function applyQr(record, payload) {
    if (record.controller.signal.aborted || isTerminalState(record.state)) return;
    let dataUrl = typeof payload?.dataUrl === 'string' && payload.dataUrl.startsWith('data:image/')
      ? payload.dataUrl
      : null;
    if (dataUrl === null) {
      try {
        dataUrl = await toQrDataUrl(payload?.content, qrcodeModule);
      } catch (error) {
        if (record.controller.signal.aborted || isTerminalState(record.state)) return;
        markTerminal(record, FLOW_STATE.FAILED, sanitizeErrorMessage(error));
        if (onInactive !== null) {
          try {
            await onInactive(record);
          } catch {
            // The manager logs handler failures itself.
          }
        }
        return;
      }
    }
    if (record.controller.signal.aborted || isTerminalState(record.state)) return;
    record.qr = { dataUrl, expiresAt: Number(payload?.expiresAt) || 0 };
    record.updatedAt = now();
    record.firstQr?.resolve();
  }

  /** @param {any} record @param {{ state?: unknown }} payload */
  function applyStatus(record, payload) {
    if (record.controller.signal.aborted || isTerminalState(record.state)) return;
    if (payload?.state !== 'scanned') return;
    if (record.state !== FLOW_STATE.SCANNED) {
      record.state = FLOW_STATE.SCANNED;
      record.updatedAt = now();
    }
  }

  /** @returns {{ promise: Promise<void>, resolve: () => void }} */
  function deferred() {
    let resolve = () => {};
    const promise = new Promise((resolvePromise) => {
      resolve = () => resolvePromise(undefined);
    });
    return { promise, resolve };
  }

  /**
   * Resolve as soon as the first QR is available, the flow becomes terminal, or
   * the grace window elapses (providers that emit nothing must not stall the
   * HTTP request).
   * @param {any} record
   * @param {number} waitMs
   */
  function waitForFirstSignal(record, waitMs) {
    return new Promise((resolvePromise) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolvePromise(undefined);
      };
      const timer = setTimeout(finish, waitMs);
      timer.unref?.();
      record.firstQr.promise.then(finish, finish);
      record.settled.promise.then(finish, finish);
    });
  }

  /**
   * Start the provider task detached from `begin()`: the HTTP POST must return
   * promptly while the QR flow can stay pending for minutes.
   * @param {any} record
   * @param {{ begin: Function }} provider
   * @param {Record<string, any>} input
   */
  function startProviderTask(record, provider, input) {
    record.task = (async () => {
      try {
        const rawResult = await provider.begin({
          ...input,
          signal: record.controller.signal,
          onQr: (payload) => {
            void applyQr(record, payload ?? {});
          },
          onStatus: (payload) => {
            applyStatus(record, payload ?? {});
          },
        });
        if (record.controller.signal.aborted || isTerminalState(record.state)) return;
        const result = sanitizeConnectResult(record.channel, rawResult);
        if (result === null) throw new Error('connect provider returned no usable result');
        // Terminal bookkeeping happens only after the manager persisted the
        // config and (when running) restarted the workspace: `confirmed` means
        // "ready to use", not "credentials received".
        if (onConfirmed !== null) await onConfirmed(record, rawResult);
        if (record.controller.signal.aborted || record.state === FLOW_STATE.CANCELLED) return;
        record.result = result;
        markTerminal(record, FLOW_STATE.CONFIRMED, null);
      } catch (error) {
        if (record.controller.signal.aborted || record.state === FLOW_STATE.CANCELLED) {
          cancelRecord(record);
          return;
        }
        // Already terminal (e.g. QR encoding failed before the provider settled).
        if (isTerminalState(record.state)) return;
        const state = classifyConnectError(error);
        if (state === 'cancelled') {
          markTerminal(record, FLOW_STATE.CANCELLED, null);
          return;
        }
        markTerminal(record, state, sanitizeErrorMessage(error));
        if (onInactive !== null) {
          try {
            await onInactive(record);
          } catch {
            // The manager logs handler failures itself.
          }
        }
      } finally {
        record.settled?.resolve();
      }
    })();
  }

  return {
    /**
     * Start a flow for one workspace+channel, replacing (cancelling) any
     * existing flow. Returns the fresh `pending` snapshot synchronously.
     * @param {{
     *   workspaceId: string,
     *   workspace: Record<string, any>,
     *   channel: string,
     *   channelConfig: Record<string, any>,
     *   stateDir?: string,
     *   mode?: string,
     * }} input
     * @returns {ConnectFlowSnapshot}
     */
    async begin(input) {
      const workspaceId = String(input?.workspaceId ?? '');
      const channel = String(input?.channel ?? '');
      const provider = providers?.[channel];
      if (provider === undefined || typeof provider.begin !== 'function') {
        throw codedError(`channel "${channel}" does not support QR connect`, 'INVALID_INPUT');
      }
      const key = flowKey(workspaceId, channel);
      const existing = flows.get(key);
      if (existing !== undefined) cancelRecord(existing);
      /** @type {any} */
      const record = {
        flowId: randomUUID(),
        workspaceId,
        channel,
        state: FLOW_STATE.PENDING,
        qr: null,
        result: null,
        error: null,
        updatedAt: now(),
        createdAt: now(),
        terminalAt: 0,
        controller: new AbortController(),
        task: null,
        firstQr: deferred(),
        settled: deferred(),
      };
      flows.set(key, record);
      startProviderTask(record, provider, {
        workspace: input?.workspace,
        channelConfig: input?.channelConfig ?? {},
        stateDir: input?.stateDir,
        mode: input?.mode ?? 'qr',
      });
      if (qrWaitMs > 0) {
        await waitForFirstSignal(record, qrWaitMs);
      }
      const flow = snapshot(record);
      // Contract §10.2: a newly begun flow is `pending`. A provider may emit
      // `scanned` while the POST is still in flight (and encoding the PNG takes
      // a few ms); that progress is observed through the next GET poll, not in
      // the begin response. Terminal outcomes (fast failure/cancel) are real.
      if (!isTerminalState(flow.state)) flow.state = FLOW_STATE.PENDING;
      return flow;
    },

    /**
     * Current or most recent flow (terminal flows expire after the retention
     * window). Returns `null` when there is nothing to show.
     * @param {string} workspaceId
     * @param {string} channel
     * @returns {ConnectFlowSnapshot | null}
     */
    get(workspaceId, channel) {
      const record = flows.get(flowKey(String(workspaceId), String(channel)));
      if (record === undefined) return null;
      if (pruneIfStale(record)) return null;
      return snapshot(record);
    },

    /**
     * Cancel an active flow. Terminal flows are returned unchanged (a cancelled
     * or confirmed flow is already history).
     * @param {string} workspaceId
     * @param {string} channel
     * @returns {ConnectFlowSnapshot | null}
     */
    cancel(workspaceId, channel) {
      const record = flows.get(flowKey(String(workspaceId), String(channel)));
      if (record === undefined) return null;
      if (pruneIfStale(record)) return null;
      cancelRecord(record);
      return snapshot(record);
    },

    /**
     * Abort every active flow belonging to one workspace (workspace removal).
     * @param {string} workspaceId
     */
    cancelWorkspace(workspaceId) {
      const prefix = `${String(workspaceId)}:`;
      for (const [key, record] of flows) {
        if (!key.startsWith(prefix)) continue;
        cancelRecord(record);
        flows.delete(key);
      }
    },

    /** Abort every active flow (manager shutdown). */
    dispose() {
      for (const record of flows.values()) cancelRecord(record);
      flows.clear();
    },

    /** @internal exposed for tests */
    entries() {
      return [...flows.values()];
    },
  };
}
