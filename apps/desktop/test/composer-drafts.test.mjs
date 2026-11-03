import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const source = await readFile(new URL("../src/renderer/src/stores/composer-drafts.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
  .replace('from "zustand"', `from ${JSON.stringify(import.meta.resolve("zustand"))}`);
const { useComposerDraftsStore: store } = await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(compiled)}`);

test.beforeEach(() => store.setState({ drafts: {} }));

test("independent conversations and Code/Work landing drafts survive consumers leaving", () => {
  const firstConsumer = store.getState();
  firstConsumer.setText("session-a", "Unsent task");
  firstConsumer.setText("session-b", "Other work");
  firstConsumer.setText("new:code", "Build a feature");
  firstConsumer.setText("new:work", "Prepare a report");
  const nextConsumer = store.getState();
  assert.equal(nextConsumer.drafts["session-a"].text, "Unsent task");
  assert.equal(nextConsumer.drafts["session-b"].text, "Other work");
  assert.equal(nextConsumer.drafts["new:code"].text, "Build a feature");
  assert.equal(nextConsumer.drafts["new:work"].text, "Prepare a report");
});

test("late attachment completion stays with its originating conversation", () => {
  const file = { path: "/project/design.png", name: "design.png", kind: "image", sizeBytes: 4 };
  store.getState().setText("a", "Review");
  store.getState().setText("b", "Current conversation");
  store.getState().setAttachments("a", (current) => [...current, file]);
  assert.deepEqual(store.getState().drafts.a.attachments, [file]);
  assert.deepEqual(store.getState().drafts.b.attachments, []);
});

test("sending clears only its own draft and empty entries are pruned", () => {
  store.getState().setText("a", "Send me");
  store.getState().setText("b", "Keep me");
  store.getState().clear("a");
  assert.equal(store.getState().drafts.a, undefined);
  assert.equal(store.getState().drafts.b.text, "Keep me");
  store.getState().setText("b", "");
  assert.deepEqual(store.getState().drafts, {});
});

test("clearing text does not silently discard attached files", () => {
  const file = { path: "/file.txt", name: "file.txt", kind: "file", sizeBytes: 4 };
  store.getState().setAttachments("a", [file]);
  store.getState().setText("a", "");
  assert.deepEqual(store.getState().drafts.a.attachments, [file]);
  store.getState().setAttachments("a", []);
  assert.equal(store.getState().drafts.a, undefined);
});
