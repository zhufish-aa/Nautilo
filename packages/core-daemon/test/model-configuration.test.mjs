import test from "node:test";
import assert from "node:assert/strict";
import { mergeInstanceModelConfig, configuredModelReasoningEffort } from "../dist/adapters/model-config.js";
import { AdapterRegistry, Database, EventService, RunService } from "../dist/index.js";

const catalog = {
  providerId: "fake", defaultModel: "upstream-a", source: "provider_cli", fetchedAt: "now",
  models: [
    { id: "upstream-a", displayName: "A", isDefault: true, reasoningEfforts: ["low", "high"], defaultReasoningEffort: "high", capabilities: [], serviceTiers: [] },
    { id: "upstream-b", displayName: "B", isDefault: false, reasoningEfforts: [], capabilities: [], serviceTiers: [] }
  ]
};

test("model metadata preserves upstream IDs and prices, excludes disabled default", () => {
  const result = mergeInstanceModelConfig(catalog, [
    { id: "upstream-a", enabled: false, reasoningEfforts: [] },
    { id: "upstream-b", displayName: "Friendly B", reasoningEfforts: ["low", "high"], defaultReasoningEffort: "high", pricing: { input: 0, output: 2.5 } }
  ]);
  assert.equal(result.defaultModel, "upstream-b");
  assert.deepEqual(result.models.map((model) => model.id), ["upstream-b"]);
  assert.equal(result.models[0].displayName, "Friendly B");
  assert.equal(result.models[0].defaultReasoningEffort, "high");
  assert.deepEqual(result.models[0].pricing, { input: 0, output: 2.5 });
  assert.equal(result.models[0].pricing.cacheRead, undefined);
  assert.equal(catalog.models.length, 2);
  assert.equal(mergeInstanceModelConfig(catalog, [{ id: "upstream-a", enabled: false }, { id: "upstream-b", enabled: false }]).defaultModel, undefined);
});

test("ordered legacy defaults survive and invalid explicit defaults never escape", () => {
  assert.equal(configuredModelReasoningEffort({ reasoningEfforts: ["medium", "high"] }), "medium");
  assert.equal(configuredModelReasoningEffort({ reasoningEfforts: ["medium"], defaultReasoningEffort: "invalid" }), "medium");
  assert.equal(configuredModelReasoningEffort({ reasoningEfforts: [], defaultReasoningEffort: "custom" }), "custom");
  assert.equal(configuredModelReasoningEffort({ enabled: false, reasoningEfforts: ["high"] }), undefined);
  const result = mergeInstanceModelConfig(catalog, [{ id: "upstream-a", reasoningEfforts: ["medium"] }]);
  assert.equal(result.models[0].defaultReasoningEffort, "medium");
  assert.equal(result.models[0].pricing, undefined);
});

test("runtime uses model default, honors session override and refuses disabled selection", async () => {
  const now = new Date().toISOString();
  const database = new Database(":memory:");
  const requests = [];
  const adapter = {
    providerId: "fake", supportsStructuredOutput: true, supportsResume: false,
    capabilities: { structuredOutput: true, textOutput: true, interactiveStdin: false, nativeResume: false, pty: false },
    detect: async () => ({ installed: true, executable: "fake" }),
    start(request) {
      requests.push(request);
      return { events: (async function* () { yield { kind: "exit", exitCode: 0 }; })(), cancel: async () => {}, process: {}, write() {} };
    }
  };
  const service = new RunService(database, new AdapterRegistry([adapter]), new EventService(database));
  const session = { id: "s", projectId: "p", memberId: "a", agentInstanceId: "a", model: "upstream-a", title: "S", status: "idle", unreadCount: 0, createdAt: now, updatedAt: now };
  const agent = { id: "a", providerId: "fake", displayName: "A", executable: "fake", baseArgs: [], capabilities: [], enabled: true, status: "available", createdAt: now, updatedAt: now, models: [{ id: "upstream-a", displayName: "Friendly", reasoningEfforts: ["low", "high"], defaultReasoningEffort: "high" }] };
  database.projects.save({ id: "p", name: "P", rootPath: process.cwd(), repositoryType: "git", nonGitDiffMode: "off", frontendPaths: [], backendPaths: [], ignoredPaths: [], policyId: "default" }, now);
  database.sessions.save(session);
  try {
    await (await service.launch(session, agent, "default")).completion;
    database.sessions.save({ ...database.sessions.get(session.id), reasoningEffort: "low" });
    await (await service.launch(session, agent, "override")).completion;
    assert.deepEqual(requests.map(({ model, reasoningEffort }) => ({ model, reasoningEffort })), [
      { model: "upstream-a", reasoningEffort: "high" }, { model: "upstream-a", reasoningEffort: "low" }
    ]);
    agent.models[0].enabled = false;
    await assert.rejects(service.launch(session, agent, "disabled"), (error) => error.descriptor?.code === "IPC_INVALID_REQUEST");
    assert.equal(requests.length, 2);
  } finally { database.close(); }
});
