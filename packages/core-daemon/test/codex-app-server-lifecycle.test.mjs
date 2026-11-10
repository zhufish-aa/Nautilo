import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startCodexAppServer } from '../dist/adapters/codex/app-server-run.js';

async function setup(t, prompt = 'fast', extra = {}) {
  const root = await mkdtemp(join(tmpdir(), 'nautilo-codex-lifecycle-'));
  await writeFile(join(root, 'app-server'), await readFile(new URL('./fixtures/fake-codex-queue.cjs', import.meta.url)));
  const logPath = join(root, 'rpc.ndjson');
  t.after(() => rm(root, { recursive: true, force: true }));
  const request = {
    instance: { id: 'same-instance', providerId: 'codex', executable: process.execPath, baseArgs: [], models: [], capabilities: [] },
    cwd: root, prompt, env: { PATH: process.env.PATH, CODEX_FAKE_LOG: logPath }, timeoutMs: 5000, ...extra
  };
  const run = startCodexAppServer(request, false);
  t.after(() => run.cancel());
  return { run, request, readLog: async () => (await readFile(logPath, 'utf8')).trim().split('\n').map(JSON.parse) };
}
const consume = async (run) => { const events = []; for await (const event of run.events) events.push(event); return events; };
const untilStarted = async (iterator) => {
  while (true) {
    const next = await iterator.next();
    assert.equal(next.done, false);
    if (next.value.kind === 'status' && next.value.phase === 'turn_started') return;
  }
};

test('Codex fallback isolates foreign/stale notifications and rejects unrelated tool requests', async (t) => {
  let tools = 0;
  const { run, readLog } = await setup(t, 'foreign', { executeRuntimeTool: async () => { tools++; return { success: true, content: 'unsafe' }; } });
  const events = await consume(run);
  assert.equal(tools, 0);
  assert.deepEqual(events.filter((e) => e.kind === 'message').map((e) => e.text), ['done:foreign']);
  assert.equal(events.filter((e) => e.kind === 'exit').length, 1);
  for (const id of ['foreign-tool', 'stale-tool']) assert.ok((await readLog()).some((q) => q.id === id && q.error?.code === -32600));
});

test('Codex fallback iterator return closes its per-run CLI before a turn starts', async (t) => {
  const { run, readLog } = await setup(t, 'hang');
  const iterator = run.events[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value.kind, 'session');
  await iterator.return();
  assert.notEqual(run.process.child.exitCode ?? run.process.child.signalCode, null);
  assert.equal((await readLog()).filter((q) => q.method === 'turn/start').length, 0);
});

test('Codex fallback cancellation before iteration never starts a later turn', async (t) => {
  const { run } = await setup(t, 'hang');
  await run.cancel();
  assert.deepEqual(await consume(run), []);
});

test('Codex fallback parallel sessions use independent CLIs and cancelling one preserves the other', async (t) => {
  const first = await setup(t, 'hang');
  const second = await setup(t, 'slow');
  assert.notEqual(first.run.process.pid, second.run.process.pid);
  const firstIterator = first.run.events[Symbol.asyncIterator]();
  const secondEvents = consume(second.run);
  await untilStarted(firstIterator);
  await first.run.cancel();
  await firstIterator.return();
  const events = await secondEvents;
  assert.ok(events.some((e) => e.kind === 'message' && e.text === 'done:slow'));
  assert.equal(events.filter((e) => e.kind === 'error').length, 0);
});


test('Codex fallback cancellation while paused at session yield cannot register a closed-RPC turn', async (t) => {
  const { run, readLog } = await setup(t, 'hang');
  const iterator = run.events[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value.kind, 'session');
  await run.cancel();
  const result = await Promise.race([
    iterator.next(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('cancelled iterator remained pending')), 350))
  ]);
  assert.equal(result.done, true);
  assert.equal((await readLog()).filter((q) => q.method === 'turn/start').length, 0);
});
