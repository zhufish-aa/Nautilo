import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AdapterRegistry,
  AgentService,
  AuditService,
  Database,
  RedactionService,
  SlashCommandService,
  slashCommandCatalog
} from "../dist/index.js";

const now = new Date().toISOString();

test("Codex and Kimi expose different provider-scoped slash command catalogs", () => {
  const codex = slashCommandCatalog("codex");
  const kimi = slashCommandCatalog("kimi-code");
  assert.ok(codex.some((command) => command.name === "/fast"));
  assert.ok(codex.some((command) => command.name === "/reasoning"));
  assert.ok(!kimi.some((command) => command.name === "/fast"));
  assert.ok(kimi.some((command) => command.name === "/thinking"));
  assert.ok(kimi.some((command) => command.name === "/title"));
  assert.ok(kimi.some((command) => command.name === "/compact" && command.execution === "provider"));
  assert.ok(kimi.some((command) => command.name === "/help" && command.execution === "provider"));
  assert.ok(!kimi.some((command) => command.name === "/mcp-config"));
});

test("Kimi provider command updates are restricted to commands executable by ACP", () => {
  const commands = slashCommandCatalog("kimi-code", [
    { name: "help", description: "Provider help" },
    { name: "mcp-config", description: "TUI-only built-in skill" },
    { name: "workspace-audit", description: "Installed skill", inputHint: "scope" }
  ]);
  assert.equal(commands.filter((command) => command.name === "/help").length, 1);
  assert.ok(!commands.some((command) => command.name === "/mcp-config"));
  assert.ok(!commands.some((command) => command.name === "/workspace-audit"));
});

test("model command returns choices and applies the selected value to the session", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agenthub-slash-"));
  const database = new Database(join(directory, "test.sqlite"));
  try {
    const adapter = {
      providerId: "codex",
      supportsStructuredOutput: true,
      supportsResume: true,
      capabilities: { structuredOutput: true, textOutput: true, interactiveStdin: false, nativeResume: true, pty: false },
      detect: async () => ({ installed: true, executable: "codex" }),
      listModels: async () => ({
        providerId: "codex",
        source: "provider_cli",
        fetchedAt: now,
        defaultModel: "model-a",
        models: [
          { id: "model-a", displayName: "Model A", isDefault: true, capabilities: [], reasoningEfforts: ["low", "high"], defaultReasoningEffort: "low", serviceTiers: [] },
          { id: "model-b", displayName: "Model B", isDefault: false, capabilities: [], reasoningEfforts: ["medium", "max"], defaultReasoningEffort: "medium", serviceTiers: [] }
        ]
      }),
      start: () => { throw new Error("not used"); }
    };
    const registry = new AdapterRegistry([adapter]);
    const agent = { id: "agent-1", providerId: "codex", displayName: "Codex", executable: "codex", baseArgs: [], capabilities: [], enabled: true, status: "available", createdAt: now, updatedAt: now };
    const session = { id: "session-1", projectId: "project-1", memberId: agent.id, agentInstanceId: agent.id, title: "Chat", status: "idle", unreadCount: 0, createdAt: now, updatedAt: now };
    database.agents.save(agent, now);
    database.sessions.save(session);
    const redaction = new RedactionService(() => []);
    const service = new SlashCommandService(database, new AgentService(database, registry), new AuditService(database, redaction));

    const picker = await service.execute(session.id, "codex.model");
    assert.deepEqual(picker.selection.options.map((option) => option.id), ["model-a", "model-b"]);
    const applied = await service.continue({ sessionId: session.id, commandId: "codex.model", actionId: "apply", selectedOptionIds: ["model-b"] });
    assert.equal(applied.sessionPatch.model, "model-b");
    assert.equal(applied.sessionPatch.reasoningEffort, "medium");
    assert.equal(database.sessions.get(session.id).model, "model-b");
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Kimi provider commands use the command runtime and do not create chat messages", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agenthub-kimi-command-"));
  const database = new Database(join(directory, "test.sqlite"));
  try {
    const adapter = {
      providerId: "kimi-code",
      supportsStructuredOutput: true,
      supportsResume: true,
      capabilities: { structuredOutput: true, textOutput: true, interactiveStdin: false, nativeResume: true, pty: false },
      detect: async () => ({ installed: true, executable: "kimi" }),
      listModels: async () => ({ providerId: "kimi-code", source: "provider_cli", fetchedAt: now, models: [] }),
      start: () => { throw new Error("not used"); }
    };
    const registry = new AdapterRegistry([adapter]);
    const agent = { id: "kimi-1", providerId: "kimi-code", displayName: "Kimi", executable: "kimi", baseArgs: [], capabilities: [], enabled: true, status: "available", createdAt: now, updatedAt: now };
    const session = { id: "session-kimi", projectId: "project-1", memberId: agent.id, agentInstanceId: agent.id, title: "Chat", status: "idle", unreadCount: 0, createdAt: now, updatedAt: now };
    database.agents.save(agent, now);
    database.sessions.save(session);
    const invocations = [];
    const runs = {
      launch: async (_session, _agent, prompt, context) => {
        invocations.push({ prompt, context });
        return {
          runId: "command-run-1",
          completion: Promise.resolve({
            run: { id: "command-run-1", sessionId: session.id, agentInstanceId: agent.id, mode: "headless_structured", status: "completed" },
            messages: [],
            finalMessage: "Context compacted"
          })
        };
      }
    };
    const redaction = new RedactionService(() => []);
    const service = new SlashCommandService(database, new AgentService(database, registry), new AuditService(database, redaction), runs);

    const result = await service.execute(session.id, "kimi-code.native.compact");
    assert.deepEqual(invocations, [{ prompt: "/compact", context: { presentation: "provider_command" } }]);
    assert.equal(database.sessions.messages(session.id).length, 0);
    assert.equal(result.sections[0].text, "Context compacted");
    assert.match(result.description, /未作为普通聊天消息发送/);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
