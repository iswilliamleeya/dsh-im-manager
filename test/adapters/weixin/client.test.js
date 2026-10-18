/**
 * iLink client: request shape, headers, envelope errors (-14), long-poll
 * timeout tolerance, base-URL trust, fetch transport.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';

import {
  ILinkClient,
  StaleTokenError,
  WeixinAbortError,
  WeixinError,
  WeixinHttpError,
  WeixinProtocolError,
  WeixinTimeoutError,
  createFetchTransport,
} from '../../../src/adapters/weixin/client.js';
import { jsonResponse, makeFetch, makeTransport, pendingUntilAborted } from './helpers.js';

const BASE = 'https://ilinkai.weixin.qq.com';

/** @param {Parameters<typeof makeTransport>[0]} responder @param {Record<string, any>} [overrides] */
function makeClient(responder, overrides = {}) {
  const { calls, transport } = makeTransport(responder);
  const client = new ILinkClient({
    baseUrl: BASE,
    token: 'bot-token-value',
    transport,
    rand: () => 0.5,
    ...overrides,
  });
  return { client, calls };
}

/** Decode the X-WECHAT-UIN header back to its uint32. */
function decodeUin(header) {
  const decimal = Buffer.from(header, 'base64').toString('utf8');
  assert.match(decimal, /^\d+$/);
  return Number(decimal);
}

test('constructor rejects non-https base URLs', () => {
  assert.throws(() => new ILinkClient({ baseUrl: 'http://ilinkai.weixin.qq.com' }), /must use https/);
  assert.throws(() => new ILinkClient({ baseUrl: '' }), /non-empty https/);
});

test('setBaseUrl accepts official hosts and the configured host, rejects others', () => {
  const { client } = makeClient(() => ({}));
  assert.equal(client.setBaseUrl('https://idc.weixin.qq.com/'), 'https://idc.weixin.qq.com');
  client.setBaseUrl(BASE);
  assert.throws(() => client.setBaseUrl('https://evil.example.com'), /not trusted/);
  assert.throws(() => client.setBaseUrl('http://ilinkai.weixin.qq.com'), /must use https/);

  const custom = new ILinkClient({ baseUrl: 'https://gateway.internal.example' });
  assert.equal(custom.setBaseUrl('https://gateway.internal.example'), 'https://gateway.internal.example');
});

test('sendMessage posts the documented payload with full headers and base_info', async () => {
  const { client, calls } = makeClient(() => ({ ret: 0, errmsg: '' }));
  const payload = {
    msg: {
      from_user_id: '',
      to_user_id: 'wxid-peer@im.wechat',
      client_id: 'client-1',
      message_type: 2,
      message_state: 2,
      context_token: 'ctx-1',
      item_list: [{ type: 1, text_item: { text: 'hello' } }],
    },
  };
  await client.sendMessage(payload);
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call.method, 'POST');
  assert.equal(call.url, `${BASE}/ilink/bot/sendmessage`);
  assert.deepEqual(call.body, { msg: payload.msg, base_info: { channel_version: '0.1.0', bot_agent: 'dsh-im-manager' } });
  assert.equal(call.headers['Content-Type'], 'application/json');
  assert.equal(call.headers.AuthorizationType, 'ilink_bot_token');
  assert.equal(call.headers.Authorization, 'Bearer bot-token-value');
  assert.equal(call.headers['iLink-App-Id'], 'bot');
  assert.equal(call.headers['iLink-App-ClientVersion'], '256');
  const uin = decodeUin(call.headers['X-WECHAT-UIN']);
  assert.equal(uin, 2147483648);
});

test('sendMessage rejects malformed payloads without network I/O', async () => {
  const { client, calls } = makeClient(() => ({ ret: 0 }));
  await assert.rejects(client.sendMessage({}), TypeError);
  await assert.rejects(client.sendMessage({ msg: 'nope' }), TypeError);
  assert.equal(calls.length, 0);
});

test('getUpdates sends cursor + base_info and parses the response', async () => {
  const { client, calls } = makeClient(() => ({
    ret: 0,
    msgs: [{ message_id: 1 }],
    get_updates_buf: 'cursor-2',
    longpolling_timeout_ms: 5000,
  }));
  const result = await client.getUpdates({ getUpdatesBuf: 'cursor-1', longPollTimeoutMs: 5000 });
  assert.deepEqual(result, {
    msgs: [{ message_id: 1 }],
    get_updates_buf: 'cursor-2',
    longpolling_timeout_ms: 5000,
    timedOut: false,
  });
  assert.equal(calls[0].url, `${BASE}/ilink/bot/getupdates`);
  assert.deepEqual(calls[0].body, {
    get_updates_buf: 'cursor-1',
    base_info: { channel_version: '0.1.0', bot_agent: 'dsh-im-manager' },
  });
  assert.equal(calls[0].timeoutMs, 5000);
});

test('getUpdates tolerates a client-side long-poll timeout', async () => {
  const { client } = makeClient((call) => pendingUntilAborted(call), { longPollTimeoutMs: 15 });
  const result = await client.getUpdates({ getUpdatesBuf: 'keep-me' });
  assert.equal(result.timedOut, true);
  assert.deepEqual(result.msgs, []);
  assert.equal(result.get_updates_buf, 'keep-me');
});

test('getUpdates maps ret/errcode -14 to StaleTokenError', async () => {
  for (const response of [{ ret: -14 }, { errcode: -14, errmsg: 'session stale' }]) {
    const { client } = makeClient(() => response);
    await assert.rejects(client.getUpdates({}), (error) => {
      assert.ok(error instanceof StaleTokenError);
      assert.equal(error.name, 'StaleTokenError');
      assert.equal(error.code, 'WEIXIN_STALE_TOKEN');
      assert.match(error.message, /-14/);
      assert.ok(!error.message.includes('bot-token-value'));
      return true;
    });
  }
});

test('non-zero ret/errcode throws a typed error with the code', async () => {
  const { client } = makeClient(() => ({ ret: 7, errmsg: 'bad request' }));
  await assert.rejects(client.getUpdates({}), (error) => {
    assert.ok(error instanceof WeixinError);
    assert.equal(error.ret, 7);
    assert.match(error.message, /ret=7/);
    assert.match(error.message, /bad request/);
    return true;
  });

  const { client: errcodeClient } = makeClient(() => ({ errcode: 9 }));
  await assert.rejects(errcodeClient.notifyStart(), /errcode=9/);
});

test('getBotQrcode uses bot_type=3, local_token_list and no Authorization header', async () => {
  const { client, calls } = makeClient(() => ({ qrcode: 'qr-1', qrcode_img_content: 'https://weixin.qq.com/qr/qr-1' }));
  const result = await client.getBotQrcode({ localTokens: ['old-token', '', 'old-token', 'second-token'] });
  assert.deepEqual(result, { qrcode: 'qr-1', qrcode_img_content: 'https://weixin.qq.com/qr/qr-1' });
  const call = calls[0];
  assert.equal(call.method, 'POST');
  assert.ok(call.url.startsWith(`${BASE}/ilink/bot/get_bot_qrcode?bot_type=3`));
  assert.deepEqual(call.body, { local_token_list: ['old-token', 'second-token'] });
  assert.equal(call.headers.Authorization, undefined);
  assert.equal(call.headers.AuthorizationType, 'ilink_bot_token');
  assert.equal(call.headers['iLink-App-Id'], 'bot');
});

test('getBotQrcode rejects a response without a qrcode', async () => {
  const { client } = makeClient(() => ({ qrcode_img_content: 'url-only' }));
  await assert.rejects(client.getBotQrcode(), WeixinProtocolError);
});

test('getQrcodeStatus is a GET with application headers only', async () => {
  const { client, calls } = makeClient(() => ({ status: 'confirmed', bot_token: 't', ilink_bot_id: 'b' }));
  const result = await client.getQrcodeStatus({ qrcode: 'qr+value/=', verifyCode: '123456' });
  assert.equal(result.status, 'confirmed');
  const call = calls[0];
  assert.equal(call.method, 'GET');
  assert.ok(call.url.startsWith(`${BASE}/ilink/bot/get_qrcode_status?`));
  const url = new URL(call.url);
  assert.equal(url.searchParams.get('qrcode'), 'qr+value/=');
  assert.equal(url.searchParams.get('verify_code'), '123456');
  assert.deepEqual(Object.keys(call.headers).sort(), ['iLink-App-ClientVersion', 'iLink-App-Id']);
  assert.equal(call.headers.Authorization, undefined);
  assert.equal(call.headers.AuthorizationType, undefined);
  assert.equal(call.headers['X-WECHAT-UIN'], undefined);
});

test('getQrcodeStatus maps a long-poll timeout to wait', async () => {
  const { client } = makeClient((call) => pendingUntilAborted(call), { qrPollTimeoutMs: 15 });
  const result = await client.getQrcodeStatus({ qrcode: 'qr-1' });
  assert.deepEqual(result, { status: 'wait' });
});

test('getQrcodeStatus maps ret=-14 to StaleTokenError', async () => {
  const { client } = makeClient(() => ({ ret: -14 }));
  await assert.rejects(client.getQrcodeStatus({ qrcode: 'qr-1' }), StaleTokenError);
});

test('getConfig and sendTyping use the documented bodies', async () => {
  const { client, calls } = makeClient((call) => {
    if (call.url.includes('getconfig')) return { ret: 0, typing_ticket: 'ticket-1' };
    return { ret: 0 };
  });
  const config = await client.getConfig({ ilinkUserId: 'user-1', contextToken: 'ctx-1' });
  assert.equal(config.typing_ticket, 'ticket-1');
  await client.sendTyping({ ilinkUserId: 'user-1', typingTicket: 'ticket-1', status: 1 });
  assert.deepEqual(calls[0].body, {
    ilink_user_id: 'user-1',
    context_token: 'ctx-1',
    base_info: { channel_version: '0.1.0', bot_agent: 'dsh-im-manager' },
  });
  assert.deepEqual(calls[1].body, {
    ilink_user_id: 'user-1',
    typing_ticket: 'ticket-1',
    status: 1,
    base_info: { channel_version: '0.1.0', bot_agent: 'dsh-im-manager' },
  });
  assert.equal(calls[0].url, `${BASE}/ilink/bot/getconfig`);
  assert.equal(calls[1].url, `${BASE}/ilink/bot/sendtyping`);
});

test('notifyStart/notifyStop send only base_info and are best-effort shaped', async () => {
  const { client, calls } = makeClient(() => ({ ret: 0 }));
  await client.notifyStart();
  await client.notifyStop();
  assert.equal(calls[0].url, `${BASE}/ilink/bot/msg/notifystart`);
  assert.equal(calls[1].url, `${BASE}/ilink/bot/msg/notifystop`);
  assert.deepEqual(calls[0].body, { base_info: { channel_version: '0.1.0', bot_agent: 'dsh-im-manager' } });
});

test('external abort surfaces as WeixinAbortError', async () => {
  const controller = new AbortController();
  const { client } = makeClient(() => ({ ret: 0 }));
  controller.abort();
  await assert.rejects(client.getUpdates({ signal: controller.signal }), (error) => {
    assert.ok(error instanceof WeixinAbortError);
    assert.equal(error.code, 'WEIXIN_ABORTED');
    return true;
  });
});

test('network errors are wrapped, redacted and never include the token', async () => {
  const { client } = makeClient(() => Object.assign(new Error('socket said Bearer bot-token-value'), { code: 'ECONNRESET' }));
  await assert.rejects(client.getUpdates({}), (error) => {
    assert.ok(error instanceof WeixinError);
    assert.match(error.message, /请求失败/);
    assert.ok(!error.message.includes('bot-token-value'));
    assert.match(error.message, /<redacted>/);
    return true;
  });
});

test('a non-object response body is a protocol error', async () => {
  const { client } = makeClient(() => 'not-an-object');
  await assert.rejects(client.sendMessage({ msg: {} }), WeixinProtocolError);
});

test('custom token and routeTag change the headers', async () => {
  const { client, calls } = makeClient(() => ({ ret: 0 }), { token: 'first-token', routeTag: 'sz' });
  client.setToken('second-token');
  await client.notifyStop();
  assert.equal(calls[0].headers.Authorization, 'Bearer second-token');
  assert.equal(calls[0].headers.SKRouteTag, 'sz');
});

test('fetch transport parses JSON, rejects HTTP errors and invalid JSON', async () => {
  const { fetchImpl: okFetch } = makeFetch(() => ({ ret: 0 }));
  const transport = createFetchTransport({ fetchImpl: okFetch });
  const { client } = makeClient(() => ({ ret: 0 }), { transport, baseUrl: BASE });
  client.transport = transport;
  assert.deepEqual(await client.notifyStart(), { ret: 0 });

  const { fetchImpl: httpErrorFetch } = makeFetch(() => jsonResponse({ ret: 0 }, 503));
  const errorTransport = createFetchTransport({ fetchImpl: httpErrorFetch });
  await assert.rejects(errorTransport.request(`${BASE}/x`), (error) => {
    assert.ok(error instanceof WeixinHttpError);
    assert.equal(error.status, 503);
    return true;
  });

  const invalidJsonFetch = async () => ({ ok: true, status: 200, text: async () => '<html>' });
  const invalidTransport = createFetchTransport({ fetchImpl: invalidJsonFetch });
  await assert.rejects(invalidTransport.request(`${BASE}/x`), WeixinProtocolError);

  const emptyFetch = async () => ({ ok: true, status: 200, text: async () => '' });
  const emptyTransport = createFetchTransport({ fetchImpl: emptyFetch });
  assert.deepEqual(await emptyTransport.request(`${BASE}/x`), {});
});

test('fetch transport works against a real local HTTP server', async () => {
  /** @type {{ method?: string, url?: string, headers?: Record<string, string>, body: string }[]} */
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      if (req.url === '/fail') {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end('{"ret":-1,"errmsg":"server error"}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ret: 0, echo: JSON.parse(body || '{}') }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = /** @type {{ port: number }} */ (server.address());
  const transport = createFetchTransport();
  try {
    const response = await transport.request(`http://127.0.0.1:${address.port}/ok`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: { hello: 'world' },
    });
    assert.deepEqual(response, { ret: 0, echo: { hello: 'world' } });
    assert.equal(seen[0].method, 'POST');
    assert.equal(seen[0].url, '/ok');

    await assert.rejects(
      transport.request(`http://127.0.0.1:${address.port}/fail`, { method: 'POST', body: {} }),
      (error) => {
        assert.ok(error instanceof WeixinHttpError);
        assert.equal(error.status, 500);
        return true;
      },
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
