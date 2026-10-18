/**
 * `channels.weixin` normalization: defaults, media config (nested + flat
 * aliases), mode handling and structural validation.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  normalizeWeixinConfig,
  validateWeixinConfig,
} from '../../../src/adapters/weixin/config.js';

const BASE = 'https://ilinkai.weixin.qq.com';
const CDN = 'https://novac2c.cdn.weixin.qq.com/c2c';

test('normalizeWeixinConfig applies documented defaults', () => {
  const config = normalizeWeixinConfig({});
  assert.equal(config.enabled, false);
  assert.equal(config.accountId, 'weixin');
  assert.equal(config.mode, 'ilink');
  assert.equal(config.baseUrl, BASE);
  assert.equal(config.cdnBaseUrl, CDN);
  assert.equal(config.credentialsFile, '');
  assert.equal(config.requestTimeoutMs, 15_000);
  assert.equal(config.longPollTimeoutMs, 35_000);
  assert.deepEqual(config.reconnect, { enabled: true, baseDelayMs: 2_000, maxDelayMs: 30_000 });
  assert.equal(config.typing, true);
  assert.equal(config.botAgent, 'dsh-im-manager');
  assert.deepEqual(config.media, { download: true, maxBytes: 26_214_400, timeoutMs: 30_000, maxItemsPerMessage: 8 });
  assert.deepEqual(config.allowFrom, []);
  assert.deepEqual(config.groups, {});
});

test('normalizeWeixinConfig merges nested media config', () => {
  const config = normalizeWeixinConfig({
    media: { download: false, maxBytes: 1024, timeoutMs: 500, maxItemsPerMessage: 3 },
  });
  assert.deepEqual(config.media, { download: false, maxBytes: 1024, timeoutMs: 500, maxItemsPerMessage: 3 });
});

test('normalizeWeixinConfig accepts flat media aliases (nested wins)', () => {
  const flat = normalizeWeixinConfig({
    mediaDownload: false,
    mediaMaxBytes: 2048,
    mediaDownloadTimeoutMs: 750,
  });
  assert.deepEqual(flat.media, { download: false, maxBytes: 2048, timeoutMs: 750, maxItemsPerMessage: 8 });

  const mixed = normalizeWeixinConfig({ mediaDownload: false, media: { download: true, maxBytes: 4096 } });
  assert.equal(mixed.media.download, true);
  assert.equal(mixed.media.maxBytes, 4096);
});

test('invalid media numbers fall back to defaults instead of throwing', () => {
  const config = normalizeWeixinConfig({ media: { maxBytes: -1, timeoutMs: 0, maxItemsPerMessage: 'x' } });
  assert.equal(config.media.maxBytes, 26_214_400);
  assert.equal(config.media.timeoutMs, 30_000);
  assert.equal(config.media.maxItemsPerMessage, 8);
});

test('mode is case-insensitive for ilink and preserved for validation otherwise', () => {
  assert.equal(normalizeWeixinConfig({ mode: 'ILINK' }).mode, 'ilink');
  assert.equal(normalizeWeixinConfig({ mode: ' mp ' }).mode, 'mp');
});

test('validateWeixinConfig accepts a minimal config and returns it', () => {
  const config = normalizeWeixinConfig({ enabled: true, baseUrl: `${BASE}/` });
  assert.equal(validateWeixinConfig(config), config);
  // Normalization keeps the string as given; the iLink client strips the
  // trailing slash when it builds request URLs.
  assert.equal(config.baseUrl, `${BASE}/`);
});

test('validateWeixinConfig rejects invalid modes, URLs and reconnect bounds', () => {
  assert.throws(() => validateWeixinConfig(normalizeWeixinConfig({ mode: 'mp' })), /mode must be 'ilink'/);
  assert.throws(
    () => validateWeixinConfig(normalizeWeixinConfig({ baseUrl: 'http://ilinkai.weixin.qq.com' })),
    /must use https/,
  );
  assert.throws(
    () => validateWeixinConfig(normalizeWeixinConfig({ cdnBaseUrl: 'http://cdn.example.com' })),
    /cdnBaseUrl must use https/,
  );
  assert.throws(
    () => validateWeixinConfig(normalizeWeixinConfig({ reconnect: { baseDelayMs: 100, maxDelayMs: 10 } })),
    /baseDelayMs/,
  );
});

test('normalizeWeixinConfig filters allowFrom and bounds media values as integers', () => {
  const config = normalizeWeixinConfig({
    allowFrom: [' ok@im.wechat ', '', 42],
    media: { maxBytes: 12.9, timeoutMs: 3.9 },
  });
  assert.deepEqual(config.allowFrom, ['ok@im.wechat']);
  assert.equal(config.media.maxBytes, 12);
  assert.equal(config.media.timeoutMs, 3);
});
