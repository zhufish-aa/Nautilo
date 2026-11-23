-- Repair records written before decisions updated the original plan block.
CREATE TEMP TABLE timeline_plan_duplicates AS
WITH ranked AS (
    SELECT session_id, block_id,
           FIRST_VALUE(block_id) OVER (plan ORDER BY seq) AS first_id,
           FIRST_VALUE(block_id) OVER (plan ORDER BY seq DESC) AS result_id,
           COUNT(*) OVER plan AS copies
    FROM timeline_blocks
    WHERE json_extract(content, '$.type') = 'workflow.plan'
      AND json_extract(content, '$.payload.plan.id') IS NOT NULL
    WINDOW plan AS (PARTITION BY session_id, json_extract(content, '$.payload.plan.id'))
)
SELECT session_id, block_id, first_id, result_id FROM ranked WHERE copies > 1;

UPDATE timeline_blocks AS first
SET status = json_extract(COALESCE(latest.result, latest.content), '$.payload.plan.status'),
    result = COALESCE(latest.result, latest.content)
FROM timeline_plan_duplicates AS repair
JOIN timeline_blocks AS latest ON latest.block_id = repair.result_id
WHERE repair.block_id = repair.first_id AND first.block_id = repair.first_id;

DELETE FROM timeline_blocks
WHERE block_id IN (SELECT block_id FROM timeline_plan_duplicates WHERE block_id <> first_id);

-- Readers with an older cursor must reopen the corrected snapshot.
INSERT INTO timeline_changes (session_id, revision, data)
SELECT affected.session_id, COALESCE(MAX(previous.revision), 0) + 2, '{"operations":[]}'
FROM (SELECT DISTINCT session_id FROM timeline_plan_duplicates) AS affected
LEFT JOIN timeline_changes AS previous ON previous.session_id = affected.session_id
GROUP BY affected.session_id;

DELETE FROM timeline_changes AS stale
WHERE stale.session_id IN (SELECT session_id FROM timeline_plan_duplicates)
  AND stale.revision < (SELECT MAX(revision) FROM timeline_changes WHERE session_id = stale.session_id);

DROP TABLE timeline_plan_duplicates;
