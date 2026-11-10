import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startAnthropicCompatProxy, responsesToAnthropicRequest, anthropicEndpoint } from '../dist/adapters/codex/anthropic-compat-proxy.js';

const tools = [{type:'function',name:'lookup',parameters:{type:'object',properties:{q:{type:'string'}}}}, {type:'namespace',name:'mcp',tools:[{type:'custom',name:'run'}]}];
const request = {model:'claude-test',input:'你好',tools};
const frame = data => `event: ${data.type}\r\ndata: ${JSON.stringify(data)}\r\n\r\n`;
const start = {type:'message_start',message:{usage:{input_tokens:10,cache_read_input_tokens:3,cache_creation_input_tokens:2}}};
const stop = reason => [{type:'message_delta',delta:{stop_reason:reason},usage:{output_tokens:4}},{type:'message_stop'}];
const textEvents = [start,{type:'content_block_start',index:0,content_block:{type:'text',text:''}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'你好 🌍'}},{type:'content_block_stop',index:0},...stop('end_turn')];
async function setup(t, handler) {
  const server=createServer(handler); await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${server.address().port}`;
  const proxy=await startAnthropicCompatProxy({remoteBaseUrl:base,environment:{ANTHROPIC_API_KEY:'secret-provider-key'}});
  t.after(async()=>{await proxy.close(); await new Promise(r=>{server.close(r);server.closeAllConnections();});});
  const send=(body=request,headers={authorization:`Bearer ${proxy.token}`})=>fetch(`${proxy.baseUrl}/responses`,{method:'POST',headers,body:JSON.stringify(body)});
  return {proxy,send,base};
}
const events = text => text.split(/\n\n/).filter(Boolean).map(x=>JSON.parse(x.split('\n').find(l=>l.startsWith('data:')).slice(5)));

test('Anthropic request translates tools, namespace history and system instructions',()=>{
 const input={...request,instructions:'be helpful',parallel_tool_calls:false,input:[{role:'developer',content:'be precise'},{role:'user',content:'hello'},{type:'function_call',call_id:'a',name:'lookup',arguments:'{"q":"hi"}'},{type:'function_call_output',call_id:'a',output:'found'},{type:'custom_tool_call',call_id:'b',namespace:'mcp',name:'run',input:'echo hi'},{type:'custom_tool_call_output',call_id:'b',output:[{type:'input_text',text:'ok'}]}]};
 const {request:r}=responsesToAnthropicRequest(input);
 assert.equal(r.max_tokens,4096); assert.equal(r.system.length,2); assert.equal(r.tools[1].name,'mcp__run');
 assert.deepEqual(r.messages[3].content[0],{type:'tool_use',id:'b',name:'mcp__run',input:{input:'echo hi'}});
 assert.equal(r.tool_choice.disable_parallel_tool_use,true);
});
test('Anthropic converter rejects unsupported features explicitly',()=>{
 for(const extra of [{previous_response_id:'r'},{text:{format:{type:'json_schema'}}},{tools:[{type:'web_search'}]},{input:[{type:'reasoning',summary:[]}]},{input:[{role:'user',content:[{type:'input_image',image_url:'https://example.test/a.png'}]}]},{tool_choice:{type:'function',name:'missing'}},{background:true}]) assert.throws(()=>responsesToAnthropicRequest({...request,...extra}));
 assert.throws(()=>responsesToAnthropicRequest({...request,tools:[...tools,{type:'function',name:'mcp__run'}]}),/colliding/);
});

test('Anthropic effort and signed thinking survive the stream and the next tool-result turn', async t => {
 let received;
 const stream = [start,
  {type:'content_block_start',index:0,content_block:{type:'thinking',thinking:'',signature:''}},
  {type:'content_block_delta',index:0,delta:{type:'thinking_delta',thinking:'Check the saved file.'}},
  {type:'content_block_delta',index:0,delta:{type:'signature_delta',signature:'provider-signed-opaque-value'}},
  {type:'content_block_stop',index:0},
  ...textEvents.slice(1,4).map(event=>({...event,index:1})), ...stop('end_turn')];
 const {send}=await setup(t,async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;received=JSON.parse(body);res.writeHead(200,{'content-type':'text/event-stream'}).end(stream.map(frame).join(''));});
 const result=events(await(await send({...request,reasoning:{effort:'max'}})).text());
 assert.deepEqual(received.output_config,{effort:'max'});
 assert.equal(result.at(-1).type,'response.completed');
 const thinking=result.at(-1).response.output[0];
 assert.equal(thinking.summary[0].text,'Check the saved file.');
 const replay=responsesToAnthropicRequest({...request,input:[{role:'user',content:'hello'},thinking,{role:'assistant',content:'done'},{role:'user',content:'continue'}]}).request;
 assert.deepEqual(replay.messages[1].content[0],{type:'thinking',thinking:'Check the saved file.',signature:'provider-signed-opaque-value'});
});
test('Anthropic endpoint validation requires remote TLS and preserves explicit paths',()=>{
 assert.equal(anthropicEndpoint('https://api.anthropic.com'),'https://api.anthropic.com/v1/messages');
 assert.equal(anthropicEndpoint('https://example.test/proxy/v1/'),'https://example.test/proxy/v1/messages');
 assert.equal(anthropicEndpoint('https://example.test/v1/messages'),'https://example.test/v1/messages');
 for(const url of ['http://example.test','https://x:y@example.test','https://example.test?key=secret','file:///tmp/a']) assert.throws(()=>anthropicEndpoint(url));
});
test('Anthropic proxy requires per-run capability and never forwards caller credentials',async t=>{
 let calls=0;
 const {send}=await setup(t,async(req,res)=>{calls++; assert.equal(req.headers.authorization,undefined); assert.equal(req.headers['x-api-key'],'secret-provider-key'); assert.equal(req.headers['anthropic-version'],'2023-06-01'); assert.equal(req.url,'/v1/messages'); for await(const _ of req){} res.writeHead(200,{'content-type':'text/event-stream'});res.end(textEvents.map(frame).join(''));});
 assert.equal((await send(request,{})).status,401);
 assert.equal((await send(request,{authorization:'Bearer secret-provider-key'})).status,401);
 const response=await send();const list=events(await response.text());assert.equal(calls,1);
 const final=list.at(-1);assert.equal(final.type,'response.completed');assert.equal(final.response.output[0].content[0].text,'你好 🌍');
 assert.deepEqual(final.response.usage,{input_tokens:15,output_tokens:4,total_tokens:19,input_tokens_details:{cached_tokens:3}});
});
test('Anthropic stream handles byte-split UTF8, interleaved text/tools and stable indices',async t=>{
 const stream=[start,{type:'content_block_start',index:0,content_block:{type:'text',text:''}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'你好'}},{type:'content_block_start',index:1,content_block:{type:'tool_use',id:'call1',name:'lookup',input:{}}},{type:'content_block_delta',index:1,delta:{type:'input_json_delta',partial_json:'{"q":"雪"}'}},{type:'content_block_stop',index:1},{type:'content_block_stop',index:0},...stop('tool_use')];
 const {send}=await setup(t,async(req,res)=>{for await(const _ of req){}res.writeHead(200,{'content-type':'text/event-stream'});for(const byte of Buffer.from(stream.map(frame).join('')))res.write(Buffer.from([byte]));res.end();});
 const result=events(await(await send()).text());const added=result.filter(e=>e.type==='response.output_item.added');const done=result.filter(e=>e.type==='response.output_item.done');
 assert.deepEqual(added.map(e=>e.output_index),[0,1]);assert.deepEqual(done.map(e=>e.output_index),[1,0]);assert.equal(result.at(-1).response.output[1].arguments,'{"q":"雪"}');
});
test('Anthropic namespaced custom tool stream restores namespace with function payload',async t=>{
 const stream=[start,{type:'content_block_start',index:3,content_block:{type:'tool_use',id:'call1',name:'mcp__run',input:{}}},{type:'content_block_delta',index:3,delta:{type:'input_json_delta',partial_json:'{"input":"echo hi"}'}},{type:'content_block_stop',index:3},...stop('tool_use')];
 const {send}=await setup(t,async(req,res)=>{for await(const _ of req){}res.writeHead(200,{'content-type':'text/event-stream'}).end(stream.map(frame).join(''));});
 const final=events(await(await send()).text()).at(-1);assert.equal(final.response.output[0].type,'function_call');assert.equal(final.response.output[0].namespace,'mcp');assert.equal(final.response.output[0].arguments,'{"input":"echo hi"}');
});
test('Anthropic max token termination is incomplete, truncation never completes',async t=>{
 let count=0;
 const {send}=await setup(t,async(req,res)=>{for await(const _ of req){}count++; const stream=count===1?[...textEvents.slice(0,4),...stop('max_tokens')]:textEvents.slice(0,4);res.writeHead(200,{'content-type':'text/event-stream'}).end(stream.map(frame).join(''));});
 const a=events(await(await send()).text()).at(-1);assert.equal(a.type,'response.incomplete');assert.equal(a.response.incomplete_details.reason,'max_output_tokens');
 const b=events(await(await send()).text());assert.equal(b.at(-1).type,'response.failed');assert(!b.some(x=>x.type==='response.completed'));
});
test('Anthropic validates unsupported requests before upstream and redacts upstream errors',async t=>{
 let calls=0; const {send}=await setup(t,async(req,res)=>{calls++;for await(const _ of req){}res.writeHead(401).end('secret-provider-key private user payload');});
 assert.equal((await send({...request,tools:[{type:'web_search'}]})).status,400);assert.equal(calls,0);
 const response=await send();assert.equal(response.status,401);assert(!((await response.text()).includes('secret-provider-key')));
});
test('Anthropic close aborts active upstream and is idempotent',async t=>{
 let connected;const ready=new Promise(r=>connected=r);let disconnected;const closed=new Promise(r=>disconnected=r);
 const {send,proxy}=await setup(t,async(req,res)=>{for await(const _ of req){}res.on('close',disconnected);res.writeHead(200,{'content-type':'text/event-stream'});res.write(frame(start));connected();});
 const response=await send();await ready;const reading=response.text().catch(()=>{});await proxy.close();await Promise.race([closed,new Promise((_,reject)=>setTimeout(()=>reject(new Error('upstream not cancelled')),1000).unref())]);await reading;await proxy.close();
});

test('Anthropic standalone custom tools retain raw input and malformed streams fail',async t=>{
 let count=0;
 const stream=[start,{type:'content_block_start',index:0,content_block:{type:'tool_use',id:'c',name:'patch',input:{}}},{type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:'{"input":"*** Begin Patch"}'}},{type:'content_block_stop',index:0},...stop('tool_use')];
 const {send}=await setup(t,async(req,res)=>{for await(const _ of req){}count++;res.writeHead(200,{'content-type':'text/event-stream'}).end(count===1?stream.map(frame).join(''):frame(start)+frame({type:'error',error:{message:'secret'}}));});
 const input={...request,tools:[{type:'custom',name:'patch'}]};
 const a=events(await(await send(input)).text()).at(-1);assert.equal(a.response.output[0].type,'custom_tool_call');assert.equal(a.response.output[0].input,'*** Begin Patch');
 const b=events(await(await send(input)).text()).at(-1);assert.equal(b.type,'response.failed');assert(!JSON.stringify(b).includes('secret'));
});

test('Anthropic bridge rejects unsupported invocation before launching CLI',async()=>{
 const {startCodexChatCompatAppServer}=await import('../dist/adapters/codex/chat-compat-proxy.js');
 const {buildCodexAppServerArgs}=await import('../dist/adapters/codex/app-server-run.js');
 const instance={providerId:'codex',executable:'missing-codex',baseArgs:[],providerOptions:{wireApi:'anthropic',baseUrl:'https://api.anthropic.com'}};
 for(const extra of [{localImagePaths:['a.png']},{serviceTier:'priority'}]) {
   const run=startCodexChatCompatAppServer({instance,...extra},false,{anthropic:true});
   const received=[]; for await(const event of run.events)received.push(event);
   assert.equal(received[0].kind,'error');assert.match(received[0].error.message,/does not support/);
 }
 const args=buildCodexAppServerArgs({...instance,providerOptions:{...instance.providerOptions,anthropicCompat:true}},{});
 assert.equal(args[args.indexOf('image_generation')-1],'--disable');
});

test('Anthropic proxy refuses redirects and does not transmit credentials to redirect target',async t=>{
 let calls=0;
 const {send}=await setup(t,async(req,res)=>{calls++;for await(const _ of req){}res.writeHead(307,{location:'/credential-target'}).end();});
 assert.equal((await send()).status,502);assert.equal(calls,1);
});

test('Anthropic runtime ignores legacy effort order but preserves explicit defaults and overrides',async()=>{
 const {AdapterRegistry,Database,EventService,RunService}=await import('../dist/index.js');
 const database=new Database(':memory:');const now=new Date().toISOString();const requests=[];
 const adapter={providerId:'codex',supportsStructuredOutput:true,supportsResume:false,capabilities:{structuredOutput:true,textOutput:true,interactiveStdin:false,nativeResume:false,pty:false},detect:async()=>({installed:true,executable:'fake'}),start(request){requests.push(request);return{events:(async function*(){yield{kind:'exit',exitCode:0};})(),cancel:async()=>{},process:{},write(){}};}};
 const service=new RunService(database,new AdapterRegistry([adapter]),new EventService(database));
 const session={id:'anthropic-s',projectId:'anthropic-p',memberId:'a',agentInstanceId:'a',model:'claude-test',title:'S',status:'idle',unreadCount:0,createdAt:now,updatedAt:now};
 const agent={id:'a',providerId:'codex',displayName:'A',executable:'fake',baseArgs:[],capabilities:[],enabled:true,status:'available',createdAt:now,updatedAt:now,providerOptions:{wireApi:'anthropic'},models:[{id:'claude-test',reasoningEfforts:['low','high']}]};
 database.projects.save({id:'anthropic-p',name:'P',rootPath:process.cwd(),repositoryType:'git',nonGitDiffMode:'off',frontendPaths:[],backendPaths:[],ignoredPaths:[],policyId:'default'},now);database.sessions.save(session);
 try {
  await(await service.launch(session,agent,'unset')).completion;
  agent.models[0].defaultReasoningEffort='high';await(await service.launch(session,agent,'default')).completion;
  database.sessions.save({...database.sessions.get(session.id),reasoningEffort:'low'});await(await service.launch(session,agent,'override')).completion;
  assert.deepEqual(requests.map(r=>r.reasoningEffort),[undefined,'high','low']);
 } finally {database.close();}
});

test('Anthropic rejects oversized bodies and unknown routes before upstream',async t=>{
 const {request: httpRequest}=await import('node:http');let calls=0;
 const {proxy}=await setup(t,()=>{calls++;});
 const status=await new Promise((resolve,reject)=>{const req=httpRequest(`${proxy.baseUrl}/responses`,{method:'POST',headers:{authorization:`Bearer ${proxy.token}`,'content-length':21*1024*1024}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end();});
 assert.equal(status,413);
 assert.equal((await fetch(`${proxy.baseUrl}/other`,{method:'POST',headers:{authorization:`Bearer ${proxy.token}`}})).status,404);
 const malformed=await fetch(`${proxy.baseUrl}/responses`,{method:'POST',headers:{authorization:`Bearer ${proxy.token}`},body:'{'});assert.equal(malformed.status,400);assert.equal(calls,0);
});

test('Anthropic model catalog advertises only supported transient capabilities',async()=>{
 const {buildCodexCustomModelCatalog}=await import('../dist/adapters/codex/app-server-run.js');
 const catalog=buildCodexCustomModelCatalog({providerOptions:{baseUrl:'http://127.0.0.1:123/v1',anthropicCompat:true,webSearch:false},models:[{id:'claude-test',reasoningEfforts:['high']}]},'claude-test');
 assert.deepEqual(catalog.models[0].supported_reasoning_levels.map(x=>x.effort),['high']);assert.deepEqual(catalog.models[0].input_modalities,['text']);assert.equal(catalog.models[0].supports_reasoning_summaries,false);
});
