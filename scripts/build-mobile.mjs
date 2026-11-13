import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const windows = process.platform === 'win32';
const cache = process.env.NAUTILO_MOBILE_CACHE || (windows && existsSync('D:/') ? 'D:/CodexBuildCache/Nautilo/mobile' : join(homedir(), '.cache', 'nautilo-mobile'));
const gradleHome = process.env.GRADLE_USER_HOME || (windows && existsSync('D:/GradleHome') ? 'D:/GradleHome' : join(cache, 'gradle'));
const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || (windows ? join(process.env.LOCALAPPDATA, 'Android', 'Sdk') : join(homedir(), 'Android', 'Sdk'));
for (const path of [cache, gradleHome, join(cache, 'tmp'), join(cache, 'signing'), join(cache, 'artifacts')]) mkdirSync(path, { recursive: true });
if (!existsSync(join(sdk, 'platforms', 'android-35'))) throw new Error('Install Android SDK platform 35 and build-tools 35.0.0, then set ANDROID_HOME.');
const env = { ...process.env, ANDROID_HOME: sdk, GRADLE_USER_HOME: gradleHome, ANDROID_USER_HOME: join(cache, 'android'),
  NAUTILO_ANDROID_BUILD_DIR: process.env.NAUTILO_ANDROID_BUILD_DIR || join(cache, 'build'), TEMP: join(cache, 'tmp'), TMP: join(cache, 'tmp') };
const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') || 'PATH';
if (env.JAVA_HOME) env[pathKey] = join(env.JAVA_HOME, 'bin') + delimiter + env[pathKey];
function run(command, args, quiet = false, cwd = root) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, windowsHide: true, stdio: quiet ? 'ignore' : 'inherit' });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${command} failed (${code})`)));
  });
}
const signing = env.NAUTILO_ANDROID_SIGNING || join(cache, 'signing', 'release.properties');
if (!existsSync(signing)) {
  const store = join(cache, 'signing', 'nautilo-mobile.jks');
  if (existsSync(store)) throw new Error('Signing key already exists but its properties are missing. Restore the matching release.properties instead of replacing the key.');
  const password = randomBytes(32).toString('hex');
  env.NAUTILO_KEY_PASSWORD = password;
  const keytool = env.JAVA_HOME ? join(env.JAVA_HOME, 'bin', windows ? 'keytool.exe' : 'keytool') : 'keytool';
  await run(keytool, ['-genkeypair', '-keystore', store, '-storetype', 'JKS', '-alias', 'nautilo-mobile', '-keyalg', 'RSA', '-keysize', '3072', '-validity', '10000',
    '-storepass:env', 'NAUTILO_KEY_PASSWORD', '-keypass:env', 'NAUTILO_KEY_PASSWORD', '-dname', 'CN=Nautilo Mobile', '-noprompt'], true);
  writeFileSync(signing, `storeFile=${store.replaceAll('\\', '/') }\nstorePassword=${password}\nkeyAlias=nautilo-mobile\nkeyPassword=${password}\n`, { mode: 0o600 });
  delete env.NAUTILO_KEY_PASSWORD;
}
env.NAUTILO_ANDROID_SIGNING = signing;
const project = join(root, 'apps', 'mobile');
const args = ['--project-cache-dir', join(cache, 'project-cache'), ':app:assembleRelease', '--console=plain'];
if (windows) await run(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'gradlew.bat', ...args], false, project);
else await run('sh', [join(project, 'gradlew'), '-p', project, ...args]);
const input = join(env.NAUTILO_ANDROID_BUILD_DIR, 'app', 'outputs', 'apk', 'release', 'app-release.apk');
const version = readFileSync(join(project, 'app', 'build.gradle.kts'), 'utf8').match(/versionName\s*=\s*"([^"]+)"/)[1];
const output = join(cache, 'artifacts', `Nautilo-Mobile-${version}.apk`);
copyFileSync(input, output);
writeFileSync(output + '.sha256', createHash('sha256').update(readFileSync(output)).digest('hex') + '  ' + output.split(/[\\/]/).at(-1) + '\n');
console.log(`\nAPK: ${output}\nSigning configuration: ${signing}\nKeep the signing folder private and back it up for future updates.`);
