import test from "node:test";
import assert from "node:assert/strict";
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
