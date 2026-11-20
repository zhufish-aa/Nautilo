import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
const source = await readFile(new URL("../src/renderer/src/lib/draft-journal.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { DraftJournal } = await import(`data:text/javascript,${encodeURIComponent(compiled)}`);
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
function setup(storage, initial = {}) {
  const values = { ...initial }, reports = [];
  const journal = new DraftJournal(storage, id => values[id] ?? null, record => { values[record.id] = record.value; }, (id, error) => reports.push([id, error]), 60_000);
  return { values, journal, reports };
}

test("close waits for an already in-flight save and saves the newest input after its acknowledgement", async () => {
  const gate = deferred(), entered = deferred(), writes = [];
  const { journal, values } = setup({ list: async () => ({ items: [], unreadable: [] }), write: async (id, revision, value) => {
    writes.push([revision, value]);
    if (writes.length === 1) { entered.resolve(); await gate.promise; }
    return { saved: true, revision: revision + 1 };
  } });
  await journal.start();
  values.a = { text: "before" }; journal.changed("a");
  const first = journal.flush("a"); await entered.promise;
  let closed = false;
  const close = journal.flushAll().then(() => { closed = true; });
  await Promise.resolve(); assert.equal(closed, false);
  values.a = { text: "after" }; journal.changed("a");
  gate.resolve(); await Promise.all([first, close]);
  assert.deepEqual(writes, [[0, { text: "before" }], [1, { text: "after" }]]);
  await journal.flushAll();
});

test("storage failures preserve unsent input and can be retried without guessing a new revision", async () => {
  let fail = true;
  const { journal, values, reports } = setup({ list: async () => ({ items: [], unreadable: [] }), write: async (_id, revision) => {
    assert.equal(revision, 0); if (fail) throw new Error("disk full"); return { saved: true, revision: 1 };
  } });
  values.a = { text: "keep me" }; journal.changed("a");
  await assert.rejects(journal.flushAll(), /disk full/);
  assert.deepEqual(values.a, { text: "keep me" });
  assert.equal(reports.at(-1)[1], "disk full");
  fail = false; await journal.flushAll(); assert.equal(reports.at(-1)[1], undefined);
});

test("CAS conflicts stop automatic writes until an explicit resolution", async () => {
  let calls = 0;
  const { journal, values } = setup({
    list: async () => ({ items: [{ id: "a", revision: 9, value: { text: "other window" }, acceptedMessageIds: [] }], unreadable: [] }),
    write: async (_id, revision) => { calls++; return { saved: calls > 1, revision: revision + 1 }; }
  });
  await journal.start(); values.a = { text: "local" }; journal.changed("a");
  await assert.rejects(journal.flushAll(), /另一窗口/);
  await assert.rejects(journal.flushAll(), /冲突/);
  assert.equal(calls, 1); assert.equal(values.a.text, "local");
  await journal.resolve("a", true); assert.equal(calls, 2); assert.equal(values.a.text, "local");
  await journal.flushAll();
});

test("corrupt stored records remain intact and do not block closing an unrelated clean window", async () => {
  let writes = 0;
  const journal = new DraftJournal({ list: async () => ({ items: [{ id: "bad", revision: 3, value: {}, acceptedMessageIds: [] }], unreadable: ["encrypted-bad"] }),
    write: async () => { writes++; throw new Error("must not overwrite"); } }, () => null, () => { throw new Error("invalid"); }, () => {}, 60_000);
  await journal.start(); await journal.flushAll(); assert.equal(writes, 0);
});

test("an empty tombstone retains its revision across restart and prevents the ABA race", async () => {
  const revisions = [];
  const { journal, values } = setup({ list: async () => ({ items: [{ id: "a", revision: 6, value: null, acceptedMessageIds: [] }], unreadable: [] }),
    write: async (_id, revision) => { revisions.push(revision); return { saved: true, revision: revision + 1 }; }
  });
  await journal.start(); values.a = { text: "new intent" }; journal.changed("a"); await journal.flushAll();
  assert.deepEqual(revisions, [6]);
});
