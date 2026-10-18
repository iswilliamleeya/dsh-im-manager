/**
 * End-to-end: real gateway + real WeCom (企业微信) adapter in webhook mode +
 * real DSH bridge against the fake runtime.
 *
 * Inbound: AES-encrypted XML callbacks posted into the gateway's HTTP host,
 * built with the adapter's own WeCom crypto implementation (same algorithm the
 * platform uses).
 * Outbound: app message API (`cgi-bin/gettoken` + `cgi-bin/message/send`) is
 * pointed at a local fake server, which captures the exact request body.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { encryptWecomMessage } from '../../src/adapters/wecom/crypto.js';
import {
  createRunDir,
  writeTestConfig,
  startGateway,
  startFakeServer,
  request,
  waitFor,
  sleep,
} from './helpers.js';

const TOKEN = 'wecom-e2e-token';
const CORP_ID = 'ww_e2e_corp';
const AGENT_ID = '1000003';
const ENCODING_AES_KEY = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
const WEBHOOK = '/webhook/wecom';

async function bootWecom() {
  const runDir = createRunDir('wecom');
  const api = await startFakeServer({
    '*': () => ({ errcode: 0, errmsg: 'ok', access_token: 'WECOM_FAKE_TOKEN', expires_in: 7200, msgid: 'wecom_msg_1' }),
  });
  try {
    const { config } = writeTestConfig({
      runDir: runDir.dir,
      env: {},
      dshEnv: {
        FAKE_DSH_REPLY_TEXT: '企业微信 e2e 回复',
      },
      overrides: {
        channels: {
          wecom: {
            enabled: true,
            mode: 'webhook',
            token: TOKEN,
            encodingAESKey: ENCODING_AES_KEY,
            corpId: CORP_ID,
            agentId: AGENT_ID,
            secret: 'wecom-e2e-app-secret',
            apiBaseUrl: api.url,
            webhookPath: WEBHOOK,
          },
        },
      },
    });
    const gw = await startGateway(config);
    return {
      ...gw,
      gateway: gw.gateway,
      api,
      config,
      async close() {
        await gw.stop();
        await api.close();
        runDir.cleanup();
      },
    };
  } catch (error) {
    await api.close().catch(() => {});
    runDir.cleanup();
    throw error;
  }
}

function innerXml({ from = 'user-1', content = '你好企业微信', msgId = '7000000000000001', createTime } = {}) {
  return [
    '<xml>',
    `<ToUserName><![CDATA[${CORP_ID}]]></ToUserName>`,
    `<FromUserName><![CDATA[${from}]]></FromUserName>`,
    `<CreateTime>${createTime ?? Math.floor(Date.now() / 1000)}</CreateTime>`,
    '<MsgType><![CDATA[text]]></MsgType>',
    `<Content><![CDATA[${content}]]></Content>`,
    `<MsgId>${msgId}</MsgId>`,
    `<AgentID>${AGENT_ID}</AgentID>`,
    '</xml>',
  ].join('');
}

function signedQuery(params) {
  return new URLSearchParams({
    msg_signature: params.signature,
    timestamp: String(params.timestamp),
    nonce: String(params.nonce),
  });
}

/** Encrypt `plaintext` and wrap it in the callback envelope XML. */
function envelope(plaintext, { timestamp = Date.now(), nonce = 'wecom-nonce' } = {}) {
  const { encrypt, signature } = encryptWecomMessage({
    encodingAESKey: ENCODING_AES_KEY,
    plaintext,
    receiveId: CORP_ID,
    timestamp,
    nonce,
    token: TOKEN,
  });
  return {
    signature,
    timestamp,
    nonce,
    encrypt,
    xml: [
      '<xml>',
      `<ToUserName><![CDATA[${CORP_ID}]]></ToUserName>`,
      `<Encrypt><![CDATA[${encrypt}]]></Encrypt>`,
      `<AgentID>${AGENT_ID}</AgentID>`,
      '</xml>',
    ].join(''),
  };
}

function outboundSends(api) {
  return api.requests.filter((entry) => entry.method === 'POST' && entry.path === '/cgi-bin/message/send');
}

function sentText(entry) {
  return entry.json?.markdown?.content ?? entry.json?.text?.content ?? '';
}

test('wecom e2e: GET URL verification decrypts and echoes echostr', async (t) => {
  const ctx = await bootWecom();
  t.after(() => ctx.close());

  const plain = 'wecom-echo-1234567890';
  const { encrypt, signature } = encryptWecomMessage({
    encodingAESKey: ENCODING_AES_KEY,
    plaintext: plain,
    receiveId: CORP_ID,
    timestamp: 1_700_000_000,
    nonce: 'echo-nonce',
    token: TOKEN,
  });
  const query = new URLSearchParams({
    msg_signature: signature,
    timestamp: '1700000000',
    nonce: 'echo-nonce',
    echostr: encrypt,
  });
  const response = await request('GET', `${ctx.baseUrl}${WEBHOOK}?${query.toString()}`);
  assert.equal(response.status, 200);
  assert.equal(response.text, plain);
});

test('wecom e2e: encrypted inbound -> fake DSH -> app message API', async (t) => {
  const ctx = await bootWecom();
  t.after(() => ctx.close());

  // The signature must cover the encrypted body (`Encrypt`), so sign and send
  // the same envelope.
  const signed = envelope(innerXml({ content: '正式消息' }));
  const response = await request(
    'POST',
    `${ctx.baseUrl}${WEBHOOK}?${signedQuery(signed)}`,
    signed.xml,
    { 'content-type': 'text/xml' },
  );
  assert.equal(response.status, 200);
  assert.equal(response.text, 'success');

  const sends = await waitFor(() => {
    const found = outboundSends(ctx.api);
    return found.length > 0 ? found : null;
  }, { timeoutMs: 8000, description: 'wecom app message send' });
  assert.equal(sends[0].json.touser, 'user-1');
  assert.equal(sentText(sends[0]), '企业微信 e2e 回复');
  assert.equal(ctx.gateway.sessions.size, 1);
});

test('wecom e2e: invalid signature is rejected before decrypt/agent', async (t) => {
  const ctx = await bootWecom();
  t.after(() => ctx.close());

  const { xml, timestamp, nonce } = envelope(innerXml({ msgId: '7000000000000099' }));
  const response = await request(
    'POST',
    `${ctx.baseUrl}${WEBHOOK}?${new URLSearchParams({ msg_signature: 'bad', timestamp: String(timestamp), nonce: String(nonce) })}`,
    xml,
    { 'content-type': 'text/xml' },
  );
  assert.equal(response.status, 401);
  await sleep(200);
  assert.equal(outboundSends(ctx.api).length, 0);
  assert.equal(ctx.gateway.sessions.size, 0);
});

test('wecom e2e: allowlist mode silently drops unknown senders', async (t) => {
  const ctx = await bootWecom();
  t.after(() => ctx.close());

  const signed = envelope(innerXml({ from: 'user-stranger', msgId: '7000000000000201' }));
  const response = await request(
    'POST',
    `${ctx.baseUrl}${WEBHOOK}?${signedQuery(signed)}`,
    signed.xml,
    { 'content-type': 'text/xml' },
  );
  assert.equal(response.status, 200);
  await sleep(300);
  assert.equal(outboundSends(ctx.api).length, 0);
  assert.equal(ctx.gateway.sessions.size, 0);
});
