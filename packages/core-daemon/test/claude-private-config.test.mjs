import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat, access, mkdtemp, mkdir, writeFile, utimes, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { privateClaudeConfig, cleanupStaleClaudeConfigs } from '../dist/adapters/claude/private-config.js';
import { ClaudeCodeAdapter } from '../dist/adapters/claude/adapter.js';
const secret = 'synthetic-api-secret', mcpSecret = 'synthetic-mcp-secret';
const request = { instance: { id: 'claude', providerId: 'claude-code', executable: 'claude', baseArgs: [], capabilities: [] }, prompt: 'hello', cwd: process.cwd(), env: { ANTHROPIC_API_KEY: secret }, mcpServers: [{ name: 'private', transport: 'http', url: 'https://example.invalid/mcp', headers: { Authorization: mcpSecret } }] };

test('private generated configs hide secrets from argv and have owner-only Unix permissions', async () => {
  const input = ['--settings', JSON.stringify({ env: { ANTHROPIC_API_KEY: secret } }), '--mcp-config', JSON.stringify({ mcpServers: { private: { env: { TOKEN: mcpSecret } } } }), 'prompt'];
  const config = await privateClaudeConfig(input);
  try {
    assert.ok(!config.args.join(' ').includes(secret)); assert.ok(!config.args.join(' ').includes(mcpSecret));
    assert.equal(await readFile(config.args[1], 'utf8'), input[1]);
    assert.equal(await readFile(config.args[3], 'utf8'), input[3]);
    if (process.platform !== 'win32') {
      assert.equal((await stat(config.args[1])).mode & 0o777, 0o600);
      assert.equal((await stat(dirname(config.args[1]))).mode & 0o777, 0o700);
    }
  } finally { await config.cleanup(); }
  await assert.rejects(access(config.args[1])); await config.cleanup();
});

for (const mode of ['complete', 'error', 'throw', 'resume']) test(`Claude ${mode} launch passes paths only and removes config files`, async () => {
  const adapter = new ClaudeCodeAdapter(); let captured;
  adapter.runtime = { start: (input) => {
    captured = input;
    if (mode === 'throw') throw new Error('spawn failed');
    return { child: { stdin: { end() {} } }, cancel: async () => {}, events: { async *[Symbol.asyncIterator]() { yield mode === 'error' ? { kind: 'error', error: new Error('process failure') } : { kind: 'exit', exitCode: 0 }; } } };
  } };
  const run = mode === 'resume' ? adapter.resume({ ...request, providerSessionId: 'existing' }) : adapter.start(request);
  for await (const _event of run.events) {}
  assert.ok(captured); assert.ok(!captured.args.join(' ').includes(secret)); assert.ok(!captured.args.join(' ').includes(mcpSecret));
  for (const flag of ['--settings', '--mcp-config']) { const file = captured.args[captured.args.indexOf(flag) + 1]; await assert.rejects(access(file)); }
});

test('cancel during execution removes private files, and cancel before iteration never launches', async () => {
  const adapter = new ClaudeCodeAdapter(); let captured, startedResolve, endResolve;
  const started = new Promise((resolve) => { startedResolve = resolve; });
  const ended = new Promise((resolve) => { endResolve = resolve; });
  adapter.runtime = { start: (input) => { captured = input; startedResolve(); return { child: { stdin: { end() {} } }, cancel: async () => endResolve(), events: { async *[Symbol.asyncIterator]() { await ended; yield { kind: 'exit', exitCode: 0 }; } } }; } };
  const run = adapter.start(request); const pumping = (async () => { for await (const _event of run.events) {} })();
  await started; await run.cancel(); await pumping;
  await assert.rejects(access(captured.args[captured.args.indexOf('--settings') + 1]));
  let launched = false; adapter.runtime = { start: () => { launched = true; } };
  const early = adapter.start(request); await early.cancel(); for await (const _event of early.events) {}
  assert.equal(launched, false);
});

test('malformed generated JSON fails closed; prompts and explicit file paths are untouched', async () => {
  await assert.rejects(privateClaudeConfig(['--settings', '{invalid', 'prompt']));
  const args = ['--settings', '/private/settings.json', '--mcp-config'];
  const config = await privateClaudeConfig(args); assert.deepEqual(config.args, args); await config.cleanup();
});

test('concurrent runs get separate private directories and clean up independently', async () => {
  const input = ['--settings', JSON.stringify({ env: { ANTHROPIC_API_KEY: secret } }), 'prompt'];
  const [first, second] = await Promise.all([privateClaudeConfig(input), privateClaudeConfig(input)]);
  assert.notEqual(dirname(first.args[1]), dirname(second.args[1]));
  await first.cleanup();
  assert.ok((await readFile(second.args[1], 'utf8')).includes(secret));
  await second.cleanup();
});

test('interrupted event consumption closes the process and removes config', async () => {
  const adapter = new ClaudeCodeAdapter(); let captured, cancelled = false;
  adapter.runtime = { start: (input) => { captured = input; return { child: { stdin: { end() {} } }, cancel: async () => { cancelled = true; }, events: { async *[Symbol.asyncIterator]() { yield { kind: 'exit', exitCode: 0 }; } } }; } };
  const run = adapter.start(request);
  for await (const _event of run.events) { break; }
  assert.equal(cancelled, true);
  await assert.rejects(access(captured.args[captured.args.indexOf('--settings') + 1]));
});

test('stale cleanup removes only old marked runs with both processes definitely dead', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'nautilo-cleanup-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const old = new Date(Date.now() - 2 * 86400_000);
  async function fixture({ parent = 99991, child = 99992, age = old, extra = false, link = false } = {}) {
    const dir = join(root, `${parent}-${randomUUID()}`); await mkdir(dir, { mode: 0o700 });
    await writeFile(join(dir, '.nautilo-run.json'), JSON.stringify({ magic: 'nautilo-private-claude-v1', parentPid: parent, childPid: child }));
    await writeFile(join(dir, 'config-1.json'), 'synthetic-secret');
    if (extra) await writeFile(join(dir, 'user-notes.txt'), 'keep');
    if (link && process.platform !== 'win32') await symlink('/nonexistent', join(dir, 'config-2.json'));
    await utimes(dir, age, age); return dir;
  }
  const reclaim = await fixture(), liveParent = await fixture({ parent: process.pid }), liveChild = await fixture({ child: process.pid }), unknownChild = await fixture({ child: null }), young = await fixture({ age: new Date() }), extra = await fixture({ extra: true });
  const linked = process.platform !== 'win32' ? await fixture({ link: true }) : undefined;
  await cleanupStaleClaudeConfigs(root, Date.now(), (pid) => pid === 99991 || pid === 99992);
  await assert.rejects(access(reclaim));
  for (const dir of [liveParent, liveChild, unknownChild, young, extra, linked].filter(Boolean)) await access(dir);
});
