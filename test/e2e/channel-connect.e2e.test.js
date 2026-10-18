/**
 * End-to-end: manager channel QR connect API with injected providers.
 *
 * The real HTTP API, flow state machine, config writes and workspace lifecycle
 * are exercised; only the external QR providers (WeChat iLink / Feishu
 * registration) are faked, so no network or phone scan is needed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { defaultConfig } from '../../src/core/config.js';
import { createManager } from '../../src/manager/manager.js';
import { createManagerApi } from '../../src/manager/api.js';
import { createRunDir, fakeRuntimePath } from './helpers.js';

const silentLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return this;
  },
};

function makeWorkspace(runDir, name) {
  const workspaceDir = join(runDir, name);
  const stateDir = join(workspaceDir, '.dsh-im-manager', 'state');
  mkdirSync(join(workspaceDir, '.dsh-im-manager'), { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  const config = defaultConfig();
  config.dsh.command = process.execPath;
  config.dsh.args = [fakeRuntimePath];
  config.dsh.cwd = workspaceDir;
  config.dsh.provider = 'deepseek-official';
  config.dsh.model = 'fake-model';
  config.dsh.env = { FAKE_DSH_REPLY_TEXT: 'connect e2e' };
  config.gateway.stateDir = stateDir;
  config.gateway.http.enabled = false;
  config.gateway.log.level = 'silent';
  // Both QR channels start disabled; the connect flow must enable them.
  config.channels.weixin.enabled = false;
  config.channels.feishu.enabled = false;
  const configFile = join(workspaceDir, '.dsh-im-manager', 'config.json');
  writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return { workspaceDir, stateDir, configFile };
}

function readConfig(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function makeSucceedingProvider(result) {
  return {
    async begin({ onQr, onStatus }) {
      onQr({ content: 'https://example.test/qr?code=abc', expiresAt: Date.now() + 600_000 });
      onStatus({ state: 'pending' });
      await new Promise((resolve) => setTimeout(resolve, 15));
      onStatus({ state: 'scanned' });
      await new Promise((resolve) => setTimeout(resolve, 15));
      return result;
    },
  };
}

function makePendingProvider() {
  return {
    async begin({ onQr, signal }) {
      onQr({ content: 'https://example.test/qr?code=pending', expiresAt: Date.now() + 600_000 });
      await new Promise((resolve, reject) => {
        if (signal?.aborted) {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          return;
        }
        signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
      });
    },
  };
}

async function waitFor(check, { timeoutMs = 8000, description = 'condition' } = {}) {
  const started = Date.now();
  while (!(await check())) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('manager channel connect e2e: weixin QR confirm enables + persists channel', async (t) => {
  const runDir = createRunDir('connect-weixin');
  const managerDataDir = join(runDir.dir, 'manager-data');
  const managerFile = join(runDir.dir, 'manager.json');
  mkdirSync(managerDataDir, { recursive: true });
  const workspace = makeWorkspace(runDir.dir, 'ws-weixin');
  writeFileSync(managerFile, `${JSON.stringify({
    version: 1,
    listen: { host: '127.0.0.1', port: 0 },
    workspaces: [{ id: 'ws-weixin', name: '微信工作区', workspaceDir: workspace.workspaceDir, configFile: workspace.configFile, autoStart: false }],
  }, null, 2)}\n`);

  const manager = createManager({
    managerFile,
    managerDataDir,
    logger: silentLogger,
    connectProviders: {
      weixin: makeSucceedingProvider({ ilinkBotId: 'bot-connect@im.bot', userId: 'wxid-connect@im.wechat' }),
    },
  });
  await manager.init();
  await manager.start();
  const api = createManagerApi({ manager, logger: silentLogger });
  const listen = await api.start({ host: '127.0.0.1', port: 0 });
  t.after(async () => {
    await api.stop().catch(() => {});
    await manager.stop().catch(() => {});
    runDir.cleanup();
  });
  const base = `http://127.0.0.1:${listen.port}`;

  const begin = await (await fetch(`${base}/api/workspaces/ws-weixin/channels/weixin/connect`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'qr' }),
  })).json();
  assert.equal(begin.state, 'pending');
  assert.match(begin.qr.dataUrl, /^data:image\/png;base64,/);
  assert.ok(begin.flowId);

  let flow;
  await waitFor(async () => {
    flow = await (await fetch(`${base}/api/workspaces/ws-weixin/channels/weixin/connect`)).json();
    return flow.state === 'confirmed';
  }, { description: 'weixin connect confirmed' });
  assert.equal(flow.result.ilinkBotId, 'bot-connect@im.bot');
  const saved = readConfig(workspace.configFile);
  assert.equal(saved.channels.weixin.enabled, true);

  // A confirmed/enabled channel cannot begin another QR flow.
  const again = await fetch(`${base}/api/workspaces/ws-weixin/channels/weixin/connect`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'qr' }),
  });
  assert.equal(again.status, 409);
});

test('manager channel connect e2e: feishu QR confirm writes appId; cancel leaves disabled', async (t) => {
  const runDir = createRunDir('connect-feishu');
  const managerDataDir = join(runDir.dir, 'manager-data');
  const managerFile = join(runDir.dir, 'manager.json');
  mkdirSync(managerDataDir, { recursive: true });
  const workspace = makeWorkspace(runDir.dir, 'ws-feishu');
  writeFileSync(managerFile, `${JSON.stringify({
    version: 1,
    listen: { host: '127.0.0.1', port: 0 },
    workspaces: [{ id: 'ws-feishu', name: '飞书工作区', workspaceDir: workspace.workspaceDir, configFile: workspace.configFile, autoStart: false }],
  }, null, 2)}\n`);

  const manager = createManager({
    managerFile,
    managerDataDir,
    logger: silentLogger,
    connectProviders: {
      feishu: makeSucceedingProvider({ appId: 'cli_0123456789abcdef', appSecret: 'secret-from-qr', domain: 'feishu' }),
    },
  });
  await manager.init();
  await manager.start();
  const api = createManagerApi({ manager, logger: silentLogger });
  const listen = await api.start({ host: '127.0.0.1', port: 0 });
  t.after(async () => {
    await api.stop().catch(() => {});
    await manager.stop().catch(() => {});
    runDir.cleanup();
  });
  const base = `http://127.0.0.1:${listen.port}`;

  const begin = await (await fetch(`${base}/api/workspaces/ws-feishu/channels/feishu/connect`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'qr' }),
  })).json();
  assert.match(begin.qr.dataUrl, /^data:image\/png;base64,/);
  let flow;
  await waitFor(async () => {
    flow = await (await fetch(`${base}/api/workspaces/ws-feishu/channels/feishu/connect`)).json();
    return flow.state === 'confirmed';
  }, { description: 'feishu connect confirmed' });
  assert.equal(flow.result.appId, 'cli_0123456789abcdef');
  const saved = readConfig(workspace.configFile);
  assert.equal(saved.channels.feishu.enabled, true);
  assert.equal(saved.channels.feishu.appId, 'cli_0123456789abcdef');
  assert.equal(saved.channels.feishu.appSecret, 'secret-from-qr');

  // Cancel path: disable the channel again, begin a pending flow, cancel it.
  const disable = await fetch(`${base}/api/workspaces/ws-feishu/config`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ config: { ...saved, channels: { ...saved.channels, feishu: { ...saved.channels.feishu, enabled: false } } } }),
  });
  assert.equal(disable.status, 200);

  const cancelManager = createManager({
    managerFile,
    managerDataDir,
    logger: silentLogger,
    connectProviders: { feishu: makePendingProvider() },
  });
  await cancelManager.init();
  const cancelApi = createManagerApi({ manager: cancelManager, logger: silentLogger });
  const cancelListen = await cancelApi.start({ host: '127.0.0.1', port: 0 });
  t.after(async () => {
    await cancelApi.stop().catch(() => {});
    await cancelManager.stop().catch(() => {});
  });
  const cancelBase = `http://127.0.0.1:${cancelListen.port}`;
  const pending = await (await fetch(`${cancelBase}/api/workspaces/ws-feishu/channels/feishu/connect`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'qr' }),
  })).json();
  assert.equal(pending.state, 'pending');
  const cancelled = await (await fetch(`${cancelBase}/api/workspaces/ws-feishu/channels/feishu/connect/cancel`, { method: 'POST' })).json();
  assert.equal(cancelled.ok, true);
  const stateAfter = await (await fetch(`${cancelBase}/api/workspaces/ws-feishu/channels/feishu/connect`)).json();
  assert.equal(stateAfter.state, 'cancelled');
  assert.equal(readConfig(workspace.configFile).channels.feishu.enabled, false);
});
