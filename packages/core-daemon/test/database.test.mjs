import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Database, EventService, ProjectionService, MaintenanceService } from "../dist/index.js";

test("repositories persist independent domain aggregates", () => {
  const database = new Database(":memory:");
  const now = new Date().toISOString();
  const project = { id: "p1", name: "Example", rootPath: process.cwd(), repositoryType: "git", frontendPaths: [], backendPaths: [], ignoredPaths: [], policyId: "default" };
  database.projects.save(project, now);
  assert.equal(database.projects.get("p1")?.name, "Example");

  const session = { id: "s1", projectId: "p1", memberId: "a1", title: "Session", status: "idle", unreadCount: 0, createdAt: now, updatedAt: now };
  database.sessions.save(session);
  database.sessions.saveMessage({ id: "m1", sessionId: "s1", sender: "user", text: "hello", createdAt: now });
  assert.equal(database.sessions.messages("s1")[0]?.text, "hello");
  database.close();
});

test("event store replays in order and projection rebuilds state", () => {
  const database = new Database(":memory:");
  const events = new EventService(database);
  const now = new Date().toISOString();
  const session = { id: "s1", projectId: "p1", memberId: "a1", title: "Session", status: "idle", unreadCount: 0, createdAt: now, updatedAt: now };
  const run = { id: "r1", sessionId: "s1", agentInstanceId: "a1", mode: "headless_structured", status: "running", startedAt: now };
  events.append(session, run, "run.started", { runId: "r1" });
  events.append(session, run, "run.completed", { summary: "done" });
  assert.deepEqual(database.events.replay({ sessionId: "s1" }).map((event) => event.sequence), [1, 2]);
  assert.equal(new ProjectionService(database).rebuildSession("s1").sessionStatus, "completed");
  const maintenance = new MaintenanceService(database);
  assert.equal(maintenance.apply({ eventDays: 0, artifactDays: 0 }, Date.now() + 1_000).deletedEvents, 2);
  database.close();
});

test("schema 5 migrates execution defaults from AgentInstance to TeamMember and Session", () => {
  const directory = mkdtempSync(join(tmpdir(), "agenthub-schema-5-"));
  const filePath = join(directory, "agenthub.sqlite");
  try {
    const initialized = new Database(filePath);
    initialized.close();

    const raw = new DatabaseSync(filePath);
    const now = new Date().toISOString();
    const legacyAgent = {
      id: "agent-legacy",
      providerId: "codex",
      displayName: "Legacy Codex",
      executable: "codex",
      baseArgs: [],
      model: "legacy-model",
      reasoningEffort: "high",
      serviceTier: "priority",
      capabilities: [],
      enabled: true,
      status: "available",
      createdAt: now,
      updatedAt: now
    };
    const legacyTeam = {
      id: "team-legacy",
      name: "Legacy team",
      delegationPolicy: "autonomous",
      members: [{
        id: "member-legacy",
        displayName: "Child",
        agentInstanceId: "agent-legacy",
        roleId: "role-child",
        strengths: {},
        allowedTaskTypes: ["code"],
        maxConcurrentTasks: 1,
        enabled: true
      }],
      createdAt: now,
      updatedAt: now
    };
    const childSession = {
      id: "session-child",
      projectId: "project",
      teamId: "team-legacy",
      memberId: "member-legacy",
      agentInstanceId: "agent-legacy",
      title: "Child",
      status: "idle",
      unreadCount: 0,
      createdAt: now,
      updatedAt: now
    };
    const standaloneSession = {
      id: "session-standalone",
      projectId: "project",
      memberId: "agent-legacy",
      agentInstanceId: "agent-legacy",
      title: "Standalone",
      status: "idle",
      unreadCount: 0,
      createdAt: now,
      updatedAt: now
    };
    raw.prepare("UPDATE schema_meta SET value = '4' WHERE key = 'schema'").run();
    raw.prepare("INSERT INTO agents(id, data, updated_at) VALUES(?, ?, ?)").run(legacyAgent.id, JSON.stringify(legacyAgent), now);
    raw.prepare("INSERT INTO teams(id, data, updated_at) VALUES(?, ?, ?)").run(legacyTeam.id, JSON.stringify(legacyTeam), now);
    for (const session of [childSession, standaloneSession]) {
      raw.prepare("INSERT INTO sessions(id, project_id, member_id, data, updated_at) VALUES(?, ?, ?, ?, ?)")
        .run(session.id, session.projectId, session.memberId, JSON.stringify(session), now);
    }
    raw.close();

    const migrated = new Database(filePath);
    const agent = migrated.agents.get(legacyAgent.id);
    assert.equal(Object.hasOwn(agent, "model"), false);
    assert.equal(Object.hasOwn(agent, "reasoningEffort"), false);
    assert.equal(Object.hasOwn(agent, "serviceTier"), false);
    const member = migrated.teams.get(legacyTeam.id)?.members[0];
    assert.equal(member?.model, "legacy-model");
    assert.equal(member?.reasoningEffort, "high");
    assert.equal(member?.serviceTier, "priority");
    for (const sessionId of [childSession.id, standaloneSession.id]) {
      const session = migrated.sessions.get(sessionId);
      assert.equal(session?.model, "legacy-model");
      assert.equal(session?.reasoningEffort, "high");
      assert.equal(session?.serviceTier, "priority");
    }
    const version = migrated.connection.raw.prepare("SELECT value FROM schema_meta WHERE key = 'schema'").get();
    assert.equal(version.value, "5");
    migrated.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
