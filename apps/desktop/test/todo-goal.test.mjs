import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const sourceUrl = new URL("../src/renderer/src/lib/todo-goal.ts", import.meta.url);

async function loadTodoGoal() {
  const source = await readFile(sourceUrl, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022
    }
  }).outputText;
  return import(`data:text/javascript;charset=utf-8,${encodeURIComponent(transpiled)}`);
}

function toolEvent(id, toolName, input, status = "done") {
  return { id, sessionId: "s1", timestamp: id, data: { kind: "tool_activity", toolName, status, input } };
}

test("extracts todos from a Kimi TodoList call", async () => {
  const { extractTodoItems } = await loadTodoGoal();
  const items = extractTodoItems(JSON.stringify({
    todos: [
      { status: "done", title: "调研现状" },
      { status: "in_progress", title: "实现桥接" },
      { status: "pending", title: "测试验证" }
    ]
  }));
  assert.deepEqual(items, [
    { title: "调研现状", status: "done" },
    { title: "实现桥接", status: "in_progress" },
    { title: "测试验证", status: "pending" }
  ]);
});

test("accepts Claude TodoWrite and Codex update_plan field naming", async () => {
  const { extractTodoItems } = await loadTodoGoal();
  assert.deepEqual(
    extractTodoItems(JSON.stringify({ todos: [{ content: "Write tests", status: "completed" }] })),
    [{ title: "Write tests", status: "done" }]
  );
  assert.deepEqual(
    extractTodoItems(JSON.stringify({ plan: [{ step: "Ship it", status: "in_progress" }] })),
    [{ title: "Ship it", status: "in_progress" }]
  );
});

test("returns undefined for truncated or unrecognized input", async () => {
  const { extractTodoItems } = await loadTodoGoal();
  assert.equal(extractTodoItems(undefined), undefined);
  assert.equal(extractTodoItems(""), undefined);
  assert.equal(extractTodoItems('{"todos": [{"status": "done", "tit'), undefined);
  assert.equal(extractTodoItems('{"path": "src/index.ts"}'), undefined);
  assert.equal(extractTodoItems('{"todos": []}'), undefined);
});

test("latestTodoGoal picks the most recent call, including inside tool groups", async () => {
  const { latestTodoGoal } = await loadTodoGoal();
  const older = toolEvent("e1", "TodoList", JSON.stringify({ todos: [{ title: "old", status: "pending" }] }));
  const unrelated = toolEvent("e2", "Read", JSON.stringify({ path: "a.ts" }));
  const newer = toolEvent("e3", "TodoList", JSON.stringify({ todos: [{ title: "new", status: "done" }] }));
  const group = {
    id: "g1",
    sessionId: "s1",
    timestamp: "g1",
    data: { kind: "tool_group", items: [unrelated, newer], stepCount: 2, callCount: 2, running: false }
  };

  assert.deepEqual(latestTodoGoal([older, group]), [{ title: "new", status: "done" }]);
  assert.deepEqual(latestTodoGoal([older, unrelated]), [{ title: "old", status: "pending" }]);
  assert.equal(latestTodoGoal([unrelated]), undefined);
  assert.equal(latestTodoGoal([]), undefined);
});

test("recognizes provider tool names in their original casing", async () => {
  const { latestTodoGoal } = await loadTodoGoal();
  const input = JSON.stringify({ todos: [{ content: "task", status: "in_progress" }] });
  for (const toolName of ["TodoList", "TodoWrite", "todo_write", "update_plan"]) {
    assert.deepEqual(
      latestTodoGoal([toolEvent("e1", toolName, input)]),
      [{ title: "task", status: "in_progress" }],
      toolName
    );
  }
});
