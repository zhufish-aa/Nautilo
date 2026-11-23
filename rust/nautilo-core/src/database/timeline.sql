CREATE TABLE IF NOT EXISTS timeline_blocks (
    session_id TEXT NOT NULL,
    seq INTEGER NOT NULL CHECK(seq > 0),
    block_id TEXT NOT NULL UNIQUE,
    run_id TEXT,
    kind TEXT NOT NULL,
    content TEXT NOT NULL CHECK(json_valid(content)),
    sealed INTEGER NOT NULL CHECK(sealed IN (0, 1)),
    call_id TEXT,
    status TEXT,
    result TEXT CHECK(result IS NULL OR json_valid(result)),
    PRIMARY KEY(session_id, seq)
);
CREATE UNIQUE INDEX IF NOT EXISTS timeline_one_open_block ON timeline_blocks(session_id) WHERE sealed = 0;
CREATE INDEX IF NOT EXISTS timeline_calls ON timeline_blocks(session_id, run_id, kind, call_id) WHERE call_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS timeline_run_blocks ON timeline_blocks(session_id, run_id, kind, seq);
CREATE TRIGGER IF NOT EXISTS timeline_block_immutable BEFORE UPDATE ON timeline_blocks
WHEN OLD.session_id IS NOT NEW.session_id OR OLD.seq IS NOT NEW.seq
    OR OLD.block_id IS NOT NEW.block_id OR OLD.run_id IS NOT NEW.run_id
    OR OLD.kind IS NOT NEW.kind OR OLD.call_id IS NOT NEW.call_id
    OR (OLD.sealed = 1 AND (NEW.sealed = 0 OR OLD.content IS NOT NEW.content))
BEGIN SELECT RAISE(ABORT, 'Timeline block identity or sealed content is immutable'); END;
CREATE TRIGGER IF NOT EXISTS timeline_block_at_tail BEFORE INSERT ON timeline_blocks
WHEN NEW.seq != COALESCE((SELECT MAX(seq) FROM timeline_blocks WHERE session_id=NEW.session_id),0)+1
BEGIN SELECT RAISE(ABORT, 'Timeline blocks must be appended at the tail'); END;

CREATE TABLE IF NOT EXISTS timeline_turns (
    session_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT,
    duration_ms INTEGER,
    final_block_id TEXT,
    PRIMARY KEY(session_id, run_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS timeline_active_turn ON timeline_turns(session_id) WHERE status = 'running';

CREATE TABLE IF NOT EXISTS timeline_changes (
    session_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    data TEXT NOT NULL CHECK(json_valid(data)),
    PRIMARY KEY(session_id, revision)
);
CREATE TRIGGER IF NOT EXISTS timeline_cleanup AFTER DELETE ON sessions BEGIN
    DELETE FROM timeline_blocks WHERE session_id=OLD.id;
    DELETE FROM timeline_turns WHERE session_id=OLD.id;
    DELETE FROM timeline_changes WHERE session_id=OLD.id;
END;
