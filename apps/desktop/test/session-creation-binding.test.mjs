import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';

test('new conversation persists the selected source and revision in its first write', async () => {
  const require = createRequire(import.meta.url);
  const calls = [];
  const source = readFileSync(new URL('../src/renderer/src/stores/sessions.ts', import.meta.url), 'utf8');
  const exports = {};
  const modules = {
    zustand: require('zustand'),
    '../lib/utils': { newId: () => 'new-session' },
    '../lib/bridge': { getBridge: () => ({}), requestCore: async (method, input) => { calls.push({ method, input }); return input; } }
  };
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports, require: name => modules[name], console });
  const session = exports.useSessionsStore.getState().createSession({ projectId: 'p', target: { type: 'agent', instanceId: 'harness-codex' }, title: 'hi', connectionId: 'account-one', connectionRevision: 3, model: 'model-a', reasoningEffort: 'max' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'session.upsert');
  for (const key of ['connectionId', 'connectionRevision', 'model', 'reasoningEffort']) assert.equal(calls[0].input[key], session[key]);
  assert.equal(calls[0].input.agentInstanceId, 'harness-codex');
});
