import test from "node:test";
import assert from "node:assert/strict";
import { createHarness } from "./helpers/orchestration-runtime-harness.mjs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const request = (id, sequence, extra = {}) => ({schemaVersion: 1, eventId: `e-${sequence}`, sessionId: "s", projectId: "p", sequence, timestamp: `2026-11-06T00:00:${String(sequence).padStart(2, "0")}Z`, type: "approval.requested", payload: {approvalId: id, category: "command", summary: "Launch Pi", operation: "agent.launch:pi"}, ...extra});
const decision = (id, sequence, value = "approved") => ({...request(id, sequence), type: "approval.resolved", payload: {approvalId: id, decision: value, scope: "once"}});
const cards = (events) => createHarness().runtime.buildStandaloneTimeline([], events, []).filter((event) => event.data.kind === "approval");

test("repeated pending launch approvals share one stable row, including legacy records", () => {
  for (const legacy of [false, true]) {
    const events = [request("a", 1), request("b", 2), request("c", 3)];
    if (legacy) for (const event of events) delete event.payload.operation;
    const rows = cards(events);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, "e-1");
    assert.equal(rows[0].data.approval.id, "a");
    const resolved = cards([...events, decision("b", 4)]);
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0].id, rows[0].id);
    assert.equal(resolved[0].data.approval.status, "approved");
    assert.equal(resolved[0].data.approval.decisionScope, "once");
  }
});

test("new approval after a decision and a different operation remain separate", () => {
  const rows = cards([request("a", 1), request("a", 2), decision("a", 3, "rejected"), request("b", 4), request("c", 5, {payload: {approvalId: "c", category: "command", summary: "Launch Pi", operation: "agent.launch:other"}})]);
  assert.equal(rows.length, 3);
  assert.deepEqual(Array.from(rows, (row) => row.data.approval.status), ["rejected", "pending", "pending"]);
});

const require = createRequire(import.meta.url);
let JSDOM;
try { ({ JSDOM } = require(process.env.NAUTILO_JSDOM_PATH ?? "jsdom")); } catch {}

test("approval controls retain the chosen scope, prevent double submits and recover from failure", {skip: !JSDOM}, async () => {
  const desktop = fileURLToPath(new URL("..", import.meta.url));
  const {build} = createRequire(require.resolve("vite/package.json"))("esbuild");
  const bundle = await build({stdin: {resolveDir: desktop, loader: "tsx", contents: `
    import React from 'react'; import {createRoot} from 'react-dom/client'; import {flushSync} from 'react-dom';
    import {I18nProvider} from './src/renderer/src/lib/i18n';
    import {ManagedApprovalCard} from './src/renderer/src/features/timeline/ManagedApprovalCard';
    const root=createRoot(document.getElementById('root'));
    window.qa={calls:[],render(status='pending') {flushSync(()=>root.render(<I18nProvider><ManagedApprovalCard approval={{id:'a',kind:'command',title:'运行审批',description:'Launch Pi',status,createdAt:'2026-11-06',decisionScope:'run',runScope:'session',availableScopes:['once','run','project','global']}} onResolve={(approved,scope)=>{this.calls.push([approved,scope]);return new Promise((resolve,reject)=>{this.resolve=resolve;this.reject=reject;});}}/></I18nProvider>));},close:()=>flushSync(()=>root.unmount())};
  `}, bundle: true, platform: "browser", format: "iife", jsx: "automatic", write: false, nodePaths: [join(desktop,"node_modules")], define: {"process.env.NODE_ENV": '"test"'}, loader: {".css":"empty"}});
  const dom = new JSDOM('<div id="root"></div>', {url:"http://localhost", runScripts:"outside-only", pretendToBeVisual:true});
  const w = dom.window;
  w.matchMedia = () => ({matches:false,addEventListener(){},removeEventListener(){},addListener(){},removeListener(){}});
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const button = (text) => [...w.document.querySelectorAll("button")].find((item) => item.textContent.trim() === text);
  try {
    w.eval(bundle.outputFiles[0].text);
    w.qa.render(); await tick();
    assert.equal(w.document.querySelector("h3").textContent, "启动 Pi");
    assert.equal(w.document.querySelector('[role="combobox"]').textContent, "此会话");
    button("批准").click(); button("批准").click(); await tick();
    assert.equal(w.qa.calls.length, 1);
    assert.deepEqual(Array.from(w.qa.calls[0]), [true, "run"]);
    assert.equal(button("批准").disabled, true);
    w.qa.reject(new w.Error("Save failed")); await tick();
    assert.equal(w.document.querySelector('[role="alert"]').textContent, "Save failed");
    assert.equal(button("批准").disabled, false);
    button("拒绝").click(); await tick();
    assert.deepEqual(Array.from(w.qa.calls[1]), [false, "run"]);
    w.qa.resolve(); await tick(); w.qa.render("rejected"); await tick();
    assert.equal(button("批准"), undefined);
    assert.ok(w.document.body.textContent.includes("已拒绝"));
  } finally {w.qa?.close(); w.close();}
});

test("only valid scopes are offered and standalone run scope is a session scope", () => {
  const solo = cards([request("a", 1)])[0].data.approval;
  assert.equal(solo.runScope, "session");
  assert.deepEqual([...solo.availableScopes], ["once", "run", "project", "global"]);
  const task = cards([request("b", 1, {projectRunId: "pr", taskId: "task"})])[0].data.approval;
  assert.equal(task.runScope, "run");
  assert.deepEqual([...task.availableScopes], ["once", "run", "task", "project", "global"]);
});

test("failed approval persistence leaves the card pending instead of showing a false success", async () => {
  const h = createHarness({failMethod: "approval.resolve"});
  h.state._append("s", {kind: "approval", approval: {id:"a",kind:"command",status:"pending",title:"运行审批",description:"Launch Pi",createdAt:h.session.createdAt}});
  const resolving = h.runtime.resolveWorkbenchApproval("s", "a", true, "once");
  const failed = assert.rejects(resolving, /simulated IPC failure/);
  assert.equal(h.state.events.s[0].data.approval.status, "pending");
  await h.advance(100); await failed;
  assert.equal(h.state.events.s[0].data.approval.status, "pending");
});
