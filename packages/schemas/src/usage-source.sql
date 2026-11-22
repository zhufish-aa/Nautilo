SELECT json_object(
    'sessionId', s.id, 'title', json_extract(s.data,'$.title'),
    'projectId', s.project_id, 'projectName', json_extract(p.data,'$.name'),
    'updatedAt', s.updated_at, 'parentSessionId', json_extract(s.data,'$.parentSessionId'),
    'harness', json_extract(a.data,'$.providerId'), 'instanceName', json_extract(a.data,'$.displayName'),
    'currentModel', json_extract(s.data,'$.model'),
    'runId', r.id, 'runHarness', json_extract(ra.data,'$.providerId'),
    'timestamp', COALESCE(e.timestamp, json_extract(r.data,'$.startedAt')),
    'runModel', COALESCE(json_extract(e.data,'$.payload.model'), json_extract(r.data,'$.model')),
    'eventId', e.event_id, 'sequence', e.sequence,
    'usage', CASE WHEN e.event_id IS NOT NULL THEN json_object(
        'usageScope', json_extract(e.data,'$.payload.usageScope'),
        'usageKey', json_extract(e.data,'$.payload.usageKey'),
        'totalTokens', json_extract(e.data,'$.payload.totalTokens'),
        'inputTokens', json_extract(e.data,'$.payload.inputTokens'),
        'cachedInputTokens', json_extract(e.data,'$.payload.cachedInputTokens'),
        'cacheCreationInputTokens', json_extract(e.data,'$.payload.cacheCreationInputTokens'),
        'outputTokens', json_extract(e.data,'$.payload.outputTokens'),
        'inputTokensIncludesCache', (e.data -> '$.payload.inputTokensIncludesCache'),
        'reportedCost', json_extract(e.data,'$.payload.reportedCost'),
        'estimatedCost', json_extract(e.data,'$.payload.estimatedCost'),
        'currency', json_extract(e.data,'$.payload.currency'),
        'connectionId', json_extract(e.data,'$.payload.connectionId'),
        'connectionRevision', json_extract(e.data,'$.payload.connectionRevision'),
        'agentInstanceId', COALESCE(json_extract(e.data,'$.payload.agentInstanceId'), ra.id),
        'pricingSnapshot', json_extract(e.data,'$.payload.pricingSnapshot')
    ) END,
    'customPricing', COALESCE(
        (SELECT json_extract(m.value,'$.pricing') FROM json_each(c.data,'$.models') m
          WHERE json_extract(m.value,'$.id')=COALESCE(json_extract(e.data,'$.payload.model'),json_extract(r.data,'$.model')) LIMIT 1),
        (SELECT json_extract(m.value,'$.pricing') FROM json_each(ra.data,'$.models') m
          WHERE json_extract(m.value,'$.id')=COALESCE(json_extract(e.data,'$.payload.model'),json_extract(r.data,'$.model')) LIMIT 1)
    )
) AS data
FROM sessions s
LEFT JOIN projects p ON p.id=s.project_id
LEFT JOIN agents a ON a.id=json_extract(s.data,'$.agentInstanceId')
LEFT JOIN runs r ON r.session_id=s.id
LEFT JOIN agents ra ON ra.id=json_extract(r.data,'$.agentInstanceId')
LEFT JOIN runtime_events e ON e.event_id=(
    SELECT u.event_id FROM runtime_events u
    WHERE u.run_id=r.id AND u.session_id=s.id AND json_extract(u.data,'$.type')='usage.updated'
      AND json_extract(u.data,'$.payload.usageScope') IN ('turn','session')
      AND json_extract(u.data,'$.payload.subagentDispatchId') IS NULL
    ORDER BY (json_extract(u.data,'$.payload.usageScope')='turn') DESC, u.sequence DESC LIMIT 1
)
LEFT JOIN runtime_connections c ON c.id=COALESCE(json_extract(e.data,'$.payload.connectionId'), json_extract(r.data,'$.connectionId'))
WHERE (?1='' OR s.project_id=?1) AND (?2='' OR s.id=?2)
ORDER BY s.id,e.sequence,r.updated_at
