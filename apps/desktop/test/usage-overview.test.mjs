import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("vite/package.json"))("esbuild");
const bundle = await build({
  entryPoints: [fileURLToPath(new URL("../src/shared/usage-overview.ts", import.meta.url))],
  bundle: true, format: "esm", write: false, platform: "node",
});
const { buildUsageOverview } = await import("data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].text).toString("base64"));
const sql = readFileSync(new URL("../../../packages/schemas/src/usage-source.sql", import.meta.url), "utf8");
const now = new Date("2026-11-22T11:04:00Z");
function record(runId, usage, extra = {}) {
  return { sessionId: "s", title: "Build logs", projectId: "p", projectName: "Workspace",
    harness: "codex", currentModel: "gpt-6.1-sol", updatedAt: now.toISOString(), runId,
    runModel: "gpt-6.1-sol", timestamp: now.toISOString(), eventId: runId + "-usage",
    sequence: 1, usage, ...extra };
}
const usage = (input, read, output) => ({ usageScope: "turn", inputTokensIncludesCache: true, inputTokens: input, cachedInputTokens: read, outputTokens: output });

test("the SQLite projection reads every session without subscriptions or raw journal contents", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE sessions(id, project_id, data, updated_at); CREATE TABLE projects(id, data); CREATE TABLE agents(id,data); CREATE TABLE runs(id,session_id,data,updated_at); CREATE TABLE runtime_events(event_id,run_id,session_id,data,timestamp,sequence); CREATE TABLE runtime_connections(id,data);");
  db.prepare("INSERT INTO projects VALUES ('p','{\"name\":\"Workspace\"}')").run();
  const session = db.prepare("INSERT INTO sessions VALUES (?,'p',?,?)");
  for (let i=0; i<340; i++) session.run("s"+i, JSON.stringify({ title: "Build logs" }), now.toISOString());
  db.prepare("INSERT INTO runs VALUES ('r','s0','{\"model\":\"gpt-6.1-sol\",\"connectionId\":\"c\"}',?)").run(now.toISOString());
  db.prepare("INSERT INTO runtime_connections VALUES ('c', ?)").run(JSON.stringify({ apiKey:"secret", models:[{id:"gpt-6.1-sol",pricing:{input:7}}]}));
  const event = db.prepare("INSERT INTO runtime_events VALUES (?,'r','s0',?,?,?)");
  for (const [seq, payload] of [[1,usage(10,2,1)],[2,usage(20,8,2)],[3,{...usage(500,200,40),usageScope:"context"}],[4,{...usage(70,12,5),subagentDispatchId:"child"}]]) {
    event.run("e"+seq, JSON.stringify({ type:"usage.updated", payload, raw:"private tool output" }), now.toISOString(), seq);
  }
  const rows = db.prepare(sql).all("", "").map(row => JSON.parse(row.data));
  assert.equal(rows.length,340);
  assert.equal(rows.find(row=>row.runId==="r").usage.inputTokensIncludesCache,true);
  assert.equal(rows.find(row=>row.runId==="r").usage.inputTokens,20);
  assert.deepEqual(rows.find(row=>row.runId==="r").customPricing,{input:7});
  assert.equal(JSON.stringify(rows).includes("private tool output"),false);
  assert.equal(JSON.stringify(rows).includes("secret"),false);
  assert.equal(buildUsageOverview(rows, { view:"usage" }, now).summary.totalTokens,22);
  db.close();
});

test("total-only records do not dilute cache rate and custom prices override reference rates", () => {
  const source = [
    record("a", {...usage(1_000_000, 800_000, 100_000), currency:"USD", reportedCost:5},
      {customPricing:{ input:10, output:10, cacheRead:1 }}),
    record("b", { usageScope:"turn", totalTokens:500_000 }, { runModel:"private-model", sequence:2 }),
  ];
  const all = buildUsageOverview(source, {view:"usage"}, now);
  assert.equal(all.summary.totalTokens,1_600_000);
  assert.equal(all.summary.breakdownTokens,1_100_000);
  assert.equal(all.summary.cacheHitRate,80);
  assert.equal(all.summary.estimatedCostUsd,3.8);
  assert.equal(all.rows[0].costUsd,5);
  assert.equal(all.rows[0].costSource,"reported");
  assert.equal(all.unpricedModels,1);
  assert.equal(all.trendSeries[0].cachedTokens,800_000);
  assert.deepEqual(all.breakdowns.byModel.map(rank=>rank.name),["gpt-6.1-sol","private-model"]);
  assert.equal(buildUsageOverview(source,{view:"usage",query:"private-model"},now).summary.totalTokens,500_000);
});

test("time filtering subtracts a preceding native counter, excludes child sessions and never charts the baseline", () => {
  const base = {...usage(1000, 300, 100), usageScope:"session", usageKey:"native"};
  const first = record("a",base,{ timestamp:"2026-10-01T03:00:00Z" });
  const second = record("b",{...base,inputTokens:1300,cachedInputTokens:450,outputTokens:140},{ sequence:2 });
  const child = record("c",usage(90,20,20),{ sessionId:"child",parentSessionId:"s",sequence:3 });
  const hour = buildUsageOverview([first,second,child], {view:"usage",period:"24h",includeChildren:false},now);
  assert.equal(hour.summary.totalTokens,340);
  assert.equal(hour.summary.totalSessions,1);
  assert.equal(hour.summary.cacheHitRate,50);
  assert.equal(hour.trendSeries.filter(x=>x.totalTokens!==undefined).length,1);
  const all = buildUsageOverview([first,second,child], {view:"usage"},now);
  assert.equal(all.summary.totalTokens,1550);
  assert.equal(all.trendSeries.reduce((sum,x)=>sum+(x.totalTokens??0),0),450);
});
