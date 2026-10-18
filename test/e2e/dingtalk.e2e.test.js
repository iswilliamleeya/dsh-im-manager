/**
 * End-to-end: real gateway + real DingTalk adapter (webhook mode) + real DSH
 * bridge against the fake runtime.
 *
 * Inbound: real signed HTTP callbacks into the gateway's HTTP host.
 * Outbound: DingTalk replies through the per-message `sessionWebhook`, which
 * points at a local fake server that captures the exact JSON payload.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import {
  createRunDir,
  writeTestConfig,
  startGateway,
  startFakeServer,
  request,
  waitFor,
  sleep,
} from './helpers.js';

const CLIENT_ID = 'ding_e2e_client_id';
const CLIENT_SECRET = 'ding_e2e_client_secret';
const WEBHOOK = '/webhook/dingtalk';

async function bootDingtalk(options = {}) {
  const runDir = createRunDir('dingtalk');
  const sessionWebhookServer = await startFakeServer({
    '*': () => ({ errcode: 0, errmsg: 'ok' }),
  });
  try {
    const { config } = writeTestConfig({
      runDir: runDir.dir,
      env: {},
      dshEnv: {
        FAKE_DSH_REPLY_TEXT: '钉钉 e2e 回复',
        ...options.dshEnv,
      },
      overrides: {
        channels: {
          dingtalk: {
            enabled: true,
            mode: 'webhook',
            clientId: CLIENT_ID,
            clientSecret: CLIENT_SECRET,
            webhookPath: WEBHOOK,
          },
        },
        ...options.overrides,
      },
    });
    const gw = await startGateway(config);
    return {
      ...gw,
      gateway: gw.gateway,
      sessionWebhookServer,
      config,
      async close() {
        await gw.stop();
        await sessionWebhookServer.close();
        runDir.cleanup();
      },
    };
  } catch (error) {
    await sessionWebhookServer.close().catch(() => {});
    runDir.cleanup();
    throw error;
  }
}

function sign(timestamp) {
  return createHmac('sha256', CLIENT_SECRET).update(`${timestamp}\n${CLIENT_SECRET}`).digest('base64');
}

function robotPayload(sessionWebhook, overrides = {}) {
  return {
    conversationId: 'cid_e2e_dm_1',
    chatbotCorpId: 'ding_corp',
    chatbotUserId: 'bot_user',
    msgId: 'ding-msg-1001',
    senderNick: 'Alice',
    isAdmin: false,
    senderStaffId: 'user-1',
    sessionWebhookExpiredTime: Date.now() + 3_600_000,
    createAt: Date.now(),
    senderCorpId: 'corp_1',
    conversationType: '1',
    senderId: 'user-1',
    sessionWebhook,
    robotCode: CLIENT_ID,
    msgtype: 'text',
    text: { content: '你好，钉钉' },
    ...overrides,
  };
}

async function postInbound(baseUrl, payload, { signed = true } = {}) {
  const timestamp = String(Date.now());
  const headers = { 'content-type': 'application/json' };
  if (signed) {
    headers.timestamp = timestamp;
    headers.sign = sign(timestamp);
  }
  return request('POST', `${baseUrl}${WEBHOOK}`, payload, headers);
}

/** Outbound replies captured by the fake sessionWebhook endpoint. */
function outboundReplies(server) {
  return server.requests.filter((entry) => entry.method === 'POST');
}

function replyText(entry) {
  return entry.json?.markdown?.text ?? entry.json?.text?.content ?? '';
}

test('dingtalk e2e: signed inbound -> fake DSH -> sessionWebhook reply', async (t) => {
  const ctx = await bootDingtalk();
  t.after(() => ctx.close());

  const payload = robotPayload(`${ctx.sessionWebhookServer.url}/robot/sendBySession?session=token`);
  const response = await postInbound(ctx.baseUrl, payload);
  assert.equal(response.status, 200);
  // The callback must be ACKed before the agent turn is done.
  assert.equal(JSON.parse(response.text).errcode, 0);

  const replies = await waitFor(() => {
    const found = outboundReplies(ctx.sessionWebhookServer);
    return found.length > 0 ? found : null;
  }, { timeoutMs: 5000, description: 'dingtalk sessionWebhook reply' });

  assert.equal(replyText(replies[0]), '钉钉 e2e 回复');
  assert.equal(replies[0].json.msgtype, 'markdown');
  assert.ok(replies[0].json.markdown.title.length > 0, 'DingTalk markdown requires a title');
  assert.equal(ctx.gateway.sessions.size, 1);
});

test('dingtalk e2e: invalid signature is rejected and never reaches the agent', async (t) => {
  const ctx = await bootDingtalk();
  t.after(() => ctx.close());

  const payload = robotPayload(`${ctx.sessionWebhookServer.url}/robot/sendBySession`);
  const timestamp = String(Date.now());
  const response = await request('POST', `${ctx.baseUrl}${WEBHOOK}`, payload, {
    'content-type': 'application/json',
    timestamp,
    sign: 'not-a-valid-signature',
  });
  assert.equal(response.status, 401);
  await sleep(200);
  assert.equal(outboundReplies(ctx.sessionWebhookServer).length, 0);
  assert.equal(ctx.gateway.sessions.size, 0);
});

test('dingtalk e2e: allowlist mode silently drops unknown senders', async (t) => {
  const ctx = await bootDingtalk({
    overrides: { gateway: { access: { dmPolicy: 'allowlist', allowFrom: ['user-1'] } } },
  });
  t.after(() => ctx.close());

  const payload = robotPayload(`${ctx.sessionWebhookServer.url}/robot/sendBySession`, {
    senderId: 'user-stranger',
    senderStaffId: 'user-stranger',
    msgId: 'ding-msg-2001',
  });
  const response = await postInbound(ctx.baseUrl, payload);
  assert.equal(response.status, 200);
  await sleep(300);
  assert.equal(outboundReplies(ctx.sessionWebhookServer).length, 0);
  assert.equal(ctx.gateway.sessions.size, 0);
});
