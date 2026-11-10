import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { buildOfficialSearchEnvironment, officialSearchWorkerKey, executeOfficialWebSearch } from '../dist/runtime/orchestration/official-web-search.js';
const target = { id: 'search-profile', providerId: 'codex', executable: 'codex', baseArgs: [], enabled: true, status: 'available', providerOptions: { loginProfileDirectory: resolve('/tmp/search-account-a') } };

test('official search excludes ambient and vault credentials when an account is selected', (t) => {
  const prior = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'ambient-secret';
  t.after(() => { if (prior === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = prior; });
  const env = buildOfficialSearchEnvironment(target, { OPENAI_API_KEY: 'vault-secret', CODEX_API_KEY: 'other-secret' });
  assert.equal(env.CODEX_HOME, target.providerOptions.loginProfileDirectory);
  assert.equal(env.OPENAI_API_KEY, undefined); assert.equal(env.CODEX_API_KEY, undefined);
  assert.ok(env.PATH || env.Path);
});

test('search environment remains allowlisted for non-account instances', (t) => {
  const prior = process.env.NAUTILO_TEST_PRIVATE_SECRET;
  process.env.NAUTILO_TEST_PRIVATE_SECRET = 'private';
  t.after(() => { if (prior === undefined) delete process.env.NAUTILO_TEST_PRIVATE_SECRET; else process.env.NAUTILO_TEST_PRIVATE_SECRET = prior; });
  const env = buildOfficialSearchEnvironment({ ...target, providerOptions: {} }, { OPENAI_API_KEY: 'saved-api-key' });
  assert.equal(env.OPENAI_API_KEY, 'saved-api-key'); assert.equal(env.NAUTILO_TEST_PRIVATE_SECRET, undefined);
});

test('persistent search worker identity changes on account, endpoint and credential changes', () => {
  const env = buildOfficialSearchEnvironment(target, {}), key = officialSearchWorkerKey(target, env);
  const changed = { ...target, providerOptions: { loginProfileDirectory: resolve('/tmp/search-account-b') } };
  assert.notEqual(key, officialSearchWorkerKey(changed, buildOfficialSearchEnvironment(changed, {})));
  assert.notEqual(key, officialSearchWorkerKey({ ...target, executable: 'other-codex' }, env));
  assert.notEqual(officialSearchWorkerKey(target, { OPENAI_API_KEY: 'a' }), officialSearchWorkerKey(target, { OPENAI_API_KEY: 'b' }));
  assert.equal(officialSearchWorkerKey(target, { A: 'a', B: 'b' }), officialSearchWorkerKey(target, { B: 'b', A: 'a' }));
  assert.match(key, /^[0-9a-f]{64}$/);
});

test('invalid mixed account configurations fail before search requests or CLI launch', async (t) => {
  const original = globalThis.fetch; let fetched = false;
  globalThis.fetch = async () => { fetched = true; throw new Error('unexpected network'); };
  t.after(() => { globalThis.fetch = original; });
  const invalid = { ...target, providerOptions: { ...target.providerOptions, baseUrl: 'https://example.invalid' } };
  const result = await executeOfficialWebSearch({ arguments: { query: 'test' } }, { providerOptions: { webSearchInstanceId: target.id } }, { agents: { get: () => invalid } }, { environment: () => ({ OPENAI_API_KEY: 'vault-secret' }) });
  assert.equal(result.success, false); assert.match(result.content, /profile is invalid/); assert.equal(fetched, false);
});
