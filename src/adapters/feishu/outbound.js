/**
 * Feishu / Lark outbound message delivery.
 *
 * Format policy (v1):
 *   - `plain`      -> msg_type=text, content={"text": "..."} (exactly what the
 *                    user typed, no markdown rendering);
 *   - `markdown`   -> msg_type=interactive card with a single `lark_md` div.
 *     Feishu's plain `text` messages do not render markdown, and its richer
 *     `post` format requires a strict per-node JSON structure. The interactive
 *     card is the smallest reliable markdown carrier. lark_md supports bold,
 *     strikethrough, links, `@mention` and line breaks, but NOT headings or
 *     fenced code blocks — those degrade to literal text in the card.
 *   - On any card/send error the adapter retries the same text as a plain
 *     `text` message (raw markdown characters are shown as-is). That retry is
 *     intentional, in addition to core's plain-text retry: a rejected card
 *     must not lose the agent reply.
 *
 * Delivery policy:
 *   - `target.replyToMessageId` set -> im/v1/messages/:message_id/reply (keeps
 *     the conversation threaded and notifies the sender);
 *   - otherwise (or if reply fails) -> im/v1/messages create to
 *     `target.conversationId` (a chat_id, as produced by the inbound mapping).
 *
 * Auth: the Lark SDK `Client` obtains and caches tenant_access_token itself and
 * attaches `Authorization: Bearer <tenant_access_token>`; the adapter never
 * handles or logs the token.
 */

/**
 * @param {string} text
 * @returns {{ msg_type: 'text', content: string }}
 */
export function buildTextPayload(text) {
  return { msg_type: 'text', content: JSON.stringify({ text }) };
}

/**
 * @param {string} text
 * @returns {Record<string, unknown>}
 */
export function buildMarkdownCard(text) {
  return {
    config: { wide_screen_mode: true },
    elements: [{ tag: 'div', text: { tag: 'lark_md', content: text } }],
  };
}

/**
 * @param {string} text
 * @returns {{ msg_type: 'interactive', content: string }}
 */
export function buildMarkdownPayload(text) {
  return { msg_type: 'interactive', content: JSON.stringify(buildMarkdownCard(text)) };
}

/**
 * @param {import('../../core/types.js').OutboundMessage} message
 * @param {Record<string, any>} config
 * @returns {Array<{ kind: 'markdown-card' | 'markdown-text' | 'text', payload: { msg_type: string, content: string } }>}
 */
export function buildAttempts(message, config) {
  const text = typeof message?.text === 'string' ? message.text : '';
  const markdown = message?.format === 'markdown';
  /** @type {Array<{ kind: 'markdown-card' | 'markdown-text' | 'text', payload: { msg_type: string, content: string } }>} */
  const attempts = [];
  if (markdown && config.markdownAsCard === true) {
    attempts.push({ kind: 'markdown-card', payload: buildMarkdownPayload(text) });
  }
  attempts.push({
    kind: markdown ? 'markdown-text' : 'text',
    payload: buildTextPayload(text),
  });
  return attempts;
}

/** Network calls must not hang a conversation forever. */
const SEND_TIMEOUT_MS = 30_000;

/**
 * @template T
 * @param {Promise<T>} promise
 * @param {number} timeoutMs
 * @param {string} label
 * @returns {Promise<T>}
 */
async function withTimeout(promise, timeoutMs, label) {
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`feishu: ${label} timed out after ${timeoutMs}ms`)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * @param {unknown} response  Lark SDK response body ({ code, msg, data })
 * @returns {{ messageId?: string }}
 */
function unwrapResponse(response) {
  const body = /** @type {Record<string, any> | undefined} */ (
    response !== null && typeof response === 'object' ? response : undefined
  );
  if (body === undefined) return {};
  if (typeof body.code === 'number' && body.code !== 0) {
    throw new Error(`feishu API error code=${body.code}${typeof body.msg === 'string' && body.msg.length > 0 ? ` msg=${body.msg}` : ''}`);
  }
  const messageId = body.data?.message_id;
  return typeof messageId === 'string' && messageId.length > 0 ? { messageId } : {};
}

/**
 * @param {any} client
 * @param {import('../../core/types.js').ReplyTarget} target
 * @param {{ msg_type: string, content: string }} payload
 * @param {Record<string, any>} config
 * @returns {Promise<{ messageId?: string }>}
 */
async function sendViaReply(client, target, payload, config) {
  const data = { msg_type: payload.msg_type, content: payload.content };
  if (config.replyInThread === true && typeof target.threadId === 'string' && target.threadId.length > 0) {
    data.reply_in_thread = true;
  }
  const response = await withTimeout(
    client.im.v1.message.reply({
      path: { message_id: target.replyToMessageId },
      data,
    }),
    SEND_TIMEOUT_MS,
    'reply',
  );
  return unwrapResponse(response);
}

/**
 * @param {any} client
 * @param {import('../../core/types.js').ReplyTarget} target
 * @param {{ msg_type: string, content: string }} payload
 * @returns {Promise<{ messageId?: string }>}
 */
async function sendViaCreate(client, target, payload) {
  const response = await withTimeout(
    client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: target.conversationId,
        msg_type: payload.msg_type,
        content: payload.content,
      },
    }),
    SEND_TIMEOUT_MS,
    'create',
  );
  return unwrapResponse(response);
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Send one outbound message, degrading markdown -> plain text and
 * reply -> create as needed.
 *
 * @param {{
 *   client: any,
 *   config: Record<string, any>,
 *   target: import('../../core/types.js').ReplyTarget,
 *   message: import('../../core/types.js').OutboundMessage,
 *   log?: import('../../core/types.js').Logger,
 * }} options
 * @returns {Promise<import('../../core/types.js').SendResult>}
 */
export async function sendOutbound({ client, config, target, message, log }) {
  if (client === null || client === undefined) {
    throw new Error('feishu: adapter is not started (no Lark client)');
  }
  if (target === null || typeof target !== 'object') {
    throw new TypeError('feishu: send() requires a ReplyTarget');
  }
  if (message === null || typeof message !== 'object') {
    throw new TypeError('feishu: send() requires an OutboundMessage');
  }
  if (Array.isArray(message.attachments) && message.attachments.length > 0) {
    throw new Error(
      'feishu: outbound attachments are not supported by this adapter (capabilities.media=false)',
    );
  }

  const text = typeof message.text === 'string' ? message.text : '';
  if (text.trim().length === 0) {
    throw new Error('feishu: refusing to send an empty message');
  }

  const replyTo = typeof target.replyToMessageId === 'string' ? target.replyToMessageId : '';
  const conversationId = typeof target.conversationId === 'string' ? target.conversationId : '';
  const transports = [];
  if (replyTo.length > 0) transports.push('reply');
  if (conversationId.length > 0) transports.push('create');
  if (transports.length === 0) {
    throw new Error('feishu: send() target has neither replyToMessageId nor conversationId');
  }

  const attempts = buildAttempts(message, config);
  let lastError;

  for (const attempt of attempts) {
    for (const transport of transports) {
      try {
        const result = transport === 'reply'
          ? await sendViaReply(client, target, attempt.payload, config)
          : await sendViaCreate(client, target, attempt.payload);
        log?.debug?.('feishu outbound sent', {
          transport,
          kind: attempt.kind,
          conversationType: target.conversationType,
        });
        return result;
      } catch (error) {
        lastError = error;
        log?.debug?.('feishu outbound attempt failed', {
          transport,
          kind: attempt.kind,
          error: errorMessage(error),
        });
      }
    }
  }

  if (attempts.length > 1) {
    log?.warn?.('feishu outbound degraded to plain text and still failed', {
      error: errorMessage(lastError),
    });
  }
  throw new Error(`feishu: failed to send message: ${errorMessage(lastError)}`, { cause: lastError });
}
