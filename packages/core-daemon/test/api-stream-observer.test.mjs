import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { startApiStreamObserver, ApiCapture } from "../dist/adapters/api-stream-observer.js";

test("buffered native callers retain their wire and receive live deltas before the complete reply", async t => {
  const calls = []; let release;
  const gate = new Promise(resolve => { release = resolve; });
  const server = createServer((request, response) => { void (async () => {
    const bytes=[]; for await (const chunk of request) bytes.push(chunk);
    calls.push({ path: request.url, key: request.headers.authorization, body: JSON.parse(Buffer.concat(bytes)) });
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ id:"x", choices:[{delta:{reasoning_content:"Visible thought"}}] })}\n\n`);
    await gate;
    response.end(`data: ${JSON.stringify({id:"x", choices:[{delta:{content:"Final reply"},finish_reason:"stop"}]})}\n\ndata: [DONE]\n\n`);
  })(); });
  server.listen(0,"127.0.0.1"); await once(server,"listening");
  const request={instance:{providerOptions:{runtimeConnectionId:"one",apiType:"openai-completions",baseUrl:`http://127.0.0.1:${server.address().port}/v1`}},env:{NAUTILO_CONNECTION_API_KEY:"private-selected-key"},reasoningEffort:"max"};
  const observer=await startApiStreamObserver(request);
  let finishNative;
  const nativeGate=new Promise(resolve=>{finishNative=resolve;});
  const run=observer.wrap({ process:{}, events:(async function*(){await nativeGate; yield {kind:"message",text:"Final reply"};})(),write(){},async cancel(){finishNative();} });
  t.after(async()=>{release(); finishNative(); await observer.close();server.closeAllConnections(); await new Promise(resolve=>server.close(resolve));});
  const iterator=run.events[Symbol.asyncIterator]();
  let done=false;
  const reply=fetch(`${request.instance.providerOptions.baseUrl}/chat/completions`,{method:"POST",body:JSON.stringify({model:"saved",stream:false,messages:[]})}).then(r=>r.json()).then(value=>{done=true;return value;});
  const first=await iterator.next();
  assert.equal(first.value.kind,"thinking");assert.equal(first.value.text,"Visible thought");assert.equal(done,false);
  assert.equal(calls[0].key,"Bearer private-selected-key");assert.equal(calls[0].body.stream,true);assert.equal(calls[0].body.reasoning_effort,"max");assert.equal(calls[0].path,"/v1/chat/completions");
  assert.notEqual(request.env.NAUTILO_CONNECTION_API_KEY,"private-selected-key");
  release();const final=await reply;assert.equal(final.choices[0].message.content,"Final reply");
  finishNative(); const rest=[];for await (const event of {[Symbol.asyncIterator]:()=>iterator}) rest.push(event);
  assert.equal(rest.filter(event=>event.kind==="message" && event.phase==="completed").length,1);
});

test("native terminal replies keep opaque Responses items and signed Messages tool blocks", () => {
  const result={id:"r",output:[{id:"reason",type:"reasoning",encrypted_content:"opaque",summary:[{type:"summary_text",text:"Summary"}]}]};
  const responses=new ApiCapture("openai-responses",()=>{}); responses.accept({type:"response.completed",response:result});assert.deepEqual(responses.reply(),result);
  const messages=new ApiCapture("anthropic-messages",()=>{});
  for(const event of [{type:"message_start",message:{id:"m",content:[],usage:{input_tokens:1}}},{type:"content_block_start",index:0,content_block:{type:"thinking",thinking:"",signature:""}},{type:"content_block_delta",index:0,delta:{type:"thinking_delta",thinking:"Thought"}},{type:"content_block_delta",index:0,delta:{type:"signature_delta",signature:"signed"}},{type:"content_block_start",index:1,content_block:{type:"tool_use",id:"call",name:"read",input:{}}},{type:"content_block_delta",index:1,delta:{type:"input_json_delta",partial_json:'{"path":"a"}'}},{type:"content_block_stop",index:1},{type:"message_delta",delta:{stop_reason:"tool_use"},usage:{output_tokens:2}},{type:"message_stop"}])messages.accept(event);
  assert.equal(messages.reply().content[0].signature,"signed");assert.deepEqual(messages.reply().content[1].input,{path:"a"});assert.equal(messages.reply().usage.input_tokens,1);assert.equal(messages.reply().usage.output_tokens,2);
});
