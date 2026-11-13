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

function fixture(t, failFirst = false) {
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
    const events = new AsyncQueue();
    queueMicrotask(async () => {
      try {
        events.push({ kind: "session", providerSessionId: "native-conversation" });
        if (failFirst && requests.length === 1) {
          events.push({ kind: "error", error: new Error("HTTP 401") });
          return;
        }
        events.push({ kind: "thinking", text: "思考", phase: "delta" });
        if (!resumed) await request.executeRuntimeTool({ name: "nautilo_relay_0", arguments: { file: "a" } });
        events.push({ kind: "message", text: "完成", phase: "delta" });
        events.push({ kind: "message", text: "完成", phase: "final" });
        events.push({ kind: "usage", inputTokens: 9, outputTokens: 2, cachedInputTokens: 3 });
        events.push({ kind: "exit", exitCode: 0 });
      } catch (error) { events.push({ kind: "error", error }); }
      finally { events.close(); }
    });
    return { events, async cancel() { cancellations++; events.close(); } };
  }
  const registry = { get: () => adapter, find: () => adapter };
  const gateway = new AccountGateways(db, registry, new CredentialService(db, root));
  const account = { id: "selected-account", kind: "login", harness: "codex", enabled: true, revision: 3, name: "Selected", loginProfileDirectory: join(root, "selected-profile"), models: [] };
  const executable = join(root, process.platform === "win32" ? "login-fixture.cmd" : "login-fixture");
  writeFileSync(executable, process.platform === "win32" ? "@echo off\r\necho Logged in using ChatGPT\r\nexit /b 0\r\n" : "#!/bin/sh\necho 'Logged in using ChatGPT'\n", { mode: 0o700 });
  db.agents.save({ id: "auth-fixture", providerId: "codex", displayName: "Fixture", executable, baseArgs: [], enabled: true, providerOptions: {}, capabilities: [], createdAt: "", updatedAt: "", status: "offline" }, "now");
  db.runtimeConnections.save(account, "now");
  db.integrationSettings.save({ id: "integration-settings", schemaVersion: 1, gateway: { enabled: true, connectionIds: [account.id] }, toolServices: [] }, "now");
  t.after(async () => { await gateway.close(); db.close(); rmSync(root, { recursive: true, force: true }); });
  return { gateway, requests, account, db, cancellations: () => cancellations };
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
  return { url: request.instance.providerOptions.baseUrl, key: request.env.OPENAI_API_KEY };
}

const original = [{ role: "user", content: "读取文件" }];
const specs = [{ type: "function", function: { name: "read_file", parameters: { type: "object" } } }];
const post = (route, messages, stream = false) => fetch(`${route.url}/chat/completions`, {
  method: "POST", headers: { Authorization: `Bearer ${route.key}`, "Content-Type": "application/json" },
  body: JSON.stringify({ model: "fixture-model", messages, tools: specs, stream }),
});

test("HTTP tool roundtrip parks one native run, streams output once, and resumes the same account", async t => {
  const f = fixture(t);
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

test("failed authentication keeps the native identity without committing failed caller history", async t => {
  const f = fixture(t, true);
  const route = await bind(f);
  const failed = await post(route, original);
  assert.equal(failed.status, 502);
  assert.match((await failed.json()).error.message, /AGENT_NOT_AUTHENTICATED/);
  const retry = await post(route, [{ role: "user", content: "重试连接" }]);
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).choices[0].message.content, "完成");
  assert.equal(f.requests[1].providerSessionId, "native-conversation");
});
