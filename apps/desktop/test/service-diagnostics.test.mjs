import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { create } from "zustand";

const source=ts.transpileModule(readFileSync(new URL("../src/renderer/src/stores/service-diagnostics.ts",import.meta.url),"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
function harness(requestCore) {
  const exports={};
  vm.runInNewContext(source,{exports,performance,Date,require:name=>name==="zustand"?{create}:name==="../lib/bridge"?{requestCore}:(()=>{throw Error(name);})()});
  return {store:exports.useServiceDiagnostics,key:exports.diagnosticKey};
}
test("diagnostics share in-flight probes, retain results across reads, and keep revisions independent",async()=>{
  let calls=0,finish;
  const wait=new Promise(resolve=>{finish=resolve;});
  const {store,key}=harness(async(method,input)=>{calls++;assert.equal(method,"connection.diagnose");assert.equal(input.revision,2);return wait;});
  const target={kind:"connection",id:"work-api",version:"2"};
  assert.equal(calls,0);
  const first=store.getState().check(target);
  assert.equal(first,store.getState().check(target));
  finish({subjectId:target.id,configurationVersion:"2",state:"passed",scope:"api_catalog",steps:[],elapsedMs:5,checkedAt:new Date().toISOString()});
  await first;
  assert.equal(calls,1);assert.equal(store.getState().checking[key(target)],false);
  assert.equal(store.getState().results[key(target)].state,"passed");
  assert.equal(store.getState().results[key({...target,version:"3"})],undefined);
  // Visiting or reading the store never automatically starts a fresh request.
  store.getState();store.getState();assert.equal(calls,1);
});
test("failed probes end loading and an explicit retry can replace the result",async()=>{
  let fail=true;
  const {store,key}=harness(async()=>{if(fail)throw Error("Backend unavailable");return {state:"passed",steps:[]};});
  const target={kind:"mcp",id:"search",version:"saved-config"};
  await store.getState().check(target);
  assert.equal(store.getState().checking[key(target)],false);
  assert.equal(store.getState().results[key(target)].steps[0].code,"IPC_ERROR");
  fail=false;await store.getState().check(target);
  assert.equal(store.getState().results[key(target)].state,"passed");
});
