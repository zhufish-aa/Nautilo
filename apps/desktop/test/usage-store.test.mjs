import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import ts from "typescript";
const compile = path => ts.transpileModule(readFileSync(new URL(path, import.meta.url),"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
function harness(requestCore) {
 const usage={}; vm.runInNewContext(compile('../src/renderer/src/lib/session-usage.ts'),{exports:usage});
 const exports={};
 vm.runInNewContext(compile('../src/renderer/src/stores/usage.ts'),{exports,Map,Date,Promise,require:name=>name==='zustand'?{create:init=>{let state;const get=()=>state;state=init(update=>{state={...state,...update(state)}},get);return {getState:get}}}:name==='../lib/bridge'?{requestCore}:usage});
 return exports.useUsageStore;
}
const event=(n,input)=>({eventId:`e${n}`,sequence:n,runId:'r',type:'usage.updated',payload:{usageScope:'turn',inputTokens:input,outputTokens:2,inputTokensIncludesCache:true}});
test('usage store replaces snapshots, rejects stale history, and ignores context updates',()=>{
 const store=harness(()=>{});
 store.getState().ingest('s',[event(2,20)]);
 store.getState().ingest('s',[event(1,10),event(2,20),{...event(3,500),payload:{usageScope:'context',inputTokens:500}}]);
 assert.equal(store.getState().summaries.s.totalTokens,22);
});
test('usage refresh coalesces repeats, retains data on failure, and recovers subscription',async()=>{
 const calls=[];let fail=false;let release;
 const gate=new Promise(resolve=>{release=resolve});
 const store=harness(async(method,input)=>{calls.push({method,input}); if(method==='event.subscribe')return {subscriptionId:`sub${calls.length}`};await gate;if(fail)throw Error('disconnected');return {events:[event(1,10)],lastSequence:1};});
 const first=store.getState().refresh('s'),second=store.getState().refresh('s');
 assert.equal(first,second);release();await first;
 assert.equal(calls.length,2); assert.equal(store.getState().summaries.s.totalTokens,12);
 fail=true;await store.getState().refresh('s');assert.equal(store.getState().summaries.s.totalTokens,12);assert.match(store.getState().errors.s,/disconnected/);
 fail=false;await store.getState().refresh('s');assert.equal(calls.filter(call=>call.method==='event.subscribe').length,2);assert.equal(store.getState().errors.s,undefined);
});
test('empty journal is known unavailable, never a fabricated zero total',async()=>{
 const store=harness(async method=>method==='event.subscribe'?{subscriptionId:'s'}:{events:[],lastSequence:0});
 await store.getState().refresh('s');assert.equal(store.getState().summaries.s.totalTokens,undefined);assert.ok(store.getState().refreshedAt.s);
});
test('store retains colliding native IDs from different connection revisions',()=>{
 const store=harness(()=>{});
 const snapshot=(sequence,id,revision)=>({...event(sequence,10),payload:{...event(sequence,10).payload,usageScope:'session',usageKey:'native',connectionId:id,connectionRevision:revision}});
 store.getState().ingest('s',[snapshot(1,'a',1),snapshot(2,'b',1),snapshot(3,'a',2)]);
 assert.equal(store.getState().summaries.s.totalTokens,36);
 store.getState().ingest('s',[snapshot(4,'a',1)]);
 assert.equal(store.getState().summaries.s.totalTokens,36);
});
