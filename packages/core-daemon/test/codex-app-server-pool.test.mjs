import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startCodexAppServer } from '../dist/adapters/codex/app-server-run.js';
import { closeCodexAppServerPool, codexPoolSize, codexAppServerPool } from '../dist/adapters/codex/app-server-pool.js';
const consume = async (run) => { const out = []; for await (const e of run.events) out.push(e); return out; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function setup(t, capacity = 2) {
  const root = await mkdtemp(join(tmpdir(), 'codex-pool-'));
  await writeFile(join(root, 'app-server'), await readFile(new URL('./fixtures/fake-codex-pool.cjs', import.meta.url)));
  const log = join(root, 'log');
  const base = { instance: { id: randomUUID(), providerId: 'codex', executable: process.execPath, baseArgs: [], models: [], capabilities: [], providerOptions: { appServerPoolSize: capacity } }, cwd: root, env: { PATH: process.env.PATH, CODEX_FAKE_LOG: log, CODEX_HOME: root }, timeoutMs: 8000 };
  const instanceIds = new Set([base.instance.id]);
  t.after(async () => { await Promise.all([...instanceIds].map((id) => closeCodexAppServerPool(id))); await rm(root, { recursive: true, force: true }); });
  return { base, run: (session, prompt, extra = {}, resume = false) => { instanceIds.add(extra.instance?.id ?? base.instance.id); return startCodexAppServer({ ...base, localSessionId: session, prompt, ...extra }, resume); }, log: async () => { try { return (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse); } catch { return []; } } };
}
async function until(check) { for (let i = 0; i < 200; i++) { if (await check()) return; await sleep(10); } throw new Error('condition timed out'); }
test('pool uses unlimited default and honors only explicit positive integer limits', () => {
  for (const value of [undefined, '3', NaN, Infinity, 0, -1, 2.5]) assert.equal(codexPoolSize(value), Infinity);
  for (const value of [1, 2, 3, 4, 5, 12]) assert.equal(codexPoolSize(value), value);
});
test('same instance/config different sessions overlap, third queues and idle LRU closes before replacement', async (t) => {
  const f = await setup(t);
  const a = f.run('a', 'slow-a'), b = f.run('b', 'slow-b'), c = f.run('c', 'fast-c');
  const all = [consume(a), consume(b), consume(c)];
  await until(async () => (await f.log()).filter((x) => x.method === 'turn/start').length === 2);
  let log = await f.log();
  assert.equal(log.filter((x) => x.done).length, 0);
  assert.equal(log.filter((x) => x.spawned).length, 2);
  const results = await Promise.all(all);
  log = await f.log();
  const third = log.findIndex((x) => x.spawned && x.pid === c.process.pid);
  assert.ok(log.slice(0, third).some((x) => x.stopped));
  assert.equal(new Set([a.process.pid, b.process.pid, c.process.pid]).size, 3);
  for (const events of results) assert.equal(events.filter((e) => e.kind === 'error').length, 0);
});
test('same session serializes and resume reuses initialized process and provider thread', async (t) => {
  const f = await setup(t);
  const a = f.run('a', 'slow-a'), first = consume(a);
  await until(async () => (await f.log()).some((x) => x.method === 'turn/start'));
  const threadId = `thread-${a.process.pid}`;
  const b = f.run('a', 'fast-b', { providerSessionId: threadId }, true), second = consume(b);
  await Promise.all([first, second]);
  const log = await f.log();
  assert.equal(a.process.pid, b.process.pid);
  assert.equal(log.filter((x) => x.method === 'initialize').length, 1);
  assert.equal(log.find((x) => x.method === 'thread/resume').params.threadId, threadId);
  assert.ok(log.findIndex((x) => x.done === 'slow-a') < log.findIndex((x) => x.method === 'turn/start' && x.params.input[0].text === 'fast-b'));
});
test('queued cancel and absolute timeout never execute or spawn; head removal admits follower', async (t) => {
  const f = await setup(t, 1);
  const a = f.run('a', 'slow-a'), first = consume(a);
  const b = f.run('b', 'forbidden-b'), second = consume(b);
  const c = f.run('c', 'forbidden-c', { timeoutMs: 30 }), third = consume(c);
  await b.cancel();
  const [_, eb, ec] = await Promise.all([first, second, third]);
  const log = await f.log();
  assert.equal(log.filter((x) => x.spawned).length, 1);
  assert.equal(log.filter((x) => x.method === 'turn/start').length, 1);
  assert.ok(ec.some((e) => e.kind === 'timeout'));
  assert.equal(b.process, undefined); assert.equal(c.process, undefined);
});
test('interrupt is acknowledged and independently cancels only its session', async (t) => {
  const f = await setup(t);
  const a = f.run('a', 'hang'), b = f.run('b', 'slow-b');
  const pa = consume(a), pb = consume(b);
  await until(async () => (await f.log()).filter((x) => x.method === 'turn/start').length === 2);
  await a.cancel();
  const [ea, eb] = await Promise.all([pa, pb]);
  assert.ok((await f.log()).some((x) => x.method === 'turn/interrupt' && x.id));
  assert.ok(eb.some((e) => e.kind === 'message' && e.text === 'done:slow-b'));
  assert.equal(b.process.child.exitCode, null);
});
test('unresponsive interrupt is bounded and does not terminate another session', async (t) => {
  const f = await setup(t);
  const a = f.run('a', 'unresponsive-hang'), b = f.run('b', 'slow-b');
  const pa = consume(a), pb = consume(b);
  await until(async () => (await f.log()).filter((x) => x.method === 'turn/start').length === 2);
  const start = Date.now(); await a.cancel();
  assert.ok(Date.now() - start < 4500);
  assert.ok((await pb).some((e) => e.kind === 'message' && e.text === 'done:slow-b'));
  await pa;
});
test('configuration change retires old active processes and rejects stale queued runs', async (t) => {
  const f = await setup(t, 1);
  const a = f.run('a', 'slow-a'), pa = consume(a);
  await until(async () => (await f.log()).some((x) => x.method === 'turn/start'));
  const stale = f.run('a', 'forbidden'), ps = consume(stale);
  const b = f.run('a', 'fast-new', { env: { ...f.base.env, NEW_CONFIG: 'yes' } }), pb = consume(b);
  const [ea, es, eb] = await Promise.all([pa, ps, pb]);
  assert.ok(ea.some((e) => e.kind === 'message' && e.text === 'done:slow-a'));
  assert.ok(es.some((e) => e.kind === 'error' && /configuration changed/.test(e.error.message)));
  const log = await f.log();
  assert.ok(log.findIndex((x) => x.stopped && x.pid === a.process.pid) < log.findIndex((x) => x.spawned && x.pid === b.process.pid));
});
test('tool and approval callbacks remain session-scoped; stale notifications cannot complete a turn', async (t) => {
  const f = await setup(t);
  let tools = 0, approvals = 0;
  const a = f.run('a', 'tools', { executeRuntimeTool: async () => { tools++; return { success: true, content: 'ok' }; }, requestInteraction: async () => { approvals++; return { outcome: 'selected', optionId: 'accept' }; } });
  const b = f.run('b', 'foreign', { executeRuntimeTool: async () => { throw new Error('foreign tool leaked'); } });
  const [ea, eb] = await Promise.all([consume(a), consume(b)]);
  assert.equal(tools, 1); assert.equal(approvals, 1);
  assert.deepEqual(eb.filter((e) => e.kind === 'message').map((e) => e.text), ['done:foreign']);
  assert.ok((await f.log()).some((x) => x.id === 'foreign-tool' && x.error?.code === -32600));
});
test('process failure is not replayed; next turn gets a fresh process', async (t) => {
  const f = await setup(t, 1);
  const a = f.run('a', 'crash'); await consume(a);
  const b = f.run('a', 'fast'); await consume(b);
  assert.notEqual(a.process.pid, b.process.pid);
  assert.equal((await f.log()).filter((x) => x.method === 'turn/start' && x.params.input[0].text === 'crash').length, 1);
});
test('iterator return releases unhealthy lease and cancellation before consuming sends no turns', async (t) => {
  const f = await setup(t, 1);
  const a = f.run('a', 'hang'); const iter = a.events[Symbol.asyncIterator]();
  assert.equal((await iter.next()).value.kind, 'session'); await iter.return();
  assert.ok(a.process.child.exitCode !== null || a.process.child.signalCode !== null);
  const b = f.run('b', 'forbidden'); await b.cancel(); await consume(b);
  assert.equal((await f.log()).filter((x) => x.method === 'turn/start').length, 0);
});

test('busy same-session waiter does not block an independent session with free capacity', async (t) => {
  const f = await setup(t);
  const a = f.run('a', 'slow-a'), pa = consume(a);
  const queued = f.run('a', 'fast-queued'), pq = consume(queued);
  const b = f.run('b', 'fast-b'), pb = consume(b);
  await Promise.all([pa, pq, pb]);
  const log = await f.log();
  assert.ok(log.findIndex((x) => x.done === 'fast-b') < log.findIndex((x) => x.done === 'slow-a'));
});
test('session-specific environment does not retire unrelated active or warm sessions', async (t) => {
  const f = await setup(t);
  const a = f.run('a', 'fast-a'), b = f.run('b', 'fast-b', { env: { ...f.base.env, SESSION_CONFIG: 'b' } });
  await Promise.all([consume(a), consume(b)]);
  const again = f.run('a', 'fast-again'); await consume(again);
  assert.equal(a.process.pid, again.process.pid);
  assert.equal(b.process.child.exitCode, null);
});

test('identical server request IDs in concurrent sessions route to their own callbacks', async (t) => {
  const f = await setup(t);
  const calls = [];
  const make = (session) => f.run(session, 'tools', {
    executeRuntimeTool: async (q) => { calls.push([session, q.arguments.pid]); return { success: true, content: session }; },
    requestInteraction: async () => ({ outcome: 'selected', optionId: 'accept' })
  });
  const a = make('a'), b = make('b'); await Promise.all([consume(a), consume(b)]);
  assert.deepEqual(calls.sort(), [['a', a.process.pid], ['b', b.process.pid]]);
  const log = await f.log();
  assert.ok(log.some((x) => x.pid === a.process.pid && x.id === 'tool' && x.result?.contentItems?.[0]?.text === 'a'));
  assert.ok(log.some((x) => x.pid === b.process.pid && x.id === 'tool' && x.result?.contentItems?.[0]?.text === 'b'));
});
test('bootstrap gates fresh spawn until initialize acknowledgement without serializing turns', async (t) => {
  const f = await setup(t);
  const a = f.run('a', 'slow-a', { env: { ...f.base.env, INIT_DELAY: '100' } });
  const b = f.run('b', 'slow-b'); await Promise.all([consume(a), consume(b)]);
  const log = await f.log();
  assert.ok(log.findIndex((x) => x.initialized && x.pid === a.process.pid) < log.findIndex((x) => x.spawned && x.pid === b.process.pid));
  assert.ok(log.findIndex((x) => x.method === 'turn/start' && x.pid === b.process.pid) < log.findIndex((x) => x.done === 'slow-a'));
});
test('timeout during unresponsive initialization closes its slot and admits another session', async (t) => {
  const f = await setup(t, 1);
  const a = f.run('a', 'forbidden', { timeoutMs: 50, env: { ...f.base.env, INIT_DELAY: '10000' } });
  const b = f.run('b', 'fast-b');
  const [ea, eb] = await Promise.all([consume(a), consume(b)]);
  assert.ok(ea.some((e) => e.kind === 'timeout'));
  assert.ok(eb.some((e) => e.kind === 'message' && e.text === 'done:fast-b'));
  assert.equal((await f.log()).filter((x) => x.method === 'turn/start').length, 1);
});
test('warm idle process expires after 60 seconds and explicit shutdown closes all slots', async (t) => {
  const f = await setup(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const a = f.run('a', 'fast'); await consume(a);
  assert.equal(a.process.child.exitCode, null);
  t.mock.timers.tick(60_000);
  await a.process.wait();
  t.mock.timers.reset();
  const b = f.run('b', 'fast'); await consume(b);
  await closeCodexAppServerPool(f.base.instance.id);
  assert.ok(b.process.child.exitCode !== null || b.process.child.signalCode !== null);
});
test('active idle timeout cancels only its lease and per-run output budget is enforced', async (t) => {
  const f = await setup(t);
  const a = f.run('a', 'hang', { idleTimeoutMs: 100 });
  const b = f.run('b', 'fast-b', { maxOutputBytes: 1 });
  const [ea, eb] = await Promise.all([consume(a), consume(b)]);
  assert.ok(ea.some((e) => e.kind === 'timeout' && e.reason === 'idle'));
  assert.ok(eb.some((e) => e.kind === 'timeout' && e.reason === 'max_output'));
});

test('configured capacity four admits four independent sessions but never a fifth live process', async (t) => {
  const f = await setup(t, 4);
  const runs = ['a', 'b', 'c', 'd', 'e'].map((s) => f.run(s, 'slow-' + s));
  const results = runs.map(consume);
  await until(async () => (await f.log()).filter((x) => x.method === 'turn/start').length === 4);
  assert.equal((await f.log()).filter((x) => x.spawned).length, 4);
  await Promise.all(results);
  let live = 0, peak = 0;
  for (const row of await f.log()) { if (row.spawned) live++; if (row.stopped) live--; peak = Math.max(peak, live); }
  assert.equal(peak, 4);
});

test('default capacity allows at least six parent/child sessions to be active together', async (t) => {
  const f = await setup(t, undefined);
  f.base.instance.providerOptions = {};
  const runs = ['parent', 'child-one', 'child-two', 'child-three', 'child-four', 'child-five'].map((s) => f.run(s, 'slow-' + s));
  const results = runs.map(consume);
  await until(async () => (await f.log()).filter((x) => x.method === 'turn/start').length === 6);
  assert.equal((await f.log()).filter((x) => x.done).length, 0);
  await Promise.all(results);
});
test('bootstrap is serialized across instances that may share HOME', async (t) => {
  const f = await setup(t);
  const a = f.run('a', 'slow-a', { env: { ...f.base.env, INIT_DELAY: '100' } });
  const b = f.run('b', 'slow-b', { instance: { ...f.base.instance, id: randomUUID() } });
  await Promise.all([consume(a), consume(b)]);
  const log = await f.log();
  assert.ok(log.findIndex((x) => x.initialized && x.pid === a.process.pid) < log.findIndex((x) => x.spawned && x.pid === b.process.pid));
});

test('transient session still uses bounded admission but is never retained warm', async (t) => {
  const f = await setup(t, 1);
  const a = f.run('a', 'slow-a'), pa = consume(a);
  const transient = startCodexAppServer({ ...f.base, localSessionId: 'bridge', prompt: 'fast-bridge' }, false, { transient: true });
  const pb = consume(transient);
  await Promise.all([pa, pb]);
  const log = await f.log();
  assert.ok(log.findIndex((x) => x.stopped && x.pid === a.process.pid) < log.findIndex((x) => x.spawned && x.pid === transient.process.pid));
  assert.ok(transient.process.child.exitCode !== null || transient.process.child.signalCode !== null);
});
test('cancellation while waiting for another instance bootstrap never spawns the cancelled CLI', async (t) => {
  const f = await setup(t);
  const a = f.run('a', 'fast-a', { env: { ...f.base.env, INIT_DELAY: '150' } }), pa = consume(a);
  const b = f.run('b', 'forbidden', { instance: { ...f.base.instance, id: randomUUID() } }), pb = consume(b);
  await b.cancel(); await Promise.all([pa, pb]);
  assert.equal((await f.log()).filter((x) => x.spawned).length, 1);
});

test('configuration changes invalidate waiters already waiting on global bootstrap', async (t) => {
  const f = await setup(t);
  const blocker = f.run('blocker', 'fast', { instance: { ...f.base.instance, id: randomUUID() }, env: { ...f.base.env, INIT_DELAY: '150' } });
  const stale = f.run('target', 'forbidden');
  const fresh = f.run('target', 'fresh', { env: { ...f.base.env, CONFIG: 'fresh' } });
  const [_, errors] = await Promise.all([consume(blocker), consume(stale), consume(fresh)]);
  assert.ok(errors.some((e) => e.kind === 'error' && /configuration changed/.test(e.error.message)));
  assert.equal((await f.log()).filter((x) => x.spawned).length, 2);
});
test('shutdown rejects a slotless bootstrap waiter without waiting for another instance', async (t) => {
  const f = await setup(t);
  const blocker = f.run('blocker', 'fast', { instance: { ...f.base.instance, id: randomUUID() }, env: { ...f.base.env, INIT_DELAY: '200' } });
  const pending = f.run('pending', 'forbidden');
  const first = consume(blocker), second = consume(pending);
  await codexAppServerPool(f.base.instance.id).shutdown();
  await Promise.race([second, sleep(100).then(() => { throw new Error('shutdown left bootstrap waiter pending'); })]);
  await first;
  assert.equal((await f.log()).filter((x) => x.spawned).length, 1);
});
test('capacity shrink while waiting for global bootstrap is rechecked before spawn', async (t) => {
  const f = await setup(t, 4);
  const first = f.run('first', 'slow-first'), p1 = consume(first);
  await until(async () => (await f.log()).some((x) => x.method === 'turn/start'));
  const blocker = f.run('blocker', 'fast', { instance: { ...f.base.instance, id: randomUUID() }, env: { ...f.base.env, CODEX_HOME: f.base.cwd + '/cold', INIT_DELAY: '150' } }), p0 = consume(blocker);
  const waiting = f.run('waiting', 'fast-waiting', { env: { ...f.base.env, CODEX_HOME: f.base.cwd + '/cold' } }), p2 = consume(waiting);
  const shrink = f.run('shrink', 'fast-shrink', { instance: { ...f.base.instance, providerOptions: { appServerPoolSize: 1 } } }), p3 = consume(shrink);
  await Promise.all([p0, p1, p2, p3]);
  const log = await f.log();
  assert.ok(log.findIndex((x) => x.stopped && x.pid === first.process.pid) < log.findIndex((x) => x.spawned && x.pid === waiting.process.pid));
});

test('different cold HOME directories initialize independently in the same instance', async (t) => {
  const f = await setup(t);
  const a = f.run('a', 'fast', { env: { ...f.base.env, INIT_DELAY: '150' } });
  const b = f.run('b', 'fast', { env: { ...f.base.env, CODEX_HOME: f.base.cwd + '/other-home', INIT_DELAY: '150' } });
  await Promise.all([consume(a), consume(b)]);
  const log = await f.log();
  const firstInit = log.findIndex((x) => x.initialized);
  assert.equal(log.slice(0, firstInit).filter((x) => x.spawned).length, 2);
});
test('warm HOME permits concurrent initialization of new independent session processes', async (t) => {
  const f = await setup(t, 4);
  await consume(f.run('warmup', 'fast'));
  const a = f.run('a', 'fast', { env: { ...f.base.env, INIT_DELAY: '150' } });
  const b = f.run('b', 'fast', { env: { ...f.base.env, INIT_DELAY: '150' } });
  await Promise.all([consume(a), consume(b)]);
  const log = await f.log();
  assert.ok(log.findIndex((x) => x.spawned && x.pid === b.process.pid) < log.findIndex((x) => x.initialized && x.pid === a.process.pid));
});

test('opaque HOME bootstrap cache expires after idle TTL and safely restores a cold gate', async (t) => {
  const f = await setup(t, 4);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const warm = f.run('warmup', 'fast'); await consume(warm);
  t.mock.timers.tick(60_000);
  await warm.process.wait();
  t.mock.timers.reset();
  const a = f.run('a', 'fast', { env: { ...f.base.env, INIT_DELAY: '150' } });
  const b = f.run('b', 'fast');
  await Promise.all([consume(a), consume(b)]);
  const log = await f.log();
  assert.ok(log.findIndex((x) => x.initialized && x.pid === a.process.pid) < log.findIndex((x) => x.spawned && x.pid === b.process.pid));
});
test('relative and absolute expressions of the same effective HOME share the cold gate', async (t) => {
  const f = await setup(t);
  const a = f.run('a', 'fast', { env: { ...f.base.env, CODEX_HOME: './same-home', INIT_DELAY: '150' } });
  const b = f.run('b', 'fast', { env: { ...f.base.env, CODEX_HOME: join(f.base.cwd, 'same-home') } });
  await Promise.all([consume(a), consume(b)]);
  const log = await f.log();
  assert.ok(log.findIndex((x) => x.initialized && x.pid === a.process.pid) < log.findIndex((x) => x.spawned && x.pid === b.process.pid));
});
