import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CapabilityImportService,
  CapabilityService,
  Database,
  parseMcpCommandLine,
  parseMcpConfigJson,
  parseMcpConfigToml,
  parseSkillMarkdown
} from "../dist/index.js";

const noopSkillSync = { sync: () => {}, removeAll: () => {} };

function service() {
  const database = new Database(":memory:");
  const capabilities = new CapabilityService(database, noopSkillSync);
  return { database, capabilities, imports: new CapabilityImportService(capabilities) };
}

function byName(servers, name) {
  return servers.find((server) => server.name === name);
}

test("mcp json parser unwraps the common config shapes", () => {
  const wrappers = [
    '{"mcpServers":{"a":{"command":"npx"}}}',
    '{"servers":{"a":{"command":"npx"}}}',
    '{"mcp":{"servers":{"a":{"command":"npx"}}}}',
    '{"mcp":{"mcpServers":{"a":{"command":"npx"}}}}',
    '{"a":{"command":"npx"}}',
    '{"name":"a","command":"npx"}'
  ];
  for (const text of wrappers) {
    const { servers, errors } = parseMcpConfigJson(text);
    assert.deepEqual(errors, [], text);
    assert.equal(servers.length, 1, text);
    assert.equal(servers[0].name, "a", text);
    assert.equal(servers[0].mcp.command, "npx", text);
  }

  // An unrelated settings file must not be mistaken for a bare server map.
  const unrelated = parseMcpConfigJson('{"theme":"dark","fontSize":13}');
  assert.deepEqual(unrelated.servers, []);
  assert.deepEqual(unrelated.errors, ["未找到 mcpServers 配置"]);

  // Arrays, e.g. a registry export.
  const array = parseMcpConfigJson('[{"name":"a","command":"npx"},{"name":"broken"}]');
  assert.equal(array.servers.length, 1);
  assert.equal(array.errors.length, 1);
});

test("mcp json parser collects per-project servers from ~/.claude.json without duplicating", () => {
  const { servers } = parseMcpConfigJson(JSON.stringify({
    numStartups: 42,
    mcpServers: { shared: { command: "npx" } },
    projects: {
      "D:/work/alpha": { mcpServers: { shared: { command: "npx" }, alpha: { command: "node", args: ["a.js"] } } },
      "D:/work/beta": { allowedTools: [] }
    }
  }), "Claude Code");
  assert.deepEqual(servers.map((server) => server.name).sort(), ["alpha", "shared"]);
  assert.equal(byName(servers, "shared").origin, "Claude Code");
  assert.equal(byName(servers, "alpha").origin, "Claude Code · D:/work/alpha");
});

test("mcp json parser normalizes transport, disabled flag and loose value types", () => {
  const { servers } = parseMcpConfigJson(JSON.stringify({
    mcpServers: {
      sse: { type: "sse", url: "https://example.com/sse" },
      streamable: { type: "streamable-http", url: "https://example.com/mcp" },
      off: { command: "npx", disabled: true },
      noArgs: { command: "npx", args: null },
      loose: { command: "npx", env: { PORT: 8080, DEBUG: true, NESTED: { a: 1 } } }
    }
  }));

  const sse = byName(servers, "sse");
  assert.equal(sse.mcp.transport, "http");
  assert.ok(sse.warnings.includes("SSE 传输已按 HTTP 处理"));

  assert.equal(byName(servers, "streamable").mcp.transport, "http");

  const off = byName(servers, "off");
  assert.equal(off.enabled, false);
  assert.equal(off.warnings.length, 1);

  assert.equal(byName(servers, "noArgs").mcp.args, undefined);

  const loose = byName(servers, "loose");
  assert.deepEqual(loose.mcp.env, { PORT: "8080", DEBUG: "true" });
  assert.equal(loose.warnings.filter((warning) => warning.includes("NESTED")).length, 1);
});

test("mcp json parser restores environment placeholders instead of importing them literally", () => {
  const { servers } = parseMcpConfigJson(JSON.stringify({
    mcpServers: {
      stdio: {
        command: "npx",
        env: {
          GITHUB_TOKEN: "${GITHUB_TOKEN}",
          ALIAS: "${env:OTHER_NAME}",
          UNRESOLVED: "${input:api-key}",
          PLAIN: "keep-me"
        }
      },
      http: {
        url: "https://example.com/mcp",
        headers: {
          Authorization: "Bearer ${API_TOKEN}",
          "X-Tenant": "${env:TENANT_ID}",
          "X-Static": "yes"
        }
      }
    }
  }));

  const stdio = byName(servers, "stdio").mcp;
  assert.deepEqual(stdio.env, { PLAIN: "keep-me", UNRESOLVED: "${input:api-key}" });
  assert.deepEqual(stdio.envPassthrough, ["GITHUB_TOKEN", "ALIAS"]);
  const stdioWarnings = byName(servers, "stdio").warnings.join("\n");
  // A cross-name reference cannot be expressed, so it must be called out.
  assert.match(stdioWarnings, /ALIAS/);
  assert.match(stdioWarnings, /UNRESOLVED/);

  const http = byName(servers, "http").mcp;
  assert.equal(http.bearerTokenEnvVar, "API_TOKEN");
  assert.deepEqual(http.envHeaders, { "X-Tenant": "TENANT_ID" });
  assert.deepEqual(http.headers, { "X-Static": "yes" });
});

test("mcp json parser warns about plaintext secrets but still imports them", () => {
  const { servers } = parseMcpConfigJson(JSON.stringify({
    mcpServers: {
      a: { command: "npx", env: { GITHUB_TOKEN: "ghp_0123456789abcdef", BLAND: "sk-live-0123456789" } },
      b: { url: "https://example.com/mcp", headers: { "X-Api-Key": "AIzaSyC0123456789" } }
    }
  }));
  const a = byName(servers, "a");
  assert.equal(a.mcp.env.GITHUB_TOKEN, "ghp_0123456789abcdef");
  assert.equal(a.warnings.filter((warning) => warning.includes("明文密钥")).length, 2);
  assert.equal(byName(servers, "b").warnings.filter((warning) => warning.includes("明文密钥")).length, 1);
});

test("mcp json parser reports malformed input as an error, never throws", () => {
  const { servers, errors } = parseMcpConfigJson("{ not json");
  assert.deepEqual(servers, []);
  assert.match(errors[0], /JSON 解析失败/);
  assert.deepEqual(parseMcpConfigJson("   "), { servers: [], errors: [] });
});

test("toml parser reads the codex mcp_servers subset", () => {
  const { servers, errors } = parseMcpConfigToml([
    "model = \"gpt-5\"",
    "",
    "[mcp_servers.github]",
    "command = \"npx\"",
    "args = [\"-y\", \"@modelcontextprotocol/server-github\"]",
    "env = { GITHUB_TOKEN = \"ghp_secret_value\" }",
    "",
    "[mcp_servers.\"remote api\"]",
    "url = \"https://example.com/mcp\"",
    "",
    "[mcp_servers.broken]",
    "description = \"no command or url\"",
    "",
    "[history]",
    "persistence = \"save-all\""
  ].join("\n"), "Codex");

  assert.deepEqual(servers.map((server) => server.name), ["github", "remote api"]);
  const github = servers[0];
  assert.deepEqual(github.mcp.args, ["-y", "@modelcontextprotocol/server-github"]);
  assert.deepEqual(github.mcp.env, { GITHUB_TOKEN: "ghp_secret_value" });
  assert.equal(github.origin, "Codex");
  assert.equal(servers[1].mcp.transport, "http");
  assert.equal(errors.length, 1);
  assert.match(errors[0], /broken/);
});

test("command line parser splits quotes, env assignments and shell prompts", () => {
  const plain = parseMcpCommandLine("npx -y @modelcontextprotocol/server-filesystem D:/work").servers[0];
  assert.equal(plain.name, "server-filesystem");
  assert.equal(plain.mcp.command, "npx");
  assert.deepEqual(plain.mcp.args, ["-y", "@modelcontextprotocol/server-filesystem", "D:/work"]);

  const quoted = parseMcpCommandLine('$ npx server "C:/Program Files/data"').servers[0];
  assert.deepEqual(quoted.mcp.args, ["server", "C:/Program Files/data"]);

  const withEnv = parseMcpCommandLine("GITHUB_TOKEN=abc123 npx -y server-github").servers[0];
  assert.deepEqual(withEnv.mcp.env, { GITHUB_TOKEN: "abc123" });
  assert.deepEqual(withEnv.mcp.args, ["-y", "server-github"]);
  assert.equal(withEnv.warnings.length, 1);

  const envKeyword = parseMcpCommandLine("env A=1 node server.js").servers[0];
  assert.deepEqual(envKeyword.mcp.env, { A: "1" });
  assert.equal(envKeyword.mcp.command, "node");

  assert.deepEqual(parseMcpCommandLine("   ").servers, []);
  assert.equal(parseMcpCommandLine("A=1").errors.length, 1);
});

test("skill markdown reads every frontmatter field", () => {
  const { skills } = parseSkillMarkdown([
    "---",
    "name: Code Review",
    "description: Review a diff carefully",
    "tags:",
    "  - review",
    "  - quality",
    "source: https://example.com/skill",
    "providers: [claude-code, codex, nope]",
    "enabled: false",
    "extraKey: surprise",
    "---",
    "",
    "# Code Review",
    "",
    "Look at the diff."
  ].join("\n"), "fallback", "skills.md");

  assert.equal(skills.length, 1);
  const skill = skills[0];
  assert.equal(skill.name, "Code Review");
  assert.equal(skill.description, "Review a diff carefully");
  assert.deepEqual(skill.tags, ["review", "quality"]);
  assert.equal(skill.source, "https://example.com/skill");
  assert.deepEqual(skill.providerIds, ["claude-code", "codex"]);
  assert.equal(skill.enabled, false);
  assert.equal(skill.origin, "skills.md");
  assert.match(skill.warnings.join("\n"), /extraKey/);
  assert.match(skill.warnings.join("\n"), /nope/);
});

test("skill markdown splits one file into several skills", () => {
  const multi = parseSkillMarkdown([
    "Preamble that belongs to no skill.",
    "",
    "---",
    "name: First",
    "---",
    "",
    "Do the first thing.",
    "",
    "---",
    "name: Second",
    "tags: a, b",
    "---",
    "",
    "Do the second thing."
  ].join("\n")).skills;
  assert.deepEqual(multi.map((skill) => skill.name), ["First", "Second"]);
  assert.equal(multi[0].instructions, "Do the first thing.");
  assert.deepEqual(multi[1].tags, ["a", "b"]);

  // No frontmatter, two H1s: split on the headings.
  const headings = parseSkillMarkdown("# Alpha\n\nAlpha body.\n\n# Beta\n\nBeta body.").skills;
  assert.deepEqual(headings.map((skill) => skill.name), ["Alpha", "Beta"]);
  assert.equal(headings[0].description, "Alpha body.");

  // A single H1 stays one skill.
  const single = parseSkillMarkdown("# Only\n\nOnly body.", "file-name").skills;
  assert.equal(single.length, 1);
  assert.equal(single[0].name, "Only");

  // No headings at all: fall back to the file name, description from the body.
  const bare = parseSkillMarkdown("Just instructions.", "my-skill").skills;
  assert.equal(bare[0].name, "my-skill");
  assert.equal(bare[0].description, "Just instructions.");

  // Nothing usable for a description at all: warn instead of inventing one.
  const headingOnly = parseSkillMarkdown("# Title only", "my-skill").skills;
  assert.equal(headingOnly[0].description, "");
  assert.match(headingOnly[0].warnings.join(), /描述/);

  assert.deepEqual(parseSkillMarkdown("   ").skills, []);
});

test("skill markdown round-trips the agenthub marker so rescans are not duplicates", () => {
  const text = [
    "---",
    "name: managed",
    "description: written by agenthub",
    "---",
    "",
    "Body text.",
    "",
    "<!-- agenthub:capability:cap-123 -->",
    ""
  ].join("\n");
  const skill = parseSkillMarkdown(text).skills[0];
  assert.equal(skill.existingId, "cap-123");
  assert.equal(skill.instructions, "Body text.");
});

test("scanSkills walks a directory, prefers SKILL.md and honours its limits", () => {
  const root = mkdtempSync(join(tmpdir(), "agenthub-scan-"));
  try {
    mkdirSync(join(root, "code-review"), { recursive: true });
    writeFileSync(join(root, "code-review", "SKILL.md"), "---\nname: From Dir\n---\n\nReview.\n", "utf8");
    mkdirSync(join(root, "node_modules", "junk"), { recursive: true });
    writeFileSync(join(root, "node_modules", "junk", "SKILL.md"), "---\nname: Ignored\n---\n\nNope.\n", "utf8");
    writeFileSync(join(root, "README.md"), "# Docs\n\nNot a skill.\n", "utf8");

    const { imports, database } = service();
    const scan = imports.scanSkills({ dir: root });
    // README.md is ignored because a conventional SKILL.md exists.
    assert.deepEqual(scan.skills.map((skill) => skill.name), ["From Dir"]);
    // A conventional SKILL.md owns its directory — recorded so the sync can
    // mirror the resources living next to it.
    assert.equal(scan.skills[0].resourceDir, join(root, "code-review"));
    assert.equal(scan.scannedFiles, 1);
    assert.equal(scan.truncated, false);

    // Nothing conventional: fall back to sweeping every markdown file.
    const docs = mkdtempSync(join(tmpdir(), "agenthub-docs-"));
    writeFileSync(join(docs, "guide.md"), "Some guidance.\n", "utf8");
    const fallback = imports.scanSkills({ dir: docs });
    assert.equal(fallback.skills.length, 1);
    assert.equal(fallback.skills[0].name, "guide");
    // A loose markdown file has no resource directory.
    assert.equal(fallback.skills[0].resourceDir, undefined);
    rmSync(docs, { recursive: true, force: true });

    const missing = imports.scanSkills({ dir: join(root, "does-not-exist") });
    assert.deepEqual(missing.skills, []);
    assert.equal(missing.errors.length, 1);

    database.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scanSkills stops descending past the depth limit", () => {
  const root = mkdtempSync(join(tmpdir(), "agenthub-deep-"));
  try {
    const deep = join(root, "a", "b", "c", "d", "e", "f");
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, "SKILL.md"), "---\nname: Too Deep\n---\n\nBody.\n", "utf8");
    const { imports, database } = service();
    const scan = imports.scanSkills({ dir: root });
    assert.deepEqual(scan.skills, []);
    assert.equal(scan.truncated, true);
    database.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("parse dispatches to the right parser and rejects unknown sources", () => {
  const { imports, database } = service();
  assert.equal(imports.parse({ source: "mcpJson", text: '{"mcpServers":{"a":{"command":"npx"}}}' }).mcpServers.length, 1);
  assert.equal(imports.parse({ source: "mcpCommand", text: "npx server" }).mcpServers.length, 1);
  assert.equal(imports.parse({ source: "mcpToml", text: "[mcp_servers.a]\ncommand = \"npx\"" }).mcpServers.length, 1);

  // The file name seeds the skill name when the document has none.
  const skills = imports.parse({ source: "skillMarkdown", text: "Body only.", fileName: "deploy.md" }).skills;
  assert.equal(skills[0].name, "deploy");

  assert.throws(() => imports.parse({ source: "bogus", text: "" }), (error) => error.descriptor?.code === "IPC_INVALID_REQUEST");
  database.close();
});

test("discoverMcp reports every known location without throwing on missing files", () => {
  const { imports, database } = service();
  const { sources } = imports.discoverMcp({ projectRoot: join(tmpdir(), "no-such-project") });
  const ids = sources.map((source) => source.id);
  for (const id of ["claude-code", "claude-desktop", "cursor", "codex", "project-mcp", "project-cursor", "project-vscode"]) {
    assert.ok(ids.includes(id), id);
  }
  for (const source of sources) {
    assert.equal(typeof source.path, "string");
    assert.ok(Array.isArray(source.servers));
  }
  // Project paths are only probed when a root is supplied.
  assert.equal(imports.discoverMcp({}).sources.some((source) => source.id.startsWith("project-")), false);
  database.close();
});

let counter = 0;
function capability(overrides = {}) {
  counter += 1;
  const now = new Date().toISOString();
  return {
    id: `cap-${counter}`,
    kind: "mcp",
    name: "GitHub",
    description: "",
    tags: [],
    enabled: true,
    providerIds: ["codex"],
    mcp: { transport: "stdio", command: "npx" },
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

test("importMany skips, overwrites or renames on conflict", () => {
  const { imports, capabilities, database } = service();
  const first = capabilities.upsert(capability({ id: "cap-existing", providerIds: ["codex", "kimi-code"] }));

  const skipped = imports.importMany({ items: [capability({ name: "github" })] }).results;
  assert.equal(skipped[0].status, "skipped");
  assert.equal(skipped[0].capabilityId, "cap-existing");
  assert.equal(capabilities.list().length, 1);

  const overwritten = imports.importMany({
    items: [capability({ name: "GitHub", description: "updated", providerIds: [] })],
    onConflict: "overwrite"
  }).results;
  assert.equal(overwritten[0].status, "updated");
  assert.equal(overwritten[0].capabilityId, "cap-existing");
  const merged = capabilities.list()[0];
  assert.equal(merged.description, "updated");
  assert.equal(merged.createdAt, first.createdAt);
  // An import without a provider selection must not wipe the existing one.
  assert.deepEqual(merged.providerIds, ["codex", "kimi-code"]);

  const renamed = imports.importMany({ items: [capability({ name: "GitHub" })], onConflict: "rename" }).results;
  assert.equal(renamed[0].status, "created");
  assert.equal(renamed[0].name, "GitHub (2)");
  assert.equal(capabilities.list().length, 2);
  database.close();
});

test("importMany resolves duplicates inside a single batch", () => {
  const { imports, capabilities, database } = service();
  const batch = () => [capability({ name: "Fetch" }), capability({ name: "fetch" }), capability({ name: "Fetch" })];

  // The default policy treats a name consumed earlier in the batch as existing.
  const skipped = imports.importMany({ items: batch() }).results;
  assert.deepEqual(skipped.map((result) => result.status), ["created", "skipped", "skipped"]);
  assert.equal(capabilities.list().length, 1);

  // Renaming keeps whatever casing the source used, only the suffix is added.
  const renamed = imports.importMany({ items: batch(), onConflict: "rename" }).results;
  assert.deepEqual(renamed.map((result) => result.name), ["Fetch (2)", "fetch (3)", "Fetch (4)"]);
  assert.equal(capabilities.list().length, 4);
  database.close();
});

test("importMany keeps skill slugs unique so skill files cannot clobber each other", () => {
  const { imports, capabilities, database } = service();
  const skill = (name, id) => capability({
    id,
    name,
    kind: "skill",
    mcp: undefined,
    skill: { instructions: `Instructions for ${name}.` },
    providerIds: ["claude-code"]
  });

  // "Code Review" and "code-review" both slugify to `code-review`.
  const results = imports.importMany({ items: [skill("Code Review", "s1"), skill("code-review", "s2")] }).results;
  assert.equal(results[0].name, "Code Review");
  assert.notEqual(results[1].name, "code-review");
  assert.equal(new Set(capabilities.list().map((item) => item.name.toLowerCase())).size, 2);
  database.close();
});

test("importMany reports per-item failures without aborting the batch", () => {
  const { imports, capabilities, database } = service();
  const results = imports.importMany({
    items: [capability({ name: "Good" }), capability({ name: "Bad", mcp: { transport: "stdio" } }), capability({ name: "AlsoGood" })]
  }).results;
  assert.deepEqual(results.map((result) => result.status), ["created", "failed", "created"]);
  assert.ok(results[1].error);
  assert.deepEqual(capabilities.list().map((item) => item.name).sort(), ["AlsoGood", "Good"]);
  database.close();
});
