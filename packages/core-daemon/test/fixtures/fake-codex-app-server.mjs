// Minimal line-delimited JSON-RPC stand-in for `codex app-server --stdio`.
// Logs every received method (one per line) to CODEX_FAKE_LOG so tests can
// assert the exact RPC sequence the adapter drove.
const readline = require("node:readline");
const fs = require("node:fs");

const logPath = process.env.CODEX_FAKE_LOG;
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

readline.createInterface({ input: process.stdin, terminal: false }).on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (logPath && typeof message.method === "string") fs.appendFileSync(logPath, `${message.method}\n`);
  if (message.id === undefined || typeof message.method !== "string") return;
  if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: {} });
  if (message.method === "thread/resume") return send({ jsonrpc: "2.0", id: message.id, result: { thread: { id: "thread-123" } } });
  if (message.method === "thread/compact/start") {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
    return send({ jsonrpc: "2.0", method: "thread/compacted", params: { threadId: "thread-123" } });
  }
  return send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `unexpected method ${message.method}` } });
});
