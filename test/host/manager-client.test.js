import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createHttpManagerAdapter, createManagerHttpClient, formatManagerStatus, pickWorkspace } from '../../src/host/manager-client.js';

const state = {
  manager: { listen: { host: '127.0.0.1', port: 8788 } },
  workspaces: [
    {
      id: 'wa',
      name: 'Workspace A',
      workspaceDir: '/tmp/a',
      state: 'running',
      bridge: 'ready',
      sessions: 2,
      channels: [{ id: 'weixin', enabled: true, health: 'connected' }],
      pendingPairings: [{ code: '123456', channel: 'weixin', senderId: 'wx_1' }],
    },
    { id: 'wb', name: 'Workspace B', workspaceDir: '/tmp/b', state: 'stopped', bridge: 'absent', sessions: 0, channels: [] },
  ],
};

test('pickWorkspace resolves by id/name/dir and requires a choice with multiple running', () => {
  assert.equal(pickWorkspace(state).id, 'wa');
  assert.equal(pickWorkspace(state, 'wb').id, 'wb');
  assert.equal(pickWorkspace(state, 'Workspace B').id, 'wb');
  assert.equal(pickWorkspace(state, '/tmp/b').id, 'wb');
  assert.throws(() => pickWorkspace(state, 'nope'), /not found/);

  const twoRunning = { workspaces: [ { ...state.workspaces[0] }, { ...state.workspaces[1], state: 'running' } ] };
  assert.throws(() => pickWorkspace(twoRunning), /multiple running workspaces/);
  assert.equal(pickWorkspace({ workspaces: [{ ...state.workspaces[0], state: 'stopped' }] }).id, 'wa');
});

test('formatManagerStatus aggregates the flat tool output', () => {
  const formatted = formatManagerStatus(state, 'http://127.0.0.1:8788');
  assert.equal(formatted.state, 'running');
  assert.equal(formatted.bridge, 'ready,absent');
  assert.equal(formatted.sessions, 2);
  assert.equal(formatted.http, 'http://127.0.0.1:8788');
  assert.deepEqual(formatted.pendingPairings, ['123456  wa/weixin:wx_1']);
  assert.match(formatted.detail, /1\/2 workspace\(s\) running/);
  assert.match(formatted.detail, /wa \[running\]/);
  assert.match(formatted.detail, /Pending pairings:/);
});

test('createManagerHttpClient maps methods to the manager API', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/api/state')) return new Response(JSON.stringify(state), { status: 200 });
    return new Response(JSON.stringify({ ok: true, messageId: 'm1' }), { status: 200 });
  };
  const client = createManagerHttpClient('http://127.0.0.1:8788/', { fetchImpl });
  assert.equal((await client.getState()).workspaces.length, 2);
  assert.deepEqual(await client.approvePairing('wa', '123456'), { ok: true, messageId: 'm1' });
  assert.deepEqual(await client.allowSender('wa', { channel: 'weixin', senderId: 'wx_1' }), { ok: true, messageId: 'm1' });
  assert.deepEqual(
    await client.sendMessage('wa', { channel: 'feishu', conversationId: 'oc_1', text: 'hi' }),
    { ok: true, messageId: 'm1' },
  );
  assert.equal(calls[0].url, 'http://127.0.0.1:8788/api/state');
  assert.match(calls[1].url, /\/api\/workspaces\/wa\/pairing\/approve$/);
  assert.equal(JSON.parse(calls[1].init.body).code, '123456');
  assert.match(calls[2].url, /\/api\/workspaces\/wa\/pairing\/allow$/);
  assert.match(calls[3].url, /\/api\/workspaces\/wa\/messages$/);
});

test('createManagerHttpClient surfaces API error messages', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ error: { message: 'workspace not running' } }), { status: 409 });
  const client = createManagerHttpClient('http://127.0.0.1:8788', { fetchImpl });
  await assert.rejects(client.getState(), /workspace not running/);
});

test('createHttpManagerAdapter maps manager methods onto the HTTP API', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const body = url.endsWith('/sessions/activity')
      ? { revision: '1:2', workspaces: [] }
      : url.endsWith('/pairing')
      ? { pending: [{ code: '1' }] }
      : url.includes('/logs')
        ? { lines: ['a', 'b'] }
        : { ok: true };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const adapter = createHttpManagerAdapter('http://127.0.0.1:8788', { fetchImpl });
  assert.deepEqual(await adapter.getSessionActivity(), { revision: '1:2', workspaces: [] });
  const adopted = await adapter.adoptWorkspace({ path: '/tmp/w', title: 'W' });
  assert.equal(adopted.ok, true);
  assert.match(calls.at(-1).url, /\/api\/workspaces$/);
  assert.equal((await adapter.listPairing('ws')).length, 1);
  assert.deepEqual(await adapter.getLogs('ws', 10), ['a', 'b']);
  await adapter.startWorkspace('ws');
  assert.match(calls.at(-1).url, /\/api\/workspaces\/ws\/start$/);
  await adapter.beginChannelConnect('ws', 'weixin', { mode: 'qr' });
  assert.match(calls.at(-1).url, /\/channels\/weixin\/connect$/);
  await adapter.cancelChannelConnect('ws', 'weixin');
  assert.match(calls.at(-1).url, /\/connect\/cancel$/);
});
