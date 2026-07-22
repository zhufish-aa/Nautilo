import test from "node:test";
import assert from "node:assert/strict";
import { connect } from "node:net";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CoreDaemon } from "../dist/index.js";

test("gateway only serves authenticated, registered methods", async () => {
  const daemon = new CoreDaemon({ databasePath: ":memory:" });
  const { port, token } = await daemon.gateway.startTcp(0);
  const socket = connect(port, "127.0.0.1");
  socket.setEncoding("utf8");
  const lines = [];
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk;
    const parts = buffer.split("\n");
    buffer = parts.pop() ?? "";
    for (const line of parts) if (line) lines.push(JSON.parse(line));
  });
  await new Promise((resolve) => socket.once("connect", resolve));
  socket.write(`${JSON.stringify({ token })}\n`);
  await waitFor(() => lines.length === 1);
  socket.write(`${JSON.stringify({ request: { requestId: "health", method: "health.get" } })}\n`);
  await waitFor(() => lines.length === 2);
  assert.equal(lines[0].data.authenticated, true);
  assert.equal(lines[1].data.status, "ok");
  socket.end();
  await daemon.stop();
});

test("gateway supports an authenticated local socket", async () => {
  const daemon = new CoreDaemon({ databasePath: ":memory:" });
  const socketPath = process.platform === "win32" ? `\\\\.\\pipe\\agenthub-test-${randomUUID()}` : join(tmpdir(), `agenthub-test-${randomUUID()}.sock`);
  const started = await daemon.gateway.startSocket(socketPath);
  const socket = connect(socketPath);
  socket.setEncoding("utf8");
  const lines = [];
  let buffer = "";
  socket.on("data", (chunk) => { buffer += chunk; const parts = buffer.split("\n"); buffer = parts.pop() ?? ""; for (const line of parts) if (line) lines.push(JSON.parse(line)); });
  await new Promise((resolve) => socket.once("connect", resolve));
  socket.write(`${JSON.stringify({ token: started.token })}\n`);
  await waitFor(() => lines.length === 1);
  assert.equal(lines[0].data.authenticated, true);
  socket.end();
  await daemon.stop();
});

async function waitFor(predicate) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
