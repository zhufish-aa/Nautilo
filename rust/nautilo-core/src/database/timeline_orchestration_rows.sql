-- Keep the original task card and its latest state. Internal prompts are not conversation rows.
CREATE TEMP TABLE timeline_orchestration_repair AS
WITH tasks AS (
    SELECT session_id, block_id, seq,
           json_extract(content, '$.payload.taskId') AS task_id,
           json_extract(content, '$.payload.workflowRunId') AS workflow_id
    FROM timeline_blocks
    WHERE json_extract(content, '$.type') = 'task.updated'
      AND json_type(content, '$.payload.taskId') = 'text'
      AND call_id IS NULL
)
SELECT session_id, block_id, task_id, workflow_id,
       FIRST_VALUE(block_id) OVER (task ORDER BY seq) AS keep_id,
       FIRST_VALUE(block_id) OVER (task ORDER BY seq DESC) AS latest_id
FROM tasks
WINDOW task AS (PARTITION BY session_id, task_id)
UNION ALL
SELECT session_id, block_id, NULL, NULL, NULL, NULL
FROM timeline_blocks
WHERE kind IN ('user_prompt', 'user_append') AND json_extract(content, '$.sender') IS NOT 'user';

-- Restore the immutable identity trigger in the same migration transaction.
DROP TRIGGER timeline_block_immutable;
UPDATE timeline_blocks AS first
SET kind = 'notice', call_id = repair.task_id,
    run_id = COALESCE(first.run_id, json_extract(workflow.data, '$.taskProjection.projectPlan.invokingRunId')),
    status = json_extract(COALESCE(latest.result, latest.content), '$.payload.status'),
    result = COALESCE(latest.result, latest.content)
FROM timeline_orchestration_repair AS repair
JOIN timeline_blocks AS latest ON latest.block_id = repair.latest_id
LEFT JOIN workflow_runs AS workflow ON workflow.id = repair.workflow_id AND workflow.session_id = repair.session_id
WHERE repair.block_id = repair.keep_id AND first.block_id = repair.keep_id;

DELETE FROM timeline_blocks
WHERE block_id IN (SELECT block_id FROM timeline_orchestration_repair WHERE block_id IS NOT keep_id);

-- Older cursors must reopen the corrected snapshot.
INSERT INTO timeline_changes (session_id, revision, data)
SELECT affected.session_id, COALESCE(MAX(previous.revision), 0) + 2, '{"operations":[]}'
FROM (SELECT DISTINCT session_id FROM timeline_orchestration_repair) AS affected
LEFT JOIN timeline_changes AS previous ON previous.session_id = affected.session_id
GROUP BY affected.session_id;

DELETE FROM timeline_changes AS stale
WHERE stale.session_id IN (SELECT session_id FROM timeline_orchestration_repair)
  AND stale.revision < (SELECT MAX(revision) FROM timeline_changes WHERE session_id = stale.session_id);

DROP TABLE timeline_orchestration_repair;
