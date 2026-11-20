import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {readFileSync} from "node:fs";
import ts from "typescript";
const code=ts.transpileModule(readFileSync(new URL("../src/renderer/src/features/sessions/source-control-client.ts",import.meta.url),"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
function client(request){const exports={};vm.runInNewContext(code,{exports,require:()=>({requestCore:request})});return exports.createSourceControlClient(request);}
const repository=(token="one")=>({available:true,rootPath:"D:/repo",token,changes:[]});
const scope={sessionId:"s"},selection={path:"a.ts",source:"worktree"};
test("concurrent status reads share IPC and identical snapshots retain their identity",async()=>{
  let requests=0,resolve;const api=client(async()=>{requests++;return new Promise(done=>{resolve=done;});});
  const first=api.status(scope),second=api.status(scope);assert.equal(first,second);resolve(repository());
  const value=await first;assert.equal(requests,1);assert.equal(api.peekStatus(scope),value);
  const next=api.status(scope);resolve(repository());assert.equal(await next,value);
});
test("a status read that finishes after a mutation cannot replace its newer snapshot",async()=>{
  let resolve;const api=client(()=>new Promise(done=>{resolve=done;}));const old=api.status(scope);
  const updated=api.rememberStatus(scope,repository("after-stage"));resolve(repository("before-stage"));
  assert.equal(await old,updated);assert.equal(api.peekStatus(scope).token,"after-stage");
});
test("switching files reuses previews, while native revisions and sessions isolate the cache",async()=>{
  let calls=0,resolve;const api=client((method,input)=>{assert.equal(method,"scm.diff");calls++;return new Promise(done=>{resolve=()=>done({...input,patch:"+line"});});});
  const repo=repository(),first=api.diff(scope,repo,selection),duplicate=api.diff(scope,repo,selection);assert.equal(first,duplicate);resolve();const value=await first;
  assert.equal(api.peekDiff(scope,repo,selection),value);assert.equal(await api.diff(scope,repo,selection),value);assert.equal(calls,1);
  const changed=api.diff(scope,repository("two"),selection);resolve();await changed;assert.equal(calls,2);
  const other=api.diff({sessionId:"other"},repo,selection);resolve();await other;assert.equal(calls,3);
});
test("a failed preview is retryable and the memory cache evicts older file contents",async()=>{
  let fail=true,calls=0;const api=client(async(method,input)=>{calls++;if(fail){fail=false;throw Error("locked");}return{...input,patch:"+content"};});
  await assert.rejects(api.diff(scope,repository(),selection),/locked/);await api.diff(scope,repository(),selection);
  for(let index=0;index<25;index++)await api.diff(scope,repository(),{...selection,path:`${index}.ts`});
  assert.equal(api.peekDiff(scope,repository(),selection),undefined);assert.ok(api.peekDiff(scope,repository(),{...selection,path:"24.ts"}));assert.equal(calls,27);
});

test("per-file revisions retain unaffected previews when another file changes",async()=>{
  let calls=0;
  const api=client(async(method,input)=>{calls++;return{...input,patch:"+cached"};});
  const before={...repository("old-index"),changes:[{path:"a.ts",version:"a1"},{path:"b.ts",version:"b1"}]};
  const shown=await api.diff(scope,before,selection);
  const after={...repository("new-index"),changes:[{path:"a.ts",version:"a1"},{path:"b.ts",version:"b2"}]};
  assert.equal(await api.diff(scope,after,selection),shown);
  assert.equal(calls,1);
});

test("repository mutations serialize Windows path aliases and status reads wait for the final save",async()=>{
  const starts=[],releases=[];
  const api=client(async(method,input)=>{
    starts.push(method);
    if(method==="scm.status")return repository("after-save");
    await new Promise(done=>releases.push(done));
    return method==="scm.mutate"?{status:repository("after-stage")}:{...input,saved:true};
  });
  api.rememberStatus(scope,repository());
  const staged=api.mutate(scope,"D:/repo",{operation:"stage",paths:["a.ts"]});
  const saved=api.save("d:\\REPO",{...scope,path:"a.ts",content:"edited",expectedHash:"version"});
  const status=api.status(scope);
  await new Promise(setImmediate);
  assert.deepEqual(starts,["scm.mutate"]);
  releases.shift()();await staged;await new Promise(setImmediate);
  assert.deepEqual(starts,["scm.mutate","scm.save"]);
  releases.shift()();await saved;
  assert.equal((await status).token,"after-save");
  assert.equal(api.peekStatus(scope).token,"after-save");
});

test("a diff invalidated during a save cannot repopulate the preview cache",async()=>{
  let finish;
  const api=client(async(method,input)=>method==="scm.diff"?new Promise(done=>finish=()=>done({...input,patch:"+stale"})):{saved:true});
  const read=api.diff(scope,repository(),selection);
  await api.save("D:/repo",{...scope,path:"a.ts",content:"new",expectedHash:"old"});
  finish();await read;
  assert.equal(api.peekDiff(scope,repository(),selection),undefined);
});
