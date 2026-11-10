import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
const source = await readFile(new URL("../src/renderer/src/features/agents/model-editor.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { modelRow, serializeModels, effortValues } = await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(compiled)}`);
const row = (patch = {}) => ({ ...modelRow({ id: "upstream-model", reasoningEfforts: ["low", "high"] }, "one"), ...patch });
test("model editor retains disabled models, explicit default and zero prices", () => {
  const [model] = serializeModels([row({ enabled: false, defaultReasoningEffort: "high", input: "0", output: "1.25", cacheRead: "0.05", cacheWrite: "2" })]);
  assert.equal(model.id, "upstream-model"); assert.equal(model.enabled, false); assert.equal(model.defaultReasoningEffort, "high");
  assert.deepEqual(model.pricing, { input: 0, output: 1.25, cacheRead: .05, cacheWrite: 2 });
  assert.deepEqual(serializeModels([modelRow(model, "two")]), [model]);
});
test("unset prices stay unset, rather than silently free", () => { assert.equal(serializeModels([row()])[0].pricing, undefined); });
test("duplicates, empty model IDs, invalid context and negative/nonfinite prices are rejected", () => {
  assert.throws(() => serializeModels([row(), row()]), /Duplicate/);
  assert.throws(() => serializeModels([row({ id: " " })]), /required/);
  for (const contextWindow of ["-1", "0", "1.2", "100abc"]) assert.throws(() => serializeModels([row({ contextWindow })]), /positive integer/);
  for (const input of ["-1", "NaN", "Infinity"]) assert.throws(() => serializeModels([row({ input })]), /non-negative/);
});
test("reasoning supports custom provider-native values but validates the default", () => {
  assert.deepEqual(effortValues("low，high, high, custom_7"), ["low", "high", "custom_7"]);
  assert.throws(() => serializeModels([row({ defaultReasoningEffort: "ultra" })]), /configured values/);
  assert.equal(serializeModels([row({ efforts: "custom_7, custom_9", defaultReasoningEffort: "custom_9" })])[0].defaultReasoningEffort, "custom_9");
});
test("old model configs preserve the first reasoning choice as their default", () => { assert.equal(row().defaultReasoningEffort, "low"); });
