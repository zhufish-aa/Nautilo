import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { McpBridgeServer, TraeAgentBridge, normalizeToolName, printable } from "../server.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));

test("printable unwraps MCP content", () => {
  assert.equal(printable({ content: [{ type: "text", text: "exact" }] }), "exact");
  assert.equal(normalizeToolName("Reading file"), "reading_file");
});

test("MCP initialize and tools/list advertise explicit success semantics", async () => {
  const server = new McpBridgeServer({ enqueue: (task) => task() });
  const initialized = await server.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  assert.equal(initialized.result.serverInfo.name, "trae-agent-files");
  const listed = await server.handle({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), ["read_file", "edit_file", "edit_by_instruction", "status"]);
});

test("read and edit run through one stateful ACP agent session", async () => {
  process.env.TRAE_CLI_PATH = process.execPath;
  process.env.TRAE_CLI_PREFIX_ARGS_JSON = JSON.stringify([resolve(here, "fake-trae-acp.mjs")]);
  process.env.TRAE_BRIDGE_TIMEOUT_MS = "5000";
  const bridge = new TraeAgentBridge();
  const server = new McpBridgeServer(bridge);
  const target = resolve(here, "encrypted-example.txt");

  try {
    const read = await server.handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "read_file", arguments: { file_path: target } } });
    assert.equal(read.result.isError, false);
    assert.equal(read.result.structuredContent.content, "before\n");

    const edit = await server.handle({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "edit_file", arguments: { file_path: target, old_string: "before", new_string: "after" } } });
    assert.equal(edit.result.isError, false);
    assert.equal(edit.result.structuredContent.edited, true);
    assert.equal(edit.result.structuredContent.verified, true);
    assert.equal(edit.result.structuredContent.sessionId, read.result.structuredContent.sessionId);
  } finally {
    bridge.close();
  }
});
