import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildRust, run, workspace } from './rust-build.mjs';
import { copyAccountNotices } from './copy-account-notices.mjs';
try {
  const env=await buildRust();
  const target=env.CARGO_TARGET_DIR?resolve(workspace,env.CARGO_TARGET_DIR):join(workspace,'rust','target');
  const nativeBuild = join(target, 'x86_64-pc-windows-gnu', 'debug');
  const binary=join(nativeBuild,process.platform==='win32'?'nautilo-core.exe':'nautilo-core');
  if(!existsSync(binary))throw new Error(`Rust backend not found: ${binary}`);
  copyAccountNotices(nativeBuild);
  env.AGENTHUB_CORE_PATH=binary;
  env.AGENTHUB_DEV_PLUGIN_DIR=join(workspace,'rust','plugins');
  env.AGENTHUB_NODE_PATH=process.execPath;
  const pnpm=process.env.npm_execpath;
  if(!pnpm || !existsSync(pnpm))throw new Error('请从项目根目录运行 pnpm dev:desktop。');
  await run(process.execPath,[pnpm,'build'],{cwd:workspace,env});
  console.log('Starting Nautilo preview: Electron + Rust');
  const desktopArgs = process.platform === 'win32'
    ? [join(workspace, 'scripts', 'start-desktop-preview.mjs')]
    : [pnpm, '--filter', '@agenthub/desktop', 'dev'];
  await run(process.execPath,desktopArgs,{cwd:workspace,env});
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
