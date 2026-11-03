import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
const source = await readFile(
  new URL(
    "../src/renderer/src/features/agents/import-safety.ts",
    import.meta.url,
  ),
  "utf8",
);
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const {
  maskedJson,
  redactConfig,
  safeMcpSummary,
  prepareImportedCapability,
  isCurrentPreview,
} = await import(
  `data:text/javascript;charset=utf-8,${encodeURIComponent(compiled)}`
);

test("stdio preview masks env and arguments without mutating import data", () => {
  const config = {
    transport: "stdio",
    command: "node",
    args: ["server.js", "--api-key", "fixture-private", "TOKEN=fixture-other"],
    env: { API_KEY: "fixture-env", PATH: "/bin" },
  };
  const original = structuredClone(config);
  const preview = JSON.stringify(redactConfig(config));
  for (const value of ["fixture-private", "fixture-other", "fixture-env"])
    assert.equal(preview.includes(value), false);
  assert.equal(preview.includes("/bin"), false); // Conservatively mask all literal env values.
  assert.equal(safeMcpSummary(config).includes("fixture-private"), false);
  assert.deepEqual(config, original);
});
test("HTTP preview masks URL credentials, query token and headers", () => {
  const config = {
    transport: "http",
    url: "https://fixture-user:fixture-password@example.test/mcp?token=fixture-query&region=us",
    headers: { Authorization: "Bearer fixture-header" },
  };
  const preview = decodeURIComponent(JSON.stringify(redactConfig(config)));
  for (const value of [
    "fixture-user",
    "fixture-password",
    "fixture-query",
    "fixture-header",
  ])
    assert.equal(preview.includes(value), false);
  assert.ok(preview.includes("region=us"));
});
test("malformed JSON never echoes secret-bearing source", () => {
  assert.equal(maskedJson('{"API_KEY":"fixture-secret",'), "••••••••");
  assert.equal(maskedJson(""), "");
});
test("multi-server source display masks nested values", () => {
  const preview = maskedJson(
    JSON.stringify({
      mcpServers: {
        one: { env: { SECRET: "fixture-one" } },
        two: { headers: { "X-API-Key": "fixture-two" } },
      },
    }),
  );
  assert.equal(preview.includes("fixture-one"), false);
  assert.equal(preview.includes("fixture-two"), false);
  assert.ok(preview.includes("one"));
  assert.ok(preview.includes("two"));
});
test("all imported MCP configurations stay disabled; skills keep original enabled state", () => {
  for (const enabled of [true, false]) {
    const item = {
      kind: "mcp",
      enabled,
      mcp: { transport: "stdio", command: "node" },
    };
    assert.equal(prepareImportedCapability(item).enabled, false);
    assert.equal(item.enabled, enabled);
  }
  const skill = { kind: "skill", enabled: true };
  assert.equal(prepareImportedCapability(skill), skill);
});
test("preview is rejected immediately when text or source changes before debounce", () => {
  const key = "mcpJson\0old";
  assert.equal(isCurrentPreview("mcpJson", "old", key), true);
  assert.equal(isCurrentPreview("mcpJson", "new", key), false);
  assert.equal(isCurrentPreview("mcpCommand", "old", key), false);
  assert.equal(isCurrentPreview("mcpJson", "old", undefined), false);
  assert.equal(isCurrentPreview(undefined, "", undefined), true);
});
