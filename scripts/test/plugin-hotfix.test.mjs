import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { assembleHotfix, compareVersions, hotfixOptions, hotfixPlatforms, hotfixPlugins, packageHotfix, verifyHandshake, verifyNativeBinary } from '../plugin-hotfix.mjs';

const sourceCommit = 'a'.repeat(40);
function fakeBinary(platform) {
  const bytes = Buffer.alloc(128);
  if (platform === 'win32-x64') {
    bytes.write('MZ'); bytes.writeUInt32LE(64, 60); bytes.writeUInt32LE(0x4550, 64); bytes.writeUInt16LE(0x8664, 68);
  } else if (platform === 'linux-x64') {
    Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]).copy(bytes); bytes.writeUInt16LE(62, 18);
  } else {
    bytes.writeUInt32LE(0xfeedfacf, 0); bytes.writeUInt32LE(platform === 'darwin-x64' ? 0x01000007 : 0x0100000c, 4);
  }
  return bytes;
}
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'nautilo-hotfix-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binaries = join(root, 'bin'), input = join(root, 'input'), output = join(root, 'output');
  mkdirSync(binaries);
  for (const id of hotfixPlugins) {
    const directory = join(root, 'rust/plugins', id);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'agenthub-plugin.json'), JSON.stringify({ id, apiVersion: 1, main: `agenthub-plugin-${id}`, version: '0.2.16', descriptor: { name: id, vendor: id } }));
  }
  writeFileSync(join(root, 'package.json'), '{"version":"0.2.16"}\n');
  const registryPath = join(root, 'registry.json');
  const registry = { schemaVersion: 1, plugins: [
    { id: 'unrelated', version: '0.2.15', platforms: { 'linux-x64': { tarball: 'unchanged', sha256: 'unchanged' } }, custom: ['keep'] },
    ...hotfixPlugins.map(id => ({ id, name: id, version: '0.2.15', minAppVersion: '0.2.15', custom: 'preserved' })),
  ] };
  writeFileSync(registryPath, JSON.stringify(registry));
  const options = hotfixOptions();
  const packageAll = () => {
    for (const platform of hotfixPlatforms) {
      for (const id of hotfixPlugins) writeFileSync(join(binaries, `agenthub-plugin-${id}${platform === 'win32-x64' ? '.exe' : ''}`), fakeBinary(platform));
      packageHotfix({ root, binaryDirectory: binaries, output: input, platform, sourceCommit, options });
    }
  };
  const assemble = () => assembleHotfix({ input, output, registryPath, sourceCommit, options });
  return { root, binaries, input, output, registryPath, registry, options, packageAll, assemble };
}

test('hotfix version, platform and URL policy is independent of the app', () => {
  const options = hotfixOptions();
  assert.equal(options.pluginVersion, '0.2.17');
  assert.equal(options.minAppVersion, '0.2.16');
  assert.equal(options.repository, 'zhufish-aa/nautilo-provider-registry');
  assert.equal(options.tag, 'plugins-v0.2.17');
  assert.equal(compareVersions('0.2.17', '0.2.16'), 1);
  assert.throws(() => hotfixOptions({ version: '0.2.16-hotfix.1' }), /numeric/);
  assert.throws(() => hotfixOptions({ 'release-tag': 'v0.2.17' }), /plugins-/);
  assert.throws(() => hotfixOptions({ 'release-repository': 'x/y/../z' }), /repository/);
  assert.throws(() => hotfixOptions({ 'min-app-version': '0.2.18' }), /minimum/);
  assert.equal(hotfixOptions({ 'release-repository': 'example/plugins', 'release-tag': 'plugins-fix-1' }).repository, 'example/plugins');
});

test('packages eight native archives, preserves source/app and unrelated registry entries', t => {
  const f = fixture(t);
  f.packageAll();
  const candidate = f.assemble();
  assert.equal(readdirSync(f.output).filter(name => name.endsWith('.tgz')).length, 8);
  assert.equal(readFileSync(join(f.root, 'package.json'), 'utf8'), '{"version":"0.2.16"}\n');
  for (const id of hotfixPlugins) assert.equal(JSON.parse(readFileSync(join(f.root, 'rust/plugins', id, 'agenthub-plugin.json'))).version, '0.2.16');
  assert.deepEqual(candidate.plugins[0], f.registry.plugins[0]);
  assert.equal(candidate.schemaVersion, 1);
  for (const entry of candidate.plugins.slice(1)) {
    assert.equal(entry.version, '0.2.17');
    assert.equal(entry.minAppVersion, '0.2.16');
    assert.equal(entry.custom, 'preserved');
    assert.deepEqual(Object.keys(entry.platforms).sort(), [...hotfixPlatforms].sort());
    assert.equal(entry.tarball, entry.platforms['win32-x64'].tarball);
    assert(entry.tarball.startsWith('https://github.com/zhufish-aa/nautilo-provider-registry/releases/download/plugins-v0.2.17/'));
  }
  assert.deepEqual(JSON.parse(readFileSync(f.registryPath)), f.registry);
  const sums = readFileSync(join(f.output, 'SHA256SUMS.txt'), 'utf8').trim().split('\n');
  assert.equal(sums.length, 10);
  assert(sums.every(line => /^[a-f0-9]{64}  [^/]+$/.test(line)));
  const archive = 'nautilo-plugin-pi-0.2.17-linux-x64.tgz';
  const listing = spawnSync('tar', ['-tvzf', archive], { cwd: f.output, encoding: 'utf8' });
  assert.equal(listing.status, 0, listing.stderr);
  if (process.platform !== 'win32') assert.match(listing.stdout, /-rwxr-xr-x.*pi\/agenthub-plugin-pi/);
  assert.throws(() => f.assemble(), /new or empty/);
});

test('rejects wrong architectures and unsafe/unsupported package selections', t => {
  const f = fixture(t);
  for (const platform of hotfixPlatforms) verifyNativeBinary(fakeBinary(platform), platform);
  assert.throws(() => verifyNativeBinary(fakeBinary('linux-x64'), 'darwin-arm64'), /Mach-O/);
  assert.throws(() => verifyNativeBinary(Buffer.alloc(2), 'win32-x64'), /truncated/);
  assert.throws(() => packageHotfix({ root: f.root, binaryDirectory: f.binaries, output: f.input, platform: 'linux-arm64', sourceCommit, options: f.options }), /Unsupported platform/);
});

test('release smoke requires the correct native handshake', () => {
  verifyHandshake('{"type":"ready","descriptor":{"providerId":"pi"}}\n', 'pi');
  assert.throws(() => verifyHandshake('', 'pi'), /handshake/);
  assert.throws(() => verifyHandshake('{"type":"ready","descriptor":{"providerId":"trae"}}\n', 'pi'), /handshake/);
  assert.throws(() => verifyHandshake('{"type":"ready","descriptor":{"providerId":"pi"}}\n{"type":"error"}\n', 'pi'), /error/);
});

for (const [name, mutate, pattern] of [
  ['corrupt archive', f => writeFileSync(join(f.input, 'nautilo-plugin-pi-0.2.17-linux-x64.tgz'), 'corrupt'), /Checksum/],
  ['missing platform', f => rmSync(join(f.input, 'plugins-darwin-arm64.json')), /ENOENT/],
  ['mixed commits', f => { const file = join(f.input, 'plugins-linux-x64.json'); const index = JSON.parse(readFileSync(file)); index.sourceCommit = 'b'.repeat(40); writeFileSync(file, JSON.stringify(index)); }, /Wrong source/],
  ['duplicate plugin', f => { const file = join(f.input, 'plugins-linux-x64.json'); const index = JSON.parse(readFileSync(file)); index.plugins[1] = index.plugins[0]; writeFileSync(file, JSON.stringify(index)); }, /duplicate/],
  ['desktop release URL', f => { const file = join(f.input, 'plugins-linux-x64.json'); const index = JSON.parse(readFileSync(file)); index.plugins[0].tarball = 'https://github.com/zhufish-aa/Nautilo/releases/download/v0.2.16/plugin.tgz'; writeFileSync(file, JSON.stringify(index)); }, /release URL/],
  ['already published version', f => { const registry = JSON.parse(readFileSync(f.registryPath)); registry.plugins[1].version = '0.2.17'; writeFileSync(f.registryPath, JSON.stringify(registry)); }, /must increase/],
]) test(`assembly rejects ${name} without producing a candidate`, t => {
  const f = fixture(t); f.packageAll(); mutate(f);
  assert.throws(() => f.assemble(), pattern);
  assert(!existsSync(f.output));
});

test('workflow only triggers plugin branches and never publishes or builds desktop', () => {
  const text = readFileSync(new URL('../../.github/workflows/plugin-hotfix.yml', import.meta.url), 'utf8');
  assert.match(text, /branches: \['release\/plugins-pi-trae-\*'\]/);
  assert(!/contents: write|action-gh-release|build:desktop|electron-builder|--workspace|assemble-release|package-native-plugins/.test(text));
  assert.equal((text.match(/platform: (win32-x64|darwin-x64|darwin-arm64|linux-x64)/g) ?? []).length, 4);
  assert(text.indexOf('plugin-hotfix.mjs build') < text.indexOf('actions/upload-artifact'));
  assert.match(text, /actions\/attest-build-provenance@v2/);
});
