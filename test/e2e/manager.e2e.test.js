/**
 * End-to-end: real manager + two real gateway instances (different workspaces,
 * different channel bindings) + the real manager HTTP API and static UI.
 *
 * The DSH runtime at the edge is the fake runtime child process, so this test
 * needs no model credentials and no IM platform network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { defaultConfig } from '../../src/core/config.js';
import { createPairingStore } from '../../src/core/pairing.js';
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

function makeWorkspaceConfig(workspaceDir, stateDir, channels) {
  const config = defaultConfig();
  config.dsh.command = process.execPath;
  config.dsh.args = [fakeRuntimePath];
  config.dsh.cwd = workspaceDir;
  config.dsh.provider = 'deepseek-official';
  config.dsh.model = 'fake-model';
  config.dsh.initTimeoutMs = 5000;
  config.dsh.turnTimeoutMs = 10000;
  config.dsh.env = { FAKE_DSH_REPLY_TEXT: 'manager e2e' };
  config.gateway = {
    ...config.gateway,
    stateDir,
    http: { enabled: true, host: '127.0.0.1', port: 0, publicBaseUrl: '' },
    log: { level: 'silent' },
    access: { dmPolicy: 'allowlist', allowFrom: ['owner'], pairingTtlSec: 600, groups: { enabled: false, requireMention: true, allowFrom: [] } },
  };
  config.channels = {
    feishu: { ...config.channels.feishu, enabled: false },
    dingtalk: { ...config.channels.dingtalk, enabled: false },
    wecom: { ...config.channels.wecom, enabled: false },
    weixin: { ...config.channels.weixin, enabled: false },
  };
  Object.assign(config.channels, channels);
  return config;
}

function writeWorkspace(runDir, name, channels) {
  const workspaceDir = join(runDir, name);
  const stateDir = join(workspaceDir, '.dsh-im-manager', 'state');
  mkdirSync(join(workspaceDir, '.dsh-im-manager'), { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  const config = makeWorkspaceConfig(workspaceDir, stateDir, channels);
  const configFile = join(workspaceDir, '.dsh-im-manager', 'config.json');
  writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return { workspaceDir, stateDir, configFile };
}

async function waitFor(check, { timeoutMs = 15000, description = 'condition' } = {}) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test('manager e2e: two workspaces, different channels, state API + pairing + static UI', async (t) => {
  const runDir = createRunDir('manager-e2e');
  const managerDataDir = join(runDir.dir, 'manager-data');
  const managerFile = join(runDir.dir, 'manager.json');
  mkdirSync(managerDataDir, { recursive: true });

  const workspaceA = writeWorkspace(runDir.dir, 'ws-feishu', {
    feishu: {
      enabled: true,
      mode: 'webhook',
      appId: 'cli_0123456789abcdef',
      appSecret: 'super-secret-feishu',
      verificationToken: 'verify-token',
      webhookPath: '/webhook/feishu',
    },
  });
  const workspaceB = writeWorkspace(runDir.dir, 'ws-weixin', {
    weixin: { enabled: true },
  });

  // Seed a pending pairing in workspace A before its gateway starts.
  const pairing = createPairingStore({ file: join(workspaceA.stateDir, 'pairing.json') });
  const pending = pairing.request({ channel: 'feishu', senderId: 'ou_owner', name: 'Owner' });
  pairing.flush();

  writeFileSync(managerFile, `${JSON.stringify({
    version: 1,
    listen: { host: '127.0.0.1', port: 0 },
    workspaces: [
      { id: 'ws-feishu', name: 'Feishu 工作区', workspaceDir: workspaceA.workspaceDir, configFile: workspaceA.configFile, autoStart: false },
      { id: 'ws-weixin', name: '微信工作区', workspaceDir: workspaceB.workspaceDir, configFile: workspaceB.configFile, autoStart: false },
    ],
  }, null, 2)}\n`, { mode: 0o600 });

  const manager = createManager({ managerFile, managerDataDir, logger: silentLogger });
  await manager.init();
  await manager.start();
  const api = createManagerApi({ manager, logger: silentLogger });
  const listen = await api.start({ host: '127.0.0.1', port: 0 });
  t.after(async () => {
    await api.stop().catch(() => {});
    await manager.stop().catch(() => {});
    runDir.cleanup();
  });

  await manager.startWorkspace('ws-feishu');
  await manager.startWorkspace('ws-weixin');
  await waitFor(() => {
    const state = manager.getState();
    return state.workspaces.every((workspace) => workspace.state === 'running');
  }, { description: 'both workspaces running' });

  const state = manager.getState();
  assert.equal(state.workspaces.length, 2);
  const feishuWorkspace = state.workspaces.find((workspace) => workspace.id === 'ws-feishu');
  const weixinWorkspace = state.workspaces.find((workspace) => workspace.id === 'ws-weixin');
  assert.deepEqual(feishuWorkspace.channels.map((channel) => channel.id), ['feishu']);
  assert.equal(feishuWorkspace.channels[0].enabled, true);
  assert.equal(feishuWorkspace.channels[0].health, 'connected');
  assert.deepEqual(weixinWorkspace.channels.map((channel) => channel.id), ['weixin']);
  assert.equal(weixinWorkspace.channels[0].health, 'disconnected');
  assert.equal(feishuWorkspace.bridge, 'ready');
  assert.equal(weixinWorkspace.bridge, 'ready');

  // API state + masked config.
  const apiState = await (await fetch(`http://127.0.0.1:${listen.port}/api/state`)).json();
  assert.equal(apiState.workspaces.length, 2);
  const masked = await (await fetch(`http://127.0.0.1:${listen.port}/api/workspaces/ws-feishu/config`)).json();
  assert.equal(masked.channels.feishu.appSecret, '***');
  assert.equal(masked.channels.feishu.appId, 'cli_0123456789abcdef');

  // Pairing list + approve through the API.
  const pairingResponse = await (await fetch(`http://127.0.0.1:${listen.port}/api/workspaces/ws-feishu/pairing`)).json();
  assert.equal(pairingResponse.pending.length, 1);
  assert.equal(pairingResponse.pending[0].code, pending.code);
  const approved = await (await fetch(`http://127.0.0.1:${listen.port}/api/workspaces/ws-feishu/pairing/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: pending.code }),
  })).json();
  assert.equal(approved.ok, true);
  const reloaded = createPairingStore({ file: join(workspaceA.stateDir, 'pairing.json') });
  assert.equal(reloaded.isApproved('feishu', 'ou_owner'), true);

  // Static UI is served by the same process.
  const indexResponse = await fetch(`http://127.0.0.1:${listen.port}/`);
  assert.equal(indexResponse.status, 200);
  assert.match(indexResponse.headers.get('content-type') ?? '', /text\/html/);
  const html = await indexResponse.text();
  assert.match(html, /id="app"/);

  await manager.stopWorkspace('ws-weixin');
  await waitFor(() => manager.getState().workspaces.find((workspace) => workspace.id === 'ws-weixin').state === 'stopped', {
    description: 'ws-weixin stopped',
  });
});
