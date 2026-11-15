import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import test from 'node:test';
import { prepareRustSources, sourceTreeHash } from '../prepare-rust-sources.mjs';

test('pinned sources: download, offline rebuild, concurrent access and tamper rejection', async t => {
  const temporary = mkdtempSync(join(tmpdir(), 'nautilo-source-test-'));
  t.after(() => {
    const child = relative(resolve(tmpdir()), resolve(temporary));
    assert.ok(child && child !== '..' && !child.startsWith(`..${sep}`) && !child.includes(':'));
    rmSync(temporary, { recursive: true, force: true });
  });
  const original = join(temporary, 'fixture-1.0.0');
  mkdirSync(join(original, 'src'), { recursive: true });
  const sourceFile = join(original, 'src/lib.rs');
  writeFileSync(sourceFile, 'original\n');
  const archivePath = join(temporary, 'fixture.crate');
  const tar = spawnSync('tar', ['-czf', archivePath, '-C', temporary, 'fixture-1.0.0'], { encoding: 'utf8', windowsHide: true });
  assert.equal(tar.status, 0, tar.stderr);
  const bytes = readFileSync(archivePath);
  const patchDirectory = join(temporary, 'patches');
  mkdirSync(patchDirectory);
  const patch = '--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -1 +1 @@\n-original\n+patched\n';
  writeFileSync(join(patchDirectory, 'fixture.patch'), patch);
  writeFileSync(sourceFile, 'patched\n');
  const expectedTree = sourceTreeHash(original);
  writeFileSync(join(patchDirectory, 'sources.json'), JSON.stringify([{
    name: 'fixture', version: '1.0.0', patch: 'fixture.patch',
    archiveSha256: createHash('sha256').update(bytes).digest('hex'),
    patchedTreeSha256: expectedTree,
  }]));
  let downloads = 0;
  t.mock.method(globalThis, 'fetch', async () => { downloads++; return new Response(bytes); });
  const vendorDirectory = join(temporary, 'generated');
  const options = { vendorDirectory, patchDirectory };
  await Promise.all([prepareRustSources(options), prepareRustSources(options)]);
  assert.equal(downloads, 1);
  assert.equal(readFileSync(join(vendorDirectory, 'fixture-1.0.0/src/lib.rs'), 'utf8'), 'patched\n');
  await prepareRustSources({ ...options, offline: true });
  assert.equal(downloads, 1);

  // A fresh tree can be reconstructed without network using the pinned archive.
  const offlineDirectory = join(temporary, 'offline');
  mkdirSync(join(offlineDirectory, '.archives'), { recursive: true });
  writeFileSync(join(offlineDirectory, '.archives/fixture-1.0.0.crate'), bytes);
  await prepareRustSources({ ...options, vendorDirectory: offlineDirectory, offline: true });
  assert.equal(sourceTreeHash(join(offlineDirectory, 'fixture-1.0.0')), expectedTree);
  assert.equal(downloads, 1);

  writeFileSync(join(vendorDirectory, 'fixture-1.0.0/src/lib.rs'), 'local changes\n');
  await assert.rejects(prepareRustSources(options), /local changes/);
  assert.equal(readFileSync(join(vendorDirectory, 'fixture-1.0.0/src/lib.rs'), 'utf8'), 'local changes\n');
  await assert.rejects(prepareRustSources({ ...options, vendorDirectory: join(temporary, 'missing'), offline: true }), /archive missing/);

  const corruptDirectory = join(temporary, 'corrupt');
  mkdirSync(join(corruptDirectory, '.archives'), { recursive: true });
  writeFileSync(join(corruptDirectory, '.archives/fixture-1.0.0.crate'), 'corrupt');
  await assert.rejects(prepareRustSources({ ...options, vendorDirectory: corruptDirectory, offline: true }), /checksum mismatch/);
  assert.equal(existsSync(join(corruptDirectory, 'fixture-1.0.0')), false);

  writeFileSync(join(patchDirectory, 'fixture.patch'), patch.replace('+patched\n', '+unexpected\n'));
  await assert.rejects(prepareRustSources({ ...options, vendorDirectory: join(temporary, 'bad-patch') }), /Patched source checksum mismatch/);
  assert.equal(existsSync(join(temporary, 'bad-patch/fixture-1.0.0')), false);
});
