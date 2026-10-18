import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createDedupe } from '../../src/core/dedupe.js';
import { createSessionStore } from '../../src/core/session-store.js';
import { createPairingStore } from '../../src/core/pairing.js';
import { createSemaphore } from '../../src/core/semaphore.js';
import { decideAccess } from '../../src/core/access.js';
import { defaultConfig } from '../../src/core/config.js';
import { tempDir, removeDir } from './helpers.js';

describe('dedupe', () => {
  it('accepts once, rejects replays, and persists across instances', () => {
    const dir = tempDir();
    try {
      const file = join(dir, 'dedupe.json');
      const first = createDedupe({ file, now: () => 1000 });
      assert.equal(first.checkAndAdd('a'), true);
      assert.equal(first.checkAndAdd('a'), false);
      first.close();
      const second = createDedupe({ file, now: () => 1000 });
      assert.equal(second.checkAndAdd('a'), false);
      assert.equal(second.checkAndAdd('b'), true);
      second.close();
    } finally {
      removeDir(dir);
    }
  });

  it('expires entries after the TTL', () => {
    let clock = 0;
    const dedupe = createDedupe({ ttlMs: 100, now: () => clock });
    assert.equal(dedupe.checkAndAdd('x'), true);
    clock = 200;
    assert.equal(dedupe.checkAndAdd('x'), true);
  });
});

describe('session store', () => {
  it('creates, persists, and resets session ids', () => {
    const dir = tempDir();
    try {
      const file = join(dir, 'sessions.json');
      const store = createSessionStore({ file, now: () => 5, uuid: () => 'uuid-1' });
      const first = store.ensure('k');
      assert.equal(first.created, true);
      assert.equal(first.sessionId, 'uuid-1');
      assert.equal(store.ensure('k').sessionId, 'uuid-1');
      const reset = store.reset('k');
      assert.equal(reset.sessionId, 'uuid-1');
      store.flush();

      const second = createSessionStore({ file });
      assert.equal(second.get('k')?.sessionId, 'uuid-1');
      assert.equal(second.get('missing'), undefined);
      assert.equal(existsSync(file), true);
      assert.match(readFileSync(file, 'utf8'), /uuid-1/);
    } finally {
      removeDir(dir);
    }
  });
});

describe('session store workspace fingerprint', () => {
  it('writes the workspace fingerprint and keeps bindings for the same workspace', () => {
    const dir = tempDir();
    try {
      const file = join(dir, 'sessions.json');
      const workspace = { cwd: '/repo/a' };
      const first = createSessionStore({ file, workspace, uuid: () => 's1' });
      first.ensure('feishu:feishu:dm:chat-1');
      first.flush();
      const raw = JSON.parse(readFileSync(file, 'utf8'));
      assert.equal(raw.version, 2);
      assert.deepEqual(raw.workspace, workspace);

      const second = createSessionStore({ file, workspace });
      assert.equal(second.workspaceMismatch, null);
      assert.equal(second.get('feishu:feishu:dm:chat-1')?.sessionId, 's1');
    } finally {
      removeDir(dir);
    }
  });

  it('discards bindings when the state dir is reused by another workspace', () => {
    const dir = tempDir();
    try {
      const file = join(dir, 'sessions.json');
      const first = createSessionStore({ file, workspace: { cwd: '/repo/a' }, uuid: () => 'wrong-project-session' });
      first.ensure('weixin:weixin:dm:wxid');
      first.flush();

      const moved = createSessionStore({ file, workspace: { cwd: '/repo/b' } });
      assert.notEqual(moved.workspaceMismatch, null);
      assert.equal(moved.workspaceMismatch.stored.cwd, '/repo/a');
      assert.equal(moved.workspaceMismatch.current.cwd, '/repo/b');
      assert.equal(moved.get('weixin:weixin:dm:wxid'), undefined);
      assert.equal(moved.size, 0);
    } finally {
      removeDir(dir);
    }
  });

  it('loads legacy v1 files without a workspace as-is', () => {
    const dir = tempDir();
    try {
      const file = join(dir, 'sessions.json');
      writeFileSync(file, JSON.stringify({
        version: 1,
        sessions: { 'feishu:feishu:dm:chat-1': { sessionId: 'legacy', createdAt: 1, lastUsedAt: 2 } },
      }));
      const store = createSessionStore({ file, workspace: { cwd: '/repo/a' } });
      assert.equal(store.workspaceMismatch, null);
      assert.equal(store.get('feishu:feishu:dm:chat-1')?.sessionId, 'legacy');
    } finally {
      removeDir(dir);
    }
  });
});

describe('pairing store', () => {
  it('reuses a pending code, approves it, and persists the allowlist', () => {
    const dir = tempDir();
    try {
      const file = join(dir, 'pairing.json');
      let clock = 1000;
      const store = createPairingStore({ file, ttlSec: 60, now: () => clock });
      const first = store.request({ channel: 'feishu', senderId: 'u9', name: 'Nine' });
      const second = store.request({ channel: 'feishu', senderId: 'u9' });
      assert.equal(first.code, second.code);
      assert.equal(store.isApproved('feishu', 'u9'), false);
      const approved = store.approve(first.code);
      assert.equal(approved.ok, true);
      assert.equal(store.isApproved('feishu', 'u9'), true);
      store.flush();

      const reloaded = createPairingStore({ file, ttlSec: 60, now: () => clock });
      assert.equal(reloaded.isApproved('feishu', 'u9'), true);
      assert.equal(reloaded.listPending().length, 0);

      clock += 61_000;
      const expired = reloaded.request({ channel: 'feishu', senderId: 'u10' });
      clock += 61_000;
      assert.equal(reloaded.approve(expired.code).ok, false);
    } finally {
      removeDir(dir);
    }
  });

  it('supports direct allow and revoke', () => {
    const store = createPairingStore({ now: () => 1 });
    store.allow({ channel: 'weixin', senderId: 'wxid_o1' });
    assert.equal(store.isApproved('weixin', 'wxid_o1'), true);
    assert.equal(store.revoke('weixin', 'wxid_o1'), true);
    assert.equal(store.isApproved('weixin', 'wxid_o1'), false);
  });

  it('observes an approval written by another process (CLI pair) without restart', () => {
    const dir = tempDir();
    try {
      const file = join(dir, 'pairing.json');
      // The running gateway owns store A for its whole lifetime.
      const gatewayStore = createPairingStore({ file, ttlSec: 600, now: () => 1000 });
      const request = gatewayStore.request({ channel: 'feishu', senderId: 'u-live' });
      assert.equal(gatewayStore.isApproved('feishu', 'u-live'), false);

      // The operator's `dsh-im-manager pair <code>` runs in another process.
      const cliStore = createPairingStore({ file, ttlSec: 600, now: () => 2000 });
      assert.equal(cliStore.approve(request.code).ok, true);

      // The next inbound message must see the approval immediately.
      assert.equal(gatewayStore.isApproved('feishu', 'u-live'), true);
      assert.equal(gatewayStore.listPending().length, 0);
    } finally {
      removeDir(dir);
    }
  });
});

describe('semaphore', () => {
  it('bounds concurrency and drains waiters in order', async () => {
    const semaphore = createSemaphore(2);
    await semaphore.acquire();
    await semaphore.acquire();
    assert.equal(semaphore.active, 2);
    let third = false;
    const pending = semaphore.acquire().then(() => {
      third = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(third, false);
    assert.equal(semaphore.queued, 1);
    semaphore.release();
    await pending;
    assert.equal(third, true);
    assert.equal(semaphore.active, 2);
    semaphore.release();
    semaphore.release();
    assert.equal(semaphore.active, 0);
  });
});

describe('decideAccess', () => {
  function baseConfig(overrides) {
    const config = defaultConfig();
    config.gateway.access = { dmPolicy: 'pairing', allowFrom: [], pairingTtlSec: 600, groups: { enabled: false, requireMention: true, allowFrom: [] } };
    Object.assign(config.gateway.access, overrides);
    return config;
  }
  const pairing = { isApproved: () => false };

  it('allows listed DM senders and denies unknown ones', () => {
    const config = baseConfig({ dmPolicy: 'allowlist', allowFrom: ['u1'] });
    assert.equal(decideAccess({ config, pairing, message: { channel: 'feishu', conversationType: 'dm', sender: { id: 'u1' }, conversationId: 'c', mentioned: true } }).allowed, true);
    const denied = decideAccess({ config, pairing, message: { channel: 'feishu', conversationType: 'dm', sender: { id: 'u2' }, conversationId: 'c', mentioned: true } });
    assert.equal(denied.allowed, false);
    assert.equal(denied.pairingRequired, undefined);
  });

  it('asks for pairing only in pairing mode', () => {
    const config = baseConfig({ dmPolicy: 'pairing' });
    const denied = decideAccess({ config, pairing, message: { channel: 'feishu', conversationType: 'dm', sender: { id: 'u2' }, conversationId: 'c', mentioned: true } });
    assert.equal(denied.pairingRequired, true);
  });

  it('enforces group enablement, allowlist, and mention requirement', () => {
    const message = { channel: 'feishu', conversationType: 'group', sender: { id: 'u1' }, conversationId: 'g1', mentioned: false };
    const disabled = decideAccess({ config: baseConfig({}), pairing, message });
    assert.equal(disabled.allowed, false);
    const config = baseConfig({ groups: { enabled: true, requireMention: true, allowFrom: ['g1'] } });
    assert.equal(decideAccess({ config, pairing, message: { ...message, mentioned: false } }).reason, '群内需要 @ 机器人');
    assert.equal(decideAccess({ config, pairing, message: { ...message, mentioned: true } }).allowed, true);
    assert.equal(decideAccess({ config, pairing, message: { ...message, conversationId: 'g2', mentioned: true } }).allowed, false);
  });
});
