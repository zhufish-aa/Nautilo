import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Database } from '../dist/database/index.js';
import { migrateDatabase } from '../dist/database/migrations.js';
import { historyProjectionSchema } from '../dist/database/history-projection-schema.js';
import { readSnapshot } from '../dist/database/history-projection.js';

const timestamp = '2026-11-03T00:00:00.000Z';
const session = (id) => ({ id, projectId: 'p', memberId: 'a', status: 'running', createdAt: timestamp, updatedAt: timestamp });
const message = (id, sessionId = 's', text = id, createdAt = timestamp) => ({ id, sessionId, sender: 'agent', runId: 'r', text, createdAt });
const artifact = (id, sessionId = 's', projectRunId = 'pr', text = id) => ({ id, kind: 'diff', sessionId, projectRunId, metadata: { text } });
function fixture(t) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.sessions.save(session('s')); db.sessions.save(session('other'));
  return db;
}
const values = (projection) => projection.items.map((item) => item.value);

test('TS and Rust use byte-identical migration SQL and expose both projection endpoints', () => {
  assert.equal(historyProjectionSchema, readFileSync(new URL('../../../rust/nautilo-core/src/database/history_projection.sql', import.meta.url), 'utf8'));
  const rust = readFileSync(new URL('../../../rust/nautilo-core/src/application/ipc_handlers.rs', import.meta.url), 'utf8');
  for (const method of ['session.history', 'artifact.changes']) assert.ok(rust.includes(`"${method}"`));
});

test('initial history preserves created_at and insertion order for identical timestamps', (t) => {
  const db = fixture(t);
  for (const id of ['z', 'a', 'm']) db.sessions.saveMessage(message(id));
  const initial = db.sessions.history('s');
  assert.equal(initial.reset, true);
  assert.deepEqual(values(initial), db.sessions.messages('s'));
  assert.deepEqual(values(initial).map((m) => m.id), ['z', 'a', 'm']);
  const unchanged = db.sessions.history('s', initial.cursor);
  assert.equal(unchanged.reset, false); assert.deepEqual(unchanged.items, []);
});

test('append and same-timestamp edits are incremental without a session updatedAt change', (t) => {
  const db = fixture(t);
  db.sessions.saveMessage(message('m'));
  const first = db.sessions.history('s');
  db.sessions.saveMessage(message('n'));
  const appended = db.sessions.history('s', first.cursor);
  assert.equal(appended.reset, false); assert.deepEqual(values(appended).map((m) => m.id), ['n']);
  db.sessions.saveMessage(message('m', 's', 'edited'));
  const edited = db.sessions.history('s', appended.cursor);
  assert.equal(edited.reset, false); assert.deepEqual(values(edited).map((m) => m.text), ['edited']);
  assert.equal(edited.items[0].order.ordinal, first.items[0].order.ordinal);
  assert.equal(edited.session.updatedAt, first.session.updatedAt);
});

test('raw SQL edits, delete/rewind and rolled-back mutations cannot skip rows', (t) => {
  const db = fixture(t), raw = db.connection.raw;
  db.sessions.saveMessage(message('a')); db.sessions.saveMessage(message('b'));
  const first = db.sessions.history('s');
  raw.prepare('UPDATE messages SET data = ? WHERE id = ?').run(JSON.stringify(message('a', 's', 'raw edit')), 'a');
  const edited = db.sessions.history('s', first.cursor);
  assert.equal(edited.reset, false); assert.equal(values(edited)[0].text, 'raw edit');
  raw.prepare('DELETE FROM messages WHERE session_id = ? AND id = ?').run('s', 'b');
  const removed = db.sessions.history('s', edited.cursor);
  assert.equal(removed.reset, true); assert.deepEqual(values(removed).map((m) => m.id), ['a']);
  raw.exec('BEGIN'); db.sessions.saveMessage(message('rollback')); raw.exec('ROLLBACK');
  assert.deepEqual(db.sessions.history('s', removed.cursor).items, []);
});

test('cursor scope, epoch, future revisions and invalid revisions force isolated snapshots', (t) => {
  const db = fixture(t);
  db.sessions.saveMessage(message('private')); db.sessions.saveMessage(message('other', 'other'));
  const first = db.sessions.history('s');
  const other = db.sessions.history('other', first.cursor);
  assert.equal(other.reset, true); assert.deepEqual(values(other).map((m) => m.id), ['other']);
  for (const cursor of [{ ...first.cursor, epoch: 'different' }, { ...first.cursor, revision: 1e9 }, { ...first.cursor, revision: -1 }, { ...first.cursor, revision: 0.5 }]) {
    assert.equal(db.sessions.history('s', cursor).reset, true);
  }
  assert.throws(() => db.sessions.history('missing', first.cursor), /IPC_NOT_FOUND|资源不存在/);
});

test('upsert and legacy INSERT OR REPLACE moves never leave rows in the previous session', (t) => {
  const db = fixture(t), raw = db.connection.raw;
  db.sessions.saveMessage(message('m'));
  const first = db.sessions.history('s');
  db.sessions.saveMessage(message('m', 'other'));
  const moved = db.sessions.history('s', first.cursor);
  assert.equal(moved.reset, true); assert.deepEqual(moved.items, []);
  const other = db.sessions.history('other');
  raw.prepare('INSERT OR REPLACE INTO messages(id, session_id, data, created_at) VALUES(?, ?, ?, ?)').run('m', 's', JSON.stringify(message('m')), timestamp);
  assert.deepEqual(db.sessions.history('other', other.cursor).items, []);
  assert.equal(db.sessions.history('other', other.cursor).reset, true);
  assert.deepEqual(values(db.sessions.history('s', moved.cursor)).map((m) => m.id), ['m']);
});

test('artifact append/update/retention and cross-project moves reset only affected scopes', (t) => {
  const db = fixture(t);
  db.artifacts.save(artifact('a'), timestamp);
  const first = db.artifacts.changes({ projectRunId: 'pr' });
  const sessionFirst = db.artifacts.changes({ sessionId: 's' });
  db.artifacts.save(artifact('a', 's', 'pr', 'edited'), timestamp);
  const edited = db.artifacts.changes({ projectRunId: 'pr', cursor: first.cursor });
  assert.equal(edited.reset, false); assert.equal(values(edited)[0].metadata.text, 'edited');
  db.artifacts.save(artifact('a', 'other', 'other-pr'), timestamp);
  assert.deepEqual(values(db.artifacts.changes({ projectRunId: 'pr', cursor: edited.cursor })), []);
  assert.equal(db.artifacts.changes({ sessionId: 's', cursor: sessionFirst.cursor }).reset, true);
  const moved = db.artifacts.changes({ projectRunId: 'other-pr' });
  assert.equal(values(moved)[0].sessionId, 'other');
  db.artifacts.deleteBefore('2026-11-04');
  const removed = db.artifacts.changes({ projectRunId: 'other-pr', cursor: moved.cursor });
  assert.equal(removed.reset, true); assert.deepEqual(removed.items, []);
  assert.throws(() => db.artifacts.changes({}), /IPC_INVALID_REQUEST|请求/);
  assert.throws(() => db.artifacts.changes({ sessionId: 's', projectRunId: 'pr' }), /IPC_INVALID_REQUEST|请求/);
});

test('legacy artifact REPLACE invalidates old scopes and raw deletes remove the row index', (t) => {
  const db = fixture(t), raw = db.connection.raw;
  db.artifacts.save(artifact('a'), timestamp);
  const previous = db.artifacts.changes({ projectRunId: 'pr' });
  raw.prepare('INSERT OR REPLACE INTO artifacts(id, kind, project_run_id, session_id, data, created_at, size_bytes) VALUES(?, ?, ?, ?, ?, ?, 0)').run('a', 'diff', 'new-pr', 'other', JSON.stringify(artifact('a', 'other', 'new-pr')), timestamp);
  const removed = db.artifacts.changes({ projectRunId: 'pr', cursor: previous.cursor });
  assert.equal(removed.reset, true); assert.deepEqual(removed.items, []);
  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM read_projection_rows WHERE scope IN ('artifacts:projectRun:pr', 'artifacts:session:s')").get().n, 0);
  raw.prepare('DELETE FROM artifacts WHERE id = ?').run('a');
  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM read_projection_rows WHERE item_id = 'a'").get().n, 0);
});

test('old schema migration seeds existing rows once and reopening preserves valid cursors', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'nautilo-history-migration-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'db.sqlite');
  const old = new DatabaseSync(path);
  old.exec("CREATE TABLE schema_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO schema_meta VALUES('schema', '7'); CREATE TABLE messages(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL);");
  old.prepare('INSERT INTO messages VALUES(?, ?, ?, ?)').run('legacy', 's', JSON.stringify(message('legacy')), timestamp);
  old.close();
  let db = new Database(path); db.sessions.save(session('s'));
  const first = db.sessions.history('s'); assert.equal(values(first)[0].id, 'legacy');
  db.sessions.saveMessage(message('new')); const next = db.sessions.history('s', first.cursor);
  db.close(); db = new Database(path); t.after(() => db.close());
  assert.equal(db.sessions.history('s', next.cursor).reset, false);
  assert.deepEqual(db.sessions.history('s', next.cursor).items, []);
  migrateDatabase(db.connection.raw);
  assert.deepEqual(db.sessions.history('s', next.cursor).items, []);
  assert.equal(db.connection.raw.prepare("SELECT value FROM schema_meta WHERE key='schema'").get().value, '8');
});

test('one WAL read snapshot binds cursor and payload while another daemon writes', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'nautilo-history-snapshot-'));
  const path = join(dir, 'db.sqlite');
  const reader = new Database(path), writer = new Database(path);
  t.after(() => { reader.close(); writer.close(); rmSync(dir, { recursive: true, force: true }); });
  reader.sessions.save(session('s')); reader.sessions.saveMessage(message('old'));
  const first = reader.sessions.history('s');
  const concurrent = readSnapshot(reader.connection.raw, () => {
    reader.connection.raw.prepare('SELECT revision FROM read_projection_clock').get(); // pins snapshot
    writer.sessions.saveMessage(message('concurrent'));
    return reader.sessions.history('s', first.cursor);
  });
  assert.equal(concurrent.cursor.revision, first.cursor.revision);
  assert.deepEqual(concurrent.items, []);
  const next = reader.sessions.history('s', concurrent.cursor);
  assert.equal(next.reset, false); assert.deepEqual(values(next).map((m) => m.id), ['concurrent']);
});

test('deleteTree followed by the same session id cannot resurrect deleted history', (t) => {
  const db = fixture(t); db.sessions.saveMessage(message('m')); db.artifacts.save(artifact('a'));
  const first = db.sessions.history('s'), artifacts = db.artifacts.changes({ sessionId: 's' });
  db.sessions.deleteTree('s'); db.sessions.save(session('s'));
  assert.equal(db.sessions.history('s', first.cursor).reset, true); assert.deepEqual(db.sessions.history('s', first.cursor).items, []);
  assert.equal(db.artifacts.changes({ sessionId: 's', cursor: artifacts.cursor }).reset, true);
});

test('ignored inserts do not mutate revision indexes or invalidate untouched history', (t) => {
  const db = fixture(t), raw = db.connection.raw;
  db.sessions.saveMessage(message('m')); db.artifacts.save(artifact('a'), timestamp);
  const initial = db.sessions.history('s'), art = db.artifacts.changes({ projectRunId: 'pr' });
  for (const clause of ['INSERT OR IGNORE', 'INSERT']) {
    const suffix = clause === 'INSERT' ? ' ON CONFLICT(id) DO NOTHING' : '';
    raw.prepare(`${clause} INTO messages(id, session_id, data, created_at) VALUES(?, ?, ?, ?)${suffix}`).run('m', 'other', JSON.stringify(message('m', 'other')), timestamp);
    raw.prepare(`${clause} INTO artifacts(id, kind, project_run_id, session_id, data, created_at) VALUES(?, ?, ?, ?, ?, ?)${suffix}`).run('a', 'diff', 'other-pr', 'other', JSON.stringify(artifact('a', 'other', 'other-pr')), timestamp);
  }
  assert.deepEqual(db.sessions.history('s', initial.cursor).items, []);
  assert.equal(db.sessions.history('s', initial.cursor).reset, false);
  assert.equal(values(db.sessions.history('s'))[0].id, 'm');
  assert.equal(values(db.artifacts.changes({ projectRunId: 'pr' }))[0].id, 'a');
  assert.equal(db.artifacts.changes({ projectRunId: 'pr', cursor: art.cursor }).reset, false);
});

test('UPDATE OR REPLACE identity collisions invalidate both overwritten and moved scopes', (t) => {
  const db = fixture(t), raw = db.connection.raw;
  db.sessions.saveMessage(message('m')); db.sessions.saveMessage(message('n', 'other'));
  const first = db.sessions.history('s'), other = db.sessions.history('other');
  raw.prepare('UPDATE OR REPLACE messages SET id = ?, data = ? WHERE id = ?').run('n', JSON.stringify(message('n')), 'm');
  assert.equal(db.sessions.history('s', first.cursor).reset, true);
  assert.deepEqual(values(db.sessions.history('s', first.cursor)).map((m) => m.id), ['n']);
  assert.equal(db.sessions.history('other', other.cursor).reset, true);
  assert.deepEqual(db.sessions.history('other').items, []);
  db.artifacts.save(artifact('a'), timestamp); db.artifacts.save(artifact('b', 'other', 'other-pr'), timestamp);
  const previous = db.artifacts.changes({ projectRunId: 'other-pr' });
  raw.prepare('UPDATE OR REPLACE artifacts SET id = ?, data = ? WHERE id = ?').run('b', JSON.stringify(artifact('b')), 'a');
  assert.equal(db.artifacts.changes({ projectRunId: 'other-pr', cursor: previous.cursor }).reset, true);
  assert.deepEqual(db.artifacts.changes({ projectRunId: 'other-pr' }).items, []);
});

test('history batches validate their bound and isolate mismatched per-session cursors', (t) => {
  const db = fixture(t); db.sessions.saveMessage(message('m')); db.sessions.saveMessage(message('other', 'other'));
  const first = db.sessions.history('s');
  const batch = db.sessions.historyBatch([{ sessionId: 's', cursor: first.cursor }, { sessionId: 'other', cursor: first.cursor }]);
  assert.deepEqual(batch.items[0].items, []);
  assert.equal(batch.items[1].reset, true); assert.deepEqual(values(batch.items[1]).map((m) => m.id), ['other']);
  for (const items of [[], Array.from({ length: 65 }, () => ({ sessionId: 's' })), [{ sessionId: '' }]]) {
    assert.throws(() => db.sessions.historyBatch(items), /IPC_INVALID_REQUEST|请求/);
  }
  assert.throws(() => db.sessions.historyBatch([{ sessionId: 's' }, { sessionId: 'missing' }]), /IPC_NOT_FOUND|资源不存在/);
  assert.deepEqual(db.sessions.history('s', first.cursor).items, [], 'failed batch never advances client cursors or changes data');
});
