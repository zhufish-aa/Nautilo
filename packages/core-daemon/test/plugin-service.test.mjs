import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { AdapterRegistry, PluginService } from "../dist/index.js";

const execFileAsync = promisify(execFile);

function tempDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writePlugin(dir, { id = "demo-cli", apiVersion = 1, providerId, entry }) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "agenthub-plugin.json"), JSON.stringify({
    id,
    apiVersion,
    main: "index.mjs",
    descriptor: {
      providerId: providerId ?? id,
      name: "Demo CLI",
      vendor: "Test",
      capabilities: ["headless_text"],
      credentialEnv: ["DEMO_API_KEY"]
    }
  }), "utf8");
  writeFileSync(join(dir, "index.mjs"), entry ?? `
    export default function createAdapter() {
      return {
        providerId: "${providerId ?? id}",
        descriptor: { providerId: "${providerId ?? id}", name: "Demo CLI", vendor: "Test", capabilities: ["headless_text"], credentialEnv: ["DEMO_API_KEY"] },
        supportsStructuredOutput: false,
        supportsResume: false,
        capabilities: { structuredOutput: false, textOutput: true, interactiveStdin: false, nativeResume: false, pty: false },
        detect: async () => ({ installed: true, executable: "demo" }),
        start() { throw new Error("fixture adapter does not run"); }
      };
    }
  `, "utf8");
}

test("startup scan loads a valid plugin and registers its adapter", async (t) => {
  const dataDir = tempDir(t, "agenthub-plugins-");
  writePlugin(join(dataDir, "plugins", "demo-cli"), {});
  const adapters = new AdapterRegistry([]);
  const service = new PluginService(dataDir, adapters);
  await service.ready;

  const [record] = service.list();
  assert.equal(record.status, "loaded");
  assert.equal(record.enabled, true);
  assert.ok(adapters.has("demo-cli"));
  assert.equal(adapters.get("demo-cli").descriptor.credentialEnv[0], "DEMO_API_KEY");
});

test("incompatible apiVersion is recorded as an error, never blocks others", async (t) => {
  const dataDir = tempDir(t, "agenthub-plugins-");
  writePlugin(join(dataDir, "plugins", "old-cli"), { id: "old-cli", apiVersion: 999 });
  writePlugin(join(dataDir, "plugins", "demo-cli"), {});
  const adapters = new AdapterRegistry([]);
  const service = new PluginService(dataDir, adapters);
  await service.ready;

  const records = service.list();
  const broken = records.find((record) => record.id === "old-cli");
  assert.equal(broken.status, "error");
  assert.match(broken.error, /API 版本不兼容/);
  assert.ok(!adapters.has("old-cli"));
  assert.ok(adapters.has("demo-cli"));
});

test("a plugin can override a built-in provider; disabling restores the built-in", async (t) => {
  const dataDir = tempDir(t, "agenthub-plugins-");
  writePlugin(join(dataDir, "plugins", "codex"), { id: "codex" });
  const adapters = new AdapterRegistry();
  const service = new PluginService(dataDir, adapters);
  await service.ready;

  const [record] = service.list();
  assert.equal(record.status, "loaded");
  // The plugin adapter replaces the built-in codex adapter.
  assert.equal(adapters.get("codex").descriptor.vendor, "Test");

  const disabled = await service.setEnabled("codex", false);
  assert.equal(disabled.status, "disabled");
  assert.equal(adapters.get("codex").descriptor.vendor, "OpenAI");

  // Re-enabling overrides the built-in again; uninstalling restores it.
  await service.setEnabled("codex", true);
  assert.equal(adapters.get("codex").descriptor.vendor, "Test");
  await service.uninstall("codex");
  assert.equal(adapters.get("codex").descriptor.vendor, "OpenAI");
});

test("disable unregisters the adapter and marks the plugin; enable reloads it", async (t) => {
  const dataDir = tempDir(t, "agenthub-plugins-");
  writePlugin(join(dataDir, "plugins", "demo-cli"), {});
  const adapters = new AdapterRegistry([]);
  const service = new PluginService(dataDir, adapters);
  await service.ready;

  const disabled = await service.setEnabled("demo-cli", false);
  assert.equal(disabled.status, "disabled");
  assert.ok(!adapters.has("demo-cli"));

  // A fresh daemon scan keeps it disabled.
  const restarted = new PluginService(dataDir, adapters);
  await restarted.ready;
  assert.equal(restarted.list()[0].status, "disabled");
  assert.ok(!adapters.has("demo-cli"));

  const enabled = await restarted.setEnabled("demo-cli", true);
  assert.equal(enabled.status, "loaded");
  assert.ok(adapters.has("demo-cli"));
});

test("disabling a plugin disposes its long-lived adapter resources", async (t) => {
  const dataDir = tempDir(t, "agenthub-plugins-");
  const marker = join(dataDir, "disposed.txt");
  writePlugin(join(dataDir, "plugins", "demo-cli"), {
    entry: `
      import { writeFileSync } from "node:fs";
      export default function createAdapter() {
        return {
          providerId: "demo-cli",
          descriptor: { providerId: "demo-cli", name: "Demo CLI", vendor: "Test", capabilities: ["headless_text"], credentialEnv: ["DEMO_API_KEY"] },
          supportsStructuredOutput: false,
          supportsResume: false,
          capabilities: { structuredOutput: false, textOutput: true, interactiveStdin: false, nativeResume: false, pty: false },
          detect: async () => ({ installed: true, executable: "demo" }),
          start() { throw new Error("fixture adapter does not run"); },
          dispose() { writeFileSync(${JSON.stringify(marker)}, "disposed", "utf8"); }
        };
      }
    `
  });
  const adapters = new AdapterRegistry([]);
  const service = new PluginService(dataDir, adapters);
  await service.ready;

  await service.setEnabled("demo-cli", false);

  assert.equal(readFileSync(marker, "utf8"), "disposed");
  assert.ok(!adapters.has("demo-cli"));
});

test("installLocal copies the directory and loads it; uninstall removes both", async (t) => {
  const dataDir = tempDir(t, "agenthub-plugins-");
  const source = tempDir(t, "agenthub-plugin-src-");
  writePlugin(source, {});
  const adapters = new AdapterRegistry([]);
  const service = new PluginService(dataDir, adapters);
  await service.ready;

  const installed = await service.installLocal(source);
  assert.equal(installed.status, "loaded");
  assert.ok(readFileSync(join(dataDir, "plugins", "demo-cli", "agenthub-plugin.json"), "utf8"));
  assert.ok(adapters.has("demo-cli"));

  await service.uninstall("demo-cli");
  assert.equal(service.list().length, 0);
  assert.ok(!adapters.has("demo-cli"));
});

test("adapter whose providerId mismatches the manifest is rejected", async (t) => {
  const dataDir = tempDir(t, "agenthub-plugins-");
  writePlugin(join(dataDir, "plugins", "demo-cli"), { providerId: "other-cli" });
  const adapters = new AdapterRegistry([]);
  const service = new PluginService(dataDir, adapters);
  await service.ready;

  assert.equal(service.list()[0].status, "error");
  assert.ok(!adapters.has("demo-cli"));
});

async function serveRegistry(t, { archive, sha256, tamper = false }) {
  const server = createServer((request, response) => {
    if (request.url === "/registry.json") {
      const port = server.address().port;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        plugins: [{
          id: "demo-cli",
          name: "Demo CLI",
          version: "1.0.0",
          vendor: "Test",
          description: { "zh-CN": "演示插件", "en-US": "Demo plugin" },
          tarball: `http://127.0.0.1:${port}/demo.tgz`,
          sha256: tamper ? "0".repeat(64) : sha256
        }]
      }));
      return;
    }
    response.setHeader("content-type", "application/gzip");
    response.end(readFileSync(archive));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}/registry.json`;
}

test("installFromRegistry downloads, verifies sha256 and loads the plugin", async (t) => {
  const dataDir = tempDir(t, "agenthub-plugins-");
  const source = tempDir(t, "agenthub-plugin-src-");
  writePlugin(source, {});
  const scratch = tempDir(t, "agenthub-plugin-pack-");
  const archive = join(scratch, "demo.tgz");
  await execFileAsync("tar", ["--force-local", "-czf", archive.replaceAll("\\", "/"), "-C", source.replaceAll("\\", "/"), "."]);
  const sha256 = createHash("sha256").update(readFileSync(archive)).digest("hex");
  const registryUrl = await serveRegistry(t, { archive, sha256 });

  const adapters = new AdapterRegistry([]);
  const service = new PluginService(dataDir, adapters);
  await service.ready;

  const entries = await service.fetchRegistry(registryUrl);
  assert.equal(entries[0].id, "demo-cli");
  const record = await service.installFromRegistry("demo-cli", registryUrl);
  assert.equal(record.status, "loaded");
  assert.ok(adapters.has("demo-cli"));
});

test("installFromRegistry refuses a tarball whose sha256 does not match", async (t) => {
  const dataDir = tempDir(t, "agenthub-plugins-");
  const source = tempDir(t, "agenthub-plugin-src-");
  writePlugin(source, {});
  const scratch = tempDir(t, "agenthub-plugin-pack-");
  const archive = join(scratch, "demo.tgz");
  await execFileAsync("tar", ["--force-local", "-czf", archive.replaceAll("\\", "/"), "-C", source.replaceAll("\\", "/"), "."]);
  const sha256 = createHash("sha256").update(readFileSync(archive)).digest("hex");
  const registryUrl = await serveRegistry(t, { archive, sha256, tamper: true });

  const adapters = new AdapterRegistry([]);
  const service = new PluginService(dataDir, adapters);
  await service.ready;
  await assert.rejects(
    () => service.installFromRegistry("demo-cli", registryUrl),
    (error) => error.descriptor?.code === "PLUGIN_CHECKSUM_MISMATCH"
  );
  assert.ok(!adapters.has("demo-cli"));
});

test("the real opencode plugin installs, registers the provider and streams events", async (t) => {
  // Requires `pnpm --filter @agenthub/provider-plugin-opencode build` first.
  const pluginSource = join(import.meta.dirname, "..", "..", "provider-plugin-opencode");
  const pluginDist = join(pluginSource, "dist", "index.js");
  if (!existsSync(pluginDist)) {
    t.skip("provider-plugin-opencode is not built");
    return;
  }
  // Fake `opencode` CLI: echoes its argv as one real-schema text event, then exits 0.
  const bin = tempDir(t, "agenthub-fake-opencode-");
  const fakeCli = join(bin, "fake-opencode.mjs");
  writeFileSync(fakeCli, `console.log(JSON.stringify({ type: "text", sessionID: "s-fixture", part: { type: "text", messageID: "m1", text: JSON.stringify(process.argv.slice(2)) } }));\n`, "utf8");

  const dataDir = tempDir(t, "agenthub-plugins-");
  const adapters = new AdapterRegistry();
  const service = new PluginService(dataDir, adapters);
  await service.ready;
  // OpenCode is plugin-only: nothing is registered before the install.
  assert.ok(!adapters.has("opencode"));

  const record = await service.installLocal(pluginSource);
  assert.equal(record.status, "loaded", record.error);
  const adapter = adapters.get("opencode");
  assert.equal(adapter.constructor.name, "OpenCodePluginAdapter");
  assert.equal(adapter.descriptor.defaultExecutable, "opencode");

  const instance = { providerId: "opencode", executable: process.execPath, baseArgs: [fakeCli], providerOptions: {} };
  const detection = await adapter.detect(instance);
  assert.equal(detection.installed, true, detection.error);

  const collect = async (run) => {
    const events = [];
    for await (const event of run.events) events.push(event);
    return events;
  };
  const started = await collect(adapter.start({ instance, prompt: "hello", cwd: bin, env: {} }));
  const startedText = started.find((event) => event.kind === "message")?.text ?? "";
  assert.match(startedText, /hello/);
  // The session id is captured from the event stream for native resume.
  assert.equal(started.find((event) => event.kind === "session")?.providerSessionId, "s-fixture");
  assert.equal(started.at(-1).kind, "exit");
  assert.equal(started.at(-1).exitCode, 0);

  const resumed = await collect(adapter.resume({ instance, prompt: "again", providerSessionId: "s-1", cwd: bin, env: {} }));
  const resumedText = resumed.find((event) => event.kind === "message")?.text ?? "";
  assert.match(resumedText, /--session/);
  assert.match(resumedText, /s-1/);

  // Uninstalling removes the provider entirely — there is no built-in fallback.
  await service.uninstall("opencode");
  assert.ok(!adapters.has("opencode"));
});

test("the opencode server transport reuses a server, ignores terminal SSE errors and recovers after exit", async (t) => {
  const pluginDist = join(import.meta.dirname, "..", "..", "provider-plugin-opencode", "dist", "index.js");
  if (!existsSync(pluginDist)) {
    t.skip("provider-plugin-opencode is not built");
    return;
  }

  const bin = tempDir(t, "agenthub-fake-opencode-server-");
  const fakeServer = join(bin, "fake-opencode-server.mjs");
  writeFileSync(fakeServer, `
    import { createServer } from "node:http";

    const portIndex = process.argv.indexOf("--port");
    const port = Number(process.argv[portIndex + 1]);
    let eventResponse;
    const server = createServer(async (request, response) => {
      const url = new URL(request.url, "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/session/status") {
        response.setHeader("content-type", "application/json");
        response.end("{}");
        return;
      }
      if (request.method === "GET" && url.pathname === "/event") {
        eventResponse = response;
        response.writeHead(200, { "content-type": "text/event-stream", connection: "keep-alive" });
        response.write(": connected\\n\\n");
        return;
      }
      if (request.method === "POST" && url.pathname === "/session") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ id: "s-fixture" }));
        return;
      }
      if (request.method === "POST" && url.pathname === "/session/s-fixture/prompt_async") {
        let body = "";
        for await (const chunk of request) body += chunk;
        const prompt = JSON.parse(body).parts?.find((part) => part.type === "text")?.text;
        response.writeHead(204).end();
        setTimeout(() => {
          const target = eventResponse;
          const sendEvent = (event) => target?.write(\`data: \${JSON.stringify(event)}\\n\\n\`);
          sendEvent({
            type: "message.part.updated",
            properties: { part: { type: "text", sessionID: "s-fixture", messageID: "m1", text: prompt === "cancel me" ? "ready" : "Hi", time: { end: 1 } } }
          });
          if (prompt === "cancel me") return;
          sendEvent({
            type: "session.status",
            properties: { sessionID: "s-fixture", status: { type: "idle" } }
          });
          setTimeout(() => target?.socket.destroy(), 5);
        }, 10);
        return;
      }
      if (request.method === "POST" && url.pathname === "/session/s-fixture/abort") {
        eventResponse?.write(\`data: \${JSON.stringify({
          type: "session.error",
          properties: { sessionID: "s-fixture", error: { name: "MessageAbortedError", data: { message: "Aborted" } } }
        })}\\n\\n\`);
        setTimeout(() => response.writeHead(204).end(), 10);
        return;
      }
      response.writeHead(404).end();
    });
    server.listen(port, "127.0.0.1");
  `, "utf8");

  let executable;
  if (process.platform === "win32") {
    executable = join(bin, "fake-opencode.cmd");
    writeFileSync(executable, `@"${process.execPath}" "${fakeServer}" %*\r\n`, "utf8");
  } else {
    executable = join(bin, "fake-opencode");
    writeFileSync(executable, `#!/bin/sh\nexec "${process.execPath}" "${fakeServer}" "$@"\n`, "utf8");
    chmodSync(executable, 0o755);
  }

  const { default: createAdapter } = await import(`${pathToFileURL(pluginDist).href}?server-termination-test`);
  const adapter = createAdapter();
  const within = async (promise, label) => {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), 5_000); })
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const instance = { id: "opencode-fixture", providerId: "opencode", executable, baseArgs: [], providerOptions: {} };
  const collect = async (prompt) => {
    const events = [];
    const run = adapter.start({ instance, prompt, cwd: bin, env: process.env });
    for await (const event of run.events) events.push(event);
    return { events, pid: run.process.pid, process: run.process };
  };
  const first = await within(collect("hello"), "first turn");
  const second = await within(collect("again"), "second turn");
  const cancelledEvents = [];
  let markReady;
  const ready = new Promise((resolve) => { markReady = resolve; });
  const cancelledRun = adapter.start({ instance, prompt: "cancel me", cwd: bin, env: process.env });
  const consumeCancelled = (async () => {
    for await (const event of cancelledRun.events) {
      cancelledEvents.push(event);
      if (event.kind === "message" && event.text === "ready") markReady();
    }
  })();
  await within(ready, "cancel fixture readiness");
  await within(cancelledRun.cancel(), "run cancellation");
  await within(consumeCancelled, "cancelled event stream shutdown");
  await within(second.process.cancel(), "server shutdown");
  const third = await within(collect("after restart"), "restarted turn");
  const activeEvents = [];
  let markActiveReady;
  const activeReady = new Promise((resolve) => { markActiveReady = resolve; });
  const activeRun = adapter.start({ instance, prompt: "cancel me", cwd: bin, env: process.env });
  const consumeActive = (async () => {
    for await (const event of activeRun.events) {
      activeEvents.push(event);
      if (event.kind === "message" && event.text === "ready") markActiveReady();
    }
  })();
  await within(activeReady, "active dispose fixture readiness");
  await within(Promise.resolve(adapter.dispose?.()), "adapter dispose");
  assert.equal(activeRun.process.child.exitCode, null, "disposing an adapter must not kill an active turn");
  await within(activeRun.cancel(), "active run cancellation");
  await within(consumeActive, "active event stream shutdown");
  await within(activeRun.process.wait(), "retired server shutdown");

  assert.equal(first.events.find((event) => event.kind === "message")?.text, "Hi");
  assert.ok(first.events.some((event) => event.kind === "status" && event.phase === "turn_completed"));
  assert.deepEqual(first.events.filter((event) => event.kind === "error"), []);
  assert.equal(first.events.at(-1)?.kind, "exit");
  assert.equal(first.events.at(-1)?.exitCode, 0);
  assert.equal(second.events.find((event) => event.kind === "message")?.text, "Hi");
  assert.equal(second.pid, first.pid, "consecutive turns should reuse one OpenCode server process");
  assert.deepEqual(cancelledEvents.filter((event) => event.kind === "error"), [], "an explicit cancel must not surface Aborted as a provider error");
  assert.notEqual(third.pid, second.pid, "a dead shared server should be replaced on the next turn");
  assert.equal(third.events.find((event) => event.kind === "message")?.text, "Hi");
  assert.deepEqual(activeEvents.filter((event) => event.kind === "error"), []);
});

test("the opencode plugin normalizes the verbose model list", async (t) => {
  const pluginDist = join(import.meta.dirname, "..", "..", "provider-plugin-opencode", "dist", "index.js");
  if (!existsSync(pluginDist)) {
    t.skip("provider-plugin-opencode is not built");
    return;
  }
  const { parseOpenCodeModels, startArgs } = await import(pathToFileURL(pluginDist).href);
  const catalog = parseOpenCodeModels([
    "opencode/big-pickle",
    "{",
    '  "id": "big-pickle",',
    '  "providerID": "opencode",',
    '  "name": "Big Pickle",',
    '  "status": "active",',
    '  "cost": {',
    '    "cache": {',
    '      "read": 0',
    "    }",
    "  },",
    '  "limit": {',
    '    "context": 200000,',
    '    "input": 160000,',
    '    "output": 32000',
    "  }",
    "}",
    "moonshotai-cn/kimi-k2.6",
    "{",
    '  "id": "kimi-k2.6",',
    '  "name": "Kimi K2.6",',
    '  "status": "deprecated",',
    '  "limit": { "context": 262144 },',
    '  "variants": {',
    '    "low": { "reasoningEffort": "low" },',
    '    "high": { "reasoningEffort": "high" }',
    "  }",
    "}",
    "noise that is not a model line"
  ].join("\n"));

  assert.equal(catalog.providerId, "opencode");
  assert.equal(catalog.source, "provider_cli");
  assert.deepEqual(catalog.models.map((model) => model.id), ["opencode/big-pickle", "moonshotai-cn/kimi-k2.6"]);
  assert.equal(catalog.models[0].displayName, "Big Pickle");
  assert.equal(catalog.models[0].contextWindow, 200000);
  assert.equal(catalog.models[1].displayName, "Kimi K2.6");
  assert.equal(catalog.models[1].contextWindow, 262144);
  assert.equal(catalog.models[1].description, "status: deprecated");
  assert.deepEqual(catalog.models[1].reasoningEfforts, ["low", "high"]);
  assert.deepEqual(catalog.models[0].reasoningEfforts, []);

  // Reasoning effort maps to opencode's --variant flag (default args path only).
  const baseInstance = { providerId: "opencode", executable: "opencode", baseArgs: [], providerOptions: {} };
  assert.deepEqual(
    startArgs(baseInstance, { instance: baseInstance, prompt: "hi", model: "m", reasoningEffort: "high" }),
    ["run", "--format", "json", "--model", "m", "--variant", "high", "hi"]
  );
  assert.deepEqual(
    startArgs(baseInstance, { instance: baseInstance, prompt: "hi" }),
    ["run", "--format", "json", "hi"]
  );
  const custom = { ...baseInstance, baseArgs: ["run", "--pure"] };
  assert.deepEqual(
    startArgs(custom, { instance: custom, prompt: "hi", reasoningEffort: "high" }),
    ["run", "--pure", "hi"]
  );
});

test("the opencode plugin normalizes the real run --format json event schema", async (t) => {
  const pluginDist = join(import.meta.dirname, "..", "..", "provider-plugin-opencode", "dist", "index.js");
  if (!existsSync(pluginDist)) {
    t.skip("provider-plugin-opencode is not built");
    return;
  }
  const { parseOpenCodeEvent } = await import(pathToFileURL(pluginDist).href);

  // Text answers nest under part; the session id rides on every event.
  // Parts arrive complete (no streaming deltas), so they map to completed phases.
  const text = parseOpenCodeEvent({ type: "text", sessionID: "ses_1", part: { type: "text", messageID: "msg_1", text: "Hi" } });
  assert.deepEqual(text[0], { kind: "session", providerSessionId: "ses_1", raw: text[0].raw });
  assert.deepEqual(text[1], { kind: "message", phase: "completed", messageId: "msg_1", text: "Hi", raw: text[1].raw });

  const reasoning = parseOpenCodeEvent({ type: "reasoning", sessionID: "ses_1", part: { type: "reasoning", messageID: "msg_1", text: "hmm" } });
  assert.equal(reasoning[1].kind, "thinking");
  assert.equal(reasoning[1].phase, "completed");
  assert.equal(reasoning[1].text, "hmm");

  const tool = parseOpenCodeEvent({
    type: "tool_use",
    sessionID: "ses_1",
    part: { type: "tool", tool: "bash", callID: "call_1", state: { status: "completed", input: { command: "echo hi" }, output: "hi\n" } }
  });
  assert.deepEqual(tool[1], {
    kind: "tool", callId: "call_1", name: "bash", phase: "completed",
    input: { command: "echo hi" }, output: "hi\n", success: true, raw: tool[1].raw
  });

  const usage = parseOpenCodeEvent({
    type: "step_finish",
    sessionID: "ses_1",
    part: { type: "step-finish", tokens: { total: 10, input: 63, output: 26, reasoning: 17, cache: { read: 8576, write: 0 } } }
  });
  assert.deepEqual(usage[1], {
    kind: "usage", inputTokens: 63, outputTokens: 26, reasoningOutputTokens: 17, cachedInputTokens: 8576,
    // Prompt-side footprint drives the context indicator: input + cache read/write.
    contextUsed: 63 + 8576, raw: usage[1].raw
  });

  // Provider errors must surface, not vanish into raw lines.
  const failure = parseOpenCodeEvent({ type: "error", sessionID: "ses_1", error: { name: "APIError", data: { message: "subscription expired" } } });
  assert.deepEqual(failure.slice(1).map((event) => event.kind), ["status", "error"]);
  assert.equal(failure[1].phase, "turn_failed");
  assert.equal(failure[2].error.message, "subscription expired");

  // step_start carries no user-facing payload beyond the session id.
  const stepStart = parseOpenCodeEvent({ type: "step_start", sessionID: "ses_1", part: { type: "step-start" } });
  assert.deepEqual(stepStart.map((event) => event.kind), ["session"]);
});

test("the opencode plugin classifies plan_exit questions inside the plugin", async (t) => {
  const pluginDist = join(import.meta.dirname, "..", "..", "provider-plugin-opencode", "dist", "index.js");
  if (!existsSync(pluginDist)) {
    t.skip("provider-plugin-opencode is not built");
    return;
  }
  const { classifyOpenCodeQuestion } = await import(pathToFileURL(pluginDist).href);
  const classified = classifyOpenCodeQuestion({
    id: "question-1",
    sessionID: "ses_1",
    tool: { name: "plan_exit" },
    questions: [{
      header: "Build Agent",
      question: "Plan at .opencode/plans/ses_1.md is complete. Would you like to switch to the build agent and start implementing?",
      options: [
        { label: "Yes", description: "Switch to build agent and start implementing the plan" },
        { label: "No", description: "Stay with plan agent to continue refining the plan" }
      ]
    }]
  });
  assert.equal(classified.kind, "plan_approval");
  assert.deepEqual(classified.options.map((option) => option.intent), ["approve", "revise"]);
});
