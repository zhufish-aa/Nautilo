import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, opendir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { captureWorkspaceSnapshot } from '../dist/runtime/run-workspace-snapshot.js';

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'nautilo-snapshot-test-'));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

// Follow filesystem order rather than assuming alphabetical readdir order.
async function orderedPaths(root, directory = root) {
  const result = [];
  for await (const entry of await opendir(directory)) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await orderedPaths(root, path));
    else if (entry.isFile()) result.push(relative(root, path).replaceAll('\\', '/'));
  }
  return result;
}

test('workspace snapshot preserves depth-first order across read batches', async () => fixture(async (root) => {
  for (let i = 0; i < 40; i++) {
    if (i === 7 || i === 22) {
      await mkdir(join(root, `nested-${i}`));
      await writeFile(join(root, `nested-${i}`, 'child.txt'), `child ${i}`);
    }
    await writeFile(join(root, `${i}.txt`), `text ${i}`);
  }
  const snapshot = await captureWorkspaceSnapshot(root);
  assert.deepEqual([...snapshot.files.keys()], await orderedPaths(root));
  assert.equal(snapshot.files.get('7.txt'), 'text 7');
  assert.equal(snapshot.truncated, false);
  assert.equal(snapshot.traversalComplete, true);
}));

test('workspace snapshot skips generated folders, links, binary and oversized files', async () => fixture(async (root) => {
  await mkdir(join(root, 'node_modules'));
  await writeFile(join(root, 'node_modules', 'ignored.txt'), 'ignored');
  await writeFile(join(root, 'good.txt'), 'hello');
  await writeFile(join(root, 'binary.txt'), 'hello\0world');
  await writeFile(join(root, 'oversized.txt'), Buffer.alloc(1024 * 1024 + 1, 65));
  await writeFile(join(root, 'image.png'), 'not a text extension');
  // Windows environments without symlink privileges still test all other skips.
  try { await symlink(join(root, 'good.txt'), join(root, 'link.txt')); }
  catch (error) { if (error.code !== 'EPERM') throw error; }
  const snapshot = await captureWorkspaceSnapshot(root);
  assert.deepEqual([...snapshot.files], [['good.txt', 'hello']]);
  assert.equal(snapshot.truncated, false);
  assert.equal(snapshot.traversalComplete, true);
}));

test('workspace snapshot keeps the first 10000 files in traversal order', async () => fixture(async (root) => {
  for (let start = 0; start < 10001; start += 100) {
    await Promise.all(Array.from({ length: Math.min(100, 10001 - start) }, (_, i) =>
      writeFile(join(root, `${start + i}.txt`), 'x')));
  }
  const order = await orderedPaths(root);
  const snapshot = await captureWorkspaceSnapshot(root);
  assert.equal(snapshot.files.size, 10000);
  assert.deepEqual([...snapshot.files.keys()], order.slice(0, 10000));
  assert.equal(snapshot.truncated, true);
  assert.equal(snapshot.traversalComplete, false);
  await rm(join(root, order[10000]));
  const exact = await captureWorkspaceSnapshot(root);
  assert.equal(exact.files.size, 10000);
  assert.equal(exact.truncated, false);
}));

test('workspace snapshot respects 64 MiB aggregate and 1 MiB individual boundaries', async () => fixture(async (root) => {
  const content = Buffer.alloc(1024 * 1024, 65);
  for (let i = 0; i < 65; i++) await writeFile(join(root, `${i}.txt`), content);
  const order = await orderedPaths(root);
  const snapshot = await captureWorkspaceSnapshot(root);
  assert.equal(snapshot.files.size, 64);
  assert.deepEqual([...snapshot.files.keys()], order.slice(0, 64));
  assert.equal(snapshot.truncated, true);
  assert.equal(snapshot.traversalComplete, false);
  assert.equal([...snapshot.files.values()].reduce((sum, text) => sum + Buffer.byteLength(text), 0), 64 * 1024 * 1024);
  await rm(join(root, order[64]));
  const exact = await captureWorkspaceSnapshot(root);
  assert.equal(exact.files.size, 64);
  assert.equal(exact.truncated, false);
}));
