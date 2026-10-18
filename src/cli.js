/** dsh-im-manager command line interface. */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadConfig,
  enabledChannels,
  CHANNEL_IDS,
} from './core/config.js';
import { createPairingStore } from './core/pairing.js';
import { resolveDshCommand } from './core/dsh-command.js';
import { loadAdapterModule } from './adapters/registry.js';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** @param {string} message */
function print(message = '') {
  process.stdout.write(`${message}\n`);
}

/** @param {string} message */
function printError(message) {
  process.stderr.write(`${message}\n`);
}

/**
 * Minimal argv parser: no dependency, no magic.
 * @param {string[]} argv
 */
function parseArgs(argv) {
  /** @type {{ _: string[], config?: string, json: boolean, force: boolean, help: boolean, version: boolean }} */
  const args = { _: [], json: false, force: false, help: false, version: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--config' || value === '-c') {
      args.config = argv[index + 1];
      index += 1;
    } else if (value.startsWith('--config=')) {
      args.config = value.slice('--config='.length);
    } else if (value === '--json') {
      args.json = true;
    } else if (value === '--force') {
      args.force = true;
    } else if (value === '--local') {
      args.local = true;
    } else if (value === '--qr') {
      args.qr = argv[index + 1];
      index += 1;
    } else if (value.startsWith('--qr=')) {
      args.qr = value.slice('--qr='.length);
    } else if (value === '--host') {
      args.host = argv[index + 1];
      index += 1;
    } else if (value === '--port') {
      args.port = argv[index + 1];
      index += 1;
    } else if (value === '--help' || value === '-h') {
      args.help = true;
    } else if (value === '--version' || value === '-V') {
      args.version = true;
    } else {
      args._.push(value);
    }
  }
  return args;
}

const USAGE = `dsh-im-manager — IM manager for DeepSeek Harness

用法：
  dsh-im-manager doctor [--config <path>]       体检：配置 / dsh 运行时 / 渠道依赖 / 端口
  dsh-im-manager status [--config <path>]       查看运行状态（读 stateDir/gateway.json）
  dsh-im-manager channels [--config <path>]     列出已启用的渠道
  dsh-im-manager sessions [--config <path>]     列出当前工作区的 IM 会话映射（微信/飞书等 → DSH sessionId）
  dsh-im-manager weixin login|status|logout     个人微信扫码登录 / 查看 / 退出（login --qr <png> 保存二维码图片）
  dsh-im-manager pair <code>                    批准一个 DM 配对码
  dsh-im-manager allow <channel>:<senderId>     直接加入允许列表
  dsh-im-manager revoke <channel>:<senderId>    移出允许列表
  dsh-im-manager list                           查看允许/待配对列表
  dsh-im-manager version                        版本
  dsh-im-manager help                           本帮助

环境变量：
  DSH_IM_MANAGER_CONFIG   配置文件路径
  DSH_IM_MANAGER_DSH      dsh 可执行文件路径
  DSH_HOME                DeepSeek Harness home（缺省 ~/.dsh）
`;

/**
 * Load config for CLI commands. Commands that only inspect state (`doctor`,
 * `status`, `pair`, ...) tolerate an incomplete config so the operator can see
 * every problem at once; commands tolerate an incomplete config.
 * @param {{ configPath?: string, warn?: (message: string) => void, strict?: boolean }} options
 */
function loadOrExplain(options) {
  try {
    return loadConfig({ configPath: options.configPath, warn: options.warn, skipValidation: options.strict !== true });
  } catch (error) {
    printError(`✗ ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * Check whether a TCP port can be bound.
 * @param {string} host
 * @param {number} port
 */
async function checkPort(host, port) {
  if (port === 0) return { ok: true, detail: 'ephemeral (0)' };
  return await new Promise((resolvePromise) => {
    const server = createServer();
    server.once('error', (error) => {
      resolvePromise({ ok: false, detail: error.code === 'EADDRINUSE' ? `port ${port} is in use` : String(error.message) });
    });
    server.once('listening', () => {
      server.close(() => resolvePromise({ ok: true, detail: `port ${port} is free` }));
    });
    server.listen(port, host);
  });
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 */
function runDsh(command, args, env) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 30_000,
    env,
    maxBuffer: 8 * 1024 * 1024,
  });
}

/**
 * `doctor`: collect every check, print a table, and exit non-zero on errors.
 * @param {{ config?: string }} args
 */
async function doctor(args) {
  /** @type {Array<{ level: 'ok'|'warn'|'error', name: string, detail: string }>} */
  const checks = [];
  const ok = (name, detail) => checks.push({ level: 'ok', name, detail });
  const warn = (name, detail) => checks.push({ level: 'warn', name, detail });
  const bad = (name, detail) => checks.push({ level: 'error', name, detail });

  const configWarnings = [];
  const loaded = loadOrExplain({ configPath: args.config, warn: (message) => configWarnings.push(message) });
  if (loaded === null) return 1;
  const { config, path } = loaded;
  ok('config', path ?? '(defaults)');
  for (const warning of configWarnings) bad('config.env', warning);
  if (existsSync(config.dsh.cwd)) {
    ok('workspace', `${config.dsh.cwd}${config.dsh.home ? `（DSH_HOME=${config.dsh.home}）` : ''}`);
  } else {
    bad('workspace', `dsh.cwd does not exist: ${config.dsh.cwd}`);
  }

  const command = resolveDshCommand(config.dsh);
  const childEnv = {
    ...process.env,
    ...(config.dsh.home ? { DSH_HOME: config.dsh.home } : {}),
    ...(config.dsh.env ?? {}),
  };
  const version = runDsh(command, ['--version'], childEnv);
  if (version.error) {
    bad('dsh', `${command} failed: ${version.error.message}`);
  } else if (version.status !== 0) {
    bad('dsh', `${command} --version exited ${version.status}: ${(version.stderr ?? '').trim().slice(0, 200)}`);
  } else {
    ok('dsh', `${command} (${(version.stdout ?? '').trim().split('\n')[0]})`);
  }

  const profile = runDsh(command, ['--profile', 'sdk', '--dump-config'], childEnv);
  if (profile.error) {
    bad('dsh.profile.sdk', `${command} --profile sdk --dump-config failed: ${profile.error.message}`);
  } else if (profile.status !== 0) {
    const stderr = String(profile.stderr ?? '');
    if (/EPERM|EACCES/.test(stderr)) {
      bad('dsh.profile.sdk', `cannot write the sdk profile under DSH_HOME (${config.dsh.home || process.env.DSH_HOME || '~/.dsh'}); run outside the sandbox or set dsh.home to a writable directory`);
    } else {
      bad('dsh.profile.sdk', `--dump-config exited ${profile.status}: ${stderr.trim().slice(0, 300)}`);
    }
  } else if (!String(profile.stdout).includes('dsh-sdk-jsonrpc-server')) {
    bad('dsh.profile.sdk', 'profile sdk does not mount dsh-sdk-jsonrpc-server');
  } else {
    ok('dsh.profile.sdk', 'SDK JSON-RPC profile is available');
  }

  if (config.gateway.http.enabled) {
    const port = await checkPort(config.gateway.http.host, config.gateway.http.port);
    if (port.ok) ok('http', port.detail);
    else bad('http', port.detail);
  } else {
    warn('http', 'disabled: webhook-mode channels cannot start');
  }

  const enabled = enabledChannels(config);
  if (enabled.length === 0) warn('channels', 'no channel enabled');
  for (const id of enabled) {
    const channel = config.channels[id];
    try {
      const module = await loadAdapterModule(id);
      const validate = module.validateConfig ?? module.default?.validateConfig;
      if (typeof validate === 'function') validate(channel);
      if ((channel.mode === 'webhook' || channel.mode === 'mp') && !config.gateway.http.enabled) {
        bad(`channel.${id}`, `${channel.mode} mode requires gateway.http.enabled=true`);
      } else {
        ok(`channel.${id}`, `mode=${channel.mode ?? 'default'}`);
      }
    } catch (error) {
      bad(`channel.${id}`, error instanceof Error ? error.message : String(error));
    }
  }

  if (config.channels.weixin?.enabled === true) {
    try {
      const loginModule = await import('./adapters/weixin/login.js');
      const stateDir = join(config.gateway.stateDir, 'channels', 'weixin');
      const credential = loginModule.readCredential(stateDir, config.channels.weixin);
      if (credential === undefined) {
        warn('channel.weixin', '未登录：运行 `dsh-im-manager weixin login` 扫码（Gateway 运行时可随时登录）');
      } else {
        ok('channel.weixin', `已登录 ${credential.ilinkBotId}`);
      }
    } catch (error) {
      bad('channel.weixin', error instanceof Error ? error.message : String(error));
    }
  }

  if (config.gateway.access.dmPolicy === 'open') {
    warn('access', 'dmPolicy=open：任何能私聊机器人的用户都能驱动 Agent');
  } else if (config.gateway.access.dmPolicy === 'pairing') {
    warn('access', 'dmPolicy=pairing：未配对用户会收到配对码，需 `dsh-im-manager pair <code>`');
  }

  const symbol = { ok: '✓', warn: '!', error: '✗' };
  for (const check of checks) print(`${symbol[check.level]} ${check.name.padEnd(18)} ${check.detail}`);
  const errors = checks.filter((check) => check.level === 'error').length;
  const warnings = checks.filter((check) => check.level === 'warn').length;
  print('');
  print(`结果：${errors === 0 ? '通过' : '失败'}（${errors} error, ${warnings} warn）`);
  return errors === 0 ? 0 : 1;
}

/**
 * @param {{ config?: string, json: boolean }} args
 */
function status(args) {
  const loaded = loadOrExplain({ configPath: args.config });
  if (loaded === null) return 1;
  const file = join(loaded.config.gateway.stateDir, 'gateway.json');
  if (!existsSync(file)) {
    printError(`✗ 网关未运行：找不到 ${file}`);
    return 1;
  }
  let state;
  try {
    state = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    printError(`✗ 无法读取 ${file}: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  let alive = false;
  if (Number.isInteger(state.pid)) {
    try {
      process.kill(state.pid, 0);
      alive = true;
    } catch (error) {
      alive = error.code === 'EPERM';
    }
  }
  const snapshot = { ...state, alive, stateFile: file };
  if (args.json) {
    print(JSON.stringify(snapshot, null, 2));
    return alive ? 0 : 1;
  }
  print(`状态：${alive ? '运行中' : '已停止'}（pid ${state.pid ?? '?'}）`);
  print(`工作区：${state.workspace?.cwd ?? '（未记录）'}`);
  print(`启动：${state.startedAt ? new Date(state.startedAt).toLocaleString() : '?'}`);
  print(`更新：${state.updatedAt ? new Date(state.updatedAt).toLocaleString() : '?'}`);
  print(`渠道：${Object.keys(state.channels ?? {}).join(', ') || '（无）'}`);
  print(`状态文件：${file}`);
  return alive ? 0 : 1;
}

/**
 * @param {ReturnType<typeof loadConfig>} loaded
 */
function pairingStore(loaded) {
  return createPairingStore({
    file: join(loaded.config.gateway.stateDir, 'pairing.json'),
    ttlSec: loaded.config.gateway.access.pairingTtlSec,
  });
}

/**
 * @param {{ config?: string }} args
 */
function listAccess(args) {
  const loaded = loadOrExplain({ configPath: args.config });
  if (loaded === null) return 1;
  const store = pairingStore(loaded);
  print(`工作区：${loaded.config.dsh.cwd}（配置：${loaded.path ?? '(defaults)'}）`);
  print('');
  const approved = store.listApproved();
  const pending = store.listPending();
  print(`允许列表（${approved.length}）：`);
  for (const entry of approved) print(`  ${entry.channel}:${entry.senderId}${entry.name ? `  (${entry.name})` : ''}`);
  print('');
  print(`待配对（${pending.length}）：`);
  for (const entry of pending) {
    const expires = new Date(entry.createdAt + store.ttlSec * 1000).toLocaleTimeString();
    print(`  ${entry.code}  ${entry.channel}:${entry.senderId}${entry.name ? `  (${entry.name})` : ''}  过期于 ${expires}`);
  }
  return 0;
}

/**
 * @param {{ config?: string }} args
 * @param {string} code
 */
function pair(args, code) {
  const loaded = loadOrExplain({ configPath: args.config });
  if (loaded === null) return 1;
  const store = pairingStore(loaded);
  print(`工作区：${loaded.config.dsh.cwd}`);
  print(`配置：${loaded.path ?? '(defaults)'}`);
  const result = store.approve(code);
  if (!result.ok) {
    printError(`✗ ${result.reason}`);
    const pending = store.listPending();
    if (pending.length > 0) {
      print('当前待配对：');
      for (const entry of pending) print(`  ${entry.code}  ${entry.channel}:${entry.senderId}`);
    }
    return 1;
  }
  print(`✓ 已允许 ${result.entry.channel}:${result.entry.senderId}${result.entry.name ? `（${result.entry.name}）` : ''}`);
  return 0;
}

/**
 * @param {{ config?: string }} args
 * @param {string} spec `<channel>:<senderId>`
 * @param {'allow'|'revoke'} mode
 */
function mutateAccess(args, spec, mode) {
  const loaded = loadOrExplain({ configPath: args.config });
  if (loaded === null) return 1;
  const separator = spec.indexOf(':');
  if (separator <= 0 || separator === spec.length - 1) {
    printError('✗ 格式应为 <channel>:<senderId>，例如 feishu:ou_xxx');
    return 1;
  }
  const channel = spec.slice(0, separator);
  const senderId = spec.slice(separator + 1);
  if (!CHANNEL_IDS.includes(channel)) {
    printError(`✗ 未知渠道 ${channel}（可用：${CHANNEL_IDS.join(', ')}）`);
    return 1;
  }
  const store = pairingStore(loaded);
  if (mode === 'allow') {
    const entry = store.allow({ channel, senderId });
    print(`✓ 已允许 ${entry.channel}:${entry.senderId}`);
  } else if (!store.revoke(channel, senderId)) {
    printError(`✗ 允许列表中没有 ${channel}:${senderId}`);
    return 1;
  } else {
    print(`✓ 已移除 ${channel}:${senderId}`);
  }
  return 0;
}

function sessionsCommand(args) {
  const loaded = loadOrExplain({ configPath: args.config });
  if (loaded === null) return 1;
  const config = loaded.config;
  const file = join(config.gateway.stateDir, 'sessions.json');
  if (!existsSync(file)) {
    print(`工作区：${config.dsh.cwd}`);
    print('还没有会话映射（尚未有 IM 消息进入）。');
    return 0;
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    printError(`✗ 无法读取 ${file}: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const rows = Object.entries(parsed.sessions ?? {})
    .map(([key, entry]) => ({ key, ...entry }))
    .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0));
  const workspace = parsed.workspace?.cwd;
  if (args.json) {
    print(JSON.stringify({ file, workspace, sessions: rows }, null, 2));
    return 0;
  }
  print(`工作区：${workspace ?? config.dsh.cwd}`);
  print(`会话文件：${file}`);
  if (rows.length === 0) {
    print('（没有会话）');
    return 0;
  }
  print('');
  for (const row of rows) {
    const age = Math.max(0, Math.round((Date.now() - (row.lastUsedAt ?? 0)) / 60000));
    print(`${String(row.sessionId).slice(0, 8)}…  ${row.key}  (${age} 分钟前)`);
  }
  print('');
  print('提示：DSH Desktop 的会话列表由宿主维护，外部 SDK 进程新建的会话可能需要刷新/重开窗口才能看到。');
  return 0;
}

/**
 * @param {{ config?: string }} args
 */
function channels(args) {
  const loaded = loadOrExplain({ configPath: args.config });
  if (loaded === null) return 1;
  const enabled = enabledChannels(loaded.config);
  if (enabled.length === 0) {
    print('没有启用的渠道。编辑配置里的 channels.*.enabled。');
    return 0;
  }
  for (const id of enabled) {
    const channel = loaded.config.channels[id];
    const path = channel.webhookPath ?? '';
    print(`${id.padEnd(10)} mode=${String(channel.mode ?? 'default').padEnd(8)} account=${channel.accountId}`
      + `${channel.mode === 'webhook' || channel.mode === 'mp' ? `  webhook=${path}` : ''}`);
  }
  return 0;
}

/**
 * @param {{ config?: string, force: boolean }} args
 */
async function weixinCommand(args, rest) {
  const sub = rest[0] ?? 'status';
  if (!['login', 'status', 'logout'].includes(sub)) {
    printError('用法：dsh-im-manager weixin login|status|logout [--config <path>]');
    return 1;
  }
  const loaded = loadOrExplain({ configPath: args.config, strict: true });
  if (loaded === null) return 1;
  const channel = loaded.config.channels.weixin;
  const stateDir = join(loaded.config.gateway.stateDir, 'channels', 'weixin');
  let loginModule;
  try {
    loginModule = await import('./adapters/weixin/login.js');
  } catch (error) {
    printError(`✗ 无法加载 weixin 登录模块：${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const { readCredential, deleteCredential, redactCredential, credentialPath, runWeixinLogin } = loginModule;
  if (sub === 'status') {
    const credential = readCredential(stateDir, channel);
    print(`凭据文件：${credentialPath(stateDir, channel)}`);
    if (credential === undefined) {
      print('状态：未登录（运行 `dsh-im-manager weixin login` 扫码）');
      return 1;
    }
    const redacted = redactCredential(credential);
    print(`状态：已登录`);
    print(`  ilinkBotId：${redacted.ilinkBotId}`);
    if (redacted.userId) print(`  微信用户：${redacted.userId}`);
    print(`  API base：${redacted.baseUrl}`);
    print(`  保存时间：${redacted.savedAt}`);
    return 0;
  }
  if (sub === 'logout') {
    const removed = deleteCredential(stateDir, channel);
    print(removed ? '✓ 已删除微信凭据；如有常驻网关，需要重新扫码登录。' : '（没有可删除的微信凭据）');
    return 0;
  }
  // login
  if (channel.enabled !== true) {
    print('! channels.weixin.enabled=false：登录会成功，但网关不会启动该渠道。');
  }
  const { createInterface } = await import('node:readline/promises');
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  const qrcode = await import('qrcode-terminal');
  const renderQr = qrcode.default?.generate ?? qrcode.generate;
  try {
    const result = await runWeixinLogin({
      stateDir,
      config: channel,
      fetch: globalThis.fetch,
      print: (text) => print(text),
      prompt: async (question) => readline.question(question),
      onQr: ({ imageContent, qrcode: payload }) => {
        const content = imageContent ?? payload;
        print('');
        if (typeof args.qr === 'string' && args.qr.length > 0) {
          // login.js does not await onQr, so handle the write as a guarded task.
          void (async () => {
            const QR = await import('qrcode');
            const toFile = QR.default?.toFile ?? QR.toFile;
            await toFile(args.qr, content, { width: 640, margin: 2, errorCorrectionLevel: 'M' });
            print(`二维码图片：${args.qr}`);
            print('用手机微信扫描该图片；二维码有效期约 3-5 分钟。');
          })().catch((error) => {
            printError(`✗ 二维码图片写入失败：${error instanceof Error ? error.message : String(error)}`);
          });
        } else {
          print('请使用微信扫描下方二维码（或在微信内打开链接）：');
          renderQr(content, { small: true });
        }
        if (imageContent) print(`链接：${imageContent}`);
      },
      onStatus: ({ status, detail }) => {
        if (status === 'wait' || status === 'scaned' || status === 'scaned_but_redirect') {
          print(`状态：${status}${detail ? `（${detail}）` : ''}`);
        }
      },
    });
    print('');
    print(`✓ 登录成功：${result.ilinkBotId}${result.userId ? `（微信用户 ${result.userId}）` : ''}`);
    print('凭据已写入；运行中的 Gateway 会在数秒内自动开始收发消息。');
    return 0;
  } catch (error) {
    printError(`✗ 登录失败：${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    readline.close();
  }
}

/**
 * @param {{ config?: string }} args
 */
export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.version || args._[0] === 'version') {
    const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'));
    print(pkg.version);
    return 0;
  }
  if (args.help || args._[0] === undefined || args._[0] === 'help') {
    print(USAGE);
    return 0;
  }
  const command = args._[0];
  const rest = args._.slice(1);
  switch (command) {
    case 'doctor':
      return await doctor(args);
    case 'status':
      return status(args);
    case 'channels':
      return channels(args);
    case 'sessions':
      return sessionsCommand(args);
    case 'weixin':
      return await weixinCommand(args, rest);
    case 'pair':
      if (rest.length !== 1) {
        printError('用法：dsh-im-manager pair <code>');
        return 1;
      }
      return pair(args, rest[0]);
    case 'allow':
      if (rest.length !== 1) {
        printError('用法：dsh-im-manager allow <channel>:<senderId>');
        return 1;
      }
      return mutateAccess(args, rest[0], 'allow');
    case 'revoke':
      if (rest.length !== 1) {
        printError('用法：dsh-im-manager revoke <channel>:<senderId>');
        return 1;
      }
      return mutateAccess(args, rest[0], 'revoke');
    case 'list':
      return listAccess(args);
    default:
      printError(`未知命令：${command}\n`);
      print(USAGE);
      return 1;
  }
}

export { USAGE };
