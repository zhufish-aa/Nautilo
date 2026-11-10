import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import { helperModules } from './helpers/orchestration-runtime-harness.mjs';

const root = new URL('../src/renderer/src/lib/', import.meta.url);
const modules = { './changed-files': helperModules['./changed-files'] };
for (const name of ['line-diff', 'revert-change', 'change-review']) {
  const source = await readFile(new URL(`${name}.ts`, root), 'utf8');
  const exports = {};
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    exports, require: (id) => { assert.ok(modules[id], `Unexpected dependency ${id}`); return modules[id]; }
  });
  modules[`./${name}`] = exports;
}
const { buildReviewFiles, recordedFileVersions, reviewBefore, reviewLineCounts, reviewRelativePath, reviewMatches } = modules['./change-review'];
const patch = (path, diff = '@@ -1 +1 @@\n-old\n+new') => ({ kind: 'patch', path, diff, edits: 1, additions: 0, deletions: 0, changeType: 'modified' });

test('Windows relative paths honor directory boundaries and preserve display casing', () => {
  assert.equal(reviewRelativePath('C:\\Repo\\src\\Main.ts', 'c:/repo/'), 'src/Main.ts');
  assert.equal(reviewRelativePath('C:/repository/a.ts', 'C:/repo'), 'C:/repository/a.ts');
  assert.equal(reviewRelativePath('D:\\中文项目\\src\\页面.tsx', 'D:\\中文项目'), 'src/页面.tsx');
  assert.equal(reviewRelativePath('/Repo/a.ts', '/repo'), '/Repo/a.ts');
});

test('selection identities survive reordered files and distinguish delegated sessions', () => {
  const first = buildReviewFiles([{ id: 'main', entries: [patch('C:/repo/a.ts'), patch('C:/repo/b.ts')] }, { id: 'child', label: 'Explorer', entries: [patch('C:/repo/a.ts')] }], 'C:/repo');
  const reordered = buildReviewFiles([{ id: 'main', entries: [patch('C:/repo/b.ts'), patch('C:/repo/a.ts')] }], 'C:/repo');
  assert.equal(first[0].id, reordered[1].id);
  assert.notEqual(first[0].id, first[2].id);
  assert.equal(first[0].directory, '');
  assert.equal(first[0].additions, 1);
  assert.equal(first[0].deletions, 1);
  assert.ok(reviewMatches(first[2], 'explorer'));
});

test('review marks invalidate on changed source while text-only projection refreshes retain entries', () => {
  const original = buildReviewFiles([{ id: 'revision', entries: [patch('/src/a.ts')] }])[0];
  const refresh = buildReviewFiles([{ id: 'revision', entries: [patch('/src/a.ts')] }])[0];
  assert.equal(original.entry, refresh.entry);
  assert.equal(original.revision, refresh.revision);
  const changed = buildReviewFiles([{ id: 'revision', entries: [patch('/src/a.ts', '@@ -1 +1 @@\n-old\n+newer')] }])[0];
  assert.notEqual(original.revision, changed.revision);
});

test('fragment totals exclude unchanged context and nonexistent empty sides', () => {
  const fragment = { path: 'a.ts', before: 'context\nold\ntail', after: 'context\nnew\ntail' };
  const created = { path: 'b.ts', before: '', after: 'hello' };
  const files = buildReviewFiles([{ id: 'fragments', entries: [
    { kind: 'fileDiff', path: 'a.ts', diff: fragment, diffs: [fragment], edits: 1 },
    { kind: 'fileDiff', path: 'b.ts', diff: created, diffs: [created], edits: 1 }
  ] }]);
  assert.equal(files[0].additions, 1);
  assert.equal(files[0].deletions, 1);
  assert.equal(files[1].additions, 1);
  assert.equal(files[1].deletions, 0);
});

test('full previews reconstruct uniquely anchored edits and retain surrounding live content', () => {
  const entry = patch('a.ts', '@@ -2 +2 @@\n-old\n+new');
  assert.equal(reviewBefore(entry, 'prefix\r\nnew\r\ntail\r\n'), 'prefix\r\nold\r\ntail\r\n');
  assert.equal(reviewBefore(entry, 'new\nseparator\nnew'), undefined);
  assert.equal(reviewBefore({ ...entry, comparisonUnavailable: true }, 'new'), undefined);
  const fragment = { path: 'a.ts', before: 'old', after: 'new', truncated: true };
  assert.equal(reviewBefore({ kind: 'fileDiff', path: 'a.ts', diff: fragment, diffs: [fragment], edits: 1 }, 'new'), undefined);
});

test('new-file preview never fabricates an empty baseline for an externally extended file', () => {
  const entry = { ...patch('new.ts', '@@ -0,0 +1 @@\n+hello'), changeType: 'added' };
  assert.equal(reviewBefore(entry, 'hello\n'), '');
  assert.equal(reviewBefore(entry, 'hello\nuser additions\n'), undefined);
});

test('write-only tool input is not proof of a newly created file', () => {
  const fragment = { operation: 'write', path: 'existing.dart', before: '', after: 'original content\n' };
  const entry = { kind: 'fileDiff', path: fragment.path, diff: fragment, diffs: [fragment], edits: 1 };
  assert.equal(reviewBefore(entry, fragment.after), undefined);
  assert.equal(buildReviewFiles([{ id: 'write-unknown', entries: [entry] }]).length, 0);
});

test('excluded file bodies and no-ops do not inflate file counts or selection indices', () => {
  const body = { operation: 'write', path: 'preview-only.ts', before: '', after: 'content' };
  const noop = { operation: 'edit', path: 'noop.ts', before: 'same', after: 'same' };
  const entries = [body, noop].map(diff => ({ kind: 'fileDiff', path: diff.path, diff, diffs: [diff], edits: 1 }));
  const files = buildReviewFiles([{ id: 'filtered', entries: [...entries, patch('real.ts')] }]);
  assert.equal(files.length, 1);
  assert.equal(files[0].entry.path, 'real.ts');
  assert.equal(files[0].index, 0);
});

test('missing created/deleted files can show their recorded complete versions, never a partial modified hunk', () => {
  const created = { ...patch('created.ts', '@@ -0,0 +1,2 @@\n+first\n+second'), changeType: 'added' };
  const deleted = { ...patch('deleted.ts', '@@ -1,2 +0,0 @@\n-first\n-second'), changeType: 'deleted' };
  assert.equal(recordedFileVersions(created).before, '');
  assert.equal(recordedFileVersions(created).after, 'first\nsecond');
  assert.equal(recordedFileVersions(deleted).before, 'first\nsecond');
  assert.equal(recordedFileVersions(deleted).after, '');
  assert.equal(recordedFileVersions(patch('modified.ts', '@@ -20 +20 @@\n-old\n+new')), undefined);
  assert.equal(recordedFileVersions({ ...created, comparisonUnavailable: true }), undefined);
  assert.equal(recordedFileVersions({ ...created, diff: '@@ -0,0 +20 @@\n+only a fragment' }), undefined);
  assert.equal(recordedFileVersions({ ...created, diff: '@@ -0,0 +1,20 @@\n+truncated creation' }), undefined);
});

test('duplicate receipts and successive appends count the four net inserted lines once', () => {
  const first = { operation: 'edit', path: 'ISSUES.md', before: 'heading\n', after: 'heading\n\nfirst result\n' };
  const second = { operation: 'edit', path: 'ISSUES.md', before: first.after, after: `${first.after}\nsecond result\n` };
  const entry = { kind: 'fileDiff', path: first.path, diff: second, diffs: [first, { ...first }, second], edits: 3 };
  const baseline = reviewBefore(entry, second.after);
  assert.equal(baseline, first.before);
  const counts = reviewLineCounts(baseline, second.after);
  assert.equal(counts.additions, 4);
  assert.equal(counts.deletions, 0);
  const file = buildReviewFiles([{ id: 'duplicate-receipts', entries: [entry] }])[0];
  assert.equal(file.additions, 4);
  assert.equal(file.deletions, 0);
});

test('unchanged full content is zero, blank lines count, and a terminal newline is not an inserted line', () => {
  for (const [before, after, added, deleted] of [
    ['same\n', 'same\n', 0, 0],
    ['line\n', 'line\n\n', 1, 0],
    ['line', 'line\n', 0, 0],
    ['a\r\nb\r\n', 'a\nb\n', 0, 0],
    ['a\nb\nc\n', 'b\nc\nd\n', 1, 1]
  ]) {
    const counts = reviewLineCounts(before, after);
    assert.equal(counts.additions, added);
    assert.equal(counts.deletions, deleted);
  }
});
