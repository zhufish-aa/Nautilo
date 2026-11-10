import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, stat, lstat, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';
const require = createRequire(import.meta.url);
const source = await readFile(new URL('../src/renderer/src/features/settings/account-connect.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { connectOfficialAccount } = await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(compiled)}`);
function fixture(patch = {}) {
  const calls = [];
  const deps = { detect: async (id) => { calls.push(['detect', id]); return id; }, prepare: async (id) => { calls.push(['prepare', id]); return { profileId: 'account-one', directory: '/managed/one' }; }, start: async (input) => { calls.push(['start', input]); return { ok: true }; }, status: async () => ({ state: 'succeeded' }), cancel: async (id) => { calls.push(['cancel', id]); }, save: async (value) => { calls.push(['save', value]); return { ...value, revision: 1 }; }, wait: async () => {}, ...patch };
  return { deps, calls };
}
test('choosing an account detects, allocates, starts official login and saves only after success', async () => {
  let poll = 0; const f = fixture({ status: async () => ({ state: ++poll === 1 ? 'running' : 'succeeded' }) });
  const stages = []; const saved = await connectOfficialAccount('codex', 'Codex account', new AbortController().signal, (s) => stages.push(s), f.deps);
  assert.deepEqual(stages, ['detecting', 'preparing', 'login', 'saving']);
  assert.deepEqual(f.calls.map(x => x[0]), ['detect', 'prepare', 'start', 'save']);
  assert.equal(f.calls[2][1].directory, '/managed/one'); assert.equal(f.calls[2][1].profileId, 'account-one:/managed/one');
  assert.equal(saved.id, 'account-one'); assert.equal(saved.loginProfileDirectory, '/managed/one'); assert.equal(saved.kind, 'login'); assert.equal(saved.apiKey, undefined);
});
for (const state of ['failed', 'cancelled', 'idle']) test(`official ${state} status never creates a fake account`, async () => {
  const f = fixture({ status: async () => ({ state, reason: 'not completed' }) });
  await assert.rejects(connectOfficialAccount('claude-code', 'Claude', new AbortController().signal, () => {}, f.deps), /not completed/);
  assert.ok(!f.calls.some(x => x[0] === 'save')); assert.equal(f.calls.at(-1)[0], 'cancel');
});
test('closing during preparation cancels the allocated job without launching or saving', async () => {
  const abort = new AbortController(); const f = fixture({ prepare: async () => { abort.abort(); return { profileId: 'account-one', directory: '/managed/one' }; } });
  await assert.rejects(connectOfficialAccount('codex', 'A', abort.signal, () => {}, f.deps), { name: 'AbortError' });
  assert.ok(!f.calls.some(x => x[0] === 'start' || x[0] === 'save')); assert.equal(f.calls.at(-1)[0], 'cancel');
});
test('failed native startup and cancelled running flow never save a connection', async () => {
  const f = fixture({ start: async () => ({ ok: false, reason: 'native executable required' }) });
  await assert.rejects(connectOfficialAccount('codex', 'A', new AbortController().signal, () => {}, f.deps), /native executable/);
  assert.ok(!f.calls.some(x => x[0] === 'save'));
  const abort = new AbortController(); const running = fixture({ status: async () => { abort.abort(); return { state: 'running' }; } });
  await assert.rejects(connectOfficialAccount('codex', 'B', abort.signal, () => {}, running.deps), { name: 'AbortError' });
  assert.ok(!running.calls.some(x => x[0] === 'save')); assert.equal(running.calls.at(-1)[0], 'cancel');
});
test('profile allocator makes separate protected directories without accepting caller paths', async (t) => {
  const src = await readFile(new URL('../src/main/account-profile.ts', import.meta.url), 'utf8');
  const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} }; new Function('require', 'module', 'exports', js)(require, module, module.exports);
  const base = await mkdtemp(join(tmpdir(), 'account-profile-test-')); t.after(() => rm(base, { recursive: true, force: true }));
  const first = await module.exports.prepareAccountProfile(base, 'codex'), second = await module.exports.prepareAccountProfile(base, 'codex');
  assert.notEqual(first.directory, second.directory); assert.ok(first.directory.startsWith(join(base, 'account-profiles')));
  if (process.platform !== 'win32') assert.equal((await stat(first.directory)).mode & 0o777, 0o700); assert.equal((await lstat(first.directory)).isSymbolicLink(), false);
  await assert.rejects(module.exports.prepareAccountProfile(base, '../other'));
  const linkBase = join(base, 'linked'); await mkdir(linkBase); await symlink(join(base, 'account-profiles'), join(linkBase, 'account-profiles'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(module.exports.prepareAccountProfile(linkBase, 'codex'), /regular directory/);
});

test('failed saves keep the completed profile recoverable; retry saves the same id without another login', async () => {
  const f = fixture({ save: async () => { throw new Error('save unavailable'); } });
  await assert.rejects(connectOfficialAccount('codex', 'A', new AbortController().signal, () => {}, f.deps), /save unavailable/);
  assert.ok(!f.calls.some(x => x[0] === 'cancel'), 'a completed login is not erased on save failure');
  const recovered = fixture({ reusePrepared: true }); let attached;
  recovered.deps.acknowledge = async (profileId, providerId) => { attached = { profileId, providerId }; };
  const saved = await connectOfficialAccount('codex', 'A', new AbortController().signal, () => {}, recovered.deps);
  assert.equal(saved.id, 'account-one'); assert.equal(saved.loginProfileDirectory, '/managed/one');
  assert.ok(!recovered.calls.some(x => x[0] === 'start'));
  assert.deepEqual(attached, { profileId: 'account-one', providerId: 'codex' });
});

test('recovering an active or stopping process never launches another login or saves early', async () => {
  const abort = new AbortController(); let reads = 0;
  const f = fixture({ reusePrepared: true, status: async () => { if (++reads === 2) abort.abort(); return { state: 'running' }; } });
  await assert.rejects(connectOfficialAccount('codex', 'A', abort.signal, () => {}, f.deps), { name: 'AbortError' });
  assert.ok(!f.calls.some(x => x[0] === 'start' || x[0] === 'save')); assert.equal(f.calls.at(-1)[0], 'cancel');
});

test('pending records survive cancellation/save failure and attachment removes metadata only', async (t) => {
  const { writeFile, access } = await import('node:fs/promises');
  const src = await readFile(new URL('../src/main/account-profile.ts', import.meta.url), 'utf8');
  const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} }; new Function('require', 'module', 'exports', js)(require, module, module.exports);
  const base = await mkdtemp(join(tmpdir(), 'account-recovery-test-')); t.after(() => rm(base, { recursive: true, force: true }));
  const profile = await module.exports.prepareAccountProfile(base, 'claude-code');
  const authPath = join(profile.directory, '.credentials.json'); await writeFile(authPath, 'synthetic-private-fixture');
  const records = await module.exports.recoverableAccountProfiles(base);
  assert.equal(records.length, 1); assert.equal(records[0].profileId, profile.profileId);
  assert.deepEqual(Object.keys(records[0]).sort(), ['createdAt', 'directory', 'profileId', 'providerId']);
  if (process.platform !== 'win32') assert.equal((await stat(join(profile.directory, 'anthropic'))).mode & 0o777, 0o700);
  await access(authPath); // Merely listing never deletes even a potentially live profile.
  await module.exports.attachAccountProfile(base, 'claude-code', profile.profileId);
  assert.deepEqual(await module.exports.recoverableAccountProfiles(base), []);
  assert.equal(await readFile(authPath, 'utf8'), 'synthetic-private-fixture');
  await assert.rejects(module.exports.attachAccountProfile(base, 'claude-code', '../outside'));
  const replaced = await module.exports.prepareAccountProfile(base, 'claude-code');
  await rm(join(replaced.directory, 'anthropic'), { recursive: true });
  await symlink(base, join(replaced.directory, 'anthropic'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.deepEqual(await module.exports.recoverableAccountProfiles(base), [], 'recovery rejects a replaced Anthropic root');
});
