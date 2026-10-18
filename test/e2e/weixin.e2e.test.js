/**
 * End-to-end: real gateway + real weixin (personal WeChat / iLink) adapter +
 * real DSH bridge against the fake runtime.
 *
 * Only the WeChat backend is faked (an injected `fetch` that speaks the iLink
 * HTTP JSON protocol); the adapter's long-poll loop, credential handling,
 * inbound mapping, context token, outbound `sendmessage`, and the whole
 * gateway/core/reply path are real.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { createWeixinAdapter } from '../../src/adapters/weixin/index.js';
import { credentialPath, writeCredential } from '../../src/adapters/weixin/credentials.js';
import { createGateway } from '../../src/core/gateway.js';
import { silentLogger } from '../../src/core/logger.js';
import { createRunDir, writeTestConfig, waitFor, PACKAGE_ROOT } from './helpers.js';

const execFileAsync = promisify(execFile);

const SENDER = 'wxid-alice@im.wechat';
const BOT_ID = 'bot-abc@im.bot';
const CONTEXT_TOKEN = 'ctx-token-secret';

/** Build one Response-like object for the injected fetch. */
function jsonResponse(body, status = 200) {
  const text = JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, text: async () => text };
}

/** A minimal iLink user text message. */
function inboundMessage(overrides = {}) {
  return {
    seq: 1,
    message_id: 1_000_001,
    from_user_id: SENDER,
    to_user_id: BOT_ID,
    create_time_ms: Date.now(),
    message_type: 1,
    message_state: 2,
    context_token: CONTEXT_TOKEN,
    item_list: [{ type: 1, text_item: { text: '你好，帮我看看这个报错' } }],
    ...overrides,
  };
}

/**
 * Fake iLink backend over an injected fetch.
 * - getupdates returns one message on the first call, then empty rounds.
 * - sendmessage requests are captured for assertions.
 */
function makeBackend() {
  /** @type {Array<{ url: string, method: string, headers: Record<string, any>, body: any }>} */
  const calls = [];
  let rounds = 0;
  const fetchImpl = async (url, init = {}) => {
    const call = {
      url: String(url),
      method: String(init.method ?? 'GET'),
      headers: /** @type {Record<string, any>} */ ({ ...(init.headers ?? {}) }),
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const path = new URL(call.url).pathname;
    if (path.endsWith('/ilink/bot/getupdates')) {
      rounds += 1;
      if (rounds === 1) {
        return jsonResponse({
          ret: 0,
          msgs: [inboundMessage()],
          get_updates_buf: 'cursor-1',
          longpolling_timeout_ms: 50,
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
      return jsonResponse({ ret: 0, msgs: [], get_updates_buf: 'cursor-1', longpolling_timeout_ms: 50 });
    }
    if (path.endsWith('/ilink/bot/sendmessage')) return jsonResponse({ ret: 0 });
    if (path.endsWith('/ilink/bot/msg/notifystart') || path.endsWith('/ilink/bot/msg/notifystop')) {
      return jsonResponse({ ret: 0 });
    }
    if (path.endsWith('/ilink/bot/getconfig')) return jsonResponse({ ret: 0, typing_ticket: 'typing-ticket' });
    if (path.endsWith('/ilink/bot/sendtyping')) return jsonResponse({ ret: 0 });
    return jsonResponse({ ret: 0 });
  };
  return { calls, fetchImpl };
}

/**
 * Boot a gateway with the weixin adapter and the real fake-DSH bridge.
 * @param {{ seed?: boolean }} [options]
 */
async function bootWeixin(options = {}) {
  const runDir = createRunDir('weixin');
  const { config, configPath, stateDir } = writeTestConfig({
    runDir: runDir.dir,
    dshEnv: { FAKE_DSH_REPLY_TEXT: '微信 e2e 回复' },
    overrides: {
      gateway: { reply: { typing: true } },
      channels: {
        weixin: { enabled: true, allowFrom: [SENDER] },
      },
    },
  });
  const backend = makeBackend();
  const adapter = createWeixinAdapter({
    fetch: backend.fetchImpl,
    credentialsCheckIntervalMs: 20,
  });
  const channelStateDir = join(stateDir, 'channels', 'weixin');
  if (options.seed !== false) {
    writeCredential(channelStateDir, config.channels.weixin, {
      version: 1,
      token: 'test-bot-token',
      ilinkBotId: BOT_ID,
      userId: SENDER,
      baseUrl: 'https://ilinkai.weixin.qq.com',
      savedAt: new Date().toISOString(),
    });
  }
  const gateway = createGateway({
    config,
    adapters: { weixin: adapter },
    logger: silentLogger,
  });
  await gateway.start();
  return {
    runDir,
    config,
    configPath,
    stateDir,
    channelStateDir,
    backend,
    adapter,
    gateway,
    async close() {
      await gateway.stop();
      runDir.cleanup();
    },
  };
}

function sendMessages(backend) {
  return backend.calls.filter((call) => call.url.includes('/ilink/bot/sendmessage'));
}

test('weixin e2e: long-poll inbound -> fake DSH -> sendmessage reply', async (t) => {
  const ctx = await bootWeixin();
  t.after(async () => ctx.close());

  await waitFor(() => sendMessages(ctx.backend).length > 0, { timeoutMs: 8000, description: 'weixin sendmessage' });
  const sent = sendMessages(ctx.backend)[0].body;
  assert.equal(sent.msg.to_user_id, SENDER);
  assert.equal(sent.msg.message_type, 2);
  assert.equal(sent.msg.message_state, 2);
  assert.equal(sent.msg.context_token, CONTEXT_TOKEN);
  assert.equal(sent.msg.item_list[0].type, 1);
  assert.equal(sent.msg.item_list[0].text_item.text, '微信 e2e 回复');
  assert.ok(sent.msg.client_id.length > 0);
  assert.equal(sent.base_info.bot_agent, 'dsh-im-manager');

  // Headers follow the iLink protocol (no token in logs, bearer on bot calls).
  const sendCall = sendMessages(ctx.backend)[0];
  assert.equal(sendCall.headers.Authorization, 'Bearer test-bot-token');
  assert.equal(sendCall.headers['iLink-App-Id'], 'bot');
  assert.ok(sendCall.headers['X-WECHAT-UIN']);

  // The runtime captured a real session for this conversation.
  const status = await ctx.gateway.status();
  assert.equal(status.channels.weixin.state, 'connected');
  assert.equal(status.sessions, 1);
});

test('weixin e2e: typing indicator is best-effort around the turn', async (t) => {
  const ctx = await bootWeixin();
  t.after(async () => ctx.close());
  await waitFor(() => sendMessages(ctx.backend).length > 0, { timeoutMs: 8000, description: 'weixin reply' });
  const typing = ctx.backend.calls.filter((call) => call.url.includes('/ilink/bot/sendtyping'));
  assert.ok(typing.length >= 1, 'expected at least one sendtyping call');
  assert.equal(typing[0].body.ilink_user_id, SENDER);
  assert.equal(typing[0].body.typing_ticket, 'typing-ticket');
  assert.equal(typing[0].body.status, 1);
  await waitFor(
    () => ctx.backend.calls.some((call) => call.url.includes('/ilink/bot/sendtyping') && call.body.status === 2),
    { timeoutMs: 4000, description: 'typing cancel' },
  );
});

test('weixin e2e: credential written while running starts the monitor', async (t) => {
  const ctx = await bootWeixin({ seed: false });
  t.after(async () => ctx.close());

  await waitFor(() => ctx.gateway.status().then((status) => status.channels.weixin.state === 'disconnected'), {
    timeoutMs: 3000,
    description: 'disconnected before login',
  });
  assert.equal(existsSync(credentialPath(ctx.channelStateDir, ctx.config.channels.weixin)), false);

  writeCredential(ctx.channelStateDir, ctx.config.channels.weixin, {
    version: 1,
    token: 'test-bot-token',
    ilinkBotId: BOT_ID,
    userId: SENDER,
    baseUrl: 'https://ilinkai.weixin.qq.com',
    savedAt: new Date().toISOString(),
  });

  await waitFor(() => sendMessages(ctx.backend).length > 0, {
    timeoutMs: 8000,
    description: 'reply after hot login',
  });
  assert.equal(sendMessages(ctx.backend)[0].body.msg.to_user_id, SENDER);
});

test('weixin CLI: status/logout reflect the credential file', async () => {
  const runDir = createRunDir('weixin-cli');
  try {
    const { configPath, stateDir } = writeTestConfig({
      runDir: runDir.dir,
      overrides: { channels: { weixin: { enabled: true } } },
    });
    const bin = join(PACKAGE_ROOT, 'bin', 'dsh-im-manager.js');
    const run = async (...args) => {
      try {
        const result = await execFileAsync(process.execPath, [bin, ...args], { env: { ...process.env } });
        return { code: 0, stdout: result.stdout, stderr: result.stderr };
      } catch (error) {
        return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
      }
    };

    const before = await run('weixin', 'status', '--config', configPath);
    assert.equal(before.code, 1);
    assert.match(before.stdout, /未登录/);

    writeCredential(join(stateDir, 'channels', 'weixin'), { credentialsFile: '' }, {
      version: 1,
      token: 'test-bot-token',
      ilinkBotId: BOT_ID,
      userId: SENDER,
      baseUrl: 'https://ilinkai.weixin.qq.com',
      savedAt: '2026-01-01T00:00:00.000Z',
    });

    const after = await run('weixin', 'status', '--config', configPath);
    assert.equal(after.code, 0);
    assert.match(after.stdout, new RegExp(BOT_ID.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(after.stdout, /test-bot-token/);

    const logout = await run('weixin', 'logout', '--config', configPath);
    assert.equal(logout.code, 0);
    assert.match(logout.stdout, /已删除/);
    assert.equal(existsSync(credentialPath(join(stateDir, 'channels', 'weixin'), { credentialsFile: '' })), false);
  } finally {
    runDir.cleanup();
  }
});
