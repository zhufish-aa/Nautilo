import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
const source = await readFile(new URL("../src/renderer/src/lib/session-usage.ts", import.meta.url), "utf8");
const { aggregateSessionUsage, estimateSnapshot } = await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText)}`);
const event = (id, payload, sequence = Number(id), runId = "run") => ({ eventId: String(id), sequence, runId, type: "usage.updated", payload });
const usage = { usageScope: "turn", inputTokens: 100, outputTokens: 20, inputTokensIncludesCache: true };
test("usage snapshots replace rather than sum duplicate/cumulative reports", () => {
 const a = event(1, usage), b = event(2, {...usage, inputTokens: 200});
 assert.equal(aggregateSessionUsage([b,a,a,b]).totalTokens,220);
 assert.equal(aggregateSessionUsage([a,event(2,usage,2,"other")]).totalTokens,240);
});
test("session cumulative snapshots span turns without duplicate totals", () => {
 const payload = {...usage,usageScope:"session",usageKey:"native-thread"};
 assert.equal(aggregateSessionUsage([event(1,payload,1,"a"),event(2,{...payload,inputTokens:300},2,"b")]).totalTokens,320);
});
test("context and ambiguous legacy events never become throughput", () => {
 const result = aggregateSessionUsage([event(1,{...usage,usageScope:"context"}),event(2,{inputTokens:99,outputTokens:8})]);
 assert.equal(result.totalTokens,undefined); assert.equal(result.unclassifiedEvents,1);
});
test("known zero remains zero; unavailable, negative, NaN do not", () => {
 assert.equal(aggregateSessionUsage([event(1,{...usage,inputTokens:0,outputTokens:0,reportedCost:0,currency:"USD"})]).reportedCost,0);
 assert.equal(aggregateSessionUsage([event(1,{...usage,inputTokens:0,outputTokens:0})]).totalTokens,0);
 assert.equal(aggregateSessionUsage([event(1,{...usage,inputTokens:-1})]).totalTokens,undefined);
 assert.equal(aggregateSessionUsage([event(1,{...usage,inputTokens:NaN})]).totalTokens,undefined);
 assert.equal(aggregateSessionUsage([]).reportedCost,undefined);
});
test("Claude cache additions and Codex cache subsets have different totals", () => {
 const cached = {...usage,cachedInputTokens:40,cacheCreationInputTokens:10};
 assert.equal(aggregateSessionUsage([event(1,{...cached,inputTokensIncludesCache:false})]).totalTokens,170);
 assert.equal(aggregateSessionUsage([event(1,cached)]).totalTokens,120);
});
test("reasoning tokens are not added to already inclusive output", () => {
 assert.equal(aggregateSessionUsage([event(1,{...usage,reasoningOutputTokens:5})]).totalTokens,120);
});
test("currency must be explicit USD and missing reports stay unavailable", () => {
 assert.equal(aggregateSessionUsage([event(1,{...usage,reportedCost:12,currency:"EUR"})]).reportedCost,undefined);
 assert.equal(aggregateSessionUsage([event(1,{...usage,reportedCost:12})]).reportedCost,undefined);
});
test("estimates require all nonzero categories to have rates, and honor free rates", () => {
 const cached = {...usage,cachedInputTokens:40};
 assert.equal(estimateSnapshot(cached,{input:2,output:4}),undefined);
 assert.equal(estimateSnapshot(cached,{input:2,output:4,cacheRead:0}),0.0002);
 assert.equal(estimateSnapshot(cached,{input:0,output:0,cacheRead:0}),0);
 assert.equal(estimateSnapshot({...cached,inputTokens:10},{input:2,output:4,cacheRead:1}),undefined);
});
test("cumulative sessions cannot be priced by their latest model", () => {
 assert.equal(estimateSnapshot({...usage,usageScope:"session",model:"latest"},{input:2,output:4}),undefined);
});

test("missing cache counters cannot silently become zero in totals or estimates", () => {
 assert.equal(aggregateSessionUsage([event(1,{...usage,inputTokensIncludesCache:false})]).totalTokens,undefined);
 assert.equal(estimateSnapshot(usage,{input:2,output:4}),undefined);
 assert.equal(estimateSnapshot({...usage,inputTokensIncludesCache:false},{input:2,output:4}),undefined);
});
test("native usage IDs are scoped to connection revision and legacy Agent identity", () => {
 const snapshot = {...usage,usageScope:"session",usageKey:"same-native-id"};
 const events = [event(1,{...snapshot,connectionId:"a",connectionRevision:1}),event(2,{...snapshot,connectionId:"b",connectionRevision:1}),event(3,{...snapshot,connectionId:"a",connectionRevision:2})];
 assert.equal(aggregateSessionUsage(events).totalTokens,360);
 assert.equal(aggregateSessionUsage([...events,event(4,{...snapshot,connectionId:"a",connectionRevision:1,inputTokens:200})]).totalTokens,460);
 assert.equal(aggregateSessionUsage([event(1,{...snapshot,agentInstanceId:"legacy-a"}),event(2,{...snapshot,agentInstanceId:"legacy-b"})]).totalTokens,240);
});
