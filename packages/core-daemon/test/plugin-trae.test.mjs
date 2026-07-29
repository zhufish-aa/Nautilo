import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { AdapterRegistry, PluginService } from "../dist/index.js";

const pluginSource = join(import.meta.dirname, "..", "..", "provider-plugin-trae");
const pluginDist = join(pluginSource, "dist", "index.js");

function tempDir(t, prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

const FAKE_TRAE_CLI = `const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("trae-cli 0.3.0"); process.exit(0); }
if (args.includes("--help")) { console.log("usage: trae-cli\\n\\ncommands:\\n  run          Run a task\\n  interactive  Interactive mode"); process.exit(0); }
if (args[0] === "run") { console.log("Task result: " + args[1]); process.exit(0); }
process.exit(1);
`;

const FAKE_TRAECLI_ACP = `const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("traecli 1.0.0"); process.exit(0); }
if (args.includes("--help")) { console.log("usage: traecli\\n\\ncommands:\\n  acp serve    Start the ACP server"); process.exit(0); }
let buffer = "";
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\\n");
const notify = (method, params) => send({ jsonrpc: "2.0", method, params });
function handle(msg) {
  if (msg.method === "initialize") return send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
  if (msg.method === "session/new") return send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "trae-session-1", configOptions: [{ id: "model", name: "Model", options: [{ value: "trae-model-a" }] }] } });
  if (msg.method === "session/load") return send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: msg.params.sessionId, configOptions: [{ id: "model", name: "Model", options: [{ value: "trae-model-a" }] }] } });
  if (msg.method === "session/set_config_option") return send({ jsonrpc: "2.0", id: msg.id, result: {} });
  if (msg.method === "session/prompt") {
    const sessionId = msg.params.sessionId;
    notify("session/update", { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello " } } });
    notify("session/update", { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "world" } } });
    notify("session/update", { sessionId, update: { sessionUpdate: "tool_call", toolCallId: "call-1", title: "edit_file", status: "completed", rawInput: { path: "a.ts", old_string: "a", new_string: "b" }, rawOutput: "done" } });
    notify("session/update", { sessionId, update: { sessionUpdate: "usage_update", used: 1200, size: 200000 } });
    return send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
  }
}
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split(/\\r?\\n/);
  buffer = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    handle(JSON.parse(line));
  }
});
setInterval(() => {}, 1000);
`;

test("the trae plugin installs and registers the provider", async (t) => {
  if (!existsSync(pluginDist)) {
    t.skip("provider-plugin-trae is not built");
    return;
  }
  const dataDir = tempDir(t, "agenthub-plugins-");
  const adapters = new AdapterRegistry();
  const service = new PluginService(dataDir, adapters);
  await service.ready;
  assert.ok(!adapters.has("trae"));

  const record = await service.installLocal(pluginSource);
  assert.equal(record.status, "loaded", record.error);
  const adapter = adapters.get("trae");
  assert.equal(adapter.constructor.name, "TraePluginAdapter");
  assert.equal(adapter.descriptor.defaultExecutable, "traecli");

  await service.uninstall("trae");
  assert.ok(!adapters.has("trae"));
});

test("the trae plugin drives trae-agent in plain-text mode", async (t) => {
  if (!existsSync(pluginDist)) {
    t.skip("provider-plugin-trae is not built");
    return;
  }
  const factory = (await import(pathToFileURL(pluginDist).href)).default;
  const adapter = factory({ sdkVersion: 1 });
  const bin = tempDir(t, "agenthub-fake-trae-cli-");
  const fakeCli = join(bin, "fake-trae-cli.mjs");
  writeFileSync(fakeCli, FAKE_TRAE_CLI, "utf8");
  const instance = { providerId: "trae", executable: process.execPath, baseArgs: [fakeCli], providerOptions: {} };

  const detection = await adapter.detect(instance);
  assert.equal(detection.installed, true, detection.error);

  const events = [];
  for await (const event of adapter.start({ instance, prompt: "hello", cwd: bin, env: {} }).events) events.push(event);
  assert.equal(events[0].kind, "status");
  const message = events.find((event) => event.kind === "message");
  assert.match(message.text, /Task result: hello/);
  assert.equal(events.at(-1).kind, "exit");
  assert.equal(events.at(-1).exitCode, 0);
});

test("the trae plugin drives traecli over ACP with streaming, tools, usage and resume", async (t) => {
  if (!existsSync(pluginDist)) {
    t.skip("provider-plugin-trae is not built");
    return;
  }
  const factory = (await import(pathToFileURL(pluginDist).href)).default;
  const adapter = factory({ sdkVersion: 1 });
  const bin = tempDir(t, "agenthub-fake-traecli-");
  const fakeCli = join(bin, "fake-traecli.mjs");
  writeFileSync(fakeCli, FAKE_TRAECLI_ACP, "utf8");
  const instance = { providerId: "trae", executable: process.execPath, baseArgs: [fakeCli], providerOptions: {} };

  const detection = await adapter.detect(instance);
  assert.equal(detection.installed, true, detection.error);
  assert.equal(detection.error, undefined);

  const started = [];
  for await (const event of adapter.start({ instance, prompt: "hi", cwd: bin, env: {}, model: "trae-model-a" }).events) started.push(event);
  assert.equal(started.find((event) => event.kind === "session")?.providerSessionId, "trae-session-1");
  const deltas = started.filter((event) => event.kind === "message" && event.phase === "delta").map((event) => event.text);
  assert.deepEqual(deltas, ["Hello ", "world"]);
  assert.ok(started.some((event) => event.kind === "message" && event.phase === "completed"));
  const tool = started.find((event) => event.kind === "tool");
  assert.equal(tool.name, "edit_file");
  assert.equal(tool.phase, "completed");
  assert.deepEqual(tool.fileDiff, { operation: "edit", path: "a.ts", before: "a", after: "b" });
  const usage = started.find((event) => event.kind === "usage");
  assert.equal(usage.contextUsed, 1200);
  assert.equal(usage.contextWindow, 200000);
  assert.ok(started.some((event) => event.kind === "status" && event.phase === "turn_completed"));
  assert.equal(started.at(-1).kind, "exit");
  assert.equal(started.at(-1).exitCode, 0);

  // Resume uses session/load and re-applies the session model.
  const resumed = [];
  for await (const event of adapter.resume({ instance, prompt: "again", providerSessionId: "trae-session-1", cwd: bin, env: {}, model: "trae-model-a" }).events) resumed.push(event);
  assert.equal(resumed.find((event) => event.kind === "session")?.providerSessionId, "trae-session-1");
  assert.ok(resumed.some((event) => event.kind === "status" && event.phase === "turn_completed"));
  assert.equal(resumed.at(-1).kind, "exit");
  assert.equal(resumed.at(-1).exitCode, 0);
});

test("the trae plugin parses ACP updates and builds trae-agent args", async (t) => {
  if (!existsSync(pluginDist)) {
    t.skip("provider-plugin-trae is not built");
    return;
  }
  const { parseTraeAcpUpdate, traeCliArgs, cleanTraeCliText } = await import(pathToFileURL(pluginDist).href);

  const state = { messageId: "m", thinkingId: "th", toolNames: new Map(), toolCalls: new Map() };
  const usage = parseTraeAcpUpdate({ sessionUpdate: "usage_update", used: 42, size: 128000 }, state);
  assert.deepEqual(usage, [{ kind: "usage", contextUsed: 42, contextWindow: 128000, raw: usage[0].raw }]);

  const commands = parseTraeAcpUpdate({ sessionUpdate: "available_commands_update", availableCommands: [{ name: "review", description: "Review code", input: { hint: "PR" } }] }, state);
  assert.equal(commands[0].kind, "commands");
  assert.deepEqual(commands[0].commands, [{ name: "review", description: "Review code", inputHint: "PR" }]);

  // Cumulative tool input re-emissions do not duplicate started events.
  const first = parseTraeAcpUpdate({ sessionUpdate: "tool_call", toolCallId: "c1", title: "write_file", status: "in_progress", rawInput: { path: "x.ts", content: "a" } }, state);
  const duplicate = parseTraeAcpUpdate({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "in_progress", rawInput: { path: "x.ts", content: "ab" } }, state);
  const done = parseTraeAcpUpdate({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed", rawOutput: "ok" }, state);
  assert.equal(first[0].phase, "started");
  assert.deepEqual(first[0].fileDiff, { operation: "write", path: "x.ts", before: "", after: "a" });
  assert.equal(duplicate.length, 0);
  assert.equal(done[0].phase, "completed");
  assert.equal(done[0].success, true);

  const base = { executable: "trae-cli", baseArgs: [] };
  assert.deepEqual(
    traeCliArgs(base, { instance: base, prompt: "hi", cwd: "/repo", model: "anthropic/claude-sonnet-4" }),
    ["run", "hi", "--working-dir", "/repo", "--provider", "anthropic", "--model", "claude-sonnet-4"]
  );
  assert.deepEqual(
    traeCliArgs({ executable: "uv", baseArgs: ["run", "trae-cli"] }, { instance: base, prompt: "hi", cwd: "/repo" }),
    ["run", "trae-cli", "run", "hi", "--working-dir", "/repo"]
  );

  assert.equal(cleanTraeCliText("[38;5;1mhello[0m\n"), "hello");
});
