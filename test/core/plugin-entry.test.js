import assert from 'node:assert/strict';
import { test } from 'node:test';

test('package main exposes the DSH host plugin surface lazily', async () => {
  const module = await import('../../src/index.js');
  assert.equal(module.name, 'im-manager');
  assert.deepEqual(module.inject, ['tools']);
  assert.equal(typeof module.apply, 'function');
  // Standalone imports must stay free of host-only packages: apply() is the
  // only path that loads src/dsh-plugin.js (which imports in-box packages).
  assert.equal(typeof module.createGateway, 'function');
  assert.equal(typeof module.loadConfig, 'function');
});
