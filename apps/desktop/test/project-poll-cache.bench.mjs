// Renderer-only deterministic IPC benchmark; not provider/model TTFT.
// node apps/desktop/test/project-poll-cache.bench.mjs [baseline-runtime.ts]
import { readFileSync } from "node:fs";
import { createHarness } from "./helpers/orchestration-runtime-harness.mjs";
import { projectFixture, settle } from "./helpers/project-poll-harness.mjs";
const source = process.argv[2] ? readFileSync(process.argv[2], "utf8") : undefined;
for (const projects of [20, 100]) {
  const h = createHarness({ source });
  h.projectState.projects = Array.from({ length: projects }, (_, i) => ({ id: `p${i}` }));
  Object.assign(h.replies, { "session.list": [], "projectRun.list": [], "run.list": [] });
  const start = h.now();
  await settle(h, () => h.runtime.hydrateWorkbenchSessions());
  console.log(JSON.stringify({ kind: "startup", projects, ipcDelayMs: 40, durationMs: h.now() - start, requests: h.calls.length }));
}
const h = projectFixture(21, source);
for (const session of h.sessions) h.messages.set(session.id, Array.from({ length: 1000 }, (_, i) => ({ id: `m${i}`, sessionId: session.id, sender: "user", text: "history ".repeat(20), createdAt: session.createdAt })));
h.runtime.registerProjectSessionView("s", "pr");
await h.hydrate();
const start = h.now(), callCount = h.calls.length;
await h.hydrate();
const calls = h.calls.slice(callCount);
const histories = calls.filter((c) => c.method === "session.get");
const bytes = histories.reduce((total, call) => total + JSON.stringify(h.replies["session.get"](call.params)).length, 0);
console.log(JSON.stringify({ kind: "idle_project_poll", sessions: 21, active: 1, completed: 20, messagesPerSession: 1000, durationMs: h.now() - start, requests: calls.length, historyReads: histories.length, historyPayloadKiB: +(bytes / 1024).toFixed(1) }));
