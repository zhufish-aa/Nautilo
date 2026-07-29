import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProcessRuntime } from "../dist/index.js";

const fixture = fileURLToPath(new URL("./fixtures/fake-cli.mjs", import.meta.url));
const ptySmoke = fileURLToPath(new URL("./fixtures/pty-smoke.mjs", import.meta.url));

test("process runtime streams output and exit code", async () => {
  const handle = new ProcessRuntime().start({ command: process.execPath, args: [fixture], timeoutMs: 5_000 });
  const events = [];
  for await (const event of handle.events) events.push(event);
  assert.ok(events.some((event) => event.kind === "stdout" && event.text.includes("fixture ready")));
  assert.equal(events.at(-1)?.exitCode, 0);
});

test("process runtime enforces total timeout", async () => {
  const handle = new ProcessRuntime().start({ command: process.execPath, args: [fixture, "--hang"], timeoutMs: 150 });
  const events = [];
  for await (const event of handle.events) events.push(event);
  assert.ok(events.some((event) => event.kind === "timeout" && event.reason === "timeout"));
});

test("process runtime enforces idle timeout", async () => {
  const handle = new ProcessRuntime().start({ command: process.execPath, args: [fixture, "--hang"], idleTimeoutMs: 150 });
  const events = [];
  for await (const event of handle.events) events.push(event);
  assert.ok(events.some((event) => event.kind === "timeout" && event.reason === "idle"));
});

test("process cancellation waits for the process to exit", async () => {
  const handle = new ProcessRuntime().start({ command: process.execPath, args: [fixture, "--hang"] });
  const exit = handle.wait();
  await new Promise((resolve) => setTimeout(resolve, 80));
  await handle.cancel();
  const result = await exit;
  assert.notEqual(result.exitCode, 0);
});

test("PTY runtime executes an interactive provider in an isolated smoke process", async (t) => {
  const handle = new ProcessRuntime().start({ command: process.execPath, args: [ptySmoke], timeoutMs: 8_000 });
  const events = [];
  for await (const event of handle.events) events.push(event);
  const exitCode = events.findLast((event) => event.kind === "exit")?.exitCode;
  if (exitCode === 77) return t.skip("node-pty optional dependency is unavailable");
  assert.equal(exitCode, 0);
});

test("windows: npm-style .cmd shims on PATH spawn via cmd.exe", async (t) => {
  if (process.platform !== "win32") return t.skip("windows-only");
  const dir = mkdtempSync(join(tmpdir(), "agenthub-shim-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // npm global installs produce both an extensionless shell script and a
  // .cmd shim; only the .cmd is spawnable on win32.
  writeFileSync(join(dir, "shim-cli"), "#!/bin/sh\necho bash-shim\n", "utf8");
  writeFileSync(join(dir, "shim-cli.cmd"), "@echo off\necho cmd-shim %1 %2\n", "utf8");

  const env = { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH}` };
  const handle = new ProcessRuntime().start({ command: "shim-cli", args: ["hello", "two words"], env, timeoutMs: 5_000 });
  const events = [];
  for await (const event of handle.events) events.push(event);
  const stdout = events.filter((event) => event.kind === "stdout").map((event) => event.text).join("");
  assert.match(stdout, /cmd-shim hello "two words"/);
  assert.equal(events.at(-1)?.exitCode, 0);
});

test("windows: an unresolvable command still fails as a spawn error", async (t) => {
  if (process.platform !== "win32") return t.skip("windows-only");
  const handle = new ProcessRuntime().start({ command: "definitely-not-a-real-cli-9f3b", args: [], timeoutMs: 5_000 });
  const events = [];
  for await (const event of handle.events) events.push(event);
  assert.ok(events.some((event) => event.kind === "error"));
});
