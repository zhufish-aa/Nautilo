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
test('API options only expose established protocol compatibility',()=>{
 assert.equal(connectionSupportsAgent(api('responses'),agent('codex')),true);
 assert.equal(connectionSupportsAgent(api('chat'),agent('codex')),true);
 assert.equal(connectionSupportsAgent(api('anthropic'),agent('claude-code')),true);
 assert.equal(connectionSupportsAgent(api('responses'),agent('claude-code')),false);
 assert.equal(connectionSupportsAgent(api('anthropic'),agent('codex')),false);
 assert.equal(connectionSupportsAgent(api('chat'),agent('custom-cli')),false);
});
test('disabled sources and custom routing do not appear eligible',()=>{
 assert.equal(connectionSupportsAgent({...api('chat'),enabled:false},agent('codex')),false);
 assert.equal(connectionSupportsAgent(api('chat'),{...agent('codex'),profile:'other'}),false);
 assert.equal(connectionSupportsAgent(api('chat'),{...agent('codex'),baseArgs:['--config','route']}),false);
});
