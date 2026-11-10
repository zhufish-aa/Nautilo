import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildRust, run, workspace } from './rust-build.mjs';
try {
  const env=await buildRust();
  const target=env.CARGO_TARGET_DIR?resolve(workspace,env.CARGO_TARGET_DIR):join(workspace,'rust','target');
  const binary=join(target,'x86_64-pc-windows-gnu','debug',process.platform==='win32'?'nautilo-core.exe':'nautilo-core');
  if(!existsSync(binary))throw new Error(`Rust backend not found: ${binary}`);
  const runtime=join(target,'nautilo-preview',String(Date.now()));mkdirSync(runtime,{recursive:true});
  const core=join(runtime,process.platform==='win32'?'nautilo-core.exe':'nautilo-core');copyFileSync(binary,core);
  env.AGENTHUB_CORE_PATH=core;
  const pluginRoot=join(runtime,'plugins');mkdirSync(pluginRoot,{recursive:true});
  for(const id of ['opencode','trae','pi','omp','commandcode','deepseek','codex-plugins']) {
    const plugin=join(pluginRoot,id);mkdirSync(plugin,{recursive:true});
    const executable=`agenthub-plugin-${id}${process.platform==='win32'?'.exe':''}`;
    copyFileSync(join(workspace,'rust','plugins',id,'agenthub-plugin.json'),join(plugin,'agenthub-plugin.json'));
    copyFileSync(join(target,'x86_64-pc-windows-gnu','debug',executable),join(plugin,executable));
  }
  env.AGENTHUB_DEV_PLUGIN_DIR=pluginRoot;
  env.AGENTHUB_NODE_PATH=process.execPath;
  const pnpm=process.env.npm_execpath;
  if(!pnpm || !existsSync(pnpm))throw new Error('请从项目根目录运行 pnpm dev:desktop。');
  await run(process.execPath,[pnpm,'build'],{cwd:workspace,env});
  console.log('Starting Nautilo preview: Electron + Rust');
  await run(process.execPath,[pnpm,'--filter','@agenthub/desktop','dev'],{cwd:workspace,env});
}catch(error){console.error(error.message);process.exitCode=1;}
