import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { createManagerApi } from '../../src/manager/api.js';
import {
  createFakeManager,
  createFakeGatewayFactory,
  removeDir,
  request,
  setupApi,
  silentLogger,
  tempDir,
} from './helpers.js';

const MASKED = {
  dsh: { cwd: '/tmp/ws-1' },
  channels: { feishu: { enabled: true, appId: 'cli_0123456789abcdef', appSecret: '***' } },
};

describe('api: health and state', () => {
  it('GET /api/health returns ok without touching the manager', async (t) => {
    const { base, manager } = await setupApi(t);
    const response = await request(base, 'GET', '/api/health');
    assert.equal(response.status, 200);
    assert.deepEqual(response.json, { ok: true });
    assert.equal(manager.calls.length, 0);
  });

  it('GET /api/state refreshes and returns aggregated state', async (t) => {
    const { base, manager } = await setupApi(t);
    const response = await request(base, 'GET', '/api/state');
    assert.equal(response.status, 200);
    assert.equal(response.json.workspaces.length, 1);
    assert.deepEqual(manager.calls.map((call) => call[0]), ['refresh', 'getState']);
    assert.match(response.headers.get('content-type') ?? '', /application\/json/);
  });

  it('GET /api/state returns JSON errors when refresh fails', async (t) => {
    const manager = createFakeManager({ failures: { refresh: new Error('state exploded') } });
    const { base } = await setupApi(t, { manager });
    const response = await request(base, 'GET', '/api/state');
    assert.equal(response.status, 500);
    assert.equal(response.json.error.message, 'state exploded');
  });
});

describe('api: workspace CRUD and lifecycle', () => {
  it('POST /api/workspaces creates a workspace (201)', async (t) => {
    const { base, manager } = await setupApi(t);
    const response = await request(base, 'POST', '/api/workspaces', {
      name: 'New WS',
      workspaceDir: '/tmp/new-ws',
      channels: ['feishu'],
      autoStart: true,
    });
    assert.equal(response.status, 201);
    assert.equal(response.json.id, 'ws-new');
    const call = manager.calls.find((entry) => entry[0] === 'addWorkspace');
    assert.deepEqual(call[1], {
      name: 'New WS',
      workspaceDir: '/tmp/new-ws',
      channels: ['feishu'],
      autoStart: true,
    });
  });

  it('POST /api/workspaces maps validation errors to 400', async (t) => {
    const error = new Error('workspace name is required');
    error.code = 'INVALID_INPUT';
    const manager = createFakeManager({ failures: { addWorkspace: error } });
    const { base } = await setupApi(t, { manager });
    const response = await request(base, 'POST', '/api/workspaces', { workspaceDir: '/x' });
    assert.equal(response.status, 400);
    assert.equal(response.json.error.message, 'workspace name is required');
  });

  it('POST /api/workspaces rejects an invalid JSON body', async (t) => {
    const { base } = await setupApi(t);
    const response = await request(base, 'POST', '/api/workspaces', '{oops');
    assert.equal(response.status, 400);
    assert.match(response.json.error.message, /invalid JSON body/);
  });

  it('POST /api/workspaces rejects bodies over 2 MiB with 413', async (t) => {
    const { base } = await setupApi(t);
    const huge = `{"name":"${'x'.repeat(2 * 1024 * 1024 + 16)}"}`;
    const response = await request(base, 'POST', '/api/workspaces', huge);
    assert.equal(response.status, 413);
    assert.match(response.json.error.message, /too large/);
  });

  it('PATCH /api/workspaces/:id updates name and autoStart', async (t) => {
    const { base, manager } = await setupApi(t);
    const response = await request(base, 'PATCH', '/api/workspaces/ws-1', { name: 'Renamed', autoStart: true });
    assert.equal(response.status, 200);
    assert.equal(response.json.id, 'ws-1');
    const call = manager.calls.find((entry) => entry[0] === 'updateWorkspace');
    assert.deepEqual(call, ['updateWorkspace', 'ws-1', { name: 'Renamed', autoStart: true }]);
  });

  it('PATCH unknown workspace maps to 404', async (t) => {
    const error = new Error('workspace not found: nope');
    error.code = 'WORKSPACE_NOT_FOUND';
    const manager = createFakeManager({ failures: { updateWorkspace: error } });
    const { base } = await setupApi(t, { manager });
    const response = await request(base, 'PATCH', '/api/workspaces/nope', { name: 'x' });
    assert.equal(response.status, 404);
    assert.match(response.json.error.message, /not found/);
  });

  it('DELETE /api/workspaces/:id removes the workspace', async (t) => {
    const { base, manager } = await setupApi(t);
    const response = await request(base, 'DELETE', '/api/workspaces/ws-1');
    assert.equal(response.status, 200);
    assert.deepEqual(response.json, { ok: true, id: 'ws-1' });
    assert.ok(manager.calls.some((call) => call[0] === 'removeWorkspace' && call[1] === 'ws-1'));
  });

  it('POST start / stop / restart delegate to the manager', async (t) => {
    const { base, manager } = await setupApi(t);
    const started = await request(base, 'POST', '/api/workspaces/ws-1/start');
    assert.equal(started.status, 200);
    assert.equal(started.json.state, 'running');
    const stopped = await request(base, 'POST', '/api/workspaces/ws-1/stop');
    assert.equal(stopped.json.state, 'stopped');
    const restarted = await request(base, 'POST', '/api/workspaces/ws-1/restart');
    assert.equal(restarted.json.state, 'running');
    assert.deepEqual(
      manager.calls.map((call) => call[0]),
      ['startWorkspace', 'stopWorkspace', 'restartWorkspace'],
    );
  });

  it('POST start surfaces failures as sanitized JSON 500s', async (t) => {
    const error = new Error('spawn failed Authorization: Bearer tok123456');
    error.code = 'WORKSPACE_START_FAILED';
    const manager = createFakeManager({ failures: { startWorkspace: error } });
    const { base } = await setupApi(t, { manager });
    const response = await request(base, 'POST', '/api/workspaces/ws-1/start');
    assert.equal(response.status, 500);
    assert.match(response.json.error.message, /spawn failed/);
    assert.equal(response.json.error.message.includes('tok123456'), false);
  });

  it('URL-decodes workspace ids in the path', async (t) => {
    const { base, manager } = await setupApi(t);
    const response = await request(base, 'PATCH', '/api/workspaces/ws%2D1', { name: 'Encoded' });
    assert.equal(response.status, 200);
    const call = manager.calls.find((entry) => entry[0] === 'updateWorkspace');
    assert.equal(call[1], 'ws-1');
  });
});

describe('api: config endpoints', () => {
  it('GET config returns the masked configuration', async (t) => {
    const manager = createFakeManager({ maskedConfig: MASKED });
    const { base } = await setupApi(t, { manager });
    const response = await request(base, 'GET', '/api/workspaces/ws-1/config');
    assert.equal(response.status, 200);
    assert.equal(response.json.channels.feishu.appSecret, '***');
    assert.equal(response.json.channels.feishu.appId, 'cli_0123456789abcdef');
    assert.ok(manager.calls.some((call) => call[0] === 'getWorkspaceConfig'));
  });

  it('PUT config saves a bare config object and returns the masked result', async (t) => {
    const manager = createFakeManager({ maskedConfig: MASKED });
    const { base } = await setupApi(t, { manager });
    const config = { channels: { feishu: { enabled: true, appSecret: '***' } } };
    const response = await request(base, 'PUT', '/api/workspaces/ws-1/config', config);
    assert.equal(response.status, 200);
    assert.equal(response.json.ok, true);
    assert.equal(response.json.config.channels.feishu.appSecret, '***');
    const call = manager.calls.find((entry) => entry[0] === 'saveWorkspaceConfig');
    assert.deepEqual(call, ['saveWorkspaceConfig', 'ws-1', config]);
  });

  it('PUT config accepts a { config } envelope', async (t) => {
    const { base, manager } = await setupApi(t);
    const config = { gateway: { http: { port: 0 } } };
    const response = await request(base, 'PUT', '/api/workspaces/ws-1/config', { config });
    assert.equal(response.status, 200);
    const call = manager.calls.find((entry) => entry[0] === 'saveWorkspaceConfig');
    assert.deepEqual(call[2], config);
  });

  it('PUT config maps validation errors to 400 and does not claim success', async (t) => {
    const error = new Error('invalid config: gateway.http.port must be 0-65535');
    error.code = 'INVALID_CONFIG';
    const manager = createFakeManager({ failures: { saveWorkspaceConfig: error } });
    const { base } = await setupApi(t, { manager });
    const response = await request(base, 'PUT', '/api/workspaces/ws-1/config', { gateway: {} });
    assert.equal(response.status, 400);
    assert.equal(response.json.ok, undefined);
    assert.match(response.json.error.message, /invalid config/);
  });
});

describe('api: pairing and logs', () => {
  it('GET pairing returns { pending: [...] } (and a pendingPairings alias)', async (t) => {
    const { base } = await setupApi(t);
    const response = await request(base, 'GET', '/api/workspaces/ws-1/pairing');
    assert.equal(response.status, 200);
    assert.equal(response.json.pending.length, 1);
    assert.equal(response.json.pending[0].code, '123456');
    assert.deepEqual(response.json.pendingPairings, response.json.pending);
  });

  it('POST pairing/approve approves a code', async (t) => {
    const { base, manager } = await setupApi(t);
    const response = await request(base, 'POST', '/api/workspaces/ws-1/pairing/approve', { code: ' 123456 ' });
    assert.equal(response.status, 200);
    assert.deepEqual(response.json, { ok: true, channel: 'feishu', senderId: 'ou_x' });
    const call = manager.calls.find((entry) => entry[0] === 'approvePairing');
    assert.deepEqual(call, ['approvePairing', 'ws-1', '123456']);
  });

  it('POST pairing/approve requires a code', async (t) => {
    const { base } = await setupApi(t);
    const response = await request(base, 'POST', '/api/workspaces/ws-1/pairing/approve', {});
    assert.equal(response.status, 400);
    assert.match(response.json.error.message, /code is required/);
  });

  it('POST pairing/approve on a stopped workspace maps to 409', async (t) => {
    const error = new Error('workspace not running: ws-1');
    error.code = 'WORKSPACE_NOT_RUNNING';
    const manager = createFakeManager({ failures: { approvePairing: error } });
    const { base } = await setupApi(t, { manager });
    const response = await request(base, 'POST', '/api/workspaces/ws-1/pairing/approve', { code: '1' });
    assert.equal(response.status, 409);
    assert.match(response.json.error.message, /not running/);
  });

  it('GET logs returns { lines } and forwards the requested count', async (t) => {
    const { base, manager } = await setupApi(t);
    const response = await request(base, 'GET', '/api/workspaces/ws-1/logs?lines=50');
    assert.equal(response.status, 200);
    assert.deepEqual(response.json.lines, ['line one', 'line two']);
    const call = manager.calls.find((entry) => entry[0] === 'getLogs');
    assert.deepEqual(call, ['getLogs', 'ws-1', 50]);
    const fallback = await request(base, 'GET', '/api/workspaces/ws-1/logs?lines=oops');
    assert.equal(fallback.status, 200);
    const fallbackCall = manager.calls.filter((entry) => entry[0] === 'getLogs').at(-1);
    assert.equal(fallbackCall[2], 200);
  });
});

describe('api: channel QR connect routes (§10.3)', () => {
  it('POST connect begins a flow and forwards mode', async (t) => {
    const { base, manager } = await setupApi(t);
    const response = await request(base, 'POST', '/api/workspaces/ws-1/channels/weixin/connect', { mode: 'qr' });
    assert.equal(response.status, 200);
    assert.equal(response.json.state, 'pending');
    assert.equal(response.json.channel, 'weixin');
    const call = manager.calls.find((entry) => entry[0] === 'beginChannelConnect');
    assert.deepEqual(call, ['beginChannelConnect', 'ws-1', 'weixin', { mode: 'qr' }]);
  });

  it('POST connect defaults to the QR mode with an empty body', async (t) => {
    const { base, manager } = await setupApi(t);
    const response = await request(base, 'POST', '/api/workspaces/ws-1/channels/feishu/connect');
    assert.equal(response.status, 200);
    const call = manager.calls.find((entry) => entry[0] === 'beginChannelConnect');
    assert.deepEqual(call, ['beginChannelConnect', 'ws-1', 'feishu', {}]);
  });

  it('POST connect rejects an invalid JSON body', async (t) => {
    const { base } = await setupApi(t);
    const response = await request(base, 'POST', '/api/workspaces/ws-1/channels/weixin/connect', '{oops');
    assert.equal(response.status, 400);
    assert.match(response.json.error.message, /invalid JSON/);
  });

  it('POST connect maps an already-enabled channel to 409', async (t) => {
    const error = new Error('channel "weixin" is already enabled; disable it before connecting');
    error.code = 'CONFLICT';
    const manager = createFakeManager({ failures: { beginChannelConnect: error } });
    const { base } = await setupApi(t, { manager });
    const response = await request(base, 'POST', '/api/workspaces/ws-1/channels/weixin/connect', {});
    assert.equal(response.status, 409);
    assert.match(response.json.error.message, /already enabled/);
  });

  it('POST connect maps unsupported channel/mode to 400 and unknown workspace to 404', async (t) => {
    const unsupported = new Error('channel "dingtalk" does not support QR connect');
    unsupported.code = 'INVALID_INPUT';
    const unsupportedManager = createFakeManager({ failures: { beginChannelConnect: unsupported } });
    const first = await setupApi(t, { manager: unsupportedManager });
    const unsupportedResponse = await request(first.base, 'POST', '/api/workspaces/ws-1/channels/dingtalk/connect', {});
    assert.equal(unsupportedResponse.status, 400);

    const missing = new Error('workspace not found: nope');
    missing.code = 'WORKSPACE_NOT_FOUND';
    const missingManager = createFakeManager({ failures: { beginChannelConnect: missing } });
    const second = await setupApi(t, { manager: missingManager });
    const missingResponse = await request(second.base, 'POST', '/api/workspaces/nope/channels/weixin/connect', {});
    assert.equal(missingResponse.status, 404);
  });

  it('GET connect returns the current flow or 404', async (t) => {
    const { base } = await setupApi(t);
    const response = await request(base, 'GET', '/api/workspaces/ws-1/channels/weixin/connect');
    assert.equal(response.status, 200);
    assert.equal(response.json.flowId, 'flow-1');
    assert.equal(response.json.state, 'confirmed');
    assert.equal(response.json.result.ilinkBotId, 'bot-1');

    const manager = createFakeManager();
    manager.getChannelConnect = () => null;
    const noFlow = await setupApi(t, { manager });
    const missing = await request(noFlow.base, 'GET', '/api/workspaces/ws-1/channels/weixin/connect');
    assert.equal(missing.status, 404);
    assert.match(missing.json.error.message, /no connect flow/);
  });

  it('POST cancel returns the flow and is the only allowed cancel method', async (t) => {
    const { base, manager } = await setupApi(t);
    const response = await request(base, 'POST', '/api/workspaces/ws-1/channels/weixin/connect/cancel');
    assert.equal(response.status, 200);
    assert.deepEqual(response.json, { ok: true, flow: null });
    assert.ok(manager.calls.some((call) => call[0] === 'cancelChannelConnect'));
    assert.equal((await request(base, 'GET', '/api/workspaces/ws-1/channels/weixin/connect/cancel')).status, 404);
    assert.equal((await request(base, 'DELETE', '/api/workspaces/ws-1/channels/weixin/connect')).status, 404);
  });
});

describe('api: pairing allow (host plugin tools)', () => {
  it('POST pairing/allow returns the allowlist entry', async (t) => {
    const { base, manager } = await setupApi(t);
    const response = await request(base, 'POST', '/api/workspaces/ws-1/pairing/allow', {
      channel: 'feishu',
      senderId: 'ou_x',
      name: 'Owner',
    });
    assert.equal(response.status, 200);
    assert.deepEqual(response.json, {
      ok: true,
      entry: { channel: 'feishu', senderId: 'ou_x', name: 'Owner' },
    });
    const call = manager.calls.find((entry) => entry[0] === 'allowSender');
    assert.deepEqual(call, ['allowSender', 'ws-1', { channel: 'feishu', senderId: 'ou_x', name: 'Owner' }]);
  });

  it('POST pairing/allow requires channel and senderId', async (t) => {
    const { base } = await setupApi(t);
    const missingChannel = await request(base, 'POST', '/api/workspaces/ws-1/pairing/allow', { senderId: 'ou_x' });
    assert.equal(missingChannel.status, 400);
    assert.match(missingChannel.json.error.message, /channel is required/);
    const missingSender = await request(base, 'POST', '/api/workspaces/ws-1/pairing/allow', { channel: 'feishu' });
    assert.equal(missingSender.status, 400);
    assert.match(missingSender.json.error.message, /senderId is required/);
    const empty = await request(base, 'POST', '/api/workspaces/ws-1/pairing/allow', { channel: '  ', senderId: '  ' });
    assert.equal(empty.status, 400);
  });

  it('POST pairing/allow maps workspace errors to 404/409', async (t) => {
    const missing = new Error('workspace not found: nope');
    missing.code = 'WORKSPACE_NOT_FOUND';
    const missingManager = createFakeManager({ failures: { allowSender: missing } });
    const first = await setupApi(t, { manager: missingManager });
    const notFound = await request(first.base, 'POST', '/api/workspaces/nope/pairing/allow', {
      channel: 'feishu',
      senderId: 'ou_x',
    });
    assert.equal(notFound.status, 404);

    const stopped = new Error('workspace not running: ws-1');
    stopped.code = 'WORKSPACE_NOT_RUNNING';
    const stoppedManager = createFakeManager({ failures: { allowSender: stopped } });
    const second = await setupApi(t, { manager: stoppedManager });
    const notRunning = await request(second.base, 'POST', '/api/workspaces/ws-1/pairing/allow', {
      channel: 'feishu',
      senderId: 'ou_x',
    });
    assert.equal(notRunning.status, 409);
  });

  it('POST pairing/allow rejects invalid JSON and wrong methods', async (t) => {
    const { base } = await setupApi(t);
    const badJson = await request(base, 'POST', '/api/workspaces/ws-1/pairing/allow', '{oops');
    assert.equal(badJson.status, 400);
    assert.match(badJson.json.error.message, /invalid JSON/);
    assert.equal((await request(base, 'GET', '/api/workspaces/ws-1/pairing/allow')).status, 404);
  });
});

describe('api: messages (host plugin send tool)', () => {
  it('POST messages builds the ReplyTarget and returns the messageId', async (t) => {
    const { base, manager } = await setupApi(t);
    const response = await request(base, 'POST', '/api/workspaces/ws-1/messages', {
      channel: 'feishu',
      conversationId: 'chat-1',
      text: 'hello',
    });
    assert.equal(response.status, 200);
    assert.deepEqual(response.json, { ok: true, messageId: 'msg-1' });
    const call = manager.calls.find((entry) => entry[0] === 'sendMessage');
    assert.deepEqual(call, [
      'sendMessage',
      'ws-1',
      {
        channel: 'feishu',
        target: {
          channel: 'feishu',
          accountId: 'feishu',
          conversationId: 'chat-1',
          conversationType: 'dm',
        },
        text: 'hello',
        format: 'plain',
      },
    ]);
  });

  it('POST messages maps group conversations and replyToMessageId', async (t) => {
    const { base, manager } = await setupApi(t);
    const response = await request(base, 'POST', '/api/workspaces/ws-1/messages', {
      channel: 'weixin',
      conversationId: 'room-1',
      text: 'reply',
      conversationType: 'group',
      replyToMessageId: 'm-9',
    });
    assert.equal(response.status, 200);
    const call = manager.calls.find((entry) => entry[0] === 'sendMessage');
    assert.equal(call[2].channel, 'weixin');
    assert.equal(call[2].target.conversationType, 'group');
    assert.equal(call[2].target.replyToMessageId, 'm-9');
    // Any unknown conversationType falls back to dm.
    await request(base, 'POST', '/api/workspaces/ws-1/messages', {
      channel: 'weixin',
      conversationId: 'room-2',
      text: 'x',
      conversationType: 'channel',
    });
    const fallback = manager.calls.filter((entry) => entry[0] === 'sendMessage').at(-1);
    assert.equal(fallback[2].target.conversationType, 'dm');
  });

  it('POST messages trims ids but keeps message text verbatim', async (t) => {
    const { base, manager } = await setupApi(t);
    const response = await request(base, 'POST', '/api/workspaces/ws-1/messages', {
      channel: '  feishu  ',
      conversationId: '  chat-2  ',
      text: '  line one\nline two  ',
    });
    assert.equal(response.status, 200);
    const call = manager.calls.find((entry) => entry[0] === 'sendMessage');
    assert.equal(call[2].channel, 'feishu');
    assert.equal(call[2].target.conversationId, 'chat-2');
    assert.equal(call[2].text, '  line one\nline two  ');
  });

  it('POST messages requires channel, conversationId and text', async (t) => {
    const { base } = await setupApi(t);
    for (const [body, pattern] of [
      [{ conversationId: 'c', text: 't' }, /channel is required/],
      [{ channel: 'feishu', text: 't' }, /conversationId is required/],
      [{ channel: 'feishu', conversationId: 'c' }, /text is required/],
      [{ channel: 'feishu', conversationId: 'c', text: '   ' }, /text is required/],
    ]) {
      const response = await request(base, 'POST', '/api/workspaces/ws-1/messages', body);
      assert.equal(response.status, 400);
      assert.match(response.json.error.message, pattern);
    }
  });

  it('POST messages maps workspace/channel errors to 404/409', async (t) => {
    const missing = new Error('workspace not found: nope');
    missing.code = 'WORKSPACE_NOT_FOUND';
    const missingManager = createFakeManager({ failures: { sendMessage: missing } });
    const first = await setupApi(t, { manager: missingManager });
    assert.equal(
      (await request(first.base, 'POST', '/api/workspaces/nope/messages', {
        channel: 'feishu',
        conversationId: 'c',
        text: 't',
      })).status,
      404,
    );

    const stopped = new Error('workspace not running: ws-1');
    stopped.code = 'WORKSPACE_NOT_RUNNING';
    const stoppedManager = createFakeManager({ failures: { sendMessage: stopped } });
    const second = await setupApi(t, { manager: stoppedManager });
    assert.equal(
      (await request(second.base, 'POST', '/api/workspaces/ws-1/messages', {
        channel: 'feishu',
        conversationId: 'c',
        text: 't',
      })).status,
      409,
    );

    const channelDown = new Error('channel "weixin" is not running');
    channelDown.code = 'CHANNEL_NOT_RUNNING';
    const channelManager = createFakeManager({ failures: { sendMessage: channelDown } });
    const third = await setupApi(t, { manager: channelManager });
    const channelResponse = await request(third.base, 'POST', '/api/workspaces/ws-1/messages', {
      channel: 'weixin',
      conversationId: 'c',
      text: 't',
    });
    assert.equal(channelResponse.status, 409);
    assert.match(channelResponse.json.error.message, /channel "weixin" is not running/);
  });

  it('POST messages rejects invalid JSON and wrong methods', async (t) => {
    const { base } = await setupApi(t);
    const badJson = await request(base, 'POST', '/api/workspaces/ws-1/messages', '{oops');
    assert.equal(badJson.status, 400);
    assert.equal((await request(base, 'GET', '/api/workspaces/ws-1/messages')).status, 404);
    assert.equal((await request(base, 'DELETE', '/api/workspaces/ws-1/messages')).status, 404);
  });
});

describe('api: routing errors', () => {
  it('unknown API paths return JSON 404 errors', async (t) => {
    const { base } = await setupApi(t);
    const response = await request(base, 'GET', '/api/nope');
    assert.equal(response.status, 404);
    assert.equal(typeof response.json.error.message, 'string');
    assert.match(response.headers.get('content-type') ?? '', /application\/json/);
  });

  it('wrong methods on known endpoints return 404', async (t) => {
    const { base } = await setupApi(t);
    assert.equal((await request(base, 'GET', '/api/workspaces')).status, 404);
    assert.equal((await request(base, 'POST', '/api/workspaces/ws-1/start')).status, 200);
    assert.equal((await request(base, 'GET', '/api/workspaces/ws-1/start')).status, 404);
    assert.equal((await request(base, 'POST', '/api/workspaces/ws-1/config')).status, 404);
  });
});

describe('api: root', () => {
  it('GET / describes the service and points at the DSH UI', async (t) => {
    const { base } = await setupApi(t);
    const response = await request(base, 'GET', '/');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /application\/json/);
    assert.equal(response.json.service, 'dsh-im-manager');
    assert.match(response.json.ui, /DSH/);
  });

  it('returns JSON 404 for unknown non-API paths', async (t) => {
    const { base } = await setupApi(t);
    const response = await request(base, 'GET', '/app.js');
    assert.equal(response.status, 404);
    assert.equal(typeof response.json.error.message, 'string');
  });
});

describe('api: lifecycle', () => {
  it('start() returns the actual port, is idempotent, and exposes listen/server', async (t) => {
    const dir = tempDir('manager-api-lifecycle');
    const api = createManagerApi({ manager: createFakeManager(), logger: silentLogger() });
    t.after(async () => {
      await api.stop().catch(() => {});
      await api.stop().catch(() => {});
      removeDir(dir);
    });
    assert.deepEqual(api.listen, { host: '127.0.0.1', port: 0 });
    const first = await api.start({ host: '127.0.0.1', port: 0 });
    assert.ok(first.port > 0);
    assert.equal(typeof api.server, 'object');
    const second = await api.start({ host: '127.0.0.1', port: 0 });
    assert.deepEqual(second, first);
    assert.deepEqual(api.listen, first);
    const response = await request(`http://127.0.0.1:${first.port}`, 'GET', '/api/health');
    assert.equal(response.status, 200);
    await api.stop();
    assert.deepEqual(api.listen, first);
  });

  it('defaults to the manager listen address when start() has no arguments', async (t) => {
    const dir = tempDir('manager-api-default-listen');
    const manager = createFakeManager();
    manager.listen = { host: '127.0.0.1', port: 0 };
    const api = createManagerApi({ manager, logger: silentLogger() });
    t.after(async () => {
      await api.stop().catch(() => {});
      removeDir(dir);
    });
    const listen = await api.start();
    assert.equal(listen.host, '127.0.0.1');
    assert.ok(listen.port > 0);
  });

  it('rejects an invalid port', async (t) => {
    const dir = tempDir('manager-api-port');
    const api = createManagerApi({ manager: createFakeManager(), logger: silentLogger() });
    t.after(() => removeDir(dir));
    await assert.rejects(api.start({ host: '127.0.0.1', port: 70000 }), /invalid port/);
  });
});

describe('api + real manager integration', () => {
  it('manages a full workspace through HTTP with a fake gateway factory', async (t) => {
    const { createManager } = await import('../../src/manager/manager.js');
    const dir = tempDir('manager-api-integration');
    const factory = createFakeGatewayFactory({ health: { weixin: 'disconnected' } });
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
    t.after(async () => {
      await api.stop().catch(() => {});
      await manager.stop().catch(() => {});
      removeDir(dir);
    });

    // Create a workspace through the API.
    const created = await request(base, 'POST', '/api/workspaces', {
      name: 'HTTP WS',
      workspaceDir: join(dir, 'http-ws'),
      channels: ['weixin'],
      autoStart: false,
    });
    assert.equal(created.status, 201);
    const id = created.json.id;
    assert.equal(id, 'http-ws');
    // §10.1: channels selected at creation are configured but not enabled.
    assert.deepEqual(created.json.channels, []);

    // Masked config.
    const config = await request(base, 'GET', `/api/workspaces/${id}/config`);
    assert.equal(config.status, 200);
    assert.equal(config.json.gateway.http.port, 0);
    assert.equal(config.json.channels.weixin.enabled, false);

    // Enabling still goes through the config endpoint (manual path).
    const enabled = await request(base, 'PUT', `/api/workspaces/${id}/config`, {
      channels: { weixin: { enabled: true } },
    });
    assert.equal(enabled.status, 200);

    // Start, then pairing.
    const started = await request(base, 'POST', `/api/workspaces/${id}/start`);
    assert.equal(started.status, 200);
    assert.equal(started.json.state, 'running');
    assert.equal(started.json.channels[0].health, 'disconnected');
    factory.gateways[0].pairing.request({ channel: 'weixin', senderId: 'wxid_1', name: 'WeChat Owner' });
    const pairing = await request(base, 'GET', `/api/workspaces/${id}/pairing`);
    assert.equal(pairing.json.pending.length, 1);
    const approve = await request(base, 'POST', `/api/workspaces/${id}/pairing/approve`, {
      code: pairing.json.pending[0].code,
    });
    assert.equal(approve.status, 200);
    assert.deepEqual(approve.json, { ok: true, channel: 'weixin', senderId: 'wxid_1' });

    // Editing the config restarts the running workspace.
    const saved = await request(base, 'PUT', `/api/workspaces/${id}/config`, {
      channels: { feishu: { enabled: true, appId: 'cli_0123456789abcdef', appSecret: 'feishu-secret' } },
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.json.ok, true);
    assert.equal(factory.gateways.length, 2);
    assert.equal(factory.gateways[0].state, 'stopped');
    assert.equal(factory.gateways[0].stopCalls, 1);

    // Logs endpoint works even when no line was captured yet.
    const logs = await request(base, 'GET', `/api/workspaces/${id}/logs?lines=20`);
    assert.equal(logs.status, 200);
    assert.ok(Array.isArray(logs.json.lines));

    // Stop + delete, then state is empty.
    const stopped = await request(base, 'POST', `/api/workspaces/${id}/stop`);
    assert.equal(stopped.json.state, 'stopped');
    const removed = await request(base, 'DELETE', `/api/workspaces/${id}`);
    assert.equal(removed.status, 200);
    const state = await request(base, 'GET', '/api/state');
    assert.deepEqual(state.json.workspaces, []);
  });
});
