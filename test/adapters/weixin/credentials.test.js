/**
 * Credential store: paths, 0600 permissions, atomic writes, validation,
 * deletion, redaction, change-detection signature.
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  CREDENTIAL_VERSION,
  credentialFileSignature,
  credentialPath,
  deleteCredential,
  deleteCredentialFile,
  normalizeCredential,
  readCredential,
  readCredentialFile,
  redactCredential,
  writeCredential,
  writeCredentialFile,
} from '../../../src/adapters/weixin/credentials.js';
import { cleanupDir, makeTempDir } from './helpers.js';

const CREDENTIAL = {
  version: 1,
  token: 'bot-token-value-never-print',
  ilinkBotId: 'bot-xyz@im.bot',
  userId: 'wxid-user@im.wechat',
  baseUrl: 'https://ilinkai.weixin.qq.com',
  savedAt: '2026-01-02T03:04:05.000Z',
};

test('credentialPath defaults to <stateDir>/credentials.json', () => {
  const stateDir = '/tmp/weixin-cred-state';
  assert.equal(credentialPath(stateDir, {}), join(stateDir, 'credentials.json'));
  assert.equal(credentialPath(stateDir, { credentialsFile: '' }), join(stateDir, 'credentials.json'));
});

test('credentialPath honours relative and absolute credentialsFile', () => {
  const stateDir = '/tmp/weixin-cred-state';
  assert.equal(credentialPath(stateDir, { credentialsFile: 'secrets/wx.json' }), join(stateDir, 'secrets/wx.json'));
  assert.equal(credentialPath(stateDir, { credentialsFile: '/etc/dsh/wx.json' }), '/etc/dsh/wx.json');
});

test('writeCredential/readCredential round-trips through the default path', () => {
  const dir = makeTempDir();
  try {
    const file = writeCredential(dir, {}, CREDENTIAL);
    assert.equal(file, join(dir, 'credentials.json'));
    const loaded = readCredential(dir, {});
    assert.ok(loaded);
    assert.equal(loaded.version, CREDENTIAL_VERSION);
    assert.equal(loaded.token, CREDENTIAL.token);
    assert.equal(loaded.ilinkBotId, CREDENTIAL.ilinkBotId);
    assert.equal(loaded.userId, CREDENTIAL.userId);
    assert.equal(loaded.baseUrl, CREDENTIAL.baseUrl);
    assert.equal(loaded.savedAt, CREDENTIAL.savedAt);
  } finally {
    cleanupDir(dir);
  }
});

test('credential file is mode 0600 and directory 0700', () => {
  const dir = makeTempDir();
  try {
    const file = writeCredentialFile(join(dir, 'nested', 'credentials.json'), CREDENTIAL);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(join(dir, 'nested')).mode & 0o777, 0o700);
  } finally {
    cleanupDir(dir);
  }
});

test('writes are atomic: no temp files are left behind', () => {
  const dir = makeTempDir();
  try {
    const file = join(dir, 'credentials.json');
    writeCredentialFile(file, CREDENTIAL);
    writeCredentialFile(file, { ...CREDENTIAL, token: 'rotated-token' });
    const leftovers = readdirSync(dir).filter((name) => name.includes('.tmp'));
    assert.deepEqual(leftovers, []);
    assert.equal(readCredentialFile(file)?.token, 'rotated-token');
    // Rewriting keeps 0600 rather than inheriting an older permissive mode.
    assert.equal(statSync(file).mode & 0o777, 0o600);
  } finally {
    cleanupDir(dir);
  }
});

test('normalizeCredential fills savedAt and validates token/ilinkBotId/baseUrl', () => {
  const normalized = normalizeCredential({
    token: ' tok ',
    ilinkBotId: ' bot ',
    baseUrl: 'https://ilinkai.weixin.qq.com/',
  }, { now: () => 1_700_000_000_000 });
  assert.equal(normalized.token, 'tok');
  assert.equal(normalized.ilinkBotId, 'bot');
  assert.equal(normalized.baseUrl, 'https://ilinkai.weixin.qq.com');
  assert.equal(normalized.savedAt, new Date(1_700_000_000_000).toISOString());

  assert.throws(() => normalizeCredential({ ilinkBotId: 'b', baseUrl: 'https://a.weixin.qq.com' }), /missing its token/);
  assert.throws(() => normalizeCredential({ token: 't', baseUrl: 'https://a.weixin.qq.com' }), /missing ilinkBotId/);
  assert.throws(
    () => normalizeCredential({ token: 't', ilinkBotId: 'b', baseUrl: 'http://a.weixin.qq.com' }),
    /invalid baseUrl/,
  );
});

test('readCredential returns undefined for missing, corrupt, wrong-version files', () => {
  const dir = makeTempDir();
  try {
    assert.equal(readCredential(dir, {}), undefined);
    writeFileSync(join(dir, 'credentials.json'), '{not json', { mode: 0o600 });
    assert.equal(readCredential(dir, {}), undefined);
    writeFileSync(join(dir, 'credentials.json'), JSON.stringify({ ...CREDENTIAL, version: 2 }), { mode: 0o600 });
    assert.equal(readCredential(dir, {}), undefined);
    writeFileSync(join(dir, 'credentials.json'), JSON.stringify({ version: 1, token: 'x' }), { mode: 0o600 });
    assert.equal(readCredential(dir, {}), undefined);
  } finally {
    cleanupDir(dir);
  }
});

test('credentialsFile overrides the credential path for read/write/delete', () => {
  const dir = makeTempDir();
  try {
    const config = { credentialsFile: 'custom/wx-cred.json' };
    const file = writeCredential(dir, config, CREDENTIAL);
    assert.equal(file, join(dir, 'custom/wx-cred.json'));
    assert.equal(readCredential(dir, config)?.ilinkBotId, CREDENTIAL.ilinkBotId);
    assert.equal(deleteCredential(dir, config), true);
    assert.equal(existsSync(file), false);
    assert.equal(deleteCredential(dir, config), false);
  } finally {
    cleanupDir(dir);
  }
});

test('deleteCredentialFile reports whether it removed anything', () => {
  const dir = makeTempDir();
  try {
    const file = join(dir, 'credentials.json');
    assert.equal(deleteCredentialFile(file), false);
    writeCredentialFile(file, CREDENTIAL);
    assert.equal(deleteCredentialFile(file), true);
    assert.equal(deleteCredentialFile(file), false);
  } finally {
    cleanupDir(dir);
  }
});

test('redactCredential never exposes the token', () => {
  const redacted = redactCredential(CREDENTIAL);
  assert.deepEqual(redacted, {
    ilinkBotId: CREDENTIAL.ilinkBotId,
    userId: CREDENTIAL.userId,
    baseUrl: CREDENTIAL.baseUrl,
    savedAt: CREDENTIAL.savedAt,
  });
  assert.equal(JSON.stringify(redacted).includes(CREDENTIAL.token), false);
  assert.equal(redactCredential(undefined).ilinkBotId, '');
});

test('credentialFileSignature changes when the file appears or is rewritten', () => {
  const dir = makeTempDir();
  try {
    const file = join(dir, 'credentials.json');
    assert.equal(credentialFileSignature(file), '');
    writeCredentialFile(file, CREDENTIAL);
    const first = credentialFileSignature(file);
    assert.match(first, /^\d+(\.\d+)?:\d+$/);
    writeCredentialFile(file, { ...CREDENTIAL, token: 'rotated-token-value' });
    const second = credentialFileSignature(file);
    assert.notEqual(second, first);
  } finally {
    cleanupDir(dir);
  }
});

test('credential file content is pretty-printed JSON with a trailing newline', () => {
  const dir = makeTempDir();
  try {
    const file = writeCredentialFile(join(dir, 'credentials.json'), CREDENTIAL);
    const raw = readFileSync(file, 'utf8');
    assert.ok(raw.endsWith('\n'));
    assert.ok(raw.includes('\n  "ilinkBotId"'));
  } finally {
    cleanupDir(dir);
  }
});
