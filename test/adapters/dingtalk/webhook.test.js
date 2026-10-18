import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeWebhookSign,
  createWebhookHandler,
  extractWebhookSignature,
  normalizeWebhookPayload,
  verifyWebhookSignature,
} from '../../../src/adapters/dingtalk/webhook.js';
import { createAdapter } from '../../../src/adapters/dingtalk/index.js';
import {
  createAdapterContext,
  createFakeResponse,
  flush,
  robotPayload,
  streamEnvelope,
} from './helpers.js';

const FIXED_NOW = 1_700_000_000_000;
const TIMESTAMP = String(FIXED_NOW);
const SECRET = 'webhook_secret';
// Vector computed with the documented DingTalk custom-robot formula:
// base64(HMAC-SHA256(clientSecret, timestamp + "\n" + clientSecret))
const EXPECTED_SIGN = 'Sj050ElC9E0DwiYKXv48TBf+zAi4tLz5uGojXpkOpa4=';

const WEBHOOK_CONFIG = {
  mode: 'webhook',
  accountId: 'dingtalk',
  clientId: 'ding_client_id',
  clientSecret: SECRET,
  webhookPath: '/webhook/dingtalk',
};

/** Start a webhook-mode adapter and return its registered route handler. */
async function startWebhookAdapter(overrides = {}) {
  const { ctx, routes, emitted, logger, controller } = createAdapterContext({
    config: { ...WEBHOOK_CONFIG, ...(overrides.config ?? {}) },
  });
  const adapter = createAdapter({ now: overrides.now ?? (() => FIXED_NOW), ...(overrides.deps ?? {}) });
  await adapter.start(ctx);
  const handler = routes.get('POST /webhook/dingtalk') ?? routes.get('POST /webhook/custom');
  assert.equal(typeof handler, 'function', 'webhook route should be registered');
  return { adapter, handler, ctx, emitted, logger, controller };
}

/** @param {Record<string, unknown>} payload */
function makeRequest(payload, { timestamp = TIMESTAMP, sign = EXPECTED_SIGN, extraHeaders = {}, url = '/webhook/dingtalk' } = {}) {
  /** @type {Record<string, unknown>} */
  const headers = { ...extraHeaders };
  if (timestamp !== null) headers.timestamp = timestamp;
  if (sign !== null) headers.sign = sign;
  return {
    req: { headers, url, method: 'POST', httpVersion: '1.1' },
    res: createFakeResponse(),
    body: Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload)),
  };
}

test('DingTalk signature matches the documented HMAC-SHA256/base64 vector', () => {
  assert.equal(computeWebhookSign(TIMESTAMP, SECRET), EXPECTED_SIGN);
  assert.equal(computeWebhookSign(TIMESTAMP, 'other'), computeWebhookSign(TIMESTAMP, 'other'));
  assert.notEqual(computeWebhookSign(TIMESTAMP, 'other'), EXPECTED_SIGN);
});

test('verifyWebhookSignature accepts valid, rejects mismatched/expired/missing material', () => {
  assert.deepEqual(
    verifyWebhookSignature({ timestamp: TIMESTAMP, sign: EXPECTED_SIGN, secret: SECRET, now: FIXED_NOW }),
    { ok: true },
  );
  assert.equal(
    verifyWebhookSignature({ timestamp: TIMESTAMP, sign: 'not-the-signature', secret: SECRET, now: FIXED_NOW }).ok,
    false,
  );
  const expired = verifyWebhookSignature({
    timestamp: String(FIXED_NOW - 2 * 60 * 60 * 1000),
    sign: computeWebhookSign(String(FIXED_NOW - 2 * 60 * 60 * 1000), SECRET),
    secret: SECRET,
    now: FIXED_NOW,
  });
  assert.equal(expired.ok, false);
  assert.match(String(expired.reason), /expired/);
  assert.equal(verifyWebhookSignature({ timestamp: null, sign: EXPECTED_SIGN, secret: SECRET, now: FIXED_NOW }).ok, false);
  assert.equal(verifyWebhookSignature({ timestamp: TIMESTAMP, sign: null, secret: SECRET, now: FIXED_NOW }).ok, false);
  assert.equal(verifyWebhookSignature({ timestamp: TIMESTAMP, sign: EXPECTED_SIGN, secret: '', now: FIXED_NOW }).ok, false);
});

test('extractWebhookSignature reads headers first, then query string, then body fields', () => {
  assert.deepEqual(
    extractWebhookSignature({ req: { headers: { timestamp: '1', sign: 'a' } } }),
    { timestamp: '1', sign: 'a' },
  );
  assert.deepEqual(
    extractWebhookSignature({ req: { headers: {}, url: '/webhook/dingtalk?timestamp=2&sign=b' } }),
    { timestamp: '2', sign: 'b' },
  );
  assert.deepEqual(
    extractWebhookSignature({ req: { headers: {} }, payload: { timestamp: '3', sign: 'c' } }),
    { timestamp: '3', sign: 'c' },
  );
  assert.deepEqual(
    extractWebhookSignature({ req: { headers: { 'x-dingtalk-timestamp': '4', 'x-dingtalk-sign': 'd' } } }),
    { timestamp: '4', sign: 'd' },
  );
});

test('normalizeWebhookPayload unwraps stream-shaped envelopes', () => {
  const raw = robotPayload();
  const unwrapped = normalizeWebhookPayload(streamEnvelope(raw, { messageId: 'delivery-9' }));
  assert.equal(unwrapped.msgId, raw.msgId);
  assert.equal(normalizeWebhookPayload('nope'), null);
  assert.equal(normalizeWebhookPayload({ data: 'not json', headers: {} }), null);
});

test('valid signed webhook: ACK 200 immediately, then emit normalized message', async () => {
  const { adapter, handler, emitted, ctx } = await startWebhookAdapter();
  try {
    const request = makeRequest(robotPayload());
    /** @type {boolean | null} */
    let responseEndedWhenEmitted = null;
    const emitNow = ctx.emit;
    ctx.emit = async (inbound) => {
      // The HTTP ACK must already be on the wire when the gateway is handed the message.
      responseEndedWhenEmitted = request.res.writableEnded;
      await emitNow(inbound);
    };
    await handler(request);
    assert.equal(request.res.statusCode, 200);
    assert.equal(request.res.headersSent, true);
    assert.equal(JSON.parse(request.res.body).errcode, 0);

    await flush();
    assert.equal(emitted.length, 1);
    assert.equal(responseEndedWhenEmitted, true);
    const inbound = emitted[0];
    assert.equal(inbound.conversationType, 'group');
    assert.equal(inbound.conversationId, 'cid_group_1');
    assert.equal(inbound.messageId, 'msg-1001');
    assert.equal(inbound.text, '帮我看看这个报错');
    assert.equal(inbound.mentioned, true);
  } finally {
    await adapter.stop();
  }
});

test('bad signature is rejected with 401 and never emitted', async () => {
  const { adapter, handler, emitted } = await startWebhookAdapter();
  try {
    const request = makeRequest(robotPayload(), { sign: 'AAAA' });
    await handler(request);
    assert.equal(request.res.statusCode, 401);
    await flush();
    assert.equal(emitted.length, 0);
  } finally {
    await adapter.stop();
  }
});

test('missing signature headers are rejected with 401', async () => {
  const { adapter, handler, emitted } = await startWebhookAdapter();
  try {
    const request = makeRequest(robotPayload(), { timestamp: null, sign: null });
    await handler(request);
    assert.equal(request.res.statusCode, 401);
    await flush();
    assert.equal(emitted.length, 0);
  } finally {
    await adapter.stop();
  }
});

test('signature supplied via query string is accepted', async () => {
  const { adapter, handler, emitted } = await startWebhookAdapter();
  try {
    const request = makeRequest(robotPayload(), {
      timestamp: null,
      sign: null,
      url: `/webhook/dingtalk?timestamp=${encodeURIComponent(TIMESTAMP)}&sign=${encodeURIComponent(EXPECTED_SIGN)}`,
    });
    await handler(request);
    assert.equal(request.res.statusCode, 200);
    await flush();
    assert.equal(emitted.length, 1);
  } finally {
    await adapter.stop();
  }
});

test('stream-shaped webhook bodies are accepted', async () => {
  const { adapter, handler, emitted } = await startWebhookAdapter();
  try {
    const request = makeRequest(streamEnvelope(robotPayload(), { messageId: 'delivery-7' }));
    await handler(request);
    assert.equal(request.res.statusCode, 200);
    await flush();
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].messageId, 'msg-1001');
  } finally {
    await adapter.stop();
  }
});

test('duplicate webhook deliveries are deduped', async () => {
  const { adapter, handler, emitted } = await startWebhookAdapter();
  try {
    await handler(makeRequest(robotPayload()));
    await handler(makeRequest(robotPayload()));
    await flush();
    assert.equal(emitted.length, 1);
  } finally {
    await adapter.stop();
  }
});

test('malformed JSON body returns 400', async () => {
  const { adapter, handler, emitted } = await startWebhookAdapter();
  try {
    const request = makeRequest('{not json');
    await handler(request);
    assert.equal(request.res.statusCode, 400);
    await flush();
    assert.equal(emitted.length, 0);
  } finally {
    await adapter.stop();
  }
});

test('verifySignature=false accepts unsigned callbacks (local testing only)', async () => {
  const { adapter, handler, emitted } = await startWebhookAdapter({ config: { verifySignature: false } });
  try {
    const request = makeRequest(robotPayload(), { timestamp: null, sign: null });
    await handler(request);
    assert.equal(request.res.statusCode, 200);
    await flush();
    assert.equal(emitted.length, 1);
  } finally {
    await adapter.stop();
  }
});

test('webhook mode requires ctx.http and a signature secret', async () => {
  const noHttp = createAdapterContext({ config: WEBHOOK_CONFIG });
  const adapter = createAdapter({ now: () => FIXED_NOW });
  // Simulate a gateway with HTTP disabled.
  noHttp.ctx.http = undefined;
  await assert.rejects(adapter.start(noHttp.ctx), /gateway\.http/);

  const missingSecret = createAdapterContext({
    config: { ...WEBHOOK_CONFIG, clientSecret: '', signatureSecret: '' },
  });
  await assert.rejects(adapter.start(missingSecret.ctx), /clientSecret/);
});

test('createWebhookHandler can be used standalone with an injected now()', async () => {
  /** @type {Array<Record<string, unknown>>} */
  const received = [];
  const handler = createWebhookHandler({
    config: { verifySignature: true, signatureSecret: SECRET, signatureMaxSkewMs: 60_000 },
    now: () => FIXED_NOW,
    onPayload: (payload) => {
      received.push(payload);
    },
  });
  const request = makeRequest(robotPayload());
  await handler(request);
  assert.equal(request.res.statusCode, 200);
  await flush();
  assert.equal(received.length, 1);
  assert.equal(received[0].msgId, 'msg-1001');
});
