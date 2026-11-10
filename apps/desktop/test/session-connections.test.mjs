import test from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../src/renderer/src/lib/session-connections.ts',import.meta.url),'utf8');
const {connectionSupportsAgent}=await import(`data:text/javascript,${encodeURIComponent(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText)}`);
const agent=providerId=>({providerId,baseArgs:[]});
const api=protocol=>({kind:'api',enabled:true,protocol});
test('account connections require exact supported harness',()=>{
 assert.equal(connectionSupportsAgent({kind:'login',enabled:true,harness:'codex'},agent('codex')),true);
 assert.equal(connectionSupportsAgent({kind:'login',enabled:true,harness:'codex'},agent('claude-code')),false);
});
test('every built-in harness exposes the saved API connections for each supported wire',()=>{
 for(const harness of ['codex','claude-code','kimi-code','pi','omp','opencode','commandcode','trae']) {
  for(const protocol of ['responses','chat','anthropic']) assert.equal(connectionSupportsAgent(api(protocol),agent(harness)),true,`${harness}: ${protocol}`);
 }
 assert.equal(connectionSupportsAgent(api('chat'),agent('new-provider-plugin')),true,'a new plugin needs no frontend allowlist edit');
});
test('disabled sources and custom routing do not appear eligible',()=>{
 assert.equal(connectionSupportsAgent({...api('chat'),enabled:false},agent('codex')),false);
 assert.equal(connectionSupportsAgent(api('chat'),{...agent('codex'),profile:'other'}),false);
 assert.equal(connectionSupportsAgent(api('chat'),{...agent('codex'),baseArgs:['--config','route']}),false);
});
