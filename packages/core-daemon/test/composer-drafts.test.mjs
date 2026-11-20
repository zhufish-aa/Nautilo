import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { Database, CredentialService } from "../dist/index.js";
import { ComposerDraftService } from "../dist/application/composer-drafts.js";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "nautilo-draft-test-")), file = join(dir, "state.sqlite");
  const database = new Database(file);
  const service = new ComposerDraftService(database, new CredentialService(database, dir));
  t.after(() => {
    database.close();
    assert(resolve(dir).startsWith(resolve(tmpdir()) + sep));
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, file, database, service };
}
const draft = { draft: { text: "private prompt 机密内容", attachments: [{ path: "D:/private/design.png", name: "design.png", kind: "image", sizeBytes: 12 }] }, submissions: [] };

test("drafts are encrypted at rest and recover with the same vault after restart", t => {
  const { database, service, dir, file } = fixture(t);
  assert.equal(service.write({ id: "a", revision: 0, value: draft }).saved, true);
  const encrypted = JSON.stringify(database.composerDrafts.list());
  assert(!encrypted.includes(draft.draft.text)); assert(!encrypted.includes("D:/private"));
  database.connection.raw.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  assert(!readFileSync(file).includes(Buffer.from(draft.draft.text)));
  const reopened = new Database(file);
  try {
    assert.deepEqual(new ComposerDraftService(reopened, new CredentialService(reopened, dir)).list().items[0].value, draft);
  } finally { reopened.close(); }
});

test("stale saves cannot overwrite or resurrect a cleared draft", t => {
  const { service } = fixture(t);
  assert.deepEqual(service.write({ id: "a", revision: 0, value: draft }), { saved: true, revision: 1 });
  assert.equal(service.write({ id: "a", revision: 0, value: {} }).saved, false);
  assert.equal(service.write({ id: "a", revision: 1, value: null }).saved, true);
  assert.equal(service.write({ id: "a", revision: 1, value: draft }).saved, false);
  assert.deepEqual(service.list().items[0], { id: "a", revision: 2, value: null, acceptedMessageIds: [] });
});

test("recovery acknowledges only messages accepted by this exact conversation", t => {
  const { database, service } = fixture(t);
  database.connection.raw.prepare("INSERT INTO messages(id,session_id,data,created_at) VALUES(?,?,?,?)").run("sent", "a", "{}", "now");
  database.connection.raw.prepare("INSERT INTO messages(id,session_id,data,created_at) VALUES(?,?,?,?)").run("other", "b", "{}", "now");
  service.write({ id: "a", revision: 0, value: { ...draft, submissions: [{ messageId: "sent" }, { messageId: "other" }, { messageId: "unknown" }] } });
  assert.deepEqual(service.list().items[0].acceptedMessageIds, ["sent"]);
});

test("one corrupt record is isolated and never interpreted as an empty draft", t => {
  const { database, service } = fixture(t);
  service.write({ id: "good", revision: 0, value: draft });
  database.connection.raw.prepare("INSERT INTO composer_drafts(id,revision,data) VALUES(?,?,?)").run("bad", 4, "invalid-json");
  assert.deepEqual(service.list().unreadable, ["bad"]);
  assert.equal(service.list().items[0].id, "good");
  assert.equal(database.connection.raw.prepare("SELECT data FROM composer_drafts WHERE id='bad'").get().data, "invalid-json");
});

test("deleting a session removes its draft, and invalid oversized requests are rejected", t => {
  const { database, service } = fixture(t);
  database.connection.raw.prepare("INSERT INTO sessions(id,project_id,member_id,data,updated_at) VALUES(?,?,?,?,?)").run("a", "p", "m", "{}", "now");
  service.write({ id: "a", revision: 0, value: draft });
  database.connection.raw.prepare("DELETE FROM sessions WHERE id=?").run("a");
  assert.deepEqual(service.list().items, []);
  assert.throws(() => service.write({ id: "bad", revision: -1, value: {} }));
  assert.throws(() => service.write({ id: "bad", revision: 0, value: { text: "x".repeat(1_048_577) } }));
});
