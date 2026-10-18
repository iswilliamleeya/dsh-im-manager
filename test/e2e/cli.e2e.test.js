/**
 * End-to-end CLI checks for the thin operator surface: `doctor` / `status`
 * exit codes, real config loading (including `env:` interpolation), and
 * workspace-local pairing resolution.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  PACKAGE_ROOT,
  createRunDir,
} from './helpers.js';
import { createPairingStore } from '../../src/core/pairing.js';

const BIN = join(PACKAGE_ROOT, 'bin', 'dsh-im-manager.js');
const NODE = process.execPath;

/**
 * A fake `dsh` executable good enough for `doctor`: `--version` succeeds and
 * `--profile sdk --dump-config` advertises the SDK JSON-RPC plugin.
 */
function writeFakeDsh(runDir) {
  const file = join(runDir, 'fake-dsh-bin.sh');
  writeFileSync(
    file,
    [
      '#!/bin/sh',
      'case "$1" in',
      '  --version) echo "9.9.9-fake"; exit 0 ;;',
      'esac',
      'for arg in "$@"; do',
      '  if [ "$arg" = "--dump-config" ]; then',
      '    echo \'{"plugins":["dsh-sdk-jsonrpc-server"]}\'',
      '    exit 0',
      '  fi',
      'done',
      'exit 0',
      '',
    ].join('\n'),
    'utf8',
  );
  chmodSync(file, 0o755);
  return file;
}

function writeCliConfig(runDir, { envVars = true } = {}) {
  const stateDir = join(runDir, 'state');
  mkdirSync(stateDir, { recursive: true });
  const fakeDsh = writeFakeDsh(runDir);
  const config = {
    dsh: {
      command: fakeDsh,
      args: [],
      cwd: PACKAGE_ROOT,
      provider: 'deepseek-official',
      model: 'fake-model',
    },
    gateway: {
      stateDir,
      log: { level: 'silent' },
      http: { enabled: true, host: '127.0.0.1', port: 0, publicBaseUrl: '' },
      access: { dmPolicy: 'allowlist', allowFrom: ['user-1'] },
    },
    channels: {
      feishu: {
        enabled: true,
        mode: 'webhook',
        appId: 'env:E2E_CLI_APP_ID',
        appSecret: 'env:E2E_CLI_APP_SECRET',
        verificationToken: envVars ? 'env:E2E_CLI_TOKEN' : 'env:E2E_CLI_TOKEN_MISSING',
        webhookPath: '/webhook/feishu',
      },
    },
  };
  const file = join(runDir, 'config.json');
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return { file, stateDir, config };
}

function runCli(args, env = {}) {
  return spawnSync(NODE, [BIN, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      E2E_CLI_APP_ID: 'cli_0123456789abcdef',
      E2E_CLI_APP_SECRET: 'feishu_cli_app_secret',
      E2E_CLI_TOKEN: 'feishu_verification_token',
      ...env,
    },
  });
}

test('cli e2e: doctor exits 0 when config, env and dsh profile are valid', () => {
  const runDir = createRunDir('cli-doctor-ok');
  try {
    const { file } = writeCliConfig(runDir.dir);
    const result = runCli(['doctor', '--config', file]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /dsh\.profile\.sdk\s+SDK JSON-RPC profile is available/);
    assert.match(result.stdout, /channel\.feishu/);
    assert.match(result.stdout, /结果：通过/);
    assert.doesNotMatch(result.stdout, /config\.env/);
  } finally {
    runDir.cleanup();
  }
});

test('cli e2e: doctor reports missing env vars and exits 1', () => {
  const runDir = createRunDir('cli-doctor-env');
  try {
    const { file } = writeCliConfig(runDir.dir, { envVars: false });
    const result = runCli(['doctor', '--config', file]);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /config\.env/);
    assert.match(result.stdout, /E2E_CLI_TOKEN_MISSING/);
    assert.match(result.stdout, /结果：失败/);
  } finally {
    runDir.cleanup();
  }
});

test('cli e2e: doctor exits 1 for a missing or invalid config file', () => {
  const runDir = createRunDir('cli-doctor-bad');
  try {
    const missing = runCli(['doctor', '--config', join(runDir.dir, 'nope.json')]);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /cannot read config file/);

    const badFile = join(runDir.dir, 'bad.json');
    writeFileSync(badFile, '{ not json', 'utf8');
    const bad = runCli(['doctor', '--config', badFile]);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /not valid JSON/);
  } finally {
    runDir.cleanup();
  }
});

test('cli e2e: status exits 1 when no gateway state file exists', () => {
  const runDir = createRunDir('cli-status-missing');
  try {
    const { file } = writeCliConfig(runDir.dir);
    const result = runCli(['status', '--config', file]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /网关未运行/);
  } finally {
    runDir.cleanup();
  }
});

test('cli e2e: pair resolves a workspace-local config', () => {
  const runDir = createRunDir('cli-workspace-pair');
  try {
    const workspace = join(runDir.dir, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const stateDir = join(runDir.dir, 'state');
    mkdirSync(stateDir, { recursive: true });
    const localConfig = join(workspace, '.dsh-im-manager', 'config.json');
    mkdirSync(join(workspace, '.dsh-im-manager'), { recursive: true });
    const config = {
      dsh: {
        command: 'dsh',
        args: [],
        cwd: workspace,
        provider: 'deepseek-official',
        model: 'fake-model',
      },
      gateway: {
        stateDir,
        log: { level: 'silent' },
        http: { enabled: true, host: '127.0.0.1', port: 0, publicBaseUrl: '' },
        access: { dmPolicy: 'pairing', allowFrom: [] },
      },
      channels: {},
    };
    writeFileSync(localConfig, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

    // Seed a pending pairing exactly like a running gateway would.
    const store = createPairingStore({ file: join(stateDir, 'pairing.json'), ttlSec: 600 });
    const request = store.request({ channel: 'feishu', senderId: 'ou_workspace_owner', name: 'Owner' });

    // `pair` runs from the workspace, finds .dsh-im-manager/config.json itself.
    const pair = spawnSync(NODE, [BIN, 'pair', request.code], {
      cwd: workspace,
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, DSH_HOME: join(runDir.dir, 'home') },
    });
    assert.equal(pair.status, 0, pair.stdout + pair.stderr);
    assert.match(pair.stdout, /工作区：/);
    assert.match(pair.stdout, /已允许 feishu:ou_workspace_owner/);

    const reloaded = createPairingStore({ file: join(stateDir, 'pairing.json') });
    assert.equal(reloaded.isApproved('feishu', 'ou_workspace_owner'), true);
  } finally {
    runDir.cleanup();
  }
});
