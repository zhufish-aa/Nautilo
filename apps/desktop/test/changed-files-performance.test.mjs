import test from 'node:test';
import assert from 'node:assert/strict';
import { helperModules } from './helpers/orchestration-runtime-harness.mjs';
const { collectChangedFiles, countChangedFiles, cachedChangedFileCount } = helperModules['./changed-files'];
const row = (id, data, runId='r') => ({ id: String(id), sessionId: 's', runId, data, sequence: id, timestamp: '' });
const edit = (id, path='a') => row(id, { kind: 'tool_activity', toolName: 'Edit', input: '', fileDiff: { path, before: `old${id}`, after: `new${id}` } });
const native = (id, paths) => row(id, { kind: 'file_change', source: 'provider', replace: true, files: paths.map(path=>({ path, changeType: 'modified', additions: 0, deletions: 0, diff: '+x' })) });

test('repeated edits append private fragments without mutating frozen input or earlier projections', () => {
  const events = Array.from({ length: 10000 }, (_, i) => edit(i));
  for (const event of events) { Object.freeze(event.data.fileDiff); Object.freeze(event.data); Object.freeze(event); }
  const first = collectChangedFiles(events);
  assert.equal(first.length, 1);
  assert.equal(first[0].diffs.length, 10000);
  assert.equal(first[0].edits, 10000);
  const next = collectChangedFiles([...events, edit(10001)]);
  assert.equal(next[0].diffs.length, 10001);
  assert.equal(first[0].diffs.length, 10000);
  assert.equal(first[0].diffs[0].before, 'old0');
  assert.equal(first[0].diffs.at(-1).after, 'new9999');
});

test('lightweight counts agree with full projection across replacement, withdrawal, groups and scopes', () => {
  const sequences = [[], [edit(1)], [edit(1), edit(2,'b')], [edit(1), native(2,['b'])], [edit(1), native(2,[])],
    [row(1,{kind:'tool_group',items:[edit(2,'a'),edit(3,'b')]}), native(4,['c'])],
    [row(1,{kind:'file_change',files:[{path:'old',additions:0,deletions:0}]},'previous'),edit(2),native(3,[])]];
  for (const events of sequences) assert.equal(countChangedFiles(events),collectChangedFiles(events).length);
});

test('count projection never scans patch contents for line counts', () => {
  const file = { path: 'a', additions: 0, deletions: 0 };
  Object.defineProperty(file, 'diff', { get() { throw Error('badge must not parse patch'); } });
  assert.equal(countChangedFiles([row(1,{kind:'file_change',files:[file]})]), 1);
});

test('immutable timeline cache refreshes same-length changed/native-cleared snapshots', () => {
  const before = [native(1,['a','b'])];
  assert.equal(cachedChangedFileCount(before), 2);
  assert.equal(cachedChangedFileCount(before), 2);
  assert.equal(cachedChangedFileCount([native(1,[])]), 0);
  assert.equal(cachedChangedFileCount([native(1,['c'])]), 1);
});
