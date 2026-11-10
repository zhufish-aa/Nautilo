import { existsSync, readFileSync } from 'node:fs';
import { join, delimiter, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

export const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function rustEnvironment() {
  const env={...process.env};
  const localFile=join(workspace,'.nautilo-dev.local.json');
  const local=existsSync(localFile)?JSON.parse(readFileSync(localFile,'utf8')):{};
  for(const key of ['RUSTUP_HOME','CARGO_HOME','CARGO_TARGET_DIR','RUSTUP_TOOLCHAIN']) if(!env[key] && local[key]) env[key]=local[key];
  const pathKey=Object.keys(env).find(key=>key.toLowerCase()==='path')??'PATH';
  const mingw=join(workspace,'.toolchains','mingw64','bin');
  env[pathKey]=[existsSync(mingw)?mingw:'',env[pathKey]].filter(Boolean).join(delimiter);
  if(!env.RUSTUP_TOOLCHAIN){
    const listed=spawnSync('rustup',['toolchain','list'],{env,encoding:'utf8',windowsHide:true});
    const available=(listed.stdout??'').split(/\r?\n/).map(line=>line.split(/\s/)[0]).filter(Boolean);
    env.RUSTUP_TOOLCHAIN=available.find(name=>name.startsWith('stable-'))??available[0]??'stable';
  }
  return env;
}
export function run(command,args,options={}) {
  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,{stdio:'inherit',windowsHide:true,...options});
    child.once('error',reject);child.once('exit',(code,signal)=>code===0?resolve():reject(new Error(`${command} ${args[0]??''} failed (${signal??code})`)));
    const interrupt=()=>child.kill();process.once('SIGINT',interrupt);process.once('SIGTERM',interrupt);
    child.once('exit',()=>{process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',interrupt);});
  });
}
export async function buildRust(release=false) {
  const env=rustEnvironment();
  console.log(`Rust toolchain: ${env.RUSTUP_TOOLCHAIN}`);
  await run('cargo',['build','--workspace',...(release?['--release']:[])],{cwd:join(workspace,'rust'),env});
  await run(process.execPath,[join(workspace,'scripts','sync-rust-plugins.mjs'),...(release?['--release']:[])],{cwd:workspace,env});
  return env;
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {await buildRust(process.argv.includes('--release'));}catch(error){console.error(error.message);process.exitCode=1;}
}
