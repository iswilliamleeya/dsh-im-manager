/**
 * Inbound media: URL resolution, AES-128-ECB decryption, magic-byte MIME
 * sniffing, local persistence, hydration caps and failure fallbacks.
 *
 * A real local `node:http` server plays the CDN; ciphertext is generated with
 * `node:crypto` in the test. No real WeChat/CDN endpoint is contacted.
 */
import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  MediaDownloadError,
  createMediaDownloader,
  decodeAesKey,
  decryptAes128Ecb,
  describeItemMedia,
  extensionFromFilename,
  hydrateInboundMedia,
  mimeFromFilename,
  safeMediaError,
  sanitizeFilename,
  sniffAvMime,
  sniffImageMime,
} from '../../../src/adapters/weixin/media.js';
import { mapInbound } from '../../../src/adapters/weixin/inbound.js';
import { cleanupDir, makeTempDir } from './helpers.js';

// ── Fixtures ────────────────────────────────────────────────────────────────

const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]),
  Buffer.from('fake-jpeg-body-for-tests'),
]);
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]),
  Buffer.from('fake-png-body'),
]);
const PDF = Buffer.from('%PDF-1.4\nfake pdf body for tests\n%%EOF\n');
const MP4 = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from('ftypisom'),
  Buffer.from([0x00, 0x00, 0x02, 0x00]),
  Buffer.from('fake-mp4-body'),
]);
const SILK = Buffer.concat([Buffer.from('#!SILK_V3'), Buffer.from('fake-silk-body')]);

/** @param {Buffer} plaintext @param {Buffer} key */
function encrypt(plaintext, key) {
  const cipher = createCipheriv('aes-128-ecb', key, null);
  cipher.setAutoPadding(true);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

/** @param {Buffer} key */
function base64OfHexKey(key) {
  return Buffer.from(key.toString('hex'), 'ascii').toString('base64');
}

/**
 * Start a fake CDN server.
 * @param {Record<string, (req: any, res: any, url: URL) => void>} routes
 */
async function startCdnServer(routes) {
  /** @type {{ path: string, query: URLSearchParams }[]} */
  const requests = [];
  const server = createServer((req, res) => {
    res.on('error', () => {});
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    requests.push({ path: url.pathname, query: url.searchParams });
    const handler = routes[url.pathname];
    if (handler === undefined) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    handler(req, res, url);
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

/** @param {Buffer} body @param {Record<string, string>} [headers] */
function sendBuffer(res, body, headers = {}) {
  res.writeHead(200, {
    'content-type': 'application/octet-stream',
    'content-length': String(body.length),
    ...headers,
  });
  res.end(body);
}

/** @param {Record<string, Buffer>} fixtures keyed by encrypted_query_param */
function downloadRoute(fixtures) {
  return (req, res, url) => {
    const key = url.searchParams.get('encrypted_query_param');
    const body = key !== null ? fixtures[key] : undefined;
    if (body === undefined) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('unknown media');
      return;
    }
    sendBuffer(res, body);
  };
}

/** @param {{ fullUrl?: string, encryptQueryParam?: string, aeskey?: string, aesKey?: string, url?: string, encryptType?: number }} [options] */
function imageItem(options = {}) {
  /** @type {Record<string, any>} */
  const media = {};
  if (options.fullUrl !== undefined) media.full_url = options.fullUrl;
  if (options.encryptQueryParam !== undefined) media.encrypt_query_param = options.encryptQueryParam;
  if (options.aesKey !== undefined) media.aes_key = options.aesKey;
  if (options.encryptType !== undefined) media.encrypt_type = options.encryptType;
  return {
    type: 2,
    image_item: {
      ...(Object.keys(media).length > 0 ? { media } : {}),
      ...(options.aeskey !== undefined ? { aeskey: options.aeskey } : {}),
      ...(options.url !== undefined ? { url: options.url } : {}),
    },
  };
}

/** @param {number} type @param {Record<string, any>} payload @param {string} field */
function makeItem(type, payload, field) {
  return { type, [field]: payload };
}

/** @param {string} serverUrl @param {Record<string, any>} [overrides] */
function makeDownloader(serverUrl, overrides = {}) {
  const dir = makeTempDir();
  const lines = [];
  const log = {
    debug: (...args) => lines.push(['debug', ...args]),
    info: (...args) => lines.push(['info', ...args]),
    warn: (...args) => lines.push(['warn', ...args]),
  };
  const downloader = createMediaDownloader({
    cdnBaseUrl: serverUrl,
    stateDir: dir,
    fetch: globalThis.fetch,
    log,
    ...overrides,
  });
  return {
    dir,
    downloader,
    lines,
    log,
    logDump: () => JSON.stringify(lines),
    cleanup: () => cleanupDir(dir),
  };
}

/** Whether a captured log line at `level` matches `pattern` in any argument. */
function hasLog(lines, level, pattern) {
  return lines.some(
    ([lineLevel, ...rest]) =>
      lineLevel === level &&
      rest.some((item) => pattern.test(typeof item === 'string' ? item : JSON.stringify(item))),
  );
}

// ── Unit: AES keys ──────────────────────────────────────────────────────────

test('decodeAesKey accepts 32-char hex, base64 raw bytes and base64-of-hex', () => {
  const key = Buffer.from('0123456789abcdef0123456789abcdef', 'hex');
  assert.deepEqual(decodeAesKey(key.toString('hex')), key);
  assert.deepEqual(decodeAesKey(key.toString('base64')), key);
  assert.deepEqual(decodeAesKey(base64OfHexKey(key)), key);
  assert.deepEqual(decodeAesKey(`  ${key.toString('hex')}  `), key);
  // base64url form
  const urlSafe = key.toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
  assert.deepEqual(decodeAesKey(urlSafe), key);
});

test('decodeAesKey rejects malformed keys', () => {
  assert.equal(decodeAesKey(undefined), undefined);
  assert.equal(decodeAesKey(''), undefined);
  assert.equal(decodeAesKey('zzz'), undefined);
  assert.equal(decodeAesKey('1234'), undefined);
  assert.equal(decodeAesKey(42), undefined);
});

test('decryptAes128Ecb round-trips AES-128-ECB + PKCS#7', () => {
  const key = randomBytes(16);
  const plaintext = Buffer.from('hello 微信 media world');
  const ciphertext = encrypt(plaintext, key);
  assert.deepEqual(decryptAes128Ecb(ciphertext, key), plaintext);
});

test('decryptAes128Ecb throws MediaDownloadError on a wrong key', () => {
  const ciphertext = encrypt(Buffer.from('secret body'), randomBytes(16));
  assert.throws(() => decryptAes128Ecb(ciphertext, randomBytes(16)), MediaDownloadError);
  assert.throws(() => decryptAes128Ecb(ciphertext, Buffer.alloc(8)), /16 字节/);
});

// ── Unit: MIME / filenames ──────────────────────────────────────────────────

test('sniffImageMime recognizes jpeg/png/gif/webp and rejects unknown data', () => {
  assert.deepEqual(sniffImageMime(JPEG), { mimeType: 'image/jpeg', ext: '.jpg' });
  assert.deepEqual(sniffImageMime(PNG), { mimeType: 'image/png', ext: '.png' });
  assert.deepEqual(sniffImageMime(Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(20)])), {
    mimeType: 'image/gif',
    ext: '.gif',
  });
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x10, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);
  assert.deepEqual(sniffImageMime(webp), { mimeType: 'image/webp', ext: '.webp' });
  assert.equal(sniffImageMime(Buffer.from('not an image at all')), undefined);
  assert.equal(sniffImageMime(Buffer.alloc(0)), undefined);
});

test('sniffAvMime recognizes silk/amr/mp3/wav and mp4 families', () => {
  assert.deepEqual(sniffAvMime(SILK), { mimeType: 'audio/silk', ext: '.silk' });
  assert.deepEqual(sniffAvMime(Buffer.concat([Buffer.from('#!AMR\n'), Buffer.alloc(20)])), {
    mimeType: 'audio/amr',
    ext: '.amr',
  });
  assert.deepEqual(sniffAvMime(Buffer.concat([Buffer.from('ID3'), Buffer.alloc(20)])), {
    mimeType: 'audio/mpeg',
    ext: '.mp3',
  });
  assert.deepEqual(sniffAvMime(MP4), { mimeType: 'video/mp4', ext: '.mp4' });
});

test('filename helpers classify MIME, extension and sanitize traversal', () => {
  assert.equal(mimeFromFilename('report.pdf'), 'application/pdf');
  assert.equal(mimeFromFilename('REPORT.PDF'), 'application/pdf');
  assert.equal(mimeFromFilename('archive.tar.gz'), 'application/gzip');
  assert.equal(mimeFromFilename('unknown.zzz'), undefined);
  assert.equal(mimeFromFilename(undefined), undefined);
  assert.equal(extensionFromFilename('photo.JPEG'), '.jpeg');
  assert.equal(extensionFromFilename('no-extension'), '');
  assert.equal(sanitizeFilename('../../etc/passwd'), 'passwd');
  assert.equal(sanitizeFilename('..\\..\\evil.txt'), 'evil.txt');
  assert.equal(sanitizeFilename('a\u0000b.txt'), 'ab.txt');
  assert.equal(sanitizeFilename('', 'fallback.bin'), 'fallback.bin');
  assert.equal(sanitizeFilename('x'.repeat(200) + '.txt').length <= 120, true);
});

test('describeItemMedia resolves URL/key priority', () => {
  const image = imageItem({
    fullUrl: 'https://cdn.example/full',
    encryptQueryParam: 'ignored',
    aeskey: '0123456789abcdef0123456789abcdef',
    aesKey: 'base64fallback',
  });
  const described = describeItemMedia(image, { cdnBaseUrl: 'https://cdn.example/base' });
  assert.equal(described.kind, 'image');
  assert.equal(described.url, 'https://cdn.example/full');
  assert.equal(described.aesKeySource, '0123456789abcdef0123456789abcdef');
  assert.equal(described.requiresKey, false);

  const file = makeItem(4, { file_name: 'a.pdf', media: { encrypt_query_param: 'p/q', aes_key: 'k' } }, 'file_item');
  const fileDescribed = describeItemMedia(file, { cdnBaseUrl: 'https://cdn.example/base' });
  assert.equal(fileDescribed.url, 'https://cdn.example/base/download?encrypted_query_param=p%2Fq');
  assert.equal(fileDescribed.aesKeySource, 'k');
  assert.equal(fileDescribed.requiresKey, true);

  // Legacy image URL without a CDN media reference is plaintext (no key use).
  const legacy = describeItemMedia(
    imageItem({ url: 'https://cdn.example/legacy.jpg', aeskey: '0123456789abcdef0123456789abcdef' }),
    { cdnBaseUrl: 'https://cdn.example/base' },
  );
  assert.equal(legacy.url, 'https://cdn.example/legacy.jpg');
  assert.equal(legacy.aesKeySource, undefined);

  assert.equal(describeItemMedia({ type: 2, image_item: {} }), null);
  assert.equal(describeItemMedia({ type: 99 }), null);
  assert.equal(describeItemMedia(null), null);
});

test('safeMediaError strips CDN URLs and encrypted query parameters', () => {
  const cleaned = safeMediaError(
    new Error('request https://cdn.example/download?encrypted_query_param=SECRET failed'),
  );
  assert.ok(!cleaned.includes('https://'));
  assert.ok(!cleaned.includes('SECRET'));
  assert.match(cleaned, /<cdn-url>|<redacted>/);
});

// ── Downloader against a local HTTP CDN ─────────────────────────────────────

test('image with hex aeskey is downloaded, decrypted and saved', async () => {
  const key = randomBytes(16);
  const ciphertext = encrypt(JPEG, key);
  const server = await startCdnServer({ '/download': downloadRoute({ img1: ciphertext }) });
  const { dir, downloader, lines, cleanup } = makeDownloader(server.url);
  try {
    const result = await downloader.downloadItem({
      item: imageItem({ encryptQueryParam: 'img1', aeskey: key.toString('hex') }),
      messageId: 'wx-123',
      index: 0,
    });
    assert.ok(result);
    assert.equal(result.mimeType, 'image/jpeg');
    assert.equal(result.name, 'image-1.jpg');
    assert.equal(result.size, JPEG.length);
    assert.equal(result.path, join(dir, 'media', 'wx-123-0.jpg'));
    assert.deepEqual(readFileSync(result.path), JPEG);
    assert.equal(statSync(result.path).mode & 0o777, 0o600);
    assert.equal(statSync(join(dir, 'media')).mode & 0o777, 0o700);
    assert.equal(server.requests.length, 1);
    assert.equal(server.requests[0].path, '/download');
    assert.equal(server.requests[0].query.get('encrypted_query_param'), 'img1');
    assert.ok(lines.some(([level]) => level === 'info'));
    assert.ok(!JSON.stringify(lines).includes(key.toString('hex')));
  } finally {
    cleanup();
    await server.close();
  }
});

test('image without a key is saved as plaintext (protocol default)', async () => {
  const server = await startCdnServer({ '/download': downloadRoute({ plain: JPEG }) });
  const { downloader, cleanup } = makeDownloader(server.url);
  try {
    const result = await downloader.downloadItem({
      item: imageItem({ encryptQueryParam: 'plain' }),
      messageId: 'wx-plain',
      index: 1,
    });
    assert.ok(result);
    assert.deepEqual(readFileSync(result.path), JPEG);
    assert.match(result.path, /wx-plain-1\.jpg$/);
  } finally {
    cleanup();
    await server.close();
  }
});

test('image decrypts via media.aes_key (base64 raw key and base64-of-hex)', async () => {
  const key = randomBytes(16);
  const ciphertext = encrypt(PNG, key);
  for (const aesKey of [key.toString('base64'), base64OfHexKey(key)]) {
    const server = await startCdnServer({ '/download': downloadRoute({ png1: ciphertext }) });
    const { downloader, cleanup } = makeDownloader(server.url);
    try {
      const result = await downloader.downloadItem({
        item: imageItem({ encryptQueryParam: 'png1', aesKey }),
        messageId: 'wx-png',
        index: 0,
      });
      assert.ok(result);
      assert.equal(result.mimeType, 'image/png');
      assert.match(result.path, /\.png$/);
      assert.deepEqual(readFileSync(result.path), PNG);
    } finally {
      cleanup();
      await server.close();
    }
  }
});

test('image falls back to media.aes_key when image_item.aeskey is malformed', async () => {
  const key = randomBytes(16);
  const server = await startCdnServer({ '/download': downloadRoute({ alt: encrypt(JPEG, key) }) });
  const { downloader, cleanup } = makeDownloader(server.url);
  try {
    const result = await downloader.downloadItem({
      item: imageItem({ encryptQueryParam: 'alt', aeskey: 'not-hex', aesKey: key.toString('base64') }),
      messageId: 'wx-alt',
      index: 0,
    });
    assert.ok(result);
    assert.deepEqual(readFileSync(result.path), JPEG);
  } finally {
    cleanup();
    await server.close();
  }
});

test('file attachments keep the original name and get MIME from the extension', async () => {
  const key = randomBytes(16);
  const server = await startCdnServer({ '/download': downloadRoute({ file1: encrypt(PDF, key) }) });
  const { dir, downloader, cleanup } = makeDownloader(server.url);
  try {
    const item = makeItem(
      4,
      { file_name: '季度报告.pdf', len: '123', media: { encrypt_query_param: 'file1', aes_key: key.toString('base64') } },
      'file_item',
    );
    const result = await downloader.downloadItem({ item, messageId: 'wx-file', index: 2 });
    assert.ok(result);
    assert.equal(result.name, '季度报告.pdf');
    assert.equal(result.mimeType, 'application/pdf');
    assert.equal(result.size, PDF.length);
    assert.equal(result.path, join(dir, 'media', 'wx-file-2.pdf'));
    assert.deepEqual(readFileSync(result.path), PDF);
  } finally {
    cleanup();
    await server.close();
  }
});

test('file without a usable extension gets a sniffed extension / .bin fallback', async () => {
  const key = randomBytes(16);
  const server = await startCdnServer({
    '/download': downloadRoute({
      pdfNoExt: encrypt(PDF, key),
      txtNoExt: encrypt(Buffer.from('plain text attachment'), key),
    }),
  });
  const { downloader, cleanup } = makeDownloader(server.url);
  try {
    const pdf = await downloader.downloadItem({
      item: makeItem(4, { file_name: 'report', media: { encrypt_query_param: 'pdfNoExt', aes_key: key.toString('base64') } }, 'file_item'),
      messageId: 'wx-noext',
      index: 0,
    });
    assert.ok(pdf);
    assert.equal(pdf.name, 'report.pdf');
    assert.equal(pdf.mimeType, 'application/pdf');
    assert.match(pdf.path, /-0\.pdf$/);

    const bin = await downloader.downloadItem({
      item: makeItem(4, { file_name: 'unknown', media: { encrypt_query_param: 'txtNoExt', aes_key: key.toString('base64') } }, 'file_item'),
      messageId: 'wx-bin',
      index: 1,
    });
    assert.ok(bin);
    assert.equal(bin.name, 'unknown.bin');
    assert.equal(bin.mimeType, 'application/octet-stream');
    assert.match(bin.path, /-1\.bin$/);
  } finally {
    cleanup();
    await server.close();
  }
});

test('file names cannot escape the media directory', async () => {
  const key = randomBytes(16);
  const server = await startCdnServer({ '/download': downloadRoute({ trav: encrypt(PDF, key) }) });
  const { dir, downloader, cleanup } = makeDownloader(server.url);
  try {
    const result = await downloader.downloadItem({
      item: makeItem(4, { file_name: '../../etc/passwd.pdf', media: { encrypt_query_param: 'trav', aes_key: key.toString('base64') } }, 'file_item'),
      messageId: 'wx-trav',
      index: 0,
    });
    assert.ok(result);
    assert.equal(result.name, 'passwd.pdf');
    assert.equal(result.path.startsWith(join(dir, 'media')), true);
  } finally {
    cleanup();
    await server.close();
  }
});

test('video and voice items decrypt and classify their MIME', async () => {
  const key = randomBytes(16);
  const server = await startCdnServer({
    '/download': downloadRoute({ video1: encrypt(MP4, key), voice1: encrypt(SILK, key) }),
  });
  const { downloader, cleanup } = makeDownloader(server.url);
  try {
    const video = await downloader.downloadItem({
      item: makeItem(5, { media: { encrypt_query_param: 'video1', aes_key: key.toString('base64') } }, 'video_item'),
      messageId: 'wx-video',
      index: 0,
    });
    assert.ok(video);
    assert.equal(video.mimeType, 'video/mp4');
    assert.equal(video.name, 'video-1.mp4');
    assert.match(video.path, /\.mp4$/);

    const voice = await downloader.downloadItem({
      item: makeItem(3, { media: { encrypt_query_param: 'voice1', aes_key: key.toString('base64') } }, 'voice_item'),
      messageId: 'wx-voice',
      index: 0,
    });
    assert.ok(voice);
    assert.equal(voice.mimeType, 'audio/silk');
    assert.equal(voice.name, 'voice-1.silk');
    assert.match(voice.path, /\.silk$/);
  } finally {
    cleanup();
    await server.close();
  }
});

test('media.full_url takes precedence over encrypt_query_param', async () => {
  const server = await startCdnServer({
    '/direct/pic': (req, res) => sendBuffer(res, JPEG),
    '/download': downloadRoute({ wrong: Buffer.from('never used') }),
  });
  const { downloader, cleanup } = makeDownloader(server.url);
  try {
    const result = await downloader.downloadItem({
      item: imageItem({ fullUrl: `${server.url}/direct/pic`, encryptQueryParam: 'wrong' }),
      messageId: 'wx-full',
      index: 0,
    });
    assert.ok(result);
    assert.deepEqual(readFileSync(result.path), JPEG);
    assert.deepEqual(server.requests.map((request) => request.path), ['/direct/pic']);
  } finally {
    cleanup();
    await server.close();
  }
});

test('image url field is used when no media reference exists', async () => {
  const server = await startCdnServer({ '/legacy/img': (req, res) => sendBuffer(res, JPEG) });
  const { downloader, cleanup } = makeDownloader(server.url);
  try {
    const result = await downloader.downloadItem({
      item: imageItem({ url: `${server.url}/legacy/img` }),
      messageId: 'wx-legacy',
      index: 0,
    });
    assert.ok(result);
    assert.deepEqual(readFileSync(result.path), JPEG);
  } finally {
    cleanup();
    await server.close();
  }
});

test('legacy image url with a stray aeskey is still saved as plaintext', async () => {
  const server = await startCdnServer({ '/legacy-key': (req, res) => sendBuffer(res, JPEG) });
  const { downloader, cleanup } = makeDownloader(server.url);
  try {
    const result = await downloader.downloadItem({
      item: imageItem({ url: `${server.url}/legacy-key`, aeskey: randomBytes(16).toString('hex') }),
      messageId: 'wx-legacy-key',
      index: 0,
    });
    assert.ok(result);
    assert.deepEqual(readFileSync(result.path), JPEG);
  } finally {
    cleanup();
    await server.close();
  }
});

test('encrypt_type is metadata only; ciphertext bytes are still decrypted', async () => {
  const key = randomBytes(16);
  const server = await startCdnServer({ '/download': downloadRoute({ enc: encrypt(JPEG, key) }) });
  const { downloader, cleanup } = makeDownloader(server.url);
  try {
    const result = await downloader.downloadItem({
      item: imageItem({ encryptQueryParam: 'enc', aeskey: key.toString('hex'), encryptType: 1 }),
      messageId: 'wx-enc',
      index: 0,
    });
    assert.ok(result);
    assert.deepEqual(readFileSync(result.path), JPEG);
  } finally {
    cleanup();
    await server.close();
  }
});

test('a wrong AES key falls back to URL-only and logs without secrets', async () => {
  const realKey = randomBytes(16);
  const wrongKey = randomBytes(16);
  const ciphertext = encrypt(JPEG, realKey);
  const server = await startCdnServer({ '/download': downloadRoute({ wrongkey: ciphertext }) });
  const { dir, downloader, lines, cleanup } = makeDownloader(server.url);
  try {
    const result = await downloader.downloadItem({
      item: imageItem({ encryptQueryParam: 'wrongkey', aeskey: wrongKey.toString('hex') }),
      messageId: 'wx-wrong',
      index: 0,
    });
    assert.equal(result, null);
    assert.ok(hasLog(lines, 'warn', /decrypt failed/));
    const dump = JSON.stringify(lines);
    assert.equal(dump.includes(wrongKey.toString('hex')), false);
    assert.equal(dump.includes(realKey.toString('hex')), false);
    assert.equal(dump.includes('encrypted_query_param=wrongkey'), false);
    assert.equal(existsSync(join(dir, 'media')), false);
  } finally {
    cleanup();
    await server.close();
  }
});

test('HTTP 404 falls back to URL-only', async () => {
  const server = await startCdnServer({});
  const { downloader, lines, cleanup } = makeDownloader(server.url);
  try {
    const result = await downloader.downloadItem({
      item: imageItem({ encryptQueryParam: 'missing' }),
      messageId: 'wx-404',
      index: 0,
    });
    assert.equal(result, null);
    assert.ok(hasLog(lines, 'warn', /HTTP 404/));
  } finally {
    cleanup();
    await server.close();
  }
});

test('content-length over media.maxBytes falls back without writing a file', async () => {
  const server = await startCdnServer({ '/download': downloadRoute({ big: JPEG }) });
  const { dir, downloader, lines, cleanup } = makeDownloader(server.url, { maxBytes: 16 });
  try {
    const result = await downloader.downloadItem({
      item: imageItem({ encryptQueryParam: 'big' }),
      messageId: 'wx-big',
      index: 0,
    });
    assert.equal(result, null);
    assert.ok(hasLog(lines, 'warn', /大小上限/));
    assert.equal(existsSync(join(dir, 'media')), false);
  } finally {
    cleanup();
    await server.close();
  }
});

test('streamed body over media.maxBytes falls back (no content-length)', async () => {
  const chunk = Buffer.alloc(64, 0x61);
  const server = await startCdnServer({
    '/chunked': (req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.write(chunk);
      res.write(chunk);
      res.end();
    },
  });
  const { downloader, lines, cleanup } = makeDownloader(server.url, { maxBytes: 100 });
  try {
    const result = await downloader.downloadItem({
      item: imageItem({ fullUrl: `${server.url}/chunked` }),
      messageId: 'wx-chunked',
      index: 0,
    });
    assert.equal(result, null);
    assert.ok(hasLog(lines, 'warn', /大小上限/));
  } finally {
    cleanup();
    await server.close();
  }
});

test('media download timeout falls back to URL-only', async () => {
  const server = await startCdnServer({
    '/slow': (req, res) => {
      setTimeout(() => {
        if (!res.writableEnded) sendBuffer(res, JPEG);
      }, 300);
    },
  });
  const { downloader, lines, cleanup } = makeDownloader(server.url, { timeoutMs: 30 });
  try {
    const result = await downloader.downloadItem({
      item: imageItem({ fullUrl: `${server.url}/slow` }),
      messageId: 'wx-slow',
      index: 0,
    });
    assert.equal(result, null);
    assert.ok(hasLog(lines, 'warn', /超时/));
  } finally {
    cleanup();
    await server.close();
  }
});

test('malformed key falls back before any network request', async () => {
  const server = await startCdnServer({});
  const { downloader, lines, cleanup } = makeDownloader(server.url);
  try {
    const result = await downloader.downloadItem({
      item: imageItem({ encryptQueryParam: 'x', aeskey: 'not-a-key' }),
      messageId: 'wx-badkey',
      index: 0,
    });
    assert.equal(result, null);
    assert.equal(server.requests.length, 0);
    assert.ok(hasLog(lines, 'warn', /malformed/));
  } finally {
    cleanup();
    await server.close();
  }
});

test('file/video/voice without an AES key keep URL only (no plaintext download)', async () => {
  const server = await startCdnServer({});
  const { downloader, lines, cleanup } = makeDownloader(server.url);
  try {
    for (const [type, field] of [
      [3, 'voice_item'],
      [4, 'file_item'],
      [5, 'video_item'],
    ]) {
      const result = await downloader.downloadItem({
        item: makeItem(type, { media: { encrypt_query_param: 'nokey' } }, field),
        messageId: `wx-nokey-${type}`,
        index: 0,
      });
      assert.equal(result, null);
    }
    assert.equal(server.requests.length, 0);
    assert.ok(hasLog(lines, 'debug', /no AES key/));
  } finally {
    cleanup();
    await server.close();
  }
});

test('unsupported item types are ignored without network I/O', async () => {
  const server = await startCdnServer({});
  const { downloader, cleanup } = makeDownloader(server.url);
  try {
    assert.equal(await downloader.downloadItem({ item: { type: 1, text_item: { text: 'hi' } }, messageId: 'm', index: 0 }), null);
    assert.equal(await downloader.downloadItem({ item: { type: 11 }, messageId: 'm', index: 0 }), null);
    assert.equal(server.requests.length, 0);
  } finally {
    cleanup();
    await server.close();
  }
});

// ── Hydration into InboundMessage ───────────────────────────────────────────

/** @param {string} serverUrl @param {any[]} items */
function inboundWithItems(serverUrl, items) {
  return mapInbound(
    {
      message_type: 1,
      from_user_id: 'wxid-user@im.wechat',
      message_id: 4242,
      create_time_ms: 1_700_000_000_000,
      item_list: items,
    },
    { cdnBaseUrl: serverUrl },
  );
}

test('hydrateInboundMedia adds path/mimeType/name/size to attachments', async () => {
  const key = randomBytes(16);
  const server = await startCdnServer({
    '/download': downloadRoute({ img: encrypt(JPEG, key), file: encrypt(PDF, key) }),
  });
  const { downloader, cleanup } = makeDownloader(server.url);
  try {
    const inbound = inboundWithItems(server.url, [
      { type: 1, text_item: { text: '看看这两个' } },
      imageItem({ encryptQueryParam: 'img', aeskey: key.toString('hex') }),
      makeItem(
        4,
        { file_name: '报告.pdf', media: { encrypt_query_param: 'file', aes_key: key.toString('base64') } },
        'file_item',
      ),
    ]);
    assert.ok(inbound);
    const hydrated = await hydrateInboundMedia(inbound, { downloader, maxItems: 8 });
    assert.equal(hydrated, inbound);
    assert.equal(inbound.attachments.length, 2);
    const [image, file] = inbound.attachments;
    assert.equal(image.kind, 'image');
    assert.ok(image.path);
    assert.equal(image.mimeType, 'image/jpeg');
    assert.equal(image.name, 'image-2.jpg'); // item_list index 1 (after the text item)
    assert.equal(image.size, JPEG.length);
    assert.ok(image.url, 'url is kept for diagnostics/fallback');
    assert.equal(file.kind, 'file');
    assert.ok(file.path);
    assert.equal(file.mimeType, 'application/pdf');
    assert.equal(file.name, '报告.pdf');
    assert.equal(file.size, PDF.length);
    assert.deepEqual(readFileSync(file.path), PDF);
  } finally {
    cleanup();
    await server.close();
  }
});

test('hydrateInboundMedia only downloads for user messages', async () => {
  const key = randomBytes(16);
  const server = await startCdnServer({ '/download': downloadRoute({ img: encrypt(JPEG, key) }) });
  const { downloader, cleanup } = makeDownloader(server.url);
  try {
    const inbound = inboundWithItems(server.url, [imageItem({ encryptQueryParam: 'img', aeskey: key.toString('hex') })]);
    assert.ok(inbound);
    inbound.raw.message_type = 2; // simulate a bot echo that somehow reached us
    const hydrated = await hydrateInboundMedia(inbound, { downloader });
    assert.equal(hydrated?.attachments[0].path, undefined);
    assert.equal(server.requests.length, 0);
  } finally {
    cleanup();
    await server.close();
  }
});

test('hydrateInboundMedia caps downloads per message', async () => {
  const key = randomBytes(16);
  const server = await startCdnServer({ '/download': downloadRoute({ imgA: encrypt(JPEG, key), imgB: encrypt(JPEG, key), imgC: encrypt(JPEG, key) }) });
  const { downloader, lines, log, cleanup } = makeDownloader(server.url);
  try {
    const inbound = inboundWithItems(server.url, [
      imageItem({ encryptQueryParam: 'imgA', aeskey: key.toString('hex') }),
      imageItem({ encryptQueryParam: 'imgB', aeskey: key.toString('hex') }),
      imageItem({ encryptQueryParam: 'imgC', aeskey: key.toString('hex') }),
    ]);
    assert.ok(inbound);
    await hydrateInboundMedia(inbound, { downloader, maxItems: 2, log });
    assert.equal(server.requests.length, 2);
    assert.ok(inbound.attachments[0].path);
    assert.ok(inbound.attachments[1].path);
    assert.equal(inbound.attachments[2].path, undefined);
    assert.ok(inbound.attachments[2].url);
    assert.ok(hasLog(lines, 'warn', /too many media items/));
  } finally {
    cleanup();
    await server.close();
  }
});

test('hydrateInboundMedia isolates per-item failures', async () => {
  const key = randomBytes(16);
  const server = await startCdnServer({ '/download': downloadRoute({ good: encrypt(JPEG, key) }) });
  const { downloader, cleanup } = makeDownloader(server.url);
  try {
    const inbound = inboundWithItems(server.url, [
      imageItem({ encryptQueryParam: 'missing', aeskey: key.toString('hex') }),
      imageItem({ encryptQueryParam: 'good', aeskey: key.toString('hex') }),
    ]);
    assert.ok(inbound);
    const hydrated = await hydrateInboundMedia(inbound, { downloader });
    assert.equal(hydrated?.attachments[0].path, undefined);
    assert.ok(hydrated?.attachments[0].url);
    assert.ok(hydrated?.attachments[1].path);
    assert.equal(hydrated?.attachments[1].mimeType, 'image/jpeg');
  } finally {
    cleanup();
    await server.close();
  }
});

test('hydrateInboundMedia is a no-op without a downloader or attachments', async () => {
  const inbound = inboundWithItems('https://cdn.example/c2c', [imageItem({ encryptQueryParam: 'x' })]);
  assert.ok(inbound);
  assert.equal(await hydrateInboundMedia(inbound, {}), inbound);
  assert.equal(inbound.attachments[0].path, undefined);
  assert.equal(await hydrateInboundMedia(null, {}), null);
});
