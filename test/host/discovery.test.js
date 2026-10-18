import assert from 'node:assert/strict';
import { test } from 'node:test';

import { mergeDiscoveredWorkspaces } from '../../src/host/discovery.js';

const registry = [
  { id: 'w-dsh', path: '/Users/me/DSH', title: 'DSH', updatedAt: '2026-10-18T00:00:00Z' },
  { id: 'w-other', path: '/Users/me/other', title: 'Other', updatedAt: '2026-10-17T00:00:00Z' },
];

const state = {
  workspaces: [
    {
      id: 'manager-dsh', name: 'DSH Manager', workspaceDir: '/Users/me/DSH', state: 'running', bridge: 'ready',
      sessions: 2, autoStart: true, channels: [{ id: 'feishu', enabled: true, health: 'connected' }], error: null,
      http: { port: 8787, publicBaseUrl: 'http://127.0.0.1:8787' },
    },
    {
      id: 'manager-demo', name: 'Demo', workspaceDir: '/Users/me/demo', state: 'stopped', bridge: 'absent',
      sessions: 0, autoStart: false, channels: [], error: null, http: { port: 0, publicBaseUrl: '' },
    },
  ],
};

test('merges registry workspaces with manager gateway summaries', () => {
  const merged = mergeDiscoveredWorkspaces(state, registry);
  assert.equal(merged.workspaces.length, 2);
  const dsh = merged.workspaces.find((workspace) => workspace.workspaceId === 'w-dsh');
  assert.equal(dsh.managerId, 'manager-dsh');
  assert.equal(dsh.title, 'DSH');
  assert.equal(dsh.gateway.state, 'running');
  assert.equal(dsh.gateway.channels[0].health, 'connected');

  const other = merged.workspaces.find((workspace) => workspace.workspaceId === 'w-other');
  assert.equal(other.managerId, null);
  assert.equal(other.gateway, null);
  assert.equal(other.title, 'Other');

  assert.deepEqual(merged.unlinked.map((entry) => entry.managerId), ['manager-demo']);
});

test('handles trailing slashes and missing state/registry inputs', () => {
  const merged = mergeDiscoveredWorkspaces(
    { workspaces: [{ id: 'm', name: 'M', workspaceDir: '/Users/me/DSH/', state: 'stopped', channels: [] }] },
    [{ id: 'w', path: '/Users/me/DSH', title: 'DSH' }],
  );
  assert.equal(merged.workspaces[0].managerId, 'm');
  assert.deepEqual(merged.unlinked, []);
  assert.deepEqual(mergeDiscoveredWorkspaces(null, null), { workspaces: [], unlinked: [] });
});
