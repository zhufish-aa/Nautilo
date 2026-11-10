import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
const source = await readFile(new URL("../src/renderer/src/lib/capability-origin.ts", import.meta.url), "utf8");
const module = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { capabilityOrigin, capabilityDescription } = await import(`data:text/javascript,${encodeURIComponent(module)}`);
const skill = (patch = {}) => ({ tags: [], description: "", ...patch });
test("origin distinguishes bundled skills, plugin packages and local CLI imports", () => {
  assert.equal(capabilityOrigin(skill({ tags: ["office", "builtin"], skill: { source: "Built-in" } })).kind, "builtin");
  const plugin = capabilityOrigin(skill({ skill: { resourceDir: "C:\\Users\\a\\.codex\\plugins\\cache\\openai-primary-runtime\\documents\\1.0\\skills\\documents" } }));
  assert.equal(plugin.kind, "plugin"); assert.equal(plugin.label, "documents");
  const local = capabilityOrigin(skill({ skill: { resourceDir: "C:\\Users\\a\\.codex\\skills\\reports" } }));
  assert.equal(local.kind, "local"); assert.equal(local.label, "Codex");
});
test("missing provenance stays unknown and YAML block markers are not descriptions", () => {
  assert.equal(capabilityOrigin(skill({ name: "Office Presentations" })).kind, "unknown");
  assert.equal(capabilityDescription(skill({ description: "|" })), "");
  assert.equal(capabilityDescription(skill({ description: "Real description" })), "Real description");
});
