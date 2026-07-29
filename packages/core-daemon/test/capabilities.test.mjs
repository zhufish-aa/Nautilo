import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database, CapabilityService, SkillFileSync, capabilityToMcpServer } from "../dist/index.js";

const now = new Date().toISOString();

function mcpCapability(overrides = {}) {
  return {
    id: "cap-mcp-1",
    kind: "mcp",
    name: "GitHub",
    description: "Repository context",
    tags: ["repo"],
    enabled: true,
    providerIds: ["codex", "kimi-code"],
    mcp: { transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] },
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

function skillCapability(overrides = {}) {
  return {
    id: "cap-skill-1",
    kind: "skill",
    name: "Code Review",
    description: "Review changed files",
    tags: ["review"],
    enabled: true,
    providerIds: ["claude-code"],
    skill: { instructions: "Review the diff and summarize findings." },
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

function fakeSkillSync(calls) {
  return {
    sync: (capability) => calls.push(["sync", capability.id]),
    removeAll: (capability) => calls.push(["removeAll", capability.id])
  };
}

test("capability service persists skills and MCP servers with per-provider enablement", () => {
  const database = new Database(":memory:");
  const calls = [];
  const service = new CapabilityService(database, fakeSkillSync(calls));

  service.upsert(mcpCapability());
  service.upsert(skillCapability());

  const listed = service.list();
  assert.equal(listed.length, 2);
  const mcp = listed.find((capability) => capability.id === "cap-mcp-1");
  assert.deepEqual(mcp.providerIds, ["codex", "kimi-code"]);
  assert.equal(mcp.mcp.command, "npx");
  assert.ok(mcp.updatedAt >= now);

  // Updating keeps the original createdAt and re-syncs skill files.
  const updated = service.upsert({ ...mcpCapability(), providerIds: ["custom"] });
  assert.equal(updated.createdAt, now);
  assert.deepEqual(updated.providerIds, ["custom"]);

  assert.deepEqual(calls, [
    ["sync", "cap-mcp-1"],
    ["sync", "cap-skill-1"],
    ["sync", "cap-mcp-1"]
  ]);

  service.remove("cap-mcp-1");
  assert.deepEqual(service.list().map((capability) => capability.id), ["cap-skill-1"]);
  assert.deepEqual(calls.at(-1), ["removeAll", "cap-mcp-1"]);
  database.close();
});

test("capability upsert validates required fields", () => {
  const database = new Database(":memory:");
  const service = new CapabilityService(database, fakeSkillSync([]));

  const invalid = (field) => (error) => error.descriptor?.code === "IPC_INVALID_REQUEST" && String(error.descriptor?.details?.field ?? "").includes(field);
  assert.throws(() => service.upsert(mcpCapability({ name: "  " })), invalid("name"));
  assert.throws(() => service.upsert(mcpCapability({ mcp: { transport: "stdio" } })), invalid("command"));
  assert.throws(() => service.upsert(mcpCapability({ mcp: { transport: "http" } })), invalid("url"));
  assert.throws(() => service.upsert(mcpCapability({ mcp: undefined })), invalid("mcp"));
  assert.throws(() => service.upsert(skillCapability({ skill: { instructions: " " } })), invalid("instructions"));

  // Valid HTTP transport round-trips.
  const http = service.upsert(mcpCapability({ id: "cap-mcp-http", mcp: { transport: "http", url: "http://127.0.0.1:9000/mcp" } }));
  assert.equal(http.mcp.transport, "http");
  database.close();
});

test("capability upsert deduplicates provider ids and trims tags", () => {
  const database = new Database(":memory:");
  const service = new CapabilityService(database, fakeSkillSync([]));
  const saved = service.upsert(mcpCapability({ providerIds: ["codex", "codex", "kimi-code"], tags: [" repo ", "", "quality"] }));
  assert.deepEqual(saved.providerIds, ["codex", "kimi-code"]);
  assert.deepEqual(saved.tags, ["repo", "quality"]);
  database.close();
});

test("capabilityToMcpServer expands env passthrough, bearer token and env-sourced headers", () => {
  const environ = {
    GITHUB_TOKEN: "secret-token",
    TENANT_ID: "tenant-42",
    PASSTHROUGH_VALUE: "passed"
  };
  const http = capabilityToMcpServer(mcpCapability({
    name: "My HTTP Server!",
    mcp: {
      transport: "http",
      url: "https://mcp.example.com/mcp",
      headers: { "X-Static": "yes" },
      bearerTokenEnvVar: "GITHUB_TOKEN",
      envHeaders: { "X-Tenant": "TENANT_ID", "X-Missing": "NO_SUCH_VAR" }
    }
  }), environ);
  assert.equal(http.name, "My-HTTP-Server");
  assert.deepEqual(http.headers, {
    "X-Static": "yes",
    Authorization: "Bearer secret-token",
    "X-Tenant": "tenant-42"
  });
  assert.equal(http.env, undefined);

  const stdio = capabilityToMcpServer(mcpCapability({
    mcp: { transport: "stdio", command: "npx", env: { FIXED: "1" }, envPassthrough: ["PASSTHROUGH_VALUE", "NO_SUCH_VAR"] }
  }), environ);
  assert.deepEqual(stdio.env, { FIXED: "1", PASSTHROUGH_VALUE: "passed" });

  // Skills never resolve to an MCP server.
  assert.equal(capabilityToMcpServer(skillCapability(), environ), undefined);
});

test("skill file sync mirrors resource folders into directory-based providers only", () => {
  const home = mkdtempSync(join(tmpdir(), "agenthub-home-"));
  const source = mkdtempSync(join(tmpdir(), "agenthub-skill-src-"));
  const envKeys = ["HOME", "USERPROFILE", "KIMI_CODE_HOME"];
  const savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  // skillTargets() reads homedir() and KIMI_CODE_HOME on every sync.
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.KIMI_CODE_HOME = join(home, ".kimi-code");
  try {
    writeFileSync(join(source, "SKILL.md"), "---\nname: Code Review\n---\n\nOriginal body.\n", "utf8");
    mkdirSync(join(source, "references"), { recursive: true });
    writeFileSync(join(source, "references", "guide.md"), "reference doc", "utf8");
    mkdirSync(join(source, "scripts", "nested"), { recursive: true });
    writeFileSync(join(source, "scripts", "nested", "run.sh"), "echo hi", "utf8");

    const sync = new SkillFileSync();
    const capability = skillCapability({
      providerIds: ["claude-code", "kimi-code", "codex"],
      skill: { instructions: "Review the diff.", resourceDir: source }
    });
    sync.sync(capability);

    const claudeDir = join(home, ".claude", "skills", "code-review");
    const kimiDir = join(home, ".kimi-code", "skills", "code-review");
    for (const dir of [claudeDir, kimiDir]) {
      // The target keeps its own rendered SKILL.md, not the source file.
      const rendered = readFileSync(join(dir, "SKILL.md"), "utf8");
      assert.ok(rendered.includes("Review the diff."), dir);
      assert.ok(rendered.includes("agenthub:capability:cap-skill-1"), dir);
      assert.equal(readFileSync(join(dir, "references", "guide.md"), "utf8"), "reference doc", dir);
      assert.equal(readFileSync(join(dir, "scripts", "nested", "run.sh"), "utf8"), "echo hi", dir);
    }
    // Codex prompts are flat files — no resource spill next to them.
    assert.ok(existsSync(join(home, ".codex", "prompts", "code-review.md")));
    assert.ok(!existsSync(join(home, ".codex", "prompts", "references")));

    // Re-importing from an installed directory is a self-copy and stays a no-op.
    sync.sync(skillCapability({ skill: { instructions: "Review the diff.", resourceDir: claudeDir } }));
    assert.ok(existsSync(join(claudeDir, "SKILL.md")));
    assert.ok(!existsSync(join(claudeDir, "references", "references")));

    // Removal deletes only the managed SKILL.md; resources are left in place
    // because they may be the user's originals.
    sync.removeAll(capability);
    assert.ok(!existsSync(join(claudeDir, "SKILL.md")));
    assert.ok(existsSync(join(claudeDir, "references", "guide.md")));
  } finally {
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    rmSync(home, { recursive: true, force: true });
    rmSync(source, { recursive: true, force: true });
  }
});
