import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunDiffCollector } from '../dist/runtime/run-diff-collector.js';

test('missing non-Git baseline never fabricates additions from current file contents', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'nautilo-no-baseline-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'existing.txt'), 'existing contents\n');
  const collector = new RunDiffCollector();
  assert.equal(await collector.isNonGitWorkspace(root), true);
  assert.deepEqual(await collector.collect(root, [{ path: 'existing.txt', changeType: 'modified' }]), []);
});

test('only explicit non-Git diagnostics identify unavailable non-Git baselines', async () => {
  for (const result of [
    { exitCode: 0, stdout: 'true\n', stderr: '' },
    { exitCode: 128, stdout: '', stderr: 'fatal: detected dubious ownership in repository' },
    { exitCode: 1, stdout: '', stderr: 'permission denied' }
  ]) {
    assert.equal(await new RunDiffCollector({ run: async () => result }).isNonGitWorkspace('/unused'), false);
  }
  await assert.rejects(new RunDiffCollector({ run: async () => { throw new Error('git unavailable'); } }).isNonGitWorkspace('/unused'));
});

test('excluded, truncated, oversized and unreadable versions never become fabricated additions or deletions', async (t) => {
  const { captureWorkspaceSnapshot } = await import('../dist/runtime/run-workspace-snapshot.js');
  const { mkdir } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'nautilo-unknown-versions-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'large.txt'), Buffer.alloc(1024 * 1024 + 1, 65));
  await writeFile(join(root, 'binary.txt'), 'old\0binary');
  await writeFile(join(root, 'grow.txt'), 'before\n');
  await writeFile(join(root, 'remove.txt'), 'before\n');
  await writeFile(join(root, 'directory.txt'), 'before\n');
  await mkdir(join(root, 'node_modules'));
  await writeFile(join(root, 'node_modules', 'hidden.txt'), 'old\n');
  const baseline = await captureWorkspaceSnapshot(root);
  assert.equal(baseline.traversalComplete, true);
  for (const path of ['large.txt', 'binary.txt', 'node_modules/hidden.txt']) await writeFile(join(root, path), 'after\n');
  await writeFile(join(root, 'grow.txt'), Buffer.alloc(1024 * 1024 + 1, 65));
  await rm(join(root, 'directory.txt')); await mkdir(join(root, 'directory.txt'));
  await rm(join(root, 'remove.txt')); await writeFile(join(root, 'new.txt'), 'created\n');
  const collector = new RunDiffCollector();
  const paths = ['large.txt', 'binary.txt', 'node_modules/hidden.txt', 'grow.txt', 'directory.txt', 'remove.txt', 'new.txt'];
  const files = await collector.collect(root, paths.map((path) => ({ path, changeType: 'modified' })), baseline);
  for (const path of paths.slice(0,5)) {
    const file = files.find((file) => file.path === path);
    assert.equal(file.comparisonUnavailable, true, path);
    assert.equal(file.diff, '', path);
    assert.equal(file.changeType, 'modified', path);
    assert.equal(file.additions + file.deletions, 0, path);
  }
  assert.equal(files.find((file) => file.path === 'remove.txt').changeType, 'deleted');
  assert.equal(files.find((file) => file.path === 'new.txt').changeType, 'added');
  const partial = { ...baseline, traversalComplete: false, truncated: true };
  const [unknown] = await collector.collect(root, [{ path: 'new.txt', changeType: 'modified' }], partial);
  assert.equal(unknown.comparisonUnavailable, true);
  assert.equal(unknown.reason, 'baseline_file_unavailable');
});
