/** Chat command parsing and help text. */

const COMMANDS = new Set(['help', 'new', 'status', 'id', 'stop', 'sessions']);

/**
 * @param {string} text
 * @returns {{ name: string, args: string, raw: string } | null}
 */
export function parseCommand(text) {
  const match = /^\/([A-Za-z][A-Za-z0-9_-]*)(?:\s+([\s\S]*))?$/.exec(String(text ?? '').trim());
  if (match === null) return null;
  return { name: match[1].toLowerCase(), args: (match[2] ?? '').trim(), raw: match[0] };
}

/** @param {string} name */
export function isKnownCommand(name) {
  return COMMANDS.has(name);
}

/** Chinese help text, intentionally short for IM bubbles. */
export function helpText() {
  return [
    '可用命令：',
    '/new     开启新会话（旧会话保留）',
    '/status  查看会话与网关状态',
    '/sessions 列出本工作区的 IM 会话映射',
    '/id      查看本会话/发送者 ID（配置 allowFrom 用）',
    '/help    显示本帮助',
    '',
    '直接发消息即可与 Agent 对话。群聊需要 @我，且群必须在 allowFrom 中。',
  ].join('\n');
}
