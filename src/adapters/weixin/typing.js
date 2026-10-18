/**
 * Best-effort typing indicator.
 *
 * Protocol:
 *   1. `POST /ilink/bot/getconfig` with the peer's `ilink_user_id` (and the
 *      conversation `context_token` when known) → `{ typing_ticket }`
 *   2. `POST /ilink/bot/sendtyping` with `{ ilink_user_id, typing_ticket,
 *      status }` where `status` is 1 (typing) or 2 (cancel)
 *
 * Tickets are cached per peer for 10 minutes. Every failure is swallowed: a
 * broken typing indicator must never fail or delay an agent turn.
 *
 * @see docs/channels/weixin.md
 */
import { TYPING_STATUS_CANCEL, TYPING_STATUS_TYPING, redactSecrets } from './protocol.js';

/** How long a `typing_ticket` is reused. */
export const TYPING_TICKET_TTL_MS = 10 * 60_000;

/**
 * @param {{
 *   client: import('./client.js').ILinkClient,
 *   enabled?: boolean,
 *   ttlMs?: number,
 *   now?: () => number,
 *   log?: { debug?: (...args: unknown[]) => void },
 * }} options
 */
export function createTypingController(options) {
  const client = options.client;
  const enabled = options.enabled !== false;
  const ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs > 0 ? Math.floor(options.ttlMs) : TYPING_TICKET_TTL_MS;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const log = options.log ?? {};
  /** @type {Map<string, { ticket: string, expiresAt: number }>} */
  const tickets = new Map();
  let active = false;

  /**
   * Resolve (and cache) a typing ticket. Returns `undefined` when the server
   * has none or the request fails; callers then send typing without a ticket
   * (the upstream client also tolerates a missing ticket).
   *
   * @param {string} peerId
   * @param {string} [contextToken]
   * @returns {Promise<string | undefined>}
   */
  async function getTicket(peerId, contextToken) {
    const peer = String(peerId ?? '');
    if (peer === '') return undefined;
    const cached = tickets.get(peer);
    if (cached !== undefined && cached.expiresAt > now()) return cached.ticket;
    tickets.delete(peer);
    try {
      const response = await client.getConfig({ ilinkUserId: peer, contextToken });
      const ticket = typeof response?.typing_ticket === 'string' && response.typing_ticket !== ''
        ? response.typing_ticket
        : undefined;
      if (ticket !== undefined) {
        tickets.set(peer, { ticket, expiresAt: now() + ttlMs });
      }
      return ticket;
    } catch (error) {
      log.debug?.('weixin typing ticket unavailable (ignored)', {
        error: redactSecrets(error instanceof Error ? error.message : String(error)),
      });
      return undefined;
    }
  }

  /**
   * Send a typing status. Always resolves; returns `true` when the request
   * succeeded. Never throws.
   * @param {string} peerId
   * @param {number} status
   * @param {string} [contextToken]
   * @returns {Promise<boolean>}
   */
  async function sendStatus(peerId, status, contextToken) {
    if (!enabled) return false;
    const peer = String(peerId ?? '');
    if (peer === '') return false;
    try {
      const ticket = await getTicket(peer, contextToken);
      await client.sendTyping({ ilinkUserId: peer, typingTicket: ticket, status });
      return true;
    } catch (error) {
      log.debug?.('weixin typing update failed (ignored)', {
        error: redactSecrets(error instanceof Error ? error.message : String(error)),
      });
      return false;
    }
  }

  return {
    /**
     * Show "typing" for a peer.
     * @param {string} peerId
     * @param {string} [contextToken]
     * @returns {Promise<boolean>}
     */
    async start(peerId, contextToken) {
      if (!enabled) return false;
      active = true;
      const ok = await sendStatus(peerId, TYPING_STATUS_TYPING, contextToken);
      if (!ok) active = false;
      return ok;
    },
    /**
     * Cancel the typing indicator for a peer.
     * @param {string} peerId
     * @param {string} [contextToken]
     * @returns {Promise<boolean>}
     */
    async stop(peerId, contextToken) {
      if (!enabled) return false;
      active = false;
      return sendStatus(peerId, TYPING_STATUS_CANCEL, contextToken);
    },
    /** Resolve a ticket (exposed for tests). */
    getTicket,
    /** Drop cached tickets (called when credentials change). */
    clear() {
      tickets.clear();
      active = false;
    },
    get active() {
      return active;
    },
    get enabled() {
      return enabled;
    },
  };
}
