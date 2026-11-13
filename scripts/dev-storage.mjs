import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Local build/cache paths only. Never relocates account or conversation data. */
export function developmentEnvironment(base = process.env) {
  const file = join(workspace, '.nautilo-dev.local.json');
  const local = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const env = { ...base };
  for (const key of ['RUSTUP_HOME', 'CARGO_HOME', 'CARGO_TARGET_DIR', 'RUSTUP_TOOLCHAIN', 'NAUTILO_DEV_STORAGE', 'NAUTILO_MINGW_DIR']) {
    if (!env[key] && typeof local[key] === 'string') env[key] = local[key];
  }

  if (env.NAUTILO_DEV_STORAGE) {
    const root = resolve(workspace, env.NAUTILO_DEV_STORAGE);
    const directories = {
      TEMP: join(root, 'tmp'),
      TMP: join(root, 'tmp'),
      NODE_COMPILE_CACHE: join(root, 'node-compile-cache'),
      ELECTRON_CACHE: join(root, 'electron-cache'),
      ELECTRON_BUILDER_CACHE: join(root, 'electron-builder-cache'),
      npm_config_cache: join(root, 'npm'),
      NAUTILO_DEV_LOG_DIR: join(root, 'logs'),
    };
    for (const [key, path] of Object.entries(directories)) {
      mkdirSync(path, { recursive: true });
      env[key] = path;
    }
  }
  return env;
}
