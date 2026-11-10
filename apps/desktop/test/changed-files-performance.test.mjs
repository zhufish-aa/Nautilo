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

test('file bodies, failed edits, pending edits and no-op edits are not changed files or badge counts', () => {
  const events = [
    row(1, { kind: 'tool_activity', toolName: 'Read', status: 'done', input: JSON.stringify({ path: 'read.ts', content: 'whole file' }) }),
    row(2, { kind: 'tool_activity', toolName: 'Write', status: 'done', input: JSON.stringify({ path: 'write.ts', content: 'whole file' }) }),
    row(3, { kind: 'tool_activity', toolName: 'write_file', status: 'done', fileDiff: { path: 'legacy-write.ts', before: '', after: 'whole file' } }),
    row(4, { kind: 'tool_activity', toolName: 'Write', status: 'done', fileDiff: { operation: 'write', path: 'explicit-write.ts', before: '', after: 'whole file' } }),
    row(5, { ...edit(5, 'failed.ts').data, status: 'failed' }),
    row(6, { ...edit(6, 'running.ts').data, status: 'running' }),
    row(7, { kind: 'tool_activity', toolName: 'Edit', status: 'done', fileDiff: { path: 'unchanged.ts', before: 'same', after: 'same' } }),
    row(8, { kind: 'tool_activity', toolName: 'Edit', status: 'done', input: JSON.stringify({ path: 'noop.ts', old_string: 'same', new_string: 'same' }) })
  ];
  assert.equal(collectChangedFiles(events).length, 0);
  assert.equal(countChangedFiles(events), 0);
  assert.equal(cachedChangedFileCount(events), 0);
});

test('completed edits and writes with captured old content remain reviewable', () => {
  const events = [
    row(1, { kind: 'tool_activity', toolName: 'Edit', status: 'done', input: JSON.stringify({ path: 'edit.ts', old_string: 'old', new_string: 'new' }) }),
    row(2, { kind: 'tool_activity', toolName: 'Write', status: 'done', fileDiff: { operation: 'write', path: 'captured.ts', before: 'old file', after: 'new file' } }),
    row(3, { kind: 'file_change', files: [{ path: 'created.ts', changeType: 'added', additions: 1, deletions: 0, diff: '@@ -0,0 +1 @@\n+created' }] })
  ];
  assert.deepEqual(Array.from(collectChangedFiles(events), file => file.path), ['edit.ts', 'captured.ts', 'created.ts']);
  assert.equal(countChangedFiles(events), 3);
});

test('changing a tool from pending to done does not reuse an excluded cached path', () => {
  const activity = { ...edit(1).data, status: 'running' };
  assert.equal(countChangedFiles([row(1, activity)]), 0);
  activity.status = 'done';
  assert.equal(countChangedFiles([row(1, activity)]), 1);
  activity.status = 'failed';
  assert.equal(collectChangedFiles([row(1, activity)]).length, 0);
});
