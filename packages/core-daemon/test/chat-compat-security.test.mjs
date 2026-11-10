import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {startChatCompatProxy,compatibilityChildEnvironment} from '../dist/adapters/codex/chat-compat-proxy.js';
async function setup(t,handler){
 const server=createServer(handler);await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const proxy=await startChatCompatProxy({remoteBaseUrl:`http://127.0.0.1:${server.address().port}/v1`,environment:{OPENAI_API_KEY:'real-provider-key'}});
 t.after(async()=>{await proxy.close();await new Promise(r=>{server.close(r);server.closeAllConnections();});});
 const send=(authorization=`Bearer ${proxy.token}`)=>fetch(`${proxy.baseUrl}/responses`,{method:'POST',headers:{authorization},body:JSON.stringify({model:'test',input:'hello',stream:true})});
 return {proxy,send};
}
test('Chat proxy requires a local capability and uses only configured upstream credentials',async t=>{
 let calls=0;const {send}=await setup(t,async(req,res)=>{calls++;assert.equal(req.headers.authorization,'Bearer real-provider-key');for await(const _ of req){}res.writeHead(200,{'content-type':'text/event-stream'}).end('data: {"choices":[{"delta":{"content":"hello"}}]}\n\ndata: [DONE]\n\n');});
 assert.equal((await send('')).status,401);assert.equal((await send('Bearer real-provider-key')).status,401);assert.equal(calls,0);
 const response=await send();assert.equal(response.status,200);assert.match(await response.text(),/response.completed/);assert.equal(calls,1);
});
test('Chat proxy refuses redirects and redacts upstream error details',async t=>{
 let calls=0;const {send}=await setup(t,async(req,res)=>{calls++;for await(const _ of req){}if(calls===1)res.writeHead(307,{location:'/target'}).end();else res.writeHead(401).end('real-provider-key private data');});
 assert.equal((await send()).status,502);assert.equal(calls,1);const r=await send();assert.equal(r.status,401);assert.doesNotMatch(await r.text(),/real-provider-key|private data/);
});
test('Chat close cancels active upstream, force closes clients and is idempotent',async t=>{
 let connected;const ready=new Promise(r=>connected=r);let disconnected;const closed=new Promise(r=>disconnected=r);
 const {send,proxy}=await setup(t,async(req,res)=>{for await(const _ of req){}res.on('close',disconnected);res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n');connected();});
 const response=await send();await ready;const body=response.text().catch(()=>{});await proxy.close();await Promise.race([closed,new Promise((_,r)=>setTimeout(()=>r(new Error('not cancelled')),1000).unref())]);await body;await proxy.close();
});
test('Both bridge children remove upstream credentials case-insensitively',()=>{
 const original={openai_api_key:'secret1',ANTHROPIC_AUTH_TOKEN:'secret2',Anthropic_Api_Key:'secret3',CODEX_API_KEY:'secret4',AGENTHUB_API_KEY:'secret5',OpenAi_Base_Url:'https://upstream',PATH:'/bin'};
 assert.deepEqual(compatibilityChildEnvironment(original,'capability','http://127.0.0.1:1/v1'),{PATH:'/bin',OPENAI_API_KEY:'capability',OPENAI_BASE_URL:'http://127.0.0.1:1/v1'});assert.equal(original.openai_api_key,'secret1');
});
test('Chat rejects unsafe upstream URLs before starting listener',async()=>{
 for(const remoteBaseUrl of ['http://example.test/v1','https://user:pass@example.test/v1','https://example.test/v1?key=secret','file:///tmp'])await assert.rejects(startChatCompatProxy({remoteBaseUrl}));
});
