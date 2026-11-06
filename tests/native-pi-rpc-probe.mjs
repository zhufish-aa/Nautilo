// Optional installed-CLI conformance probe; uses an isolated profile and no model call.
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { createInterface } from 'node:readline';
for (const provider of ['pi', 'omp']) {
  const executable = process.env[`NAUTILO_${provider.toUpperCase()}_CLI`] ?? join(process.env.APPDATA ?? '', 'npm', `${provider}.cmd`);
  try { await access(executable); } catch { process.stdout.write(`${provider}: not installed, skipped\n`); continue; }
  const directory = await mkdtemp(join(tmpdir(), `nautilo-${provider}-rpc-`));
  const extension = join(directory, 'probe.mjs');
  await writeFile(extension, `export default function(pi) { pi.registerCommand('nautilo-parity-probe', { handler: async (_args,ctx) => {
    const selected=await ctx.ui.select('Select',['one','two']);
    const text=await ctx.ui.input('Input','placeholder');
    const edited=await ctx.ui.editor('Editor','original');
    ctx.ui.setStatus('probe','native-status'); ctx.ui.setWidget('probe',['native-widget']);
    ctx.ui.notify('probe-complete:'+JSON.stringify([selected,text,edited]),'info');
  }}); }`);
  const quote = value => `"${value.replaceAll('"', '""')}"`;
  const child = spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `call ${quote(executable)} --mode rpc --extension ${quote(extension)}`], {
    windowsHide: true, windowsVerbatimArguments: true, cwd: directory,
    env: { ...process.env, HOME: directory, USERPROFILE: directory, PI_CODING_AGENT_DIR: join(directory, 'agent'),
      OPENAI_API_KEY: 'offline-probe', ANTHROPIC_API_KEY: 'offline-probe', OPENAI_BASE_URL: 'http://127.0.0.1:1', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1' },
  });
  const frames = []; let prompted = false; let completed = false;
  const send = frame => { if (!child.stdin.destroyed) child.stdin.write(JSON.stringify(frame) + '\n'); };
  const input = createInterface({ input: child.stdout });
  input.on('line', line => {
    let frame; try { frame=JSON.parse(line); } catch { return; }
    frames.push({ type:frame.type, id:frame.id, method:frame.method, command:frame.command, agentInvoked:frame.agentInvoked, success:frame.success });
    if (frame.type === 'ready') send({ id:'negotiate',type:'negotiate_protocol',protocolVersion:2 });
    if ((frame.type === 'ready' || frame.type === 'response') && !prompted) { prompted=true; send({id:'probe',type:'prompt',message:'/nautilo-parity-probe'}); }
    if (frame.type === 'extension_ui_request') {
      if (frame.method === 'select') send({type:'extension_ui_response',id:frame.id,value:'two'});
      if (frame.method === 'input') send({type:'extension_ui_response',id:frame.id,value:''});
      if (frame.method === 'editor') send({type:'extension_ui_response',id:frame.id,value:'\n  editor\n'});
      if (frame.method === 'notify' && frame.message.startsWith('probe-complete:')) completed=true;
    }
  });
  // Pi's RPC has no ready preamble. A harmless state request also primes old OMP versions.
  if (provider === 'pi') send({id:'state',type:'get_state'});
  let stderr='';child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-500);});
  await new Promise(resolve => { const timeout=setTimeout(resolve,8000); child.once('exit',()=>{clearTimeout(timeout);resolve();}); });
  process.stdout.write(JSON.stringify({provider,completed,frames,...(!frames.length?{stderr}:{})})+'\n');
  child.stdin.end(); child.kill(); input.close();
  // Only the isolated directory created above belongs to this probe.
  if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith(`nautilo-${provider}-rpc-`)) throw new Error('Unexpected probe directory');
  await rm(directory,{recursive:true,force:true,maxRetries:5}).catch(()=>{});
  if (!completed) process.exitCode=1;
}
