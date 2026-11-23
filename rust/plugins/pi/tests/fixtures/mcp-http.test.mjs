import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import install from "../../agenthub_provider_extension.mjs";

test("Pi reads replies from an open MCP event stream and calls the tool", {timeout: 3000}, async () => {
  const methods = [];
  const server = createServer(async (request,response) => {
    if (request.method === "DELETE") { response.writeHead(204).end(); return; }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const message = JSON.parse(Buffer.concat(chunks));
    methods.push([message.method,request.headers["mcp-protocol-version"],request.headers["mcp-session-id"]]);
    if (!message.id) { response.writeHead(202).end(); return; }
    const result = message.method === "initialize" ? {protocolVersion:"2025-03-26"}
      : message.method === "tools/list" ? {tools:[{name:"delegate",inputSchema:{type:"object"}}]}
      : {content:[{type:"text",text:"receipt:"+message.params.arguments.task}]};
    response.writeHead(200,{"content-type":"text/event-stream","mcp-session-id":"fixture"});
    response.write("data: "+JSON.stringify({jsonrpc:"2.0",method:"notifications/progress"})+"\r\n\r\n");
    response.write("data: "+JSON.stringify({jsonrpc:"2.0",id:message.id,result})+"\r\n");
    response.write("\r\n");
  });
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  process.env.AGENTHUB_PI_MCP_SERVERS=JSON.stringify([
    {name:"agenthub",transport:"http",url:"http://127.0.0.1:"+server.address().port}
  ]);
  const hooks = new Map(), tools = new Map();
  try {
    await install({on:(name,hook)=>hooks.set(name,hook),registerTool:tool=>tools.set(tool.name,tool)});
    const result = await tools.get("mcp_agenthub_delegate").execute("call",{task:"inspect"});
    assert.equal(result.content[0].text,"receipt:inspect");
    assert.deepEqual(methods.slice(1),[
      ["notifications/initialized","2025-03-26","fixture"],
      ["tools/list","2025-03-26","fixture"],
      ["tools/call","2025-03-26","fixture"],
    ]);
    await hooks.get("session_shutdown")();
  } finally {
    delete process.env.AGENTHUB_PI_MCP_SERVERS;
    server.closeAllConnections();
    await new Promise(resolve=>server.close(resolve));
  }
});
