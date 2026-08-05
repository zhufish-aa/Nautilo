import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  AdapterRegistry,
  AgentService,
  Database,
  EnvironmentPolicyService
} from "../dist/index.js";

test("Pi quick fetch honors unsaved Anthropic API settings and never falls back to CLI", async (t) => {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ url: request.url, headers: request.headers });
    response.setHeader("content-type", "application/json");
    if (request.url === "/coding/v1/models") {
      response.end(JSON.stringify({ data: [{ id: "kimi-k3", display_name: "Kimi K3" }] }));
      return;
    }
    response.statusCode = request.url?.startsWith("/broken") ? 401 : 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");

  let cliDiscoveryCalls = 0;
  const adapter = {
    providerId: "pi",
    descriptor: {
      providerId: "pi",
      name: "Pi",
      vendor: "Pi",
      capabilities: [],
      defaultExecutable: "pi",
      credentialEnv: ["AGENTHUB_PI_API_KEY"]
    },
    capabilities: { structuredOutput: true, pty: false },
    async detect() { return { installed: true, executable: "pi" }; },
    async listModels() {
      cliDiscoveryCalls += 1;
      return {
        providerId: "pi",
        source: "provider_cli",
        fetchedAt: new Date().toISOString(),
        models: [{ id: "cli-model", displayName: "CLI Model", reasoningEfforts: [], capabilities: [], serviceTiers: [] }]
      };
    }
  };
  const database = new Database(":memory:");
  t.after(() => database.close());
  const now = new Date().toISOString();
  database.agents.save({
    id: "pi-instance",
    providerId: "pi",
    displayName: "Pi",
    executable: "pi",
    baseArgs: [],
    capabilities: [],
    enabled: true,
    status: "available",
    createdAt: now,
    updatedAt: now
  }, now);
  const service = new AgentService(database, new AdapterRegistry([adapter]), undefined, new EnvironmentPolicyService());

  const catalog = await service.listModels("pi", "pi", "pi-instance", {
    baseUrl: `http://127.0.0.1:${address.port}/coding`,
    apiKey: "secret-key",
    apiType: "anthropic-messages"
  });
  assert.equal(catalog.source, "provider_api");
  assert.deepEqual(catalog.models.map((model) => model.id), ["kimi-k3"]);
  assert.equal(cliDiscoveryCalls, 0);
  assert.deepEqual(requests.map((request) => request.url), ["/coding/models", "/coding/v1/models"]);
  assert.equal(requests[1].headers["x-api-key"], "secret-key");
  assert.equal(requests[1].headers["anthropic-version"], "2023-06-01");
  assert.equal(requests[1].headers.authorization, undefined);

  const failed = await service.listModels("pi", "pi", "pi-instance", {
    baseUrl: `http://127.0.0.1:${address.port}/broken/v1`,
    apiKey: "secret-key",
    apiType: "anthropic-messages"
  });
  assert.equal(failed.source, "unavailable");
  assert.equal(failed.models.length, 0);
  assert.match(failed.warning ?? "", /failed \(401\)/);
  assert.equal(cliDiscoveryCalls, 0);
});
