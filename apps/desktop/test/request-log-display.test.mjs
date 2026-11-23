import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("vite/package.json"))("esbuild");
const bundle = await build({
  entryPoints: [fileURLToPath(new URL("../src/renderer/src/features/settings/request-log-display.ts", import.meta.url))],
  bundle: true, format: "esm", write: false, platform: "node",
});
const { duration, ms, requestTelemetry, requestTrace, tracePosition, traceReport } = await import(
  "data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].text).toString("base64")
);

test("telemetry counts only recorded timings and explicit reuse states", () => {
  const overview = requestTelemetry([
    { status: "completed", milestones: { firstText: 0, ended: 4000 }, runtime: { reused: true } },
    { status: "failed", milestones: { firstText: null, ended: 8000 }, runtime: { reused: false } },
    { status: "running", milestones: { firstText: 10000 } },
    { status: "interrupted", milestones: {} },
  ]);
  assert.deepEqual(overview, {
    completed: 1, abnormal: 2, reused: 1, fresh: 1,
    p50: 5000, p95: 9500, firstCount: 2, maxFirst: 10000, mean: 6000, longest: 8000,
  });
  assert.equal(requestTelemetry([{ status: "queued", milestones: {} }]).p50, undefined);
  assert.equal(duration(1_553_560), "25m 53s");
  assert.equal(ms(null), "—");
});

test("trace orders recorded times and leaves unobserved milestones blank", () => {
  const trace = requestTrace({ milestones: {
    queued: 0, preparing: 10, dispatched: 40, runtimeReady: 160,
    firstText: 5100, firstEvent: 180, firstThinking: 5400, ended: 45_100,
  } });
  const observed = trace.nodes.filter(node => node.at !== undefined);
  assert.deepEqual(observed.map(node => node.key), ["queued", "preparing", "dispatched", "runtimeReady", "firstEvent", "firstText", "firstThinking", "ended"]);
  assert.deepEqual(observed.map(node => node.delta), [0, 10, 30, 120, 20, 4920, 300, 39700]);
  assert.deepEqual(trace.phases.map(phase => phase.value), [160, 4940, 40000]);
  assert.equal(trace.nodes.find(node => node.key === "prepared").delta, undefined);
  assert.equal(trace.bottleneck.key, "output");
  assert.equal(trace.longestNode.key, "ended");
  assert.equal(tracePosition(45100, 45100, true), 100);
  assert.ok(tracePosition(160, 45100, true) > tracePosition(160, 45100, false));
});

test("sparse historical logs skip phase shares and report only known details", () => {
  const row = {
    id: "request-1", sessionId: "session-1", providerId: "codex", runId: "run-1", status: "failed",
    createdAt: "2026-11-23T00:00:00Z", milestones: { queued: 0, firstEvent: 150, ended: 500 },
    failure: { stage: "runtime", code: "PROCESS_ERROR", message: "Failed to start\nProcess exited" },
    observedTools: ["read_file"], suppliedTools: [], suppliedServers: [],
  };
  const trace = requestTrace(row);
  assert.equal(trace.partitioned, false);
  assert.equal(trace.bottleneck, undefined);
  assert.deepEqual(trace.phases.map(phase => phase.value), [undefined, undefined, undefined]);
  const report = traceReport(row, "Test request", false);
  assert.match(report, /Request ID: request-1/);
  assert.match(report, /\| First text \| — \| — \|/);
  assert.match(report, /\n\n- Observed tools: read_file/);
  assert.match(report, /PROCESS_ERROR\n\nFailed to start\nProcess exited/);
  assert.doesNotMatch(report, /PID|Bottleneck|Tokens|Cost/);
});
