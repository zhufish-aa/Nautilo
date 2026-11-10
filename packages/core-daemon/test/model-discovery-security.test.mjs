import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { discoverOpenAiCompatibleModels } from "../dist/adapters/model-config.js";
async function server(handler) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  return { server, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }) };
}
for (const [apiType, header, expected] of [["anthropic-messages", "x-api-key", "fixture-key"], ["google-generative-ai", "x-goog-api-key", "fixture-key"], [undefined, "authorization", "Bearer fixture-key"]]) {
  test(`model discovery does not forward ${header} across redirects`, async () => {
    const received = [];
    const target = await server((request, response) => { received.push(request.headers); response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ data: [{ id: "must-not-discover" }] })); });
    const source = await server((_request, response) => { response.writeHead(307, { location: `${target.url}/models` }); response.end(); });
    try { await assert.rejects(discoverOpenAiCompatibleModels(source.url, "fixture-key", 1000, apiType)); assert.equal(received.length, 0); }
    finally { await Promise.all([source.close(), target.close()]); }
  });
  test(`model discovery still authenticates only at configured endpoint with ${header}`, async () => {
    const received = [];
    const source = await server((request, response) => { received.push(request.headers[header]); response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ data: [{ id: "allowed-model" }] })); });
    try { const catalog = await discoverOpenAiCompatibleModels(source.url, "fixture-key", 1000, apiType); assert.equal(catalog.models[0].id, "allowed-model"); assert.deepEqual(received, [expected]); }
    finally { await source.close(); }
  });
}
test("model discovery rejects same-origin redirects as well", async () => {
  let targetRequests = 0;
  const source = await server((request, response) => {
    if (request.url === "/redirect-target") { targetRequests++; response.end(JSON.stringify({ data: [{ id: "forbidden" }] })); }
    else { response.writeHead(302, { location: "/redirect-target" }); response.end(); }
  });
  try { await assert.rejects(discoverOpenAiCompatibleModels(source.url, "fixture-key", 1000, "anthropic-messages")); assert.equal(targetRequests, 0); }
  finally { await source.close(); }
});
test("unsafe endpoint URLs fail before requests and never echo embedded secrets", async () => {
  for (const endpoint of ["http://localhost", "http://example.com", "https://fixture-user:fixture-secret@example.com", "https://example.com?token=fixture-secret", "https://example.com#fixture-secret", "https://example.com?", "https://example.com#", "not-a-url"]) {
    await assert.rejects(discoverOpenAiCompatibleModels(endpoint, "fixture-key", 100), (error) => { assert.doesNotMatch(error.message, /fixture-secret/); return true; });
  }
});

const { discoverClaudeModels } = await import("../dist/adapters/claude/models.js");
const { discoverCodexModelsViaApi } = await import("../dist/adapters/codex/models.js");
for (const provider of ["claude", "codex"]) {
  test(`${provider} native discovery blocks redirects before any target request`, async () => {
    let leakedRequests = 0;
    const target = await server((_request, response) => { leakedRequests++; response.end(JSON.stringify({ data: [{ id: "forbidden" }] })); });
    const source = await server((_request, response) => { response.writeHead(302, { location: `${target.url}/models` }); response.end(); });
    try {
      if (provider === "claude") {
        const result = await discoverClaudeModels({ ANTHROPIC_BASE_URL: source.url, ANTHROPIC_API_KEY: "fixture-key", ANTHROPIC_AUTH_TOKEN: "fixture-token" });
        assert(result.warning); assert(!result.models.some((model) => model.id === "forbidden"));
      } else await assert.rejects(discoverCodexModelsViaApi({ providerOptions: { baseUrl: source.url } }, { OPENAI_API_KEY: "fixture-key" }));
      assert.equal(leakedRequests, 0);
    } finally { await Promise.all([source.close(), target.close()]); }
  });
  test(`${provider} native discovery rejects unsafe endpoint URLs without secret echo`, async () => {
    for (const endpoint of ["http://localhost", "http://example.com", "https://user:fixture-secret@example.com", "https://example.com?key=fixture-secret", "https://example.com#fixture-secret", "not-a-url-fixture-secret"]) {
      if (provider === "claude") {
        const result = await discoverClaudeModels({ ANTHROPIC_BASE_URL: endpoint, ANTHROPIC_API_KEY: "fixture-key" });
        assert(result.warning); assert.doesNotMatch(result.warning, /fixture-secret/);
      } else await assert.rejects(discoverCodexModelsViaApi({ providerOptions: { baseUrl: endpoint } }, { OPENAI_API_KEY: "fixture-key" }), (error) => { assert.doesNotMatch(error.message, /fixture-secret/); return true; });
    }
  });
}
test("Claude native pagination encodes provider cursor without changing request origin or query scope", async () => {
  const paths = [];
  const source = await server((request, response) => {
    paths.push(request.url); response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ data: [{ id: `model-${paths.length}` }], has_more: paths.length === 1, last_id: "cursor&api_key=injected#part" }));
  });
  try { const result = await discoverClaudeModels({ ANTHROPIC_BASE_URL: source.url, ANTHROPIC_API_KEY: "fixture-key" }); assert.equal(result.warning, undefined); assert.equal(paths.length, 2); const second = new URL(paths[1], source.url); assert.equal(second.searchParams.get("after_id"), "cursor&api_key=injected#part"); assert.equal(second.searchParams.get("api_key"), null); }
  finally { await source.close(); }
});
