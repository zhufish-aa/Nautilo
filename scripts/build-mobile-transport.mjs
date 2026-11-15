// Rebuild the pinned SDK with Nautilo's QUIC STREAM path policy for every APK ABI.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const buildRoot = process.env.NAUTILO_ANDROID_BUILD_DIR || join(root, 'apps/mobile/build');
const cache = join(buildRoot, 'transport');
mkdirSync(cache, { recursive: true });
const env = { ...process.env, CARGO_TARGET_DIR: join(cache, 'target'), CARGO_BUILD_JOBS: '1', CARGO_INCREMENTAL: '0' };
for (const key of ['TEMP','TMP','TMPDIR']) env[key] = join(cache, 'tmp');
mkdirSync(env.TEMP, { recursive: true });
const isWindows = process.platform === 'win32';
function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, { cwd: root, env, windowsHide: true, stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${executable} failed (${result.status})`);
  return result;
}
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const source = join(root, 'apps/mobile/native/iroh-kmp');
const upstreamHash = '96641eca55a48aeb0341ab647e3a121000a1c8c7e617b1aa48b255aae3660217';
const upstream = process.env.NAUTILO_IROH_UPSTREAM_AAR || join(cache, 'iroh-kmp-upstream-0.2.1.aar');
if (!existsSync(upstream)) run(isWindows ? 'curl.exe' : 'curl', ['--fail','--location','--retry','2','--connect-timeout','15','--output',upstream,
  'https://repo.maven.apache.org/maven2/app/azula/iroh/iroh-kmp-android/0.2.1/iroh-kmp-android-0.2.1.aar']);
if (hash(upstream) !== upstreamHash) throw new Error('Upstream SDK AAR checksum mismatch');

const fingerprint = createHash('sha256').update(upstreamHash).update('opt1-codegen16-v1');
function addSources(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a,b)=>a.name.localeCompare(b.name))) {
    if (entry.name === 'target' || entry.name.startsWith('.')) continue;
    const file = join(directory, entry.name);
    if (entry.isDirectory()) addSources(file);
    else if (/\.(rs|toml)$|Cargo\.lock$/.test(entry.name)) fingerprint.update(file.slice(root.length)).update(readFileSync(file));
  }
}
for (const dir of [source, join(root,'rust/vendor/iroh-1.4.1'), join(root,'rust/vendor/noq-proto-1.4.0')]) addSources(dir);
const version = spawnSync('rustc', ['--version'], { env, encoding: 'utf8', windowsHide: true });
if (version.status !== 0) throw new Error('Rust toolchain is required to build the mobile transport');
fingerprint.update(version.stdout);
const key = fingerprint.digest('hex');
const output = join(cache, 'iroh-kmp-nautilo.aar');
const stamp = join(cache, 'build.json');
if (existsSync(stamp) && existsSync(output)) {
  const previous = JSON.parse(readFileSync(stamp, 'utf8'));
  if (previous.key === key && previous.sha256 === hash(output)) { console.log('Mobile QUIC transport is current'); process.exit(0); }
}

const sdk = env.ANDROID_HOME || env.ANDROID_SDK_ROOT;
let ndk = env.ANDROID_NDK_HOME || env.ANDROID_NDK_ROOT;
if (!ndk && sdk && existsSync(join(sdk,'ndk'))) {
  const dirs = readdirSync(join(sdk,'ndk')).filter(dir=>existsSync(join(sdk,'ndk',dir,'source.properties'))).sort().reverse();
  if (dirs.length) ndk = join(sdk,'ndk',dirs[0]);
}
if (!ndk) throw new Error('Set ANDROID_NDK_HOME to an Android NDK r28+ installation');
const host = isWindows ? 'windows-x86_64' : process.platform === 'darwin' ? 'darwin-x86_64' : 'linux-x86_64';
const llvm = join(ndk, 'toolchains/llvm/prebuilt', host, 'bin');
const abis = [
  ['arm64-v8a','aarch64-linux-android','aarch64-linux-android'],
  ['armeabi-v7a','armv7-linux-androideabi','armv7a-linux-androideabi'],
  ['x86_64','x86_64-linux-android','x86_64-linux-android']
];
// Cargo.lock is checked in with the local patches resolved.
for (const [abi, target, clangTarget] of abis) {
  console.log(`Building ${abi} QUIC transport`);
  const compiler = join(llvm, `${clangTarget}26-clang${isWindows ? '.cmd' : ''}`);
  const targetEnv = { ...env,
    [`CARGO_TARGET_${target.toUpperCase().replaceAll('-','_')}_LINKER`]: compiler,
    [`CC_${target.replaceAll('-','_')}`]: compiler,
    [`AR_${target.replaceAll('-','_')}`]: join(llvm, `llvm-ar${isWindows ? '.exe' : ''}`),
    CARGO_PROFILE_RELEASE_OPT_LEVEL:'1', CARGO_PROFILE_RELEASE_LTO:'false', CARGO_PROFILE_RELEASE_CODEGEN_UNITS:'16'
  };
  run('cargo',['build','--manifest-path',join(source,'Cargo.toml'),'--locked','--release','--target',target], { cwd: source, env: targetEnv });
}
const stage = join(cache, `aar-${key.slice(0,16)}`);
mkdirSync(stage, { recursive: true });
const jar = env.JAVA_HOME ? join(env.JAVA_HOME,'bin',isWindows ? 'jar.exe' : 'jar') : 'jar';
const listed = spawnSync(jar, ['tf',upstream], { env, encoding:'utf8', windowsHide:true });
if (listed.status !== 0) throw new Error('Cannot read upstream AAR');
const entries = listed.stdout.split(/\r?\n/).filter(name=>name && !name.endsWith('/') && !name.startsWith('jni/'));
if (entries.some(name=>name.startsWith('/') || name.split('/').includes('..'))) throw new Error('Invalid upstream archive path');
run(jar, ['xf',upstream,...entries], { cwd: stage });
for (const [abi,target] of abis) {
  const library = join(cache,'target',target,'release/libiroh_kmp.so');
  const symbols = spawnSync(join(llvm,isWindows ? 'llvm-nm.exe' : 'llvm-nm'), ['--dynamic','--defined-only',library], { env, encoding:'utf8', windowsHide:true });
  if (symbols.status !== 0 || !symbols.stdout.includes('Java_app_nautilo_mobile_transport_DirectTransportPolicy_setEnabledNative')) throw new Error(`${abi}: native direct policy is missing`);
  const destination = join(stage,'jni',abi);
  mkdirSync(destination,{recursive:true}); copyFileSync(library,join(destination,'libiroh_kmp.so'));
}
run(jar,['cf',output,'-C',stage,'.']);
writeFileSync(stamp,JSON.stringify({key,sha256:hash(output),upstreamSha256:upstreamHash,abis:abis.map(item=>item[0])},null,2)+'\n');
console.log(`Built ${output}`);
