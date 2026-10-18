import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadAdapter } from '../../src/adapters/registry.js';

// Adapters are stateful (`started`, sockets, counters). The manager runs one
// gateway per workspace in one process, so every load MUST return a fresh
// instance. Regression: feishu/wecom used their default singleton export, which
// made the second workspace fail with "adapter already started".
for (const id of ['feishu', 'dingtalk', 'wecom', 'weixin']) {
  test(`loadAdapter(${id}) returns isolated instances`, async () => {
    const first = await loadAdapter(id);
    const second = await loadAdapter(id);
    assert.equal(first.id, id);
    assert.notEqual(first, second, `${id} adapter must not be a shared singleton`);
    assert.equal(typeof first.start, 'function');
    assert.equal(typeof second.send, 'function');
  });
}
