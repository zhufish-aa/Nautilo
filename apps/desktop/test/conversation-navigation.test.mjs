import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const source = await readFile(new URL("../src/renderer/src/lib/conversation-navigation.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const { conversationLocations, locationAtRow } = await import(`data:text/javascript,${encodeURIComponent(compiled)}`);
const message = (id, sender, text, time = "2026-11-16T12:00:00Z") => ({ id, timestamp: time, data: { kind: "message", messageId: `message-${id}`, sender, text } });

test("navigation follows displayed order, including steering messages, rather than grouping by run or timestamp", () => {
  const events = [message("q1", "user", "First"), message("a1", "agent", "Before steering"),
    message("q2", "user", "Steer now", "2026-11-16T11:59:59Z"), message("a2", "agent", "After steering")];
  const locations = conversationLocations(events, [{ key: "q1" }, { key: "turn-q1" }, { key: "q2" }, { key: "turn-q2" }]);
  assert.deepEqual(locations.map(item => [item.rowIndex, item.title, item.preview]), [[0, "First", "Before steering"], [2, "Steer now", "After steering"]]);
  assert.equal(locationAtRow(locations, 1), 0);
  assert.equal(locationAtRow(locations, 2), 1);
  assert.equal(locationAtRow(locations, 300), 1);
});

test("hidden queued messages and tool activity do not create stray markers or attach replies to an earlier question", () => {
  const events = [message("q1", "user", "Visible"), message("a1", "agent", "Visible answer"),
    { id: "tool", data: { kind: "tool_activity", output: "Internal output" } },
    message("q2", "user", "Not yet displayed"), message("a2", "agent", "Not displayed answer")];
  assert.deepEqual(conversationLocations(events, [{ key: "q1" }, { key: "turn-q1" }]).map(item => item.preview), ["Visible answer"]);
});

test("a long virtual conversation retains real row indexes and bounded previews", () => {
  const events = Array.from({ length: 300 }, (_, index) => [message(`q${index}`, "user", `Question ${index}`), message(`a${index}`, "agent", "answer ".repeat(200))]).flat();
  const rows = events.map(item => ({ key: item.id }));
  const locations = conversationLocations(events, rows);
  assert.equal(locations.length, 300);
  assert.equal(locations[250].rowIndex, 500);
  assert.equal(locations[250].preview.length, 160);
  assert.equal(locationAtRow(locations, 501), 250);
  events.at(-1).data.text += "another token";
  assert.equal(conversationLocations(events, rows, locations), locations, "tokens beyond the excerpt do not rerender the entire rail");
});

test("attachment-only questions have a usable label and navigation state handles an empty conversation", () => {
  const event = message("q", "user", "");
  event.data.attachments = [{ name: "设计稿.png" }];
  assert.equal(conversationLocations([event], [{ key: "q" }])[0].title, "设计稿.png");
  assert.deepEqual(conversationLocations([], []), []);
  assert.equal(locationAtRow([], 3), 0);
});
