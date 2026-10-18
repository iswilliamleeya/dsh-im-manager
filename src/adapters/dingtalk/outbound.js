/**
 * DingTalk outbound: reply through the per-message `sessionWebhook` that every
 * robot callback carries. No OpenAPI token is needed for this path; the webhook
 * URL embeds a short-lived access token and expires (typically within hours /
 * after a few uses), so responses must go out promptly.
 *
 * Must never log the sessionWebhook URL: it contains the access token.
 */
import { DEFAULT_MARKDOWN_TITLE, DEFAULT_REQUEST_TIMEOUT_MS } from './config.js';

/** @type {number} */
let fallbackMessageCounter = 0;

/**
 * @param {unknown} value
 * @returns {string}
 */
function readString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function errorMessage(value) {
  if (value instanceof Error) return value.message;
  return String(value);
}

/**
 * Derive a DingTalk markdown `title` (max 64 chars, required by the platform).
 * Uses the first non-empty line with markdown noise removed.
 *
 * @param {string} text
 * @param {string} [fallback]
 * @returns {string}
 */
export function deriveMarkdownTitle(text, fallback = DEFAULT_MARKDOWN_TITLE) {
  const firstLine = String(text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? '';
  const cleaned = firstLine
    .replace(/^[#>*\-\s]+/, '')
    .replace(/[*_`~]/g, '')
    .trim()
    .slice(0, 64);
  return cleaned.length > 0 ? cleaned : (readString(fallback) || DEFAULT_MARKDOWN_TITLE);
}

/**
 * Extract the reply webhook from `target.raw`, verifying its expiry metadata.
 *
 * @param {import('../../core/types.js').ReplyTarget} target
 * @param {{ now?: number, config?: { requestTimeoutMs?: number } }} [options]
 * @returns {string}
 */
export function resolveSessionWebhook(target, options = {}) {
  const now = typeof options.now === 'number' ? options.now : Date.now();
  const raw = target !== null && typeof target === 'object' && target.raw !== null && typeof target.raw === 'object'
    ? /** @type {Record<string, unknown>} */ (target.raw)
    : {};
  const url = readString(raw.sessionWebhook ?? raw.session_webhook ?? raw.webhook);
  if (url.length === 0) {
    const error = new Error(
      'DingTalk 回复失败：当前会话没有可用的 sessionWebhook。'
        + 'sessionWebhook 随每条用户消息下发，不能用于主动推送；请等待用户再次发消息，或改用 OpenAPI 主动发送。',
    );
    // @ts-expect-error custom error code for callers
    error.code = 'DINGTALK_WEBHOOK_MISSING';
    throw error;
  }
  const expiredAtRaw = raw.sessionWebhookExpiredTime ?? raw.session_webhook_expired_time;
  const expiredAt = typeof expiredAtRaw === 'string' ? Number(expiredAtRaw) : expiredAtRaw;
  if (typeof expiredAt === 'number' && Number.isFinite(expiredAt) && expiredAt > 0 && now >= expiredAt) {
    const error = new Error(
      `DingTalk sessionWebhook 已过期（${new Date(expiredAt).toISOString()}）。`
        + 'sessionWebhook 只在短时间内有效，请等待用户重新发消息后再回复。',
    );
    // @ts-expect-error custom error code for callers
    error.code = 'DINGTALK_WEBHOOK_EXPIRED';
    throw error;
  }
  return url;
}

/**
 * Append attachment hints to the reply text. v1 does not upload media through
 * the webhook (DingTalk sessionWebhook supports markdown/text only); remote
 * URLs are rendered as links, local-only media is called out as unsupported.
 *
 * @param {string} text
 * @param {import('../../core/types.js').Attachment[] | undefined} attachments
 * @returns {string}
 */
export function appendAttachmentLinks(text, attachments) {
  if (!Array.isArray(attachments) || attachments.length === 0) return text;
  /** @type {string[]} */
  const lines = [];
  for (const attachment of attachments) {
    if (attachment === null || typeof attachment !== 'object') continue;
    const label = readString(attachment.name) || readString(attachment.kind) || '附件';
    const url = readString(attachment.url);
    if (url.length > 0) {
      lines.push(`📎 [${label}](${url})`);
      continue;
    }
    // Local paths / platform media ids cannot be re-sent through a webhook.
    const handle = readString(attachment.path) || readString(attachment.mediaId);
    if (handle.length > 0) lines.push(`📎 ${label}（本地/平台附件，v1 暂不支持通过 sessionWebhook 发送）`);
  }
  if (lines.length === 0) return text;
  return [text, ...lines].filter((part) => part.length > 0).join('\n\n');
}

/**
 * Build the exact JSON body POSTed to the sessionWebhook.
 *
 * Quote replies are a best-effort extension: DingTalk documents
 * `referenceOpenMessageId` + `srcMsgSendOpenDingTalkId` for group markdown
 * messages sent through OpenAPI; the webhook accepts the same top-level fields
 * on current clients. It is opt-in (`channels.dingtalk.quoteReply=true`)
 * because older tenants may reject unknown fields.
 *
 * @param {{
 *   target: import('../../core/types.js').ReplyTarget,
 *   message: import('../../core/types.js').OutboundMessage,
 *   config?: { markdownTitle?: string, quoteReply?: boolean },
 * }} options
 * @returns {{ body: Record<string, unknown>, format: 'plain'|'markdown', text: string }}
 */
export function buildOutboundPayload(options) {
  const { target, message } = options;
  const config = options.config ?? {};
  const originalText = String(message?.text ?? '');
  const text = appendAttachmentLinks(originalText, message?.attachments);
  if (text.trim().length === 0) {
    throw new Error('DingTalk 回复失败：消息正文为空（空回复不应发送到平台）');
  }
  const format = message?.format === 'markdown' ? 'markdown' : 'plain';

  /** @type {Record<string, unknown>} */
  let body;
  if (format === 'markdown') {
    body = {
      msgtype: 'markdown',
      markdown: {
        title: deriveMarkdownTitle(text, config.markdownTitle || DEFAULT_MARKDOWN_TITLE),
        text,
      },
    };
    const raw = target !== null && typeof target === 'object' && target.raw !== null && typeof target.raw === 'object'
      ? /** @type {Record<string, unknown>} */ (target.raw)
      : {};
    const referenceId = readString(target?.replyToMessageId);
    const referenceSender = readString(raw.senderOpenDingTalkId ?? raw.senderStaffId);
    if (config.quoteReply === true && target?.conversationType === 'group' && referenceId.length > 0 && referenceSender.length > 0) {
      body.referenceOpenMessageId = referenceId;
      body.srcMsgSendOpenDingTalkId = referenceSender;
    }
  } else {
    body = { msgtype: 'text', text: { content: text } };
  }
  return { body, format, text };
}

/**
 * POST one outbound message to the target's sessionWebhook.
 *
 * @param {{
 *   target: import('../../core/types.js').ReplyTarget,
 *   message: import('../../core/types.js').OutboundMessage,
 *   config?: { markdownTitle?: string, quoteReply?: boolean, requestTimeoutMs?: number },
 *   fetchImpl?: typeof fetch,
 *   now?: () => number,
 * }} options
 * @returns {Promise<import('../../core/types.js').SendResult>}
 */
export async function sendViaSessionWebhook(options) {
  const config = options.config ?? {};
  const now = typeof options.now === 'function' ? options.now() : Date.now();
  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : globalThis.fetch;
  const url = resolveSessionWebhook(options.target, { now, config });
  const { body } = buildOutboundPayload({ target: options.target, message: options.message, config });

  const timeoutMs = typeof config.requestTimeoutMs === 'number' && config.requestTimeoutMs > 0
    ? config.requestTimeoutMs
    : DEFAULT_REQUEST_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  /** @type {Response} */
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`DingTalk sessionWebhook 请求超时（${timeoutMs}ms）`);
    }
    throw new Error(`DingTalk sessionWebhook 请求失败：${errorMessage(error)}`);
  } finally {
    clearTimeout(timer);
  }

  /** @type {string} */
  let rawText = '';
  try {
    rawText = await response.text();
  } catch {
    rawText = '';
  }
  /** @type {Record<string, unknown> | null} */
  let payload = null;
  if (rawText.length > 0) {
    try {
      const parsed = JSON.parse(rawText);
      if (parsed !== null && typeof parsed === 'object') payload = /** @type {Record<string, unknown>} */ (parsed);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const detail = readString(payload?.errmsg) || readString(payload?.message) || rawText.slice(0, 200);
    const hint = response.status === 400 || response.status === 401 || response.status === 403
      ? '（sessionWebhook 可能已过期或鉴权失败，请等待用户重新发消息）'
      : '';
    throw new Error(`DingTalk sessionWebhook 返回 HTTP ${response.status}${detail.length > 0 ? `：${detail}` : ''}${hint}`);
  }
  const errcode = payload?.errcode;
  if (errcode !== undefined && errcode !== null && String(errcode) !== '0') {
    const detail = readString(payload?.errmsg) || readString(payload?.message) || 'unknown error';
    throw new Error(`DingTalk sessionWebhook 返回错误 errcode=${String(errcode)}：${detail}`);
  }

  const messageId = readString(payload?.messageId)
    || readString(payload?.processQueryKey)
    || `dt_webhook_${now.toString(36)}_${(fallbackMessageCounter += 1).toString(36)}`;
  return { messageId };
}
