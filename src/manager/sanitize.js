/**
 * Error/log sanitization shared by the manager, the channel-connect flows and
 * the HTTP API. Kept in its own module so `channel-connect.js` can reuse it
 * without importing `manager.js` (which imports channel-connect).
 */

const SECRET_KEY_RE = /^(authorization|token|access_token|accesstoken|appsecret|app_secret|secret|encodingaeskey|encoding_aes_key|clientsecret|client_secret|password|apikey|api_key|encryptkey|encrypt_key|verificationtoken|verification_token|signaturesecret|signature_secret)$/i;

/**
 * Redact credential-looking substrings from free text (messages, URLs, error
 * strings). Structural redaction (object keys) happens in the manager logger.
 * @param {unknown} value
 */
export function redactText(value) {
  return String(value)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer ***')
    .replace(/([?&](?:token|access_token|secret|key|password|code|signature|ticket)=)[^&\s]+/gi, '$1***')
    .replace(
      /\b(appsecret|app_secret|clientsecret|client_secret|secret|token|password|apikey|api_key|encodingaeskey|encryptkey|verificationtoken)\s*([:=])\s*[^\s,;]+/gi,
      (_match, key, separator) => `${key}${separator}***`,
    );
}

/** @param {string} text @param {number} max */
export function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** @param {unknown} value */
export function oneLine(value) {
  return String(value).replace(/\s+/g, ' ').trim();
}

/**
 * Turn an error into a short, secret-free message for state/API responses.
 * @param {unknown} error
 */
export function sanitizeErrorMessage(error) {
  /** @type {unknown} */
  let message = error;
  if (error !== null && typeof error === 'object') {
    const record = /** @type {Record<string, unknown>} */ (error);
    message = typeof record.message === 'string' && record.message.length > 0
      ? record.message
      : (typeof record.code === 'string' && record.code.length > 0 ? record.code : String(error));
  }
  return truncate(oneLine(redactText(message)), 300);
}

/** Fields that must never be copied into a public connect-flow result. */
export { SECRET_KEY_RE };
