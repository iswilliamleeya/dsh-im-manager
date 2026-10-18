/**
 * QR login state machine: happy path, verify code, expiry refresh, redirect
 * trust, binded_redirect, abort, timeout, credential persistence.
 */
import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { WeixinAbortError } from '../../../src/adapters/weixin/client.js';
import { readCredential, writeCredential } from '../../../src/adapters/weixin/credentials.js';
import { runWeixinLogin } from '../../../src/adapters/weixin/login.js';
import { cleanupDir, makeTempDir, makeTransport } from './helpers.js';

const BASE = 'https://ilinkai.weixin.qq.com';
const CDN = 'https://novac2c.cdn.weixin.qq.com/c2c';

/** @param {Record<string, unknown>} [overrides] */
function loginConfig(overrides = {}) {
  return {
    enabled: true,
    accountId: 'weixin',
    mode: 'ilink',
    baseUrl: BASE,
    cdnBaseUrl: CDN,
    loginTimeoutMs: 60_000,
    typing: true,
    botAgent: 'dsh-im-manager',
    ...overrides,
  };
}

/** QR fetch + scripted status responses. */
function makeLoginTransport(sequence, qr = { qrcode: 'qr-value-1', qrcode_img_content: 'https://weixin.qq.com/qr/qr-value-1' }) {
  let qrCount = 0;
  const { calls, transport } = makeTransport((call) => {
    if (call.url.includes('/ilink/bot/get_bot_qrcode')) {
      qrCount += 1;
      return qrCount === 1 ? qr : { qrcode: `qr-value-${qrCount}`, qrcode_img_content: `https://weixin.qq.com/qr/qr-value-${qrCount}` };
    }
    const next = sequence.length > 0 ? sequence.shift() : { status: 'wait' };
    return typeof next === 'function' ? next(call) : next;
  });
  return { calls, transport, qrCount: () => qrCount };
}

const CONFIRMED = {
  status: 'confirmed',
  bot_token: 'bot-token-secret-value',
  ilink_bot_id: 'bot-xyz@im.bot',
  baseurl: BASE,
  ilink_user_id: 'wxid-scan@im.wechat',
};

/** Collect print/onQr/onStatus output. */
function recorder() {
  const printed = [];
  const qr = [];
  const statuses = [];
  return {
    printed,
    qr,
    statuses,
    print: (text) => printed.push(String(text)),
    onQr: (payload) => qr.push(payload),
    onStatus: (payload) => statuses.push(payload),
    dump: () => JSON.stringify([printed, qr, statuses]),
  };
}

test('happy path: wait -> scaned -> confirmed writes a 0600 credential', async () => {
  const dir = makeTempDir();
  try {
    const recorderState = recorder();
    const { calls, transport } = makeLoginTransport([
      { status: 'wait' },
      { status: 'scaned' },
      CONFIRMED,
    ]);
    const result = await runWeixinLogin({
      stateDir: dir,
      config: loginConfig(),
      transport,
      sleep: async () => {},
      print: recorderState.print,
      prompt: async () => '',
      onQr: recorderState.onQr,
      onStatus: recorderState.onStatus,
      now: () => 1_700_000_000_000,
    });

    assert.deepEqual(result, {
      ilinkBotId: 'bot-xyz@im.bot',
      userId: 'wxid-scan@im.wechat',
      baseUrl: BASE,
    });
    const credentialFile = join(dir, 'credentials.json');
    assert.equal(existsSync(credentialFile), true);
    assert.equal(statSync(credentialFile).mode & 0o777, 0o600);
    const credential = readCredential(dir, {});
    assert.ok(credential);
    assert.equal(credential.token, CONFIRMED.bot_token);
    assert.equal(credential.ilinkBotId, CONFIRMED.ilink_bot_id);
    assert.equal(credential.userId, CONFIRMED.ilink_user_id);
    assert.equal(credential.baseUrl, BASE);
    assert.equal(credential.savedAt, new Date(1_700_000_000_000).toISOString());

    // QR POST shape + polling GETs.
    const qrCall = calls.find((call) => call.url.includes('/ilink/bot/get_bot_qrcode'));
    assert.ok(qrCall);
    assert.equal(qrCall.method, 'POST');
    assert.ok(qrCall.url.endsWith('/ilink/bot/get_bot_qrcode?bot_type=3'));
    assert.deepEqual(qrCall.body, { local_token_list: [] });
    const statusCalls = calls.filter((call) => call.url.includes('/ilink/bot/get_qrcode_status'));
    assert.equal(statusCalls.length, 3);
    assert.equal(new URL(statusCalls[0].url).searchParams.get('qrcode'), 'qr-value-1');

    // QR handed to the CLI, and no token in printed output.
    assert.equal(recorderState.qr.length, 1);
    assert.equal(recorderState.qr[0].imageContent, 'https://weixin.qq.com/qr/qr-value-1');
    assert.ok(recorderState.statuses.some((entry) => entry.status === 'confirmed'));
    assert.match(recorderState.printed.join('\n'), /登录成功：bot-xyz@im\.bot/);
    assert.equal(recorderState.dump().includes(CONFIRMED.bot_token), false);
  } finally {
    cleanupDir(dir);
  }
});

test('need_verifycode prompts and polls with &verify_code=', async () => {
  const dir = makeTempDir();
  try {
    const recorderState = recorder();
    const questions = [];
    const { calls, transport } = makeLoginTransport([
      { status: 'need_verifycode' },
      { status: 'scaned' },
      CONFIRMED,
    ]);
    const result = await runWeixinLogin({
      stateDir: dir,
      config: loginConfig(),
      transport,
      sleep: async () => {},
      print: recorderState.print,
      prompt: async (question) => {
        questions.push(question);
        return '  135790  ';
      },
      onStatus: recorderState.onStatus,
    });
    assert.equal(result.ilinkBotId, CONFIRMED.ilink_bot_id);
    assert.equal(questions.length, 1);
    assert.match(questions[0], /数字验证码/);
    const statusCalls = calls.filter((call) => call.url.includes('/ilink/bot/get_qrcode_status'));
    assert.equal(new URL(statusCalls[0].url).searchParams.get('verify_code'), null);
    assert.equal(new URL(statusCalls[1].url).searchParams.get('verify_code'), '135790');
    // Once the server reports `scaned`, the accepted code is no longer sent.
    assert.equal(new URL(statusCalls[2].url).searchParams.get('verify_code'), null);
    assert.match(recorderState.printed.join('\n'), /已提交验证码/);
  } finally {
    cleanupDir(dir);
  }
});

test('a second need_verifycode asks again with a different prompt', async () => {
  const dir = makeTempDir();
  try {
    const questions = [];
    const { transport } = makeLoginTransport([
      { status: 'need_verifycode' },
      { status: 'need_verifycode' },
      CONFIRMED,
    ]);
    await runWeixinLogin({
      stateDir: dir,
      config: loginConfig(),
      transport,
      sleep: async () => {},
      prompt: async (question) => {
        questions.push(question);
        return questions.length === 1 ? '111111' : '222222';
      },
    });
    assert.equal(questions.length, 2);
    assert.match(questions[0], /请输入/);
    assert.match(questions[1], /不正确/);
  } finally {
    cleanupDir(dir);
  }
});

test('expired refreshes the QR code and keeps polling', async () => {
  const dir = makeTempDir();
  try {
    const recorderState = recorder();
    const { transport, qrCount } = makeLoginTransport([{ status: 'expired' }, CONFIRMED]);
    const result = await runWeixinLogin({
      stateDir: dir,
      config: loginConfig(),
      transport,
      sleep: async () => {},
      print: recorderState.print,
      onQr: recorderState.onQr,
      onStatus: recorderState.onStatus,
    });
    assert.equal(result.ilinkBotId, CONFIRMED.ilink_bot_id);
    assert.equal(qrCount(), 2);
    assert.equal(recorderState.qr.length, 2);
    assert.match(recorderState.printed.join('\n'), /二维码已过期，正在刷新/);
    assert.ok(recorderState.statuses.some((entry) => entry.status === 'expired'));
  } finally {
    cleanupDir(dir);
  }
});

test('gives up after too many expired QR codes', async () => {
  const dir = makeTempDir();
  try {
    const { transport, qrCount } = makeLoginTransport([
      { status: 'expired' },
      { status: 'expired' },
      { status: 'expired' },
      { status: 'expired' },
    ]);
    await assert.rejects(
      runWeixinLogin({
        stateDir: dir,
        config: loginConfig(),
        transport,
        sleep: async () => {},
        print: () => {},
      }),
      /多次过期/,
    );
    assert.equal(qrCount(), 4); // initial + 3 refreshes
    assert.equal(existsSync(join(dir, 'credentials.json')), false);
  } finally {
    cleanupDir(dir);
  }
});

test('verify_code_blocked refreshes the QR code', async () => {
  const dir = makeTempDir();
  try {
    const printed = [];
    const { transport, qrCount } = makeLoginTransport([{ status: 'verify_code_blocked' }, CONFIRMED]);
    const result = await runWeixinLogin({
      stateDir: dir,
      config: loginConfig(),
      transport,
      sleep: async () => {},
      print: (text) => printed.push(String(text)),
    });
    assert.equal(result.ilinkBotId, CONFIRMED.ilink_bot_id);
    assert.equal(qrCount(), 2);
    assert.match(printed.join('\n'), /错误次数过多/);
  } finally {
    cleanupDir(dir);
  }
});

test('scaned_but_redirect switches polling to the official redirect host', async () => {
  const dir = makeTempDir();
  try {
    const { calls, transport } = makeLoginTransport([
      { status: 'scaned_but_redirect', redirect_host: 'idc.weixin.qq.com' },
      { ...CONFIRMED, baseurl: 'https://idc.weixin.qq.com' },
    ]);
    const result = await runWeixinLogin({
      stateDir: dir,
      config: loginConfig(),
      transport,
      sleep: async () => {},
      print: () => {},
    });
    assert.equal(result.baseUrl, 'https://idc.weixin.qq.com');
    const statusCalls = calls.filter((call) => call.url.includes('/ilink/bot/get_qrcode_status'));
    assert.equal(new URL(statusCalls[0].url).host, 'ilinkai.weixin.qq.com');
    assert.equal(new URL(statusCalls[1].url).host, 'idc.weixin.qq.com');
  } finally {
    cleanupDir(dir);
  }
});

test('rejects an untrusted redirect host without writing credentials', async () => {
  const dir = makeTempDir();
  try {
    const { transport } = makeLoginTransport([{ status: 'scaned_but_redirect', redirect_host: 'evil.example.com' }]);
    await assert.rejects(
      runWeixinLogin({
        stateDir: dir,
        config: loginConfig(),
        transport,
        sleep: async () => {},
        print: () => {},
      }),
      /不受信任/,
    );
    assert.equal(existsSync(join(dir, 'credentials.json')), false);
  } finally {
    cleanupDir(dir);
  }
});

test('rejects an untrusted confirmed baseurl', async () => {
  const dir = makeTempDir();
  try {
    const { transport } = makeLoginTransport([
      { ...CONFIRMED, baseurl: 'https://evil.example.com' },
    ]);
    await assert.rejects(
      runWeixinLogin({
        stateDir: dir,
        config: loginConfig(),
        transport,
        sleep: async () => {},
        print: () => {},
      }),
      /不受信任/,
    );
    assert.equal(existsSync(join(dir, 'credentials.json')), false);
  } finally {
    cleanupDir(dir);
  }
});

test('confirmed without bot_token/ilink_bot_id fails safely', async () => {
  const dir = makeTempDir();
  try {
    const { transport } = makeLoginTransport([{ status: 'confirmed', baseurl: BASE }]);
    await assert.rejects(
      runWeixinLogin({
        stateDir: dir,
        config: loginConfig(),
        transport,
        sleep: async () => {},
        print: () => {},
      }),
      /bot_token/,
    );
    assert.equal(existsSync(join(dir, 'credentials.json')), false);
  } finally {
    cleanupDir(dir);
  }
});

test('confirmed without baseurl keeps the configured base URL', async () => {
  const dir = makeTempDir();
  try {
    const { transport } = makeLoginTransport([
      { status: 'confirmed', bot_token: 'tok-2', ilink_bot_id: 'bot-2@im.bot' },
    ]);
    const result = await runWeixinLogin({
      stateDir: dir,
      config: loginConfig(),
      transport,
      sleep: async () => {},
      print: () => {},
    });
    assert.equal(result.baseUrl, BASE);
    assert.equal(readCredential(dir, {})?.baseUrl, BASE);
  } finally {
    cleanupDir(dir);
  }
});

test('binded_redirect keeps an existing credential and sends it as local token', async () => {
  const dir = makeTempDir();
  try {
    writeCredential(dir, {}, {
      version: 1,
      token: 'existing-token',
      ilinkBotId: 'existing-bot@im.bot',
      userId: 'existing-user',
      baseUrl: BASE,
      savedAt: '2026-01-01T00:00:00.000Z',
    });
    const { calls, transport } = makeLoginTransport([{ status: 'binded_redirect' }]);
    const printed = [];
    const result = await runWeixinLogin({
      stateDir: dir,
      config: loginConfig(),
      transport,
      sleep: async () => {},
      print: (text) => printed.push(String(text)),
    });
    assert.deepEqual(result, {
      ilinkBotId: 'existing-bot@im.bot',
      userId: 'existing-user',
      baseUrl: BASE,
    });
    assert.match(printed.join('\n'), /已绑定本网关/);
    assert.equal(readCredential(dir, {})?.token, 'existing-token');
    const qrCall = calls.find((call) => call.url.includes('/get_bot_qrcode'));
    assert.deepEqual(qrCall.body, { local_token_list: ['existing-token'] });
  } finally {
    cleanupDir(dir);
  }
});

test('binded_redirect without a local credential is an error', async () => {
  const dir = makeTempDir();
  try {
    const { transport } = makeLoginTransport([{ status: 'binded_redirect' }]);
    await assert.rejects(
      runWeixinLogin({
        stateDir: dir,
        config: loginConfig(),
        transport,
        sleep: async () => {},
        print: () => {},
      }),
      /本地没有可用凭据/,
    );
  } finally {
    cleanupDir(dir);
  }
});

test('times out when the QR code is never confirmed', async () => {
  const dir = makeTempDir();
  try {
    let ticks = 0;
    const { transport } = makeLoginTransport([]);
    await assert.rejects(
      runWeixinLogin({
        stateDir: dir,
        config: loginConfig({ loginTimeoutMs: 1_000 }),
        transport,
        sleep: async () => {},
        print: () => {},
        now: () => {
          const value = ticks;
          ticks += 600;
          return value;
        },
      }),
      /登录超时/,
    );
    assert.equal(existsSync(join(dir, 'credentials.json')), false);
  } finally {
    cleanupDir(dir);
  }
});

test('a pre-aborted signal cancels the login without network I/O', async () => {
  const dir = makeTempDir();
  try {
    const controller = new AbortController();
    controller.abort();
    const { transport, calls, qrCount } = makeLoginTransport([]);
    await assert.rejects(
      runWeixinLogin({
        stateDir: dir,
        config: loginConfig(),
        transport,
        sleep: async () => {},
        print: () => {},
        signal: controller.signal,
      }),
      (error) => {
        assert.ok(error instanceof WeixinAbortError);
        assert.equal(error.code, 'WEIXIN_ABORTED');
        return true;
      },
    );
    assert.equal(calls.length, 0);
    assert.equal(qrCount(), 0);
  } finally {
    cleanupDir(dir);
  }
});

test('need_verifycode without a prompt fails with a clear message', async () => {
  const dir = makeTempDir();
  try {
    const { transport } = makeLoginTransport([{ status: 'need_verifycode' }]);
    await assert.rejects(
      runWeixinLogin({
        stateDir: dir,
        config: loginConfig(),
        transport,
        sleep: async () => {},
        print: () => {},
      }),
      /无法交互输入/,
    );
  } finally {
    cleanupDir(dir);
  }
});

test('without onQr the image content is printed for manual opening', async () => {
  const dir = makeTempDir();
  try {
    const printed = [];
    const { transport } = makeLoginTransport([CONFIRMED]);
    await runWeixinLogin({
      stateDir: dir,
      config: loginConfig(),
      transport,
      sleep: async () => {},
      print: (text) => printed.push(String(text)),
    });
    assert.ok(printed.join('\n').includes('https://weixin.qq.com/qr/qr-value-1'));
    assert.match(printed.join('\n'), /请使用手机微信扫描/);
  } finally {
    cleanupDir(dir);
  }
});
