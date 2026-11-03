import test from 'node:test';
import assert from 'node:assert/strict';
import {executeOfficialWebSearch,supportsOfficialWebSearch} from '../dist/runtime/orchestration/official-web-search.js';
const current={providerOptions:{webSearchMode:'official',webSearchInstanceId:'search',webSearchModel:'test-model'}};
const call={providerId:'codex',name:'official_web_search',arguments:{query:'private search'}};
function fixture(t,options={}){
 const target={id:'search',providerId:'codex',enabled:true,status:'available',executable:'missing-cli',baseArgs:[],providerOptions:{baseUrl:'https://search.example.test/v1',wireApi:'responses',...options}};
 const database={agents:{get:()=>target}};const credentials={environment:()=>({OPENAI_API_KEY:'private-api-key'})};
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
 return {target,database,credentials,run:(c=call)=>executeOfficialWebSearch(c,current,database,credentials)};
}
test('Official search rejects Anthropic targets before credential lookup or request',async t=>{
 const f=fixture(t,{wireApi:'anthropic'});f.credentials.environment=()=>{throw new Error('must not read credentials');};globalThis.fetch=()=>{throw new Error('must not call network');};
 assert.equal(supportsOfficialWebSearch(current,f.database),false);const result=await f.run();assert.equal(result.success,false);assert.match(result.content,/does not support native web search/);
});
test('Official search validates endpoint before exposing any credentials',async t=>{
 for(const baseUrl of ['http://remote.example.test/v1','https://user:pass@example.test/v1','https://example.test/v1?key=secret','https://example.test/v1#secret','file:///tmp']){
  const f=fixture(t,{baseUrl});let calls=0;globalThis.fetch=()=>{calls++;throw new Error('not allowed');};const r=await f.run();assert.equal(r.success,false);assert.match(r.content,/HTTPS API URL/);assert.equal(calls,0);
 }
});
test('Official direct search disables redirects, installs timeout and accepts literal loopback',async t=>{
 const f=fixture(t,{baseUrl:'http://127.0.0.1:1234/v1/responses'});let observed;
 globalThis.fetch=async(url,options)=>{observed={url:String(url),options};return new Response(JSON.stringify({output_text:'answer'}));};
 assert.deepEqual(await f.run(),{success:true,content:'answer'});assert.equal(observed.url,'http://127.0.0.1:1234/v1/responses');assert.equal(observed.options.redirect,'error');assert(observed.options.signal instanceof AbortSignal);assert.equal(observed.options.headers.authorization,'Bearer private-api-key');
});
test('Official search redacts HTTP, transport and malformed body errors',async t=>{
 const f=fixture(t);
 globalThis.fetch=async()=>new Response(JSON.stringify({error:{message:'private-api-key private search'}}),{status:401});let r=await f.run();assert.equal(r.success,false);assert.doesNotMatch(r.content,/private-api-key|private search/);
 globalThis.fetch=async()=>{throw new Error('private-api-key private search');};r=await f.run();assert.equal(r.success,false);assert.doesNotMatch(r.content,/private-api-key|private search/);
 globalThis.fetch=async()=>new Response('{broken');assert.equal((await f.run()).success,false);
 globalThis.fetch=async()=>new Response('{}');assert.equal((await f.run()).success,false);
 globalThis.fetch=async()=>new Response(JSON.stringify({status:'failed',error:{message:'private-api-key'}}));r=await f.run();assert.equal(r.success,false);assert.doesNotMatch(r.content,/private-api-key/);
});
test('Official search bounds streamed responses and cancels oversized bodies',async t=>{
 const f=fixture(t);let cancelled=false;
 globalThis.fetch=async()=>new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array(8*1024*1024+1));},cancel(){cancelled=true;}}));
 assert.equal((await f.run()).success,false);assert.equal(cancelled,true);
 let calls=0;globalThis.fetch=async()=>{calls++;return new Response('{}');};assert.equal((await f.run({...call,arguments:{query:'a'.repeat(64*1024+1)}})).success,false);assert.equal(calls,0);
});
