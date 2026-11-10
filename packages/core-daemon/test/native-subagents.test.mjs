import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { startCodexAppServer } from "../dist/adapters/codex/app-server-run.js";
import { closeCodexAppServerPool } from "../dist/adapters/codex/app-server-pool.js";
import { subagentMeta } from "../dist/runtime/subagent-detection.js";
import { OrchestrationPromptBuilder } from "../dist/runtime/orchestration/prompt-builder.js";
import { Database } from "../dist/database/index.js";
import { TeamService } from "../dist/application/team-service.js";

test("native children expose history, live output and actual completion without overwriting the parent", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nautilo-native-child-"));
  const id = randomUUID();
  await writeFile(join(root, "app-server"), await readFile(new URL("./fixtures/fake-codex-queue.cjs", import.meta.url)));
  t.after(async () => { await closeCodexAppServerPool(id); await rm(root, { recursive: true, force: true }); });
  const log = join(root, "calls.ndjson");
  const run = startCodexAppServer({ instance: { id, providerId: "codex", executable: process.execPath, models: [], capabilities: [], providerOptions: {} }, prompt: "native-child", cwd: root, env: { PATH: process.env.PATH, CODEX_HOME: root, CODEX_FAKE_LOG: log }, localSessionId: id, timeoutMs: 5000 });
  const events = [];
  for await (const event of run.events) events.push(event);
  assert.ok(events.some((event) => event.kind === "message" && event.subagentDispatchId === "spawn-native" && event.text === "Child snapshot before join"));
  assert.ok(events.some((event) => event.kind === "message" && event.subagentDispatchId === "spawn-native" && event.text === "Real native child result"));
  const dispatches = events.filter((event) => event.kind === "tool" && event.callId === "spawn-native");
  assert.equal(subagentMeta("spawnAgent", dispatches[0].input).status, "running", "spawn finished does not mean child finished");
  const final = subagentMeta("spawnAgent", dispatches.at(-1).input);
  assert.equal(final.status, "done");
  assert.deepEqual(final.nativeAgentIds, ["native-child-thread"]);
  assert.equal(final.model, "native-test-model");
  assert.ok(!events.some((event) => event.kind === "usage" && event.inputTokens === 999999));
  assert.ok(events.some((event) => event.kind === "message" && !event.subagentDispatchId && event.text === "done:native-child"));
  assert.equal(events.at(-1).exitCode, 0);
  assert.doesNotMatch(await readFile(log, "utf8"), /thread\/subscribe/);
});

test("team prompts honor direct-only policy and distinguish configured members from native children", () => {
  const builder = new OrchestrationPromptBuilder();
  const team = { id: "team", members: [{ id: "member", enabled: true }], roles: [], delegationPolicy: "direct_only" };
  const disabled = builder.mainTurn("Use my member", team);
  assert.match(disabled, /delegation is disabled/);
  assert.doesNotMatch(disabled, /Use agenthub_delegate or agenthub_plan/);
  const enabled = builder.mainTurn("Use my member", { ...team, delegationPolicy: "autonomous" });
  assert.match(enabled, /Honor an explicit user request/);
  assert.match(enabled, /Only report a configured dispatch after a successful Nautilo tool receipt/);
});

test("changing the team allowlist refreshes native tools while keeping conversation context", () => {
  const db = new Database(":memory:");
  try {
    const now = new Date().toISOString();
    db.agents.save({ id: "codex", providerId: "codex", updatedAt: now }, now);
    const teams = new TeamService(db);
    const team = { id: "team", roles: [], members: [{ id: "explorer", enabled: true }], delegationPolicy: "direct_only", createdAt: now, updatedAt: now };
    teams.upsert(team);
    db.sessions.save({ id: "main", projectId: "p", memberId: "codex", agentInstanceId: "codex", teamId: "team", status: "idle", unreadCount: 0, providerSessionId: "old-native-thread", providerContextSyncedAt: now, runtimeToolVersion: 3, model: "my-model", createdAt: now, updatedAt: now });
    db.sessions.saveMessage({ id: "earlier", sessionId: "main", sender: "user", text: "Keep this context", createdAt: now });
    teams.upsert({ ...team, delegationPolicy: "autonomous" });
    const session = db.sessions.get("main");
    assert.equal(session.runtimeToolVersion, 0);
    assert.equal(session.providerSessionId, "old-native-thread");
    assert.equal(session.model, "my-model");
    assert.equal(db.sessions.messages("main")[0].text, "Keep this context");
    db.sessions.save({ ...session, runtimeToolVersion: 3 });
    teams.upsert({ ...team, delegationPolicy: "autonomous" });
    assert.equal(db.sessions.get("main").runtimeToolVersion, 3, "ordinary repeated saves must not restart the provider thread");
  } finally { db.close(); }
});
