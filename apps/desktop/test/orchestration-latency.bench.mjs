// Synthetic renderer-only timings, not end-to-end model latency.
// node apps/desktop/test/orchestration-latency.bench.mjs [baseline-runtime.ts]
import { readFileSync } from "node:fs";
import { createHarness, delta } from "./helpers/orchestration-runtime-harness.mjs";

const source = process.argv[2] ? readFileSync(process.argv[2], "utf8") : undefined;
const h = createHarness({ source });
const start = h.now();
const sent = h.runtime.sendWorkbenchMessage("s", "Hello");
await h.advance(1000); await sent;
const team = createHarness({ source, agentCount: 4 });
team.session.target.teamId = "t";
const teamStart = team.now();
let syncMs;
const synced = team.runtime.syncProjectAndAgents(team.session).then(() => { syncMs = team.now() - teamStart; });
await team.advance(1000); await synced;
const first = createHarness({ source });
first.runtime.standaloneHydrated.add("s");
first.runtime.standaloneLastRebuildAt.set("s", first.now());
first.runtime.scheduleStandaloneRender("s");
await first.advance(1);
const received = first.now();
first.runtime.mergeStandaloneEvents("s", [delta(1)]);
await first.advance(200);
const project = createHarness({ source });
const readyAt = project.now() + 6751;
let observedAt;
project.runtime.projectRunAwaitingOutput?.set("pr", true);
project.runtime.setTestProjectHydrator(async () => {
  if (project.now() >= readyAt && observedAt === undefined) observedAt = project.now();
  return { id: "pr", status: observedAt === undefined ? "running" : "completed", mainSessionId: "s" };
});
project.runtime.schedulePoll("pr");
await project.advance(10000);
console.log(JSON.stringify({
  ipcDelayMs: 40,
  sendDispatchMs: h.calls.find((call) => call.method === "session.send").at - start,
  eventWaitStartMs: h.calls.find((call) => call.method === "event.wait").at - start,
  fourAgentSyncMs: syncMs,
  firstTokenStoreDelayMs: first.renders[0].at - received,
  projectObservationDelayMs: observedAt - readyAt
}, null, 2));
