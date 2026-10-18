/**
 * Outbound text sending over iLink `sendmessage`.
 *
 * The wire payload mirrors the upstream text builder:
 *
 * ```json
 * {
 *   "msg": {
 *     "from_user_id": "",
 *     "to_user_id": "<peer>",
 *     "client_id": "<uuid>",
 *     "message_type": 2,
 *     "message_state": 2,
 *     "context_token": "<inbound token>",
 *     "item_list": [{ "type": 1, "text_item": { "text": "..." } }]
 *   },
 *   "base_info": { "channel_version": "0.1.0", "bot_agent": "dsh-im-manager" }
 * }
 * ```
 *
 * Markdown is degraded to plain text (`../../core/text.js` `markdownToPlain`)
 * because `capabilities.markdown=false`; core normally already sends plain,
 * but a forced `gateway.reply.format=markdown` must not leak `**` markers.
 *
 * v1 does not send media (`capabilities.media=false`): attachments are ignored
 * by the adapter before reaching this module.
 *
 * @see docs/channels/weixin.md
 */
import { randomUUID } from 'node:crypto';

import { markdownToPlain } from '../../core/text.js';
import { MESSAGE_ITEM_TYPE_TEXT, MESSAGE_STATE_FINISH, MESSAGE_TYPE_BOT, redactSecrets } from './protocol.js';
import { WeixinError } from './client.js';

/**
 * Build the `sendmessage` request body for one text message.
 *
 * @param {{
 *   to: string,
 *   text: string,
 *   contextToken?: string,
 *   clientId?: string,
 *   fromUserId?: string,
 * }} params
 * @returns {{ msg: Record<string, any> }}
 */
export function buildSendTextPayload(params) {
  const to = String(params?.to ?? '').trim();
  if (to === '') throw new WeixinError('微信发送失败：缺少接收者 id', { code: 'WEIXIN_SEND_FAILED' });
  const text = String(params?.text ?? '');
  const msg = {
    from_user_id: typeof params?.fromUserId === 'string' ? params.fromUserId : '',
    to_user_id: to,
    client_id: typeof params?.clientId === 'string' && params.clientId !== '' ? params.clientId : randomUUID(),
    message_type: MESSAGE_TYPE_BOT,
    message_state: MESSAGE_STATE_FINISH,
    item_list: text === '' ? [] : [{ type: MESSAGE_ITEM_TYPE_TEXT, text_item: { text } }],
  };
  const contextToken = typeof params?.contextToken === 'string' ? params.contextToken.trim() : '';
  if (contextToken !== '') msg.context_token = contextToken;
  return { msg };
}

/**
 * Create the outbound sender bound to one iLink client.
 *
 * @param {{
 *   client: import('./client.js').ILinkClient,
 *   contextTokens?: { get: (peerId: string) => string | undefined },
 *   log?: { debug?: (...args: unknown[]) => void, warn?: (...args: unknown[]) => void },
 *   now?: () => number,
 *   uuid?: () => string,
 * }} options
 */
export function createOutboundSender(options) {
  const client = options.client;
  const contextTokens = options.contextTokens;
  const log = options.log ?? {};
  const uuid = typeof options.uuid === 'function' ? options.uuid : randomUUID;

  /**
   * @param {import('../../core/types.js').ReplyTarget} target
   * @param {import('../../core/types.js').OutboundMessage} message
   * @returns {Promise<import('../../core/types.js').SendResult>}
   */
  async function send(target, message) {
    const to = String(target?.conversationId ?? '').trim();
    if (to === '') {
      throw new WeixinError('微信发送失败：缺少会话 id（conversationId）', { code: 'WEIXIN_SEND_FAILED' });
    }

    let text = String(message?.text ?? '');
    if (message?.format === 'markdown') text = markdownToPlain(text);
    if (text.trim() === '') text = '';
    if (text === '') {
      throw new WeixinError('微信发送失败：消息正文为空', { code: 'WEIXIN_SEND_FAILED' });
    }

    const contextToken = typeof contextTokens?.get === 'function' ? contextTokens.get(to) : undefined;
    const payload = buildSendTextPayload({ to, text, contextToken, clientId: uuid() });

    try {
      await client.sendMessage(payload);
    } catch (error) {
      const safe = redactSecrets(error instanceof Error ? error.message : String(error));
      // Keep typed errors (e.g. StaleTokenError) so callers/health can react,
      // but guarantee the message carries no credential material.
      if (error instanceof WeixinError) {
        if (safe === error.message) throw error;
        throw new WeixinError(safe, { code: error.code, cause: error });
      }
      throw new WeixinError(`微信消息发送失败：${safe}`, { code: 'WEIXIN_SEND_FAILED', cause: error });
    }

    log.debug?.('weixin outbound text sent', {
      to,
      chars: text.length,
      withContextToken: contextToken !== undefined,
    });
    return { messageId: payload.msg.client_id };
  }

  return { send };
}
