/**
 * Adapter-level inbound media integration: a fake iLink transport delivers
 * messages whose media URLs point at a local HTTP CDN; the adapter must
 * download/decrypt before emitting, and must skip downloading when
 * `channels.weixin.media.download=false`.
 */
import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { createWeixinAdapter } from '../../../src/adapters/weixin/index.js';
import {
  cleanupDir,
  makeAdapterCtx,
  makeLogger,
  makeTempDir,
  pendingUntilAborted,
  seedCredential,
  waitFor,
} from './helpers.js';

const BASE = 'https://ilinkai.weixin.qq.com';
const CDN = 'https://novac2c.cdn.weixin.qq.com/c2c';

const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]),
  Buffer.from('adapter-image-body'),
]);
const PDF = Buffer.from('%PDF-1.4\nadapter pdf attachment\n%%EOF\n');

/** @param {Buffer} plaintext @param {Buffer} key */
function encrypt(plaintext, key) {
  const cipher = createCipheriv('aes-128-ecb', key, null);
  cipher.setAutoPadding(true);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

/** @param {Record<string, Buffer>} files */
async function startCdn(files) {
  /** @type {string[]} */
  const requests = [];
  const server = createServer((req, res) => {
    res.on('error', () => {});
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    requests.push(url.pathname);
    const body = files[url.pathname];
    if (body === undefined) {
      res.writeHead(404);
      res.end('missing');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(body.length) });
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = /** @type {{ port: number }} */ (server.address());
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** Fake iLink transport: first getupdates returns `messages`, then long-polls forever. */
function makeIlinkTransport(messages) {
  const calls = [];
  let polls = 0;
  const transport = {
    async request(url, init = {}) {
      const call = { url: String(url), method: init.method, headers: init.headers ?? {}, body: init.body, signal: init.signal };
      calls.push(call);
      if (call.url.includes('/ilink/bot/getupdates')) {
        polls += 1;
        if (polls === 1) return { ret: 0, msgs: messages, get_updates_buf: 'cursor-1' };
        return pendingUntilAborted(call);
      }
      return { ret: 0 };
    },
  };
  return { calls, transport };
}

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
 * Start an adapter with fake iLink transport + real local CDN, collecting emits.
 * @param {{ dir: string, messages: any[], fetchImpl?: typeof fetch, config?: Record<string, any> }} options
 */
async function start(options) {
  seedCredential(options.dir, {});
  const { calls, transport } = makeIlinkTransport(options.messages);
  const adapter = createWeixinAdapter({
    transport,
    ...(options.fetchImpl ? { mediaFetch: options.fetchImpl } : {}),
    credentialsCheckIntervalMs: 20,
  });
  const logger = makeLogger();
  const emitted = [];
  const { ctx } = makeAdapterCtx({
    config: adapterConfig(options.config ?? {}),
    stateDir: options.dir,
    emit: async (inbound) => emitted.push(inbound),
    log: logger.log,
  });
  await adapter.start(ctx);
  return { adapter, calls, emitted, logger };
}

test('adapter downloads and decrypts an image before emitting (hex aeskey)', async () => {
  const key = randomBytes(16);
  const cdn = await startCdn({ '/pic': encrypt(JPEG, key) });
  const dir = makeTempDir();
  const { adapter, emitted, logger } = await start({
    dir,
    fetchImpl: globalThis.fetch,
    messages: [
      {
        seq: 1,
        message_id: 5001,
        from_user_id: 'wxid-user@im.wechat',
        create_time_ms: 1_700_000_000_000,
        message_type: 1,
        item_list: [
          {
            type: 2,
            image_item: {
              media: { full_url: `${cdn.url}/pic`, encrypt_query_param: 'ignored', encrypt_type: 1 },
              aeskey: key.toString('hex'),
            },
          },
        ],
      },
    ],
  });
  try {
    await waitFor(() => emitted.length === 1, { label: 'image emit' });
    const [attachment] = emitted[0].attachments;
    assert.equal(attachment.kind, 'image');
    assert.ok(attachment.path, 'gateway consumes attachment.path for image blocks');
    assert.equal(attachment.mimeType, 'image/jpeg');
    assert.equal(attachment.name, 'image-1.jpg');
    assert.equal(attachment.size, JPEG.length);
    assert.deepEqual(readFileSync(attachment.path), JPEG);
    assert.equal(attachment.url, `${cdn.url}/pic`);
    assert.deepEqual(cdn.requests, ['/pic']);
    assert.equal(logger.dump().includes(key.toString('hex')), false);
  } finally {
    await adapter.stop();
    cleanupDir(dir);
    await cdn.close();
  }
});

test('adapter downloads and decrypts a file attachment with its original name', async () => {
  const key = randomBytes(16);
  const cdn = await startCdn({ '/doc': encrypt(PDF, key) });
  const dir = makeTempDir();
  const { adapter, emitted } = await start({
    dir,
    fetchImpl: globalThis.fetch,
    messages: [
      {
        message_id: 5002,
        from_user_id: 'wxid-user@im.wechat',
        create_time_ms: 1_700_000_000_000,
        message_type: 1,
        item_list: [
          {
            type: 4,
            file_item: {
              file_name: '合同.pdf',
              len: String(PDF.length),
              media: { full_url: `${cdn.url}/doc`, aes_key: key.toString('base64') },
            },
          },
        ],
      },
    ],
  });
  try {
    await waitFor(() => emitted.length === 1, { label: 'file emit' });
    const [attachment] = emitted[0].attachments;
    assert.equal(attachment.kind, 'file');
    assert.ok(attachment.path);
    assert.match(attachment.path, /\.pdf$/);
    assert.equal(attachment.mimeType, 'application/pdf');
    assert.equal(attachment.name, '合同.pdf');
    assert.equal(attachment.size, PDF.length);
    assert.deepEqual(readFileSync(attachment.path), PDF);
    assert.equal(attachment.path.startsWith(join(dir, 'media')), true);
    assert.equal(existsSync(attachment.path), true);
  } finally {
    await adapter.stop();
    cleanupDir(dir);
    await cdn.close();
  }
});

test('media.download=false keeps URL-only attachments and performs no CDN request', async () => {
  const cdn = await startCdn({ '/pic': JPEG });
  const dir = makeTempDir();
  const { adapter, emitted } = await start({
    dir,
    fetchImpl: globalThis.fetch,
    config: { media: { download: false } },
    messages: [
      {
        message_id: 5003,
        from_user_id: 'wxid-user@im.wechat',
        create_time_ms: 1_700_000_000_000,
        message_type: 1,
        item_list: [{ type: 2, image_item: { media: { full_url: `${cdn.url}/pic` } } }],
      },
    ],
  });
  try {
    await waitFor(() => emitted.length === 1, { label: 'url-only emit' });
    const [attachment] = emitted[0].attachments;
    assert.equal(attachment.path, undefined);
    assert.equal(attachment.url, `${cdn.url}/pic`);
    assert.deepEqual(cdn.requests, []);
  } finally {
    await adapter.stop();
    cleanupDir(dir);
    await cdn.close();
  }
});

test('a failed media download still emits the message with URL-only attachment', async () => {
  const cdn = await startCdn({});
  const dir = makeTempDir();
  const { adapter, emitted, logger } = await start({
    dir,
    fetchImpl: globalThis.fetch,
    messages: [
      {
        message_id: 5004,
        from_user_id: 'wxid-user@im.wechat',
        create_time_ms: 1_700_000_000_000,
        message_type: 1,
        item_list: [{ type: 2, image_item: { media: { full_url: `${cdn.url}/gone` } } }],
      },
    ],
  });
  try {
    await waitFor(() => emitted.length === 1, { label: 'fallback emit' });
    const [attachment] = emitted[0].attachments;
    assert.equal(attachment.path, undefined);
    assert.equal(attachment.url, `${cdn.url}/gone`);
    assert.match(logger.dump(), /download failed/);
    assert.equal(logger.dump().includes(`${cdn.url}/gone`), false);
  } finally {
    await adapter.stop();
    cleanupDir(dir);
    await cdn.close();
  }
});
