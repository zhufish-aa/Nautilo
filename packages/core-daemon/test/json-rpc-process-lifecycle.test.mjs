import test from 'node:test';
import assert from 'node:assert/strict';
import { JsonRpcProcessClient } from '../dist/adapters/json-rpc-process.js';
import { AsyncQueue } from '../dist/adapters/async-queue.js';
import { ProcessRuntime } from '../dist/process-runtime.js';

function fake(write) {
  const events = new AsyncQueue();
  const sent = [];
  const client = new JsonRpcProcessClient({ events, write: (line) => { sent.push(JSON.parse(line)); write?.(line, events); } });
  return { client, events, sent };
}
async function drained(client) { for await (const _event of client) {} }

test('JSON-RPC close rejects existing requests and new requests without writing', async () => {
  const { client, events, sent } = fake();
  const first = assert.rejects(client.request('before'), /process closed/);
  events.close();
  await first;
  await drained(client);
  const count = sent.length;
  await assert.rejects(client.request('after'), /process closed/);
  assert.equal(sent.length, count);
  assert.equal(client.pending.size, 0);
});

test('JSON-RPC natural child exit rejects requests after the pump has closed', async (t) => {
  const process = new ProcessRuntime().start({ command: globalThis.process.execPath, args: ['-e', 'process.exit(0)'], env: {} });
  t.after(() => process.cancel());
  const client = new JsonRpcProcessClient(process);
  await drained(client);
  await assert.rejects(client.request('thread/start', {}), /process closed/);
});

test('JSON-RPC closes every concurrent pending request exactly once', async () => {
  const { client, events } = fake();
  const settled = Promise.allSettled(Array.from({ length: 100 }, (_, i) => client.request('concurrent', { i })));
  events.close();
  const results = await settled;
  assert.equal(results.length, 100);
  assert.ok(results.every((value) => value.status === 'rejected' && /process closed/.test(value.reason.message)));
  assert.equal(client.pending.size, 0);
});

test('JSON-RPC synchronous write and serialization failures reject without retaining pending requests', async () => {
  let fail = true;
  const { client, events } = fake((line, output) => {
    if (fail) throw new Error('write failed');
    const q = JSON.parse(line);
    output.push({ kind: 'stdout', text: JSON.stringify({ id: q.id, result: { ok: true } }) + '\n' });
  });
  await assert.rejects(client.request('broken-write'), /write failed/);
  assert.equal(client.pending.size, 0);
  await assert.rejects(client.request('broken-json', { value: 1n }), /BigInt/);
  assert.equal(client.pending.size, 0);
  fail = false;
  assert.deepEqual(await client.request('healthy'), { ok: true });
  assert.equal(client.pending.size, 0);
  events.close();
  await drained(client);
});

test('JSON-RPC notification and server-response shapes are unchanged', async () => {
  const { client, events, sent } = fake();
  client.notify('initialized', {});
  client.respond('server-request', { accepted: true });
  client.respondError('bad-request', -32600, 'invalid');
  assert.deepEqual(sent, [
    { jsonrpc: '2.0', method: 'initialized', params: {} },
    { jsonrpc: '2.0', id: 'server-request', result: { accepted: true } },
    { jsonrpc: '2.0', id: 'bad-request', error: { code: -32600, message: 'invalid' } }
  ]);
  events.close();
  await drained(client);
});
