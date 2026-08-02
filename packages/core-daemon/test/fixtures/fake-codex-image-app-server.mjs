// Minimal line-delimited JSON-RPC stand-in that asks the host to execute the
// image_gen dynamic tool, then completes the turn after receiving the result.
const readline = require("node:readline");
const fs = require("node:fs");

const logPath = process.env.CODEX_FAKE_LOG;
const log = (message) => {
  if (logPath) fs.appendFileSync(logPath, `${JSON.stringify(message)}\n`);
};
const send = (message) => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

readline.createInterface({ input: process.stdin, terminal: false }).on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  log(message);

  if (message.id !== undefined && typeof message.method !== "string") {
    if (message.id === "image-call-1") {
      send({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-image", turnId: "turn-image" } });
    }
    return;
  }
  if (message.id === undefined || typeof message.method !== "string") return;
  if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: {} });
  if (message.method === "thread/start") {
    return send({ jsonrpc: "2.0", id: message.id, result: { thread: { id: "thread-image" } } });
  }
  if (message.method === "turn/start") {
    send({ jsonrpc: "2.0", id: message.id, result: { turn: { id: "turn-image" } } });
    return send({
      jsonrpc: "2.0",
      id: "image-call-1",
      method: "item/tool/call",
      params: {
        threadId: "thread-image",
        turnId: "turn-image",
        callId: "call-image-1",
        tool: "image_gen",
        arguments: { prompt: "A small blue square", filename: "e2e-blue-square" }
      }
    });
  }
  send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `unexpected method ${message.method}` } });
});
