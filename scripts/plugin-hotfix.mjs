import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { nativeTargets } from './native-packaging.mjs';
import { rustEnvironment, workspace } from './rust-build.mjs';
import { prepareRustSources } from './prepare-rust-sources.mjs';

// This entry point deliberately never calls the desktop/workspace build or
// publication scripts. Only these two plugin packages may be released here.
export const hotfixPlugins = ['pi', 'trae'];
export const hotfixPlatforms = Object.keys(nativeTargets);
const descriptions = {
  pi: { 'zh-CN': '接入 Pi coding agent，支持会话恢复与原生扩展。', 'en-US': 'Use Pi coding agent with session resume and native extensions.' },
  trae: { 'zh-CN': '接入开源 trae-agent 和 Trae CLI。', 'en-US': 'Use open-source trae-agent and Trae CLI.' },
};
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (${result.status}): ${result.stderr ?? ''}`);
  return result.stdout?.trim();
}
function version(value) {
  assert.match(value, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, 'Use a numeric major.minor.patch version; the marketplace does not compare prerelease labels');
  assert(value.split('.').every(part => Number.isSafeInteger(Number(part))), 'Version component is too large');
  return value;
}
export function compareVersions(a, b) {
  const left = version(a).split('.').map(Number), right = version(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return Math.sign(left[i] - right[i]);
  return 0;
}
export function hotfixOptions(values = {}) {
  const pluginVersion = version(values.version ?? '0.2.17');
  const minAppVersion = version(values['min-app-version'] ?? '0.2.16');
  assert(compareVersions(pluginVersion, minAppVersion) >= 0, 'Plugin version precedes the minimum app version');
  const repository = values['release-repository'] ?? 'zhufish-aa/nautilo-provider-registry';
  assert.match(repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'Invalid release repository');
  const tag = values['release-tag'] ?? `plugins-v${pluginVersion}`;
  assert.match(tag, /^plugins-[A-Za-z0-9][A-Za-z0-9._-]*$/, 'Use a plugins-* tag, never a desktop v* or build-v* tag');
  return { pluginVersion, minAppVersion, repository, tag };
}
function archiveName(id, options, platform) { return `nautilo-plugin-${id}-${options.pluginVersion}-${platform}.tgz`; }
function archiveUrl(name, options) { return `https://github.com/${options.repository}/releases/download/${options.tag}/${name}`; }
function validateSourceCommit(commit) { assert.match(commit, /^[a-f0-9]{40}$/, 'A full source commit is required'); }

export function verifyNativeBinary(bytes, platform) {
  assert(bytes.length >= 64, `Empty/truncated native binary for ${platform}`);
  if (platform === 'linux-x64') {
    assert(bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) && bytes[4] === 2 && bytes[5] === 1 && bytes.readUInt16LE(18) === 62, 'Expected an x64 ELF binary');
  } else if (platform === 'win32-x64') {
    const pe = bytes.readUInt32LE(60);
    assert(bytes.toString('ascii', 0, 2) === 'MZ' && pe <= bytes.length - 6 && bytes.readUInt32LE(pe) === 0x4550 && bytes.readUInt16LE(pe + 4) === 0x8664, 'Expected an x64 PE binary');
  } else {
    assert(['darwin-x64', 'darwin-arm64'].includes(platform), `Unsupported platform: ${platform}`);
    assert(bytes.readUInt32LE(0) === 0xfeedfacf && bytes.readUInt32LE(4) === (platform === 'darwin-x64' ? 0x01000007 : 0x0100000c), `Expected a ${platform} Mach-O binary`);
  }
}

export function verifyHandshake(output, id) {
  const frames = output.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  assert(frames.some(frame => frame.type === 'ready' && frame.descriptor?.providerId === id), `Plugin ${id} did not complete its API v1 handshake`);
  assert(!frames.some(frame => frame.type === 'error'), `Plugin ${id} reported a handshake error`);
}

export function packageHotfix({ root = workspace, binaryDirectory, output, platform, sourceCommit, options }) {
  assert(hotfixPlatforms.includes(platform), `Unsupported platform: ${platform}`);
  validateSourceCommit(sourceCommit);
  mkdirSync(output, { recursive: true });
  const expected = hotfixPlugins.map(id => archiveName(id, options, platform));
  for (const name of [...expected, `plugins-${platform}.json`]) assert(!existsSync(join(output, name)), `Refusing to replace existing artifact: ${name}`);
  const stage = mkdtempSync(join(tmpdir(), 'nautilo-plugin-hotfix-'));
  try {
    const plugins = hotfixPlugins.map(id => {
      const manifest = json(join(root, 'rust/plugins', id, 'agenthub-plugin.json'));
      assert(manifest.id === id && manifest.apiVersion === 1 && manifest.main === `agenthub-plugin-${id}`, `Unexpected ${id} manifest`);
      assert(compareVersions(options.pluginVersion, manifest.version) >= 0, `Refusing to downgrade ${id}`);
      const executable = `${manifest.main}${platform === 'win32-x64' ? '.exe' : ''}`;
      const binary = join(binaryDirectory, executable);
      verifyNativeBinary(readFileSync(binary), platform);
      const directory = join(stage, id);
      mkdirSync(directory);
      // Only the staged manifest changes; application and source versions stay put.
      writeJson(join(directory, 'agenthub-plugin.json'), { ...manifest, version: options.pluginVersion, minAppVersion: options.minAppVersion });
      copyFileSync(binary, join(directory, executable));
      chmodSync(join(directory, executable), 0o755);
      const name = archiveName(id, options, platform);
      // Relative output name avoids GNU tar interpreting a Windows drive as a host.
      run('tar', ['-czf', name, '-C', stage, id], { cwd: output });
      const sha256 = digest(readFileSync(join(output, name)));
      return { id, name: manifest.descriptor.name, vendor: manifest.descriptor.vendor, version: options.pluginVersion, minAppVersion: options.minAppVersion,
        description: descriptions[id], tarball: archiveUrl(name, options), sha256 };
    });
    const index = { platform, sourceCommit, releaseRepository: options.repository, releaseTag: options.tag, plugins };
    writeJson(join(output, `plugins-${platform}.json`), index);
    return index;
  } finally { rmSync(stage, { recursive: true, force: true }); }
}

export function assembleHotfix({ input, output, registryPath, sourceCommit, options }) {
  validateSourceCommit(sourceCommit);
  assert(!existsSync(output) || readdirSync(output).length === 0, 'Assembly output must be a new or empty directory');
  assert(resolve(input) !== resolve(output), 'Assembly output must differ from input');
  const registryBytes = readFileSync(registryPath), registry = JSON.parse(registryBytes);
  assert(Array.isArray(registry.plugins), 'Registry must contain a plugins array');
  assert(new Set(registry.plugins.map(item => item.id)).size === registry.plugins.length, 'Duplicate registry plugin IDs');
  const replacements = new Map(), files = [];
  for (const platform of hotfixPlatforms) {
    const index = json(join(input, `plugins-${platform}.json`));
    assert(index.platform === platform && index.sourceCommit === sourceCommit && index.releaseRepository === options.repository && index.releaseTag === options.tag, `Wrong source/platform/release: ${platform}`);
    assert(Array.isArray(index.plugins) && index.plugins.length === hotfixPlugins.length && new Set(index.plugins.map(item => item.id)).size === hotfixPlugins.length, `Incomplete or duplicate plugins: ${platform}`);
    for (const plugin of index.plugins) {
      assert(hotfixPlugins.includes(plugin.id) && plugin.version === options.pluginVersion && plugin.minAppVersion === options.minAppVersion, `Unexpected plugin/version: ${plugin.id}`);
      const name = archiveName(plugin.id, options, platform), archive = join(input, name);
      assert(plugin.tarball === archiveUrl(name, options), `Unexpected release URL: ${name}`);
      assert.match(plugin.sha256, /^[a-f0-9]{64}$/, `Invalid checksum: ${name}`);
      assert(digest(readFileSync(archive)) === plugin.sha256, `Checksum mismatch: ${name}`);
      // Verify actual package membership and manifest, not just a trusted index.
      const listing = run('tar', ['-tzf', name], { cwd: input }).split(/\r?\n/).map(item => item.replace(/^\.\//, '')).filter(item => !item.endsWith('/')).sort();
      const executable = `agenthub-plugin-${plugin.id}${platform === 'win32-x64' ? '.exe' : ''}`;
      assert.deepEqual(listing, [`${plugin.id}/agenthub-plugin.json`, `${plugin.id}/${executable}`].sort(), `Unexpected archive files: ${name}`);
      const manifest = JSON.parse(run('tar', ['-xOzf', name, `${plugin.id}/agenthub-plugin.json`], { cwd: input }));
      assert(manifest.id === plugin.id && manifest.apiVersion === 1 && manifest.main === `agenthub-plugin-${plugin.id}` && manifest.version === options.pluginVersion && manifest.minAppVersion === options.minAppVersion, `Archive manifest mismatch: ${name}`);
      const metadata = { ...plugin }; delete metadata.tarball; delete metadata.sha256;
      const previous = replacements.get(plugin.id);
      if (previous) assert.deepEqual(previous.metadata, metadata, `Platform metadata mismatch: ${plugin.id}`);
      const entry = previous ?? { metadata, platforms: {} };
      entry.platforms[platform] = { tarball: plugin.tarball, sha256: plugin.sha256 };
      replacements.set(plugin.id, entry);
      files.push({ name, sha256: plugin.sha256 });
    }
  }
  for (const id of hotfixPlugins) {
    const current = registry.plugins.find(plugin => plugin.id === id);
    assert(current, `Existing marketplace entry required: ${id}`);
    assert(compareVersions(options.pluginVersion, current.version) > 0, `Marketplace version must increase: ${id}`);
  }
  const candidate = { ...registry, plugins: registry.plugins.map(current => {
    const replacement = replacements.get(current.id);
    return replacement ? { ...current, ...replacement.metadata, ...replacement.platforms['win32-x64'], platforms: replacement.platforms } : current;
  }) };
  mkdirSync(output, { recursive: true });
  for (const file of files) copyFileSync(join(input, file.name), join(output, file.name));
  writeJson(join(output, 'registry.candidate.json'), candidate);
  writeJson(join(output, 'plugin-hotfix-manifest.json'), { sourceCommit, ...options, baseRegistrySha256: digest(registryBytes), plugins: hotfixPlugins, platforms: hotfixPlatforms, artifacts: files });
  const names = [...files.map(file => file.name), 'registry.candidate.json', 'plugin-hotfix-manifest.json'].sort();
  writeFileSync(join(output, 'SHA256SUMS.txt'), names.map(name => `${digest(readFileSync(join(output, name)))}  ${name}`).join('\n') + '\n', { flag: 'wx' });
  return candidate;
}

async function main() {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: Object.fromEntries(['version', 'min-app-version', 'release-repository', 'release-tag', 'platform', 'binary-directory', 'output', 'input', 'registry', 'source-commit'].map(name => [name, { type: 'string' }])) });
  const [command] = positionals;
  assert(positionals.length === 1 && ['build', 'package', 'assemble'].includes(command), 'Usage: node scripts/plugin-hotfix.mjs build|package|assemble [--version 0.2.17 --min-app-version 0.2.16 ...]');
  const options = hotfixOptions({
    version: process.env.PLUGIN_VERSION,
    'min-app-version': process.env.MIN_APP_VERSION,
    'release-repository': process.env.RELEASE_REPOSITORY,
    ...values,
  });
  const sourceCommit = values['source-commit'] ?? run('git', ['rev-parse', 'HEAD'], { cwd: workspace });
  const output = resolve(workspace, values.output ?? `release/plugin-hotfix/${options.pluginVersion}`);
  if (command === 'assemble') {
    assert(values.input && values.registry, 'assemble requires --input and --registry');
    assembleHotfix({ input: resolve(values.input), output, registryPath: resolve(values.registry), sourceCommit, options });
  } else {
    const platform = values.platform ?? `${process.platform}-${process.arch}`;
    assert(hotfixPlatforms.includes(platform), `Unsupported platform: ${platform}`);
    const env = rustEnvironment(), target = nativeTargets[platform];
    const targetDirectory = env.CARGO_TARGET_DIR ? resolve(workspace, env.CARGO_TARGET_DIR) : join(workspace, 'rust/target');
    if (command === 'build') {
      assert(platform === `${process.platform}-${process.arch}`, 'Build and test on the native target runner');
      assert(!values['binary-directory'], 'build cannot package an unrelated binary directory');
      run('cargo', ['--version'], { env }); // Fail before downloads if Rust is absent.
      await prepareRustSources(); // Cargo resolves workspace path patches even for -p.
      const packages = hotfixPlugins.flatMap(id => ['-p', `agenthub-plugin-${id}`]);
      run('cargo', ['test', '--locked', '--target', target, ...packages, '--', '--test-threads=1'], { cwd: join(workspace, 'rust'), env, stdio: 'inherit' });
      run('cargo', ['build', '--release', '--locked', '--target', target, ...packages], { cwd: join(workspace, 'rust'), env, stdio: 'inherit' });
      for (const id of hotfixPlugins) {
        const executable = join(targetDirectory, target, 'release', `agenthub-plugin-${id}${platform === 'win32-x64' ? '.exe' : ''}`);
        verifyHandshake(run(executable, [], { cwd: workspace, env, input: '{"type":"handshake","apiVersion":1}\n', timeout: 10_000 }), id);
      }
    }
    packageHotfix({ binaryDirectory: values['binary-directory'] ? resolve(values['binary-directory']) : join(targetDirectory, target, 'release'), output, platform, sourceCommit, options });
  }
  console.log(`${command} completed: ${output}`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
