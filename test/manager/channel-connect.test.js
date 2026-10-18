import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  classifyConnectError,
  createChannelConnectProviders,
  createChannelConnectService,
  isConnectSupportedChannel,
  resolveFeishuConnectDomain,
  sanitizeConnectResult,
  toQrDataUrl,
} from '../../src/manager/channel-connect.js';
import {
  addWorkspace,
  createFakeConnectProviders,
  createFakeGatewayFactory,
  readJson,
  removeDir,
  setupManager,
  silentLogger,
  tempDir,
  waitFor,
} from './helpers.js';

/** Decode the PNG width from a `data:image/png;base64,...` URL. */
function pngWidth(dataUrl) {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const buffer = Buffer.from(base64, 'base64');
  assert.equal(buffer.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  return buffer.readUInt32BE(16);
}

// ── providers ────────────────────────────────────────────────────────────────

describe('channel connect: QR encoding', () => {
  it('renders a 640×640 PNG data URL', async () => {
    const dataUrl = await toQrDataUrl('https://example.com/qr');
    assert.match(dataUrl, /^data:image\/png;base64,/);
    assert.equal(pngWidth(dataUrl), 640);
  });

  it('forwards the encoder options and accepts an injected qrcode module', async () => {
    let captured = null;
    const fakeQr = {
      async toDataURL(text, options) {
        captured = { text, options };
        return 'data:image/png;base64,AAAA';
      },
    };
    const dataUrl = await toQrDataUrl('payload', fakeQr);
    assert.equal(dataUrl, 'data:image/png;base64,AAAA');
    assert.equal(captured.text, 'payload');
    assert.equal(captured.options.width, 640);
    assert.equal(captured.options.margin, 2);
  });

  it('rejects an encoder that does not return a data URL', async () => {
    await assert.rejects(toQrDataUrl('x', { toDataURL: async () => 'not-a-data-url' }), /data URL/);
  });
});

describe('channel connect: weixin provider', () => {
  it('calls runWeixinLogin with stateDir/config/onQr/onStatus/signal and maps the result', async () => {
    const calls = [];
    const providers = createChannelConnectProviders({
      runWeixinLogin: async (options) => {
        calls.push(options);
        options.onStatus({ status: 'wait' });
        options.onStatus({ status: 'scaned' });
        options.onQr({ qrcode: 'raw-qr', imageContent: 'https://weixin.example/qr', expiresAt: 12345 });
        options.onStatus({ status: 'confirmed' });
        return { ilinkBotId: 'ilink-bot-9', userId: 'wx-user-9', baseUrl: 'https://api.example' };
      },
    });
    const signal = new AbortController().signal;
    const qrEvents = [];
    const statuses = [];
    const result = await providers.weixin.begin({
      channelConfig: { mode: 'ilink' },
      stateDir: '/tmp/ws/state/channels/weixin',
      onQr: (payload) => qrEvents.push(payload),
      onStatus: (payload) => statuses.push(payload),
      signal,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].stateDir, '/tmp/ws/state/channels/weixin');
    assert.equal(calls[0].config.mode, 'ilink');
    assert.equal(calls[0].signal, signal);
    assert.deepEqual(result, { ilinkBotId: 'ilink-bot-9', userId: 'wx-user-9' });
    // 'wait' → pending, 'scaned' → scanned, 'confirmed' is not a UI status.
    assert.deepEqual(statuses.map((status) => status.state), ['pending', 'scanned']);
    await waitFor(() => qrEvents.length === 1, { description: 'weixin qr event' });
    assert.equal(qrEvents[0].content, 'https://weixin.example/qr');
    assert.equal(qrEvents[0].expiresAt, 12345);
    assert.match(qrEvents[0].dataUrl, /^data:image\/png;base64,/);
  });

  it('falls back to the raw qrcode content when imageContent is missing', async () => {
    const providers = createChannelConnectProviders({
      runWeixinLogin: async (options) => {
        options.onQr({ qrcode: 'https://raw.example/qr', imageContent: '', expiresAt: 1 });
        return { ilinkBotId: 'bot' };
      },
    });
    const qrEvents = [];
    await providers.weixin.begin({
      channelConfig: {},
      stateDir: '/tmp/state',
      onQr: (payload) => qrEvents.push(payload),
      onStatus: () => {},
    });
    await waitFor(() => qrEvents.length === 1, { description: 'weixin qr event' });
    assert.equal(qrEvents[0].content, 'https://raw.example/qr');
  });

  it('maps abort to a CANCELLED error', async () => {
    const providers = createChannelConnectProviders({
      runWeixinLogin: async ({ signal }) => {
        assert.equal(signal.aborted, true);
        throw new Error('login aborted');
      },
    });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      providers.weixin.begin({
        channelConfig: {},
        stateDir: '/tmp/state',
        onQr: () => {},
        onStatus: () => {},
        signal: controller.signal,
      }),
      (error) => {
        assert.equal(error.code, 'CANCELLED');
        return true;
      },
    );
  });

  it('maps QR expiry/timeout failures to an EXPIRED error', async () => {
    const providers = createChannelConnectProviders({
      runWeixinLogin: async () => {
        throw new Error('登录超时：二维码未在有效期内确认，请重新运行登录命令');
      },
    });
    await assert.rejects(
      providers.weixin.begin({ channelConfig: {}, stateDir: '/tmp/state', onQr: () => {}, onStatus: () => {} }),
      (error) => {
        assert.equal(error.code, 'EXPIRED');
        return true;
      },
    );
  });

  it('rejects an empty login result', async () => {
    const providers = createChannelConnectProviders({
      runWeixinLogin: async () => ({ ilinkBotId: '' }),
    });
    await assert.rejects(
      providers.weixin.begin({ channelConfig: {}, stateDir: '/tmp/state', onQr: () => {}, onStatus: () => {} }),
      /no ilinkBotId/,
    );
  });
});

describe('channel connect: feishu provider', () => {
  it('uses the feishu accounts domain, forwards the QR URL and maps credentials', async () => {
    let captured = null;
    const providers = createChannelConnectProviders({
      registerApp: async (options) => {
        captured = options;
        options.onQRCodeReady({ url: 'https://accounts.feishu.cn/qr/abc', expireIn: 600 });
        options.onStatusChange({ status: 'polling' });
        options.onStatusChange({ status: 'slow_down', interval: 10 });
        return { client_id: 'cli_0123456789abcdef', client_secret: 'secret-from-feishu' };
      },
    });
    const signal = new AbortController().signal;
    const qrEvents = [];
    const statuses = [];
    const before = Date.now();
    const result = await providers.feishu.begin({
      channelConfig: { domain: 'feishu' },
      onQr: (payload) => qrEvents.push(payload),
      onStatus: (payload) => statuses.push(payload),
      signal,
    });
    assert.equal(captured.domain, 'accounts.feishu.cn');
    assert.equal(captured.signal, signal);
    assert.equal(typeof captured.onQRCodeReady, 'function');
    assert.deepEqual(result, {
      appId: 'cli_0123456789abcdef',
      appSecret: 'secret-from-feishu',
      domain: 'feishu',
    });
    await waitFor(() => qrEvents.length === 1, { description: 'feishu qr event' });
    assert.equal(qrEvents[0].content, 'https://accounts.feishu.cn/qr/abc');
    assert.ok(qrEvents[0].expiresAt >= before + 600_000);
    assert.deepEqual(statuses, [{ state: 'pending', detail: 'slow_down' }]);
  });

  it('uses the Lark accounts domain for lark channels', async () => {
    let captured = null;
    const providers = createChannelConnectProviders({
      registerApp: async (options) => {
        captured = options;
        return { client_id: 'cli_0123456789abcdef', client_secret: 's' };
      },
    });
    const result = await providers.feishu.begin({
      channelConfig: { domain: 'lark' },
      onQr: () => {},
      onStatus: () => {},
    });
    assert.equal(captured.domain, 'accounts.larksuite.com');
    assert.equal(result.domain, 'lark');
  });

  it('rejects incomplete credentials', async () => {
    const providers = createChannelConnectProviders({
      registerApp: async () => ({ client_id: 'cli_x', client_secret: '' }),
    });
    await assert.rejects(
      providers.feishu.begin({ channelConfig: {}, onQr: () => {}, onStatus: () => {} }),
      /incomplete credentials/,
    );
  });

  it('maps abort to CANCELLED and keeps protocol error codes for the flow', async () => {
    const abortProviders = createChannelConnectProviders({
      registerApp: async ({ signal }) => {
        assert.equal(signal.aborted, true);
        throw new Error('aborted');
      },
    });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      abortProviders.feishu.begin({ channelConfig: {}, onQr: () => {}, onStatus: () => {}, signal: controller.signal }),
      (error) => {
        assert.equal(error.code, 'CANCELLED');
        return true;
      },
    );

    const expiredProviders = createChannelConnectProviders({
      registerApp: async () => {
        const error = new Error('device code expired');
        error.code = 'expired_token';
        throw error;
      },
    });
    await assert.rejects(
      expiredProviders.feishu.begin({ channelConfig: {}, onQr: () => {}, onStatus: () => {} }),
      (error) => {
        assert.equal(error.code, 'expired_token');
        return true;
      },
    );
  });
});

describe('channel connect: helpers', () => {
  it('recognises only weixin/feishu as QR-connect channels', () => {
    assert.equal(isConnectSupportedChannel('weixin'), true);
    assert.equal(isConnectSupportedChannel('feishu'), true);
    assert.equal(isConnectSupportedChannel('dingtalk'), false);
    assert.equal(isConnectSupportedChannel('wecom'), false);
    assert.equal(isConnectSupportedChannel(undefined), false);
  });

  it('resolves the feishu/lark accounts hosts', () => {
    assert.deepEqual(resolveFeishuConnectDomain({ domain: 'lark' }), {
      accountsDomain: 'accounts.larksuite.com',
      domain: 'lark',
    });
    assert.deepEqual(resolveFeishuConnectDomain({ domain: 'https://open.larksuite.com' }), {
      accountsDomain: 'accounts.larksuite.com',
      domain: 'lark',
    });
    assert.deepEqual(resolveFeishuConnectDomain({ domain: 'feishu' }), {
      accountsDomain: 'accounts.feishu.cn',
      domain: 'feishu',
    });
    assert.deepEqual(resolveFeishuConnectDomain({}), {
      accountsDomain: 'accounts.feishu.cn',
      domain: 'feishu',
    });
  });

  it('strips secrets from public flow results', () => {
    assert.deepEqual(
      sanitizeConnectResult('feishu', { appId: 'cli_x', appSecret: 'DO-NOT-LEAK', domain: 'feishu' }),
      { appId: 'cli_x', domain: 'feishu' },
    );
    assert.deepEqual(
      sanitizeConnectResult('weixin', { ilinkBotId: 'bot', userId: 'u', baseUrl: 'https://x', token: 't' }),
      { ilinkBotId: 'bot', userId: 'u' },
    );
    assert.equal(sanitizeConnectResult('feishu', { appSecret: 's' }), null);
    assert.equal(sanitizeConnectResult('weixin', null), null);
    assert.equal(sanitizeConnectResult('dingtalk', { appId: 'x' }), null);
  });

  it('classifies provider failures', () => {
    assert.equal(classifyConnectError({ code: 'CANCELLED' }), 'cancelled');
    assert.equal(classifyConnectError({ code: 'ABORT_ERR' }), 'cancelled');
    assert.equal(classifyConnectError({ code: 'access_denied' }), 'cancelled');
    assert.equal(classifyConnectError({ code: 'expired_token' }), 'expired');
    assert.equal(classifyConnectError(new Error('二维码已过期')), 'expired');
    assert.equal(classifyConnectError(new Error('socket hang up')), 'failed');
  });
});

// ── flow state machine ───────────────────────────────────────────────────────

/**
 * @param {{ providers?: Record<string, any>, options?: Record<string, any>, onConfirmed?: Function }} [input]
 */
function makeService(input = {}) {
  const fake = createFakeConnectProviders(input.providers ?? {});
  /** @type {any[]} */
  const confirmed = [];
  /** @type {any[]} */
  const inactive = [];
  const service = createChannelConnectService({
    providers: fake.providers,
    qrWaitMs: 0,
    ...(input.options ?? {}),
    onConfirmed: async (record, raw) => {
      confirmed.push({ record, raw });
      if (typeof input.onConfirmed === 'function') await input.onConfirmed(record, raw);
    },
    onInactive: async (record) => {
      inactive.push(record);
    },
  });
  return { service, fake, confirmed, inactive };
}

function beginInput(overrides = {}) {
  return {
    workspaceId: 'ws-1',
    workspace: { id: 'ws-1' },
    channel: 'weixin',
    channelConfig: { enabled: false },
    stateDir: '/tmp/ws-1/channels/weixin',
    ...overrides,
  };
}

describe('channel connect: flow state machine', () => {
  it('begin() returns a pending flow snapshot', async () => {
    const { service } = makeService();
    const flow = await service.begin(beginInput());
    assert.equal(flow.channel, 'weixin');
    assert.equal(flow.state, 'pending');
    assert.equal(flow.qr, null);
    assert.equal(flow.result, null);
    assert.equal(flow.error, null);
    assert.equal(flow.intervalMs, 1500);
    assert.equal(typeof flow.flowId, 'string');
    assert.ok(flow.flowId.length > 0);
    assert.equal(typeof flow.updatedAt, 'number');
  });

  it('begin() waits for the first QR when a grace window is configured', async () => {
    const provider = async (input) => {
      input.onQr({ content: 'https://qr.example/first', expiresAt: 55 });
      // Long enough that PNG encoding (a few ms) always finishes first.
      await new Promise((resolve) => setTimeout(resolve, 250));
      return { ilinkBotId: 'bot-after-wait' };
    };
    const { service } = makeService({ providers: { weixin: provider }, options: { qrWaitMs: 500 } });
    const flow = await service.begin(beginInput());
    assert.notEqual(flow.qr, null);
    assert.match(flow.qr.dataUrl, /^data:image\/png;base64,/);
    assert.equal(flow.qr.expiresAt, 55);
    // The provider is still running: confirmation arrives later.
    assert.equal(flow.state, 'pending');
    await waitFor(() => service.get('ws-1', 'weixin').state === 'confirmed', { description: 'late confirm' });
  });

  it('begin() returns a pending flow when the grace window elapses', async () => {
    const { service } = makeService({ options: { qrWaitMs: 25 } });
    const started = Date.now();
    const flow = await service.begin(beginInput());
    assert.equal(flow.state, 'pending');
    assert.equal(flow.qr, null);
    assert.ok(Date.now() - started >= 20);
  });

  it('rejects unsupported channels', async () => {
    const { service } = makeService();
    await assert.rejects(service.begin(beginInput({ channel: 'dingtalk' })), (error) => {
      assert.equal(error.code, 'INVALID_INPUT');
      return true;
    });
  });

  it('turns provider QR events into PNG data URLs', async () => {
    const { service, fake } = makeService();
    await service.begin(beginInput());
    const controller = fake.last('weixin');
    controller.qr({ content: 'https://qr.example/scan', expiresAt: 777 });
    await waitFor(() => service.get('ws-1', 'weixin').qr !== null, { description: 'qr data url' });
    const flow = service.get('ws-1', 'weixin');
    assert.equal(flow.state, 'pending');
    assert.equal(flow.qr.expiresAt, 777);
    assert.match(flow.qr.dataUrl, /^data:image\/png;base64,/);
    assert.equal(pngWidth(flow.qr.dataUrl), 640);
  });

  it('uses a provider-supplied dataUrl verbatim', async () => {
    const { service, fake } = makeService();
    await service.begin(beginInput());
    fake.last('weixin').qr({ dataUrl: 'data:image/png;base64,PROVIDED' });
    await waitFor(() => service.get('ws-1', 'weixin').qr !== null, { description: 'provided qr' });
    assert.equal(service.get('ws-1', 'weixin').qr.dataUrl, 'data:image/png;base64,PROVIDED');
  });

  it('moves pending → scanned and never downgrades', async () => {
    const { service, fake } = makeService();
    await service.begin(beginInput());
    const controller = fake.last('weixin');
    controller.status('pending');
    assert.equal(service.get('ws-1', 'weixin').state, 'pending');
    controller.status('scanned');
    assert.equal(service.get('ws-1', 'weixin').state, 'scanned');
    controller.status('pending');
    assert.equal(service.get('ws-1', 'weixin').state, 'scanned');
  });

  it('confirms a flow and exposes only the sanitized result', async () => {
    const { service, fake, confirmed } = makeService();
    await service.begin(beginInput({ channel: 'feishu' }));
    fake.last('feishu').success({
      appId: 'cli_0123456789abcdef',
      appSecret: 'provider-secret',
      domain: 'feishu',
    });
    await waitFor(() => service.get('ws-1', 'feishu').state === 'confirmed', { description: 'confirmed' });
    const flow = service.get('ws-1', 'feishu');
    assert.deepEqual(flow.result, { appId: 'cli_0123456789abcdef', domain: 'feishu' });
    assert.equal(JSON.stringify(flow).includes('provider-secret'), false);
    // The manager handler receives the raw result (needs the secret).
    assert.equal(confirmed.length, 1);
    assert.equal(confirmed[0].raw.appSecret, 'provider-secret');
    assert.equal(flow.error, null);
  });

  it('marks failures as failed with a redacted error and notifies the handler', async () => {
    const { service, fake, inactive } = makeService();
    await service.begin(beginInput());
    fake.last('weixin').fail(new Error('network exploded token=leak-me'));
    await waitFor(() => service.get('ws-1', 'weixin').state === 'failed', { description: 'failed' });
    const flow = service.get('ws-1', 'weixin');
    assert.match(flow.error, /network exploded/);
    assert.equal(flow.error.includes('leak-me'), false);
    assert.equal(flow.qr, null);
    assert.equal(flow.result, null);
    assert.equal(inactive.length, 1);
  });

  it('marks expired device codes as expired', async () => {
    const { service, fake, inactive } = makeService();
    await service.begin(beginInput({ channel: 'feishu' }));
    const error = new Error('device code expired');
    error.code = 'expired_token';
    fake.last('feishu').fail(error);
    await waitFor(() => service.get('ws-1', 'feishu').state === 'expired', { description: 'expired' });
    assert.equal(inactive.length, 1);
  });

  it('marks a failing manager handler as failed', async () => {
    const { service, fake, inactive } = makeService({
      onConfirmed: async () => {
        throw new Error('config write failed');
      },
    });
    await service.begin(beginInput());
    fake.last('weixin').success({ ilinkBotId: 'bot' });
    await waitFor(() => service.get('ws-1', 'weixin').state === 'failed', { description: 'handler failure' });
    assert.match(service.get('ws-1', 'weixin').error, /config write failed/);
    assert.equal(inactive.length, 1);
  });

  it('marks a flow failed when QR encoding fails', async () => {
    const fake = createFakeConnectProviders();
    const inactive = [];
    const svc = createChannelConnectService({
      providers: fake.providers,
      qrcode: { toDataURL: async () => { throw new Error('encoder broke'); } },
      onInactive: async (record) => inactive.push(record),
    });
    await svc.begin(beginInput());
    fake.last('weixin').qr({ content: 'https://qr.example' });
    await waitFor(() => svc.get('ws-1', 'weixin').state === 'failed', { description: 'encoder failure' });
    assert.match(svc.get('ws-1', 'weixin').error, /encoder broke/);
    assert.equal(inactive.length, 1);
  });

  it('rejects a provider result without a usable identifier', async () => {
    const { service, fake } = makeService();
    await service.begin(beginInput());
    fake.last('weixin').success({});
    await waitFor(() => service.get('ws-1', 'weixin').state === 'failed', { description: 'invalid result' });
    assert.match(service.get('ws-1', 'weixin').error, /no usable result/);
  });

  it('cancel() aborts the provider and keeps the flow cancelled', async () => {
    const { service, fake, confirmed } = makeService();
    await service.begin(beginInput());
    const controller = fake.last('weixin');
    const canceled = service.cancel('ws-1', 'weixin');
    assert.equal(canceled.state, 'cancelled');
    assert.equal(controller.input.signal.aborted, true);
    // A late provider success must not resurrect a cancelled flow.
    controller.success({ ilinkBotId: 'late-bot' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(service.get('ws-1', 'weixin').state, 'cancelled');
    assert.equal(confirmed.length, 0);
  });

  it('begin() replaces an active flow', async () => {
    const { service, fake } = makeService();
    const first = await service.begin(beginInput());
    const firstController = fake.last('weixin');
    const second = await service.begin(beginInput());
    assert.notEqual(first.flowId, second.flowId);
    assert.equal(firstController.input.signal.aborted, true);
    assert.equal(service.get('ws-1', 'weixin').flowId, second.flowId);
    assert.equal(fake.calls.length, 2);
  });

  it('get() returns null for unknown flows', () => {
    const { service } = makeService();
    assert.equal(service.get('ws-x', 'weixin'), null);
  });

  it('retains terminal flows for the TTL and then forgets them', async () => {
    let clock = 1_000;
    const { service, fake } = makeService({ options: { now: () => clock, terminalTtlMs: 1_000 } });
    await service.begin(beginInput());
    fake.last('weixin').success({ ilinkBotId: 'bot' });
    await waitFor(() => service.get('ws-1', 'weixin')?.state === 'confirmed', { description: 'confirmed' });
    clock += 1_001;
    assert.equal(service.get('ws-1', 'weixin'), null);
  });

  it('dispose() aborts every active flow', async () => {
    const { service, fake } = makeService();
    await service.begin(beginInput({ channel: 'weixin' }));
    await service.begin(beginInput({ channel: 'feishu', stateDir: '/tmp/ws-1/channels/feishu' }));
    service.dispose();
    assert.equal(fake.last('weixin').input.signal.aborted, true);
    assert.equal(fake.last('feishu').input.signal.aborted, true);
    assert.equal(service.get('ws-1', 'weixin'), null);
  });

  it('cancelWorkspace() only touches one workspace', async () => {
    const { service, fake } = makeService();
    await service.begin(beginInput({ workspaceId: 'ws-a' }));
    await service.begin(beginInput({ workspaceId: 'ws-b' }));
    service.cancelWorkspace('ws-a');
    assert.equal(fake.controllers[0].input.signal.aborted, true);
    assert.equal(fake.controllers[1].input.signal.aborted, false);
    assert.equal(service.get('ws-a', 'weixin'), null);
    assert.equal(service.get('ws-b', 'weixin').state, 'pending');
  });
});

// ── manager integration ──────────────────────────────────────────────────────

/**
 * @param {import('node:test').TestContext} t
 * @param {Record<string, any>} [options]
 */
async function setupConnectManager(t, options = {}) {
  const fake = options.fake ?? createFakeConnectProviders();
  const setup = await setupManager(t, {
    ...(options.setup ?? {}),
    connectProviders: fake.providers,
    connectOptions: { qrWaitMs: 0, ...(options.connectOptions ?? {}) },
  });
  return { ...setup, fake };
}

describe('manager: channel connect', () => {
  it('beginChannelConnect() returns a pending flow and forwards provider input', async (t) => {
    const { dir, manager, fake } = await setupConnectManager(t);
    const entry = await addWorkspace(manager, dir);
    const flow = await manager.beginChannelConnect(entry.id, 'weixin', { mode: 'qr' });
    assert.equal(flow.state, 'pending');
    assert.equal(flow.channel, 'weixin');
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0].input.workspace.id, entry.id);
    assert.equal(fake.calls[0].input.workspace.stateDir.endsWith('/channels/weixin'), true);
    assert.equal(fake.calls[0].input.stateDir.endsWith('/channels/weixin'), true);
    assert.deepEqual(manager.getChannelConnect(entry.id, 'weixin'), flow);
  });

  it('rejects unsupported channels, modes and unknown workspaces', async (t) => {
    const { dir, manager } = await setupConnectManager(t);
    const entry = await addWorkspace(manager, dir);
    await assert.rejects(manager.beginChannelConnect(entry.id, 'dingtalk'), (error) => {
      assert.equal(error.code, 'INVALID_INPUT');
      return true;
    });
    await assert.rejects(manager.beginChannelConnect(entry.id, 'wecom'), /does not support QR connect/);
    await assert.rejects(manager.beginChannelConnect(entry.id, 'weixin', { mode: 'manual' }), (error) => {
      assert.equal(error.code, 'INVALID_INPUT');
      return true;
    });
    await assert.rejects(manager.beginChannelConnect('missing', 'weixin'), (error) => {
      assert.equal(error.code, 'WORKSPACE_NOT_FOUND');
      return true;
    });
    assert.throws(() => manager.getChannelConnect(entry.id, 'dingtalk'), /does not support/);
    assert.throws(() => manager.getChannelConnect('missing', 'weixin'), /workspace not found/);
    await assert.rejects(manager.cancelChannelConnect('missing', 'weixin'), /workspace not found/);
  });

  it('refuses to connect a channel that is already enabled (409 conflict)', async (t) => {
    const { dir, manager } = await setupConnectManager(t);
    const entry = await addWorkspace(manager, dir);
    await manager.saveWorkspaceConfig(entry.id, { channels: { weixin: { enabled: true } } });
    await assert.rejects(manager.beginChannelConnect(entry.id, 'weixin'), (error) => {
      assert.equal(error.code, 'CONFLICT');
      assert.match(error.message, /already enabled/);
      return true;
    });
  });

  it('weixin success enables the channel and exposes a secret-free result', async (t) => {
    const fake = createFakeConnectProviders({
      weixin: async (input) => {
        input.onQr({ content: 'https://qr.example/weixin', expiresAt: 42 });
        input.onStatus({ state: 'scanned' });
        return { ilinkBotId: 'ilink-bot-42', userId: 'wx-user', token: 'must-not-leak' };
      },
    });
    const { dir, manager, factory } = await setupConnectManager(t, { fake });
    const entry = await addWorkspace(manager, dir);
    await manager.beginChannelConnect(entry.id, 'weixin');
    await waitFor(() => manager.getChannelConnect(entry.id, 'weixin').state === 'confirmed', {
      description: 'weixin confirmed',
    });
    const flow = manager.getChannelConnect(entry.id, 'weixin');
    assert.deepEqual(flow.result, { ilinkBotId: 'ilink-bot-42', userId: 'wx-user' });
    assert.equal(JSON.stringify(flow).includes('must-not-leak'), false);
    assert.equal(manager.getWorkspaceConfig(entry.id).channels.weixin.enabled, true);
    // The workspace was stopped: connecting must not spawn a gateway.
    assert.equal(factory.gateways.length, 0);
    assert.equal(manager.getState().workspaces[0].channels[0].id, 'weixin');
  });

  it('restarts a running workspace after weixin connect', async (t) => {
    const { dir, manager, factory, fake } = await setupConnectManager(t);
    const entry = await addWorkspace(manager, dir);
    await manager.startWorkspace(entry.id);
    assert.equal(factory.gateways.length, 1);
    await manager.beginChannelConnect(entry.id, 'weixin');
    fake.last('weixin').success({ ilinkBotId: 'bot-running' });
    await waitFor(() => manager.getChannelConnect(entry.id, 'weixin').state === 'confirmed', {
      description: 'confirmed after restart',
    });
    assert.equal(factory.gateways.length, 2);
    assert.equal(factory.gateways[0].state, 'stopped');
    assert.equal(factory.gateways[1].state, 'running');
    assert.equal(factory.configs[1].channels.weixin.enabled, true);
    assert.equal(manager.getState().workspaces[0].state, 'running');
  });

  it('feishu success writes appId/appSecret/domain and masks the secret on read', async (t) => {
    const fake = createFakeConnectProviders({
      feishu: async (input) => {
        input.onQr({ content: 'https://accounts.feishu.cn/qr', expiresAt: 7 });
        return { appId: 'cli_0123456789abcdef', appSecret: 'feishu-secret', domain: 'lark' };
      },
    });
    const { dir, manager } = await setupConnectManager(t, { fake });
    const entry = await addWorkspace(manager, dir, { channels: ['feishu'] });
    await manager.beginChannelConnect(entry.id, 'feishu');
    await waitFor(() => manager.getChannelConnect(entry.id, 'feishu').state === 'confirmed', {
      description: 'feishu confirmed',
    });
    const flow = manager.getChannelConnect(entry.id, 'feishu');
    assert.deepEqual(flow.result, { appId: 'cli_0123456789abcdef', domain: 'lark' });
    assert.equal(JSON.stringify(flow).includes('feishu-secret'), false);

    const raw = readJson(entry.configFile);
    assert.equal(raw.channels.feishu.enabled, true);
    assert.equal(raw.channels.feishu.appId, 'cli_0123456789abcdef');
    assert.equal(raw.channels.feishu.appSecret, 'feishu-secret');
    assert.equal(raw.channels.feishu.domain, 'lark');
    const masked = manager.getWorkspaceConfig(entry.id);
    assert.equal(masked.channels.feishu.appSecret, '***');
    assert.equal(masked.channels.feishu.appId, 'cli_0123456789abcdef');
  });

  it('leaves the channel disabled when the provider fails', async (t) => {
    const fake = createFakeConnectProviders({
      weixin: async () => {
        throw new Error('scan failed token=leak-me');
      },
    });
    const { dir, manager } = await setupConnectManager(t, { fake });
    const entry = await addWorkspace(manager, dir);
    await manager.beginChannelConnect(entry.id, 'weixin');
    await waitFor(() => manager.getChannelConnect(entry.id, 'weixin').state === 'failed', {
      description: 'failed flow',
    });
    const flow = manager.getChannelConnect(entry.id, 'weixin');
    assert.equal(flow.error.includes('leak-me'), false);
    assert.equal(manager.getWorkspaceConfig(entry.id).channels.weixin.enabled, false);
  });

  it('cancelChannelConnect() aborts the flow and keeps the channel disabled', async (t) => {
    const { dir, manager, fake } = await setupConnectManager(t);
    const entry = await addWorkspace(manager, dir);
    await manager.beginChannelConnect(entry.id, 'weixin');
    const providerInput = fake.last('weixin').input;
    const result = await manager.cancelChannelConnect(entry.id, 'weixin');
    assert.equal(result.ok, true);
    assert.equal(result.flow.state, 'cancelled');
    assert.equal(providerInput.signal.aborted, true);
    assert.equal(manager.getWorkspaceConfig(entry.id).channels.weixin.enabled, false);
    // Idempotent: a second cancel returns the terminal snapshot.
    const again = await manager.cancelChannelConnect(entry.id, 'weixin');
    assert.equal(again.flow.state, 'cancelled');
  });

  it('cancel with no flow still disables an enabled channel and restarts', async (t) => {
    const { dir, manager, factory } = await setupConnectManager(t);
    const entry = await addWorkspace(manager, dir);
    await manager.saveWorkspaceConfig(entry.id, { channels: { weixin: { enabled: true } } });
    await manager.startWorkspace(entry.id);
    assert.equal(factory.gateways.length, 1);
    const result = await manager.cancelChannelConnect(entry.id, 'weixin');
    assert.deepEqual(result, { ok: true, flow: null });
    assert.equal(manager.getWorkspaceConfig(entry.id).channels.weixin.enabled, false);
    assert.equal(factory.gateways.length, 2);
  });

  it('begin replaces an active flow and aborts the old provider task', async (t) => {
    const { dir, manager, fake } = await setupConnectManager(t);
    const entry = await addWorkspace(manager, dir);
    const first = await manager.beginChannelConnect(entry.id, 'weixin');
    const firstInput = fake.last('weixin').input;
    const second = await manager.beginChannelConnect(entry.id, 'weixin');
    assert.notEqual(first.flowId, second.flowId);
    assert.equal(firstInput.signal.aborted, true);
    assert.equal(manager.getChannelConnect(entry.id, 'weixin').flowId, second.flowId);
  });

  it('getChannelConnect() forgets terminal flows after the retention window', async (t) => {
    let clock = 1_000;
    const fake = createFakeConnectProviders({ weixin: async () => ({ ilinkBotId: 'bot-ttl' }) });
    const { dir, manager } = await setupConnectManager(t, {
      fake,
      setup: { now: () => clock },
      connectOptions: { terminalTtlMs: 500 },
    });
    const entry = await addWorkspace(manager, dir);
    await manager.beginChannelConnect(entry.id, 'weixin');
    await waitFor(() => manager.getChannelConnect(entry.id, 'weixin')?.state === 'confirmed', {
      description: 'confirmed',
    });
    clock += 501;
    assert.equal(manager.getChannelConnect(entry.id, 'weixin'), null);
  });

  it('removeWorkspace() aborts the workspace flow', async (t) => {
    const { dir, manager, fake } = await setupConnectManager(t);
    const entry = await addWorkspace(manager, dir);
    await manager.beginChannelConnect(entry.id, 'weixin');
    const providerInput = fake.last('weixin').input;
    await manager.removeWorkspace(entry.id);
    assert.equal(providerInput.signal.aborted, true);
    assert.throws(() => manager.getChannelConnect(entry.id, 'weixin'), /workspace not found/);
  });

  it('manager.stop() aborts every active connect flow', async (t) => {
    const { dir, manager, fake } = await setupConnectManager(t);
    const entry = await addWorkspace(manager, dir);
    await manager.beginChannelConnect(entry.id, 'weixin');
    const providerInput = fake.last('weixin').input;
    await manager.stop();
    assert.equal(providerInput.signal.aborted, true);
  });

  it('feishu manual mode is untouched: saveWorkspaceConfig enables without a flow', async (t) => {
    const { dir, manager } = await setupConnectManager(t);
    const entry = await addWorkspace(manager, dir, { channels: ['feishu'] });
    const saved = await manager.saveWorkspaceConfig(entry.id, {
      channels: { feishu: { enabled: true, appId: 'cli_0123456789abcdef', appSecret: 'manual-secret' } },
    });
    assert.equal(saved.channels.feishu.enabled, true);
    assert.equal(manager.getChannelConnect(entry.id, 'feishu'), null);
    assert.equal(readJson(entry.configFile).channels.feishu.appSecret, 'manual-secret');
  });
});

describe('manager: channel connect begin response', () => {
  it('POST connect waits briefly for the QR and returns it in a pending flow', async (t) => {
    const { createManagerApi } = await import('../../src/manager/api.js');
    const { createManager } = await import('../../src/manager/manager.js');
    const dir = tempDir('manager-connect-begin');
    // Provider emits the QR synchronously (like the real feishu/weixin
    // providers eventually do) and confirms a moment later.
    const fake = createFakeConnectProviders({
      weixin: async (input) => {
        input.onQr({ content: 'https://qr.example/sync', expiresAt: 4242 });
        await new Promise((resolve) => setTimeout(resolve, 40));
        return { ilinkBotId: 'ilink-bot-sync' };
      },
    });
    const manager = createManager({
      managerFile: join(dir, 'manager.json'),
      managerDataDir: join(dir, 'data'),
      logger: silentLogger(),
      gatewayFactory: createFakeGatewayFactory(),
      connectProviders: fake.providers,
      // Default qrWaitMs (1500) on purpose: this mirrors the real POST path.
    });
    await manager.init();
    const api = createManagerApi({ manager, logger: silentLogger() });
    const listen = await api.start({ host: '127.0.0.1', port: 0 });
    const base = `http://127.0.0.1:${listen.port}`;
    t.after(async () => {
      await api.stop().catch(() => {});
      await manager.stop().catch(() => {});
      removeDir(dir);
    });
    const created = await (await fetch(`${base}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Begin WS', workspaceDir: join(dir, 'begin-ws'), channels: ['weixin'] }),
    })).json();

    const begin = await (await fetch(`${base}/api/workspaces/${created.id}/channels/weixin/connect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'qr' }),
    })).json();
    assert.equal(begin.state, 'pending');
    assert.notEqual(begin.qr, null);
    assert.match(begin.qr.dataUrl, /^data:image\/png;base64,/);
    assert.equal(begin.qr.expiresAt, 4242);
    assert.ok(begin.flowId);

    let flow = begin;
    for (let attempt = 0; attempt < 100 && flow.state !== 'confirmed'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      flow = await (await fetch(`${base}/api/workspaces/${created.id}/channels/weixin/connect`)).json();
    }
    assert.equal(flow.state, 'confirmed');
    assert.equal(flow.result.ilinkBotId, 'ilink-bot-sync');
    const config = await (await fetch(`${base}/api/workspaces/${created.id}/config`)).json();
    assert.equal(config.channels.weixin.enabled, true);
  });
});

describe('manager: channel connect api integration', () => {
  it('exposes begin/get/cancel over HTTP with real validation and config writes', async (t) => {
    const { createManagerApi } = await import('../../src/manager/api.js');
    const { createManager } = await import('../../src/manager/manager.js');
    const dir = tempDir('manager-connect-api');
    const fake = createFakeConnectProviders();
    const factory = createFakeGatewayFactory();
    const manager = createManager({
      managerFile: join(dir, 'manager.json'),
      managerDataDir: join(dir, 'data'),
      logger: silentLogger(),
      gatewayFactory: factory,
      connectProviders: fake.providers,
      connectOptions: { qrWaitMs: 0 },
    });
    await manager.init();
    const api = createManagerApi({ manager, logger: silentLogger() });
    const listen = await api.start({ host: '127.0.0.1', port: 0 });
    const base = `http://127.0.0.1:${listen.port}`;
    const json = async (method, path, body) => {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      return { status: response.status, json: text.length > 0 ? JSON.parse(text) : null };
    };
    t.after(async () => {
      await api.stop().catch(() => {});
      await manager.stop().catch(() => {});
      removeDir(dir);
    });

    const created = await json('POST', '/api/workspaces', {
      name: 'Connect WS',
      workspaceDir: join(dir, 'connect-ws'),
      channels: ['weixin', 'feishu'],
    });
    assert.equal(created.status, 201);
    const id = created.json.id;

    // Unsupported channel / mode → 400.
    assert.equal((await json('POST', `/api/workspaces/${id}/channels/dingtalk/connect`, {})).status, 400);
    assert.equal((await json('POST', `/api/workspaces/${id}/channels/weixin/connect`, { mode: 'nope' })).status, 400);
    // GET before any flow → 404.
    assert.equal((await json('GET', `/api/workspaces/${id}/channels/weixin/connect`)).status, 404);
    // Unknown workspace → 404.
    assert.equal((await json('POST', '/api/workspaces/nope/channels/weixin/connect', {})).status, 404);

    // Begin → pending flow with a flowId.
    const begun = await json('POST', `/api/workspaces/${id}/channels/weixin/connect`, { mode: 'qr' });
    assert.equal(begun.status, 200);
    assert.equal(begun.json.state, 'pending');
    assert.equal(typeof begun.json.flowId, 'string');
    assert.equal(begun.json.intervalMs, 1500);

    // QR + scanned state are visible through GET.
    fake.last('weixin').qr({ content: 'https://qr.example/http', expiresAt: 99 });
    fake.last('weixin').status('scanned');
    await waitFor(() => {
      const flow = manager.getChannelConnect(id, 'weixin');
      return flow.state === 'scanned' && flow.qr !== null;
    }, { description: 'scanned flow with qr' });
    const polled = await json('GET', `/api/workspaces/${id}/channels/weixin/connect`);
    assert.equal(polled.status, 200);
    assert.equal(polled.json.state, 'scanned');
    assert.match(polled.json.qr.dataUrl, /^data:image\/png;base64,/);

    // Success → confirmed + enabled.
    fake.last('weixin').success({ ilinkBotId: 'http-bot' });
    await waitFor(() => manager.getChannelConnect(id, 'weixin')?.state === 'confirmed', {
      description: 'api confirmed',
    });
    const confirmed = await json('GET', `/api/workspaces/${id}/channels/weixin/connect`);
    assert.equal(confirmed.json.state, 'confirmed');
    assert.deepEqual(confirmed.json.result, { ilinkBotId: 'http-bot' });
    const enabledConfig = await json('GET', `/api/workspaces/${id}/config`);
    assert.equal(enabledConfig.json.channels.weixin.enabled, true);
    // Starting an enabled channel now conflicts with a new connect attempt.
    assert.equal((await json('POST', `/api/workspaces/${id}/channels/weixin/connect`, {})).status, 409);

    // Cancel disables it again.
    const canceled = await json('POST', `/api/workspaces/${id}/channels/weixin/connect/cancel`, {});
    assert.equal(canceled.status, 200);
    assert.equal(canceled.json.ok, true);
    const disabled = await json('GET', `/api/workspaces/${id}/config`);
    assert.equal(disabled.json.channels.weixin.enabled, false);
  });
});
