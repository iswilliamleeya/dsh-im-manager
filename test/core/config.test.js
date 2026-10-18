import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  defaultConfig,
  loadConfig,
  resolveAccess,
  resolveConfigPath,
  validate,
  enabledChannels,
} from '../../src/core/config.js';
import { tempDir, removeDir } from './helpers.js';

describe('loadConfig', () => {
  it('applies defaults and resolves env: and ${} interpolation', () => {
    const dir = tempDir();
    try {
      const file = join(dir, 'config.json');
      writeFileSync(file, JSON.stringify({
        dsh: { command: 'env:MY_DSH_BIN', model: '${MY_MODEL}' },
        gateway: { stateDir: '~/state' },
        channels: { feishu: { enabled: true, appId: 'env:FEISHU_APP_ID', appSecret: '${FEISHU_SECRET}' } },
      }));
      const { config, warnings } = loadConfig({
        configPath: file,
        env: { MY_DSH_BIN: '/usr/local/bin/dsh', MY_MODEL: 'deepseek-chat', FEISHU_APP_ID: 'cli_x', FEISHU_SECRET: 'sec' },
      });
      assert.equal(config.dsh.command, '/usr/local/bin/dsh');
      assert.equal(config.dsh.model, 'deepseek-chat');
      assert.equal(config.channels.feishu.appId, 'cli_x');
      assert.equal(config.channels.feishu.appSecret, 'sec');
      assert.equal(config.channels.feishu.mode, 'ws');
      assert.equal(config.dsh.args[0], '--profile');
      assert.deepEqual(warnings, []);
      assert.ok(config.gateway.stateDir.endsWith('/state'));
      assert.equal(enabledChannels(config).length, 1);
    } finally {
      removeDir(dir);
    }
  });

  it('reports missing env variables as warnings instead of crashing', () => {
    const dir = tempDir();
    try {
      const file = join(dir, 'config.json');
      writeFileSync(file, JSON.stringify({ dsh: { command: 'env:MISSING_BIN' }, channels: { weixin: { enabled: true, credentialsFile: '${ALSO_MISSING}' } } }));
      const { config, warnings } = loadConfig({ configPath: file, env: {}, skipValidation: true });
      assert.equal(config.dsh.command, '');
      assert.equal(warnings.length, 2);
      assert.ok(warnings[0].includes('MISSING_BIN'));
    } finally {
      removeDir(dir);
    }
  });

  it('rejects unknown channels and invalid policies', () => {
    const config = defaultConfig();
    config.channels.telegram = { enabled: false };
    assert.throws(() => validate(config), /unknown channel/);
    const second = defaultConfig();
    second.gateway.access.dmPolicy = 'everyone';
    assert.throws(() => validate(second), /dmPolicy/);
  });

  it('resolves config path precedence', () => {
    const explicit = resolveConfigPath({ configPath: '/tmp/a.json', env: {} });
    assert.equal(explicit, '/tmp/a.json');
    const fromEnv = resolveConfigPath({ env: { DSH_IM_MANAGER_CONFIG: '/tmp/b.json' } });
    assert.equal(fromEnv, '/tmp/b.json');
  });

  it('prefers the workspace-local config over the machine-wide one', () => {
    const dir = tempDir();
    try {
      const workspace = join(dir, 'workspace');
      const localConfig = join(workspace, '.dsh-im-manager', 'config.json');
      const globalConfig = join(dir, 'home', 'im-manager', 'config.json');
      mkdirSync(join(workspace, '.dsh-im-manager'), { recursive: true });
      mkdirSync(join(dir, 'home', 'im-manager'), { recursive: true });
      writeFileSync(localConfig, '{}');
      writeFileSync(globalConfig, '{}');
      const previous = process.cwd();
      process.chdir(workspace);
      try {
        assert.equal(
          resolveConfigPath({ env: { DSH_HOME: join(dir, 'home') } }),
          join(process.cwd(), '.dsh-im-manager', 'config.json'),
          'cd <workspace> must resolve that workspace config for pair/doctor',
        );
      } finally {
        process.chdir(previous);
      }
    } finally {
      removeDir(dir);
    }
  });

  it('throws when no config exists and allowMissingConfig is false', () => {
    const dir = tempDir();
    try {
      const previous = process.cwd();
      process.chdir(dir);
      try {
        assert.throws(
          () => loadConfig({ env: { DSH_HOME: join(dir, '.dsh') } }),
          /no config file found/,
        );
      } finally {
        process.chdir(previous);
      }
    } finally {
      removeDir(dir);
    }
  });
});

describe('resolveAccess', () => {
  it('unions allowlists and lets channel group settings win', () => {
    const config = defaultConfig();
    config.gateway.access.allowFrom = ['global-user'];
    config.gateway.access.groups = { enabled: false, requireMention: true, allowFrom: [] };
    config.channels.feishu.allowFrom = ['channel-user'];
    config.channels.feishu.groups = { enabled: true, requireMention: false };
    const access = resolveAccess(config, 'feishu');
    assert.deepEqual(access.allowFrom.sort(), ['channel-user', 'global-user']);
    assert.equal(access.groups.enabled, true);
    assert.equal(access.groups.requireMention, false);
  });
});

describe('defaultConfig', () => {
  it('is a fresh object each call', () => {
    const first = defaultConfig();
    first.channels.feishu.enabled = true;
    assert.equal(defaultConfig().channels.feishu.enabled, false);
  });
});
