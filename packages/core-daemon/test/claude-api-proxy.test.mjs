import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const source = await readFile(new URL('../src/adapters/claude/api-proxy.ts', import.meta.url), 'utf8');
const module = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { startClaudeApiProxy, NativeMessageStream } = await import(`data:text/javascript,${encodeURIComponent(module)}`);

async function fixture(t, protocol = 'openai-completions') {
  const calls = []; let fail = false;
  const server = createServer((request, response) => { void (async () => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    calls.push({ path: request.url, authorization: request.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString()) });
    response.setHeader('content-type', 'application/json');
    if (fail) { response.writeHead(403); response.end('rejected private-fixture-key'); return; }
    response.end(JSON.stringify(protocol === 'openai-responses' ? {
      id: 'response', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Hello from the selected API' }] }], usage: { input_tokens: 20, output_tokens: 5 },
    } : {
      id: 'response', choices: [{ message: { content: 'Hello from the selected API', tool_calls: [{ id: 'call-next', type: 'function', function: { name: 'read', arguments: '{"path":"a.txt"}' } }] }, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 20, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 4 } },
    }));
  })().catch(() => { response.writeHead(500); response.end(); }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const proxy = await startClaudeApiProxy({ instance: { providerOptions: { runtimeConnectionId: 'api', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiType: protocol } }, model: 'saved-model', reasoningEffort: 'max', env: { NAUTILO_CONNECTION_API_KEY: 'private-fixture-key', OPENAI_API_KEY: 'private-fixture-key', ANTHROPIC_AUTH_TOKEN: 'wrong-account' } });
  t.after(async () => { await proxy.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { proxy, calls, setFailure: () => { fail = true; } };
}

test('native Claude beta requests reach the saved Chat API with model, effort, tools and selected key', async t => {
  const { proxy, calls } = await fixture(t);
  assert.notEqual(proxy.env.ANTHROPIC_API_KEY, 'private-fixture-key');
  assert.notEqual(proxy.env.NAUTILO_CONNECTION_API_KEY, 'private-fixture-key');
  assert.equal(proxy.env.ANTHROPIC_AUTH_TOKEN, undefined);
  const response = await fetch(`${proxy.env.ANTHROPIC_BASE_URL}/v1/messages?beta=true`, { method: 'POST', body: JSON.stringify({ model: 'internal-model', stream: true, max_tokens: 512, system: 'System', tools: [{ name: 'read', input_schema: { type: 'object' } }], messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'call-prev', name: 'read', input: { path: 'b.txt' } }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-prev', content: 'File result' }] }] }) });
  assert.equal(response.status, 200);
  const events = await response.text();
  assert.match(events, /Hello from the selected API/);
  assert.match(events, /message_stop/);
  assert.match(events, /input_json_delta/);
  assert.equal(calls[0].path, '/v1/chat/completions');
  assert.equal(calls[0].authorization, 'Bearer private-fixture-key');
  assert.equal(calls[0].body.model, 'saved-model');
  assert.equal(calls[0].body.reasoning_effort, 'max');
  assert.equal(calls[0].body.stream, true);
  assert.equal(calls[0].body.messages[2].tool_call_id, 'call-prev');
  assert.equal(calls[0].body.tools[0].function.name, 'read');
  assert.doesNotMatch(events, /private-fixture-key|wrong-account/);
});

test('Responses connections translate the native Claude conversation and return a real assistant reply', async t => {
  const { proxy, calls } = await fixture(t, 'openai-responses');
  const response = await fetch(`${proxy.env.ANTHROPIC_BASE_URL}/v1/messages`, { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: 'Hello' }], max_tokens: 512 }) });
  const body = await response.json();
  assert.equal(body.content[0].text, 'Hello from the selected API');
  assert.equal(calls[0].path, '/v1/responses');
  assert.equal(calls[0].body.model, 'saved-model');
  assert.equal(calls[0].body.reasoning.effort, 'max');
  assert.equal(calls[0].body.input[0].content, 'Hello');
  assert.equal(body.usage.output_tokens, 5);
});

for (const responses of [false, true]) test(`${responses ? 'Responses' : 'Chat'} sends max and streams thinking/text before upstream completion`, async t => {
  let release, requestBody;
  const gate = new Promise(resolve => { release = resolve; });
  let finished = false;
  const server = createServer((incoming, outgoing) => { void (async () => {
    const chunks = []; for await (const chunk of incoming) chunks.push(chunk); requestBody = JSON.parse(Buffer.concat(chunks));
    outgoing.writeHead(200, {'content-type':'text/event-stream'});
    const emit = value => outgoing.write(`data: ${JSON.stringify(value)}\n\n`);
    if (responses) {
      emit({type:'response.output_item.added', output_index:0, item:{id:'reason',type:'reasoning'}});
      emit({type:'response.reasoning_summary_text.delta', item_id:'reason', summary_index:0, delta:'思考中'});
      emit({type:'response.output_item.added', output_index:1, item:{id:'answer',type:'message'}});
      emit({type:'response.output_text.delta', item_id:'answer', content_index:0, delta:'Hello'});
    } else emit({choices:[{delta:{reasoning_content:'思考中', content:'Hello'}}]});
    await gate; finished = true;
    if (responses) emit({type:'response.completed',response:{status:'completed', output:[
      {id:'reason',type:'reasoning',summary:[{type:'summary_text',text:'思考中'}],encrypted_content:'opaque-context'},
      {id:'answer',type:'message',role:'assistant',content:[{type:'output_text',text:'Hello world'}]}],usage:{input_tokens:20,output_tokens:9,input_tokens_details:{cached_tokens:4}}}});
    else {
      emit({choices:[{delta:{content:' world'},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:9,prompt_tokens_details:{cached_tokens:4}}});
      outgoing.write('data: [DONE]\n\n');
    }
    outgoing.end();
  })(); });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const proxy = await startClaudeApiProxy({instance:{providerOptions:{runtimeConnectionId:'api',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,apiType:responses?'openai-responses':'openai-completions'}},model:'selected',reasoningEffort:'max',env:{NAUTILO_CONNECTION_API_KEY:'key'}});
  t.after(async () => { release(); await proxy.close(); server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); });
  const response = await fetch(`${proxy.env.ANTHROPIC_BASE_URL}/v1/messages`,{method:'POST',body:JSON.stringify({model:'internal',output_config:{effort:'low'},stream:true,messages:[{role:'user',content:'Hi'}]})});
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let body = '';
  const first = async () => { while(!body.includes('Hello')) { const part=await reader.read(); assert.equal(part.done,false); body+=decoder.decode(part.value,{stream:true}); } };
  await Promise.race([first(),new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('First text waited for completion')),2000);timer.unref();})]);
  assert.equal(finished,false,'the first text must be delivered before upstream finishes');
  assert.match(body,/thinking_delta/); assert.match(body,/思考中/);
  assert.equal(requestBody.stream,true); assert.equal(responses?requestBody.reasoning.effort:requestBody.reasoning_effort,'max');
  release(); for (;;) { const part=await reader.read(); if(part.done)break; body+=decoder.decode(part.value,{stream:true}); }
  assert.match(body,/message_stop/); assert.match(body,/world/); assert.match(body,/"input_tokens":16/);
  if(responses)assert.match(body,/signature_delta/);
});

test('streaming tool arguments and Responses reasoning context survive the tool round trip', () => {
  const stream = new NativeMessageStream(true,'selected'); const frames=[];
  const reason={id:'reason',type:'reasoning',summary:[{type:'summary_text',text:'Plan'}],encrypted_content:'opaque'};
  for(const value of [
    {type:'response.reasoning_summary_text.delta',item_id:'reason',delta:'Plan'},
    {type:'response.output_item.done',item:reason},
    {type:'response.output_item.added',output_index:1,item:{id:'tool',type:'function_call',call_id:'call',name:'read',arguments:''}},
    {type:'response.function_call_arguments.delta',item_id:'tool',delta:'{"path":'},
    {type:'response.function_call_arguments.delta',item_id:'tool',delta:'"a"}'},
    {type:'response.completed',response:{output:[],usage:{input_tokens:4,output_tokens:2}}}
  ])frames.push(...stream.event(value));
  frames.push(...stream.finish());
  assert.equal(frames.filter(frame=>frame.delta?.type==='input_json_delta').map(frame=>frame.delta.partial_json).join(''),'{"path":"a"}');
  const signature=frames.find(frame=>frame.delta?.type==='signature_delta').delta.signature;
  assert.deepEqual(JSON.parse(Buffer.from(signature.split(':')[1],'base64').toString()),reason);
  assert.equal(frames.find(frame=>frame.type==='message_delta').delta.stop_reason,'tool_use');
  const truncated=new NativeMessageStream(false,'selected'); truncated.event({choices:[{delta:{content:'Partial'}}]});
  assert.throws(()=>truncated.finish(),/before completion/);
});

test('upstream errors remain errors and cannot echo the connection credential', async t => {
  const { proxy, setFailure } = await fixture(t); setFailure();
  const response = await fetch(`${proxy.env.ANTHROPIC_BASE_URL}/v1/messages`, { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: 'Hello' }] }) });
  assert.equal(response.status, 403);
  const body = await response.text();
  assert.match(body, /rejected/);
  assert.doesNotMatch(body, /private-fixture-key/);
});
