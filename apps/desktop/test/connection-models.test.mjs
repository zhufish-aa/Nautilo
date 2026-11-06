import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const compile = file => ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const helpers = {};
vm.runInNewContext(compile('../src/renderer/src/lib/connection-models.ts'), { exports: helpers, Date });
const { connectionModelCatalog, resolveDraftConnectionConfiguration } = helpers;
const plain = value => JSON.parse(JSON.stringify(value));
const model = (id, patch = {}) => ({ id, displayName: id, reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'high', capabilities: [], serviceTiers: [], ...patch });
const connection = (patch = {}) => ({ id: 'deepseek', name: 'DeepSeek', kind: 'api', protocol: 'chat', revision: 3, enabled: true, hasCredential: true, models: [model('deepseek/deepseek-v4.1-flash', { displayName: 'DeepSeek Flash' })], createdAt: '2026-11-03T00:00:00Z', updatedAt: '2026-11-03T00:00:00Z', ...patch });
const discovered = models => ({ providerId: 'connection:deepseek', models, defaultModel: models[0]?.id, source: 'provider_api', fetchedAt: new Date().toISOString() });

test('one configured model stays selectable when discovery is unavailable or lists unrelated models', () => {
  const saved = connection();
  const all = discovered([model('claude-sonnet'), model('other-model'), model(saved.models[0].id)]);
  for (const catalog of [undefined, all, { ...all, models: [], source: 'unavailable' }]) {
    const result = connectionModelCatalog(saved, catalog);
    assert.deepEqual(plain(result.models.map(item => item.id)), [saved.models[0].id]);
    assert.equal(result.models[0].displayName, 'DeepSeek Flash');
    assert.equal(result.defaultModel, saved.models[0].id);
  }
  assert.equal(all.models.length, 3, 'selecting must not mutate the discovery catalog');
});

test('disabled or removed models cannot reappear through discovery; configured order supplies the default', () => {
  const saved = connection({ models: [model('second'), model('first', { enabled: false }), model('third')] });
  const result = connectionModelCatalog(saved, discovered([model('first'), model('unconfigured'), model('third')]));
  assert.deepEqual(plain(result.models.map(item => item.id)), ['second', 'third']);
  assert.equal(result.defaultModel, 'second');
  assert.equal(connectionModelCatalog(connection({ models: [] }), discovered([model('other')])).models.length, 0);
  assert.equal(connectionModelCatalog(connection({ enabled: false }), discovered([model('other')])).models.length, 0);
});

test('turning off reasoning survives live metadata and defaults', () => {
  const saved = connection({ models: [model('custom', { reasoningEfforts: [], defaultReasoningEffort: undefined })] });
  const result = connectionModelCatalog(saved, discovered([model('custom')]));
  assert.deepEqual(plain(result.models[0].reasoningEfforts), []);
  assert.equal(result.models[0].defaultReasoningEffort, undefined);
  const selection = resolveDraftConnectionConfiguration({ model: 'custom', reasoningEffort: 'high' }, saved, result);
  assert.equal(selection.reasoningEffort, undefined);
});

test('an unsent draft follows the saved revision and retains a still-enabled model and effort', () => {
  const selection = { connectionId: 'deepseek', connectionRevision: 1, model: 'deepseek/deepseek-v4.1-flash', reasoningEffort: 'low', permissionMode: 'default' };
  const resolved = resolveDraftConnectionConfiguration(selection, connection());
  assert.equal(resolved.connectionRevision, 3);
  assert.equal(resolved.model, selection.model);
  assert.equal(resolved.reasoningEffort, 'low');
  assert.equal(resolved.permissionMode, 'default');
  assert.equal(selection.connectionRevision, 1, 'persisted caller data is never mutated');
});

test('a draft drops stale models and unsupported options after a connection edit', () => {
  const saved = connection({ models: [model('new-model')] });
  const resolved = resolveDraftConnectionConfiguration({ model: 'deleted-model', reasoningEffort: 'max', serviceTier: 'unsupported' }, saved);
  assert.equal(resolved.model, 'new-model');
  assert.equal(resolved.reasoningEffort, 'high');
  assert.equal(resolved.serviceTier, undefined);
});

test('a new login account can discover models, while a curated account keeps its saved selection', () => {
  const all = discovered([model('account-default'), model('other')]);
  assert.equal(connectionModelCatalog(connection({ kind: 'login', models: [] }), all).models.length, 2);
  assert.deepEqual(plain(connectionModelCatalog(connection({ kind: 'login', models: [model('account-default')] }), all).models.map(item => item.id)), ['account-default']);
});

function storeHarness(requestCore) {
  const reasoning = {};
  vm.runInNewContext(compile('../src/renderer/src/lib/model-reasoning.ts'), { exports: reasoning });
  const exports = {};
  vm.runInNewContext(compile('../src/renderer/src/stores/connections.ts'), {
    exports, Map, Date, Promise,
    require: name => name === 'zustand' ? { create: init => {
      let state;
      const get = () => state;
      const set = update => { state = { ...state, ...(typeof update === 'function' ? update(state) : update) }; };
      state = init(set, get);
      return { getState: get, setState: set };
    } } : name === '../lib/bridge' ? { requestCore } : name === '../lib/connection-models' ? helpers : reasoning,
  });
  return exports.useConnectionsStore;
}

test('manual API models load without contacting discovery and remain version-specific', async () => {
  const saved = connection();
  const calls = [];
  const store = storeHarness(async (method, input) => { calls.push({ method, input }); return { ...saved, revision: input.revision, models: [model('historical-model')] }; });
  store.setState({ connections: [saved] });
  const latest = await store.getState().loadModels(saved.id, 3);
  assert.equal(latest.models[0].id, saved.models[0].id);
  assert.equal(calls.length, 0, 'chat must not depend on the provider supporting /models');
  const old = await store.getState().loadModels(saved.id, 1);
  assert.equal(old.models[0].id, 'historical-model');
  assert.deepEqual(calls.map(call => call.method), ['connection.get']);
  assert.equal(store.getState().connections[0].revision, 3);
});

test('explicit discovery returns all candidates to settings but cannot expand the chat model cache', async () => {
  const saved = connection();
  const store = storeHarness(async () => discovered([model('unconfigured'), model(saved.models[0].id)]));
  store.setState({ connections: [saved] });
  const candidates = await store.getState().models(saved.id, 3);
  assert.equal(candidates.models.length, 2);
  const selected = store.getState().modelCatalogs['deepseek:3'];
  assert.deepEqual(plain(selected.models.map(item => item.id)), [saved.models[0].id]);
  assert.equal(selected.defaultModel, saved.models[0].id);
});

test('saving model edits immediately seeds the new revision without overwriting historical catalogs', async () => {
  const saved = connection({ revision: 4, models: [model('new-model')] });
  const store = storeHarness(async () => saved);
  store.setState({ connections: [connection()], modelCatalogs: { 'deepseek:3': discovered([model('old-model')]) } });
  await store.getState().save(saved, 3);
  assert.equal(store.getState().modelCatalogs['deepseek:4'].models[0].id, 'new-model');
  assert.equal(store.getState().modelCatalogs['deepseek:3'].models[0].id, 'old-model');
});
