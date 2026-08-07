import { createInterface } from "node:readline";

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
let session = 0;

for await (const line of input) {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
  } else if (message.method === "session/new") {
    session += 1;
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: `fake-session-${session}` } });
  } else if (message.method === "session/prompt") {
    const sessionId = message.params.sessionId;
    const prompt = message.params.prompt[0].text;
    const target = JSON.parse(prompt.match(/Target file: (".*")/)[1]);
    const read = (id, text) => {
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "tool_call", toolCallId: id, title: "Read", status: "in_progress", rawInput: { file_path: target } } } });
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "tool_call_update", toolCallId: id, title: "Read", status: "completed", rawOutput: { content: [{ type: "text", text }] } } } });
    };
    read("read-1", "before\n");
    if (prompt.includes("Exact old text:") || prompt.includes("Requested change:")) {
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "tool_call", toolCallId: "edit-1", title: "Edit", status: "completed", rawInput: { file_path: target }, rawOutput: { content: [{ type: "text", text: "edited" }] } } } });
      read("read-2", "after\n");
    }
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "完成" } } } });
    send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
  }
}
