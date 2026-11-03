import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const source = await readFile(new URL("../src/renderer/src/stores/composer-drafts.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
  .replace('from "zustand"', `from ${JSON.stringify(import.meta.resolve("zustand"))}`);
const { useComposerDraftsStore: store, deliverComposerSubmission: deliver } = await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(compiled)}`);

test.beforeEach(() => store.setState({ drafts: {}, pending: {}, failed: {} }));

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

const attachment = { path: "/project/report.pdf", name: "report.pdf", kind: "file", sizeBytes: 8 };
const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

test("rejected sends retain text and attachments, retry accepts and clears only that snapshot", async () => {
  store.getState().setText("a", "Review this report");
  store.getState().setAttachments("a", [attachment]);
  const first = store.getState().begin("a", "message");
  assert.equal(await deliver(first, () => Promise.reject(new Error("offline"))), false);
  assert.equal(store.getState().drafts.a.text, "Review this report");
  assert.deepEqual(store.getState().drafts.a.attachments, [attachment]);
  const failed = store.getState().failed.a[0];
  const retry = store.getState().begin("a", "message", undefined, failed.submission.token);
  let attempts = 0;
  assert.equal(await deliver(retry, async () => { attempts++; }), true);
  assert.equal(attempts, 1);
  assert.equal(store.getState().drafts.a, undefined);
  assert.equal(store.getState().failed.a, undefined);
});

test("pending lock blocks duplicate queue/steer while awaiting real promise rejection", async () => {
  store.getState().setText("a", "Follow up");
  const request = deferred();
  const first = store.getState().begin("a", "queue");
  let calls = 0;
  const sent = deliver(first, () => { calls++; return request.promise; });
  assert.equal(store.getState().begin("a", "steer"), undefined);
  assert.equal(store.getState().drafts.a.text, "Follow up");
  request.reject(new Error("queue rejected"));
  assert.equal(await sent, false);
  assert.equal(calls, 1);
  assert.equal(store.getState().pending.a, undefined);
  assert.equal(store.getState().failed.a[0].submission.kind, "queue");
});

test("late failure preserves newer draft and exposes independent retry of original payload", async () => {
  store.getState().setText("a", "Original");
  store.getState().setAttachments("a", [attachment]);
  const request = deferred();
  const first = store.getState().begin("a", "message", "edit-1");
  const sent = deliver(first, () => request.promise);
  store.getState().setText("a", "New work");
  store.getState().setAttachments("a", []);
  store.getState().setText("b", "Other session");
  request.reject(new Error("send rejected"));
  await sent;
  assert.equal(store.getState().drafts.a.text, "New work");
  const retry = store.getState().begin("a", "message", undefined, first.token);
  assert.equal(retry.draft.text, "Original");
  assert.equal(retry.editMessageId, "edit-1");
  assert.deepEqual(retry.draft.attachments, [attachment]);
  await deliver(retry, async () => {});
  assert.equal(store.getState().drafts.a.text, "New work");
  assert.equal(store.getState().drafts.b.text, "Other session");
});

test("late success cannot erase a newly edited draft even if text returns to the original", async () => {
  store.getState().setText("a", "Same");
  const request = deferred();
  const first = store.getState().begin("a", "steer");
  const sent = deliver(first, () => request.promise);
  store.getState().setText("a", "New");
  store.getState().setText("a", "Same");
  request.resolve();
  await sent;
  assert.equal(store.getState().drafts.a.text, "Same");
});

test("first send migrates pending draft to created session and survives landing unmount", async () => {
  store.getState().setText("new:conversation", "First message");
  store.getState().setAttachments("new:conversation", [attachment]);
  const original = store.getState().begin("new:conversation", "message");
  const sent = store.getState().move(original, "created-session");
  assert.equal(store.getState().begin("new:conversation", "message"), undefined);
  assert.equal(store.getState().begin("created-session", "message"), undefined);
  assert.equal(store.getState().drafts["new:conversation"], undefined);
  assert.deepEqual(store.getState().drafts["created-session"].attachments, [attachment]);
  store.getState().setText("new:conversation", "Next new task");
  await deliver(sent, async () => { throw new Error("persist failed"); });
  assert.equal(store.getState().drafts["created-session"].text, "First message");
  assert.equal(store.getState().drafts["new:conversation"].text, "Next new task");
  assert.deepEqual(store.getState().pending, {});
});

test("multiple failed payloads remain individually retryable and stale settlements are ignored", async () => {
  store.getState().setText("a", "One");
  const one = store.getState().begin("a", "message");
  await deliver(one, async () => { throw new Error("one failed"); });
  store.getState().setText("a", "Two");
  const two = store.getState().begin("a", "message");
  store.getState().finish(one);
  assert.equal(store.getState().pending.a.token, two.token);
  await deliver(two, async () => { throw new Error("two failed"); });
  assert.deepEqual(store.getState().failed.a.map((entry) => entry.submission.draft.text), ["One", "Two"]);
});


test("retrying an original new message never inherits a different edit target", async () => {
  store.getState().setText("a", "New message");
  const first = store.getState().begin("a", "message");
  await deliver(first, async () => { throw new Error("offline"); });
  const retry = store.getState().begin("a", "message", "different-message-edit", first.token);
  assert.equal(retry.editMessageId, undefined);
});
