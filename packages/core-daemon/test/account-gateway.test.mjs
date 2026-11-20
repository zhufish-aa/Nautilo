import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "../dist/database/index.js";
import { AsyncQueue } from "../dist/adapters/async-queue.js";
import { CredentialService } from "../dist/runtime/security/credential-service.js";
import { AccountGateways } from "../dist/runtime/account-gateway.js";
import { CallerTools } from "../dist/runtime/account-gateway/caller-tools.js";
import { streamDelta } from "../dist/runtime/account-gateway/events.js";
import { RelayError, respondError } from "../dist/runtime/account-gateway/http.js";
import { IntegrationService } from "../dist/application/integration-service.js";

test("terminal snapshots do not replay deltas or replace a newer streamed value", () => {
  const seen = new Map();
  assert.equal(streamDelta(seen, "reasoning", "先", "delta"), "先");
  assert.equal(streamDelta(seen, "reasoning", "思考", "delta"), "思考");
  assert.equal(streamDelta(seen, "reasoning", "先思考", "final"), "");
  assert.equal(streamDelta(seen, "reasoning", "先", "final"), "");
  assert.equal(streamDelta(seen, "reasoning", "先思考完成", "final"), "完成");
});

test("SSE errors use real frame boundaries", () => {
  let text = "";
  respondError({ headersSent: true, destroyed: false, writableEnded: false, end: value => { text = value; } }, new RelayError(400, "INVALID", "fixture"));
  assert.ok(text.endsWith("data: [DONE]\n\n"));
  assert.equal(text.split("\n\n").filter(Boolean).length, 2);
});

test("parallel caller tools retain their names and resolve their own native calls", async () => {
  const tools = new CallerTools();
  const output = new AsyncQueue();
  const binding = tools.bind([
    { type: "function", function: { name: "read_file" } },
    { type: "function", function: { name: "search" } },
  ], output);
  const first = binding.executeRuntimeTool({ name: "nautilo_relay_0", arguments: { path: "a" } });
  const second = binding.executeRuntimeTool({ name: "nautilo_relay_1", arguments: "{}" });
  const iterator = output[Symbol.asyncIterator]();
  const a = (await iterator.next()).value.tool_calls[0];
  const b = (await iterator.next()).value.tool_calls[0];
  assert.equal(a.function.name, "read_file");
  assert.equal(b.function.name, "search");
  assert.notEqual(a.id, b.id);
  assert.equal(tools.deliver([{ role: "tool", tool_call_id: b.id, content: "search result" }]), 1);
  assert.equal((await second).content, "search result");
  tools.cancel();
  await assert.rejects(first, /cancelled/);
  assert.equal(tools.deliver([{ role: "tool", tool_call_id: a.id, content: "late" }]), 0);
});

function fixture(t, failFirst = false, harness = "codex", controls = {}) {
  const root = mkdtempSync(join(tmpdir(), "nautilo-account-relay-"));
  const db = new Database(":memory:");
  const requests = [];
  let cancellations = 0;
  const adapter = {
    descriptor: { defaultExecutable: "fixture-codex", credentialEnv: ["OPENAI_API_KEY"] },
    start(request) { return start(request, false); },
    resume(request) { return start(request, true); },
  };
  function start(request, resumed) {
    requests.push(request);
    const nativeId = request.providerSessionId ?? (controls.uniqueSessions ? `native-${requests.length}` : "native-conversation");
    const events = new AsyncQueue();
    queueMicrotask(async () => {
      try {
        events.push({ kind: "session", providerSessionId: nativeId });
        await controls.beforeReply?.(request);
        if (failFirst && requests.length === 1) {
          events.push({ kind: "error", error: new Error("HTTP 401") });
          return;
        }
        events.push({ kind: "thinking", text: "思考", phase: "delta" });
        if (!resumed && request.runtimeTools?.length) await request.executeRuntimeTool({ name: "nautilo_relay_0", arguments: { file: "a" } });
        const text=controls.reply?.(request)??"完成";
        events.push({ kind: "message", text, phase: "delta" });
        events.push({ kind: "message", text, phase: "final" });
        events.push({ kind: "usage", inputTokens: 9, outputTokens: 2, cachedInputTokens: 3 });
        events.push({ kind: "exit", exitCode: 0 });
      } catch (error) { events.push({ kind: "error", error }); }
      finally { events.close(); }
    });
    return { events, async cancel() { cancellations++; controls.onCancel?.(request); events.close(); } };
  }
  const registry = { get: () => adapter, find: () => adapter, listModels: async () => ({models:[{id:"opencode/fixture-free",reasoningEfforts:["low","high","max"],contextWindow:200000}]}) };
  const gateway = new AccountGateways(db, registry, new CredentialService(db, root));
  const account = { id: "selected-account", kind: "login", harness, ...(harness === "opencode" ? { nativeLogin: true } : { loginProfileDirectory: join(root, "selected-profile") }), enabled: true, revision: 3, name: "Selected", models: [] };
  const executable = join(root, process.platform === "win32" ? "login-fixture.cmd" : "login-fixture");
  writeFileSync(executable, process.platform === "win32" ? "@echo off\r\necho Logged in using ChatGPT\r\nexit /b 0\r\n" : "#!/bin/sh\necho 'Logged in using ChatGPT'\n", { mode: 0o700 });
  db.agents.save({ id: "auth-fixture", providerId: harness, displayName: "Fixture", executable, baseArgs: [], enabled: true, providerOptions: {}, capabilities: [], createdAt: "", updatedAt: "", status: "offline" }, "now");
  db.runtimeConnections.save(account, "now");
  db.integrationSettings.save({ id: "integration-settings", schemaVersion: 1, gateway: { enabled: true, connectionIds: [account.id] }, toolServices: [] }, "now");
  t.after(async () => { await gateway.close(); db.close(); rmSync(root, { recursive: true, force: true }); });
  return { gateway, requests, account, db, registry, credentials:new CredentialService(db,root), cancellations: () => cancellations };
}

test("selecting an account enables only that account and retains unrelated integration settings", t => {
  const { db, account } = fixture(t);
  const service = new IntegrationService(db);
  const original = service.get();
  db.integrationSettings.save({ ...original, gateway: { enabled: false, connectionIds: [account.id] }, toolServices: [{ purpose: "search", enabled: false }] }, "now");
  const other = { ...account, id: "other-account" };
  db.runtimeConnections.save(other, "now");
  service.setAccountRoute(other.id, true);
  assert.deepEqual(service.get().gateway, { enabled: true, connectionIds: [other.id] });
  assert.deepEqual(service.get().toolServices, [{ purpose: "search", enabled: false }]);
  service.setAccountRoute(account.id, true);
  service.setAccountRoute(other.id, false);
  assert.deepEqual(service.get().gateway, { enabled: true, connectionIds: [account.id] });
  service.setAccountRoute(account.id, false);
  assert.deepEqual(service.get().gateway, { enabled: false, connectionIds: [] });
  assert.throws(() => service.setAccountRoute("not-an-account", true));
  assert.deepEqual(service.get().gateway, { enabled: false, connectionIds: [] });
});

async function bind(fixture) {
  const request = { instance: { id: "outer", providerId: "pi", providerOptions: {} }, cwd: tmpdir() };
  await fixture.gateway.bind("chat", fixture.account, request);
  return { url: request.instance.providerOptions.baseUrl, key: request.env.OPENAI_API_KEY, model: fixture.account.harness === "opencode" ? "opencode/fixture-free" : "fixture-model" };
}

test("OpenCode model reasoning capabilities reach the outer harness with explicit overrides intact", async t => {
  const f = fixture(t, false, "opencode");
  const request = { instance: {id:"outer",providerId:"deepseek",providerOptions:{},models:[{id:"opencode/fixture-free",contextWindow:12345}]}, cwd:tmpdir(), model:"opencode/fixture-free", reasoningEffort:"max" };
  await f.gateway.bind("capabilities",f.account,request);
  assert.deepEqual(request.instance.models[0].reasoningEfforts,["low","high","max"]);
  assert.equal(request.instance.models[0].contextWindow,12345);
});

for (const titleStream of [false,true]) test(`title completions keep a separate native conversation even when stream=${titleStream}`, async t => {
  const f=fixture(t,false,"opencode");
  const request={instance:{id:"outer",providerId:"deepseek",providerOptions:{}},cwd:tmpdir(),model:"opencode/fixture-free"};
  await f.gateway.bind("deepseek-title",f.account,request);
  const route={url:request.instance.providerOptions.baseUrl,key:request.env.OPENAI_API_KEY,model:request.model};
  const title=()=>fetch(`${route.url}/chat/completions`,{method:"POST",headers:{authorization:`Bearer ${route.key}`,"content-type":"application/json"},body:JSON.stringify({model:route.model,messages:[{role:"user",content:"Generate a title"}],stream:titleStream})});
  assert.equal((await title()).status,200);
  const response=await post(route,original,true);
  assert.equal(response.status,200); const text=await response.text();
  const call=text.split("\n\n").filter(line=>line.startsWith("data: {")).map(line=>JSON.parse(line.slice(6))).flatMap(frame=>frame.choices?.[0]?.delta?.tool_calls??[])[0];
  assert.ok(call); assert.equal(f.requests[1].providerSessionId,undefined,"the title's native session must not be resumed by the main agent");
  const history=[...original,{role:"assistant",content:"",tool_calls:[call]},{role:"tool",tool_call_id:call.id,content:"real file result"}];
  const final=await post(route,history,true); assert.equal(final.status,200); await final.text();
  assert.equal((await title()).status,200);
  const next=await post(route,[...history,{role:"assistant",content:"完成"},{role:"user",content:"继续"}],true);
  assert.equal(next.status,200);await next.text();
  assert.equal(f.requests.at(-1).providerSessionId,"native-conversation");
  assert.ok(!f.requests.at(-1).prompt.includes("Generate a title"));
  assert.notEqual(f.requests[0].localSessionId,f.requests[1].localSessionId);
});

const postJson = (route, body, signal) => fetch(`${route.url}/chat/completions`,{
  method:"POST",headers:{authorization:`Bearer ${route.key}`,"content-type":"application/json"},
  body:JSON.stringify({model:route.model,...body}),signal,
});

test("rewritten history, new tools and duplicate HTTP retries are fresh model calls, not 409s",async t=>{
  const f=fixture(t,false,"opencode",{uniqueSessions:true}),route=await bind(f);
  const first=await postJson(route,{messages:[{role:"user",content:"Original request"}]});await first.text();
  const rewritten=[{role:"system",content:"Compacted caller context"},{role:"assistant",content:"",tool_calls:[{id:"historical",type:"function",function:{name:"read_file",arguments:"{}"}}]},{role:"tool",tool_call_id:"historical",content:"HISTORICAL_RESULT"},{role:"user",content:"Continue from this context"}];
  for(let i=0;i<2;i++){
    const response=await postJson(route,{messages:rewritten});assert.equal(response.status,200);await response.text();
    assert.equal(f.requests.at(-1).providerSessionId,undefined);
    assert.match(f.requests.at(-1).prompt,/HISTORICAL_RESULT/);
    assert.match(f.requests.at(-1).prompt,/tool_calls/);
  }
  const changed=await postJson(route,{messages:[...rewritten,{role:"assistant",content:"完成"},{role:"user",content:"New tool set"}],tools:specs});
  assert.equal(changed.status,200);assert.equal((await changed.json()).choices[0].message.tool_calls[0].function.name,"read_file");
  assert.equal(f.requests.at(-1).providerSessionId,undefined);
});

test("independent requests on one account run concurrently without sharing their output or native IDs",{timeout:5000},async t=>{
  const releases=[];
  const f=fixture(t,false,"opencode",{uniqueSessions:true,beforeReply:()=>new Promise(resolve=>{releases.push(resolve);if(releases.length===2)releases.forEach(release=>release());}),reply:request=>request.prompt.includes("PARALLEL_A")?"A":"B"});
  const route=await bind(f);
  const responses=await Promise.all(["PARALLEL_A","PARALLEL_B"].map(content=>postJson(route,{messages:[{role:"user",content}]})));
  assert.deepEqual(responses.map(response=>response.status),[200,200]);
  assert.deepEqual(await Promise.all(responses.map(async response=>(await response.json()).choices[0].message.content)),["A","B"]);
  assert.notEqual(f.requests[0].localSessionId,f.requests[1].localSessionId);
});

test("cancelling one account HTTP request leaves an unrelated request running",{timeout:5000},async t=>{
  let started;const ready=new Promise(resolve=>started=resolve);let release;
  const cancelled=[];
  const f=fixture(t,false,"opencode",{uniqueSessions:true,beforeReply:request=>request.prompt.includes("CANCEL_THIS")?new Promise(resolve=>{release=resolve;started();}):undefined,onCancel:request=>{cancelled.push(request.prompt);release?.();}});
  const route=await bind(f),abort=new AbortController();
  const waiting=postJson(route,{messages:[{role:"user",content:"CANCEL_THIS"}]},abort.signal);
  const rejected=assert.rejects(waiting,/abort/i);
  await ready;abort.abort();await rejected;
  const other=await postJson(route,{messages:[{role:"user",content:"KEEP_RUNNING"}]});
  assert.equal(other.status,200);assert.equal((await other.json()).choices[0].message.content,"完成");
  await new Promise(resolve=>setImmediate(resolve));
  assert.ok(cancelled.some(prompt=>prompt.includes("CANCEL_THIS")));
  assert.ok(!cancelled.some(prompt=>prompt.includes("KEEP_RUNNING")));
});

test("a restarted gateway can resume each matching native conversation without pinning unrelated calls",async t=>{
  const f=fixture(t,false,"opencode",{uniqueSessions:true}),route=await bind(f);
  for(const content of ["CONVERSATION_A","CONVERSATION_B"]){const r=await postJson(route,{messages:[{role:"user",content}]});await r.text();}
  await f.gateway.close();
  const restored=new AccountGateways(f.db,f.registry,f.credentials);t.after(()=>restored.close());
  const request={instance:{id:"outer",providerId:"pi",providerOptions:{}},cwd:tmpdir()};
  await restored.bind("chat",f.account,request);
  const nextRoute={...route,url:request.instance.providerOptions.baseUrl,key:request.env.OPENAI_API_KEY};
  const result=await postJson(nextRoute,{messages:[{role:"user",content:"CONVERSATION_A"},{role:"assistant",content:"完成"},{role:"user",content:"Continue A"}]});
  assert.equal(result.status,200);await result.text();
  assert.equal(f.requests.at(-1).providerSessionId,"native-1");
  assert.ok(!f.requests.at(-1).prompt.includes("CONVERSATION_B"));
});

test("retry branches resume the native run that actually produced the caller's assistant answer", async t => {
  const f = fixture(t, false, "opencode", { uniqueSessions: true, reply: () => `BRANCH_${f.requests.length}` });
  const route = await bind(f), original = { role: "user", content: "Same input, separate retries" };
  for (const expected of ["BRANCH_1", "BRANCH_2"]) {
    const response = await postJson(route, { messages: [original] });
    assert.equal((await response.json()).choices[0].message.content, expected);
  }
  const continued = await postJson(route, { messages: [original, { role: "assistant", content: "BRANCH_1" }, { role: "user", content: "Continue the first answer" }] });
  assert.equal(continued.status, 200); await continued.text();
  assert.equal(f.requests[2].providerSessionId, "native-1");
});

const original = [{ role: "user", content: "读取文件" }];
const specs = [{ type: "function", function: { name: "read_file", parameters: { type: "object" } } }];
const post = (route, messages, stream = false) => fetch(`${route.url}/chat/completions`, {
  method: "POST", headers: { Authorization: `Bearer ${route.key}`, "Content-Type": "application/json" },
  body: JSON.stringify({ model: route.model, messages, tools: specs, stream }),
});

for (const harness of ["codex", "opencode"]) test(`${harness} HTTP tool roundtrip parks one native run, streams output once, and resumes the same account`, async t => {
  const f = fixture(t, false, harness);
  const route = await bind(f);
  const first = await (await post(route, original)).json();
  const calls = first.choices[0].message.tool_calls;
  assert.equal(calls[0].function.name, "read_file");
  const history = [...original, { role: "assistant", content: "", tool_calls: calls }, { role: "tool", tool_call_id: calls[0].id, content: "real file result" }];
  const final = await (await post(route, history, true)).text();
  const frames = final.split("\n\n").filter(value => value.startsWith("data: {")).map(value => JSON.parse(value.slice(6)));
  assert.equal(frames.map(frame => frame.choices?.[0]?.delta?.content ?? "").join(""), "完成");
  assert.equal(frames.find(frame => frame.usage)?.usage.prompt_tokens, 9);
  assert.equal(f.requests.length, 1);
  const next = await post(route, [...history, { role: "assistant", content: "完成" }, { role: "user", content: "继续" }]);
  assert.equal(next.status, 200);
  await next.text();
  assert.equal(f.requests[1].providerSessionId, "native-conversation");
  assert.equal(f.requests[1].instance.providerOptions.loginProfileDirectory, f.account.loginProfileDirectory);
  assert.ok(!f.requests[1].prompt.includes("读取文件"));
  if (harness === "opencode") {
    assert.equal(f.requests[1].instance.providerOptions.nativeLogin, true);
    assert.equal(f.requests[1].env.NAUTILO_CONNECTION_API_KEY, undefined);
    assert.equal(f.requests[1].model, "opencode/fixture-free");
    new IntegrationService(f.db).setAccountRoute(f.account.id, false);
    const disabled = await post(route, original);
    assert.equal(disabled.status, 403);
  }
});

test("disabling a selected account route blocks it without silently switching accounts", async t => {
  const f = fixture(t);
  const route = await bind(f);
  f.db.integrationSettings.save({ id: "integration-settings", schemaVersion: 1, gateway: { enabled: false, connectionIds: [] }, toolServices: [] }, "later");
  const response = await post(route, original);
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, "ACCOUNT_ROUTE_DISABLED");
  assert.equal(f.requests.length, 0);
});

test("failed authentication retries the same pinned account without reusing a failed native turn", async t => {
  const f = fixture(t, true);
  const route = await bind(f);
  const failed = await post(route, original);
  assert.equal(failed.status, 502);
  assert.match((await failed.json()).error.message, /AGENT_NOT_AUTHENTICATED/);
  const retry = await post(route, [{ role: "user", content: "重试连接" }]);
  assert.equal(retry.status, 200);
  const call=(await retry.json()).choices[0].message.tool_calls[0];
  assert.ok(call);
  assert.equal(f.requests[1].providerSessionId, undefined);
  assert.equal(f.requests[1].instance.providerOptions.loginProfileDirectory,f.account.loginProfileDirectory);
  const result=await post(route,[{role:"user",content:"重试连接"},{role:"assistant",tool_calls:[call],content:""},{role:"tool",tool_call_id:call.id,content:"real result"}]);
  assert.equal((await result.json()).choices[0].message.content,"完成");
});
