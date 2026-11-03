import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { isolateLoginProfile, loginProfileDirectory } from '../dist/runtime/security/environment-policy.js';
import { AgentService } from '../dist/application/agent-service.js';
const instance = (providerId = 'codex', directory = resolve('/tmp/account-a')) => ({
  id: 'account-a', providerId, executable: providerId, baseArgs: [],
  providerOptions: { loginProfileDirectory: directory },
});

test('selected login overrides vault, allowlist and ambient API credentials without mutating inputs', () => {
  const env = { PATH: '/bin', HOME: '/home/test', OPENAI_API_KEY: 'secret', CODEX_API_KEY: 'secret', OPENAI_BASE_URL: 'https://other.invalid', CODEX_HOME: '/wrong', ANTHROPIC_AUTH_TOKEN: 'secret', CLAUDE_CODE_OAUTH_TOKEN: 'secret', CLAUDE_CODE_USE_BEDROCK: '1', AGENTHUB_API_KEY: 'secret' };
  const isolated = isolateLoginProfile(instance(), env);
  assert.deepEqual(isolated, { PATH: '/bin', HOME: '/home/test', CODEX_HOME: resolve('/tmp/account-a') });
  assert.equal(env.CODEX_HOME, '/wrong');
  assert.equal(env.OPENAI_API_KEY, 'secret');
});

test('two Codex profiles and Claude profiles get distinct explicit configuration directories', () => {
  assert.notEqual(isolateLoginProfile(instance(), {}).CODEX_HOME, isolateLoginProfile(instance('codex', resolve('/tmp/account-b')), {}).CODEX_HOME);
  assert.deepEqual(isolateLoginProfile(instance('claude-code'), { CODEX_HOME: '/wrong' }), { CLAUDE_CONFIG_DIR: resolve('/tmp/account-a'), ANTHROPIC_CONFIG_DIR: join(resolve('/tmp/account-a'), 'anthropic') });
});

test('profile-less API instances retain existing credentials', () => {
  const agent = { ...instance(), providerOptions: {} };
  assert.deepEqual(isolateLoginProfile(agent, { OPENAI_API_KEY: 'key' }), { OPENAI_API_KEY: 'key' });
});

test('invalid, unsupported and mixed-auth profiles fail closed', () => {
  for (const agent of [instance('kimi'), instance('codex', '../relative'), instance('codex', ' '), instance('codex', '/tmp/a\n'), { ...instance(), baseArgs: ['--config', 'x'] }, { ...instance(), profile: 'other' }, { ...instance(), providerOptions: { ...instance().providerOptions, baseUrl: 'https://other.invalid' } }]) {
    assert.throws(() => loginProfileDirectory(agent));
  }
});

test('existing conversations cannot silently move to another account', () => {
  let saved;
  const current = instance();
  const db = { runs: { list: () => [] }, agents: { get: () => current, save: (value) => { saved = value; } }, sessions: { listAll: () => [{ agentInstanceId: current.id }] } };
  const service = new AgentService(db, {});
  assert.throws(() => service.upsert(instance('codex', resolve('/tmp/account-b'))));
  assert.equal(saved, undefined);
  service.upsert({ ...current, providerOptions: { ...current.providerOptions, loginProfileLabel: 'Work' } });
  assert.equal(saved.providerOptions.loginProfileLabel, 'Work');
});

test('model discovery uses the selected login and suppresses saved API credentials', async () => {
  const current = instance();
  let discovered;
  const db = { agents: { list: () => [current] } };
  const adapters = {
    find: () => ({ descriptor: { credentialEnv: ['OPENAI_API_KEY'], envPassthrough: ['OPENAI_API_KEY'], baseUrlEnv: 'OPENAI_BASE_URL' } }),
    listModels: async (_instance, context) => { discovered = context.env; return { models: [], source: 'provider_cli' }; }
  };
  const credentials = { environment: () => ({ OPENAI_API_KEY: 'vault-secret' }) };
  const environment = { build: (_policy, additions) => ({ OPENAI_API_KEY: 'ambient-secret', ...additions }) };
  const result = await new AgentService(db, adapters, credentials, environment).listModels('codex', 'codex', current.id);
  assert.equal(result.source, 'provider_cli');
  assert.deepEqual(discovered, { CODEX_HOME: resolve('/tmp/account-a') });
});

test('legacy sessions with only historical run identity still prevent account changes', () => {
  const current = instance();
  const db = { agents: { get: () => current }, sessions: { listAll: () => [{ memberId: 'member-a' }] }, runs: { list: () => [{ agentInstanceId: current.id }] } };
  assert.throws(() => new AgentService(db, {}).upsert(instance('codex', resolve('/tmp/account-b'))));
});

test('Claude profile also overrides the documented global Anthropic federation configuration root', async (t) => {
  const { mkdtemp, mkdir, writeFile, rm, readdir } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const root = await mkdtemp(join(tmpdir(), 'nautilo-federation-fixture-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const globalRoot = join(root, '.config', 'anthropic');
  await mkdir(join(globalRoot, 'configs'), { recursive: true });
  await writeFile(join(globalRoot, 'configs', 'default.json'), JSON.stringify({ authentication: { type: 'oidc_federation', federation_rule_id: 'fixture-only' } }));
  const a = join(root, 'account-a'), b = join(root, 'account-b');
  await mkdir(join(a, 'anthropic'), { recursive: true }); await mkdir(join(b, 'anthropic'), { recursive: true });
  for (const directory of [a, b]) {
    const environment = isolateLoginProfile(instance('claude-code', directory), { HOME: root, APPDATA: root, ANTHROPIC_CONFIG_DIR: globalRoot, anthropic_profile: 'default', ANTHROPIC_FEDERATION_RULE_ID: 'fixture-only', ANTHROPIC_ORGANIZATION_ID: 'fixture-org' });
    assert.equal(environment.HOME, root); assert.equal(environment.APPDATA, root);
    assert.equal(environment.CLAUDE_CONFIG_DIR, directory); assert.equal(environment.ANTHROPIC_CONFIG_DIR, join(directory, 'anthropic'));
    assert.equal(environment.anthropic_profile, undefined); assert.equal(environment.ANTHROPIC_FEDERATION_RULE_ID, undefined);
    assert.deepEqual(await readdir(environment.ANTHROPIC_CONFIG_DIR), []);
  }
});

test('API connections never inherit an isolated or global Anthropic profile directory', async () => {
  const { connectionEnvironment } = await import('../dist/runtime/runtime-connection.js');
  const result = connectionEnvironment({ id: 'api', revision: 1, kind: 'api', baseUrl: 'https://api.example.test' }, { providerId: 'claude-code' }, { HOME: '/fixture-home', ANTHROPIC_CONFIG_DIR: '/other-account', CLAUDE_CONFIG_DIR: '/other-login', anthropic_profile: 'default' }, { has: () => true, environment: () => ({ ANTHROPIC_API_KEY: 'fixture-key' }) });
  assert.equal(result.ANTHROPIC_CONFIG_DIR, undefined); assert.equal(result.CLAUDE_CONFIG_DIR, undefined); assert.equal(result.anthropic_profile, undefined); assert.equal(result.ANTHROPIC_API_KEY, 'fixture-key');
});
