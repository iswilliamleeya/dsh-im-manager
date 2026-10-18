/**
 * Shared helpers for the manager/API unit tests.
 *
 * The fake gateway implements just enough of `createGateway`'s surface for the
 * manager (`start`, `stop`, `status`, `state`, `config`, `pairing`) and keeps
 * counters so tests can assert lifecycle behaviour without spawning a DSH
 * runtime.
 */
import http from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createManager } from '../../src/manager/manager.js';
import { createPairingStore } from '../../src/core/pairing.js';

/** @param {string} [label] */
export function tempDir(label = 'manager') {
  return mkdtempSync(join(tmpdir(), `dsh-im-manager-${label}-`));
}

/** @param {string} dir */
export function removeDir(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
}

/** Poll `check()` until it returns truthy (or throw after timeout). */
export async function waitFor(check, { timeoutMs = 2000, description = 'condition' } = {}) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export function silentLogger() {
  /** @type {any} */
  const logger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    child() {
      return logger;
    },
  };
  return logger;
}

/** @param {string} file */
export function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** @param {string} file @returns {number} e.g. 0o600 */
export function fileMode(file) {
  return statSync(file).mode & 0o777;
}

/** @param {string} file @param {unknown} value */
export function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fake gateway factory. Options:
 *   - failStart(config, gateway, index) -> boolean (throw on that start)
 *   - failStop(config, gateway) -> boolean
 *   - failStatus(config, gateway) -> boolean
 *   - startDelayMs / stopDelayMs
 *   - bridgeState, sessions, httpPort, health: Record<channel, state>
 *   - onStart(gateway) / onStop(gateway)
 *
 * @param {Record<string, any>} [options]
 */
export function createFakeGatewayFactory(options = {}) {
  /** @type {any[]} */
  const gateways = [];
  /** @type {Record<string, any>[]} */
  const configs = [];
  /** @param {{ config: Record<string, any>, logger: any }} input */
  function factory(input) {
    const gateway = createFakeGateway({
      config: input.config,
      logger: input.logger,
      options,
      index: gateways.length,
    });
    gateways.push(gateway);
    configs.push(input.config);
    options.onFactory?.(gateway, input.config);
    return gateway;
  }
  factory.gateways = gateways;
  factory.configs = configs;
  return factory;
}

/**
 * @param {{
 *   config: Record<string, any>,
 *   logger: any,
 *   options?: Record<string, any>,
 *   index?: number,
 * }} input
 */
export function createFakeGateway({ config, logger, options = {}, index = 0 }) {
  /** @type {'idle'|'starting'|'running'|'stopping'|'stopped'} */
  let state = 'idle';
  let startCalls = 0;
  let stopCalls = 0;
  const pairing = createPairingStore({ file: join(config.gateway.stateDir, 'pairing.json') });
  const sessions = options.sessionStore ?? { list: () => Array.isArray(options.sessionEntries) ? options.sessionEntries : [] };
  /** @type {Map<string, any>} */
  const adapters = new Map();
  /** @type {Array<{ channel: string, target: any, message: any }>} */
  const sent = [];
  let sendAttempts = 0;

  /**
   * Register one fake adapter per enabled channel (or an explicit
   * `options.adapterIds`) when the gateway starts.
   */
  function registerAdapters() {
    const ids = Array.isArray(options.adapterIds)
      ? options.adapterIds
      : Object.entries(config.channels ?? {})
        .filter(([, channelConfig]) => channelConfig?.enabled === true)
        .map(([channelId]) => channelId);
    for (const channelId of ids) {
      if (adapters.has(channelId)) continue;
      adapters.set(channelId, {
        id: channelId,
        capabilities: { text: true, markdown: true, media: false, streaming: false, typing: false, threads: false },
        async send(target, message) {
          sendAttempts += 1;
          if (typeof options.failSend === 'function' && options.failSend(config, gateway, channelId) === true) {
            throw new Error(options.failSendMessage ?? 'fake adapter send failed');
          }
          if (typeof options.onSend === 'function') {
            const custom = await options.onSend({ channel: channelId, target, message, gateway, index });
            if (custom !== undefined) return custom;
          }
          sent.push({ channel: channelId, target, message });
          return { messageId: `${options.messageIdPrefix ?? 'fake-msg'}-${sent.length}` };
        },
      });
    }
  }

  /** @type {any} */
  const gateway = {
    config,
    logger,
    pairing,
    sessions,
    adapterMap: adapters,
    sent,
    get sendAttempts() {
      return sendAttempts;
    },
    get state() {
      return state;
    },
    get startCalls() {
      return startCalls;
    },
    get stopCalls() {
      return stopCalls;
    },
    async start() {
      startCalls += 1;
      if (options.failStart?.(config, gateway, index) === true) {
        state = 'stopped';
        throw new Error(options.failMessage ?? 'fake gateway start failed');
      }
      state = 'starting';
      if (options.startDelayMs) await delay(options.startDelayMs);
      state = 'running';
      registerAdapters();
      options.onStart?.(gateway);
    },
    async stop() {
      stopCalls += 1;
      if (options.failStop?.(config, gateway) === true) {
        throw new Error('fake gateway stop failed');
      }
      if (state === 'stopped') return;
      state = 'stopping';
      if (options.stopDelayMs) await delay(options.stopDelayMs);
      state = 'stopped';
      options.onStop?.(gateway);
    },
    async status() {
      if (options.failStatus?.(config, gateway) === true) {
        throw new Error('fake gateway status failed');
      }
      if (typeof options.status === 'function') {
        return options.status({ config, gateway, state });
      }
      /** @type {Record<string, any>} */
      const channels = {};
      for (const [id, channelConfig] of Object.entries(config.channels ?? {})) {
        if (channelConfig?.enabled === true) {
          channels[id] = {
            state: options.health?.[id] ?? 'connected',
            ...(options.detail?.[id] ? { detail: options.detail[id] } : {}),
          };
        }
      }
      const httpPort = options.httpPort ?? 54321;
      return {
        state,
        bridge: options.bridgeState ?? (state === 'running' ? 'ready' : 'stopped'),
        channels,
        sessions: options.sessions ?? 0,
        http: { port: httpPort, publicBaseUrl: `http://127.0.0.1:${httpPort}` },
      };
    },
  };
  return gateway;
}

/**
 * Fake channel-connect providers.
 *
 * By default every `begin()` returns a pending promise and records a
 * controller so the test can drive QR callbacks, status updates, success or
 * failure. Pass `overrides.weixin` / `overrides.feishu` with an async function
 * `(input) => result` for simple immediate flows.
 *
 * @param {{ weixin?: Function, feishu?: Function }} [overrides]
 */
export function createFakeConnectProviders(overrides = {}) {
  /** @type {Array<{ channel: string, input: any }>} */
  const calls = [];
  /** @type {Array<Record<string, any>>} */
  const controllers = [];

  /** @param {string} channel */
  function defaultResult(channel) {
    return channel === 'feishu'
      ? { appId: 'cli_0123456789abcdef', appSecret: 'feishu-secret-from-provider', domain: 'feishu' }
      : { ilinkBotId: 'ilink-bot-1', userId: 'wx-user-1' };
  }

  /** @param {string} channel */
  function providerFor(channel) {
    return {
      async begin(input) {
        calls.push({ channel, input });
        const override = overrides[channel];
        if (typeof override === 'function') {
          return override(input, channel);
        }
        return new Promise((resolve, reject) => {
          controllers.push({
            channel,
            input,
            qr(payload = {}) {
              input.onQr({
                content: payload.content ?? `https://qr.example/${channel}`,
                expiresAt: payload.expiresAt ?? Date.now() + 60_000,
                ...(payload.dataUrl === undefined ? {} : { dataUrl: payload.dataUrl }),
              });
            },
            status(state, detail) {
              input.onStatus({ state, ...(detail === undefined ? {} : { detail }) });
            },
            success(result) {
              resolve(result ?? defaultResult(channel));
            },
            fail(error) {
              reject(error);
            },
          });
        });
      },
    };
  }

  const providers = { weixin: providerFor('weixin'), feishu: providerFor('feishu') };
  return {
    providers,
    calls,
    controllers,
    /** @param {string} channel */
    last(channel) {
      for (let index = controllers.length - 1; index >= 0; index -= 1) {
        if (controllers[index].channel === channel) return controllers[index];
      }
      return undefined;
    },
  };
}

/**
 * Create a manager wired to a fake gateway factory, inside a throwaway dir.
 * Registers cleanup on the test context.
 *
 * @param {import('node:test').TestContext} t
 * @param {{
 *   factory?: Record<string, any>,
 *   factoryOptions?: Record<string, any>,
 *   provider?: string,
 *   now?: () => number,
 *   init?: boolean,
 *   managerFile?: string,
 *   connectProviders?: Record<string, any>,
 *   connectOptions?: Record<string, any>,
 * }} [options]
 */
export async function setupManager(t, options = {}) {
  const dir = tempDir('manager-lifecycle');
  const managerFile = options.managerFile ?? join(dir, 'manager.json');
  const managerDataDir = join(dir, 'manager-data');
  const factory = options.factory ?? createFakeGatewayFactory(options.factoryOptions ?? {});
  const manager = createManager({
    managerFile,
    managerDataDir,
    logger: silentLogger(),
    gatewayFactory: factory,
    ...(options.provider === undefined ? {} : { provider: options.provider }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.connectProviders === undefined ? {} : { connectProviders: options.connectProviders }),
    ...(options.connectOptions === undefined ? {} : { connectOptions: options.connectOptions }),
  });
  if (options.init !== false) await manager.init();
  t.after(async () => {
    await manager.stop().catch(() => {});
    removeDir(dir);
  });
  return { dir, managerFile, managerDataDir, manager, factory };
}

/**
 * Add a workspace under `dir` with a unique directory. Defaults to a single
 * enabled `feishu` channel (valid credentials are *not* required at creation).
 *
 * @param {ReturnType<typeof createManager>} manager
 * @param {string} dir
 * @param {Record<string, any>} [overrides]
 */
export async function addWorkspace(manager, dir, overrides = {}) {
  const name = overrides.name ?? `Workspace ${Math.random().toString(36).slice(2, 8)}`;
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'ws';
  const workspaceDir = overrides.workspaceDir ?? join(dir, 'workspaces', `${slug}-${Math.random().toString(36).slice(2, 6)}`);
  const input = {
    name,
    workspaceDir,
    channels: ['feishu'],
    autoStart: false,
    ...overrides,
  };
  if (overrides.workspaceDir === undefined) input.workspaceDir = workspaceDir;
  return manager.addWorkspace(input);
}

/**
 * Create a fake manager for API tests: records every call, returns canned data
 * and can be told to fail specific methods.
 *
 * @param {{ state?: Record<string, any>, failures?: Record<string, any> }} [options]
 */
export function createFakeManager(options = {}) {
  /** @type {Array<[string, ...any]>} */
  const calls = [];
  const state = options.state ?? {
    manager: { pid: 4242, listen: { host: '127.0.0.1', port: 8788 }, startedAt: 100, workspaceCount: 1 },
    workspaces: [{ id: 'ws-1', name: 'WS 1', state: 'running', channels: [] }],
  };
  const failures = options.failures ?? {};
  const maskedConfig = options.maskedConfig ?? {
    dsh: { cwd: '/tmp/ws-1' },
    gateway: { stateDir: '/tmp/state' },
    channels: { feishu: { enabled: true, appId: 'cli_0123456789abcdef', appSecret: '***' } },
  };

  /** @param {string} name */
  function maybeFail(name) {
    const failure = failures[name];
    if (failure === undefined) return;
    throw failure;
  }

  /** @param {string} name @param {...any} args */
  function record(name, ...args) {
    calls.push([name, ...args]);
  }

  return {
    calls,
    maskedConfig,
    async refresh() {
      record('refresh');
      maybeFail('refresh');
    },
    getState() {
      record('getState');
      return state;
    },
    async addWorkspace(input) {
      record('addWorkspace', input);
      maybeFail('addWorkspace');
      return { id: 'ws-new', name: input?.name ?? 'new', state: 'stopped' };
    },
    async updateWorkspace(id, patch) {
      record('updateWorkspace', id, patch);
      maybeFail('updateWorkspace');
      return { id, name: patch?.name ?? 'WS 1', state: 'running' };
    },
    async removeWorkspace(id) {
      record('removeWorkspace', id);
      maybeFail('removeWorkspace');
      return { ok: true, workspace: { id } };
    },
    async startWorkspace(id) {
      record('startWorkspace', id);
      maybeFail('startWorkspace');
      return { id, state: 'running' };
    },
    async stopWorkspace(id) {
      record('stopWorkspace', id);
      maybeFail('stopWorkspace');
      return { id, state: 'stopped' };
    },
    async restartWorkspace(id) {
      record('restartWorkspace', id);
      maybeFail('restartWorkspace');
      return { id, state: 'running' };
    },
    getWorkspaceConfig(id) {
      record('getWorkspaceConfig', id);
      maybeFail('getWorkspaceConfig');
      return maskedConfig;
    },
    async saveWorkspaceConfig(id, config) {
      record('saveWorkspaceConfig', id, config);
      maybeFail('saveWorkspaceConfig');
      return maskedConfig;
    },
    async beginChannelConnect(id, channel, input) {
      record('beginChannelConnect', id, channel, input);
      maybeFail('beginChannelConnect');
      return {
        flowId: 'flow-1',
        channel,
        state: 'pending',
        qr: null,
        intervalMs: 1500,
        error: null,
        result: null,
        updatedAt: 123,
      };
    },
    getChannelConnect(id, channel) {
      record('getChannelConnect', id, channel);
      maybeFail('getChannelConnect');
      return {
        flowId: 'flow-1',
        channel,
        state: 'confirmed',
        qr: { dataUrl: 'data:image/png;base64,AAAA', expiresAt: 999 },
        intervalMs: 1500,
        error: null,
        result: { ilinkBotId: 'bot-1' },
        updatedAt: 124,
      };
    },
    async cancelChannelConnect(id, channel) {
      record('cancelChannelConnect', id, channel);
      maybeFail('cancelChannelConnect');
      return { ok: true, flow: null };
    },
    listPairing(id) {
      record('listPairing', id);
      maybeFail('listPairing');
      return [{ code: '123456', channel: 'feishu', senderId: 'ou_x', name: null, expiresAt: 999 }];
    },
    async approvePairing(id, code) {
      record('approvePairing', id, code);
      maybeFail('approvePairing');
      return { ok: true, channel: 'feishu', senderId: 'ou_x' };
    },
    async allowSender(id, input) {
      record('allowSender', id, input);
      maybeFail('allowSender');
      return { channel: input.channel, senderId: input.senderId, ...(input.name ? { name: input.name } : {}) };
    },
    async sendMessage(id, input) {
      record('sendMessage', id, input);
      maybeFail('sendMessage');
      return { messageId: 'msg-1' };
    },
    getLogs(id, lines) {
      record('getLogs', id, lines);
      maybeFail('getLogs');
      return ['line one', 'line two'];
    },
  };
}

/**
 * Write a minimal static UI into `<dir>/webui`.
 * @param {string} dir
 */
/**
 * Start a manager API against a fake manager.
 * @param {import('node:test').TestContext} t
 * @param {{ manager?: any }} [options]
 */
export async function setupApi(t, options = {}) {
  const { createManagerApi } = await import('../../src/manager/api.js');
  const dir = tempDir('manager-api');
  const manager = options.manager ?? createFakeManager();
  const api = createManagerApi({ manager, logger: silentLogger() });
  const listen = await api.start({ host: '127.0.0.1', port: 0 });
  t.after(async () => {
    await api.stop().catch(() => {});
    removeDir(dir);
  });
  return { dir, manager, api, listen, base: `http://127.0.0.1:${listen.port}` };
}

/**
 * JSON-ish fetch helper.
 * @param {string} base
 * @param {string} method
 * @param {string} path
 * @param {unknown} [body]
 */
export async function request(base, method, path, body) {
  const init = { method, headers: {} };
  if (body !== undefined) {
    if (typeof body === 'string') {
      init.body = body;
      init.headers['content-type'] = 'application/json';
    } else {
      init.body = JSON.stringify(body);
      init.headers['content-type'] = 'application/json';
    }
  }
  const response = await fetch(`${base}${path}`, init);
  const text = await response.text();
  let json = null;
  try {
    json = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return {
    status: response.status,
    headers: response.headers,
    text,
    json,
  };
}

/**
 * Send a raw HTTP request (fetch normalizes `..` in URL paths, so traversal
 * tests must use the lower-level client).
 * @param {number} port
 * @param {string} rawPath
 */
export function rawRequest(port, rawPath) {
  return new Promise((resolvePromise, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: rawPath }, (res) => {
      /** @type {Buffer[]} */
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        resolvePromise({
          status: res.statusCode ?? 0,
          headers: res.headers,
          text: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}
