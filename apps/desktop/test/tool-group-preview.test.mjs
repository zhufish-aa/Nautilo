import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const sourceUrl = new URL("../src/renderer/src/lib/tool-group-preview.ts", import.meta.url);

async function loadPreviewHelpers() {
  const source = await readFile(sourceUrl, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022
    }
  }).outputText;
  return import(`data:text/javascript;charset=utf-8,${encodeURIComponent(transpiled)}`);
}

function event(id, data) {
  return {
    id,
    sessionId: "session-1",
    sequence: Number(id.replace(/\D/g, "")) || 0,
    timestamp: "2026-07-24T00:00:00.000Z",
    data
  };
}

test("reasoning summary follows the latest non-empty streamed line", async () => {
  const { latestReasoningSummary } = await loadPreviewHelpers();

  assert.equal(latestReasoningSummary("First thought\nSecond thought partial"), "Second thought partial");
  assert.equal(latestReasoningSummary("First thought\nSecond thought completed"), "Second thought completed");
});

test("the timeline source keeps later tool activity after a reasoning event", () => {
  const items = [
    event("event-1", { kind: "reasoning", text: "Latest reasoning", streaming: true }),
    event("event-2", { kind: "tool_activity", toolName: "Write", status: "running" })
  ];

  assert.equal(items.at(-1).data.kind, "tool_activity");
});
