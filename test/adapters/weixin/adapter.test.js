/**
 * Adapter lifecycle: credential watcher (unauthenticated start, auto-start on
 * QR login, logout), -14 handling, send payload/context-token, typing,
 * idempotent stop, health details, config validation.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import adapterDefault, { createWeixinAdapter, validateConfig } from '../../../src/adapters/weixin/index.js';
import { writeCredential } from '../../../src/adapters/weixin/credentials.js';
import {
  cleanupDir,
  makeAdapterCtx,
  makeLogger,
  makeTempDir,
  pendingUntilAborted,
  seedCredential,
  textMessage,
  waitFor,
} from './helpers.js';

const BASE = 'https://ilinkai.weixin.qq.com';
const CDN = 'https://novac2c.cdn.weixin.qq.com/c2c';
const LOGIN_HINT = '未登录，运行 dsh-im-manager weixin login';

/** @param {Record<string, unknown>} [overrides] */
function adapterConfig(overrides = {}) {
  return {
    enabled: true,
    accountId: 'weixin',
    mode: 'ilink',
    baseUrl: BASE,
    cdnBaseUrl: CDN,
    credentialsFile: '',
    requestTimeoutMs: 5_000,
    longPollTimeoutMs: 5_000,
    reconnect: { enabled: true, baseDelayMs: 20, maxDelayMs: 100 },
    typing: true,
    botAgent: 'dsh-im-manager',
    allowFrom: [],
    groups: {},
    credentialsCheckIntervalMs: 20,
    ...overrides,
  };
}

/**
 * Fake transport with per-endpoint hooks. Unhooked `getupdates` stays pending
 * until aborted, which is exactly the real long-poll shape.
 */
function makeHarness(hooks = {}) {
  /** @type {{ url: string, method: string, headers: Record<string, string>, body?: any, signal?: AbortSignal }[]} */
  const calls = [];
  const transport = {
    async request(url, init = {}) {
      const call = {
        url: String(url),
        method: String(init.method ?? 'GET'),
        headers: /** @type {Record<string, string>} */ ({ ...(init.headers ?? {}) }),
        body: init.body,
        signal: init.signal,
      };
      calls.push(call);
      const route = call.url;
      if (route.includes('/ilink/bot/getupdates')) {
        return hooks.getUpdates ? hooks.getUpdates(call, calls) : pendingUntilAborted(call);
      }
      if (route.includes('/ilink/bot/msg/notifystart') || route.includes('/ilink/bot/msg/notifystop')) {
        return hooks.notify ? hooks.notify(call) : { ret: 0 };
      }
      if (route.includes('/ilink/bot/sendmessage')) {
        return hooks.sendMessage ? hooks.sendMessage(call) : { ret: 0 };
      }
      if (route.includes('/ilink/bot/getconfig')) {
        return hooks.getConfig ? hooks.getConfig(call) : { ret: 0, typing_ticket: 'typing-ticket-1' };
      }
      if (route.includes('/ilink/bot/sendtyping')) {
        return hooks.sendTyping ? hooks.sendTyping(call) : { ret: 0 };
      }
      return { ret: 0 };
    },
  };
  return { calls, transport };
}

/**
 * Start the adapter against a temp state dir.
 * @param {{ dir: string, config?: Record<string, any>, transport?: unknown, controller?: AbortController, logger?: any, deps?: Record<string, any> }} options
 */
async function startAdapter(options) {
  const adapter = createWeixinAdapter({
    ...(options.transport ? { transport: options.transport } : {}),
    credentialsCheckIntervalMs: 20,
    ...(options.deps ?? {}),
  });
  const logger = options.logger ?? makeLogger();
  const { ctx, controller } = makeAdapterCtx({
    config: adapterConfig(options.config ?? {}),
    stateDir: options.dir,
    ...(options.controller ? { controller: options.controller } : {}),
    log: logger.log,
  });
  await adapter.start(ctx);
  return { adapter, ctx, controller, logger };
}

/** Calls to one endpoint. */
function callsTo(calls, fragment) {
  return calls.filter((call) => call.url.includes(fragment));
}

test('default export satisfies the adapter contract shape', () => {
  assert.equal(adapterDefault.id, 'weixin');
  assert.equal(typeof adapterDefault.start, 'function');
  assert.equal(typeof adapterDefault.stop, 'function');
  assert.equal(typeof adapterDefault.send, 'function');
  assert.equal(typeof adapterDefault.startTyping, 'function');
  assert.equal(typeof adapterDefault.stopTyping, 'function');
  assert.equal(typeof adapterDefault.health, 'function');
  assert.deepEqual(adapterDefault.capabilities, {
    text: true,
    markdown: false,
    media: false,
    streaming: false,
    typing: true,
    threads: false,
  });
});

test('validateConfig accepts ilink and rejects other modes clearly', () => {
  assert.doesNotThrow(() => validateConfig(adapterConfig()));
  assert.throws(() => validateConfig(adapterConfig({ mode: 'mp' })), /mode must be 'ilink'/);
  assert.throws(() => validateConfig(adapterConfig({ baseUrl: 'http://ilinkai.weixin.qq.com' })), /must use https/);
  assert.throws(() => validateConfig(adapterConfig({ reconnect: { enabled: true, baseDelayMs: 10, maxDelayMs: 5 } })), /baseDelayMs/);
  assert.doesNotThrow(() => validateConfig(adapterConfig({ media: { download: false } })));
  // Invalid numbers are normalized to safe defaults rather than rejected.
  assert.doesNotThrow(() => validateConfig(adapterConfig({ media: { maxBytes: 0 } })));
});

test('start rejects invalid mode and missing context pieces without leaking secrets', async () => {
  const dir = makeTempDir();
  try {
    const adapter = createWeixinAdapter({ transport: makeHarness().transport });
    const { ctx } = makeAdapterCtx({ config: adapterConfig({ mode: 'mp' }), stateDir: dir });
    await assert.rejects(adapter.start(ctx), /mode must be 'ilink'/);

    const goodAdapter = createWeixinAdapter();
    await assert.rejects(
      (async () => {
        const { ctx: badCtx } = makeAdapterCtx({ config: adapterConfig(), stateDir: dir });
        delete badCtx.emit;
        await goodAdapter.start(badCtx);
      })(),
      /ctx\.emit/,
    );
    await assert.rejects(
      (async () => {
        const { ctx: noStateCtx } = makeAdapterCtx({ config: adapterConfig(), stateDir: dir });
        delete noStateCtx.stateDir;
        await goodAdapter.start(noStateCtx);
      })(),
      /stateDir/,
    );
  } finally {
    cleanupDir(dir);
  }
});

test('start without credentials does not throw and reports the login hint', async () => {
  const dir = makeTempDir();
  try {
    const { calls, transport } = makeHarness();
    const { adapter } = await startAdapter({ dir, transport });
    try {
      const health = await adapter.health();
      assert.equal(health.state, 'disconnected');
      assert.match(health.detail, new RegExp(LOGIN_HINT));
      assert.equal(calls.length, 0, 'no network I/O before login');
      assert.equal(adapter.credentialPath(), join(dir, 'credentials.json'));
    } finally {
      await adapter.stop();
    }
  } finally {
    cleanupDir(dir);
  }
});

test('start with a credential connects the long-poll loop and reports ilinkBotId', async () => {
  const dir = makeTempDir();
  try {
    seedCredential(dir, {});
    const { calls, transport } = makeHarness();
    const { adapter, logger } = await startAdapter({ dir, transport });
    try {
      await waitFor(() => callsTo(calls, '/getupdates').length >= 1, { label: 'first poll' });
      const health = await adapter.health();
      assert.equal(health.state, 'connected');
      assert.match(health.detail, /ilinkBotId: bot-abc@im\.bot/);
      const poll = callsTo(calls, '/getupdates')[0];
      assert.equal(poll.headers.Authorization, 'Bearer test-bot-token-0123456789');
      assert.equal(poll.headers['iLink-App-Id'], 'bot');
      assert.deepEqual(poll.body.base_info, { channel_version: '0.1.0', bot_agent: 'dsh-im-manager' });
      assert.equal(callsTo(calls, '/notifystart').length, 1);
      assert.equal(logger.dump().includes('test-bot-token-0123456789'), false);
    } finally {
      await adapter.stop();
    }
    assert.equal(await adapter.health().then((health) => health.state), 'disconnected');
  } finally {
    cleanupDir(dir);
  }
});

test('stop is idempotent and sends notifystop once', async () => {
  const dir = makeTempDir();
  try {
    seedCredential(dir, {});
    const { calls, transport } = makeHarness();
    const { adapter } = await startAdapter({ dir, transport });
    await waitFor(() => callsTo(calls, '/getupdates').length >= 1, { label: 'first poll' });
    await adapter.stop();
    await adapter.stop();
    await adapter.stop();
    assert.equal(callsTo(calls, '/notifystop').length, 1);
    assert.equal((await adapter.health()).state, 'disconnected');
  } finally {
    cleanupDir(dir);
  }
});

test('a credential written after start starts the monitor automatically (QR login while serving)', async () => {
  const dir = makeTempDir();
  try {
    const { calls, transport } = makeHarness();
    const { adapter } = await startAdapter({ dir, transport });
    try {
      assert.match((await adapter.health()).detail, new RegExp(LOGIN_HINT));
      seedCredential(dir, {}, { token: 'fresh-token', ilinkBotId: 'fresh-bot@im.bot' });
      await waitFor(() => callsTo(calls, '/getupdates').length >= 1, { label: 'auto-start poll' });
      const health = await adapter.health();
      assert.equal(health.state, 'connected');
      assert.match(health.detail, /fresh-bot@im\.bot/);
      assert.equal(callsTo(calls, '/getupdates')[0].headers.Authorization, 'Bearer fresh-token');
    } finally {
      await adapter.stop();
    }
  } finally {
    cleanupDir(dir);
  }
});

test('removing the credential stops the monitor and reports logged out', async () => {
  const dir = makeTempDir();
  try {
    seedCredential(dir, {});
    const { calls, transport } = makeHarness();
    const { adapter } = await startAdapter({ dir, transport });
    try {
      await waitFor(() => callsTo(calls, '/getupdates').length >= 1, { label: 'first poll' });
      assert.equal((await adapter.health()).state, 'connected');
      const { deleteCredential } = await import('../../../src/adapters/weixin/credentials.js');
      deleteCredential(dir, {});
      await waitFor(async () => (await adapter.health()).state === 'disconnected', { label: 'logged out' });
      assert.match((await adapter.health()).detail, new RegExp(LOGIN_HINT));
      await waitFor(() => callsTo(calls, '/notifystop').length >= 1, { label: 'notifystop' });
    } finally {
      await adapter.stop();
    }
  } finally {
    cleanupDir(dir);
  }
});

test('rotating the credential restarts the monitor with the new token', async () => {
  const dir = makeTempDir();
  try {
    seedCredential(dir, {}, { token: 'token-one', ilinkBotId: 'bot-one@im.bot' });
    const { calls, transport } = makeHarness();
    const { adapter } = await startAdapter({ dir, transport });
    try {
      await waitFor(() => callsTo(calls, '/getupdates').length >= 1, { label: 'first poll' });
      await new Promise((resolve) => setTimeout(resolve, 15));
      seedCredential(dir, {}, { token: 'token-two', ilinkBotId: 'bot-two@im.bot' });
      await waitFor(
        () => callsTo(calls, '/getupdates').some((call) => call.headers.Authorization === 'Bearer token-two'),
        { label: 'restart with new token' },
      );
      assert.match((await adapter.health()).detail, /bot-two@im\.bot/);
    } finally {
      await adapter.stop();
    }
  } finally {
    cleanupDir(dir);
  }
});

test('a -14 token marks the channel logged out without exiting the process', async () => {
  const dir = makeTempDir();
  try {
    seedCredential(dir, {});
    let polls = 0;
    const { calls, transport } = makeHarness({
      getUpdates: (call) => {
        polls += 1;
        if (polls === 1) return { ret: -14, errmsg: 'session stale' };
        return pendingUntilAborted(call);
      },
    });
    const { adapter, logger } = await startAdapter({ dir, transport });
    try {
      await waitFor(async () => /-14/.test((await adapter.health()).detail), { label: 'stale health' });
      const health = await adapter.health();
      assert.equal(health.state, 'disconnected');
      assert.match(health.detail, /-14/);
      assert.match(health.detail, /weixin login/);
      await assert.rejects(adapter.send({ conversationId: 'u' }, { text: 'hi' }), /-14/);
      assert.equal(logger.dump().includes('test-bot-token-0123456789'), false);
    } finally {
      await adapter.stop();
    }
  } finally {
    cleanupDir(dir);
  }
});

test('send posts sendmessage with the stored context_token and returns client_id', async () => {
  const dir = makeTempDir();
  try {
    seedCredential(dir, {});
    const inbound = textMessage({ context_token: 'ctx-for-reply' });
    const { calls, transport } = makeHarness({
      getUpdates: (call, all) => {
        if (callsTo(all, '/getupdates').length === 1) {
          return { ret: 0, msgs: [inbound], get_updates_buf: 'cursor-1' };
        }
        return pendingUntilAborted(call);
      },
      sendMessage: () => ({ ret: 0, errmsg: '' }),
    });
    const logger = makeLogger();
    const { adapter } = await startAdapter({ dir, transport, logger });
    try {
      await waitFor(() => existsSync(join(dir, 'context-tokens.json')), { label: 'context token persisted' });
      const result = await adapter.send(
        { channel: 'weixin', accountId: 'weixin', conversationId: 'wxid-alice@im.wechat', conversationType: 'dm' },
        { text: '收到的回复', format: 'plain' },
      );
      assert.ok(result.messageId);
      const call = callsTo(calls, '/sendmessage')[0];
      assert.ok(call);
      assert.equal(call.headers.Authorization, 'Bearer test-bot-token-0123456789');
      assert.equal(call.body.msg.to_user_id, 'wxid-alice@im.wechat');
      assert.equal(call.body.msg.from_user_id, '');
      assert.equal(call.body.msg.message_type, 2);
      assert.equal(call.body.msg.message_state, 2);
      assert.equal(call.body.msg.context_token, 'ctx-for-reply');
      assert.equal(call.body.msg.client_id, result.messageId);
      assert.deepEqual(call.body.msg.item_list, [{ type: 1, text_item: { text: '收到的回复' } }]);
      assert.deepEqual(call.body.base_info, { channel_version: '0.1.0', bot_agent: 'dsh-im-manager' });
      assert.equal(logger.dump().includes('ctx-for-reply'), false);
    } finally {
      await adapter.stop();
    }
  } finally {
    cleanupDir(dir);
  }
});

test('send degrades markdown to plain text', async () => {
  const dir = makeTempDir();
  try {
    seedCredential(dir, {});
    const { calls, transport } = makeHarness();
    const { adapter } = await startAdapter({ dir, transport });
    try {
      await waitFor(() => callsTo(calls, '/getupdates').length >= 1, { label: 'first poll' });
      await adapter.send({ conversationId: 'u-1' }, { text: '**粗体** 和 `代码`', format: 'markdown' });
      const call = callsTo(calls, '/sendmessage')[0];
      assert.equal(call.body.msg.item_list[0].text_item.text, '粗体 和 代码');
    } finally {
      await adapter.stop();
    }
  } finally {
    cleanupDir(dir);
  }
});

test('send before login throws with the login hint', async () => {
  const dir = makeTempDir();
  try {
    const { calls, transport } = makeHarness();
    const { adapter } = await startAdapter({ dir, transport });
    try {
      await assert.rejects(adapter.send({ conversationId: 'u' }, { text: 'hi' }), /未登录.*weixin login/);
    } finally {
      await adapter.stop();
    }
    assert.equal(callsTo(calls, '/sendmessage').length, 0);
  } finally {
    cleanupDir(dir);
  }
});

test('send with empty text is a no-op', async () => {
  const dir = makeTempDir();
  try {
    seedCredential(dir, {});
    const { calls, transport } = makeHarness();
    const { adapter } = await startAdapter({ dir, transport });
    try {
      await waitFor(() => callsTo(calls, '/getupdates').length >= 1, { label: 'first poll' });
      assert.deepEqual(await adapter.send({ conversationId: 'u' }, { text: '   ' }), {});
      assert.equal(callsTo(calls, '/sendmessage').length, 0);
    } finally {
      await adapter.stop();
    }
  } finally {
    cleanupDir(dir);
  }
});

test('send failure is a clear error without the bot token', async () => {
  const dir = makeTempDir();
  try {
    seedCredential(dir, {});
    const { calls, transport } = makeHarness({
      sendMessage: () => ({ ret: 500, errmsg: 'upstream rejected' }),
    });
    const { adapter, logger } = await startAdapter({ dir, transport });
    try {
      await waitFor(() => callsTo(calls, '/getupdates').length >= 1, { label: 'first poll' });
      await assert.rejects(adapter.send({ conversationId: 'u' }, { text: 'hi' }), (error) => {
        assert.match(error.message, /发送失败|返回错误/);
        assert.equal(error.message.includes('test-bot-token-0123456789'), false);
        return true;
      });
      assert.equal(logger.dump().includes('test-bot-token-0123456789'), false);
    } finally {
      await adapter.stop();
    }
  } finally {
    cleanupDir(dir);
  }
});

test('typing uses getconfig ticket then sendtyping status 1/2 with caching', async () => {
  const dir = makeTempDir();
  try {
    seedCredential(dir, {});
    const { calls, transport } = makeHarness();
    const { adapter } = await startAdapter({ dir, transport });
    try {
      await waitFor(() => callsTo(calls, '/getupdates').length >= 1, { label: 'first poll' });
      const target = { channel: 'weixin', accountId: 'weixin', conversationId: 'peer-1', conversationType: 'dm' };
      await adapter.startTyping(target);
      await adapter.stopTyping(target);

      const configCalls = callsTo(calls, '/getconfig');
      const typingCalls = callsTo(calls, '/sendtyping');
      assert.equal(configCalls.length, 1, 'typing ticket is cached for 10 minutes');
      assert.equal(typingCalls.length, 2);
      assert.equal(configCalls[0].body.ilink_user_id, 'peer-1');
      assert.deepEqual(typingCalls[0].body, {
        ilink_user_id: 'peer-1',
        typing_ticket: 'typing-ticket-1',
        status: 1,
        base_info: { channel_version: '0.1.0', bot_agent: 'dsh-im-manager' },
      });
      assert.equal(typingCalls[1].body.status, 2);
    } finally {
      await adapter.stop();
    }
  } finally {
    cleanupDir(dir);
  }
});

test('typing failures never break the main flow', async () => {
  const dir = makeTempDir();
  try {
    seedCredential(dir, {});
    const { calls, transport } = makeHarness({
      getConfig: () => {
        throw new Error('getconfig exploded');
      },
      sendTyping: () => {
        throw new Error('sendtyping exploded');
      },
    });
    const { adapter } = await startAdapter({ dir, transport });
    try {
      await waitFor(() => callsTo(calls, '/getupdates').length >= 1, { label: 'first poll' });
      await assert.doesNotReject(adapter.startTyping({ conversationId: 'peer-1' }));
      await assert.doesNotReject(adapter.stopTyping({ conversationId: 'peer-1' }));
    } finally {
      await adapter.stop();
    }
  } finally {
    cleanupDir(dir);
  }
});

test('typing is disabled by config.typing=false', async () => {
  const dir = makeTempDir();
  try {
    seedCredential(dir, {});
    const { calls, transport } = makeHarness();
    const { adapter } = await startAdapter({ dir, transport, config: { typing: false } });
    try {
      await waitFor(() => callsTo(calls, '/getupdates').length >= 1, { label: 'first poll' });
      await adapter.startTyping({ conversationId: 'peer-1' });
      await adapter.stopTyping({ conversationId: 'peer-1' });
      assert.equal(callsTo(calls, '/getconfig').length, 0);
      assert.equal(callsTo(calls, '/sendtyping').length, 0);
    } finally {
      await adapter.stop();
    }
  } finally {
    cleanupDir(dir);
  }
});

test('custom credentialsFile is used and corrupt files count as logged out', async () => {
  const dir = makeTempDir();
  try {
    const config = { credentialsFile: 'secrets/wx.json' };
    const { calls, transport } = makeHarness();
    const { adapter } = await startAdapter({ dir, transport, config });
    try {
      assert.equal(adapter.credentialPath(), join(dir, 'secrets/wx.json'));
      seedCredential(dir, config);
      await waitFor(() => callsTo(calls, '/getupdates').length >= 1, { label: 'custom credential poll' });
      assert.equal((await adapter.health()).state, 'connected');
    } finally {
      await adapter.stop();
    }
  } finally {
    cleanupDir(dir);
  }

  const dir2 = makeTempDir();
  try {
    writeFileSync(join(dir2, 'credentials.json'), '{broken json', { mode: 0o600 });
    const { calls, transport } = makeHarness();
    const { adapter } = await startAdapter({ dir: dir2, transport });
    try {
      assert.match((await adapter.health()).detail, new RegExp(LOGIN_HINT));
      assert.equal(calls.length, 0);
    } finally {
      await adapter.stop();
    }
  } finally {
    cleanupDir(dir2);
  }
});

test('ctx.signal abort stops the adapter', async () => {
  const dir = makeTempDir();
  try {
    seedCredential(dir, {});
    const controller = new AbortController();
    const { calls, transport } = makeHarness();
    const { adapter } = await startAdapter({ dir, transport, controller });
    try {
      await waitFor(() => callsTo(calls, '/getupdates').length >= 1, { label: 'first poll' });
      controller.abort();
      await waitFor(async () => (await adapter.health()).state === 'disconnected', { label: 'aborted' });
      await waitFor(() => callsTo(calls, '/notifystop').length >= 1, { label: 'notifystop' });
    } finally {
      await adapter.stop();
    }
  } finally {
    cleanupDir(dir);
  }
});

test('adapter never registers HTTP routes', async () => {
  const dir = makeTempDir();
  try {
    const adapter = createWeixinAdapter({ transport: makeHarness().transport });
    const { ctx } = makeAdapterCtx({ config: adapterConfig(), stateDir: dir });
    let routeRegistrations = 0;
    ctx.http.route = () => {
      routeRegistrations += 1;
    };
    await adapter.start(ctx);
    try {
      assert.equal(routeRegistrations, 0);
    } finally {
      await adapter.stop();
    }
  } finally {
    cleanupDir(dir);
  }
});

test('monitor round-trip: inbound message reaches ctx.emit', async () => {
  const dir = makeTempDir();
  try {
    seedCredential(dir, {});
    const inbound = textMessage({ message_id: 9001 });
    const emitted = [];
    const { calls, transport } = makeHarness({
      getUpdates: (call, all) => {
        if (callsTo(all, '/getupdates').length === 1) {
          return { ret: 0, msgs: [inbound], get_updates_buf: 'cursor-1' };
        }
        return pendingUntilAborted(call);
      },
    });
    const adapter = createWeixinAdapter({ transport, credentialsCheckIntervalMs: 20 });
    const logger = makeLogger();
    const { ctx } = makeAdapterCtx({
      config: adapterConfig(),
      stateDir: dir,
      emit: async (message) => emitted.push(message),
      log: logger.log,
    });
    await adapter.start(ctx);
    try {
      await waitFor(() => emitted.length === 1, { label: 'inbound emit' });
      assert.equal(emitted[0].messageId, 'wx-9001');
      assert.equal(emitted[0].channel, 'weixin');
      assert.equal(emitted[0].conversationId, 'wxid-alice@im.wechat');
    } finally {
      await adapter.stop();
    }
  } finally {
    cleanupDir(dir);
  }
});
