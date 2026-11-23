-- Repair duplicate display rows while keeping the first call's ID and position.
CREATE TEMP TABLE timeline_tool_duplicates AS
WITH ranked AS (
    SELECT session_id, block_id,
           FIRST_VALUE(block_id) OVER (call ORDER BY seq) AS first_id,
           FIRST_VALUE(block_id) OVER (call ORDER BY status IN ('done', 'failed') DESC, seq DESC) AS result_id,
           COUNT(*) OVER call AS copies
    FROM timeline_blocks
    WHERE kind = 'tool_call' AND run_id IS NOT NULL AND call_id IS NOT NULL
    WINDOW call AS (PARTITION BY session_id, run_id, call_id)
)
SELECT session_id, block_id, first_id, result_id FROM ranked WHERE copies > 1;

UPDATE timeline_blocks AS first
SET status = latest.status,
    result = CASE WHEN latest.block_id = first.block_id THEN latest.result
                  ELSE COALESCE(latest.result, latest.content) END
FROM timeline_tool_duplicates AS repair
JOIN timeline_blocks AS latest ON latest.block_id = repair.result_id
WHERE repair.block_id = repair.first_id AND first.block_id = repair.first_id;

DELETE FROM timeline_blocks
WHERE block_id IN (SELECT block_id FROM timeline_tool_duplicates WHERE block_id <> first_id);

-- Force subscribers with the old rows to refresh their snapshot.
INSERT INTO timeline_changes (session_id, revision, data)
SELECT affected.session_id, COALESCE(MAX(previous.revision), 0) + 2, '{"operations":[]}'
FROM (SELECT DISTINCT session_id FROM timeline_tool_duplicates) AS affected
LEFT JOIN timeline_changes AS previous ON previous.session_id = affected.session_id
GROUP BY affected.session_id;

DELETE FROM timeline_changes AS stale
WHERE stale.session_id IN (SELECT session_id FROM timeline_tool_duplicates)
  AND stale.revision < (SELECT MAX(revision) FROM timeline_changes WHERE session_id = stale.session_id);

DROP TABLE timeline_tool_duplicates;
