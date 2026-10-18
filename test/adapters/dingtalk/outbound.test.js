import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import {
  buildOutboundPayload,
  deriveMarkdownTitle,
  resolveSessionWebhook,
  sendViaSessionWebhook,
} from '../../../src/adapters/dingtalk/outbound.js';

const FIXED_NOW = 1_700_000_000_000;
const NOT_EXPIRED = FIXED_NOW + 3_600_000;

/**
 * Local fake sessionWebhook that captures every reply request.
 * @param {(record: { body: any }) => { status?: number, body?: any } | undefined} [responder]
 */
async function startWebhookServer(responder) {
  /** @type {Array<{ method: string, url: string, headers: Record<string, any>, body: any }>} */
  const requests = [];
  const server = createServer((req, res) => {
    /** @type {Buffer[]} */
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      /** @type {{ method: string, url: string, headers: Record<string, any>, body: any }} */
      const record = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: text.length > 0 ? JSON.parse(text) : null,
      };
      requests.push(record);
      const verdict = responder?.(record) ?? {};
      const status = verdict.status ?? 200;
      const body = verdict.body ?? { errcode: 0, errmsg: 'ok' };
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/robot/sendBySession?session=token_value`,
    requests,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

function makeTarget(url, overrides = {}) {
  return {
    channel: 'dingtalk',
    accountId: 'dingtalk',
    conversationId: 'staff_001',
    conversationType: 'dm',
    raw: {
      sessionWebhook: url,
      sessionWebhookExpiredTime: NOT_EXPIRED,
      senderOpenDingTalkId: 'open_sender_1',
    },
    ...overrides,
  };
}

test('plain text replies POST text msgtype to the sessionWebhook', async () => {
  const server = await startWebhookServer();
  try {
    const result = await sendViaSessionWebhook({
      target: makeTarget(server.url),
      message: { text: '你好', format: 'plain' },
      config: {},
      now: () => FIXED_NOW,
    });
    assert.equal(server.requests.length, 1);
    const request = server.requests[0];
    assert.equal(request.method, 'POST');
    assert.match(String(request.headers['content-type']), /application\/json/);
    assert.deepEqual(request.body, { msgtype: 'text', text: { content: '你好' } });
    assert.equal(typeof result.messageId, 'string');
    assert.ok(result.messageId.length > 0);
  } finally {
    await server.close();
  }
});

test('markdown replies include a derived title and exact markdown shape', async () => {
  const server = await startWebhookServer();
  try {
    await sendViaSessionWebhook({
      target: makeTarget(server.url),
      message: { text: '## 发布说明\n- 一\n- 二', format: 'markdown' },
      config: { markdownTitle: 'DSH' },
      now: () => FIXED_NOW,
    });
    assert.deepEqual(server.requests[0].body, {
      msgtype: 'markdown',
      markdown: { title: '发布说明', text: '## 发布说明\n- 一\n- 二' },
    });
  } finally {
    await server.close();
  }
});

test('remote attachment URLs are appended as markdown links', async () => {
  const server = await startWebhookServer();
  try {
    await sendViaSessionWebhook({
      target: makeTarget(server.url),
      message: {
        text: '结果如下',
        format: 'markdown',
        attachments: [{ kind: 'image', url: 'https://cdn.example.test/a.png', name: 'a.png' }],
      },
      config: {},
      now: () => FIXED_NOW,
    });
    const text = server.requests[0].body.markdown.text;
    assert.match(text, /结果如下/);
    assert.match(text, /📎 \[a\.png\]\(https:\/\/cdn\.example\.test\/a\.png\)/);
  } finally {
    await server.close();
  }
});

test('quote reply fields are opt-in and only for group markdown', async () => {
  const server = await startWebhookServer();
  try {
    const target = makeTarget(server.url, {
      conversationId: 'cid_group_1',
      conversationType: 'group',
      replyToMessageId: 'msg-1001',
    });
    await sendViaSessionWebhook({
      target,
      message: { text: '收到', format: 'markdown' },
      config: { quoteReply: true },
      now: () => FIXED_NOW,
    });
    const body = server.requests[0].body;
    assert.equal(body.referenceOpenMessageId, 'msg-1001');
    assert.equal(body.srcMsgSendOpenDingTalkId, 'open_sender_1');

    await sendViaSessionWebhook({
      target,
      message: { text: '收到', format: 'markdown' },
      config: {}, // quoteReply defaults to false
      now: () => FIXED_NOW,
    });
    const plainBody = server.requests[1].body;
    assert.equal(plainBody.referenceOpenMessageId, undefined);
    assert.equal(plainBody.srcMsgSendOpenDingTalkId, undefined);
  } finally {
    await server.close();
  }
});

test('missing sessionWebhook raises a clear error without touching the network', async () => {
  const server = await startWebhookServer();
  try {
    await assert.rejects(
      sendViaSessionWebhook({
        target: { channel: 'dingtalk', accountId: 'dingtalk', conversationId: 'c', conversationType: 'dm', raw: {} },
        message: { text: 'hi', format: 'plain' },
        config: {},
        now: () => FIXED_NOW,
      }),
      (error) => {
        assert.match(error.message, /sessionWebhook/);
        assert.equal(error.code, 'DINGTALK_WEBHOOK_MISSING');
        return true;
      },
    );
    assert.equal(server.requests.length, 0);
  } finally {
    await server.close();
  }
});

test('expired sessionWebhook raises a clear error without touching the network', async () => {
  const server = await startWebhookServer();
  try {
    await assert.rejects(
      sendViaSessionWebhook({
        target: makeTarget(server.url, {
          raw: { sessionWebhook: server.url, sessionWebhookExpiredTime: FIXED_NOW - 1 },
        }),
        message: { text: 'hi', format: 'plain' },
        config: {},
        now: () => FIXED_NOW,
      }),
      (error) => {
        assert.match(error.message, /过期/);
        assert.equal(error.code, 'DINGTALK_WEBHOOK_EXPIRED');
        return true;
      },
    );
    assert.equal(server.requests.length, 0);
  } finally {
    await server.close();
  }
});

test('HTTP failures surface status/detail but never leak the webhook token', async () => {
  const server = await startWebhookServer(() => ({
    status: 400,
    body: { errcode: 400, errmsg: 'webhook expired' },
  }));
  try {
    await assert.rejects(
      sendViaSessionWebhook({
        target: makeTarget(server.url),
        message: { text: 'hi', format: 'plain' },
        config: {},
        now: () => FIXED_NOW,
      }),
      (error) => {
        assert.match(error.message, /HTTP 400/);
        assert.match(error.message, /webhook expired/);
        assert.match(error.message, /过期/); // actionable hint
        assert.doesNotMatch(error.message, /token_value/);
        return true;
      },
    );
  } finally {
    await server.close();
  }
});

test('non-zero errcode in a 200 response is treated as a send failure', async () => {
  const server = await startWebhookServer(() => ({
    status: 200,
    body: { errcode: 310000, errmsg: 'invalid parameter' },
  }));
  try {
    await assert.rejects(
      sendViaSessionWebhook({
        target: makeTarget(server.url),
        message: { text: 'hi', format: 'plain' },
        config: {},
        now: () => FIXED_NOW,
      }),
      /errcode=310000.*invalid parameter/,
    );
  } finally {
    await server.close();
  }
});

test('resolveSessionWebhook accepts snake_case webhook fields from webhook callbacks', () => {
  const url = resolveSessionWebhook(
    { channel: 'dingtalk', accountId: 'dingtalk', conversationId: 'c', conversationType: 'dm', raw: { session_webhook: 'https://example.test/hook' } },
    { now: FIXED_NOW },
  );
  assert.equal(url, 'https://example.test/hook');
});

test('buildOutboundPayload rejects empty replies and derives titles', () => {
  assert.equal(deriveMarkdownTitle('### Hello world\nmore'), 'Hello world');
  assert.equal(deriveMarkdownTitle('   ', 'Fallback'), 'Fallback');
  assert.throws(
    () => buildOutboundPayload({
      target: makeTarget('https://example.test/hook'),
      message: { text: '   ', format: 'plain' },
      config: {},
    }),
    /正文为空/,
  );
});
