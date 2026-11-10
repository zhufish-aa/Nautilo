import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const source = readFileSync(new URL('../src/renderer/src/lib/core-mappers.ts', import.meta.url), 'utf8');
const exports = {};
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports, require: (name) => {
  assert.equal(name, './provider-catalog'); return { providerMeta: () => ({ capabilities: [] }) };
} });
const agent = { id: 'shared', providerId: 'codex', displayName: 'Shared Codex', executable: 'codex', baseArgs: [], capabilities: [], enabled: true, status: 'available', createdAt: 'now', updatedAt: 'now' };
test('Codex concurrency defaults to unlimited and explicit limits survive editing and persistence', () => {
  assert.equal(exports.toUiAgent(agent).appServerPoolSize, undefined);
  for (const limit of [1, 2, 4, 16, 100]) {
    const original = { ...agent, providerOptions: { appServerPoolSize: limit, permissionMode: 'read-only' } };
    const ui = exports.toUiAgent(original);
    assert.equal(ui.appServerPoolSize, limit);
    const saved = exports.toDomainAgent({ ...ui, displayName: 'Renamed' });
    assert.equal(saved.providerOptions.appServerPoolSize, limit);
    assert.equal(saved.providerOptions.permissionMode, 'read-only');
  }
});
test('invalid limits are unset and non-Codex instances do not acquire pool settings', () => {
  for (const [input, expected] of [[0, undefined], [-1, undefined], [2.9, undefined], [NaN, undefined], [Infinity, undefined], ['2', undefined]]) {
    const ui = exports.toUiAgent({ ...agent, providerOptions: { appServerPoolSize: input } });
    assert.equal(ui.appServerPoolSize, expected);
  }
  const ui = exports.toUiAgent({ ...agent, providerId: 'claude-code', providerOptions: { appServerPoolSize: 3 } });
  assert.equal(ui.appServerPoolSize, undefined);
  assert.equal(Object.hasOwn(exports.toDomainAgent(ui).providerOptions, 'appServerPoolSize'), false);
});

test('clearing an explicit limit removes it from the complete persisted configuration', () => {
  const ui = exports.toUiAgent({ ...agent, providerOptions: { appServerPoolSize: 2 } });
  const saved = exports.toDomainAgent({ ...ui, appServerPoolSize: undefined });
  assert.equal(Object.hasOwn(saved.providerOptions, 'appServerPoolSize'), false);
  assert.equal(exports.toUiAgent(saved).appServerPoolSize, undefined);
});
test('member limits remain optional without overwriting existing explicit choices', () => {
  const team = { id: 'team', name: 'Team', delegationPolicy: 'autonomous', members: [{ id: 'member', displayName: 'Member', agentInstanceId: 'shared', roleId: 'role', strengths: {}, allowedTaskTypes: [], enabled: true }], createdAt: 'now', updatedAt: 'now' };
  assert.equal(exports.toDomainTeam(exports.toUiTeam(team)).members[0].maxConcurrentTasks, undefined);
  const existing = { ...team, members: [{ ...team.members[0], maxConcurrentTasks: 1 }] };
  const ui = exports.toUiTeam(existing);
  assert.equal(exports.toDomainTeam(ui).members[0].maxConcurrentTasks, 1);
  ui.members[0].maxConcurrentTasks = undefined;
  const saved = JSON.parse(JSON.stringify(exports.toDomainTeam(ui)));
  assert.equal(Object.hasOwn(saved.members[0], 'maxConcurrentTasks'), false);
});
