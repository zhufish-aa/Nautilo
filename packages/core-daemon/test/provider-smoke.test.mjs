import test from "node:test";
import assert from "node:assert/strict";
import { AdapterRegistry } from "../dist/index.js";

const enabled = process.env.AGENTHUB_PROVIDER_SMOKE === "1";
const now = new Date().toISOString();

function instance(providerId, executable, baseArgs = [], model) {
  return {
    id: `${providerId}-smoke`,
    providerId,
    displayName: `${providerId} smoke`,
    executable,
    baseArgs,
    model,
    capabilities: [],
    enabled: true,
    status: "available",
    createdAt: now,
    updatedAt: now
  };
}

async function collect(run) {
  const events = [];
  for await (const event of run.events) events.push(event);
  return events;
}

test("real Codex CLI emits a resumable structured run", { skip: !enabled }, async () => {
  const model = process.env.AGENTHUB_CODEX_SMOKE_MODEL;
  const configured = instance("codex", process.env.AGENTHUB_CODEX_EXECUTABLE ?? "codex", [], model);
  const events = await collect(new AdapterRegistry().start({
    instance: configured,
    prompt: "Reply with exactly CODEX_ADAPTER_SMOKE_OK. Do not use tools.",
    cwd: process.cwd(),
    timeoutMs: 120_000
  }));
  assert.ok(events.some((event) => event.kind === "session"));
  assert.ok(events.some((event) => event.kind === "message" && event.phase === "delta"));
  assert.ok(events.some((event) => event.kind === "message" && event.text === "CODEX_ADAPTER_SMOKE_OK"));
  assert.ok(events.some((event) => event.kind === "usage"));
  assert.equal(events.at(-1)?.kind, "exit");
});

test("real Kimi Code CLI emits a resumable structured run", { skip: !enabled }, async () => {
  const configured = instance("kimi-code", process.env.AGENTHUB_KIMI_EXECUTABLE ?? "kimi", [], process.env.AGENTHUB_KIMI_SMOKE_MODEL);
  const events = await collect(new AdapterRegistry().start({
    instance: configured,
    prompt: "Reply with exactly KIMI_ADAPTER_SMOKE_OK. Do not use tools.",
    cwd: process.cwd(),
    timeoutMs: 120_000
  }));
  assert.ok(events.some((event) => event.kind === "session"));
  assert.ok(events.some((event) => event.kind === "message" && event.phase === "delta"));
  assert.ok(events.some((event) => event.kind === "message" && event.text === "KIMI_ADAPTER_SMOKE_OK"));
  assert.equal(events.at(-1)?.kind, "exit");
});

test("real Codex and Kimi CLIs expose their effective model catalogs", { skip: !enabled }, async () => {
  const registry = new AdapterRegistry();
  const codex = await registry.listModels(instance("codex", process.env.AGENTHUB_CODEX_EXECUTABLE ?? "codex"));
  assert.ok(codex.models.length > 0);
  assert.ok(codex.models.every((model) => model.id && model.displayName));

  const kimi = await registry.listModels(instance("kimi-code", process.env.AGENTHUB_KIMI_EXECUTABLE ?? "kimi"));
  assert.ok(kimi.models.length > 0);
  assert.ok(kimi.models.every((model) => model.id.includes("/")));
});
