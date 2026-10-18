/**
 * Unit tests for the newline-delimited JSON-RPC transport (in-memory streams).
 * The cross-process bridge behaviour is covered by the other test/bridge files.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';

import { JsonRpcLineTransport, JsonRpcResponseError } from '../../src/bridge/jsonrpc.js';
import { waitFor } from '../support/fake-dsh-runtime.js';

/**
 * Read one newline-delimited JSON frame from `stream`.
 *
 * @param {import('node:stream').Readable} stream
 * @returns {() => Promise<any>}
 */
function frameReader(stream) {
  /** @type {any[]} */
  const frames = [];
  /** @type {((frame: any) => void)[]} */
  const waiters = [];
  let buffer = '';
  stream.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line.length > 0) frames.push(JSON.parse(line));
    }
    while (waiters.length > 0 && frames.length > 0) waiters.shift()(frames.shift());
  });
  return () =>
    new Promise((resolve, reject) => {
      if (frames.length > 0) {
        resolve(frames.shift());
        return;
      }
      const timer = setTimeout(() => reject(new Error('timed out waiting for a JSON-RPC frame')), 2000);
      waiters.push((frame) => {
        clearTimeout(timer);
        resolve(frame);
      });
    });
}

/** Create a transport wired to two PassThroughs plus a frame reader for its writes. */
function createHarness() {
  const incoming = new PassThrough();
  const outgoing = new PassThrough();
  const transport = new JsonRpcLineTransport(incoming, outgoing);
  transport.start();
  return { incoming, outgoing, transport, readFrame: frameReader(outgoing) };
}

test('sends requests and resolves with the matching response result', async () => {
  const { incoming, transport, readFrame } = createHarness();
  const pending = transport.request('session/prompt', { sessionId: 's1' });
  const frame = await readFrame();
  assert.equal(frame.jsonrpc, '2.0');
  assert.equal(frame.method, 'session/prompt');
  assert.deepEqual(frame.params, { sessionId: 's1' });
  assert.equal(typeof frame.id, 'string');

  incoming.write(`${JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: { messageId: 'm1' } })}\n`);
  assert.deepEqual(await pending, { messageId: 'm1' });
  assert.equal(transport.pendingCount, 0);
  transport.close();
});

test('rejects requests answered with a JSON-RPC error frame', async () => {
  const { incoming, transport, readFrame } = createHarness();
  const pending = transport.request('session/prompt', {});
  const frame = await readFrame();
  incoming.write(
    `${JSON.stringify({
      jsonrpc: '2.0',
      id: frame.id,
      error: { code: -32001, message: 'nope', data: { reason: 'test' } },
    })}\n`,
  );
  await assert.rejects(pending, (error) => {
    assert.ok(error instanceof JsonRpcResponseError);
    assert.equal(error.name, 'JsonRpcResponseError');
    assert.equal(error.code, -32001);
    assert.equal(error.message, 'nope');
    assert.deepEqual(error.data, { reason: 'test' });
    return true;
  });
  transport.close();
});

test('dispatches notifications and ignores malformed lines', async () => {
  const { incoming, transport } = createHarness();
  /** @type {{ method: string, params: any }[]} */
  const notifications = [];
  /** @type {{ line: string, error: Error }[]} */
  const malformed = [];
  transport.onNotification((method, params) => notifications.push({ method, params }));
  transport.onMalformedLine((line, error) => malformed.push({ line, error }));

  incoming.write('this is not json\n');
  incoming.write('\n');
  incoming.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'session.status', params: { sessionId: 's1', status: 'idle' } })}\n`);

  await waitFor(() => notifications.length === 1, { description: 'notification dispatch' });
  assert.deepEqual(notifications[0], {
    method: 'session.status',
    params: { sessionId: 's1', status: 'idle' },
  });
  assert.equal(malformed.length, 1);
  assert.equal(malformed[0].line, 'this is not json');
  transport.close();
});

test('answers incoming requests through the request handler', async () => {
  const { incoming, transport, readFrame } = createHarness();
  transport.onRequest(async (method, params) => {
    assert.equal(method, 'ping');
    return { echo: params.value };
  });
  incoming.write(`${JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'ping', params: { value: 'hi' } })}\n`);
  const response = await readFrame();
  assert.equal(response.id, 99);
  assert.deepEqual(response.result, { echo: 'hi' });
  transport.close();
});

test('answers incoming requests with -32603 when the handler throws', async () => {
  const { incoming, transport, readFrame } = createHarness();
  transport.onRequest(() => {
    throw new Error('handler exploded');
  });
  incoming.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'r1', method: 'bad', params: {} })}\n`);
  const response = await readFrame();
  assert.equal(response.id, 'r1');
  assert.equal(response.error.code, -32603);
  assert.equal(response.error.message, 'handler exploded');
  transport.close();
});

test('buffers partial and multi-frame chunks', async () => {
  const { incoming, transport, readFrame } = createHarness();
  const first = transport.request('a', {});
  const frameA = await readFrame();
  // Respond to the first request across two chunks split mid-JSON.
  const response = `${JSON.stringify({ jsonrpc: '2.0', id: frameA.id, result: 'done' })}\n`;
  incoming.write(response.slice(0, 10));
  await new Promise((resolve) => setImmediate(resolve));
  incoming.write(response.slice(10));
  assert.equal(await first, 'done');
  transport.close();
});

test('close() rejects in-flight requests', async () => {
  const { transport } = createHarness();
  const pending = transport.request('never', {});
  assert.equal(transport.pendingCount, 1);
  transport.close();
  await assert.rejects(pending, /JSON-RPC transport closed/);
  assert.equal(transport.pendingCount, 0);
});

test('rejects an aborted request and drops it from the pending table', async () => {
  const { transport } = createHarness();
  const controller = new AbortController();
  const pending = transport.request('slow', {}, controller.signal);
  assert.equal(transport.pendingCount, 1);
  controller.abort(new Error('user aborted'));
  await assert.rejects(pending, /user aborted/);
  assert.equal(transport.pendingCount, 0);
  transport.close();
});
