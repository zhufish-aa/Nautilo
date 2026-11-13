import test from "node:test";
import assert from "node:assert/strict";
import { Database } from "../dist/database/index.js";
import { RequestLogService } from "../dist/runtime/request-log.js";
import { RedactionService } from "../dist/runtime/security/redaction-service.js";

function fixture(t){const db=new Database(":memory:");t.after(()=>db.close());return{db,service:new RequestLogService(db,new RedactionService(()=>["fixture-private-key"]))};}
const session={id:"session",projectId:"project",connectionId:"account",connectionRevision:7,model:"fixture-model"};
const agent={id:"harness",providerId:"claude-code"};

test("request logs preserve first streamed milestones, account revision and evidence without saving content",t=>{
  const {db,service}=fixture(t);const id=service.begin(session,agent,"message","message-1");
  service.mark(id,"preparing");service.attach(id,"run-1");service.supplied(id,[{name:"managed"}],[{name:"server"}]);service.mark(id,"dispatched");
  service.observe(id,{kind:"status",phase:"runtime_ready",raw:{reused:true,attachMs:8,pid:42}});
  service.observe(id,{kind:"status",phase:"runtime_capabilities",raw:{tools:["native","managed"],mcpServers:[{name:"server",status:"connected"}]}});
  service.observe(id,{kind:"thinking",text:"private reasoning",phase:"delta"});service.observe(id,{kind:"message",text:"private answer",phase:"delta"});
  const first=db.requestLogs.get(id).milestones.firstText;
  service.observe(id,{kind:"message",text:"another private answer",phase:"delta"});service.observe(id,{kind:"tool",name:"native",input:{secret:"do-not-save"}});service.finish(id,"completed");
  const row=db.requestLogs.page({sessionId:"session"}).items[0];assert.equal(row.milestones.firstText,first);assert.equal(row.connectionRevision,7);assert.equal(row.runtime.reused,true);assert.equal(row.status,"completed");
  assert.ok(!/private answer|private reasoning|do-not-save/.test(JSON.stringify(row)));
  const tools=service.inventory("session");assert.equal(tools.nativeReported,true);assert.equal(tools.tools.find(t=>t.name==="managed").evidence,"native");assert.equal(tools.servers[0].status,"connected");
});
test("queued cancellation and preparation failures are recorded without creating a native run",t=>{
  const {db,service}=fixture(t);const id=service.begin(session,agent,"message","queued");service.cancelQueued("session","queued");assert.equal(db.requestLogs.get(id).status,"cancelled");assert.equal(db.requestLogs.get(id).runId,undefined);
  const failed=service.begin(session,agent,"message");service.mark(failed,"preparing");service.finish(failed,"failed","CONFIG_INVALID","bad fixture-private-key");const row=db.requestLogs.get(failed);assert.equal(row.failure.stage,"preparation");assert.ok(!row.failure.message.includes("fixture-private-key"));
});

test("native startup details retain measured phases and omit unrelated configuration", t => {
  const { db, service } = fixture(t);
  const id = service.begin(session, agent, "message");
  const startupTimings = {
    prepareMs: 7, bootstrapMs: 3426, sessionOpenMs: 3245,
    openDetails: {
      providerBindMs: 2960, sessionCreateMs: 271, agentResolveMs: 0, preferencesMs: 2,
      loaderWaitMs: 2946, providerUpdateMs: 13, pendingPlugins: ["@deepseek-ai/dsh-mcp-client"],
    },
  };
  service.observe(id, {
    kind: "status", phase: "runtime_ready",
    raw: { reused: false, startupTimings: { ...startupTimings, credential: "do-not-save" } },
  });
  assert.deepEqual(db.requestLogs.get(id).runtime.startupTimings, startupTimings);
  assert.ok(!JSON.stringify(db.requestLogs.get(id)).includes("do-not-save"));
});
test("request log pagination is stable for tied timestamps and restart does not invent missing timings",t=>{
  const {db,service}=fixture(t);for(let n=0;n<5;n++){const id=service.begin(session,agent,"message");const row=db.requestLogs.get(id);row.createdAt="2026-11-12T01:00:00Z";db.requestLogs.save(row,row.updatedAt);}
  const page=db.requestLogs.page({limit:2}),next=db.requestLogs.page({limit:2,before:page.nextCursor});assert.equal(new Set([...page.items,...next.items].map(r=>r.id)).size,4);
  new RequestLogService(db);const row=db.requestLogs.get(page.items[0].id);assert.equal(row.status,"interrupted");assert.equal(row.milestones.firstText,undefined);assert.equal(row.milestones.ended,undefined);
});
