/**
 * Inbound access control. Adapters translate platform data; the core alone
 * decides whether a human may reach the agent.
 *
 * DM policy: open | allowlist | pairing.
 * Group policy: disabled by default; when enabled, group id allowlist plus an
 * optional mention requirement.
 */
import { resolveAccess } from './config.js';

/**
 * @typedef {Object} AccessDecision
 * @property {boolean} allowed
 * @property {string} [reason]
 * @property {boolean} [pairingRequired]
 */

/**
 * @param {{
 *   config: Record<string, any>,
 *   message: import('./types.js').InboundMessage,
 *   pairing: ReturnType<typeof import('./pairing.js').createPairingStore>,
 * }} input
 * @returns {AccessDecision}
 */
export function decideAccess(input) {
  const { config, message, pairing } = input;
  const channelId = message.channel;
  const access = resolveAccess(config, channelId);
  const senderId = String(message.sender?.id ?? '');
  const listed = (list, value) => list.includes('*') || list.includes(value);

  if (message.conversationType === 'group') {
    if (!access.groups.enabled) return { allowed: false, reason: '群聊未启用（gateway.access.groups.enabled=false）' };
    if (access.groups.allowFrom.length > 0 && !listed(access.groups.allowFrom, String(message.conversationId))) {
      return { allowed: false, reason: '该群不在 allowFrom 中' };
    }
    if (access.groups.requireMention && message.mentioned !== true) {
      return { allowed: false, reason: '群内需要 @ 机器人' };
    }
    return { allowed: true };
  }

  if (access.dmPolicy === 'open') return { allowed: true };
  if (listed(access.allowFrom, senderId) || pairing.isApproved(channelId, senderId)) return { allowed: true };
  const reason = access.dmPolicy === 'pairing' ? '未配对' : '发送者不在 allowFrom 中';
  return access.dmPolicy === 'pairing'
    ? { allowed: false, reason, pairingRequired: true }
    : { allowed: false, reason };
}
