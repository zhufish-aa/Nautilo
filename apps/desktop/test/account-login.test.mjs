import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import ts from 'typescript';
const require = createRequire(import.meta.url);
const source = await readFile(new URL('../src/main/account-login.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
function load() {
  const handlers = {}, children = [], calls = [];
  const imports = { './account-profile': { prepareAccountProfile: async () => ({ profileId: 'managed', directory: '/managed' }) }, electron: { ipcMain: { handle: (name, fn) => { handlers[name] = fn; } } }, 'node:fs/promises': { mkdir: async () => {}, realpath: async (path) => path }, 'node:child_process': { spawn: (...args) => { calls.push(args); const child = new EventEmitter(); child.kill = () => { child.killed = true; }; children.push(child); return child; } } };
  const module = { exports: {} };
  new Function('require', 'module', 'exports', compiled)((name) => name === './antigravity-login' ? { authenticateAntigravity: () => Promise.reject(new Error('not exercised here')) } : imports[name] ?? require(name), module, module.exports);
  module.exports.registerAccountLoginHandlers();
  return { ...module.exports, handlers, children, calls };
}
const input = { profileId: 'one', providerId: 'codex', executable: 'codex', directory: resolve('/tmp/test-account') };
const event = () => ({ sender: new EventEmitter() });
test('official login is shell-free, fixed-argument, and never exposes auth output', async () => {
  const f = load();
  const result = await f.handlers['account:login-start'](event(), input);
  assert.deepEqual(result, { ok: true });
  assert.equal(f.calls[0][2].shell, false); assert.equal(f.calls[0][2].stdio, 'ignore');
  assert.deepEqual(f.calls[0][1], ['login']); assert.equal(f.calls[0][2].env.CODEX_HOME, input.directory);
  f.children[0].emit('exit', 0);
  assert.deepEqual(f.handlers['account:login-status']({}, input.profileId), { state: 'succeeded' });
});
test('double clicks and simultaneous directory logins are rejected, cancellation wins over exit', async () => {
  const f = load();
  const results = await Promise.all([f.handlers['account:login-start'](event(), input), f.handlers['account:login-start'](event(), input)]);
  assert.equal(results.filter((result) => result.ok).length, 1); assert.equal(f.calls.length, 1);
  assert.equal((await f.handlers['account:login-start'](event(), { ...input, profileId: 'two' })).ok, false);
  f.handlers['account:login-cancel']({}, input.profileId);
  f.children[0].emit('exit', 0);
  assert.equal(f.children[0].killed, true); assert.equal(f.handlers['account:login-status']({}, input.profileId).state, 'cancelled');
});
test('only supported native CLI profiles can launch', () => {
  const f = load();
  for (const patch of [{ executable: 'codex.cmd' }, { executable: 'x.bat' }, { providerId: 'kimi' }, { directory: 'relative' }, { directory: '/tmp/a\n' }]) assert.throws(() => f.loginInvocation({ ...input, ...patch }));
  assert.deepEqual(f.loginInvocation({ ...input, providerId: 'claude-code', executable: 'claude' }).args, ['auth', 'login']);
});
test('closing renderer cancels active login and process errors do not leak output', async () => {
  const f = load(), sender = event();
  await f.handlers['account:login-start'](sender, input);
  sender.sender.emit('destroyed');
  assert.equal(f.children[0].killed, true); assert.equal(f.handlers['account:login-status']({}, input.profileId).state, 'running');
  assert.equal((await f.handlers['account:login-start'](event(), { ...input, profileId: 'other' })).ok, false);
  f.children[0].emit('exit', null);
  assert.equal(f.handlers['account:login-status']({}, input.profileId).state, 'cancelled');
  await f.handlers['account:login-start'](event(), input);
  f.children[1].emit('error', new Error('secret-sensitive-output'));
  assert.equal(f.handlers['account:login-status']({}, input.profileId).state, 'failed');
  assert.ok(!f.handlers['account:login-status']({}, input.profileId).reason.includes('secret'));
});

test('failed or delayed termination keeps the account directory locked until actual exit', async () => {
  const f = load(); await f.handlers['account:login-start'](event(), input);
  f.children[0].pid = 12345; f.children[0].kill = () => false;
  f.handlers['account:login-cancel']({}, input.profileId);
  f.children[0].emit('error', new Error('termination denied'));
  assert.equal(f.handlers['account:login-status']({}, input.profileId).state, 'running');
  assert.equal((await f.handlers['account:login-start'](event(), { ...input, profileId: 'two' })).ok, false);
  f.children[0].emit('exit', null);
  assert.equal(f.handlers['account:login-status']({}, input.profileId).state, 'cancelled');
  assert.equal((await f.handlers['account:login-start'](event(), { ...input, profileId: 'two' })).ok, true);
  f.children[1].emit('exit', 0);
});

test('Claude login pins both CLI and Anthropic profile roots without changing HOME', () => {
  const f = load();
  const invocation = f.loginInvocation({ ...input, providerId: 'claude-code', executable: 'claude' });
  assert.equal(invocation.env.CLAUDE_CONFIG_DIR, input.directory);
  assert.equal(invocation.env.ANTHROPIC_CONFIG_DIR, require('node:path').join(input.directory, 'anthropic'));
  if (process.env.HOME) assert.equal(invocation.env.HOME, process.env.HOME);
  assert.equal(invocation.env.ANTHROPIC_PROFILE, undefined);
});

test('Antigravity sign-in uses official ACP without spoofing an isolated keyring', () => {
  const invocation = load().loginInvocation({ ...input, providerId:'antigravity', executable:'agy.exe' });
  assert.deepEqual(invocation.args,['acp']);
  for (const key of ['CODEX_HOME','CLAUDE_CONFIG_DIR','GEMINI_API_KEY','GOOGLE_API_KEY','AGY_ADC_AUTH']) assert.equal(invocation.env[key],undefined);
  if(process.env.USERPROFILE) assert.equal(invocation.env.USERPROFILE,process.env.USERPROFILE);
});
