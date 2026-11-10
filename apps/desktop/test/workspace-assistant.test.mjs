import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("vite/package.json"))("esbuild");
const desktop = resolve(import.meta.dirname, "..");
const bundle = await build({
  stdin: {
    contents:
      'export * from "./src/main/assistant/workspace-assistant"; export * from "./src/main/assistant/context"; export * from "./src/main/core-daemon-client";',
    resolveDir: desktop,
  },
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
  logLevel: "silent",
});
const { WorkspaceAssistant, CoreDaemonClient, composeStep, modelContext } = await import(
  "data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].contents).toString("base64")
);
const config = { connectionId: "router", model: "fixture-model", maxSteps: 8 };
const now = new Date().toISOString();
function journal() {
  const rows = [];
  const save = ({ kind, id, value }) => {
    let row = rows.find((r) => r.id === id);
    if (!row) rows.push((row = { id, kind, seq: rows.length + 1 }));
    row.value = structuredClone(value);
    return { seq: row.seq };
  };
  const records = ({ kind, limit = 24, query = "", after = 0, before = 0, oldest = false }) => {
    const match = rows.filter(
      (r) =>
        r.kind === kind &&
        r.seq > after &&
        (!before || r.seq < before) &&
        JSON.stringify(r.value).includes(query),
    );
    return structuredClone((oldest ? match : match.reverse()).slice(0, limit));
  };
  return { rows, save, records };
}
function finishedTurn(text) {
  return { id: "turn_" + randomUUID(), at: now, text, status: "done", reply: "Confirmed.", receipts: [] };
}

test("a routing step appends its observation and leaves earlier blocks byte-identical", () => {
  const base = { prefix: ['{"request":"original"}'], cost: 10 };
  const step = { tool: "list_sessions", arguments: {}, result: [{ id: "a", status: "running" }] };
  const first = composeStep(base, [step], 10000);
  const second = composeStep(
    base,
    [step, { tool: "send_task", arguments: { sessionId: "a" }, result: { delivery: "queued" } }],
    10000,
  );
  assert.deepEqual(second.slice(0, first.length), first);
  assert.equal(second.length, first.length + 1);
});
test("automatic compaction persists a watermark and destinations, with all original requests still searchable", async () => {
  const db = journal();
  const first = finishedTurn("retain_original_marker " + "previous detail ".repeat(140));
  first.receipts = [
    { sessionId: "worker-a", title: "First", project: "Fixture", task: "do it", delivery: "sent" },
  ];
  db.save({ id: first.id, kind: "turn", value: first });
  for (let i = 0; i < 8; i++) {
    const t = finishedTurn("Old history " + i + " detail".repeat(120));
    db.save({ kind: "turn", id: t.id, value: t });
  }
  const current = finishedTurn("What's next?"),
    seq = db.save({ kind: "turn", id: current.id, value: current }).seq;
  let summaries = 0;
  const core = async (method, input) => {
    if (method === "assistant.records") return db.records(input);
    if (method === "assistant.save") return db.save(input);
    if (method === "assistant.modelStep") {
      assert.deepEqual(input.tools, []);
      summaries++;
      return { text: "Worker a owns the task." };
    }
    throw Error(method);
  };
  const ctx = await modelContext(
    core,
    config,
    4096,
    { seq, value: current },
    () => {},
    () => {},
  );
  assert.ok(summaries);
  assert.ok(ctx.prefix.some((p) => p.includes("worker-a")));
  assert.equal(db.records({ kind: "turn", query: "retain_original_marker" })[0].value.id, first.id);
  assert.equal(db.records({ kind: "memory" }).length, 1);
  const count = summaries;
  await modelContext(
    core,
    config,
    4096,
    { seq, value: current },
    () => {},
    () => {},
  );
  assert.equal(summaries, count);
});
test("an interrupted summary cannot advance the archive watermark", async () => {
  const db = journal(),
    item = finishedTurn("Long archived text ".repeat(500));
  db.save({ id: item.id, kind: "turn", value: item });
  const current = finishedTurn("Next");
  await assert.rejects(
    modelContext(
      async (method, input) => {
        if (method === "assistant.records") return db.records(input);
        if (method === "assistant.modelStep") throw Error("provider unavailable");
        throw Error(method);
      },
      config,
      3000,
      { seq: 3, value: current },
      () => {},
      () => {},
    ),
    /provider unavailable/,
  );
  assert.equal(db.records({ kind: "memory" }).length, 0);
});

test(
  "a queued handoff uses the drafted message, including a literal from a previous exchange",
  { timeout: 10000 },
  async () => {
    const db = journal();
    db.save({ kind: "settings", id: "settings", value: config });
    const command = "npm test -- --grep '浏览器评论'";
    const source = finishedTurn("前".repeat(1200) + command);
    const { seq } = db.save({ kind: "turn", id: source.id, value: source });
    const request = "让他按之前那条命令复测，命令原样保留。";
    const task = "请在当前工作区复测浏览器评论用例，使用以下命令：\n\n" + command;
    const target = {
      id: "s1",
      projectId: "p1",
      project: "Fixture",
      title: "Browser tests",
      status: "running",
      runStatus: "running",
    };
    const deliveries = [];
    const call = (name, args) => ({ call: { name, arguments: args } });
    const decisions = [
      () => call("find_history", { query: command }),
      (result) => call("find_history", { seq: result.items[0].seq }),
      (result) => call("find_history", { seq: result.seq, offset: result.nextOffset }),
      (result) => {
        assert.equal(result.seq, seq);
        assert.equal(result.user, command);
        return call("create_session", {
          projectId: "p1",
          harnessId: "h1",
          connectionId: "c1",
          title: "Browser tests",
        });
      },
      (result) => {
        assert.match(result.error, /Supply task/);
        return call("send_task", { sessionId: target.id, task: "   " });
      },
      (result) => {
        assert.match(result.error, /Supply task/);
        return call("send_task", { sessionId: target.id, task: "a".repeat(16001) });
      },
      (result) => {
        assert.match(result.error, /exceeds/);
        return call("send_task", { sessionId: target.id, task });
      },
      (result) => {
        assert.equal(result.delivery, "queued");
        return { text: "已加入测试会话的队列。" };
      },
    ];
    const finished = Promise.withResolvers();
    const assistant = new WorkspaceAssistant(
      async (method, input) => {
        switch (method) {
          case "assistant.records":
            return db.records(input);
          case "assistant.save": {
            const saved = db.save(input);
            if (input.kind === "turn" && !["running", "queued"].includes(input.value.status))
              finished.resolve(input.value);
            return saved;
          }
          case "connection.list":
            return [{ id: config.connectionId, enabled: true, models: [{ id: config.model }] }];
          case "assistant.modelStep":
            return decisions.shift()(JSON.parse(input.context.at(-1)).observation?.result);
          case "assistant.sessions":
            return { items: [target], next: null };
          case "interaction.list":
            return [];
          case "session.list":
            return [target];
          case "session.followUp":
            deliveries.push(input);
            return {};
          default:
            throw Error("Unexpected call: " + method);
        }
      },
      () => {},
    );
    try {
      await assistant.submit("turn_" + randomUUID(), request);
      const turn = await finished.promise;
      assert.equal(turn.status, "done", turn.reply);
      assert.equal(turn.text, request);
      assert.deepEqual(
        turn.receipts.map((r) => r.task),
        [task],
      );
      assert.deepEqual(
        deliveries.map((d) => [d.sessionId, d.mode, d.text]),
        [[target.id, "queue", task]],
      );
    } finally {
      assistant.close();
    }
  },
);

test(
  "the Rust desktop path routes, deduplicates and reads a worker, and measures the cache on all three wire protocols",
  { skip: !process.env.NAUTILO_NATIVE_CORE, timeout: 85000 },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "nautilo-assistant-integration-"));
    const workerDir = join(dir, "project");
    await mkdir(workerDir);
    const native = join(dir, process.platform === "win32" ? "nautilo-core.exe" : "nautilo-core");
    await copyFile(process.env.NAUTILO_NATIVE_CORE, native);
    const workerLog = join(dir, "worker.log");
    const fake = await readFile(
      resolve(desktop, "../../packages/core-daemon/test/fixtures/fake-codex-pool.cjs"),
      "utf8",
    );
    await writeFile(
      join(workerDir, "app-server"),
      "process.env.CODEX_FAKE_LOG=" + JSON.stringify(workerLog) + ";\n" + fake,
    );
    const calls = [];
    let nextDecision = () => ({ text: "ok" }),
      serverFault;
    const server = createServer(async (req, res) => {
      try {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString());
        calls.push({ url: req.url, body });
        const decision = nextDecision(body);
        const func = decision.call
          ? { name: decision.call.name, arguments: JSON.stringify(decision.call.arguments) }
          : null;
        let response;
        if (req.url.endsWith("/responses"))
          response = {
            output: [
              func
                ? { type: "function_call", ...func }
                : { type: "message", content: [{ type: "output_text", text: decision.text }] },
            ],
            usage: { input_tokens: 120, input_tokens_details: { cached_tokens: 80 } },
          };
        else if (req.url.endsWith("/messages"))
          response = {
            content: [{ type: "text", text: "ok" }],
            usage: { input_tokens: 20, cache_read_input_tokens: 80, cache_creation_input_tokens: 20 },
          };
        else
          response = {
            choices: [{ message: { content: "ok" } }],
            usage: { prompt_tokens: 120, prompt_cache_hit_tokens: 80 },
          };
        if (body.stream) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          const evt = (data) =>
            res.write("data: " + (typeof data === "string" ? data : JSON.stringify(data)) + "\r\n\r\n");
          const first = decision.text?.slice(0, 1) ?? "",
            last = decision.text?.slice(1) ?? "";
          if (req.url.endsWith("/responses")) {
            if (func) {
              evt({
                type: "response.output_item.added",
                output_index: 0,
                item: { type: "function_call", name: func.name },
              });
              evt({ type: "response.function_call_arguments.delta", output_index: 0, delta: func.arguments });
            } else {
              evt({ type: "response.output_text.delta", delta: first });
              await delay(130);
              evt({ type: "response.output_text.delta", delta: last });
            }
            evt({ type: "response.completed", response });
          } else if (req.url.endsWith("/messages")) {
            evt({ type: "message_start", message: { usage: response.usage } });
            evt({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: first } });
            await delay(130);
            evt({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: last } });
            evt({ type: "message_stop" });
          } else {
            evt({ choices: [{ delta: { content: first } }] });
            await delay(130);
            evt({ choices: [{ delta: { content: last }, finish_reason: "stop" }] });
            evt({ choices: [], usage: response.usage });
            evt("[DONE]");
          }
          res.end();
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(response));
      } catch (error) {
        serverFault = error;
        res.writeHead(500);
        res.end(JSON.stringify({ error: { message: String(error) } }));
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => {
      server.closeAllConnections();
      server.close();
    });
    const baseUrl = "http://127.0.0.1:" + server.address().port + "/v1";
    // The native process and its worker inherit only the fixture's home and database paths.
    const fixtureEnv = {
      AGENTHUB_CORE_PATH: native,
      AGENTHUB_NODE_PATH: process.execPath,
      USERPROFILE: dir,
      HOME: dir,
      APPDATA: dir,
      LOCALAPPDATA: dir,
      CODEX_HOME: dir,
      AGENTHUB_DEV_PLUGIN_DIR: join(dir, "empty-plugins"),
    };
    const saved = Object.fromEntries(Object.keys(fixtureEnv).map((k) => [k, process.env[k]]));
    let liveAssistant;
    const wireDeltas = [];
    const client = new CoreDaemonClient((id, text) => {
      wireDeltas.push({ id, text });
      liveAssistant?.receiveText(id, text);
    });
    try {
      Object.assign(process.env, fixtureEnv);
      await client.start(dir);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    t.after(() => client.stop());
    const core = (method, input) => client.request({ method, input });
    for (const protocol of ["responses", "chat", "anthropic"]) {
      const connectionId = protocol === "responses" ? "router" : protocol;
      await core("connection.upsert", {
        connection: {
          id: connectionId,
          name: protocol,
          kind: "api",
          protocol,
          baseUrl,
          enabled: true,
          models: [
            {
              id: config.model,
              contextWindow: 32768,
              reasoningEfforts: ["low", "high"],
              defaultReasoningEffort: "low",
            },
          ],
        },
        apiKey: "local-fixture",
      });
      const probe = await core("assistant.modelStep", {
        connectionId,
        model: config.model,
        instructions: "fixed",
        tools: [],
        context: ["one", "two"],
      });
      assert.equal(probe.inputTokens, 120);
      assert.equal(probe.cacheReadTokens, 80);
      const streamId = randomUUID();
      const streamed = await core("assistant.modelStep", {
        connectionId,
        model: config.model,
        instructions: "fixed",
        context: ["one", "two"],
        tools: [],
        streamId,
        reasoningEffort: "high",
      });
      assert.equal(streamed.text, "ok");
      assert.equal(streamed.cacheReadTokens, 80);
      assert.equal(streamed.inputTokens, 120);
      assert.deepEqual(
        wireDeltas.filter((d) => d.id === streamId).map((d) => d.text),
        ["o", "k"],
      );
      const sent = calls.at(-1).body;
      assert.equal(sent.stream, true);
      assert.equal(
        protocol === "anthropic"
          ? sent.output_config.effort
          : protocol === "responses"
            ? sent.reasoning.effort
            : sent.reasoning_effort,
        "high",
      );
      if (protocol === "anthropic") {
        assert.deepEqual(
          sent.messages[0].content.map((b) => b.text),
          ["one", "two"],
        );
        assert.equal(sent.messages[0].content.at(-1).cache_control.type, "ephemeral");
      } else
        assert.deepEqual(
          (sent.input ?? sent.messages.slice(1)).map((m) => m.content),
          ["one", "two"],
        );
    }
    await core("policy.upsert", {
      id: "policy_1",
      name: "Test",
      defaultCommandAction: "allow",
      commandRules: [],
      environmentAllowlist: [
        "PATH",
        "SystemRoot",
        "WINDIR",
        "ComSpec",
        "PATHEXT",
        "TEMP",
        "TMP",
        "USERPROFILE",
        "APPDATA",
        "LOCALAPPDATA",
      ],
      allowedPaths: [workerDir],
      updatedAt: now,
    });
    await core("project.upsert", {
      id: "project_1",
      name: "Fixture",
      rootPath: workerDir,
      repositoryType: "none",
      workspaceMode: "direct",
      nonGitDiffMode: "off",
      frontendPaths: [],
      backendPaths: [],
      ignoredPaths: [],
      policyId: "policy_1",
    });
    await core("agent.upsert", {
      id: "worker",
      providerId: "codex",
      displayName: "Codex",
      executable: process.execPath,
      baseArgs: [],
      capabilities: [],
      enabled: true,
      status: "available",
      createdAt: now,
      updatedAt: now,
      providerOptions: { configurationKind: "harness" },
    });
    const liveEvents = [];
    const assistant = (liveAssistant = new WorkspaceAssistant(
      core,
      () => {},
      (draft) => liveEvents.push({ ...draft }),
    ));
    t.after(() => assistant.close());
    await assistant.configure(config);
    let target;
    const action = (name, args = {}) => ({ call: { name, arguments: args } });
    async function submit(text, steps) {
      const requests = [];
      let i = 0;
      nextDecision = (body) => {
        requests.push(body);
        const s = steps[i++];
        if (!s) throw Error("Unexpected model step");
        return typeof s === "function" ? s(body) : s;
      };
      const id = "turn_" + randomUUID();
      await assistant.submit(id, text);
      await assistant.submit(id, text);
      let row;
      for (let i = 0; i < 330; i++) {
        const view = await assistant.view();
        row = view.turns.find((r) => r.value.id === id)?.value;
        if (row && !["running", "queued"].includes(row.status)) break;
        await delay(75);
      }
      assert.ifError(serverFault);
      assert.equal(row?.status, "done", row?.reply);
      assert.equal(requests.length, steps.length);
      for (let i = 1; i < requests.length; i++) {
        assert.deepEqual(requests[i].input.slice(0, -1), requests[i - 1].input);
        assert.deepEqual(requests[i].tools, requests[0].tools);
        assert.equal(requests[i].instructions, requests[0].instructions);
      }
      assert.equal(row.usage.cached, steps.length * 80);
      assert.ok(
        liveEvents.some((d) => d.turnId === id && d.text === row.reply.slice(0, 1)),
        "The desktop received partial text before the final reply",
      );
      return row;
    }
    const request = "开个会话评审浏览器的十条验收用例，区分 P0、P1。";
    const review = "评审浏览器的十条验收用例，按 P0 和 P1 整理测试清单。";
    const first = await submit(request, [
      action("list_workspace"),
      action("create_session", {
        projectId: "project_1",
        harnessId: "worker",
        connectionId: "router",
        title: "Fixture task",
        task: review,
      }),
      { text: "Assigned." },
    ]);
    assert.equal(first.receipts.length, 1);
    const receipt = first.receipts[0];
    assert.equal(receipt.delivery, "sent", receipt.error);
    assert.equal(first.text, request);
    assert.equal(receipt.task, review);
    target = receipt.sessionId;
    async function workerDone(runId) {
      let run;
      for (let i = 0; i < 180; i++) {
        run = await core("run.get", { runId });
        if (["completed", "failed", "crashed", "cancelled", "timed_out"].includes(run.status)) break;
        await delay(80);
      }
      assert.equal(run?.status, "completed", JSON.stringify(run).slice(-650));
    }
    await workerDone(receipt.runId);
    const rows = await core("assistant.sessions", {});
    assert.equal(rows.items.find((r) => r.id === target)?.preview, null);
    const read = await core("assistant.excerpts", { sessionId: target, messageId: receipt.messageId });
    assert.equal(read.items[0].text, review);
    const followUp = "再让他测试把";
    const retest = "请按刚才评审出的浏览器验收清单复测这十条用例，按 P0、P1 记录结果。";
    const next = await submit(followUp, [
      action("list_sessions", { sessionId: target }),
      action("read_session", { sessionId: target, messageId: receipt.messageId }),
      (body) => {
        const { observation } = JSON.parse(body.input.at(-1).content);
        assert.equal(observation.result.items[0].text, review);
        for (const name of ["send_task", "create_session"])
          assert.ok(body.tools.find((tool) => tool.name === name).parameters.required.includes("task"));
        return action("send_task", { sessionId: target, task: retest });
      },
      action("send_task", { sessionId: target, task: retest }),
      { text: "Sent." },
    ]);
    assert.equal(next.receipts.length, 1);
    assert.equal(next.receipts[0].sessionId, target);
    assert.equal(next.text, followUp);
    assert.equal(next.receipts[0].task, retest);
    await workerDone(next.receipts[0].runId);
    const detail = await core("session.get", { sessionId: target });
    assert.deepEqual(
      detail.messages.filter((m) => m.sender === "user").map((m) => m.text),
      [review, retest],
    );
    const restored = new WorkspaceAssistant(core, () => {});
    const view = await restored.view();
    assert.equal(view.settings.model, config.model);
    assert.equal(view.turns.length, 2);
    restored.close();
  },
);
