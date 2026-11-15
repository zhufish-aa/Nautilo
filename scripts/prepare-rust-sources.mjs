import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export function sourceTreeHash(directory) {
  const digest = createHash('sha256');
  function walk(at) {
    for (const entry of readdirSync(at, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      if (entry.name === '.nautilo-source.json') continue;
      const file = join(at, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) digest.update(relative(directory, file).split(sep).join('/')).update('\0').update(readFileSync(file)).update('\0');
      else throw new Error(`Unexpected source entry: ${file}`);
    }
  }
  walk(directory);
  return digest.digest('hex');
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.stdout}`);
}

export async function prepareRustSources({
  vendorDirectory = join(root, 'rust/vendor/generated'),
  patchDirectory = join(root, 'rust/patches'),
  offline = false,
} = {}) {
  vendorDirectory = resolve(vendorDirectory);
  const sources = JSON.parse(readFileSync(join(patchDirectory, 'sources.json'), 'utf8'));
  mkdirSync(vendorDirectory, { recursive: true });
  // Serialize desktop/Android preparation; abandoned locks can be reclaimed.
  const lock = join(vendorDirectory, '.prepare-lock');
  const deadline = Date.now() + 120_000;
  while (true) {
    try {
      mkdirSync(lock);
      writeFileSync(join(lock, 'pid'), String(process.pid));
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const pid = Number(readFileSync(join(lock, 'pid'), 'utf8'));
        if (pid > 0) process.kill(pid, 0);
      } catch (ownerError) {
        if (ownerError.code === 'ESRCH') { removeGenerated(lock); continue; }
      }
      if (Date.now() > deadline) throw new Error(`Timed out waiting for source preparation: ${lock}`);
      await delay(100);
    }
  }
  function removeGenerated(target) {
    const child = relative(vendorDirectory, resolve(target));
    if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) throw new Error(`Unsafe generated path: ${target}`);
    rmSync(target, { recursive: true, force: true });
  }
  try {
    for (const source of sources) {
      const directory = `${source.name}-${source.version}`;
      if (!/^[a-z0-9.-]+$/.test(directory)) throw new Error(`Invalid source directory: ${directory}`);
      const destination = join(vendorDirectory, directory);
      if (existsSync(destination)) {
        const actual = sourceTreeHash(destination);
        if (actual === source.patchedTreeSha256) continue;
        const stamp = join(destination, '.nautilo-source.json');
        if (!existsSync(stamp) || actual !== JSON.parse(readFileSync(stamp, 'utf8')).treeSha256) {
          throw new Error(`Generated dependency has local changes; move it aside before rebuilding: ${destination}`);
        }
      }
      const cache = join(vendorDirectory, '.archives');
      const archive = join(cache, `${directory}.crate`);
      mkdirSync(cache, { recursive: true });
      if (!existsSync(archive)) {
        if (offline) throw new Error(`Offline source archive missing: ${archive}`);
        const url = `https://static.crates.io/crates/${source.name}/${directory}.crate`;
        console.log(`Downloading pinned source: ${directory}`);
        const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
        if (!response.ok) throw new Error(`Source download failed (${response.status}): ${url}`);
        const bytes = Buffer.from(await response.arrayBuffer());
        if (sha256(bytes) !== source.archiveSha256) throw new Error(`Source checksum mismatch: ${directory}`);
        writeFileSync(archive, bytes);
      }
      if (sha256(readFileSync(archive)) !== source.archiveSha256) throw new Error(`Cached source checksum mismatch: ${archive}`);
      const stage = mkdtempSync(join(vendorDirectory, '.prepare-'));
      try {
        run('tar', ['-xzf', archive, '-C', stage], root);
        const extracted = join(stage, directory);
        run('git', ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'apply', '--no-index', '--', resolve(patchDirectory, source.patch)], extracted);
        for (const [name, file] of Object.entries(source.additionalFiles ?? {})) {
          if (!/^[A-Z0-9-]+$/.test(name)) throw new Error(`Invalid additional source file: ${name}`);
          writeFileSync(join(extracted, name), readFileSync(resolve(patchDirectory, file)));
        }
        if (sourceTreeHash(extracted) !== source.patchedTreeSha256) throw new Error(`Patched source checksum mismatch: ${directory}`);
        writeFileSync(join(extracted, '.nautilo-source.json'), JSON.stringify({ treeSha256: source.patchedTreeSha256 }) + '\n');
        if (existsSync(destination)) removeGenerated(destination);
        renameSync(extracted, destination);
        console.log(`Prepared patched source: ${directory}`);
      } finally {
        removeGenerated(stage);
      }
    }
  } finally {
    removeGenerated(lock);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await prepareRustSources({ offline: process.argv.includes('--offline') }); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
