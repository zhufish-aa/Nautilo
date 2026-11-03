// Keep identical to Rust history_projection.sql; guarded by repository tests.
export const historyProjectionSchema = `BEGIN IMMEDIATE;
-- Shared by both daemons. Tests enforce byte-identical migration SQL.
CREATE TABLE IF NOT EXISTS read_projection_clock (id INTEGER PRIMARY KEY CHECK(id = 1), epoch TEXT NOT NULL, revision INTEGER NOT NULL);
INSERT OR IGNORE INTO read_projection_clock VALUES(1, lower(hex(randomblob(16))), 0);
CREATE TABLE IF NOT EXISTS read_projection_rows (scope TEXT NOT NULL, item_id TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(scope, item_id));
CREATE INDEX IF NOT EXISTS idx_read_projection_revision ON read_projection_rows(scope, revision);
CREATE INDEX IF NOT EXISTS idx_read_projection_item ON read_projection_rows(item_id, scope);
CREATE TABLE IF NOT EXISTS read_projection_invalidations (scope TEXT PRIMARY KEY, revision INTEGER NOT NULL);
INSERT OR IGNORE INTO read_projection_rows SELECT 'messages:session:' || session_id, id, 0 FROM messages WHERE session_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM schema_meta WHERE key = 'history_projection_seeded_v1');
CREATE TRIGGER IF NOT EXISTS read_projection_messages_insert AFTER INSERT ON messages BEGIN
UPDATE read_projection_clock SET revision = revision + 1 WHERE id = 1;
INSERT INTO read_projection_invalidations(scope, revision) SELECT scope, (SELECT revision FROM read_projection_clock WHERE id = 1) FROM read_projection_rows WHERE scope LIKE 'messages:%' AND ((item_id = NEW.id AND scope IS NOT ('messages:session:' || NEW.session_id))) ON CONFLICT(scope) DO UPDATE SET revision = excluded.revision;
DELETE FROM read_projection_rows WHERE scope LIKE 'messages:%' AND item_id IN (NEW.id);
INSERT INTO read_projection_rows(scope, item_id, revision) SELECT 'messages:session:' || NEW.session_id, NEW.id, (SELECT revision FROM read_projection_clock WHERE id = 1) WHERE NEW.session_id IS NOT NULL ON CONFLICT(scope, item_id) DO UPDATE SET revision = excluded.revision;
END;
CREATE TRIGGER IF NOT EXISTS read_projection_messages_update AFTER UPDATE OF id, data, created_at, session_id ON messages BEGIN
UPDATE read_projection_clock SET revision = revision + 1 WHERE id = 1;
INSERT INTO read_projection_invalidations(scope, revision) SELECT scope, (SELECT revision FROM read_projection_clock WHERE id = 1) FROM read_projection_rows WHERE scope LIKE 'messages:%' AND ((item_id = NEW.id AND scope IS NOT ('messages:session:' || NEW.session_id)) OR (item_id = OLD.id AND OLD.id IS NOT NEW.id)) ON CONFLICT(scope) DO UPDATE SET revision = excluded.revision;
DELETE FROM read_projection_rows WHERE scope LIKE 'messages:%' AND item_id IN (OLD.id, NEW.id);
INSERT INTO read_projection_rows(scope, item_id, revision) SELECT 'messages:session:' || NEW.session_id, NEW.id, (SELECT revision FROM read_projection_clock WHERE id = 1) WHERE NEW.session_id IS NOT NULL ON CONFLICT(scope, item_id) DO UPDATE SET revision = excluded.revision;
END;
CREATE TRIGGER IF NOT EXISTS read_projection_messages_delete AFTER DELETE ON messages BEGIN
UPDATE read_projection_clock SET revision = revision + 1 WHERE id = 1;
INSERT INTO read_projection_invalidations(scope, revision) SELECT scope, (SELECT revision FROM read_projection_clock WHERE id = 1) FROM read_projection_rows WHERE scope LIKE 'messages:%' AND item_id = OLD.id ON CONFLICT(scope) DO UPDATE SET revision = excluded.revision;
DELETE FROM read_projection_rows WHERE scope LIKE 'messages:%' AND item_id IN (OLD.id);
END;
INSERT OR IGNORE INTO read_projection_rows SELECT 'artifacts:session:' || session_id, id, 0 FROM artifacts WHERE session_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM schema_meta WHERE key = 'history_projection_seeded_v1');
INSERT OR IGNORE INTO read_projection_rows SELECT 'artifacts:projectRun:' || project_run_id, id, 0 FROM artifacts WHERE project_run_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM schema_meta WHERE key = 'history_projection_seeded_v1');
CREATE TRIGGER IF NOT EXISTS read_projection_artifacts_insert AFTER INSERT ON artifacts BEGIN
UPDATE read_projection_clock SET revision = revision + 1 WHERE id = 1;
INSERT INTO read_projection_invalidations(scope, revision) SELECT scope, (SELECT revision FROM read_projection_clock WHERE id = 1) FROM read_projection_rows WHERE scope LIKE 'artifacts:%' AND ((item_id = NEW.id AND scope IS NOT ('artifacts:session:' || NEW.session_id) AND scope IS NOT ('artifacts:projectRun:' || NEW.project_run_id))) ON CONFLICT(scope) DO UPDATE SET revision = excluded.revision;
DELETE FROM read_projection_rows WHERE scope LIKE 'artifacts:%' AND item_id IN (NEW.id);
INSERT INTO read_projection_rows(scope, item_id, revision) SELECT 'artifacts:session:' || NEW.session_id, NEW.id, (SELECT revision FROM read_projection_clock WHERE id = 1) WHERE NEW.session_id IS NOT NULL ON CONFLICT(scope, item_id) DO UPDATE SET revision = excluded.revision;
INSERT INTO read_projection_rows(scope, item_id, revision) SELECT 'artifacts:projectRun:' || NEW.project_run_id, NEW.id, (SELECT revision FROM read_projection_clock WHERE id = 1) WHERE NEW.project_run_id IS NOT NULL ON CONFLICT(scope, item_id) DO UPDATE SET revision = excluded.revision;
END;
CREATE TRIGGER IF NOT EXISTS read_projection_artifacts_update AFTER UPDATE OF id, data, created_at, session_id, project_run_id ON artifacts BEGIN
UPDATE read_projection_clock SET revision = revision + 1 WHERE id = 1;
INSERT INTO read_projection_invalidations(scope, revision) SELECT scope, (SELECT revision FROM read_projection_clock WHERE id = 1) FROM read_projection_rows WHERE scope LIKE 'artifacts:%' AND ((item_id = NEW.id AND scope IS NOT ('artifacts:session:' || NEW.session_id) AND scope IS NOT ('artifacts:projectRun:' || NEW.project_run_id)) OR (item_id = OLD.id AND OLD.id IS NOT NEW.id)) ON CONFLICT(scope) DO UPDATE SET revision = excluded.revision;
DELETE FROM read_projection_rows WHERE scope LIKE 'artifacts:%' AND item_id IN (OLD.id, NEW.id);
INSERT INTO read_projection_rows(scope, item_id, revision) SELECT 'artifacts:session:' || NEW.session_id, NEW.id, (SELECT revision FROM read_projection_clock WHERE id = 1) WHERE NEW.session_id IS NOT NULL ON CONFLICT(scope, item_id) DO UPDATE SET revision = excluded.revision;
INSERT INTO read_projection_rows(scope, item_id, revision) SELECT 'artifacts:projectRun:' || NEW.project_run_id, NEW.id, (SELECT revision FROM read_projection_clock WHERE id = 1) WHERE NEW.project_run_id IS NOT NULL ON CONFLICT(scope, item_id) DO UPDATE SET revision = excluded.revision;
END;
CREATE TRIGGER IF NOT EXISTS read_projection_artifacts_delete AFTER DELETE ON artifacts BEGIN
UPDATE read_projection_clock SET revision = revision + 1 WHERE id = 1;
INSERT INTO read_projection_invalidations(scope, revision) SELECT scope, (SELECT revision FROM read_projection_clock WHERE id = 1) FROM read_projection_rows WHERE scope LIKE 'artifacts:%' AND item_id = OLD.id ON CONFLICT(scope) DO UPDATE SET revision = excluded.revision;
DELETE FROM read_projection_rows WHERE scope LIKE 'artifacts:%' AND item_id IN (OLD.id);
END;
INSERT OR IGNORE INTO schema_meta(key, value) VALUES('history_projection_seeded_v1', '1');
COMMIT;
`;
