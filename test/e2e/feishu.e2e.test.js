/**
 * End-to-end: real gateway + real Feishu adapter (webhook mode) + real DSH
 * bridge against the fake runtime.
 *
 * Inbound: real v2 event POSTs into the gateway's HTTP host (verification token
 * checked, URL-verification challenge handled synchronously).
 * Outbound: the adapter's Lark SDK client points at a local fake Feishu OpenAPI
 * (`domain` override), which captures the message reply/create request.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createRunDir,
  writeTestConfig,
  startGateway,
  startFakeServer,
  request,
  waitFor,
  sleep,
  mergeConfig,
} from './helpers.js';

const APP_ID = 'cli_e2e0000000000';
const APP_SECRET = 'feishu-e2e-secret';
const VERIFICATION_TOKEN = 'feishu-e2e-verification-token';
const WEBHOOK = '/webhook/feishu';

async function bootFeishu(options = {}) {
  const runDir = createRunDir('feishu');
  const api = await startFakeServer({
    'POST /open-apis/auth/v3/tenant_access_token/internal': () => ({
      code: 0,
      msg: 'ok',
      tenant_access_token: 't-fake-tenant-token',
      expire: 7200,
    }),
    '*': () => ({ code: 0, msg: 'ok', data: { message_id: 'om_fake_reply_1' } }),
  });
  try {
    const { config } = writeTestConfig({
      runDir: runDir.dir,
      env: {},
      dshEnv: {
        FAKE_DSH_REPLY_TEXT: '飞书 e2e 回复',
        ...options.dshEnv,
      },
      overrides: mergeConfig(
        {
          channels: {
            feishu: {
              enabled: true,
              mode: 'webhook',
              appId: APP_ID,
              appSecret: APP_SECRET,
              verificationToken: VERIFICATION_TOKEN,
              domain: api.url,
              webhookPath: WEBHOOK,
            },
          },
          gateway: { access: { allowFrom: ['ou_e2e_user_1'] } },
        },
        options.overrides ?? {},
      ),
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

function eventPayload(overrides = {}) {
  const now = Date.now();
  const message = {
    message_id: 'om_e2e_msg_1',
    chat_id: 'oc_e2e_chat_1',
    chat_type: 'p2p',
    message_type: 'text',
    content: JSON.stringify({ text: '你好，飞书' }),
    create_time: String(now),
    ...overrides.message,
  };
  return {
    schema: '2.0',
    header: {
      event_id: 'evt_e2e_1',
      event_type: 'im.message.receive_v1',
      create_time: String(now),
      token: VERIFICATION_TOKEN,
      ...overrides.header,
    },
    event: {
      sender: {
        sender_id: { open_id: 'ou_e2e_user_1' },
        sender_type: 'user',
        ...overrides.sender,
      },
      message,
    },
  };
}

function outboundMessages(api) {
  return api.requests.filter(
    (entry) => entry.method === 'POST'
      && entry.path.startsWith('/open-apis/im/v1/messages')
      && !entry.path.includes('tenant_access_token'),
  );
}

function outboundText(entry) {
  try {
    const content = JSON.parse(entry.json?.content ?? '{}');
    // markdown replies are interactive cards (lark_md div); plain ones are text
    return content.text ?? content.elements?.[0]?.text?.content ?? '';
  } catch {
    return '';
  }
}

test('feishu e2e: url_verification challenge is echoed synchronously', async (t) => {
  const ctx = await bootFeishu();
  t.after(() => ctx.close());

  const challenge = 'feishu-challenge-123';
  const response = await request('POST', `${ctx.baseUrl}${WEBHOOK}`, {
    type: 'url_verification',
    challenge,
    token: VERIFICATION_TOKEN,
  });
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.text), { challenge });
});

test('feishu e2e: DM event -> fake DSH -> im v1 message reply', async (t) => {
  const ctx = await bootFeishu();
  t.after(() => ctx.close());

  const response = await request('POST', `${ctx.baseUrl}${WEBHOOK}`, eventPayload());
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(response.text).code, 0);

  const sent = await waitFor(() => {
    const found = outboundMessages(ctx.api);
    return found.length > 0 ? found : null;
  }, { timeoutMs: 8000, description: 'feishu message reply' });

  assert.match(sent[0].path, /\/open-apis\/im\/v1\/messages\/om_e2e_msg_1\/reply/);
  assert.equal(outboundText(sent[0]), '飞书 e2e 回复');
  assert.equal(ctx.gateway.sessions.size, 1);
});

test('feishu e2e: wrong verification token is rejected before the agent runs', async (t) => {
  const ctx = await bootFeishu();
  t.after(() => ctx.close());

  const payload = eventPayload({ header: { token: 'wrong-token' } });
  const response = await request('POST', `${ctx.baseUrl}${WEBHOOK}`, payload);
  assert.equal(response.status, 403);
  await sleep(300);
  assert.equal(outboundMessages(ctx.api).length, 0);
  assert.equal(ctx.gateway.sessions.size, 0);
});

test('feishu e2e: group message without @bot is dropped (requireMention)', async (t) => {
  const ctx = await bootFeishu({
    overrides: {
      gateway: { access: { groups: { enabled: true, requireMention: true, allowFrom: [] } } },
      channels: { feishu: { allowFrom: ['ou_e2e_user_1'] } },
    },
  });
  t.after(() => ctx.close());

  const payload = eventPayload({
    message: { chat_id: 'oc_e2e_group_1', chat_type: 'group', message_id: 'om_e2e_group_1' },
  });
  const response = await request('POST', `${ctx.baseUrl}${WEBHOOK}`, payload);
  assert.equal(response.status, 200);
  await sleep(400);
  assert.equal(outboundMessages(ctx.api).length, 0);
  assert.equal(ctx.gateway.sessions.size, 0);
});
