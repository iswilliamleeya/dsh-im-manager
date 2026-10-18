import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { createManager } from '../../src/manager/manager.js';
import {
  addWorkspace,
  createFakeGatewayFactory,
  readJson,
  removeDir,
  setupManager,
  silentLogger,
  tempDir,
} from './helpers.js';

/** @param {import('node:test').TestContext} t @param {Record<string, any>} [options] */
async function setup(t, options = {}) {
  return setupManager(t, options);
}

describe('manager init', () => {
  it('creates a default manager.json with no workspaces', async (t) => {
    const { managerFile, manager } = await setup(t);
    const data = readJson(managerFile);
    assert.deepEqual(data.workspaces, []);
    assert.deepEqual(data.listen, { host: '127.0.0.1', port: 8788 });
    assert.deepEqual(manager.getState().workspaces, []);
    assert.equal(manager.listen.port, 8788);
  });

  it('returns an empty default state before init()', async (t) => {
    const dir = tempDir('manager-uninit');
    t.after(() => removeDir(dir));
    const manager = createManager({
      managerFile: join(dir, 'manager.json'),
      managerDataDir: join(dir, 'data'),
      logger: silentLogger(),
      gatewayFactory: createFakeGatewayFactory(),
    });
    const state = manager.getState();
    assert.equal(state.workspaces.length, 0);
    assert.equal(state.manager.workspaceCount, 0);
    assert.equal(typeof state.manager.pid, 'number');
    await manager.stop();
  });

  it('exposes the configured listen address and workspace metadata', async (t) => {
    const { dir, manager } = await setup(t);
    const entry = await addWorkspace(manager, dir, { name: 'Demo', autoStart: true });
    assert.equal(entry.state, 'stopped');
    assert.equal(entry.error, null);
    assert.equal(entry.bridge, 'absent');
    assert.equal(entry.workspaceCwd, entry.workspaceDir);
    // §10.1: channels selected at creation are not enabled until connected.
    assert.deepEqual(entry.channels, []);
    const state = manager.getState();
    assert.equal(state.manager.workspaceCount, 1);
    assert.equal(state.manager.listen.port, 8788);
    assert.equal(state.workspaces[0].configFile, entry.configFile);
    assert.equal(typeof state.manager.pid, 'number');
  });
});

describe('manager lifecycle', () => {
  it('start() starts only autoStart workspaces', async (t) => {
    const { dir, manager, factory } = await setup(t);
    const auto = await addWorkspace(manager, dir, { name: 'Auto', autoStart: true });
    const manual = await addWorkspace(manager, dir, { name: 'Manual', autoStart: false });
    await manager.start();
    assert.equal(factory.gateways.length, 1);
    const state = manager.getState();
    assert.equal(state.workspaces.find((workspace) => workspace.id === auto.id).state, 'running');
    assert.equal(state.workspaces.find((workspace) => workspace.id === manual.id).state, 'stopped');
  });

  it('start() is idempotent', async (t) => {
    const { dir, manager, factory } = await setup(t);
    await addWorkspace(manager, dir, { name: 'Auto', autoStart: true });
    await manager.start();
    await manager.start();
    assert.equal(factory.gateways.length, 1);
    assert.equal(factory.gateways[0].startCalls, 1);
  });

  it('startWorkspace() brings a workspace up and refreshes state', async (t) => {
    const { dir, manager, factory } = await setup(t, { factoryOptions: { sessions: 3, httpPort: 45678 } });
    const entry = await addWorkspace(manager, dir, { channels: ['feishu', 'weixin'] });
    await manager.saveWorkspaceConfig(entry.id, {
      channels: {
        feishu: { enabled: true, appId: 'cli_0123456789abcdef', appSecret: 's' },
        weixin: { enabled: true },
      },
    });
    const summary = await manager.startWorkspace(entry.id);

    assert.equal(summary.state, 'running');
    assert.equal(summary.bridge, 'ready');
    assert.equal(summary.sessions, 3);
    assert.deepEqual(summary.channels.map((channel) => channel.id), ['feishu', 'weixin']);
    assert.equal(summary.channels[0].health, 'connected');
    assert.equal(summary.http.port, 45678);
    assert.equal(summary.http.publicBaseUrl, 'http://127.0.0.1:45678');
    assert.equal(factory.gateways.length, 1);
    assert.equal(factory.gateways[0].state, 'running');
  });

  it('startWorkspace() is idempotent while running', async (t) => {
    const { dir, manager, factory } = await setup(t);
    const entry = await addWorkspace(manager, dir);
    await manager.startWorkspace(entry.id);
    const second = await manager.startWorkspace(entry.id);
    assert.equal(second.state, 'running');
    assert.equal(factory.gateways.length, 1);
    assert.equal(factory.gateways[0].startCalls, 1);
  });

  it('isolates a failing workspace during start()', async (t) => {
    const factory = createFakeGatewayFactory({
      failStart: (config) => config.dsh.cwd.includes('bad'),
      failMessage: 'boom token=supersecret',
    });
    const { dir, manager } = await setup(t, { factory });
    const good = await addWorkspace(manager, dir, { name: 'Good', workspaceDir: join(dir, 'good'), autoStart: true });
    const bad = await addWorkspace(manager, dir, { name: 'Bad', workspaceDir: join(dir, 'bad'), autoStart: true });
    await manager.start();
    // manager.start() must not reject because of one broken workspace.
    const state = manager.getState();
    const goodState = state.workspaces.find((workspace) => workspace.id === good.id);
    const badState = state.workspaces.find((workspace) => workspace.id === bad.id);
    assert.equal(goodState.state, 'running');
    assert.equal(badState.state, 'error');
    assert.match(badState.error, /boom/);
    assert.equal(badState.error.includes('supersecret'), false);
    assert.match(badState.error, /token=\*\*\*/);
    // The surviving gateway is untouched.
    assert.equal(factory.gateways.filter((gateway) => gateway.state === 'running').length, 1);
  });

  it('marks a config error as state=error and can retry after a fix', async (t) => {
    const { dir, manager } = await setup(t);
    const entry = await addWorkspace(manager, dir);
    const savedConfig = readFileSync(entry.configFile, 'utf8');
    rmSync(entry.configFile);
    await assert.rejects(manager.startWorkspace(entry.id), /config not found/);
    assert.equal(manager.getState().workspaces[0].state, 'error');
    assert.match(manager.getState().workspaces[0].error, /config not found/);
    // Restoring a valid config allows a retry.
    writeFileSync(entry.configFile, savedConfig);
    const summary = await manager.startWorkspace(entry.id);
    assert.equal(summary.state, 'running');
  });

  it('stopWorkspace() stops a running gateway and is idempotent', async (t) => {
    const { dir, manager, factory } = await setup(t);
    const entry = await addWorkspace(manager, dir);
    await manager.startWorkspace(entry.id);
    const stopped = await manager.stopWorkspace(entry.id);
    assert.equal(stopped.state, 'stopped');
    assert.equal(stopped.bridge, 'absent');
    assert.equal(factory.gateways[0].state, 'stopped');
    const again = await manager.stopWorkspace(entry.id);
    assert.equal(again.state, 'stopped');
    assert.equal(factory.gateways[0].stopCalls, 1);
  });

  it('restartWorkspace() replaces the gateway instance', async (t) => {
    const { dir, manager, factory } = await setup(t);
    const entry = await addWorkspace(manager, dir);
    await manager.startWorkspace(entry.id);
    const summary = await manager.restartWorkspace(entry.id);
    assert.equal(summary.state, 'running');
    assert.equal(factory.gateways.length, 2);
    assert.equal(factory.gateways[0].state, 'stopped');
    assert.equal(factory.gateways[1].state, 'running');
    assert.equal(factory.gateways[0].stopCalls, 1);
  });

  it('restartWorkspace() starts a workspace that was stopped', async (t) => {
    const { dir, manager, factory } = await setup(t);
    const entry = await addWorkspace(manager, dir);
    const summary = await manager.restartWorkspace(entry.id);
    assert.equal(summary.state, 'running');
    assert.equal(factory.gateways.length, 1);
  });

  it('manager.stop() stops every workspace and is idempotent', async (t) => {
    const { dir, manager, factory } = await setup(t);
    const first = await addWorkspace(manager, dir, { name: 'One' });
    const second = await addWorkspace(manager, dir, { name: 'Two' });
    await manager.startWorkspace(first.id);
    await manager.startWorkspace(second.id);
    await manager.stop();
    assert.ok(manager.getState().workspaces.every((workspace) => workspace.state === 'stopped'));
    assert.ok(factory.gateways.every((gateway) => gateway.state === 'stopped'));
    await manager.stop();
    assert.ok(manager.getState().workspaces.every((workspace) => workspace.state === 'stopped'));
  });

  it('serializes concurrent startWorkspace() calls', async (t) => {
    const factory = createFakeGatewayFactory({ startDelayMs: 20 });
    const { dir, manager } = await setup(t, { factory });
    const entry = await addWorkspace(manager, dir);
    const [a, b] = await Promise.all([
      manager.startWorkspace(entry.id),
      manager.startWorkspace(entry.id),
    ]);
    assert.equal(a.state, 'running');
    assert.equal(b.state, 'running');
    assert.equal(factory.gateways.length, 1);
  });

  it('starts a newly added autoStart workspace when the manager is already running', async (t) => {
    const { dir, manager, factory } = await setup(t);
    await manager.start();
    const auto = await addWorkspace(manager, dir, { name: 'Late Auto', autoStart: true });
    const manual = await addWorkspace(manager, dir, { name: 'Late Manual', autoStart: false });
    assert.equal(manager.getState().workspaces.find((workspace) => workspace.id === auto.id).state, 'running');
    assert.equal(manager.getState().workspaces.find((workspace) => workspace.id === manual.id).state, 'stopped');
    assert.equal(factory.gateways.length, 1);
  });

  it('removeWorkspace() stops the gateway before removing the entry', async (t) => {
    const { dir, manager, factory } = await setup(t);
    const entry = await addWorkspace(manager, dir);
    await manager.startWorkspace(entry.id);
    const result = await manager.removeWorkspace(entry.id);
    assert.equal(result.ok, true);
    assert.equal(factory.gateways[0].state, 'stopped');
    assert.deepEqual(manager.getState().workspaces, []);
    assert.equal(existsSync(entry.configFile), true);
  });

  it('rejects operations on unknown workspaces with coded errors', async (t) => {
    const { manager } = await setup(t);
    for (const operation of [
      () => manager.startWorkspace('missing'),
      () => manager.stopWorkspace('missing'),
      () => manager.restartWorkspace('missing'),
      () => manager.removeWorkspace('missing'),
      () => manager.saveWorkspaceConfig('missing', {}),
    ]) {
      await assert.rejects(operation(), (error) => {
        assert.equal(error.code, 'WORKSPACE_NOT_FOUND');
        return true;
      });
    }
    assert.throws(() => manager.getWorkspaceConfig('missing'), /workspace not found/);
    assert.throws(() => manager.listPairing('missing'), /workspace not found/);
    assert.throws(() => manager.getLogs('missing'), /workspace not found/);
  });

  it('keeps running when a status() refresh fails', async (t) => {
    const factory = createFakeGatewayFactory({ failStatus: () => true });
    const { dir, manager } = await setup(t, { factory });
    const entry = await addWorkspace(manager, dir);
    await manager.saveWorkspaceConfig(entry.id, { channels: { weixin: { enabled: true } } });
    const summary = await manager.startWorkspace(entry.id);
    assert.equal(summary.state, 'running');
    assert.equal(summary.channels[0].health, '');
  });
});

describe('manager config editing', () => {
  it('saveWorkspaceConfig() while stopped does not create a gateway', async (t) => {
    const { dir, manager, factory } = await setup(t);
    const entry = await addWorkspace(manager, dir, { channels: [] });
    const saved = await manager.saveWorkspaceConfig(entry.id, {
      channels: { feishu: { enabled: true, appId: 'cli_0123456789abcdef', appSecret: 'sec' } },
    });
    assert.equal(saved.channels.feishu.enabled, true);
    assert.equal(saved.channels.feishu.appSecret, '***');
    assert.equal(factory.gateways.length, 0);
    assert.equal(manager.getWorkspaceConfig(entry.id).channels.feishu.appId, 'cli_0123456789abcdef');
    // State reflects the newly enabled channel (still stopped).
    const state = manager.getState();
    assert.deepEqual(state.workspaces[0].channels.map((channel) => channel.id), ['feishu']);
    assert.equal(state.workspaces[0].state, 'stopped');
  });

  it('saveWorkspaceConfig() restarts a running workspace with the new config', async (t) => {
    const { dir, manager, factory } = await setup(t);
    const entry = await addWorkspace(manager, dir, { channels: [] });
    await manager.startWorkspace(entry.id);
    assert.equal(factory.gateways.length, 1);
    const saved = await manager.saveWorkspaceConfig(entry.id, {
      channels: { weixin: { enabled: true } },
    });
    assert.equal(saved.channels.weixin.enabled, true);
    assert.equal(factory.gateways.length, 2);
    assert.equal(factory.gateways[0].state, 'stopped');
    assert.equal(factory.gateways[1].state, 'running');
    const state = manager.getState();
    assert.deepEqual(state.workspaces[0].channels.map((channel) => channel.id), ['weixin']);
  });

  it('saveWorkspaceConfig() with invalid config leaves the running gateway alone', async (t) => {
    const { dir, manager, factory } = await setup(t);
    const entry = await addWorkspace(manager, dir);
    await manager.startWorkspace(entry.id);
    await assert.rejects(
      manager.saveWorkspaceConfig(entry.id, { gateway: { http: { port: -1 } } }),
      (error) => {
        assert.equal(error.code, 'INVALID_CONFIG');
        return true;
      },
    );
    assert.equal(factory.gateways.length, 1);
    assert.equal(factory.gateways[0].state, 'running');
    assert.equal(manager.getState().workspaces[0].state, 'running');
  });

  it('preserves "***" secrets across a save + restart', async (t) => {
    const { dir, manager, factory } = await setup(t);
    const entry = await addWorkspace(manager, dir, { channels: [] });
    await manager.saveWorkspaceConfig(entry.id, {
      channels: { feishu: { enabled: true, appId: 'cli_0123456789abcdef', appSecret: 'keep-me' } },
    });
    await manager.startWorkspace(entry.id);
    const saved = await manager.saveWorkspaceConfig(entry.id, {
      channels: { feishu: { appSecret: '***', appId: 'cli_0123456789abcdef' } },
    });
    assert.equal(saved.channels.feishu.appSecret, '***');
    assert.equal(readJson(entry.configFile).channels.feishu.appSecret, 'keep-me');
    assert.equal(factory.gateways.length, 2);
  });
});

describe('manager pairing', () => {
  it('lists nothing and refuses approval while the workspace is not running', async (t) => {
    const { dir, manager } = await setup(t);
    const entry = await addWorkspace(manager, dir);
    assert.deepEqual(manager.listPairing(entry.id), []);
    assert.deepEqual(manager.getState().workspaces[0].pendingPairings, []);
    await assert.rejects(manager.approvePairing(entry.id, '123456'), (error) => {
      assert.equal(error.code, 'WORKSPACE_NOT_RUNNING');
      assert.match(error.message, /workspace not running/);
      return true;
    });
  });

  it('lists pending pairings from the live gateway and approves them', async (t) => {
    const { dir, manager, factory } = await setup(t);
    const entry = await addWorkspace(manager, dir);
    await manager.startWorkspace(entry.id);
    const request = factory.gateways[0].pairing.request({ channel: 'feishu', senderId: 'ou_1', name: 'Owner' });

    const pending = manager.listPairing(entry.id);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].code, request.code);
    assert.equal(pending[0].channel, 'feishu');
    assert.equal(pending[0].senderId, 'ou_1');
    assert.equal(pending[0].name, 'Owner');
    assert.ok(pending[0].expiresAt > Date.now());
    assert.deepEqual(manager.getState().workspaces[0].pendingPairings, pending);

    const approved = await manager.approvePairing(entry.id, request.code);
    assert.deepEqual(approved, { ok: true, channel: 'feishu', senderId: 'ou_1' });
    assert.deepEqual(manager.listPairing(entry.id), []);
    await assert.rejects(manager.approvePairing(entry.id, request.code), /不存在|not found|expired/);
  });

  it('returns null for a pending pairing without a display name', async (t) => {
    const { dir, manager, factory } = await setup(t);
    const entry = await addWorkspace(manager, dir);
    await manager.startWorkspace(entry.id);
    factory.gateways[0].pairing.request({ channel: 'feishu', senderId: 'ou_2' });
    const pending = manager.listPairing(entry.id);
    assert.equal(pending[0].name, null);
  });
});

describe('manager log ring buffer', () => {
  it('captures redacted gateway log lines with scopes and levels', async (t) => {
    const { dir, manager, factory } = await setup(t);
    const entry = await addWorkspace(manager, dir);
    await manager.startWorkspace(entry.id);
    const gatewayLogger = factory.gateways[0].logger;
    gatewayLogger.info('hello %s', 'world');
    gatewayLogger.warn('payload', { appSecret: 's3cr3t', token: 'abc' });
    gatewayLogger.error('Authorization: Bearer abcdef');
    gatewayLogger.error('http://host/path?token=leaked&a=1');
    gatewayLogger.child('http').debug('debug detail');
    gatewayLogger.child('http').info('scoped line');

    const lines = manager.getLogs(entry.id);
    assert.equal(lines.length, 5); // debug is below the default info level
    assert.match(lines[0], /^\d{4}-\d{2}-\d{2}T.* INFO\s+hello world$/);
    assert.match(lines[1], /WARN\s+payload/);
    assert.match(lines[1], /\*\*\*/);
    assert.equal(lines[1].includes('s3cr3t'), false);
    assert.equal(lines[1].includes('"abc"'), false);
    assert.match(lines[2], /Bearer \*\*\*/);
    assert.equal(lines[2].includes('abcdef'), false);
    assert.match(lines[3], /token=\*\*\*/);
    assert.equal(lines[3].includes('leaked'), false);
    assert.match(lines[4], /INFO\s+\[http\] scoped line/);
  });

  it('keeps the most recent 500 lines and honours the requested count', async (t) => {
    const { dir, manager, factory } = await setup(t);
    const entry = await addWorkspace(manager, dir);
    await manager.startWorkspace(entry.id);
    const gatewayLogger = factory.gateways[0].logger;
    for (let index = 0; index < 600; index += 1) gatewayLogger.info('line %d', index);
    const all = manager.getLogs(entry.id, 500);
    assert.equal(all.length, 500);
    assert.match(all[0], /line 100$/);
    assert.match(all[499], /line 599$/);
    const ten = manager.getLogs(entry.id, 10);
    assert.equal(ten.length, 10);
    assert.match(ten[9], /line 599$/);
    // Unknown/invalid counts fall back to the default 200.
    assert.equal(manager.getLogs(entry.id, 'nope').length, 200);
    assert.equal(manager.getLogs(entry.id, 0).length, 200);
    assert.equal(manager.getLogs(entry.id, 10_000).length, 500);
  });

  it('keeps logs across a restart', async (t) => {
    const { dir, manager, factory } = await setup(t);
    const entry = await addWorkspace(manager, dir);
    await manager.startWorkspace(entry.id);
    factory.gateways[0].logger.info('before restart');
    await manager.restartWorkspace(entry.id);
    factory.gateways[1].logger.info('after restart');
    const lines = manager.getLogs(entry.id);
    assert.ok(lines.some((line) => line.includes('before restart')));
    assert.ok(lines.some((line) => line.includes('after restart')));
  });

  it('returns an empty list before the workspace ever starts', async (t) => {
    const { dir, manager } = await setup(t);
    const entry = await addWorkspace(manager, dir);
    assert.deepEqual(manager.getLogs(entry.id), []);
  });
});

describe('manager state shape', () => {
  it('is JSON-serializable and free of functions', async (t) => {
    const factory = createFakeGatewayFactory({
      health: { weixin: 'disconnected' },
      detail: { weixin: '未登录' },
      sessions: 2,
    });
    const { dir, manager } = await setup(t, { factory });
    const entry = await addWorkspace(manager, dir, { channels: ['feishu', 'weixin'], autoStart: true });
    await manager.saveWorkspaceConfig(entry.id, {
      channels: {
        feishu: { enabled: true, appId: 'cli_0123456789abcdef', appSecret: 's' },
        weixin: { enabled: true },
      },
    });
    await manager.start();
    const state = manager.getState();
    const text = JSON.stringify(state);
    const parsed = JSON.parse(text);
    assert.equal(parsed.workspaces.length, 1);
    const workspace = parsed.workspaces[0];
    assert.equal(workspace.id, entry.id);
    assert.equal(workspace.state, 'running');
    assert.equal(workspace.bridge, 'ready');
    assert.equal(workspace.sessions, 2);
    assert.equal(workspace.error, null);
    assert.deepEqual(workspace.channels, [
      { id: 'feishu', enabled: true, mode: 'ws', health: 'connected', detail: '' },
      { id: 'weixin', enabled: true, mode: 'ilink', health: 'disconnected', detail: '未登录' },
    ]);
    assert.equal(typeof workspace.http.port, 'number');
    assert.equal(typeof workspace.pendingPairings.length, 'number');
  });
});
