import assert from 'node:assert/strict';
import { test } from 'node:test';

import { addWorkspace, request, setupApi, setupManager } from './helpers.js';

test('manager exposes running gateway session activity with a stable revision', async (t) => {
  const entries = [
    { sessionId: 'session-a', lastUsedAt: 1000 },
    { sessionId: 'session-b', lastUsedAt: 2000 },
  ];
  const { dir, manager } = await setupManager(t, { factoryOptions: { sessionEntries: entries } });
  const workspace = await addWorkspace(manager, dir, { channels: [] });
  await manager.startWorkspace(workspace.id);

  const activity = manager.getSessionActivity();
  assert.equal(activity.revision, '2:2000');
  assert.equal(activity.workspaces.length, 1);
  assert.equal(activity.workspaces[0].id, workspace.id);
  assert.equal(activity.workspaces[0].workspaceDir, workspace.workspaceDir);
  assert.deepEqual(activity.workspaces[0].sessions, entries);

  // Stopping the workspace removes its live activity.
  await manager.stopWorkspace(workspace.id);
  assert.deepEqual(manager.getSessionActivity(), { revision: '0:0', workspaces: [] });
});

test('GET /api/sessions/activity returns the manager activity', async (t) => {
  const expected = { revision: '1:42', workspaces: [{ id: 'ws', sessions: [{ sessionId: 's', lastUsedAt: 42 }] }] };
  const { base } = await setupApi(t, { manager: { getSessionActivity: () => expected } });
  const response = await request(base, 'GET', '/api/sessions/activity');
  assert.equal(response.status, 200);
  assert.deepEqual(response.json, expected);
  const wrongMethod = await request(base, 'POST', '/api/sessions/activity');
  assert.equal(wrongMethod.status, 404);
});

test('adoptWorkspace registers a discovered path idempotently and can rename', async (t) => {
  const { dir, manager } = await setupManager(t);
  const workspaceDir = `${dir}/workspaces/adopted`;
  const { mkdirSync } = await import('node:fs');
  mkdirSync(workspaceDir, { recursive: true });
  const first = await manager.adoptWorkspace({ path: workspaceDir, title: 'Discovered' });
  assert.equal(first.workspaceDir, workspaceDir);
  assert.equal(first.state, 'stopped');
  const second = await manager.adoptWorkspace({ path: workspaceDir, title: 'Renamed' });
  assert.equal(second.id, first.id);
  assert.equal(second.name, 'Renamed');
  assert.equal(manager.getState().workspaces.length, 1);
});
