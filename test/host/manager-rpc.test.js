import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createManagerRpcHandler } from '../../src/host/manager-rpc.js';

function fakeManager(overrides = {}) {
  const calls = [];
  const record = (name) => (...args) => {
    calls.push({ name, args });
    return overrides[name] ? overrides[name](...args) : { ok: true };
  };
  const manager = {
    getState: () => ({ workspaces: [{ id: 'ws', state: 'running' }] }),
    getSessionActivity: () => ({ revision: '1:10', workspaces: [] }),
    adoptWorkspace: record('adoptWorkspace'),
    addWorkspace: record('addWorkspace'),
    updateWorkspace: record('updateWorkspace'),
    startWorkspace: record('startWorkspace'),
    stopWorkspace: record('stopWorkspace'),
    restartWorkspace: record('restartWorkspace'),
    removeWorkspace: record('removeWorkspace'),
    getWorkspaceConfig: () => ({ channels: { feishu: { appSecret: '***' } } }),
    saveWorkspaceConfig: record('saveWorkspaceConfig'),
    listPairing: () => [{ code: '123456', channel: 'weixin', senderId: 'wx_1' }],
    approvePairing: record('approvePairing'),
    allowSender: record('allowSender'),
    beginChannelConnect: record('beginChannelConnect'),
    getChannelConnect: () => ({ state: 'pending' }),
    cancelChannelConnect: record('cancelChannelConnect'),
    getLogs: (id, lines) => [`${id}:${lines}`],
    sendMessage: record('sendMessage'),
  };
  return { manager, calls };
}

test('state/config/pairing/logs endpoints', async () => {
  const { manager } = fakeManager();
  const rpc = createManagerRpcHandler(manager);
  const state = await rpc('state', {});
  assert.equal(state.ok, true);
  assert.equal(state.value.workspaces[0].id, 'ws');
  const activity = await rpc('activity', {});
  assert.deepEqual(activity.value, { revision: '1:10', workspaces: [] });
  const discover = await createManagerRpcHandler(manager, { discover: async () => ({ workspaces: [1], unlinked: [] }) })('discover', {});
  assert.deepEqual(discover.value, { workspaces: [1], unlinked: [] });

  const config = await rpc('config.get', { id: 'ws' });
  assert.equal(config.ok, true);
  assert.equal(config.value.channels.feishu.appSecret, '***');

  const pairing = await rpc('pairing.list', { id: 'ws' });
  assert.equal(pairing.value.pending.length, 1);

  const logs = await rpc('logs', { id: 'ws', lines: 25 });
  assert.deepEqual(logs.value.lines, ['ws:25']);
});

test('workspace lifecycle endpoints forward the id', async () => {
  const { manager, calls } = fakeManager();
  const rpc = createManagerRpcHandler(manager);
  for (const endpoint of ['workspace.start', 'workspace.stop', 'workspace.restart']) {
    const result = await rpc(endpoint, { id: 'ws' });
    assert.equal(result.ok, true);
    assert.deepEqual(calls.at(-1), { name: endpoint.split('.')[1] + 'Workspace', args: ['ws'] });
  }
  const removed = await rpc('workspace.remove', { id: 'ws' });
  assert.deepEqual(removed.value, { id: 'ws' });
  assert.equal(calls.at(-1).name, 'removeWorkspace');
});

test('add/update/save-config endpoints validate and map payloads', async () => {
  const { manager, calls } = fakeManager({ addWorkspace: () => ({ id: 'new' }) });
  const rpc = createManagerRpcHandler(manager);
  const added = await rpc('workspace.add', { name: 'W', workspaceDir: '/tmp/w', channels: ['feishu'] });
  assert.equal(added.value.id, 'new');
  assert.deepEqual(calls.at(-1).args, [{ name: 'W', workspaceDir: '/tmp/w', channels: ['feishu'], autoStart: false }]);

  const updated = await rpc('workspace.update', { id: 'ws', name: 'N', autoStart: true });
  assert.equal(updated.ok, true);
  assert.deepEqual(calls.at(-1).args, ['ws', { name: 'N', autoStart: true }]);

  const saved = await rpc('config.save', { id: 'ws', config: { a: 1 } });
  assert.equal(saved.ok, true);
  assert.deepEqual(calls.at(-1).args, ['ws', { a: 1 }]);

  const adopted = await rpc('workspace.adopt', { path: '/tmp/w', title: 'W' });
  assert.equal(adopted.ok, true);
  assert.deepEqual(calls.at(-1), { name: 'adoptWorkspace', args: [{ path: '/tmp/w', title: 'W' }] });
});

test('pairing approve/allow and connect endpoints', async () => {
  const { manager, calls } = fakeManager({
    beginChannelConnect: () => ({ flowId: 'f', state: 'pending' }),
    cancelChannelConnect: () => ({ ok: true }),
  });
  const rpc = createManagerRpcHandler(manager);
  await rpc('pairing.approve', { id: 'ws', code: '123456' });
  assert.deepEqual(calls.at(-1), { name: 'approvePairing', args: ['ws', '123456'] });
  await rpc('pairing.allow', { id: 'ws', channel: 'feishu', senderId: 'ou_1' });
  assert.deepEqual(calls.at(-1), { name: 'allowSender', args: ['ws', { channel: 'feishu', senderId: 'ou_1' }] });

  const begun = await rpc('connect.begin', { id: 'ws', channel: 'weixin' });
  assert.equal(begun.value.flowId, 'f');
  assert.equal(calls.at(-1).name, 'beginChannelConnect');
  const got = await rpc('connect.get', { id: 'ws', channel: 'weixin' });
  assert.equal(got.value.state, 'pending');
  await rpc('connect.cancel', { id: 'ws', channel: 'weixin' });
  assert.equal(calls.at(-1).name, 'cancelChannelConnect');
});

test('message.send builds a ReplyTarget', async () => {
  const { manager, calls } = fakeManager();
  const rpc = createManagerRpcHandler(manager);
  await rpc('message.send', { id: 'ws', channel: 'feishu', conversationId: 'oc_1', text: 'hi', conversationType: 'group' });
  assert.deepEqual(calls.at(-1).args, ['ws', {
    channel: 'feishu',
    text: 'hi',
    target: { channel: 'feishu', accountId: 'feishu', conversationId: 'oc_1', conversationType: 'group' },
  }]);
});

test('errors and invalid input become structured failures', async () => {
  const { manager } = fakeManager();
  const rpc = createManagerRpcHandler(manager);
  assert.equal((await rpc('state', {})).ok, true);
  assert.equal((await rpc('state', {})).value.workspaces.length, 1);

  const invalid = await rpc('workspace.start', {});
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, 'INVALID_INPUT');

  const unknown = await rpc('nope', {});
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error.code, 'UNKNOWN_ENDPOINT');

  const forbidden = await rpc('state', {}, undefined, { principal: { kind: 'guest' } });
  assert.equal(forbidden.ok, false);
  assert.equal(forbidden.error.code, 'FORBIDDEN');
});
