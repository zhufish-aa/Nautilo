import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../src/renderer/src/lib/session-error-presentation.ts", import.meta.url), "utf8");
const exports = {};
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports });
const present = exports.sessionErrorPresentation;

test("expired login has a named account and reauthentication action", () => {
  const result = present("AGENT_NOT_AUTHENTICATED", "登录失效", true, { id: "one", kind: "login", name: "Codex 账号 1" });
  assert.equal(result.loginRequired, true);
  assert.equal(result.settings, "accounts");
  assert.match(result.description, /Codex 账号 1/);
  assert.equal(present("PROVIDER_ERROR", "HTTP 401", true, { kind: "login" }).loginRequired, true);
});

test("API key and network failures keep their own recovery guidance", () => {
  assert.match(present("PROVIDER_ERROR", "401 Unauthorized", true, { kind: "api" }).description, /API Key/);
  assert.equal(present("PROVIDER_ERROR", "Connection error", true, { kind: "login" }).loginRequired, undefined);
  assert.equal(present("PROVIDER_ERROR", "409 NATIVE_CONVERSATION_DIVERGED", true, { kind: "login" }).loginRequired, undefined);
});
