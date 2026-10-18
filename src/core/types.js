/**
 * Shared JSDoc typedefs for dsh-im-manager. Keep in sync with docs/contracts.md.
 *
 * This module has no runtime exports; it exists so editors can resolve types
 * from `import('./types.js')` in JSDoc annotations.
 */

/**
 * @typedef {Object} Logger
 * @property {(...args: unknown[]) => void} debug
 * @property {(...args: unknown[]) => void} info
 * @property {(...args: unknown[]) => void} warn
 * @property {(...args: unknown[]) => void} error
 * @property {(scope: string) => Logger} child
 */

/**
 * @typedef {Object} Attachment
 * @property {'image'|'file'|'audio'|'video'} kind
 * @property {string} [url]
 * @property {string} [path]
 * @property {string} [mimeType]
 * @property {string} [name]
 * @property {number} [size]
 * @property {string} [mediaId]
 */

/**
 * @typedef {Object} ReplyTarget
 * @property {string} channel
 * @property {string} accountId
 * @property {string} conversationId
 * @property {'dm'|'group'} conversationType
 * @property {string} [threadId]
 * @property {string} [replyToMessageId]
 * @property {unknown} [raw]
 */

/**
 * @typedef {Object} InboundMessage
 * @property {string} channel
 * @property {string} accountId
 * @property {string} conversationId
 * @property {'dm'|'group'} conversationType
 * @property {string} messageId
 * @property {{ id: string, name?: string }} sender
 * @property {string} text
 * @property {boolean} mentioned
 * @property {Attachment[]} attachments
 * @property {ReplyTarget} target
 * @property {number} timestamp
 * @property {unknown} [raw]
 */

/**
 * @typedef {Object} OutboundMessage
 * @property {string} text
 * @property {'plain'|'markdown'} [format]
 * @property {Attachment[]} [attachments]
 */

/**
 * @typedef {Object} SendResult
 * @property {string} [messageId]
 */

/**
 * @typedef {Object} ChannelHealth
 * @property {'connected'|'connecting'|'degraded'|'disconnected'} state
 * @property {string} [detail]
 * @property {number} [since]
 */

/**
 * @typedef {Object} AdapterCapabilities
 * @property {boolean} text
 * @property {boolean} markdown
 * @property {boolean} media
 * @property {boolean} streaming
 * @property {boolean} typing
 * @property {boolean} threads
 */

/**
 * @typedef {Object} HttpRouteRequest
 * @property {import('node:http').IncomingMessage} req
 * @property {import('node:http').ServerResponse} res
 * @property {Buffer} body
 */

/**
 * @typedef {Object} HttpRegistry
 * @property {(method: string, path: string, handler: (request: HttpRouteRequest) => Promise<void> | void) => void} route
 * @property {() => string | null} publicBaseUrl
 * @property {(path: string) => string | null} publicUrl
 */

/**
 * @typedef {Object} AdapterContext
 * @property {Record<string, unknown>} config
 * @property {(inbound: InboundMessage) => Promise<void>} emit
 * @property {Logger} log
 * @property {AbortSignal} signal
 * @property {HttpRegistry} http
 * @property {string} stateDir
 * @property {(name: string) => string | undefined} secret
 */

/**
 * @typedef {Object} Adapter
 * @property {string} id
 * @property {AdapterCapabilities} capabilities
 * @property {(ctx: AdapterContext) => Promise<void>} start
 * @property {() => Promise<void>} stop
 * @property {(target: ReplyTarget, message: OutboundMessage) => Promise<SendResult>} send
 * @property {(target: ReplyTarget) => Promise<void>} [startTyping]
 * @property {(target: ReplyTarget) => Promise<void>} [stopTyping]
 * @property {() => Promise<ChannelHealth>} [health]
 */

/**
 * @typedef {Object} BridgeEvent
 * @property {string} sessionId
 * @property {SessionEvent} event
 */

/**
 * @typedef {Object} SessionEvent
 * @property {string} type
 * @property {number} seq
 * @property {number} time
 * @property {Record<string, any>} data
 */

/**
 * @typedef {Object} DshBridge
 * @property {() => Promise<void>} start
 * @property {() => Promise<void>} stop
 * @property {(sessionId: string) => Promise<void>} ensureSession
 * @property {(sessionId: string, blocks: ContentBlock[]) => Promise<{ messageId: string }>} prompt
 * @property {(sessionId: string) => Promise<{}>} wait
 * @property {(fn: (event: BridgeEvent) => void) => () => void} onEvent
 * @property {(fn: (status: { sessionId: string, status: string }) => void) => () => void} onStatus
 * @property {(fn: (state: { state: string, detail?: string }) => void) => () => void} onState
 * @property {() => string} get state
 * @property {() => number | undefined} get pid
 */

/**
 * @typedef {{ type: 'text', text: string } | { type: 'image', data: string, mimeType: string }} ContentBlock
 */

/** Stable conversation key used for session mapping. */
export const CONVERSATION_KEY_SEPARATOR = ':';

/**
 * Build the stable conversation key for session mapping.
 * @param {InboundMessage} message
 * @returns {string}
 */
export function conversationKey(message) {
  const tail = message.target.threadId ? `${message.conversationId}:${message.target.threadId}` : message.conversationId;
  return [message.channel, message.accountId, message.conversationType, tail].join(CONVERSATION_KEY_SEPARATOR);
}
