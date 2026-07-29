import test from "node:test";
import assert from "node:assert/strict";
import {
  Database,
  EventService,
  InteractionService,
  buildClaudePermissionPromptHandler,
  claudePermissionPromptToolArgs,
  extractInteractionPlan,
  normalizeKimiPermissionInteraction
} from "../dist/index.js";

const now = new Date().toISOString();

function seedSession(database, id = "session-1") {
  database.projects.save({ id: "project-1", name: "demo", rootPath: "C:/demo", repositoryType: "none", workspaceMode: "direct", createdAt: now, updatedAt: now }, now);
  const session = {
    id,
    projectId: "project-1",
    memberId: "member-1",
    title: "demo",
    status: "running",
    createdAt: now,
    updatedAt: now
  };
  database.sessions.save(session);
  return session;
}

function setup() {
  const database = new Database(":memory:");
  const events = new EventService(database);
  const interactions = new InteractionService(database, events);
  return { database, events, interactions };
}

test("interaction request blocks until respond and emits requested/resolved events", async () => {
  const { database, events, interactions } = setup();
  const session = seedSession(database);
  const seen = [];
  events.onAppend((event) => seen.push(event.type));

  const resolution = interactions.request(session, "run-1", "codex", {
    kind: "question",
    title: "请求用户输入",
    questions: [{ id: "q1", question: "选哪个？", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }]
  });

  const pending = interactions.list({ sessionId: session.id, status: "pending" });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].providerId, "codex");
  assert.deepEqual(seen, ["interaction.requested"]);

  const record = interactions.respond(pending[0].id, { outcome: "selected", answers: { q1: ["A"] } });
  assert.equal(record.status, "resolved");
  const response = await resolution;
  assert.deepEqual(response.answers, { q1: ["A"] });
  assert.deepEqual(seen, ["interaction.requested", "interaction.resolved"]);
  assert.equal(interactions.list({ status: "pending" }).length, 0);
});

test("respond on unknown or already-resolved interaction throws INTERACTION_NOT_FOUND", async () => {
  const { database, interactions } = setup();
  const session = seedSession(database);
  assert.throws(() => interactions.respond("nope", { outcome: "cancelled" }), (error) => error.descriptor?.code === "INTERACTION_NOT_FOUND");
  const resolution = interactions.request(session, "run-1", "kimi-code", { kind: "approval", title: "权限请求", options: [{ id: "allow", label: "allow" }] });
  const [pending] = interactions.list({ status: "pending" });
  interactions.respond(pending.id, { outcome: "selected", optionId: "allow" });
  await resolution;
  assert.throws(() => interactions.respond(pending.id, { outcome: "cancelled" }), (error) => error.descriptor?.code === "INTERACTION_NOT_FOUND");
});

test("cancelForRun auto-cancels pending interactions of a finished run only", async () => {
  const { database, interactions } = setup();
  const session = seedSession(database);
  const first = interactions.request(session, "run-1", "codex", { kind: "approval", title: "t", options: [] });
  const second = interactions.request(session, "run-2", "codex", { kind: "approval", title: "t", options: [] });

  interactions.cancelForRun("run-1");
  assert.deepEqual(await first, { outcome: "cancelled" });
  const cancelled = interactions.list({ status: "cancelled" });
  assert.equal(cancelled.length, 1);
  assert.equal(cancelled[0].runId, "run-1");
  assert.equal(interactions.list({ status: "pending" }).length, 1);

  interactions.cancelForRun("run-2");
  await second;
  database.close();
});

test("claude permission prompt handler answers AskUserQuestion via updatedInput.answers", async () => {
  let captured;
  const handler = buildClaudePermissionPromptHandler(async (input) => {
    captured = input;
    return { outcome: "selected", answers: { "大了还是小了？": ["大了"] } };
  });
  const result = await handler({
    toolName: "AskUserQuestion",
    input: {
      questions: [{
        question: "大了还是小了？",
        header: "猜数",
        multiSelect: false,
        options: [{ label: "大了", description: "x" }, { label: "小了", description: "y" }]
      }]
    }
  });
  assert.equal(captured.kind, "question");
  assert.equal(captured.questions[0].options.length, 2);
  assert.equal(result.behavior, "allow");
  assert.deepEqual(result.updatedInput.answers, { "大了还是小了？": "大了" });
});

test("claude permission prompt handler maps approvals and cancellations to allow/deny", async () => {
  const allow = buildClaudePermissionPromptHandler(async () => ({ outcome: "selected", optionId: "allow" }));
  assert.deepEqual(await allow({ toolName: "Bash", input: { command: "ls" } }), { behavior: "allow", updatedInput: { command: "ls" } });

  const deny = buildClaudePermissionPromptHandler(async () => ({ outcome: "selected", optionId: "deny" }));
  assert.equal((await deny({ toolName: "Bash", input: {} })).behavior, "deny");

  const cancelled = buildClaudePermissionPromptHandler(async () => ({ outcome: "cancelled" }));
  const questionResult = await cancelled({ toolName: "AskUserQuestion", input: { questions: [] } });
  assert.equal(questionResult.behavior, "deny");
});

test("plan approval extracts provider content blocks instead of exposing raw JSON", () => {
  const plan = extractInteractionPlan([
    {
      type: "content",
      content: {
        type: "text",
        text: "Plan saved to: C:/tmp/feature.md\n\n# Feature plan\n\n1. Add the protocol\n2. Render the card\n\nRequesting approval to Presenting plan and exiting plan mode"
      }
    }
  ]);
  assert.equal(plan.sourcePath, "C:/tmp/feature.md");
  assert.equal(plan.content, "# Feature plan\n\n1. Add the protocol\n2. Render the card");
});

test("claude ExitPlanMode becomes a provider-neutral plan approval", async () => {
  let captured;
  const approve = buildClaudePermissionPromptHandler(async (input) => {
    captured = input;
    return { outcome: "selected", optionId: "allow" };
  });
  const result = await approve({ toolName: "ExitPlanMode", input: { plan: "# Ship it\n\n- test" } });
  assert.equal(captured.kind, "plan_approval");
  assert.equal(captured.plan.content, "# Ship it\n\n- test");
  assert.deepEqual(captured.options.map((option) => option.intent), ["approve", "revise"]);
  assert.equal(result.behavior, "allow");
});

test("Kimi ExitPlanMode content is normalized into the dedicated plan contract", () => {
  const interaction = normalizeKimiPermissionInteraction({
    title: "ExitPlanMode",
    content: [{
      type: "content",
      content: {
        type: "text",
        text: "Plan saved to: C:/tmp/kimi-plan.md\n\n# Kimi plan\n\n- Implement the card\n\nRequesting approval to Presenting plan and exiting plan mode"
      }
    }]
  }, [
    { optionId: "allow_once", name: "Allow", kind: "allow_once" },
    { optionId: "reject_once", name: "Reject", kind: "reject_once" }
  ]);
  assert.equal(interaction.kind, "plan_approval");
  assert.equal(interaction.detail, undefined);
  assert.equal(interaction.plan.content, "# Kimi plan\n\n- Implement the card");
  assert.deepEqual(interaction.options.map((option) => option.intent), ["approve", "reject"]);
});

test("claude permission prompt tool flag requires bridge and interaction handler", () => {
  const withBridge = { url: "http://127.0.0.1:1/mcp/x", close: async () => {} };
  const request = { requestInteraction: async () => ({ outcome: "cancelled" }) };
  assert.deepEqual(claudePermissionPromptToolArgs(request, withBridge), ["--permission-prompt-tool", "mcp__agenthub__permission_prompt"]);
  assert.deepEqual(claudePermissionPromptToolArgs(request, undefined), []);
  assert.deepEqual(claudePermissionPromptToolArgs({}, withBridge), []);
});
