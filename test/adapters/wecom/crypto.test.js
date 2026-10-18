/**
 * WeCom crypto unit tests: callback signature + AES-256-CBC envelope roundtrip,
 * plus media decryption. All keys/tokens are synthesized; nothing touches the
 * real platform.
 */
import assert from 'node:assert/strict';
import { createCipheriv } from 'node:crypto';
import { test } from 'node:test';

import {
  computeSignature,
  decodeEncodingAESKey,
  decryptWecomMedia,
  decryptWecomMessage,
  encryptWecomMessage,
  pkcs7Pad,
  pkcs7Unpad,
  sha1Hex,
  verifySignature,
} from '../../../src/adapters/wecom/crypto.js';

/** Deterministic 32-byte key, Base64 without trailing '=' (WeCom style). */
function makeEncodingAESKey(fill = 7) {
  return Buffer.alloc(32, fill).toString('base64').replace(/=+$/, '');
}

const TOKEN = 'QDG6eK';
const TIMESTAMP = '1409659813';
const NONCE = '1372623149';
const ENCRYPT_SAMPLE = 'abcdefhijklmn';
// Independently computed: sha1("13726231491409659813QDG6eK" + "abcdefhijklmn")
const SIGNATURE_SAMPLE = 'bc6b33b9368899ee0ec1a328e3bfd31c944dead4';

test('computeSignature matches the documented WeCom vector', () => {
  assert.equal(
    computeSignature({ token: TOKEN, timestamp: TIMESTAMP, nonce: NONCE, encrypt: ENCRYPT_SAMPLE }),
    SIGNATURE_SAMPLE,
  );
});

test('computeSignature sorts parameters lexicographically, order independent', () => {
  const a = computeSignature({ token: 'tok', timestamp: '1700000000', nonce: 'n1', encrypt: 'cipher' });
  const b = computeSignature({ encrypt: 'cipher', nonce: 'n1', timestamp: '1700000000', token: 'tok' });
  assert.equal(a, b);
  assert.equal(a, sha1Hex(['1700000000', 'cipher', 'n1', 'tok'].sort().join('')));
});

test('verifySignature accepts the right signature and rejects tampering', () => {
  assert.equal(
    verifySignature(SIGNATURE_SAMPLE, { token: TOKEN, timestamp: TIMESTAMP, nonce: NONCE, encrypt: ENCRYPT_SAMPLE }),
    true,
  );
  assert.equal(
    verifySignature(SIGNATURE_SAMPLE, { token: TOKEN, timestamp: TIMESTAMP, nonce: NONCE, encrypt: 'tampered' }),
    false,
  );
  assert.equal(
    verifySignature('short', { token: TOKEN, timestamp: TIMESTAMP, nonce: NONCE, encrypt: ENCRYPT_SAMPLE }),
    false,
  );
});

test('decodeEncodingAESKey decodes 43-char keys and rejects invalid lengths', () => {
  const key = makeEncodingAESKey(7);
  assert.equal(key.length, 43);
  assert.equal(decodeEncodingAESKey(key).length, 32);
  assert.throws(() => decodeEncodingAESKey(''), /empty/);
  assert.throws(() => decodeEncodingAESKey('abcd'), /invalid encodingAESKey/);
});

test('PKCS#7 pads to a 32-byte block and unpads symmetrically', () => {
  for (const length of [0, 1, 15, 16, 31, 32, 33, 100]) {
    const input = Buffer.alloc(length, 0x61);
    const padded = pkcs7Pad(input, 32);
    assert.equal(padded.length % 32, 0);
    assert.ok(padded.length > input.length || input.length === 0);
    assert.deepEqual(pkcs7Unpad(padded, 32), input);
  }
  assert.throws(() => pkcs7Unpad(Buffer.alloc(32, 0), 32), /padding/);
});

test('AES envelope encrypt → decrypt roundtrips XML payloads', () => {
  const encodingAESKey = makeEncodingAESKey(11);
  const plaintext = '<xml><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[你好，企业微信]]></Content></xml>';
  const { encrypt, signature } = encryptWecomMessage({
    encodingAESKey,
    plaintext,
    receiveId: 'ww-corp-demo',
    timestamp: TIMESTAMP,
    nonce: NONCE,
    token: TOKEN,
  });
  assert.equal(
    signature,
    computeSignature({ token: TOKEN, timestamp: TIMESTAMP, nonce: NONCE, encrypt }),
  );
  assert.equal(
    decryptWecomMessage({ encodingAESKey, encrypt, receiveId: 'ww-corp-demo' }),
    plaintext,
  );
});

test('decryptWecomMessage rejects a wrong receiveId (corpId) and garbage ciphertext', () => {
  const encodingAESKey = makeEncodingAESKey(12);
  const { encrypt } = encryptWecomMessage({
    encodingAESKey,
    plaintext: '<xml/>',
    receiveId: 'corp-a',
    timestamp: TIMESTAMP,
    nonce: NONCE,
    token: TOKEN,
  });
  assert.throws(
    () => decryptWecomMessage({ encodingAESKey, encrypt, receiveId: 'corp-b' }),
    /receiveId mismatch/,
  );
  assert.throws(
    () => decryptWecomMessage({ encodingAESKey, encrypt: Buffer.alloc(8).toString('base64'), receiveId: 'corp-a' }),
    /padding|ciphertext|payload|block/i,
  );
});

test('decryptWecomMedia recovers a file encrypted with the per-URL aeskey scheme', () => {
  const aesKey = makeEncodingAESKey(21);
  const key = decodeEncodingAESKey(aesKey);
  const plaintext = Buffer.from('fake-image-binary-data', 'utf8');
  const padded = pkcs7Pad(plaintext, 32);
  const cipher = createCipheriv('aes-256-cbc', key, key.subarray(0, 16));
  cipher.setAutoPadding(false);
  const encrypted = Buffer.concat([cipher.update(padded), cipher.final()]);

  assert.deepEqual(decryptWecomMedia(encrypted, aesKey), plaintext);
  assert.throws(() => decryptWecomMedia(encrypted, makeEncodingAESKey(22)), /padding/);
  assert.throws(() => decryptWecomMedia(Buffer.alloc(0), aesKey), /empty/);
});
