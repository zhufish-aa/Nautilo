import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { developmentEnvironment } from './dev-storage.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Package the Electron shell and the matching native daemon/plugins together. */
export async function packageDesktop(targetNames) {
  const env = developmentEnvironment();
  Object.assign(process.env, env);
  const { version } = JSON.parse(readFileSync(join(root, 'apps/desktop/package.json'), 'utf8'));
  const storage = env.NAUTILO_DEV_STORAGE && resolve(root, env.NAUTILO_DEV_STORAGE);
  const packagingRoot = storage ? join(storage, 'packaging') : join(root, 'build');
  const staging = join(packagingRoot, `${process.platform}-${process.arch}-${version}`, 'resources');
  const output = resolve(env.NAUTILO_RELEASE_DIR || (storage ? join(storage, 'releases', version) : join(root, 'release')));
  mkdirSync(output, { recursive: true });
  await new Promise((accept, reject) => {
    const child = spawn(process.execPath, [join(root, 'scripts/prepare-packaged-resources.mjs'), staging], {
      cwd: root, env: { ...env, NAUTILO_PACKAGING_ROOT: packagingRoot }, windowsHide: true, stdio: 'inherit'
    });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? accept() : reject(new Error(`Native packaging failed (${code})`)));
  });

  const electronDist = env.NAUTILO_ELECTRON_DIST && resolve(env.NAUTILO_ELECTRON_DIST);
  if (electronDist && !existsSync(join(electronDist, process.platform === 'win32' ? 'electron.exe' : process.platform === 'darwin' ? 'Electron.app' : 'electron'))) {
    throw new Error(`Electron distribution is missing: ${electronDist}`);
  }
  const { build, Platform, Arch } = await import('electron-builder');
  const targets = targetNames?.length ? Platform.current().createTarget(targetNames, Arch[process.arch]) : undefined;
  // Local out/ may be a junction to the build drive. Builder's file collector
  // does not dereference that junction, so stage real files on the build drive.
  // Only copy the app payload; account data and development dependencies stay out.
  const appDirectory = mkdtempSync(join(packagingRoot, `${process.platform}-${process.arch}-${version}`, 'app-'));
  const desktopDirectory = join(root, 'apps/desktop');
  cpSync(join(desktopDirectory, 'out'), join(appDirectory, 'out'), { recursive: true, dereference: true });
  const metadata = JSON.parse(readFileSync(join(desktopDirectory, 'package.json'), 'utf8'));
  // Runtime imports are bundled and verified by electron.vite.config.ts.
  // These are build-time dependency declarations, not shipped node_modules.
  delete metadata.dependencies;
  delete metadata.devDependencies;
  delete metadata.scripts;
  writeFileSync(join(appDirectory, 'package.json'), JSON.stringify(metadata, null, 2));
  mkdirSync(join(appDirectory, 'resources'));
  cpSync(join(desktopDirectory, 'resources/nautilo-icon-512.png'), join(appDirectory, 'resources/nautilo-icon-512.png'));
  // Builder concatenates inherited resource arrays. Use a single complete
  // configuration so resources are not copied/signature-edited twice at once.
  const configFile = join(packagingRoot, `${process.platform}-${process.arch}-${version}`, 'electron-builder.yml');
  const baseConfig = readFileSync(join(root, 'electron-builder.yml'), 'utf8')
    .replace('from: build/packaged/core-daemon', `from: ${JSON.stringify(join(staging, 'core-daemon'))}`)
    .replace('from: build/packaged/plugins', `from: ${JSON.stringify(join(staging, 'plugins'))}`);
  writeFileSync(configFile, baseConfig);
  const artifacts = await build({
    projectDir: root,
    publish: 'never',
    ...(targets ? { targets } : {}),
    config: {
      extends: configFile,
      directories: { app: appDirectory, buildResources: join(desktopDirectory, 'resources'), output },
      ...(electronDist ? { electronDist } : {})
    }
  });
  console.log(JSON.stringify({ version, output, artifacts }, null, 2));
  return artifacts;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await packageDesktop();
