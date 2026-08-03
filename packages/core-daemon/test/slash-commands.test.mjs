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
  assert.ok(codex.some((command) => command.id === "codex.native.compact" && command.execution === "provider" && command.availability === "idle"));
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

test("plugin providers get a generic catalog from their reported native commands", () => {
  // No built-in catalog: nothing shows until the plugin reports commands.
  assert.deepEqual(slashCommandCatalog("opencode"), []);
  const opencode = slashCommandCatalog("opencode", [
    { name: "compact", description: "压缩当前会话上下文（OpenCode summarize）", providerCommand: "compact" }
  ]);
  const compact = opencode.find((command) => command.name === "/compact");
  assert.equal(compact.id, "opencode.native.compact");
  assert.equal(compact.execution, "provider");
  assert.equal(compact.availability, "idle");
  assert.equal(compact.providerCommand, "compact");
});

test("plugin-reported compact requires a provider session and uses the compact transport", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agenthub-opencode-command-"));
  const database = new Database(join(directory, "test.sqlite"));
  try {
    const adapter = {
      providerId: "opencode",
      supportsStructuredOutput: true,
      supportsResume: true,
      capabilities: { structuredOutput: true, textOutput: true, interactiveStdin: false, nativeResume: true, pty: false },
      detect: async () => ({ installed: true, executable: "opencode" }),
      listModels: async () => ({ providerId: "opencode", source: "provider_cli", fetchedAt: now, models: [] }),
      start: () => { throw new Error("not used"); }
    };
    const registry = new AdapterRegistry([adapter]);
    const agent = { id: "opencode-1", providerId: "opencode", displayName: "OpenCode", executable: "opencode", baseArgs: [], capabilities: [], enabled: true, status: "available", createdAt: now, updatedAt: now };
    const session = { id: "session-opencode", projectId: "project-1", memberId: agent.id, agentInstanceId: agent.id, title: "Chat", status: "idle", unreadCount: 0, createdAt: now, updatedAt: now };
    database.agents.save(agent, now);
    database.sessions.save(session);
    // The plugin reports its native commands during a run; the daemon replays
    // the latest report when listing slash commands.
    database.events.append({
      schemaVersion: 1,
      eventId: "evt-commands-1",
      sequence: 1,
      projectId: "project-1",
      sessionId: session.id,
      type: "provider.commands_updated",
      timestamp: now,
      payload: { providerId: "opencode", commands: [{ name: "compact", description: "Compact context", providerCommand: "compact" }] }
    });
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

    assert.ok(service.list(session.id).some((command) => command.id === "opencode.native.compact"));

    // Without a provider session there is nothing to summarize.
    const rejected = await service.execute(session.id, "opencode.native.compact").catch((error) => error);
    assert.equal(rejected.descriptor?.details?.reason, "compact_requires_provider_session");
    assert.equal(invocations.length, 0);

    database.sessions.save({ ...session, providerSessionId: "ses_1" });
    const result = await service.execute(session.id, "opencode.native.compact");
    assert.deepEqual(invocations, [{ prompt: "/compact", context: { presentation: "provider_command", providerCommand: "compact" } }]);
    assert.equal(result.sections[0].text, "Context compacted");
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Claude Code exposes a provider-scoped catalog with dynamic native commands", () => {
  const claude = slashCommandCatalog("claude-code");
  assert.ok(claude.some((command) => command.name === "/model"));
  assert.ok(claude.some((command) => command.name === "/effort"));
  assert.ok(claude.some((command) => command.name === "/title"));
  assert.ok(claude.some((command) => command.name === "/usage"));
  assert.ok(!claude.some((command) => command.name === "/compact"));

  const withNative = slashCommandCatalog("claude-code", [
    { name: "compact", description: "Compact conversation context" },
    { name: "review", description: "Review a pull request", inputHint: "PR number" },
    { name: "login", description: "Interactive only" },
    { name: "clear", description: "Destructive, excluded" }
  ]);
  const compact = withNative.find((command) => command.name === "/compact");
  assert.equal(compact.execution, "provider");
  assert.equal(compact.availability, "idle");
  const review = withNative.find((command) => command.name === "/review");
  assert.equal(review.argumentHint, "PR number");
  assert.ok(!withNative.some((command) => command.name === "/login"));
  assert.ok(!withNative.some((command) => command.name === "/clear"));
  // Nautilo-local /status stays authoritative over a provider /status.
  assert.equal(withNative.filter((command) => command.name === "/status").length, 1);
});
