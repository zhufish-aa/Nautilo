import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import ts from "typescript";
const compiled=ts.transpileModule(readFileSync(new URL("../src/renderer/src/lib/context-usage.ts",import.meta.url),"utf8"),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const {latestContextUsage}=await import(`data:text/javascript,${encodeURIComponent(compiled)}`);
const usage=payload=>({type:"usage.updated",payload});
test("accounting snapshots do not erase native context pressure or capacity",()=>{
  const events=[usage({usageScope:"context",contextWindow:128000}),usage({usageScope:"context",contextUsed:8123}),usage({usageScope:"turn",inputTokens:30000,outputTokens:500,contextUsed:null,contextWindow:null})];
  assert.deepEqual(latestContextUsage(events),{contextUsed:8123,contextWindow:128000});
  assert.deepEqual(latestContextUsage([...events,usage({usageScope:"context",contextUsed:1000})]),{contextUsed:1000,contextWindow:128000});
});
test("missing context stays unknown, zero stays zero and invalid fields are ignored",()=>{
  assert.equal(latestContextUsage([usage({usageScope:"turn",inputTokens:999})]),undefined);
  assert.deepEqual(latestContextUsage([usage({contextUsed:0,contextWindow:100}),usage({contextUsed:-1,contextWindow:NaN})]),{contextUsed:0,contextWindow:100});
});
