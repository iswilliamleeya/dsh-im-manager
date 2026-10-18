/**
 * WeCom webhook tests: GET URL verification and POST encrypted callbacks over a
 * local HTTP server. The "platform" side is produced with the same documented
 * WeCom AES scheme (self-signed test key, no real 企业微信 involved).
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';

import {
  computeSignature,
  encryptWecomMessage,
} from '../../../src/adapters/wecom/crypto.js';
import { createWebhookHandler } from '../../../src/adapters/wecom/webhook.js';

const TIMESTAMP = '1700000000';
const NONCE = 'nonce-1';
const TOKEN = 'test-token';
const CORP_ID = 'ww-corp-demo';

const noopLog = { debug() {}, info() {}, warn() {}, error() {} };

/** Deterministic test key (43 Base64 chars, no padding). */
function makeKey(fill = 5) {
  return Buffer.alloc(32, fill).toString('base64').replace(/=+$/, '');
}

function makeConfig(overrides = {}) {
  return {
    token: TOKEN,
    encodingAESKey: makeKey(5),
    corpId: CORP_ID,
    botName: '小助手',
    accountId: 'wecom',
    agentId: '1000002',
    secret: 'test-secret',
    ...overrides,
  };
}

/**
 * Encrypt a plaintext with the test key and build the query signature the
 * platform would send.
 */
function seal(plaintext, config, { timestamp = TIMESTAMP, nonce = NONCE, receiveId = config.corpId } = {}) {
  const { encrypt, signature } = encryptWecomMessage({
    encodingAESKey: config.encodingAESKey,
    plaintext,
    receiveId,
    timestamp,
    nonce,
    token: config.token,
  });
  return { encrypt, signature };
}

/**
 * Start a local HTTP server dispatching every request to the adapter handler.
 * @param {ReturnType<typeof createWebhookHandler>} handler
 */
async function startServer(handler) {
  const server = createServer((req, res) => {
    /** @type {Buffer[]} */
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      void handler
        .handleRequest({ req, res, body: Buffer.concat(chunks) })
        .catch((error) => {
          if (!res.headersSent) res.writeHead(500);
          res.end(`handler failed: ${error.message}`);
        });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/**
 * @param {string} plaintext
 * @param {Record<string, any>} config
 */
function outerEnvelope(plaintext, config) {
  const { encrypt, signature } = seal(plaintext, config);
  const body = `<xml><ToUserName><![CDATA[${CORP_ID}]]></ToUserName><Encrypt><![CDATA[${encrypt}]]></Encrypt><AgentID>1000002</AgentID></xml>`;
  return { body, signature, encrypt };
}

function callbackUrl(origin, signature, path = '/webhook/wecom') {
  const params = new URLSearchParams({ msg_signature: signature, timestamp: TIMESTAMP, nonce: NONCE });
  return `${origin}${path}?${params.toString()}`;
}

test('GET verification decrypts echostr and echoes the plaintext', async (t) => {
  const config = makeConfig();
  const handler = createWebhookHandler({ config, emit: async () => {}, log: noopLog });
  const server = await startServer(handler);
  t.after(() => server.close());

  const { encrypt } = seal('echo-ok-123', config);
  const params = new URLSearchParams({
    msg_signature: computeSignature({ token: TOKEN, timestamp: TIMESTAMP, nonce: NONCE, encrypt }),
    timestamp: TIMESTAMP,
    nonce: NONCE,
    echostr: encrypt,
  });
  const response = await fetch(`${server.origin}/webhook/wecom?${params.toString()}`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'echo-ok-123');
});

test('GET verification rejects a bad signature and missing params', async (t) => {
  const config = makeConfig();
  const handler = createWebhookHandler({ config, emit: async () => {}, log: noopLog });
  const server = await startServer(handler);
  t.after(() => server.close());

  const { encrypt } = seal('echo-x', config);
  const params = new URLSearchParams({
    msg_signature: 'deadbeef',
    timestamp: TIMESTAMP,
    nonce: NONCE,
    echostr: encrypt,
  });
  const bad = await fetch(`${server.origin}/webhook/wecom?${params.toString()}`);
  assert.equal(bad.status, 401);

  const missing = await fetch(`${server.origin}/webhook/wecom?timestamp=${TIMESTAMP}&nonce=${NONCE}`);
  assert.equal(missing.status, 400);
});

test('POST decrypts a 自建应用 text callback, acks success and emits', async (t) => {
  const config = makeConfig();
  /** @type {any[]} */
  const emitted = [];
  const handler = createWebhookHandler({ config, emit: async (inbound) => emitted.push(inbound), log: noopLog });
  const server = await startServer(handler);
  t.after(() => server.close());

  const plaintext = `<xml>
    <ToUserName><![CDATA[${CORP_ID}]]></ToUserName>
    <FromUserName><![CDATA[zhangsan]]></FromUserName>
    <CreateTime>1700000000</CreateTime>
    <MsgType><![CDATA[text]]></MsgType>
    <Content><![CDATA[你好，网关]]></Content>
    <MsgId>9000000000001</MsgId>
    <AgentID>1000002</AgentID>
  </xml>`;
  const { body, signature } = outerEnvelope(plaintext, config);
  const response = await fetch(callbackUrl(server.origin, signature), {
    method: 'POST',
    headers: { 'content-type': 'text/xml' },
    body,
  });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'success');

  // emit runs after the platform ack; wait for the async continuation.
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(emitted.length, 1);
  const inbound = emitted[0];
  assert.equal(inbound.channel, 'wecom');
  assert.equal(inbound.conversationType, 'dm');
  assert.equal(inbound.conversationId, 'zhangsan');
  assert.equal(inbound.messageId, '9000000000001');
  assert.equal(inbound.text, '你好，网关');
});

test('POST acks before a slow emit (fast-ack contract)', async (t) => {
  const config = makeConfig();
  /** @type {(value?: unknown) => void} */
  let releaseEmit = () => {};
  const emitGate = new Promise((resolve) => {
    releaseEmit = resolve;
  });
  let emitStarted = false;
  const handler = createWebhookHandler({
    config,
    emit: async () => {
      emitStarted = true;
      await emitGate;
    },
    log: noopLog,
  });
  const server = await startServer(handler);
  t.after(() => server.close());

  const plaintext = `<xml><FromUserName><![CDATA[zhangsan]]></FromUserName><CreateTime>1700000000</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[slow]]></Content><MsgId>9003</MsgId></xml>`;
  const { body, signature } = outerEnvelope(plaintext, config);
  const response = await fetch(callbackUrl(server.origin, signature), {
    method: 'POST',
    headers: { 'content-type': 'text/xml' },
    body,
  });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'success');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(emitStarted, true); // emit began only after the ack was written
  releaseEmit();
});

test('POST rejects a bad signature and does not emit', async (t) => {
  const config = makeConfig();
  let emitCount = 0;
  const handler = createWebhookHandler({
    config,
    emit: async () => {
      emitCount += 1;
    },
    log: noopLog,
  });
  const server = await startServer(handler);
  t.after(() => server.close());

  const plaintext = `<xml><FromUserName><![CDATA[zhangsan]]></FromUserName><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[x]]></Content><MsgId>1</MsgId></xml>`;
  const { body } = outerEnvelope(plaintext, config);
  const response = await fetch(callbackUrl(server.origin, 'bad-signature'), {
    method: 'POST',
    headers: { 'content-type': 'text/xml' },
    body,
  });
  assert.equal(response.status, 401);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(emitCount, 0);
});

test('POST rejects a payload encrypted for another corpId', async (t) => {
  const config = makeConfig({ corpId: 'ww-other-corp' });
  const handler = createWebhookHandler({ config, emit: async () => {}, log: noopLog });
  const server = await startServer(handler);
  t.after(() => server.close());

  const plaintext = `<xml><FromUserName><![CDATA[zhangsan]]></FromUserName><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[x]]></Content><MsgId>1</MsgId></xml>`;
  // Sealed for the real corp id, server expects another one.
  const sealed = seal(plaintext, config, { receiveId: CORP_ID });
  const body = `<xml><Encrypt><![CDATA[${sealed.encrypt}]]></Encrypt></xml>`;
  const response = await fetch(callbackUrl(server.origin, sealed.signature), {
    method: 'POST',
    headers: { 'content-type': 'text/xml' },
    body,
  });
  assert.equal(response.status, 400);
});

test('unsupported methods get 405', async (t) => {
  const config = makeConfig();
  const handler = createWebhookHandler({ config, emit: async () => {}, log: noopLog });
  const server = await startServer(handler);
  t.after(() => server.close());

  const response = await fetch(`${server.origin}/webhook/wecom`, { method: 'PUT', body: 'x' });
  assert.equal(response.status, 405);
});
