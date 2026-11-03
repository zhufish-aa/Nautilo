import test from 'node:test';
import assert from 'node:assert/strict';
import {MAX_MODEL_RESPONSE_BYTES,readModelResponseJson} from '../dist/adapters/bounded-model-response.js';
import {discoverOpenAiCompatibleModels} from '../dist/adapters/model-config.js';
import {discoverClaudeModels} from '../dist/adapters/claude/models.js';
import {discoverCodexModels,discoverCodexModelsViaApi} from '../dist/adapters/codex/models.js';
import {ProcessRuntime} from '../dist/process-runtime.js';
function mockFetch(t,fn){const original=globalThis.fetch;globalThis.fetch=fn;t.after(()=>{globalThis.fetch=original;});}
function oversized(onCancel=()=>{}){return new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(MAX_MODEL_RESPONSE_BYTES+1));},cancel:onCancel}));}
test('Model discovery reader caps streamed bytes without Content-Length and cancels',async()=>{
 let cancelled=false;await assert.rejects(readModelResponseJson(oversized(()=>{cancelled=true;})),/8 MiB/);assert.equal(cancelled,true);
 let pulled=false;let cancelledHeader=false;
 const body=new ReadableStream({pull(){pulled=true;},cancel(){cancelledHeader=true;}},{highWaterMark:0});
 await assert.rejects(readModelResponseJson(new Response(body,{headers:{'content-length':String(MAX_MODEL_RESPONSE_BYTES+1)}})),/8 MiB/);assert.equal(pulled,false);assert.equal(cancelledHeader,true);
});
test('Model reader handles byte-split Unicode and redacts invalid JSON',async()=>{
 const bytes=Buffer.from('{"data":[{"id":"模型🌍"}]}');
 const body=new ReadableStream({start(c){for(const byte of bytes)c.enqueue(Uint8Array.of(byte));c.close();}});
 assert.equal((await readModelResponseJson(new Response(body))).data[0].id,'模型🌍');
 await assert.rejects(readModelResponseJson(new Response('{private-api-key')),e=>/invalid JSON/.test(e.message)&&!e.message.includes('private-api-key'));
});
test('All HTTP model-discovery paths reject oversized provider responses',async t=>{
 let cancelled=0;mockFetch(t,async()=>oversized(()=>{cancelled++;}));
 await assert.rejects(discoverOpenAiCompatibleModels('https://models.example.test/v1','key'),/8 MiB/);
 await assert.rejects(discoverCodexModelsViaApi({providerOptions:{baseUrl:'https://models.example.test/v1'}},{OPENAI_API_KEY:'key'}),/8 MiB/);
 const result=await discoverClaudeModels({ANTHROPIC_BASE_URL:'https://models.example.test',ANTHROPIC_API_KEY:'key'});assert.match(result.warning,/8 MiB/);assert.equal(result.models[0].id,'default');assert.equal(cancelled,3);
});
test('Paginated Anthropic discovery applies one shared 8 MiB budget',async t=>{
 let calls=0;mockFetch(t,async()=>{calls++;return new Response(JSON.stringify({data:[{id:'model',padding:'x'.repeat(5*1024*1024)}],has_more:true,last_id:'model'}));});
 const result=await discoverClaudeModels({ANTHROPIC_BASE_URL:'https://models.example.test',ANTHROPIC_API_KEY:'key'});assert.match(result.warning,/8 MiB/);assert.equal(calls,2);
});
test('Full Codex discovery fails closed on rejected URLs and custom endpoint errors, never starts CLI',async t=>{
 const original=ProcessRuntime.prototype.start;let spawned=0;ProcessRuntime.prototype.start=function(){spawned++;throw new Error('CLI must not start');};t.after(()=>{ProcessRuntime.prototype.start=original;});
 let fetched=0;mockFetch(t,async()=>{fetched++;throw new Error('redirect rejected');});
 const instance={id:'x',providerId:'codex',executable:'codex',baseArgs:[]};
 await assert.rejects(discoverCodexModels({...instance,providerOptions:{baseUrl:'http://untrusted.invalid/v1'}},{env:{OPENAI_API_KEY:'key'}}),/HTTPS/);assert.equal(fetched,0);
 await assert.rejects(discoverCodexModels(instance,{env:{OPENAI_BASE_URL:'https://user:pass@models.example.test/v1',OPENAI_API_KEY:'key'}}),/credentials/);assert.equal(fetched,0);
 await assert.rejects(discoverCodexModels({...instance,providerOptions:{baseUrl:'https://models.example.test/v1'}},{env:{OPENAI_API_KEY:'key'}}),/redirect rejected/);assert.equal(fetched,1);assert.equal(spawned,0);
});
