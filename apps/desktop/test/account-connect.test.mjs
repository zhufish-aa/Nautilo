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
const harnessSource = await readFile(new URL('../src/shared/account-harnesses.ts', import.meta.url), 'utf8');
const harnesses = {};
new Function('exports', ts.transpileModule(harnessSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText)(harnesses);
const profileSource = await readFile(new URL('../src/main/account-profile.ts', import.meta.url), 'utf8');
const profileModule = { exports: {} };
new Function('require', 'module', 'exports', ts.transpileModule(profileSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText)(
  id => id === '../shared/account-harnesses' ? harnesses : require(id), profileModule, profileModule.exports
);
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

test('OpenCode follows the same isolated official-login pipeline and does not save while device authorization is pending', async () => {
  let polls=0; const progress=[];
  const f=fixture({status:async()=>({state:++polls===1?'running':'succeeded',reason:'fixture device code'}),progress:reason=>progress.push(reason)});
  const saved=await connectOfficialAccount('opencode','OpenCode account',new AbortController().signal,()=>{},f.deps);
  assert.deepEqual(f.calls.map(call=>call[0]),['detect','prepare','start','save']);
  assert.equal(f.calls[2][1].providerId,'opencode');
  assert.equal(saved.nativeLogin,true); assert.equal(saved.loginProfileDirectory,'/managed/one');
  assert.deepEqual(progress,['fixture device code']);
  const denied=fixture({status:async()=>({state:'failed',reason:'Authorization denied'})});
  await assert.rejects(()=>connectOfficialAccount('opencode','OpenCode',new AbortController().signal,()=>{},denied.deps),/denied/);
  assert.equal(denied.calls.some(call=>call[0]==='save'),false);
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
  const module = profileModule;
  const base = await mkdtemp(join(tmpdir(), 'account-profile-test-')); t.after(() => rm(base, { recursive: true, force: true }));
  const first = await module.exports.prepareAccountProfile(base, 'codex'), second = await module.exports.prepareAccountProfile(base, 'codex');
  assert.notEqual(first.directory, second.directory); assert.ok(first.directory.startsWith(join(base, 'account-profiles')));
  const openCode=await module.exports.prepareAccountProfile(base,'opencode');
  assert.ok(openCode.directory.startsWith(join(base,'account-profiles','opencode-')));
  assert.ok((await module.exports.recoverableAccountProfiles(base)).some(profile=>profile.profileId===openCode.profileId&&profile.providerId==='opencode'));
  await module.exports.attachAccountProfile(base,'opencode',openCode.profileId);
  const kimiOne = await module.exports.prepareAccountProfile(base, 'kimi-code');
  const kimiTwo = await module.exports.prepareAccountProfile(base, 'kimi-code');
  assert.notEqual(kimiOne.directory, kimiTwo.directory);
  assert.ok((await module.exports.recoverableAccountProfiles(base)).some(profile => profile.profileId === kimiTwo.profileId));
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
  const { writeFile, access, realpath } = await import('node:fs/promises');
  const module = profileModule;
  const base = await mkdtemp(join(tmpdir(), 'account-recovery-test-')); t.after(() => rm(base, { recursive: true, force: true }));
  const profile = await module.exports.prepareAccountProfile(base, 'claude-code');
  const authPath = join(profile.directory, '.credentials.json'); await writeFile(authPath, 'synthetic-private-fixture');
  const records = await module.exports.recoverableAccountProfiles(base);
  assert.equal(records.length, 1); assert.equal(records[0].profileId, profile.profileId);
  assert.deepEqual(Object.keys(records[0]).sort(), ['createdAt', 'directory', 'profileId', 'providerId']);
  if (process.platform !== 'win32') assert.equal((await stat(join(profile.directory, 'anthropic'))).mode & 0o777, 0o700);
  await access(authPath); // Merely listing never deletes even a potentially live profile.
  await module.exports.recordAccountVerification(base, 'claude-code', `${profile.profileId}:${profile.directory}`, await realpath(profile.directory));
  await module.exports.attachAccountProfile(base, 'claude-code', profile.profileId);
  assert.deepEqual(await module.exports.recoverableAccountProfiles(base), []);
  assert.equal(await readFile(authPath, 'utf8'), 'synthetic-private-fixture');
  const verification = JSON.parse(await readFile(join(profile.directory, '.nautilo-verified-login.json'), 'utf8'));
  assert.equal(verification.providerId, 'claude-code'); assert.ok(Number.isFinite(Date.parse(verification.lastVerifiedAt)));
  assert.deepEqual(Object.keys(verification).sort(), ['lastVerifiedAt', 'providerId']);
  await assert.rejects(module.exports.attachAccountProfile(base, 'claude-code', '../outside'));
  const replaced = await module.exports.prepareAccountProfile(base, 'claude-code');
  await rm(join(replaced.directory, 'anthropic'), { recursive: true });
  await symlink(base, join(replaced.directory, 'anthropic'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.deepEqual(await module.exports.recoverableAccountProfiles(base), [], 'recovery rejects a replaced Anthropic root');
});
