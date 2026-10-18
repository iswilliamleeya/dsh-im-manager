/**
 * WeCom (企业微信) message crypto.
 *
 * Two distinct schemes are used by the platform, both AES-256-CBC:
 *
 * 1. Callback envelope (webhook mode): Base64 `EncodingAESKey` (43 chars) decodes
 *    to a 32-byte key; IV = first 16 bytes; plaintext is
 *    `random(16) + msgLen(4, big-endian) + msg + receiveId`, padded to a multiple
 *    of 32 bytes with PKCS#7. The envelope signature is
 *    `sha1(sort(token, timestamp, nonce, encrypt).join(""))`.
 *
 * 2. Media files (ws mode): each media URL carries its own Base64 `aeskey`
 *    (also 32 bytes after padding); IV = first 16 bytes; PKCS#7 padded to a
 *    multiple of 32 bytes.
 *
 * Nothing in this module logs or embeds secrets. Keys are only used locally.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** AES-256 key length in bytes. */
export const AES_KEY_LENGTH = 32;
/** WeCom uses a 32-byte PKCS#7 block, not the AES block size (16). */
export const PKCS7_BLOCK_SIZE = 32;

/**
 * Decode a WeCom Base64 key (`EncodingAESKey` or a media `aeskey`).
 * WeCom omits the trailing `=` padding; we add it back if needed.
 * @param {string} encoded
 * @returns {Buffer} 32-byte key
 */
export function decodeEncodingAESKey(encoded) {
  const trimmed = String(encoded ?? '').trim();
  if (!trimmed) throw new Error('encodingAESKey is empty');
  const withPadding = trimmed.endsWith('=') ? trimmed : `${trimmed}=`;
  const key = Buffer.from(withPadding, 'base64');
  if (key.length !== AES_KEY_LENGTH) {
    throw new Error(`invalid encodingAESKey (expected 32 bytes, got ${key.length})`);
  }
  return key;
}

/**
 * @param {Buffer} buf
 * @param {number} [blockSize]
 * @returns {Buffer}
 */
export function pkcs7Pad(buf, blockSize = PKCS7_BLOCK_SIZE) {
  const mod = buf.length % blockSize;
  const pad = mod === 0 ? blockSize : blockSize - mod;
  return Buffer.concat([buf, Buffer.alloc(pad, pad)]);
}

/**
 * @param {Buffer} buf
 * @param {number} [blockSize]
 * @returns {Buffer}
 */
export function pkcs7Unpad(buf, blockSize = PKCS7_BLOCK_SIZE) {
  if (buf.length === 0) throw new Error('invalid PKCS#7 payload (empty)');
  if (buf.length % 16 !== 0) throw new Error('invalid AES ciphertext length');
  const pad = buf[buf.length - 1];
  if (pad < 1 || pad > blockSize) throw new Error(`invalid PKCS#7 padding value: ${pad}`);
  if (pad > buf.length) throw new Error('invalid PKCS#7 payload length');
  for (let i = 0; i < pad; i += 1) {
    if (buf[buf.length - 1 - i] !== pad) throw new Error('invalid PKCS#7 padding bytes');
  }
  return buf.subarray(0, buf.length - pad);
}

/**
 * @param {string | Buffer} input
 * @returns {string} lowercase hex sha1
 */
export function sha1Hex(input) {
  return createHash('sha1').update(input).digest('hex');
}

/**
 * WeCom callback signature: sha1 of the lexicographically sorted
 * `[token, timestamp, nonce, encrypt]` joined with no separator.
 * @param {{ token: string, timestamp: string|number, nonce: string|number, encrypt: string }} params
 * @returns {string}
 */
export function computeSignature(params) {
  return sha1Hex(
    [params.token, params.timestamp, params.nonce, params.encrypt]
      .map((value) => String(value ?? ''))
      .sort()
      .join(''),
  );
}

/**
 * Constant-time signature verification.
 * @param {string} actual signature supplied by the platform
 * @param {{ token: string, timestamp: string|number, nonce: string|number, encrypt: string }} params
 * @returns {boolean}
 */
export function verifySignature(actual, params) {
  const expected = computeSignature(params);
  const left = Buffer.from(String(actual ?? ''), 'utf8');
  const right = Buffer.from(expected, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Decrypt a WeCom callback envelope.
 * @param {{ encodingAESKey: string, encrypt: string, receiveId?: string, verifyReceiveId?: boolean }} params
 * @returns {string} plaintext (XML or JSON)
 */
export function decryptWecomMessage(params) {
  const key = decodeEncodingAESKey(params.encodingAESKey);
  const iv = key.subarray(0, 16);
  const decipher = createDecipheriv('aes-256-cbc', key, iv);
  decipher.setAutoPadding(false);
  const decryptedPadded = Buffer.concat([
    decipher.update(Buffer.from(String(params.encrypt ?? ''), 'base64')),
    decipher.final(),
  ]);
  const payload = pkcs7Unpad(decryptedPadded, PKCS7_BLOCK_SIZE);
  if (payload.length < 20) {
    throw new Error(`invalid WeCom payload (expected >=20 bytes, got ${payload.length})`);
  }
  const msgLen = payload.readUInt32BE(16);
  const msgStart = 20;
  const msgEnd = msgStart + msgLen;
  if (msgEnd > payload.length) throw new Error('invalid WeCom payload message length');
  const plaintext = payload.subarray(msgStart, msgEnd).toString('utf8');
  const receiveId = String(params.receiveId ?? '');
  if (params.verifyReceiveId !== false && receiveId) {
    const trailing = payload.subarray(msgEnd).toString('utf8');
    if (trailing !== receiveId) throw new Error('receiveId mismatch (check corpId)');
  }
  return plaintext;
}

/**
 * Encrypt a plaintext into a WeCom callback envelope (used by tests, and by
 * environments that need passive replies).
 * @param {{ encodingAESKey: string, plaintext: string, receiveId?: string, timestamp: string|number, nonce: string|number, token: string }} params
 * @returns {{ encrypt: string, signature: string }}
 */
export function encryptWecomMessage(params) {
  const key = decodeEncodingAESKey(params.encodingAESKey);
  const iv = key.subarray(0, 16);
  const msg = Buffer.from(String(params.plaintext ?? ''), 'utf8');
  const msgLen = Buffer.alloc(4);
  msgLen.writeUInt32BE(msg.length, 0);
  const raw = Buffer.concat([
    randomBytes(16),
    msgLen,
    msg,
    Buffer.from(String(params.receiveId ?? ''), 'utf8'),
  ]);
  const padded = pkcs7Pad(raw, PKCS7_BLOCK_SIZE);
  const cipher = createCipheriv('aes-256-cbc', key, iv);
  cipher.setAutoPadding(false);
  const encrypted = Buffer.concat([cipher.update(padded), cipher.final()]);
  const encrypt = encrypted.toString('base64');
  const signature = computeSignature({
    token: params.token,
    timestamp: params.timestamp,
    nonce: params.nonce,
    encrypt,
  });
  return { encrypt, signature };
}

/**
 * Decrypt a ws-mode media file with the per-URL `aeskey` returned in the
 * callback (`image.aeskey` / `file.aeskey` / `video.aeskey`).
 * @param {Buffer} encrypted
 * @param {string} aesKey Base64 key from the callback message
 * @returns {Buffer}
 */
export function decryptWecomMedia(encrypted, aesKey) {
  if (!Buffer.isBuffer(encrypted) || encrypted.length === 0) {
    throw new Error('decryptWecomMedia: encrypted buffer is empty');
  }
  const key = decodeEncodingAESKey(aesKey);
  const iv = key.subarray(0, 16);
  const decipher = createDecipheriv('aes-256-cbc', key, iv);
  decipher.setAutoPadding(false);
  const padded = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return pkcs7Unpad(padded, PKCS7_BLOCK_SIZE);
}
