/**
 * Protocol primitives: version encoding, X-WECHAT-UIN, headers, base_info,
 * base-URL trust rules, redaction.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ADAPTER_VERSION,
  CLIENT_VERSION,
  DEFAULT_BOT_AGENT,
  DEFAULT_CDN_BASE_URL,
  HEADERS,
  assertTrustedBaseUrl,
  buildApplicationHeaders,
  buildBaseInfo,
  buildCdnMediaUrl,
  buildHeaders,
  buildWechatUin,
  clientVersionFromString,
  describeError,
  encodeClientVersion,
  isOfficialWeixinHost,
  normalizeBaseUrl,
  randomUint32,
  redactSecrets,
  truncateForLog,
} from '../../../src/adapters/weixin/protocol.js';

test('encodeClientVersion encodes 0x00MMNNPP as a uint32', () => {
  assert.equal(encodeClientVersion(2, 4, 8), 0x00020408);
  assert.equal(encodeClientVersion(2, 4, 8), 132104);
  assert.equal(encodeClientVersion(0, 1, 0), 256);
  assert.equal(encodeClientVersion(0, 0, 0), 0);
  // High byte is fixed to zero / values masked to 8 bits.
  assert.equal(encodeClientVersion(256, 4, 8), 0x00000408);
  assert.equal(encodeClientVersion(-1, -1, -1), 0x00ffffff);
});

test('clientVersionFromString parses dotted versions and tolerates garbage', () => {
  assert.equal(clientVersionFromString('2.4.8'), 132104);
  assert.equal(clientVersionFromString('0.1.0'), 256);
  assert.equal(clientVersionFromString('1'), 0x00010000);
  assert.equal(clientVersionFromString(''), 0);
  assert.equal(clientVersionFromString('v1.2.3'), 515); // NaN major -> 0
});

test('adapter version 0.1.0 is the reported client version', () => {
  assert.equal(ADAPTER_VERSION, '0.1.0');
  assert.equal(CLIENT_VERSION, 256);
});

test('buildWechatUin is base64 of the decimal uint32 string', () => {
  assert.equal(buildWechatUin(123), Buffer.from('123', 'utf8').toString('base64'));
  // Deterministic random source for tests: 0.5 -> 2147483647.
  assert.equal(buildWechatUin(undefined, () => 0.5), Buffer.from('2147483648', 'utf8').toString('base64'));
  assert.equal(buildWechatUin(0xffffffff), Buffer.from('4294967295', 'utf8').toString('base64'));
});

test('random uint32 always decodes to a valid decimal', () => {
  const value = randomUint32(() => 0.123456);
  assert.ok(Number.isInteger(value));
  assert.ok(value >= 0 && value <= 0xffffffff);
  const defaultRandom = randomUint32();
  assert.ok(defaultRandom >= 0 && defaultRandom <= 0xffffffff);
});

test('buildHeaders produces the full JSON request header set', () => {
  const headers = buildHeaders({ token: '  test-token  ', uin: 123, clientVersion: 256 });
  assert.equal(headers[HEADERS.CONTENT_TYPE], 'application/json');
  assert.equal(headers[HEADERS.AUTHORIZATION_TYPE], 'ilink_bot_token');
  assert.equal(headers[HEADERS.AUTHORIZATION], 'Bearer test-token');
  assert.equal(headers[HEADERS.X_WECHAT_UIN], 'MTIz');
  assert.equal(headers[HEADERS.ILINK_APP_ID], 'bot');
  assert.equal(headers[HEADERS.ILINK_APP_CLIENT_VERSION], '256');
  assert.equal(headers[HEADERS.SK_ROUTE_TAG], undefined);

  const routed = buildHeaders({ routeTag: ' shenzhen ' });
  assert.equal(routed[HEADERS.SK_ROUTE_TAG], 'shenzhen');
});

test('buildHeaders omits Authorization when there is no token', () => {
  const headers = buildHeaders({});
  assert.equal(headers[HEADERS.AUTHORIZATION], undefined);
  assert.equal(headers[HEADERS.AUTHORIZATION_TYPE], 'ilink_bot_token');
  assert.ok(headers[HEADERS.X_WECHAT_UIN].length > 0);
});

test('QR status polling uses application headers only', () => {
  const headers = buildApplicationHeaders({ routeTag: 'rt', clientVersion: 256 });
  assert.deepEqual(headers, {
    [HEADERS.ILINK_APP_ID]: 'bot',
    [HEADERS.ILINK_APP_CLIENT_VERSION]: '256',
    [HEADERS.SK_ROUTE_TAG]: 'rt',
  });
});

test('buildBaseInfo defaults match the documented base_info', () => {
  assert.deepEqual(buildBaseInfo(), { channel_version: '0.1.0', bot_agent: DEFAULT_BOT_AGENT });
  assert.deepEqual(buildBaseInfo({ channelVersion: '9.9.9', botAgent: 'custom-agent' }), {
    channel_version: '9.9.9',
    bot_agent: 'custom-agent',
  });
  assert.equal(buildBaseInfo({ botAgent: '   ' }).bot_agent, 'dsh-im-manager');
});

test('normalizeBaseUrl enforces https and strips trailing slashes', () => {
  assert.equal(normalizeBaseUrl('https://ilinkai.weixin.qq.com/'), 'https://ilinkai.weixin.qq.com');
  assert.equal(normalizeBaseUrl(' https://ilinkai.weixin.qq.com// '), 'https://ilinkai.weixin.qq.com');
  assert.equal(normalizeBaseUrl('https://example.com/base/'), 'https://example.com/base');
  assert.throws(() => normalizeBaseUrl('http://ilinkai.weixin.qq.com'), /must use https/);
  assert.throws(() => normalizeBaseUrl(''), /non-empty https/);
  assert.throws(() => normalizeBaseUrl('not a url'), /not a valid URL/);
  assert.throws(() => normalizeBaseUrl('https://user:pass@ilinkai.weixin.qq.com'), /must not contain credentials/);
  assert.throws(() => normalizeBaseUrl('https://ilinkai.weixin.qq.com/?x=1'), /query/);
});

test('isOfficialWeixinHost only trusts weixin.qq.com and its subdomains', () => {
  assert.equal(isOfficialWeixinHost('weixin.qq.com'), true);
  assert.equal(isOfficialWeixinHost('ilinkai.weixin.qq.com'), true);
  assert.equal(isOfficialWeixinHost('IDC.WEIXIN.QQ.COM'), true);
  assert.equal(isOfficialWeixinHost('evilweixin.qq.com'), false);
  assert.equal(isOfficialWeixinHost('weixin.qq.com.evil.example'), false);
  assert.equal(isOfficialWeixinHost(''), false);
});

test('assertTrustedBaseUrl accepts official hosts and the configured host only', () => {
  assert.equal(
    assertTrustedBaseUrl('https://ilinkai.weixin.qq.com', { configuredBaseUrl: 'https://ilinkai.weixin.qq.com' }),
    'https://ilinkai.weixin.qq.com',
  );
  assert.equal(assertTrustedBaseUrl('https://idc.weixin.qq.com'), 'https://idc.weixin.qq.com');
  assert.equal(
    assertTrustedBaseUrl('https://gateway.internal.example', { configuredBaseUrl: 'https://gateway.internal.example' }),
    'https://gateway.internal.example',
  );
  assert.throws(() => assertTrustedBaseUrl('https://evil.example.com'), /not trusted/);
  assert.throws(
    () => assertTrustedBaseUrl('https://evil.example.com', { configuredBaseUrl: 'https://ilinkai.weixin.qq.com' }),
    /not trusted/,
  );
  assert.throws(() => assertTrustedBaseUrl('http://ilinkai.weixin.qq.com'), /must use https/);
});

test('buildCdnMediaUrl builds the documented CDN download URL', () => {
  const url = buildCdnMediaUrl(DEFAULT_CDN_BASE_URL, 'a+b/c=');
  assert.equal(
    url,
    'https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=a%2Bb%2Fc%3D',
  );
  assert.equal(buildCdnMediaUrl('https://cdn.example.com/base/', 'x y'), 'https://cdn.example.com/base/download?encrypted_query_param=x%20y');
  assert.equal(buildCdnMediaUrl(DEFAULT_CDN_BASE_URL, ''), undefined);
  assert.equal(buildCdnMediaUrl(DEFAULT_CDN_BASE_URL, undefined), undefined);
});

test('redactSecrets masks bearer tokens and token-ish JSON fields', () => {
  assert.equal(redactSecrets('Authorization: Bearer abc.def-123'), 'Authorization: Bearer <redacted>');
  assert.match(redactSecrets('{"bot_token":"secret-value"}'), /bot_token.*<redacted>/);
  assert.match(redactSecrets('context_token=abc123'), /context_token=<redacted>/);
  assert.equal(redactSecrets(undefined), '');
  assert.equal(redactSecrets(42), '42');
});

test('truncateForLog and describeError keep logs short and stack-free', () => {
  assert.equal(truncateForLog('abc', 10), 'abc');
  assert.equal(truncateForLog('a'.repeat(20), 5), 'aaaaa…');
  const error = new Error('boom with Bearer top-secret-token');
  const described = describeError(error);
  assert.match(described, /^Error: boom/);
  assert.ok(!described.includes('top-secret-token'));
  assert.ok(!described.includes('\n'));
});
