/**
 * End-to-end CLI checks: `doctor` / `status` / `serve` exit codes, the real
 * config loader (including `env:` interpolation), and a full serve round-trip
 * with the fake DSH runtime.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  PACKAGE_ROOT,
  fakeRuntimePath,
  createRunDir,
  waitFor,
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

/** Config for a real `serve` process: the DSH command is the fake runtime. */
function writeServeConfig(runDir) {
  const stateDir = join(runDir, 'state');
  mkdirSync(stateDir, { recursive: true });
  const config = {
    dsh: {
      command: NODE,
      args: [fakeRuntimePath],
      cwd: PACKAGE_ROOT,
      provider: 'deepseek-official',
      model: 'fake-model',
      initTimeoutMs: 5000,
      turnTimeoutMs: 10000,
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
        appId: 'cli_0123456789abcdef',
        appSecret: 'feishu_cli_app_secret',
        verificationToken: 'feishu_verification_token',
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

test('cli e2e: init writes an example config', () => {
  const runDir = createRunDir('cli-init');
  try {
    const target = join(runDir.dir, 'config.json');
    const result = runCli(['init', '--config', target]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /已写入/);
    const second = runCli(['init', '--config', target]);
    assert.equal(second.status, 1, 'existing config must not be overwritten without --force');
  } finally {
    runDir.cleanup();
  }
});

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

test('cli e2e: serve writes state, status exits 0, SIGINT stops and status exits 1', async (t) => {
  const runDir = createRunDir('cli-serve');
  const { file } = writeServeConfig(runDir.dir);
  const child = spawn(NODE, [BIN, 'serve', '--config', file], {
    cwd: PACKAGE_ROOT,
    env: {
      ...process.env,
      E2E_CLI_APP_ID: 'cli_0123456789abcdef',
      E2E_CLI_APP_SECRET: 'feishu_cli_app_secret',
      E2E_CLI_TOKEN: 'feishu_verification_token',
      FAKE_DSH_REPLY_TEXT: 'cli reply',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  /** @type {string[]} */
  const stderr = [];
  child.stderr.on('data', (chunk) => stderr.push(String(chunk)));

  t.after(async () => {
    if (child.exitCode === null) {
      child.kill('SIGKILL');
      await new Promise((resolve) => child.once('exit', resolve));
    }
    runDir.cleanup();
  });

  await waitFor(async () => {
    const status = runCli(['status', '--config', file]);
    return status.status === 0 ? status : null;
  }, { timeoutMs: 15_000, description: 'serve writes gateway.json and status exits 0' });

  const running = runCli(['status', '--json', '--config', file]);
  assert.equal(running.status, 0);
  const snapshot = JSON.parse(running.stdout);
  assert.equal(snapshot.alive, true);
  assert.equal(snapshot.state, 'running');
  assert.ok(snapshot.pid > 0);
  assert.equal(snapshot.channels.feishu, 'running');

  child.kill('SIGINT');
  await new Promise((resolve) => child.once('exit', resolve));
  const afterStop = runCli(['status', '--config', file]);
  assert.equal(afterStop.status, 1, stderr.join(''));
  assert.match(afterStop.stdout + afterStop.stderr, /已停止/);
});


test('cli e2e: init --local + pair resolve the workspace config', () => {
  const runDir = createRunDir('cli-workspace-pair');
  try {
    const workspace = join(runDir.dir, 'workspace');
    mkdirSync(workspace, { recursive: true });

    const init = spawnSync(NODE, [BIN, 'init', '--local'], {
      cwd: workspace,
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(init.status, 0, init.stderr);
    assert.match(init.stdout, /工作区/);
    const configFile = join(workspace, '.dsh-im-manager', 'config.json');
    assert.equal(existsSync(configFile), true);

    // Point the workspace config at an isolated state dir; keep channels disabled.
    const config = JSON.parse(readFileSync(configFile, 'utf8'));
    config.gateway.stateDir = join(runDir.dir, 'state');
    config.dsh.cwd = workspace;
    writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

    // Seed a pending pairing exactly like a running gateway would.
    const store = createPairingStore({ file: join(config.gateway.stateDir, 'pairing.json'), ttlSec: 600 });
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

    const reloaded = createPairingStore({ file: join(config.gateway.stateDir, 'pairing.json') });
    assert.equal(reloaded.isApproved('feishu', 'ou_workspace_owner'), true);
  } finally {
    runDir.cleanup();
  }
});
