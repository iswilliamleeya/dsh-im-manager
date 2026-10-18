import assert from 'node:assert/strict';
import { test } from 'node:test';

import { attachSessionsToWorkspaces, backfillWorkspaceSessions } from '../../src/host/workspace-attach.js';

function fakeRegistry({ byPath = {}, attachErrors = new Set() } = {}) {
  const attached = [];
  const entities = new Map();
  const registry = {
    async resolveByPath(path) {
      const known = byPath[path];
      if (known === undefined) return undefined;
      if (!entities.has(path)) {
        entities.set(path, {
          sessionIds: [...(known.sessionIds ?? [])],
          async attachSession(sessionId) {
            if (attachErrors.has(sessionId)) throw new Error('header not persisted yet');
            attached.push({ path, sessionId });
            if (!this.sessionIds.includes(sessionId)) this.sessionIds.unshift(sessionId);
          },
        });
      }
      return entities.get(path);
    },
  };
  return { registry, attached };
}

test('attaches sessions to the matching workspace and skips already-attached ones', async () => {
  const { registry, attached } = fakeRegistry({
    byPath: {
      '/ws/a': { sessionIds: ['already'] },
    },
  });
  const activity = {
    revision: '2:2',
    workspaces: [
      { id: 'wa', workspaceDir: '/ws/a', sessions: [{ sessionId: 'already' }, { sessionId: 'new-a' }] },
      { id: 'wb', workspaceDir: '/ws/b', sessions: [{ sessionId: 'new-b' }] },
    ],
  };
  const result = await attachSessionsToWorkspaces(activity, registry);
  assert.deepEqual(result.attached, ['new-a']);
  assert.deepEqual(result.skipped, []);
  assert.deepEqual(attached, [{ path: '/ws/a', sessionId: 'new-a' }]);
});

test('best-effort: missing workspace, unresolved path and not-yet-persisted headers are skipped', async () => {
  const { registry, attached } = fakeRegistry({
    byPath: { '/ws/a': { sessionIds: [] }, '/ws/error': { sessionIds: [] } },
    attachErrors: new Set(['pending']),
  });
  const activity = {
    workspaces: [
      { id: 'wa', workspaceDir: '/ws/a', sessions: [{ sessionId: 'pending' }, { sessionId: 'ok' }] },
      { id: 'wmissing', workspaceDir: '/ws/missing', sessions: [{ sessionId: 'x' }] },
      { id: 'wnodir', sessions: [{ sessionId: 'y' }] },
    ],
  };
  const result = await attachSessionsToWorkspaces(activity, registry);
  assert.deepEqual(result.attached, ['ok']);
  assert.deepEqual(result.skipped, ['pending']);
  assert.deepEqual(attached, [{ path: '/ws/a', sessionId: 'ok' }]);
});

test('ignores malformed activity and missing registry', async () => {
  assert.deepEqual(await attachSessionsToWorkspaces(null, {}), { attached: [], skipped: [] });
  assert.deepEqual(await attachSessionsToWorkspaces({ workspaces: [] }, null), { attached: [], skipped: [] });
  const { registry } = fakeRegistry();
  assert.deepEqual(await attachSessionsToWorkspaces({ workspaces: [{ workspaceDir: '/ws/a', sessions: [{}] }] }, registry), {
    attached: [],
    skipped: [],
  });
});


test('backfill attaches stored sessions to matching workspaces and skips failures', async () => {
  const entities = new Map([
    ['/ws/a', { sessionIds: ['already'], async attachSession(id) { this.sessionIds.unshift(id); } }],
  ]);
  const registry = {
    async resolveByPath(path) {
      return entities.get(path);
    },
  };
  const sessionQuery = {
    async listSessions() {
      return [
        { header: { id: 'already', cwd: '/ws/a' } },
        { header: { id: 'new', cwd: '/ws/a' } },
        { header: { id: 'unknown-path', cwd: '/ws/unknown' } },
        { header: { id: 'no-cwd' } },
        { header: { id: 'bad', cwd: '/ws/a' } },
      ];
    },
  };
  const original = entities.get('/ws/a').attachSession;
  entities.get('/ws/a').attachSession = async function attach(id) {
    if (id === 'bad') throw new Error('header mismatch');
    return original.call(this, id);
  };
  const result = await backfillWorkspaceSessions(registry, sessionQuery);
  assert.deepEqual(result, { attached: 1, skipped: 1, scanned: 4 });
  assert.deepEqual(entities.get('/ws/a').sessionIds, ['new', 'already']);
});

test('backfill tolerates unavailable services and list failures', async () => {
  assert.deepEqual(await backfillWorkspaceSessions(null, {}), { attached: 0, skipped: 0, scanned: 0 });
  assert.deepEqual(await backfillWorkspaceSessions({}, { listSessions: async () => [] }), { attached: 0, skipped: 0, scanned: 0 });
  const failing = { listSessions: async () => { throw new Error('backend down'); } };
  assert.deepEqual(await backfillWorkspaceSessions({ async resolveByPath() {} }, failing), { attached: 0, skipped: 0, scanned: 0 });
});
