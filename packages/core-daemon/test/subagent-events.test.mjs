import test from "node:test";
import assert from "node:assert/strict";
import { parseClaudeJsonEvent, parseCodexAppServerNotification } from "../dist/index.js";

test("claude sub-agent activity is tagged with parent_tool_use_id", () => {
  const dispatch = parseClaudeJsonEvent({
    type: "assistant",
    parent_tool_use_id: null,
    message: { id: "msg-1", content: [{ type: "tool_use", id: "toolu-1", name: "Agent", input: { description: "调研", prompt: "看看", subagent_type: "Explore" } }] }
  });
  assert.equal(dispatch[0].kind, "tool");
  assert.equal(dispatch[0].subagentDispatchId, undefined);

  const child = parseClaudeJsonEvent({
    type: "assistant",
    parent_tool_use_id: "toolu-1",
    message: { id: "msg-2", content: [{ type: "text", text: "子 agent 在干活" }] }
  });
  assert.equal(child[0].kind, "message");
  assert.equal(child[0].subagentDispatchId, "toolu-1");

  const childTool = parseClaudeJsonEvent({
    type: "assistant",
    parent_tool_use_id: "toolu-1",
    message: { id: "msg-3", content: [{ type: "tool_use", id: "toolu-2", name: "Read", input: { file_path: "/a.ts" } }] }
  });
  assert.equal(childTool[0].subagentDispatchId, "toolu-1");

  const childResult = parseClaudeJsonEvent({
    type: "user",
    parent_tool_use_id: "toolu-1",
    message: { content: [{ type: "tool_result", tool_use_id: "toolu-2", content: "file text" }] }
  });
  assert.equal(childResult[0].subagentDispatchId, "toolu-1");
});

test("codex collabAgentToolCall becomes a sub-agent dispatch tool event", () => {
  const [started] = parseCodexAppServerNotification("item/started", {
    threadId: "thread-main",
    item: {
      type: "collabAgentToolCall",
      id: "collab-1",
      tool: "spawnAgent",
      status: "inProgress",
      senderThreadId: "thread-main",
      receiverThreadIds: ["thread-child"],
      prompt: "去验证登录流程",
      model: "gpt-5",
      agentsStates: {}
    }
  });
  assert.equal(started.kind, "tool");
  assert.equal(started.callId, "collab-1");
  assert.equal(started.name, "spawnAgent");
  assert.equal(started.phase, "started");
  assert.equal(started.input.prompt, "去验证登录流程");

  const [completed] = parseCodexAppServerNotification("item/completed", {
    threadId: "thread-main",
    item: {
      type: "collabAgentToolCall",
      id: "collab-1",
      tool: "spawnAgent",
      status: "completed",
      senderThreadId: "thread-main",
      receiverThreadIds: ["thread-child"],
      agentsStates: { "thread-child": { status: "completed", message: "done" } }
    }
  });
  assert.equal(completed.phase, "completed");
  assert.equal(completed.success, true);
  assert.match(completed.output, /thread-child: completed — done/);
});
