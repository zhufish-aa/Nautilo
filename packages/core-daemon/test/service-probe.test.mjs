import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { diagnoseMcp, diagnoseConnection } from "../dist/runtime/service-probe.js";

const capability = mcp => ({id:"probe-fixture",name:"Fixture",kind:"mcp",enabled:true,providerIds:["codex"],description:"",tags:[],createdAt:"2026-11-12T00:00:00Z",updatedAt:"2026-11-12T00:00:00Z",mcp});
async function server(t,handler) {
  const app = createServer(async (request,response)=>{
    try { const parts=[]; for await(const chunk of request) parts.push(chunk); await handler(request,response,parts.length ? JSON.parse(Buffer.concat(parts).toString()) : undefined); }
    catch(error) { response.writeHead(500);response.end(String(error)); }
  });
  await new Promise(resolve=>app.listen(0,"127.0.0.1",resolve));
  t.after(()=>new Promise(resolve=>{app.closeAllConnections();app.close(resolve);}));
  return `http://127.0.0.1:${app.address().port}/mcp`;
}
const json = (response,body) => {response.writeHead(200,{"content-type":"application/json","mcp-session-id":"fixture-session"});response.end(JSON.stringify(body));};

test("MCP probe negotiates HTTP, reads paginated SSE tool lists, redacts credentials and closes its own session",async t=>{
  const calls=[];
  const url=await server(t,(request,response,body)=>{
    calls.push(body?.method ?? request.method);
    assert.equal(request.headers.authorization,"Bearer fixture-secret-1234");
    if(request.method==="DELETE") {assert.equal(request.headers["mcp-session-id"],"fixture-session");response.writeHead(204);response.end();return;}
    if(body.method==="initialize") return json(response,{jsonrpc:"2.0",id:body.id,result:{protocolVersion:"2025-03-26",serverInfo:{name:"fixture"},capabilities:{tools:{}}}});
    assert.equal(request.headers["mcp-session-id"],"fixture-session");
    assert.equal(request.headers["mcp-protocol-version"],"2025-03-26");
    if(body.method==="notifications/initialized") {response.writeHead(202);response.end();return;}
    assert.equal(body.method,"tools/list");
    if(!body.params.cursor) return json(response,{jsonrpc:"2.0",id:body.id,result:{tools:[{name:"read",description:"fixture-secret-1234"}],nextCursor:"next"}});
    response.writeHead(200,{"content-type":"text/event-stream"});
    response.write('event: message\r\ndata: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\r\n\r\n');
    const reply={jsonrpc:"2.0",id:body.id,result:{tools:[{name:"read"},{name:"search",description:"Search the fixture"}]}};
    response.write(`event: message\r\ndata: ${JSON.stringify(reply)}\r\n\r\n`);
    // Leave SSE open: a correct client resolves at the matching response.
  });
  const result=await diagnoseMcp(capability({transport:"http",url,headers:{Authorization:"Bearer fixture-secret-1234"}}));
  assert.equal(result.state,"passed");assert.equal(result.toolCount,2);
  assert.deepEqual(result.tools.map(tool=>tool.name),["read","search"]);
  assert.ok(!JSON.stringify(result).includes("fixture-secret-1234"));
  assert.deepEqual(calls,["initialize","notifications/initialized","tools/list","tools/list","DELETE"]);
  assert.deepEqual(result.steps.map(step=>step.id),["configuration","launch","initialize","tools"]);
});
test("HTTP auth rejection identifies the handshake step and never claims native incompatibility",async t=>{
  const url=await server(t,(_request,response)=>{response.writeHead(401);response.end();});
  const result=await diagnoseMcp(capability({transport:"http",url}));
  assert.equal(result.state,"failed");assert.equal(result.steps.at(-1).id,"initialize");
  assert.equal(result.steps.at(-1).code,"AUTH_REQUIRED");assert.equal(result.toolCount,undefined);
});
test("stdio probe waits for initialized, handles fragmented JSONL, and shuts down the diagnostic child",async()=>{
  const script=`const r=require('readline').createInterface({input:process.stdin});let ready=false;r.on('line',line=>{const m=JSON.parse(line);if(m.method==='notifications/initialized'){ready=true;return;}const result=m.method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{tools:{}}}:ready?{tools:[{name:'fixture_tool'}]}:null;const s=JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n';process.stdout.write(s.slice(0,12));setTimeout(()=>process.stdout.write(s.slice(12)),5);});`;
  const result=await diagnoseMcp(capability({transport:"stdio",command:process.execPath,args:["-e",script]}));
  assert.equal(result.state,"passed");assert.equal(result.toolCount,1);assert.equal(result.tools[0].name,"fixture_tool");
});
test("resource-only MCP is a warning, not an empty successful tool inventory",async t=>{
  const url=await server(t,(_request,response,body)=>{
    if(body?.method==="initialize") return json(response,{jsonrpc:"2.0",id:body.id,result:{protocolVersion:"2025-03-26",capabilities:{resources:{}}}});
    response.writeHead(204);response.end();
  });
  const result=await diagnoseMcp(capability({transport:"http",url}));
  assert.equal(result.state,"warning");assert.equal(result.steps.at(-1).code,"NO_TOOLS_CAPABILITY");
});
test("catalog checks do not equate absent GET /models with absent inference support",async()=>{
  const connection={id:"api-fixture",revision:3,kind:"api",enabled:true,hasCredential:true};
  let reads=0;
  const result=await diagnoseConnection(connection,async()=>{reads++;throw new Error("GET /models failed (404)");});
  assert.equal(reads,1);assert.equal(result.state,"warning");assert.equal(result.scope,"api_catalog");
  assert.equal(result.steps.at(-1).code,"CATALOG_NOT_SUPPORTED");
  const disabled=await diagnoseConnection({...connection,enabled:false},async()=>{throw new Error("must not run");});
  assert.equal(disabled.steps[0].code,"DISABLED");
});

test("invalid endpoints and missing executables return actionable diagnostic steps",async()=>{
  const invalid=await diagnoseMcp(capability({transport:"http",url:"not-a-url"}));
  assert.equal(invalid.state,"failed");assert.equal(invalid.steps.at(-1).code,"INVALID_ENDPOINT");
  const missing=await diagnoseMcp(capability({transport:"stdio",command:"nautilo-missing-fixture-executable-98623",args:[]}));
  assert.equal(missing.state,"failed");assert.equal(missing.steps.at(-1).code,"SPAWN_FAILED");
});
