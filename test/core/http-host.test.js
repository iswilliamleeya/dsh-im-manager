import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createHttpHost } from '../../src/core/http-host.js';

describe('http host', () => {
  it('routes exact paths, exposes the ephemeral port, and 404s unknown paths', async () => {
    const host = createHttpHost({ host: '127.0.0.1', port: 0 });
    const received = [];
    host.route('POST', '/hook', async ({ req, res, body }) => {
      received.push({ body: body.toString('utf8'), header: req.headers['x-test'] });
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
    await host.start();
    try {
      assert.ok(host.port > 0);
      const response = await fetch(`http://127.0.0.1:${host.port}/hook`, {
        method: 'POST',
        headers: { 'x-test': 'yes' },
        body: 'payload',
      });
      assert.equal(response.status, 200);
      assert.equal(await response.text(), 'ok');
      assert.deepEqual(received, [{ body: 'payload', header: 'yes' }]);

      const missing = await fetch(`http://127.0.0.1:${host.port}/nope`, { method: 'POST', body: 'x' });
      assert.equal(missing.status, 404);
      assert.match(host.publicUrl('/hook'), /^http:\/\/127\.0\.0\.1:\d+\/hook$/);
    } finally {
      await host.stop();
    }
  });

  it('rejects duplicate routes', () => {
    const host = createHttpHost({ port: 0 });
    host.route('GET', '/a', () => {});
    assert.throws(() => host.route('GET', '/a', () => {}), /duplicate HTTP route/);
  });

  it('rejects oversized bodies', async () => {
    const host = createHttpHost({ host: '127.0.0.1', port: 0, bodyLimitBytes: 8 });
    host.route('POST', '/big', ({ res }) => {
      res.end('accepted');
    });
    await host.start();
    try {
      const response = await fetch(`http://127.0.0.1:${host.port}/big`, { method: 'POST', body: 'x'.repeat(64) });
      assert.equal(response.status, 413);
    } finally {
      await host.stop();
    }
  });

  it('returns 500 when a handler throws', async () => {
    const host = createHttpHost({ host: '127.0.0.1', port: 0 });
    host.route('GET', '/boom', () => {
      throw new Error('boom');
    });
    await host.start();
    try {
      const response = await fetch(`http://127.0.0.1:${host.port}/boom`);
      assert.equal(response.status, 500);
    } finally {
      await host.stop();
    }
  });
});
