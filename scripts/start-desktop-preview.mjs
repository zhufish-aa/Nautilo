import { createReadStream, createWriteStream, mkdirSync } from 'node:fs';
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { developmentEnvironment } from './dev-storage.mjs';

Object.assign(process.env, developmentEnvironment());

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const desktopRequire = createRequire(join(workspace, 'apps', 'desktop', 'package.json'));

async function prepareElectron() {
  const packagePath = desktopRequire.resolve('electron/package.json');
  const { version } = JSON.parse(await readFile(packagePath, 'utf8'));
  const source = join(dirname(packagePath), 'dist');
  if (!process.env.AGENTHUB_CORE_PATH) throw new Error('The Rust runtime path is not configured. Use the CMD launcher.');
  const target = join(dirname(process.env.AGENTHUB_CORE_PATH), `electron-${version}`);
  const marker = join(target, '.nautilo-runtime-ready');
  try {
    if ((await readFile(marker, 'utf8')).trim() === version) {
      await access(join(target, 'electron.exe'));
      return target;
    }
  } catch { /* Prepare the versioned runtime once, before starting Electron. */ }
  console.log(`Preparing Electron ${version}: ${target}`);
  async function extract(from, to) {
    await mkdir(to, { recursive: true });
    for (const item of await readdir(from, { withFileTypes: true })) {
      const input = join(from, item.name), output = join(to, item.name);
      if (item.isDirectory()) await extract(input, output);
      else if (item.isFile()) {
        // Write file data into freshly created cache files. Do not copy the
        // checkout's inherited Windows ACLs or modify any existing ACL.
        await pipeline(createReadStream(input), createWriteStream(output));
      } else throw new Error(`Unexpected Electron runtime entry: ${input}`);
    }
  }
  await extract(source, target);
  await writeFile(marker, version, 'utf8');
  return target;
}

const electronRuntime = await prepareElectron();
if (process.argv.includes('--prepare-only')) process.exit(0);
const logs = process.env.NAUTILO_DEV_LOG_DIR
  ? join(process.env.NAUTILO_DEV_LOG_DIR, 'startup')
  : join(workspace, 'work', 'startup');
mkdirSync(logs, { recursive: true });
const logPath = join(logs, 'latest.log');
const electronLog = join(logs, 'electron.log');
const traceLog = join(logs, 'phases.log');
await writeFile(traceLog, '', 'utf8');
const desktop = join(workspace, 'apps', 'desktop');
const log = createWriteStream(logPath, { flags: 'w' });
const env = {
  ...process.env,
  // electron-vite 2.x resolves its executable directly and does not use the
  // Electron npm package's ELECTRON_OVERRIDE_DIST_PATH override.
  ELECTRON_EXEC_PATH: join(electronRuntime, 'electron.exe'),
  ELECTRON_OVERRIDE_DIST_PATH: electronRuntime,
  NAUTILO_STARTUP_TRACE: traceLog,
  ELECTRON_ENTRY: desktop,
  ELECTRON_ENABLE_LOGGING: '1',
  ELECTRON_ENABLE_STACK_DUMPING: '1',
  ELECTRON_LOG_FILE: electronLog,
};
// Diagnostic switches only. Keep the normal sandbox, GPU and user profile.
const args = JSON.parse(env.ELECTRON_CLI_ARGS || '[]');
env.ELECTRON_CLI_ARGS = JSON.stringify([...args, '--enable-logging=file', `--log-file=${electronLog}`]);
console.log(`Startup log: ${logPath}`);
console.log(`Electron log: ${electronLog}`);
console.log(`Electron executable: ${env.ELECTRON_EXEC_PATH}`);
log.write(`Nautilo startup ${new Date().toISOString()}\n`);
log.write(`Electron executable: ${env.ELECTRON_EXEC_PATH}\n`);
const child = spawn('pnpm --filter @agenthub/desktop dev', {
  cwd: workspace, env, shell: true, windowsHide: true,
  stdio: ['inherit', 'pipe', 'pipe'],
});
child.stdout.on('data', chunk => { process.stdout.write(chunk); log.write(chunk); });
child.stderr.on('data', chunk => { process.stderr.write(chunk); log.write(chunk); });
let spawnError;
child.once('error', error => { spawnError = error; console.error(error.message); log.write(`${error.stack}\n`); });
child.once('close', (code, signal) => {
  // Windows exception statuses can be signed negative values. Preserve their
  // hex value for diagnosis and return a conventional failure to the batch file.
  const status = `Exit: ${code ?? signal ?? 'unknown'}${code == null ? '' : ` (0x${(code >>> 0).toString(16).padStart(8, '0')})`}`;
  console.log(status);
  log.end(`${status}\n`);
  process.exitCode = code === 0 && !spawnError ? 0 : 1;
});
