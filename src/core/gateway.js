/**
 * The gateway orchestrator: adapters emit normalized inbound messages; the
 * gateway applies access control, chat commands, per-conversation serialization,
 * session mapping, DSH prompts, and reply chunking.
 *
 * Design note: this module never imports a platform SDK and never talks to the
 * DSH runtime directly — both boundaries are injected (`adapters`, `bridge`),
 * which keeps the whole loop testable without network or model access.
 */
import { createDedupe } from './dedupe.js';
import { createSessionStore } from './session-store.js';
import { createPairingStore } from './pairing.js';
import { createHttpHost } from './http-host.js';
import { createSemaphore } from './semaphore.js';
import { decideAccess } from './access.js';
import { parseCommand, helpText } from './commands.js';
import { chunkText, oneLine } from './text.js';
import { writeJsonAtomic, ensureDir } from './fs-util.js';
import { conversationKey } from './types.js';
import { resolveDshCommand } from './dsh-command.js';
import { basename, extname, join } from 'node:path';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';

const DEFAULT_EMPTY_TEXT = '（本轮没有文本输出）';

/**
 * Extract visible text from an `assistant/message` event payload.
 * @param {any} message
 * @returns {string}
 */
export function extractAssistantText(message) {
  const content = message?.content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string' && block.text.length > 0)
    .map((block) => block.text)
    .join('\n')
    .trim();
}

/**
 * @param {{
 *   config: Record<string, any>,
 *   bridge?: import('./types.js').DshBridge,
 *   adapters?: Record<string, import('./types.js').Adapter>,
 *   loadAdapter?: (id: string) => Promise<import('./types.js').Adapter>,
 *   logger?: import('./types.js').Logger,
 *   now?: () => number,
 *   uuid?: () => string,
 *   createBridge?: (options: Record<string, any>) => import('./types.js').DshBridge,
 * }} options
 */
export function createGateway(options) {
  const config = options.config;
  const logger = options.logger ?? consoleLogger();
  const now = options.now ?? Date.now;
  const stateDir = config.gateway.stateDir;
  const bridgeOption = options.bridge;
  const adapterOverrides = options.adapters ?? {};
  const loadAdapter = options.loadAdapter ?? null;
  const stateDirChannels = join(stateDir, 'channels');

  /** @type {import('./types.js').DshBridge | null} */
  let bridge = bridgeOption ?? null;
  /** @type {Map<string, import('./types.js').Adapter>} */
  const adapters = new Map(Object.entries(adapterOverrides).filter(([, adapter]) => adapter !== undefined));
  /** @type {Map<string, any>} */
  const channelErrors = new Map();
  /** @type {Map<string, { promise: Promise<void> }>} */
  const queues = new Map();
  /** @type {Set<Promise<void>>} */
  const pendingTurns = new Set();
  /** @type {Map<string, TurnWaiter>} */
  const turnWaiters = new Map();
  const semaphore = createSemaphore(config.gateway.concurrency);
  const abort = new AbortController();
  let state = 'idle';
  let startedAt = 0;
  /** @type {ReturnType<typeof setInterval> | undefined} */
  let heartbeat;

  ensureDir(stateDir);
  ensureDir(stateDirChannels);

  const workspace = {
    cwd: config.dsh.cwd,
    ...(config.dsh.home ? { dshHome: config.dsh.home } : {}),
  };
  const dedupe = createDedupe({ file: join(stateDir, 'dedupe.json'), now });
  const sessions = createSessionStore({
    file: join(stateDir, 'sessions.json'),
    now,
    uuid: options.uuid,
    workspace,
  });
  const pairing = createPairingStore({
    file: join(stateDir, 'pairing.json'),
    ttlSec: config.gateway.access.pairingTtlSec,
    now,
  });

  /** @type {ReturnType<typeof createHttpHost> | null} */
  const httpHost = config.gateway.http.enabled
    ? createHttpHost({
        host: config.gateway.http.host,
        port: config.gateway.http.port,
        log: logger.child('http'),
      })
    : null;

  /**
   * @typedef {Object} TurnWaiter
   * @property {(event: any) => void} onEvent
   * @property {(reason: { kind: string, text?: string, error?: unknown }) => void} finish
   * @property {Promise<{ kind: string, text?: string, reason?: any, error?: unknown }>} promise
   */

  /**
   * @param {string} sessionId
   * @returns {TurnWaiter}
   */
  function createTurnWaiter(sessionId) {
    let settled = false;
    /** @type {(value: any) => void} */
    let resolvePromise = () => {};
    const promise = new Promise((resolve) => {
      resolvePromise = resolve;
    });
    /** @type {number | null} */
    let turn = null;
    let lastText = '';
    const timeoutMs = config.dsh.turnTimeoutMs;
    const timer = setTimeout(() => {
      finish({ kind: 'timeout' });
    }, timeoutMs);
    timer.unref?.();

    function finish(reason) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      turnWaiters.delete(sessionId);
      resolvePromise({ ...reason, text: reason.text ?? lastText });
    }

    return {
      onEvent(event) {
        if (settled) return;
        if (event?.type === 'turn/start') {
          if (turn === null) turn = event.data?.turn;
          return;
        }
        if (event?.type === 'assistant/message') {
          const text = extractAssistantText(event.data?.message);
          if (text.length > 0 && (turn === null || event.data?.turn === turn)) lastText = text;
          return;
        }
        if (event?.type === 'turn/end') {
          if (turn !== null && event.data?.turn === turn) {
            finish({ kind: 'turn-end', reason: event.data?.reason });
          }
        }
      },
      finish,
      promise,
    };
  }

  /**
   * @param {string} sessionId
   * @param {any} event
   */
  function dispatchEvent(sessionId, event) {
    const waiter = turnWaiters.get(sessionId);
    if (waiter !== undefined) waiter.onEvent(event);
    if (logger !== undefined) {
      if (event?.type === 'turn/end') {
        logger.debug('turn ended', { sessionId, reason: event.data?.reason?.kind });
      } else if (event?.type === 'approval/asked') {
        logger.warn('agent is waiting for approval (headless gateway cannot answer)', {
          sessionId,
          id: event.data?.id,
          toolName: event.data?.toolName,
          reason: event.data?.reason,
        });
      } else if (event?.type === 'tool/call') {
        logger.debug('tool call', { sessionId, name: event.data?.name, callId: event.data?.callId });
      } else if (event?.type === 'tool/result') {
        logger.debug('tool result', { sessionId, callId: event.data?.message?.toolCallId, error: event.data?.error?.code });
      }
    }
  }

  /** Fail every in-flight turn so users see a prompt error instead of waiting for the timeout. */
  function failAllWaiters(kind, error) {
    for (const waiter of [...turnWaiters.values()]) waiter.finish({ kind, error });
  }

  /** @param {import('./types.js').InboundMessage} raw */
  function normalizeInbound(raw) {
    const channel = String(raw?.channel ?? '');
    const accountId = String(raw?.accountId ?? channel);
    const conversationId = String(raw?.conversationId ?? '');
    const messageId = String(raw?.messageId ?? '');
    const conversationType = raw?.conversationType === 'group' ? 'group' : 'dm';
    /** @type {import('./types.js').ReplyTarget} */
    const target = {
      channel,
      accountId,
      conversationId,
      conversationType,
      ...(raw?.target?.threadId ? { threadId: String(raw.target.threadId) } : {}),
      ...(raw?.target?.replyToMessageId ? { replyToMessageId: String(raw.target.replyToMessageId) } : {}),
      ...(raw?.target?.raw !== undefined ? { raw: raw.target.raw } : {}),
    };
    return /** @type {import('./types.js').InboundMessage} */ ({
      channel,
      accountId,
      conversationId,
      conversationType,
      messageId,
      sender: { id: String(raw?.sender?.id ?? ''), ...(raw?.sender?.name ? { name: String(raw.sender.name) } : {}) },
      text: String(raw?.text ?? ''),
      mentioned: raw?.mentioned === true || conversationType === 'dm',
      attachments: Array.isArray(raw?.attachments) ? raw.attachments : [],
      target,
      timestamp: Number(raw?.timestamp) || now(),
      ...(raw?.raw !== undefined ? { raw: raw.raw } : {}),
    });
  }

  /**
   * Handle one inbound message. Returns after enqueueing (normal messages) or
   * after sending an immediate reply (access/commands); it does not wait for
   * the agent turn.
   * @param {import('./types.js').InboundMessage} raw
   * @returns {Promise<void>}
   */
  async function handleInbound(raw) {
    if (state !== 'running') {
      logger.warn('inbound ignored: gateway is not running', { state });
      return;
    }
    const message = normalizeInbound(raw);
    if (message.channel.length === 0 || message.conversationId.length === 0 || message.messageId.length === 0) {
      logger.warn('inbound ignored: incomplete message', {
        channel: message.channel,
        conversationId: message.conversationId,
        messageId: message.messageId,
      });
      return;
    }
    const adapter = adapters.get(message.channel);
    if (adapter === undefined) {
      logger.warn('inbound ignored: channel adapter is not running', { channel: message.channel });
      return;
    }

    const dedupeKey = `${message.channel}:${message.accountId}:${message.messageId}`;
    if (!dedupe.checkAndAdd(dedupeKey)) {
      logger.debug('duplicate inbound dropped', { channel: message.channel, messageId: message.messageId });
      return;
    }

    const decision = decideAccess({ config, message, pairing });
    if (!decision.allowed) {
      await handleDenied(message, adapter, decision);
      return;
    }

    const command = parseCommand(message.text);
    if (command !== null) {
      await handleCommand(message, adapter, command);
      return;
    }
    if (message.text.trim().length === 0 && message.attachments.length === 0) {
      logger.debug('empty inbound dropped', { channel: message.channel, messageId: message.messageId });
      return;
    }
    enqueueMessage(message, adapter);
  }

  /**
   * @param {import('./types.js').InboundMessage} message
   * @param {import('./types.js').Adapter} adapter
   * @param {{ reason?: string, pairingRequired?: boolean }} decision
   */
  async function handleDenied(message, adapter, decision) {
    logger.info('inbound denied', {
      channel: message.channel,
      conversationType: message.conversationType,
      reason: decision.reason,
      sender: message.sender.id,
      conversationId: message.conversationId,
    });
    if (decision.pairingRequired !== true) return;
    try {
      const request = pairing.request({
        channel: message.channel,
        senderId: message.sender.id,
        name: message.sender.name,
      });
      if (!request.created) return; // already told this sender recently
      const minutes = Math.max(1, Math.round((request.expiresAt - now()) / 60000));
      const text = [
        '🔐 你还没有使用此机器人的权限。',
        '',
        '请在网关所在机器执行：',
        `  dsh-im-manager pair ${request.code}`,
        '',
        `配对码 ${minutes} 分钟内有效。`,
        `你的 ID：${message.sender.id}`,
      ].join('\n');
      await sendText(adapter, message.target, text, 'plain');
    } catch (error) {
      logger.warn('failed to send pairing instructions', { channel: message.channel, error });
    }
  }

  /**
   * Ask the SDK runtime to create/persist a session without starting a model
   * turn (`session/working-directory/get` creates an unknown session). This
   * makes `/new` materialize a real DSH session immediately instead of only
   * rotating the local conversation binding.
   * @param {string} sessionId
   */
  async function materializeSession(sessionId) {
    const activeBridge = bridge;
    if (activeBridge === null || typeof activeBridge.getWorkingDirectory !== 'function') return;
    try {
      await activeBridge.getWorkingDirectory(sessionId);
    } catch (error) {
      logger.debug('session materialize failed', { sessionId, error });
    }
  }

  /**
   * @param {import('./types.js').InboundMessage} message
   * @param {import('./types.js').Adapter} adapter
   * @param {{ name: string, args: string }} command
   */
  async function handleCommand(message, adapter, command) {
    const key = conversationKey(message);
    switch (command.name) {
      case 'help':
        await sendText(adapter, message.target, helpText(), 'plain');
        return;
      case 'id': {
        const text = [
          `渠道：${message.channel}`,
          `账号：${message.accountId}`,
          `会话：${message.conversationId}${message.target.threadId ? ` / thread ${message.target.threadId}` : ''}`,
          `类型：${message.conversationType}`,
          `发送者：${message.sender.id}`,
          `会话键：${key}`,
        ].join('\n');
        await sendText(adapter, message.target, text, 'plain');
        return;
      }
      case 'new': {
        const entry = sessions.reset(key);
        logger.info('session reset', { key, sessionId: entry.sessionId });
        await materializeSession(entry.sessionId);
        await sendText(adapter, message.target, `🆕 已开启新会话：${entry.sessionId.slice(0, 8)}…`, 'plain');
        return;
      }
      case 'sessions': {
        const rows = sessions
          .list()
          .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
          .slice(0, 8);
        const current = sessions.get(key)?.sessionId;
        const lines = rows.length === 0
          ? ['本工作区还没有 IM 会话映射。']
          : [
              `本工作区 IM 会话（${rows.length}）：`,
              ...rows.map((row) => {
                const marker = row.sessionId === current ? ' ← 当前' : '';
                const age = Math.max(0, Math.round((now() - row.lastUsedAt) / 60000));
                return `- ${row.sessionId.slice(0, 8)}… ${row.key}（${age} 分钟前）${marker}`;
              }),
              '',
              '提示：DSH Desktop 的会话列表由宿主维护，外部 SDK 进程新建的会话可能需要刷新/重开窗口才能看到。',
            ];
        await sendText(adapter, message.target, lines.join('\n'), 'plain');
        return;
      }
      case 'status': {
        const snapshot = await status();
        const channel = snapshot.channels[message.channel];
        const text = [
          `网关：${snapshot.state}`,
          `DSH：${snapshot.bridge}`,
          `渠道：${channel?.state ?? 'unknown'}${channel?.detail ? `（${channel.detail}）` : ''}`,
          `会话：${sessions.get(key)?.sessionId ?? '（未创建）'}`,
          `队列：${semaphore.active} 运行 / ${semaphore.queued} 等待`,
        ].join('\n');
        await sendText(adapter, message.target, text, 'plain');
        return;
      }
      case 'stop':
        await sendText(adapter, message.target, '当前版本不支持中止正在进行的一轮；可发送 /new 开启新会话。', 'plain');
        return;
      default:
        await sendText(adapter, message.target, `未知命令 /${command.name}\n\n${helpText()}`, 'plain');
    }
  }

  /**
   * @param {import('./types.js').InboundMessage} message
   * @param {import('./types.js').Adapter} adapter
   */
  function enqueueMessage(message, adapter) {
    const key = conversationKey(message);
    const previous = queues.get(key)?.promise ?? Promise.resolve();
    const turn = previous
      .catch(() => {})
      .then(() => runTurn(message, adapter))
      .catch((error) => {
        logger.error('turn failed unexpectedly', { key, error });
      })
      .finally(() => {
        pendingTurns.delete(turn);
        if (queues.get(key)?.promise === turn) queues.delete(key);
      });
    queues.set(key, { promise: turn });
    pendingTurns.add(turn);
  }

  /**
   * @param {import('./types.js').InboundMessage} message
   * @param {import('./types.js').Adapter} adapter
   */
  async function runTurn(message, adapter) {
    const key = conversationKey(message);
    await semaphore.acquire();
    let typing = false;
    try {
      const session = sessions.ensure(key);
      if (session.created && typeof /** @type {any} */ (bridge)?.getWorkingDirectory === 'function') {
        await materializeSession(session.sessionId);
      }
      logger.info('turn start', {
        key,
        sessionId: session.sessionId,
        created: session.created,
        chars: message.text.length,
        attachments: message.attachments.length,
      });

      if (!bridgeReady()) {
        await sendText(adapter, message.target, '⚠️ DSH runtime 尚未就绪，请稍后重试。', 'plain');
        return;
      }
      const activeBridge = /** @type {import('./types.js').DshBridge} */ (bridge);
      await activeBridge.ensureSession(session.sessionId);

      const waiter = createTurnWaiter(session.sessionId);
      turnWaiters.set(session.sessionId, waiter);
      if (config.gateway.reply.typing && typeof adapter.startTyping === 'function') {
        typing = true;
        try {
          await adapter.startTyping(message.target);
        } catch (error) {
          logger.debug('startTyping failed', { channel: message.channel, error });
        }
      }

      try {
        const blocks = await buildContentBlocks(message);
        logger.debug('prompt blocks', {
          sessionId: session.sessionId,
          blocks: blocks.map((block) => ({
            type: block.type,
            ...(block.type === 'text' ? { chars: block.text.length, preview: block.text.slice(0, 240) } : {}),
          })),
        });
        await activeBridge.prompt(session.sessionId, blocks);
      } catch (error) {
        turnWaiters.delete(session.sessionId);
        waiter.finish({ kind: 'prompt-error', error });
        logger.error('prompt failed', { key, sessionId: session.sessionId, error });
      }

      const result = await waiter.promise;
      const text = formatTurnResult(result);
      if (text.length > 0) await sendText(adapter, message.target, text);
      sessions.touch(key);
      logger.info('turn end', { key, sessionId: session.sessionId, kind: result.kind, replyChars: text.length });
    } catch (error) {
      logger.error('turn crashed', { key, error });
      try {
        await sendText(adapter, message.target, `⚠️ 处理消息失败：${error instanceof Error ? error.message : String(error)}`, 'plain');
      } catch (sendError) {
        logger.warn('failed to report turn crash', { channel: message.channel, error: sendError });
      }
    } finally {
      if (typing && typeof adapter.stopTyping === 'function') {
        try {
          await adapter.stopTyping(message.target);
        } catch {
          // Typing indicators are best-effort.
        }
      }
      semaphore.release();
    }
  }

  /**
   * Turn one inbound message into SDK prompt blocks.
   *
   * Images that the adapter downloaded/decrypted are inlined as encoded image
   * blocks (the SDK converts them to durable attachments, and vision models see
   * the pixels). Other downloaded files are copied into the workspace so the
   * agent's file tools can read them, and referenced by local path.
   *
   * @param {import('./types.js').InboundMessage} message
   */
  async function buildContentBlocks(message) {
    /** @type {import('./types.js').ContentBlock[]} */
    const blocks = [];
    let text = message.text;
    /** @type {string[]} */
    const notes = [];
    const maxInlineImageBytes = Number(config.gateway.media?.maxInlineImageBytes) || 8 * 1024 * 1024;
    const mediaDirSetting = config.gateway.media?.dir ?? '.dsh-im-manager/media';

    for (const attachment of message.attachments) {
      const name = attachment.name ?? attachment.kind;
      if (attachment.kind === 'image' && attachment.path && existsSync(attachment.path)) {
        try {
          const size = statSync(attachment.path).size;
          if (size > maxInlineImageBytes) {
            notes.push(`[附件 image: ${name}] 图片过大（${size} bytes），未内联；路径：${attachment.path}`);
            continue;
          }
          const data = readFileSync(attachment.path).toString('base64');
          const mimeType = attachment.mimeType ?? sniffImageMime(attachment.path) ?? 'image/jpeg';
          blocks.push({ type: 'image', data, mimeType });
          continue;
        } catch (error) {
          logger.warn('failed to inline inbound image', { error });
        }
      }
      if (attachment.path && existsSync(attachment.path)) {
        try {
          const targetDir = join(config.dsh.cwd, mediaDirSetting);
          mkdirSync(targetDir, { recursive: true });
          const safeName = `${Date.now()}-${sanitizeFileName(name)}`;
          const target = join(targetDir, safeName);
          copyFileSync(attachment.path, target);
          notes.push(`[附件 ${attachment.kind}: ${name}] 本地路径：${target}`);
          continue;
        } catch (error) {
          logger.warn('failed to copy inbound attachment into workspace', { error });
        }
      }
      const where = attachment.url ?? attachment.mediaId ?? '';
      notes.push(`[附件 ${attachment.kind}: ${name}]${where ? ` ${where}` : ''}`);
    }
    if (notes.length > 0) text = [text, ...notes].filter((part) => part.length > 0).join('\n');
    if (text.length > 0) blocks.push({ type: 'text', text });
    return blocks;
  }

  /**
   * Format one completed turn into user-facing text.
   * @param {{ kind: string, text?: string, reason?: any, error?: unknown }} result
   */
  function formatTurnResult(result) {
    const replyConfig = config.gateway.reply;
    if (result.kind === 'timeout') {
      return `⚠️ Agent 本轮超时（${Math.round(config.dsh.turnTimeoutMs / 1000)}s）。可以发送 /new 开启新会话。`;
    }
    if (result.kind === 'prompt-error' || result.kind === 'bridge-error' || result.kind === 'shutdown') {
      const detail = replyConfig.showErrorDetail && result.error ? `：${errorMessage(result.error)}` : '';
      return `⚠️ 无法驱动 DSH Agent${detail}`;
    }
    const reasonKind = result.reason?.kind;
    if (reasonKind === 'completed' || reasonKind === 'max-tokens') {
      const base = result.text && result.text.length > 0 ? result.text : (replyConfig.emptyText || DEFAULT_EMPTY_TEXT);
      return reasonKind === 'max-tokens' ? `${base}\n\n（输出达到 token 上限）` : base;
    }
    if (reasonKind === 'aborted' || reasonKind === 'interrupted') return '⚠️ 本轮已中止。';
    if (reasonKind === 'blocked') return '⚠️ 本轮被拦截（可能需要审批或权限）。';
    if (reasonKind === 'error') {
      const detail = replyConfig.showErrorDetail && result.reason?.error ? `：${errorMessage(result.reason.error)}` : '';
      return `⚠️ Agent 出错${detail}`;
    }
    if (reasonKind === 'forked') return '⚠️ 本轮被 fork 处理。';
    return result.text && result.text.length > 0 ? result.text : (replyConfig.emptyText || DEFAULT_EMPTY_TEXT);
  }

  /**
   * Send text to a target, chunked, with one plain-text retry per chunk.
   * @param {import('./types.js').Adapter} adapter
   * @param {import('./types.js').ReplyTarget} target
   * @param {string} text
   * @param {'plain'|'markdown'} [forcedFormat]
   */
  async function sendText(adapter, target, text, forcedFormat) {
    const chunks = chunkText(text, config.gateway.reply.chunkChars);
    if (chunks.length === 0) return;
    const maxChunks = config.gateway.reply.maxChunks;
    let toSend = chunks;
    if (maxChunks > 0 && chunks.length > maxChunks) {
      const kept = chunks.slice(0, maxChunks - 1);
      const remaining = chunks.length - kept.length;
      toSend = [...kept, `…（内容过长，其余 ${remaining} 段已省略）`];
    }
    const format = forcedFormat ?? (config.gateway.reply.format === 'auto'
      ? (adapter.capabilities?.markdown ? 'markdown' : 'plain')
      : config.gateway.reply.format);
    for (let index = 0; index < toSend.length; index += 1) {
      const chunk = toSend[index];
      try {
        await adapter.send(target, { text: chunk, format });
      } catch (error) {
        logger.warn('send failed, retrying as plain text', {
          channel: target.channel,
          conversationId: target.conversationId,
          error,
        });
        if (format === 'plain') throw error;
        await adapter.send(target, { text: chunk, format: 'plain' });
      }
    }
  }

  function bridgeReady() {
    return bridge !== null && bridge.state === 'ready';
  }

  /** @returns {Promise<Record<string, any>>} */
  async function status() {
    const channels = {};
    for (const [id, adapter] of adapters) {
      let health = { state: 'connected' };
      if (typeof adapter.health === 'function') {
        try {
          health = await adapter.health();
        } catch (error) {
          health = { state: 'degraded', detail: errorMessage(error) };
        }
      }
      channels[id] = { ...health, error: channelErrors.get(id)?.message };
    }
    for (const [id, error] of channelErrors) {
      if (channels[id] === undefined) channels[id] = { state: 'disconnected', detail: errorMessage(error) };
    }
    return {
      state,
      pid: process.pid,
      workspace,
      startedAt,
      uptimeMs: startedAt === 0 ? 0 : now() - startedAt,
      bridge: bridge?.state ?? 'absent',
      channels,
      sessions: sessions.size,
      dedupe: dedupe.size,
      queues: { active: semaphore.active, queued: semaphore.queued, conversations: queues.size },
      http: httpHost === null ? null : { port: httpHost.port, publicBaseUrl: httpHost.publicBaseUrl() },
    };
  }

  function writeGatewayState() {
    try {
      writeJsonAtomic(join(stateDir, 'gateway.json'), {
        version: 1,
        pid: process.pid,
        state,
        workspace,
        startedAt,
        updatedAt: now(),
        config: {
          stateDir,
          http: config.gateway.http,
          concurrency: config.gateway.concurrency,
        },
        channels: Object.fromEntries([...adapters.keys()].map((id) => [id, 'running'])),
      });
    } catch (error) {
      logger.warn('failed to write gateway state', { error });
    }
  }

  async function start() {
    if (state !== 'idle') throw new Error(`gateway cannot start in state ${state}`);
    startedAt = now();
    state = 'starting';
    logger.info('gateway starting', {
      stateDir,
      workspace: workspace.cwd,
      channels: Object.keys(config.channels).filter((id) => config.channels[id]?.enabled === true),
    });

    if (bridge === null) {
      const createBridge = options.createBridge ?? (await import('../bridge/dsh-sdk.js')).createDshBridge;
      bridge = createBridge({
        ...config.dsh,
        command: resolveDshCommand(config.dsh),
        env: {
          ...(config.dsh.env ?? {}),
          ...(config.dsh.home ? { DSH_HOME: config.dsh.home } : {}),
        },
        // Config-level names are stable; map them to the bridge's option names.
        initializeTimeoutMs: config.dsh.initTimeoutMs,
        restart: {
          initialDelayMs: config.dsh.restart?.minDelayMs,
          maxDelayMs: config.dsh.restart?.maxDelayMs,
        },
        log: logger.child('bridge'),
      });
    }
    bridge.onEvent(({ sessionId, event }) => dispatchEvent(sessionId, event));
    bridge.onStatus(({ sessionId, status: statusValue }) => {
      logger.debug('agent status', { sessionId, status: statusValue });
    });
    bridge.onState(({ state: bridgeState, detail }) => {
      logger.info('bridge state', { state: bridgeState, ...(detail ? { detail } : {}) });
      if (bridgeState !== 'ready' && bridgeState !== 'starting') {
        failAllWaiters('bridge-error', new Error(`bridge ${bridgeState}`));
      }
    });

    // Start the bridge before channels: a long-connection adapter can receive a
    // message the moment it connects, and the turn must not race a missing runtime.
    await bridge.start();

    if (sessions.workspaceMismatch !== null) {
      logger.warn('sessions.json belongs to a different workspace; conversation bindings were discarded', {
        stored: sessions.workspaceMismatch.stored,
        current: sessions.workspaceMismatch.current,
      });
    }

    if (httpHost !== null) {
      try {
        httpHost.route('GET', '/healthz', async ({ res }) => {
          const snapshot = await status();
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(`${JSON.stringify({ state: snapshot.state, bridge: snapshot.bridge, channels: snapshot.channels, sessions: snapshot.sessions })}\n`);
        });
        await httpHost.start();
        if (config.gateway.http.publicBaseUrl) httpHost.setPublicBaseUrl(config.gateway.http.publicBaseUrl);
      } catch (error) {
        logger.error('HTTP host failed to start; webhook channels will be unavailable', { error });
        channelErrors.set('http', error instanceof Error ? error : new Error(String(error)));
      }
    }

    state = 'running';
    for (const id of Object.keys(config.channels)) {
      const channelConfig = config.channels[id];
      if (channelConfig?.enabled !== true) continue;
      await startChannel(id, channelConfig);
    }
    writeGatewayState();
    heartbeat = setInterval(writeGatewayState, 10_000);
    heartbeat.unref?.();
    logger.info('gateway running', { channels: [...adapters.keys()], bridge: bridge.state });
  }

  /**
   * @param {string} id
   * @param {Record<string, any>} channelConfig
   */
  async function startChannel(id, channelConfig) {
    try {
      const adapter = adapters.get(id) ?? await (loadAdapter ?? defaultLoadAdapter)(id, { channelConfig });
      if (adapter === undefined) throw new Error(`no adapter registered for channel ${id}`);
      await adapter.start({
        config: channelConfig,
        emit: (inbound) => handleInbound(inbound),
        log: logger.child(id),
        signal: abort.signal,
        http: httpHost ?? unavailableHttp(),
        stateDir: ensureDir(join(stateDirChannels, id)),
        secret: (name) => process.env[name],
      });
      adapters.set(id, adapter);
      channelErrors.delete(id);
      logger.info('channel started', { channel: id, mode: channelConfig.mode });
    } catch (error) {
      adapters.delete(id);
      channelErrors.set(id, error instanceof Error ? error : new Error(String(error)));
      logger.error('channel failed to start', { channel: id, error });
    }
  }

  async function stop() {
    if (state === 'stopped') return;
    state = 'stopping';
    abort.abort();
    failAllWaiters('shutdown', new Error('gateway shutting down'));
    if (heartbeat !== undefined) clearInterval(heartbeat);
    // Let in-flight turns observe the shutdown and report through still-running
    // adapters, then stop the adapters.
    await Promise.allSettled([...pendingTurns]);
    await Promise.allSettled([...adapters.values()].map((adapter) => Promise.resolve().then(() => adapter.stop())));
    await httpHost?.stop();
    if (bridge !== null) {
      try {
        await bridge.stop();
      } catch (error) {
        logger.warn('bridge stop failed', { error });
      }
    }
    dedupe.close();
    sessions.flush();
    pairing.flush();
    state = 'stopped';
    writeGatewayState();
    logger.info('gateway stopped');
  }

  /** Wait for every queue and pending turn to settle (tests and shutdown). */
  async function waitForIdle() {
    while (pendingTurns.size > 0) {
      await Promise.allSettled([...pendingTurns]);
    }
  }

  return {
    config,
    logger,
    adapters,
    bridge: () => bridge,
    sessions,
    pairing,
    dedupe,
    httpHost,
    handleInbound,
    start,
    stop,
    status,
    waitForIdle,
    get state() {
      return state;
    },
    get adapterMap() {
      return adapters;
    },
  };
}

/** @param {string} file @returns {string | null} */
function sniffImageMime(file) {
  try {
    const head = readFileSync(file).subarray(0, 12);
    if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
    if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
    if (head.subarray(0, 4).toString('ascii') === 'RIFF' && head.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
    if (head.subarray(0, 6).toString('ascii') === 'GIF87a' || head.subarray(0, 6).toString('ascii') === 'GIF89a') return 'image/gif';
    return null;
  } catch {
    return null;
  }
}

/** @param {string} name */
function sanitizeFileName(name) {
  const base = basename(String(name ?? 'attachment')).replace(/[^A-Za-z0-9._-]+/g, '_');
  const clean = base.length > 0 ? base : 'attachment';
  return clean.length > 120 ? `${clean.slice(0, 80)}${extname(clean)}` : clean;
}

/** @param {unknown} error */
function errorMessage(error) {
  if (error instanceof Error) return oneLine(error.message, 160);
  if (error !== null && typeof error === 'object') {
    const record = /** @type {Record<string, unknown>} */ (error);
    if (typeof record.message === 'string' && record.message.length > 0) return oneLine(record.message, 160);
    if (typeof record.code === 'string' && record.code.length > 0) return oneLine(record.code, 160);
    try {
      return oneLine(JSON.stringify(error), 160);
    } catch {
      return '(unknown error)';
    }
  }
  return oneLine(String(error), 160);
}

function consoleLogger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
    child() {
      return this;
    },
  };
}

function unavailableHttp() {
  const fail = () => {
    throw new Error('HTTP host is disabled (gateway.http.enabled=false)');
  };
  return { route: fail, publicBaseUrl: () => null, publicUrl: () => null };
}

/**
 * Load a channel adapter lazily from the built-in registry.
 * @param {string} id
 * @returns {Promise<import('./types.js').Adapter>}
 */
async function defaultLoadAdapter(id) {
  const module = await import('../adapters/registry.js');
  return module.loadAdapter(id);
}
