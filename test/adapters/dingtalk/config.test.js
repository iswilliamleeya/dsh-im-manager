import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_WEBHOOK_PATH,
  normalizeConfig,
  normalizeWebhookPath,
  resolveSecretValue,
  validateConfig,
} from '../../../src/adapters/dingtalk/config.js';

test('normalizeConfig applies safe defaults', () => {
  const config = normalizeConfig();
  assert.equal(config.mode, 'stream');
  assert.equal(config.accountId, 'dingtalk');
  assert.equal(config.webhookPath, DEFAULT_WEBHOOK_PATH);
  assert.equal(config.verifySignature, true);
  assert.equal(config.quoteReply, false);
  assert.equal(config.markdownTitle, 'DSH');
  assert.equal(config.requestTimeoutMs, 15_000);
  assert.equal(config.signatureMaxSkewMs, 3_600_000);
  assert.equal(config.keepAlive, false);
});

test('normalizeConfig resolves env: values through ctx.secret and process.env', () => {
  const secret = (name) => ({ DINGTALK_CLIENT_ID: 'ctx_id', DINGTALK_CLIENT_SECRET: 'ctx_secret' })[name];
  const config = normalizeConfig(
    { mode: 'stream', clientId: 'env:DINGTALK_CLIENT_ID', clientSecret: 'env:DINGTALK_CLIENT_SECRET' },
    { secret },
  );
  assert.equal(config.clientId, 'ctx_id');
  assert.equal(config.clientSecret, 'ctx_secret');
  assert.equal(config.robotCode, 'ctx_id'); // robotCode falls back to clientId

  process.env.DINGTALK_TEST_VALUE = 'from_env';
  try {
    assert.equal(resolveSecretValue('env:DINGTALK_TEST_VALUE'), 'from_env');
    assert.equal(resolveSecretValue('env:DINGTALK_TEST_MISSING'), '');
    assert.equal(resolveSecretValue('plain-value'), 'plain-value');
    assert.equal(resolveSecretValue('  spaced  '), 'spaced');
    assert.equal(resolveSecretValue(undefined), '');
  } finally {
    delete process.env.DINGTALK_TEST_VALUE;
  }
});

test('normalizeWebhookPath always yields a leading-slash path', () => {
  assert.equal(normalizeWebhookPath(undefined), '/webhook/dingtalk');
  assert.equal(normalizeWebhookPath(''), '/webhook/dingtalk');
  assert.equal(normalizeWebhookPath('webhook/dingtalk'), '/webhook/dingtalk');
  assert.equal(normalizeWebhookPath('/webhook/dingtalk/'), '/webhook/dingtalk');
  assert.equal(normalizeWebhookPath('/'), '/');
});

test('normalizeConfig keeps explicit booleans/overrides', () => {
  const config = normalizeConfig({
    mode: 'webhook',
    accountId: 'work',
    clientId: 'id',
    clientSecret: 'secret',
    signatureSecret: 'sig-secret',
    verifySignature: false,
    signatureMaxSkewMs: 5000,
    requestTimeoutMs: 1000,
    markdownTitle: 'Bot',
    keepAlive: true,
    quoteReply: true,
    botUserId: 'bot-1',
    ua: 'custom-ua',
  });
  assert.equal(config.mode, 'webhook');
  assert.equal(config.accountId, 'work');
  assert.equal(config.signatureSecret, 'sig-secret');
  assert.equal(config.verifySignature, false);
  assert.equal(config.signatureMaxSkewMs, 5000);
  assert.equal(config.requestTimeoutMs, 1000);
  assert.equal(config.markdownTitle, 'Bot');
  assert.equal(config.keepAlive, true);
  assert.equal(config.quoteReply, true);
  assert.equal(config.botUserId, 'bot-1');
  assert.equal(config.ua, 'custom-ua');
  assert.equal(normalizeConfig({ mode: 'nope' }).mode, 'stream');
  assert.equal(normalizeConfig({ quoteReply: 'yes' }).quoteReply, false);
});

test('validateConfig accepts raw channel config (as doctor passes it)', () => {
  assert.doesNotThrow(() => validateConfig({
    enabled: true,
    accountId: 'dingtalk',
    mode: 'stream',
    clientId: 'id',
    clientSecret: 'secret',
    webhookPath: '/webhook/dingtalk',
  }));
  assert.doesNotThrow(() => validateConfig({
    mode: 'webhook',
    clientId: 'id',
    clientSecret: 'secret',
    webhookPath: '/webhook/dingtalk',
  }));
  // signatureSecret alone is enough in webhook mode.
  assert.doesNotThrow(() => validateConfig({
    mode: 'webhook',
    signatureSecret: 'sig',
    verifySignature: true,
  }));
  // verifySignature=false allows credential-less local testing.
  assert.doesNotThrow(() => validateConfig({ mode: 'webhook', verifySignature: false }));
});

test('validateConfig rejects incomplete raw config with actionable errors', () => {
  assert.throws(
    () => validateConfig({ mode: 'stream', clientSecret: 'secret' }),
    /clientId .*required/,
  );
  assert.throws(
    () => validateConfig({ mode: 'stream', clientId: 'id' }),
    /clientSecret .*required/,
  );
  assert.throws(
    () => validateConfig({ mode: 'webhook', clientId: 'id', verifySignature: true }),
    /clientSecret .*required to verify webhook signatures/,
  );
  // webhookPath is normalized rather than rejected, so a missing leading slash is fine.
  assert.doesNotThrow(() => validateConfig({
    mode: 'stream',
    clientId: 'id',
    clientSecret: 'secret',
    webhookPath: 'webhook/dingtalk',
  }));
});

test('validateConfig accepts the normalized object returned by normalizeConfig', () => {
  const normalized = normalizeConfig({ mode: 'stream', clientId: 'id', clientSecret: 'secret' });
  assert.equal(validateConfig(normalized), normalized);
});
