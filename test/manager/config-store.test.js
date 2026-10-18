import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  createConfigStore,
  createWorkspaceConfig,
  isValidWorkspaceId,
  isSecretPlaceholder,
  maskConfig,
  maskSecretValue,
  slugifyWorkspaceId,
} from '../../src/manager/config-store.js';
import { defaultConfig } from '../../src/core/config.js';
import { fileMode, readJson, removeDir, silentLogger, tempDir, writeJson } from './helpers.js';

/**
 * @param {import('node:test').TestContext} t
 * @param {{ dir?: string, store?: Record<string, any> }} [options]
 */
async function setupStore(t, options = {}) {
  const dir = options.dir ?? tempDir('manager-config');
  t.after(() => removeDir(dir));
  const managerFile = join(dir, 'manager.json');
  const managerDataDir = join(dir, 'manager-data');
  const store = createConfigStore({
    managerFile,
    managerDataDir,
    logger: silentLogger(),
    ...options.store,
  });
  await store.load();
  return { dir, managerFile, managerDataDir, store };
}

describe('workspace id helpers', () => {
  it('slugifies names into lowercase id-safe slugs', () => {
    assert.equal(slugifyWorkspaceId('DSH Workspace'), 'dsh-workspace');
    assert.equal(slugifyWorkspaceId('  --Hello__World!! '), 'hello-world');
    assert.equal(slugifyWorkspaceId('a'.repeat(80)).length, 40);
    assert.equal(slugifyWorkspaceId(''), 'workspace');
    assert.equal(slugifyWorkspaceId('微信工作区'), 'workspace');
  });

  it('validates ids strictly', () => {
    assert.equal(isValidWorkspaceId('dsh'), true);
    assert.equal(isValidWorkspaceId('a-b-2'), true);
    assert.equal(isValidWorkspaceId('2ws'), true);
    assert.equal(isValidWorkspaceId('Dsh'), false);
    assert.equal(isValidWorkspaceId('a--b'), false);
    assert.equal(isValidWorkspaceId('-a'), false);
    assert.equal(isValidWorkspaceId('a_b'), false);
    assert.equal(isValidWorkspaceId(''), false);
    assert.equal(isValidWorkspaceId('a'.repeat(65)), false);
    assert.equal(isValidWorkspaceId(42), false);
  });
});

describe('manager.json store', () => {
  it('creates a default manager file on first load (0600, empty workspaces)', async (t) => {
    const dir = tempDir('manager-default');
    t.after(() => removeDir(dir));
    const managerFile = join(dir, 'manager.json');
    const store = createConfigStore({ managerFile, managerDataDir: join(dir, 'data') });
    await store.load();
    assert.equal(existsSync(managerFile), true);
    assert.equal(fileMode(managerFile), 0o600);
    assert.deepEqual(readJson(managerFile), {
      version: 1,
      listen: { host: '127.0.0.1', port: 8788 },
      workspaces: [],
    });
    assert.deepEqual(store.listWorkspaces(), []);
  });

  it('defaults managerFile to <managerDataDir>/manager.json', () => {
    const dir = tempDir('manager-default-path');
    try {
      const store = createConfigStore({ managerDataDir: dir });
      assert.equal(store.managerFile, join(dir, 'manager.json'));
      assert.equal(store.managerDataDir, dir);
    } finally {
      removeDir(dir);
    }
  });

  it('loads an existing manager.json and derives a default configFile', async (t) => {
    const dir = tempDir('manager-load');
    t.after(() => removeDir(dir));
    const managerFile = join(dir, 'manager.json');
    writeJson(managerFile, {
      version: 1,
      listen: { host: '127.0.0.1', port: 9999 },
      workspaces: [{ id: 'dsh', name: 'DSH', workspaceDir: join(dir, 'ws'), autoStart: true }],
    });
    const store = createConfigStore({ managerFile, managerDataDir: join(dir, 'data') });
    await store.load();
    assert.deepEqual(store.getListen(), { host: '127.0.0.1', port: 9999 });
    const entry = store.getWorkspace('dsh');
    assert.equal(entry.name, 'DSH');
    assert.equal(entry.autoStart, true);
    assert.equal(entry.configFile, join(dir, 'ws', '.dsh-im-manager', 'config.json'));
  });

  it('rejects duplicate workspace ids in manager.json', async (t) => {
    const dir = tempDir('manager-dupe');
    t.after(() => removeDir(dir));
    const managerFile = join(dir, 'manager.json');
    writeJson(managerFile, {
      version: 1,
      workspaces: [
        { id: 'a', name: 'A', workspaceDir: join(dir, 'a') },
        { id: 'a', name: 'A2', workspaceDir: join(dir, 'b') },
      ],
    });
    const store = createConfigStore({ managerFile, managerDataDir: join(dir, 'data') });
    await assert.rejects(store.load(), /duplicate workspace id/);
  });

  it('rejects corrupt manager.json with a clear message', async (t) => {
    const dir = tempDir('manager-corrupt');
    t.after(() => removeDir(dir));
    const managerFile = join(dir, 'manager.json');
    writeFileSync(managerFile, '{not json');
    const store = createConfigStore({ managerFile, managerDataDir: join(dir, 'data') });
    await assert.rejects(store.load(), /not valid JSON/);
  });

  it('persists listen changes atomically', async (t) => {
    const { dir, managerFile, store } = await setupStore(t);
    const listen = await store.setListen({ port: 9000 });
    assert.deepEqual(listen, { host: '127.0.0.1', port: 9000 });
    assert.equal(readJson(managerFile).listen.port, 9000);
    assert.equal(fileMode(managerFile), 0o600);
    const reloaded = createConfigStore({ managerFile, managerDataDir: join(dir, 'manager-data') });
    await reloaded.load();
    assert.deepEqual(reloaded.getListen(), { host: '127.0.0.1', port: 9000 });
  });
});

describe('workspace CRUD', () => {
  it('adds a workspace with a slug id and a 0600 gateway config', async (t) => {
    const { dir, store } = await setupStore(t);
    const workspaceDir = join(dir, 'workspaces', 'demo');
    const entry = await store.addWorkspace({ name: 'Demo Workspace', workspaceDir, channels: ['feishu', 'weixin'] });

    assert.equal(entry.id, 'demo-workspace');
    assert.equal(entry.workspaceDir, workspaceDir);
    assert.equal(entry.autoStart, false);
    assert.equal(entry.configFile, join(workspaceDir, '.dsh-im-manager', 'config.json'));
    assert.equal(existsSync(entry.configFile), true);
    assert.equal(fileMode(entry.configFile), 0o600);

    const config = readJson(entry.configFile);
    assert.equal(config.dsh.cwd, workspaceDir);
    assert.equal(config.gateway.stateDir, join(dir, 'manager-data', 'workspaces', 'demo-workspace', 'state'));
    assert.equal(config.gateway.http.port, 0);
    // Contract §10.1: creating a workspace never enables a channel.
    assert.equal(config.channels.feishu.enabled, false);
    assert.equal(config.channels.weixin.enabled, false);
    assert.equal(config.channels.dingtalk.enabled, false);
    assert.equal(config.channels.wecom.enabled, false);
    assert.deepEqual(store.listWorkspaces().map((item) => item.id), ['demo-workspace']);
  });

  it('de-duplicates slug ids with numeric suffixes', async (t) => {
    const { dir, store } = await setupStore(t);
    const first = await store.addWorkspace({ name: 'Same Name', workspaceDir: join(dir, 'a') });
    const second = await store.addWorkspace({ name: 'Same Name', workspaceDir: join(dir, 'b') });
    const third = await store.addWorkspace({ name: 'Same Name', workspaceDir: join(dir, 'c') });
    assert.equal(first.id, 'same-name');
    assert.equal(second.id, 'same-name-2');
    assert.equal(third.id, 'same-name-3');
  });

  it('accepts an explicit id but rejects duplicates and invalid ids', async (t) => {
    const { dir, store } = await setupStore(t);
    const entry = await store.addWorkspace({ id: 'my-dsh', name: 'My DSH', workspaceDir: join(dir, 'a') });
    assert.equal(entry.id, 'my-dsh');
    await assert.rejects(
      store.addWorkspace({ id: 'my-dsh', name: 'Dupe', workspaceDir: join(dir, 'b') }),
      /already exists/,
    );
    await assert.rejects(
      store.addWorkspace({ id: 'Bad_Id', name: 'Bad', workspaceDir: join(dir, 'c') }),
      /invalid workspace id/,
    );
  });

  it('validates name, workspaceDir and channel selection', async (t) => {
    const { dir, store } = await setupStore(t);
    await assert.rejects(store.addWorkspace({ name: '', workspaceDir: join(dir, 'a') }), /name is required/);
    await assert.rejects(store.addWorkspace({ name: 'A', workspaceDir: '' }), /workspaceDir is required/);
    await assert.rejects(
      store.addWorkspace({ name: 'A', workspaceDir: join(dir, 'a'), channels: ['telegram'] }),
      /unknown channel/,
    );
    await assert.rejects(
      store.addWorkspace({ name: 'A', workspaceDir: join(dir, 'a'), channels: 'feishu' }),
      /channels must be an array/,
    );
  });

  it('can inherit a dsh.provider from store options', async (t) => {
    const dir = tempDir('manager-provider');
    t.after(() => removeDir(dir));
    const store = createConfigStore({
      managerFile: join(dir, 'manager.json'),
      managerDataDir: join(dir, 'data'),
      provider: 'custom-provider',
    });
    await store.load();
    const entry = await store.addWorkspace({ name: 'P', workspaceDir: join(dir, 'p') });
    assert.equal(readJson(entry.configFile).dsh.provider, 'custom-provider');
  });

  it('updates name and autoStart and persists them', async (t) => {
    const { dir, managerFile, store } = await setupStore(t);
    const entry = await store.addWorkspace({ name: 'Old', workspaceDir: join(dir, 'a') });
    const updated = await store.updateWorkspace(entry.id, { name: 'New', autoStart: true });
    assert.equal(updated.name, 'New');
    assert.equal(updated.autoStart, true);
    const reloaded = createConfigStore({ managerFile, managerDataDir: join(dir, 'manager-data') });
    await reloaded.load();
    assert.deepEqual(reloaded.getWorkspace(entry.id), updated);
  });

  it('rejects invalid updates and unknown ids with coded errors', async (t) => {
    const { dir, store } = await setupStore(t);
    const entry = await store.addWorkspace({ name: 'A', workspaceDir: join(dir, 'a') });
    await assert.rejects(store.updateWorkspace(entry.id, { name: '   ' }), /non-empty/);
    await assert.rejects(store.updateWorkspace(entry.id, { autoStart: 'yes' }), /boolean/);
    await assert.rejects(store.updateWorkspace('missing', { name: 'x' }), (error) => {
      assert.equal(error.code, 'WORKSPACE_NOT_FOUND');
      assert.match(error.message, /workspace not found: missing/);
      return true;
    });
  });

  it('removes a workspace from manager.json but keeps its files', async (t) => {
    const { dir, store } = await setupStore(t);
    const entry = await store.addWorkspace({ name: 'Gone', workspaceDir: join(dir, 'gone') });
    const removed = await store.removeWorkspace(entry.id);
    assert.equal(removed.id, entry.id);
    assert.equal(store.getWorkspace(entry.id), undefined);
    assert.equal(existsSync(entry.configFile), true);
    await assert.rejects(store.removeWorkspace(entry.id), /workspace not found/);
  });
});

describe('secret masking', () => {
  it('masks credential values but preserves placeholders and empty strings', () => {
    assert.equal(maskSecretValue('topsecret'), '***');
    assert.equal(maskSecretValue(''), '');
    assert.equal(maskSecretValue(undefined), undefined);
    assert.equal(maskSecretValue('env:FEISHU_APP_SECRET'), 'env:FEISHU_APP_SECRET');
    assert.equal(maskSecretValue('${FEISHU_APP_SECRET}'), '${FEISHU_APP_SECRET}');
    assert.equal(isSecretPlaceholder('env:TOKEN'), true);
    assert.equal(isSecretPlaceholder('prefix-${TOKEN}'), true);
    assert.equal(isSecretPlaceholder('literal-secret'), false);
  });

  it('masks every contract §4 field and dsh.env credential names', () => {
    const config = {
      dsh: {
        cwd: '/tmp/ws',
        env: {
          FEISHU_APP_SECRET: 'env-secret',
          MY_API_KEY: 'key-secret',
          DSH_HOME: '/tmp/home',
          SAFE_TOKEN: '${SAFE_TOKEN}',
        },
      },
      channels: {
        feishu: { enabled: true, appId: 'cli_0123456789abcdef', appSecret: 's1', encryptKey: 'e1', verificationToken: 'v1' },
        dingtalk: { clientId: 'id', clientSecret: 's2' },
        wecom: { secret: 's3', token: 't3', encodingAESKey: 'k3', password: 'p3', apiKey: 'a3' },
        weixin: { enabled: false, credentialsFile: '/tmp/cred.json' },
      },
    };
    const masked = maskConfig(config);
    assert.equal(masked.channels.feishu.appId, 'cli_0123456789abcdef');
    assert.equal(masked.channels.feishu.appSecret, '***');
    assert.equal(masked.channels.feishu.encryptKey, '***');
    assert.equal(masked.channels.feishu.verificationToken, '***');
    assert.equal(masked.channels.dingtalk.clientSecret, '***');
    assert.equal(masked.channels.wecom.secret, '***');
    assert.equal(masked.channels.wecom.token, '***');
    assert.equal(masked.channels.wecom.encodingAESKey, '***');
    assert.equal(masked.channels.wecom.password, '***');
    assert.equal(masked.channels.wecom.apiKey, '***');
    assert.equal(masked.channels.weixin.credentialsFile, '/tmp/cred.json');
    assert.equal(masked.dsh.env.FEISHU_APP_SECRET, '***');
    assert.equal(masked.dsh.env.MY_API_KEY, '***');
    assert.equal(masked.dsh.env.DSH_HOME, '/tmp/home');
    assert.equal(masked.dsh.env.SAFE_TOKEN, '${SAFE_TOKEN}');
    // The input object is not mutated.
    assert.equal(config.channels.feishu.appSecret, 's1');
  });

  it('getWorkspaceConfig returns a masked, structurally complete config', async (t) => {
    const { dir, store } = await setupStore(t);
    const entry = await store.addWorkspace({ name: 'Masked', workspaceDir: join(dir, 'masked'), channels: ['feishu'] });
    await store.saveWorkspaceConfig(entry.id, {
      channels: { feishu: { enabled: true, appId: 'cli_0123456789abcdef', appSecret: 'feishu-secret' } },
    });
    const masked = store.getWorkspaceConfig(entry.id);
    assert.equal(masked.channels.feishu.appSecret, '***');
    assert.equal(masked.channels.feishu.appId, 'cli_0123456789abcdef');
    assert.equal(masked.gateway.http.port, 0);
    assert.equal(masked.channels.dingtalk.enabled, false);
    // Secret is still on disk in clear text (only the API surface is masked).
    assert.equal(readJson(entry.configFile).channels.feishu.appSecret, 'feishu-secret');
  });
});

describe('saveWorkspaceConfig', () => {
  it('writes merged config atomically with 0600 and returns masked values', async (t) => {
    const { dir, store } = await setupStore(t);
    const entry = await store.addWorkspace({ name: 'Save', workspaceDir: join(dir, 'save'), channels: [] });
    const saved = await store.saveWorkspaceConfig(entry.id, {
      dsh: { model: 'deepseek-reasoner' },
      channels: { feishu: { enabled: true, appId: 'cli_0123456789abcdef', appSecret: 'sec' } },
    });
    assert.equal(saved.dsh.model, 'deepseek-reasoner');
    assert.equal(saved.channels.feishu.appSecret, '***');
    const config = readJson(entry.configFile);
    assert.equal(config.dsh.model, 'deepseek-reasoner');
    assert.equal(config.channels.feishu.appId, 'cli_0123456789abcdef');
    assert.equal(config.channels.feishu.appSecret, 'sec');
    assert.equal(config.channels.dingtalk.enabled, false);
    assert.equal(fileMode(entry.configFile), 0o600);
  });

  it('keeps the previous value for "***" placeholders', async (t) => {
    const { dir, store } = await setupStore(t);
    const entry = await store.addWorkspace({ name: 'Placeholder', workspaceDir: join(dir, 'ph') });
    await store.saveWorkspaceConfig(entry.id, {
      channels: { feishu: { enabled: true, appId: 'cli_0123456789abcdef', appSecret: 'original-secret' } },
    });
    const saved = await store.saveWorkspaceConfig(entry.id, {
      channels: { feishu: { appId: 'cli_0123456789abcdef', appSecret: '***', verificationToken: '***' } },
    });
    assert.equal(saved.channels.feishu.appSecret, '***');
    assert.equal(readJson(entry.configFile).channels.feishu.appSecret, 'original-secret');
    // No previous value: placeholder becomes empty, never the literal "***".
    assert.equal(readJson(entry.configFile).channels.feishu.verificationToken, '');
  });

  it('leaves env: / ${} placeholders untouched', async (t) => {
    const { dir, store } = await setupStore(t);
    const entry = await store.addWorkspace({ name: 'Env', workspaceDir: join(dir, 'env') });
    await store.saveWorkspaceConfig(entry.id, {
      channels: {
        feishu: {
          enabled: true,
          appId: 'cli_0123456789abcdef',
          appSecret: '${FEISHU_APP_SECRET}',
          verificationToken: 'env:FEISHU_VERIFICATION_TOKEN',
        },
      },
    });
    const masked = store.getWorkspaceConfig(entry.id);
    assert.equal(masked.channels.feishu.appSecret, '${FEISHU_APP_SECRET}');
    assert.equal(masked.channels.feishu.verificationToken, 'env:FEISHU_VERIFICATION_TOKEN');
    assert.equal(readJson(entry.configFile).channels.feishu.appSecret, '${FEISHU_APP_SECRET}');
  });

  it('rejects invalid core config and does not touch the file', async (t) => {
    const { dir, store } = await setupStore(t);
    const entry = await store.addWorkspace({ name: 'Invalid', workspaceDir: join(dir, 'invalid') });
    const before = readFileSync(entry.configFile, 'utf8');
    await assert.rejects(
      store.saveWorkspaceConfig(entry.id, { gateway: { http: { port: 99999 } } }),
      (error) => {
        assert.equal(error.code, 'INVALID_CONFIG');
        assert.match(error.message, /http\.port/);
        return true;
      },
    );
    await assert.rejects(store.saveWorkspaceConfig(entry.id, { channels: { telegram: { enabled: true } } }), /unknown channel/);
    assert.equal(readFileSync(entry.configFile, 'utf8'), before);
  });

  it('runs the enabled channel adapter validateConfig()', async (t) => {
    const { dir, store } = await setupStore(t);
    const entry = await store.addWorkspace({ name: 'Adapter', workspaceDir: join(dir, 'adapter'), channels: [] });
    // Enabling feishu without credentials is rejected by the adapter.
    await assert.rejects(
      store.saveWorkspaceConfig(entry.id, { channels: { feishu: { enabled: true } } }),
      /channels\.feishu/,
    );
    // A malformed appId is rejected too.
    await assert.rejects(
      store.saveWorkspaceConfig(entry.id, {
        channels: { feishu: { enabled: true, appId: 'not-an-app-id', appSecret: 's' } },
      }),
      /invalid appId/,
    );
    // A valid configuration passes.
    const saved = await store.saveWorkspaceConfig(entry.id, {
      channels: { feishu: { enabled: true, appId: 'cli_0123456789abcdef', appSecret: 's' } },
    });
    assert.equal(saved.channels.feishu.enabled, true);
  });

  it('resolves env references for adapter validation but keeps them in the file', async (t) => {
    const { dir, store } = await setupStore(t);
    const entry = await store.addWorkspace({ name: 'EnvValidate', workspaceDir: join(dir, 'env-validate') });
    const previousAppId = process.env.FEISHU_APP_ID;
    try {
      process.env.FEISHU_APP_ID = 'cli_0123456789abcdef';
      await store.saveWorkspaceConfig(entry.id, {
        channels: {
          feishu: {
            enabled: true,
            appId: 'env:FEISHU_APP_ID',
            appSecret: '${FEISHU_APP_SECRET}',
          },
        },
      });
      const masked = store.getWorkspaceConfig(entry.id);
      assert.equal(masked.channels.feishu.appId, 'env:FEISHU_APP_ID');
      assert.equal(masked.channels.feishu.appSecret, '${FEISHU_APP_SECRET}');
      assert.equal(readJson(entry.configFile).channels.feishu.appId, 'env:FEISHU_APP_ID');
    } finally {
      if (previousAppId === undefined) delete process.env.FEISHU_APP_ID;
      else process.env.FEISHU_APP_ID = previousAppId;
    }
  });

  it('rejects saving config for an unknown workspace', async (t) => {
    const { store } = await setupStore(t);
    await assert.rejects(store.saveWorkspaceConfig('missing', {}), /workspace not found/);
    assert.throws(() => store.getWorkspaceConfig('missing'), /workspace not found/);
  });

  it('createWorkspaceConfig() disables every channel when none is selected', () => {
    const config = createWorkspaceConfig({
      workspaceDir: '/tmp/ws',
      stateDir: '/tmp/state',
      channels: [],
    });
    assert.deepEqual(
      Object.entries(config.channels).filter(([, channel]) => channel.enabled === true).map(([id]) => id),
      [],
    );
    assert.equal(config.dsh.cwd, '/tmp/ws');
    assert.equal(config.gateway.stateDir, '/tmp/state');
    assert.equal(config.gateway.http.port, 0);
    // Sanity: the generated config is structurally valid.
    assert.equal(typeof defaultConfig().gateway.stateDir, 'string');
  });

  it('adds a workspace even when the target directory does not exist yet', async (t) => {
    const { dir, store } = await setupStore(t);
    const workspaceDir = join(dir, 'nested', 'new', 'workspace');
    assert.equal(existsSync(workspaceDir), false);
    const entry = await store.addWorkspace({ name: 'Nested', workspaceDir });
    assert.equal(existsSync(workspaceDir), true);
    assert.equal(existsSync(entry.configFile), true);
  });

  it('keeps manager.json permissions at 0600 across writes and leaves no temp files', async (t) => {
    const { dir, managerFile, store } = await setupStore(t);
    const entry = await store.addWorkspace({ name: 'Perms', workspaceDir: join(dir, 'perms') });
    await store.updateWorkspace(entry.id, { autoStart: true });
    assert.equal(fileMode(managerFile), 0o600);
    assert.equal(statSync(managerFile).isFile(), true);
    assert.equal(readJson(managerFile).workspaces.length, 1);
    assert.equal(readdirSync(dir).some((name) => name.endsWith('.tmp')), false);
  });
});
