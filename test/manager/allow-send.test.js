import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  addWorkspace,
  createFakeGatewayFactory,
  removeDir,
  setupManager,
  silentLogger,
  tempDir,
} from './helpers.js';

/**
 * Start a manager with one running workspace that has `channel` enabled.
 * @param {import('node:test').TestContext} t
 * @param {{ channel?: string, factoryOptions?: Record<string, any> }} [options]
 */
async function setupRunning(t, options = {}) {
  const channel = options.channel ?? 'weixin';
  const setup = await setupManager(t, { factoryOptions: options.factoryOptions ?? {} });
  const entry = await addWorkspace(setup.manager, setup.dir);
  await setup.manager.saveWorkspaceConfig(entry.id, {
    channels: {
      [channel]: {
        enabled: true,
        ...(channel === 'feishu' ? { appId: 'cli_0123456789abcdef', appSecret: 'feishu-secret' } : {}),
      },
    },
  });
  await setup.manager.startWorkspace(entry.id);
  return { ...setup, entry, channel };
}

describe('manager.allowSender', () => {
  it('adds a sender to the running gateway allowlist and returns the entry', async (t) => {
    const { manager, entry, factory } = await setupRunning(t);
    const allowed = await manager.allowSender(entry.id, { channel: 'weixin', senderId: 'wxid_1' });
    assert.deepEqual(allowed, { channel: 'weixin', senderId: 'wxid_1' });
    assert.equal(factory.gateways[0].pairing.isApproved('weixin', 'wxid_1'), true);
    assert.equal(factory.gateways[0].pairing.listApproved().length, 1);
  });

  it('trims input and keeps an optional display name', async (t) => {
    const { manager, entry, factory } = await setupRunning(t);
    const allowed = await manager.allowSender(entry.id, {
      channel: '  weixin ',
      senderId: '  wxid_2  ',
      name: '  Owner  ',
    });
    assert.deepEqual(allowed, { channel: 'weixin', senderId: 'wxid_2', name: 'Owner' });
    const approved = factory.gateways[0].pairing.listApproved();
    assert.equal(approved[0].name, 'Owner');
  });

  it('is idempotent for an already allowed sender', async (t) => {
    const { manager, entry, factory } = await setupRunning(t);
    await manager.allowSender(entry.id, { channel: 'weixin', senderId: 'wxid_1' });
    await manager.allowSender(entry.id, { channel: 'weixin', senderId: 'wxid_1' });
    assert.equal(factory.gateways[0].pairing.listApproved().length, 1);
  });

  it('rejects a stopped workspace (409)', async (t) => {
    const { manager, dir } = await setupManager(t);
    const entry = await addWorkspace(manager, dir);
    await assert.rejects(manager.allowSender(entry.id, { channel: 'weixin', senderId: 'wxid_1' }), (error) => {
      assert.equal(error.code, 'WORKSPACE_NOT_RUNNING');
      assert.match(error.message, /workspace not running/);
      return true;
    });
  });

  it('rejects an unknown workspace (404) and missing fields (400)', async (t) => {
    const { manager, entry } = await setupRunning(t);
    await assert.rejects(manager.allowSender('missing', { channel: 'weixin', senderId: 'x' }), (error) => {
      assert.equal(error.code, 'WORKSPACE_NOT_FOUND');
      return true;
    });
    for (const input of [{ senderId: 'x' }, { channel: 'weixin' }, { channel: '   ', senderId: 'x' }]) {
      await assert.rejects(manager.allowSender(entry.id, input), (error) => {
        assert.equal(error.code, 'INVALID_INPUT');
        return true;
      });
    }
  });
});

describe('manager.sendMessage', () => {
  it('sends through the live channel adapter and returns the messageId', async (t) => {
    const { manager, entry, factory } = await setupRunning(t);
    const target = {
      channel: 'weixin',
      accountId: 'weixin',
      conversationId: 'wxid_1',
      conversationType: 'dm',
      replyToMessageId: 'm-1',
    };
    const result = await manager.sendMessage(entry.id, { channel: 'weixin', target, text: '你好' });
    assert.deepEqual(result, { messageId: 'fake-msg-1' });
    assert.equal(factory.gateways[0].sent.length, 1);
    assert.deepEqual(factory.gateways[0].sent[0], {
      channel: 'weixin',
      target,
      message: { text: '你好', format: 'plain' },
    });
  });

  it('forwards markdown format and custom adapter results', async (t) => {
    const factoryOptions = {
      onSend: ({ target, message }) => ({
        messageId: `custom-${message.format}-${target.conversationId}`,
      }),
    };
    const { manager, entry, factory } = await setupRunning(t, { channel: 'feishu', factoryOptions });
    const result = await manager.sendMessage(entry.id, {
      channel: 'feishu',
      target: { channel: 'feishu', accountId: 'feishu', conversationId: 'chat-1', conversationType: 'group' },
      text: '**hi**',
      format: 'markdown',
    });
    assert.deepEqual(result, { messageId: 'custom-markdown-chat-1' });
    // The fake custom result is returned without recording in `sent`.
    assert.equal(factory.gateways[0].sent.length, 0);
  });

  it('returns {} when the adapter reports no messageId', async (t) => {
    const { manager, entry } = await setupRunning(t, { factoryOptions: { onSend: () => ({}) } });
    const result = await manager.sendMessage(entry.id, {
      channel: 'weixin',
      target: { channel: 'weixin', accountId: 'weixin', conversationId: 'wxid_1', conversationType: 'dm' },
      text: 'hi',
    });
    assert.deepEqual(result, {});
  });

  it('rejects a channel whose adapter is not running (409)', async (t) => {
    const { manager, entry } = await setupRunning(t, { channel: 'weixin' });
    await assert.rejects(
      manager.sendMessage(entry.id, {
        channel: 'feishu',
        target: { channel: 'feishu', accountId: 'feishu', conversationId: 'chat-1', conversationType: 'dm' },
        text: 'hi',
      }),
      (error) => {
        assert.equal(error.code, 'CHANNEL_NOT_RUNNING');
        assert.equal(error.message, 'channel "feishu" is not running');
        return true;
      },
    );
  });

  it('rejects a stopped workspace (409) and an unknown workspace (404)', async (t) => {
    const { manager, dir, entry } = await setupRunning(t);
    await manager.stopWorkspace(entry.id);
    await assert.rejects(
      manager.sendMessage(entry.id, {
        channel: 'weixin',
        target: { channel: 'weixin', accountId: 'weixin', conversationId: 'wxid_1', conversationType: 'dm' },
        text: 'hi',
      }),
      (error) => {
        assert.equal(error.code, 'WORKSPACE_NOT_RUNNING');
        return true;
      },
    );
    assert.ok(dir);
    await assert.rejects(
      manager.sendMessage('missing', {
        channel: 'weixin',
        target: { channel: 'weixin', accountId: 'weixin', conversationId: 'wxid_1', conversationType: 'dm' },
        text: 'hi',
      }),
      (error) => {
        assert.equal(error.code, 'WORKSPACE_NOT_FOUND');
        return true;
      },
    );
  });

  it('rejects missing channel, text or target', async (t) => {
    const { manager, entry } = await setupRunning(t);
    const target = { channel: 'weixin', accountId: 'weixin', conversationId: 'wxid_1', conversationType: 'dm' };
    for (const input of [
      { target, text: 'hi' },
      { channel: 'weixin', target, text: '   ' },
      { channel: 'weixin', target },
      { channel: 'weixin', text: 'hi', target: null },
      { channel: 'weixin', text: 'hi', target: 'not-an-object' },
    ]) {
      await assert.rejects(manager.sendMessage(entry.id, input), (error) => {
        assert.equal(error.code, 'INVALID_INPUT');
        return true;
      });
    }
  });

  it('propagates adapter failures without retrying', async (t) => {
    const { manager, entry, factory } = await setupRunning(t, {
      factoryOptions: { failSend: () => true, failSendMessage: 'transport exploded' },
    });
    await assert.rejects(
      manager.sendMessage(entry.id, {
        channel: 'weixin',
        target: { channel: 'weixin', accountId: 'weixin', conversationId: 'wxid_1', conversationType: 'dm' },
        text: 'hi',
      }),
      /transport exploded/,
    );
    assert.equal(factory.gateways[0].sendAttempts, 1);
    assert.equal(factory.gateways[0].sent.length, 0);
  });
});

describe('manager allow/send via HTTP (host plugin path)', () => {
  it('allows a sender and sends a message through the real manager+API', async (t) => {
    const { createManagerApi } = await import('../../src/manager/api.js');
    const { createManager } = await import('../../src/manager/manager.js');
    const dir = tempDir('manager-allow-send');
    const factory = createFakeGatewayFactory();
    const manager = createManager({
      managerFile: join(dir, 'manager.json'),
      managerDataDir: join(dir, 'data'),
      logger: silentLogger(),
      gatewayFactory: factory,
    });
    await manager.init();
    const api = createManagerApi({ manager, logger: silentLogger() });
    const listen = await api.start({ host: '127.0.0.1', port: 0 });
    const base = `http://127.0.0.1:${listen.port}`;
    const json = async (method, path, body) => {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      return { status: response.status, json: text.length > 0 ? JSON.parse(text) : null };
    };
    t.after(async () => {
      await api.stop().catch(() => {});
      await manager.stop().catch(() => {});
      removeDir(dir);
    });

    const workspaceDir = join(dir, 'ws');
    const created = await json('POST', '/api/workspaces', {
      name: 'Host WS',
      workspaceDir,
      channels: ['weixin'],
    });
    assert.equal(created.status, 201);
    const id = created.json.id;
    // Enable the channel via the config endpoint, then start the workspace.
    assert.equal(
      (await json('PUT', `/api/workspaces/${id}/config`, { channels: { weixin: { enabled: true } } })).status,
      200,
    );
    assert.equal((await json('POST', `/api/workspaces/${id}/start`)).json.state, 'running');

    const allowed = await json('POST', `/api/workspaces/${id}/pairing/allow`, {
      channel: 'weixin',
      senderId: 'wxid_owner',
      name: 'Owner',
    });
    assert.equal(allowed.status, 200);
    assert.deepEqual(allowed.json, {
      ok: true,
      entry: { channel: 'weixin', senderId: 'wxid_owner', name: 'Owner' },
    });
    assert.equal(factory.gateways[0].pairing.isApproved('weixin', 'wxid_owner'), true);

    const message = await json('POST', `/api/workspaces/${id}/messages`, {
      channel: 'weixin',
      conversationId: 'wxid_owner',
      text: 'hello from the host plugin',
      replyToMessageId: 'msg-0',
    });
    assert.equal(message.status, 200);
    assert.deepEqual(message.json, { ok: true, messageId: 'fake-msg-1' });
    assert.equal(factory.gateways[0].sent.length, 1);
    assert.deepEqual(factory.gateways[0].sent[0].target, {
      channel: 'weixin',
      accountId: 'weixin',
      conversationId: 'wxid_owner',
      conversationType: 'dm',
      replyToMessageId: 'msg-0',
    });
    assert.equal(factory.gateways[0].sent[0].message.text, 'hello from the host plugin');

    // Unknown workspace paths keep their canonical status codes.
    assert.equal((await json('POST', '/api/workspaces/nope/pairing/allow', { channel: 'weixin', senderId: 'x' })).status, 404);
    assert.equal(
      (await json('POST', '/api/workspaces/nope/messages', { channel: 'weixin', conversationId: 'x', text: 'hi' })).status,
      404,
    );
  });
});
