import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createGateway } from '../../src/core/gateway.js';
import { silentLogger } from '../../src/core/logger.js';
import {
  tempDir,
  removeDir,
  makeConfig,
  inbound,
  createFakeBridge,
  createFakeAdapter,
} from './helpers.js';

/**
 * @param {import('node:test').TestContext} t
 * @param {{ config?: (config: any) => void, bridge?: any, adapter?: any }} [options]
 */
async function setup(t, options = {}) {
  const dir = tempDir();
  const config = makeConfig(dir, options.config);
  const bridge = options.bridge ?? createFakeBridge();
  const adapter = options.adapter ?? createFakeAdapter();
  const gateway = createGateway({
    config,
    bridge,
    adapters: { feishu: adapter },
    logger: silentLogger,
  });
  await gateway.start();
  t.after(async () => {
    await gateway.stop();
    removeDir(dir);
  });
  return { dir, config, bridge, adapter, gateway };
}

/** Poll until `check()` is true. */
async function waitFor(check, timeoutMs = 2000, label = 'condition') {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('gateway core loop', () => {
  it('prompts the bridge and sends the final assistant text', async (t) => {
    const { gateway, adapter, bridge } = await setup(t, { bridge: createFakeBridge({ reply: '你好，我是 Agent。' }) });
    await gateway.handleInbound(inbound({ text: 'hi' }));
    await gateway.waitForIdle();
    await waitFor(() => adapter.sent.length === 1, 1000, 'reply');
    assert.equal(adapter.sent[0].message.text, '你好，我是 Agent。');
    assert.equal(bridge.prompts.length, 1);
    assert.deepEqual(bridge.prompts[0].blocks, [{ type: 'text', text: 'hi' }]);
    assert.equal(bridge.opened.size, 1);
    assert.equal(gateway.sessions.size, 1);
  });

  it('reuses one DSH session per conversation and resets on /new', async (t) => {
    const { gateway, adapter, bridge, config } = await setup(t);
    await gateway.handleInbound(inbound({ text: 'first', messageId: 'm1' }));
    await gateway.waitForIdle();
    await gateway.handleInbound(inbound({ text: 'second', messageId: 'm2' }));
    await gateway.waitForIdle();
    await waitFor(() => adapter.sent.length === 2, 1000, 'two replies');
    assert.equal(bridge.prompts[0].sessionId, bridge.prompts[1].sessionId);
    const before = gateway.sessions.get('feishu:feishu:dm:chat-1').sessionId;

    await gateway.handleInbound(inbound({ text: '/new', messageId: 'm3' }));
    await gateway.waitForIdle();
    await waitFor(() => adapter.sent.length === 3, 1000, 'command reply');
    const after = gateway.sessions.get('feishu:feishu:dm:chat-1').sessionId;
    assert.notEqual(before, after);
    assert.match(adapter.sent[2].message.text, /新会话/);
    assert.equal(config.gateway.access.dmPolicy, 'pairing');
  });

  it('drops duplicate platform message ids', async (t) => {
    const { gateway, adapter, bridge } = await setup(t);
    await gateway.handleInbound(inbound({ messageId: 'same' }));
    await gateway.waitForIdle();
    await gateway.handleInbound(inbound({ messageId: 'same' }));
    await gateway.waitForIdle();
    assert.equal(bridge.prompts.length, 1);
    assert.equal(adapter.sent.length, 1);
  });

  it('sends pairing instructions and admits the sender after approval', async (t) => {
    const { gateway, adapter, bridge } = await setup(t, {
      config: (config) => {
        config.gateway.access.dmPolicy = 'pairing';
        config.channels.feishu.allowFrom = [];
      },
    });
    await gateway.handleInbound(inbound({ sender: { id: 'stranger' }, messageId: 'p1' }));
    await gateway.waitForIdle();
    await waitFor(() => adapter.sent.length === 1, 1000, 'pairing reply');
    const text = adapter.sent[0].message.text;
    const match = /pair (\d{6})/.exec(text);
    assert.ok(match, `pairing code missing in: ${text}`);
    assert.equal(bridge.prompts.length, 0);

    // Replay from the same sender reuses the pending code without spamming.
    await gateway.handleInbound(inbound({ sender: { id: 'stranger' }, messageId: 'p2' }));
    await waitFor(() => gateway.pairing.listPending().length === 1, 1000, 'pending');
    assert.equal(adapter.sent.length, 1);

    const approval = gateway.pairing.approve(match[1]);
    assert.equal(approval.ok, true);
    await gateway.handleInbound(inbound({ sender: { id: 'stranger' }, messageId: 'p3' }));
    await gateway.waitForIdle();
    await waitFor(() => adapter.sent.length === 2, 1000, 'authorized reply');
    assert.equal(bridge.prompts.length, 1);
  });

  it('enforces group enablement and mention requirements', async (t) => {
    const { gateway, adapter, bridge } = await setup(t, {
      config: (config) => {
        config.gateway.access.groups = { enabled: true, requireMention: true, allowFrom: ['g1'] };
      },
    });
    const group = (overrides) => inbound({
      conversationId: 'g1',
      conversationType: 'group',
      mentioned: false,
      target: { channel: 'feishu', accountId: 'feishu', conversationId: 'g1', conversationType: 'group' },
      ...overrides,
    });
    await gateway.handleInbound(group({ messageId: 'gxm1' }));
    await gateway.waitForIdle();
    assert.equal(bridge.prompts.length, 0);
    assert.equal(adapter.sent.length, 0);

    await gateway.handleInbound(group({ messageId: 'gxm2', mentioned: true, text: '@bot hello' }));
    await gateway.waitForIdle();
    await waitFor(() => adapter.sent.length === 1, 1000, 'group reply');
    assert.equal(bridge.prompts.length, 1);
    assert.equal(bridge.prompts[0].blocks[0].text, '@bot hello');
  });

  it('materializes a DSH session on /new and lists mappings via /sessions', async (t) => {
    const { gateway, adapter, bridge } = await setup(t);
    await gateway.handleInbound(inbound({ text: '/new', messageId: 'c1' }));
    await gateway.waitForIdle();
    await waitFor(() => adapter.sent.length === 1, 1000, 'new reply');
    const sessionId = gateway.sessions.get('feishu:feishu:dm:chat-1').sessionId;
    assert.equal(bridge.materialized.has(sessionId), true, '/new must materialize the DSH session');

    await gateway.handleInbound(inbound({ text: '/sessions', messageId: 'c2' }));
    await waitFor(() => adapter.sent.length === 2, 1000, 'sessions reply');
    const reply = adapter.sent[1].message.text;
    assert.match(reply, /feishu:feishu:dm:chat-1/);
    assert.match(reply, new RegExp(sessionId.slice(0, 8)));
  });

  it('inlines downloaded images and copies files into the workspace', async (t) => {
    const workspace = (await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'gw-media-ws-'));
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    const imagePath = join(workspace, 'photo.png');
    const filePath = join(workspace, 'report.txt');
    writeFileSync(imagePath, png);
    writeFileSync(filePath, 'hello attachment');
    t.after(async () => {
      await import('node:fs').then((fs) => fs.rmSync(workspace, { recursive: true, force: true }));
    });
    const { gateway, bridge } = await setup(t, {
      config: (config) => {
        config.dsh.cwd = workspace;
      },
    });
    await gateway.handleInbound(inbound({
      text: 'look at these',
      messageId: 'm-media',
      attachments: [
        { kind: 'image', path: imagePath, mimeType: 'image/png', name: 'photo.png', size: png.length },
        { kind: 'file', path: filePath, mimeType: 'text/plain', name: 'report.txt', size: 16 },
      ],
    }));
    await gateway.waitForIdle();
    const blocks = bridge.prompts[0].blocks;
    const image = blocks.find((block) => block.type === 'image');
    assert.ok(image, 'expected an encoded image block');
    assert.equal(image.mimeType, 'image/png');
    assert.equal(Buffer.from(image.data, 'base64').equals(png), true);
    const text = blocks.find((block) => block.type === 'text')?.text ?? '';
    assert.match(text, /report\.txt/);
    assert.match(text, /本地路径：/);
    const copiedPath = /本地路径：(\S+)/.exec(text)?.[1];
    assert.ok(copiedPath && existsSync(copiedPath), 'file should be copied into the workspace');
    assert.match(readFileSync(copiedPath, 'utf8'), /hello attachment/);
    assert.ok(copiedPath.startsWith(workspace), 'copied file must live inside the workspace');
  });

  it('replies to /id and /help without prompting the agent', async (t) => {
    const { gateway, adapter, bridge } = await setup(t);
    await gateway.handleInbound(inbound({ text: '/id', messageId: 'c1' }));
    await gateway.handleInbound(inbound({ text: '/help', messageId: 'c2' }));
    await gateway.waitForIdle();
    await waitFor(() => adapter.sent.length === 2, 1000, 'command replies');
    assert.match(adapter.sent[0].message.text, /feishu:feishu:dm:chat-1/);
    assert.match(adapter.sent[0].message.text, /u1/);
    assert.match(adapter.sent[1].message.text, /\/new/);
    assert.equal(bridge.prompts.length, 0);
  });

  it('chunks long replies and drops overflow beyond maxChunks', async (t) => {
    const { gateway, adapter } = await setup(t, {
      config: (config) => {
        config.gateway.reply.chunkChars = 100;
        config.gateway.reply.maxChunks = 0;
      },
      bridge: createFakeBridge({ reply: 'a'.repeat(350) }),
    });
    await gateway.handleInbound(inbound({ text: 'long' }));
    await gateway.waitForIdle();
    await waitFor(() => adapter.sent.length === 4, 1000, 'chunks');
    assert.equal(adapter.sent.map((entry) => entry.message.text).join(''), 'a'.repeat(350));

    const second = await setup(t, {
      config: (config) => {
        config.gateway.reply.chunkChars = 100;
        config.gateway.reply.maxChunks = 2;
      },
      bridge: createFakeBridge({ reply: 'b'.repeat(350) }),
    });
    await second.gateway.handleInbound(inbound({ text: 'long' }));
    await second.gateway.waitForIdle();
    await waitFor(() => second.adapter.sent.length === 2, 1000, 'capped chunks');
    assert.match(second.adapter.sent[1].message.text, /其余 3 段已省略/);
  });

  it('shows the provider error message when showErrorDetail is enabled', async (t) => {
    const { gateway, adapter } = await setup(t, {
      config: (config) => {
        config.gateway.reply.showErrorDetail = true;
      },
      bridge: createFakeBridge({ reply: null, reason: { kind: 'error', error: { code: 'AUTH', message: 'no API key for provider route' } } }),
    });
    await gateway.handleInbound(inbound({ text: 'hi' }));
    await gateway.waitForIdle();
    await waitFor(() => adapter.sent.length === 1, 1000, 'error reply');
    assert.match(adapter.sent[0].message.text, /no API key for provider route/);
    assert.doesNotMatch(adapter.sent[0].message.text, /\[object Object\]/);
  });

  it('reports a failed turn reason', async (t) => {
    const { gateway, adapter } = await setup(t, {
      bridge: createFakeBridge({ reply: null, reason: { kind: 'error', error: { code: 'AUTH' } } }),
    });
    await gateway.handleInbound(inbound({ text: 'hi' }));
    await gateway.waitForIdle();
    await waitFor(() => adapter.sent.length === 1, 1000, 'error reply');
    assert.match(adapter.sent[0].message.text, /Agent 出错/);
  });

  it('times out a silent turn', async (t) => {
    const { gateway, adapter } = await setup(t, {
      config: (config) => {
        config.dsh.turnTimeoutMs = 60;
      },
      bridge: createFakeBridge({ emitEvents: false }),
    });
    await gateway.handleInbound(inbound({ text: 'stuck' }));
    await gateway.waitForIdle();
    await waitFor(() => adapter.sent.length === 1, 1000, 'timeout reply');
    assert.match(adapter.sent[0].message.text, /超时/);
  });

  it('fails in-flight turns when the bridge leaves ready', async (t) => {
    const { gateway, adapter, bridge } = await setup(t, { bridge: createFakeBridge({ emitEvents: false }) });
    await gateway.handleInbound(inbound({ text: 'hi' }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    bridge.setState('restarting');
    await gateway.waitForIdle();
    await waitFor(() => adapter.sent.length === 1, 1000, 'bridge error reply');
    assert.match(adapter.sent[0].message.text, /无法驱动/);
  });

  it('retries a failed markdown send as plain text', async (t) => {
    const { gateway, adapter } = await setup(t, {
      adapter: createFakeAdapter({ failFirstSend: true }),
      bridge: createFakeBridge({ reply: '**bold** reply' }),
    });
    await gateway.handleInbound(inbound({ text: 'hi' }));
    await gateway.waitForIdle();
    await waitFor(() => adapter.sent.length === 1, 1000, 'retried reply');
    assert.equal(adapter.sent[0].message.format, 'plain');
  });

  it('drives typing indicators around the turn', async (t) => {
    const { gateway, adapter } = await setup(t);
    await gateway.handleInbound(inbound({ text: 'hi' }));
    await gateway.waitForIdle();
    assert.deepEqual(adapter.typing.map((entry) => entry.type), ['start', 'stop']);
  });

  it('isolates a channel that fails to start', async (t) => {
    const adapter = createFakeAdapter({ startError: new Error('bad credentials') });
    const { gateway } = await setup(t, { adapter });
    const snapshot = await gateway.status();
    assert.equal(snapshot.channels.feishu.state, 'disconnected');
    assert.equal(gateway.adapterMap.size, 0);
    await gateway.handleInbound(inbound({ text: 'hi' }));
    await gateway.waitForIdle();
    assert.equal(adapter.sent.length, 0);
  });

  it('exposes attachments as text notes for the agent', async (t) => {
    const { gateway, bridge } = await setup(t);
    await gateway.handleInbound(inbound({
      text: 'look',
      attachments: [{ kind: 'image', url: 'https://example.com/a.png', name: 'a.png' }],
    }));
    await gateway.waitForIdle();
    assert.equal(bridge.prompts[0].blocks[0].text, 'look\n[附件 image: a.png] https://example.com/a.png');
  });
});
