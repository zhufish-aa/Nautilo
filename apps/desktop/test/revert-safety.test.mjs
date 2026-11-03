import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

const root = new URL('../src/renderer/src/', import.meta.url);
const pure = await readFile(new URL('lib/revert-change.ts', root), 'utf8');
const compiled = ts.transpileModule(pure, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const { revertFileDiffs, reverseApplyUnifiedPatch } = await import(`data:text/javascript,${encodeURIComponent(compiled)}`);

test('fragment revert rejects repeated and overlapping matches', () => {
  assert.equal(revertFileDiffs('NEW\nseparator\nNEW', [{ before: 'OLD', after: 'NEW' }]).ok, false);
  assert.equal(revertFileDiffs('aaa', [{ before: 'x', after: 'aa' }]).ok, false);
  assert.deepEqual(revertFileDiffs('prefix\nNEW\n', [{ before: 'OLD', after: 'NEW' }]), { ok: true, content: 'prefix\nOLD\n' });
});
test('unified revert rejects ambiguous or unanchored hunks, preserves unique CRLF edits', () => {
  const patch = '@@ -3 +3 @@\n-OLD\n+NEW';
  assert.equal(reverseApplyUnifiedPatch('NEW\nseparator\nNEW', patch).ok, false);
  assert.equal(reverseApplyUnifiedPatch('one\ntwo', '@@ -1 +0,0 @@\n-gone').ok, false);
  assert.deepEqual(reverseApplyUnifiedPatch('prefix\r\nNEW\r\n', patch), { ok: true, content: 'prefix\r\nOLD\r\n' });
});

const drawer = await readFile(new URL('features/sessions/Drawers.tsx', root), 'utf8');
const start = drawer.indexOf('  const revertChange =');
const end = drawer.indexOf('  const startEdit =', start);
const handler = ts.transpileModule(drawer.slice(start, end).replace('const revertChange', 'export const revertChange'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS }
}).outputText;
function createHandler(read) {
  const mutations = [], errors = [];
  const context = {
    exports: {}, window: { agenthub: { files: {
      readText: async () => read,
      writeText: async (input) => { mutations.push(['write', input]); return { ok: true }; },
      delete: async (input) => { mutations.push(['delete', input]); return { ok: true }; }
    } } }, projectRoot: '/fixture', locale: 'en',
    setReverting() {}, setRevertArmed() {},
    toast: { error(value) { errors.push(value); }, success() {} }, t: (key) => key,
    revertFileDiffs, reverseApplyUnifiedPatch,
    sameContent: () => true, patchFileImages: () => ({ before: 'old', after: 'new' })
  };
  vm.runInNewContext(handler, context);
  return { run: context.exports.revertChange, mutations, errors };
}
for (const entry of [
  { kind: 'fileDiff', path: 'a', diffs: [{ before: 'old', after: 'new' }] },
  { kind: 'patch', path: 'a', changeType: 'modified', diff: '@@ -1 +1 @@\n-old\n+new' },
  { kind: 'patch', path: 'a', changeType: 'added', diff: '@@ -0,0 +1 @@\n+new' }
]) test(`truncated live content never mutates ${entry.kind}/${entry.changeType ?? 'fragment'}`, async () => {
  const h = createHandler({ ok: true, content: 'new', truncated: true, resolvedPath: '/fixture/a' });
  await h.run(entry);
  assert.deepEqual(h.mutations, []);
  assert.deepEqual(h.errors, ['sessions.drawers.revertTruncated']);
});
test('deleted-file revert never overwrites a newly recreated file', async () => {
  const h = createHandler({ ok: true, content: 'new user work', resolvedPath: '/fixture/a' });
  await h.run({ kind: 'patch', path: 'a', changeType: 'deleted', diff: '@@ -1 +0,0 @@\n-old' });
  assert.equal(h.mutations.length, 0);
  assert.equal(h.errors.length, 1);
});
test('complete uniquely matched file remains revertible', async () => {
  const h = createHandler({ ok: true, content: 'new', truncated: false, resolvedPath: '/fixture/a' });
  await h.run({ kind: 'fileDiff', path: 'a', diffs: [{ before: 'old', after: 'new' }] });
  assert.equal(h.mutations.length, 1);
  assert.equal(h.mutations[0][1].content, 'old');
});
test('unavailable comparison cannot mutate a file even with a stale patch', async () => {
  const h = createHandler({ ok: true, content: 'new', resolvedPath: '/fixture/a' });
  await h.run({ kind: 'patch', path: 'a', changeType: 'modified', comparisonUnavailable: true, diff: '@@ -1 +1 @@\n-old\n+new' });
  assert.equal(h.mutations.length, 0);
  assert.equal(h.errors.length, 1);
});
