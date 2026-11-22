use rusqlite::Connection;
use serde_json::Value;

use crate::{database::connection::db_fail, errors::CoreResult};

pub(super) fn totals(db: &Connection, id: &str, since: &str) -> CoreResult<(u64, Option<f64>)> {
    // One authoritative snapshot per run. For native cumulative counters, compare to
    // the previous run on the same native thread, including just before the date range.
    let mut statement = db.prepare("WITH snapshots AS (
        SELECT e.data,e.sequence,e.session_id,e.run_id FROM runs r JOIN runtime_events e ON e.event_id=(
            SELECT x.event_id FROM runtime_events x WHERE x.run_id=r.id
                AND json_extract(x.data,'$.type')='usage.updated'
                AND json_extract(x.data,'$.payload.usageScope') IN ('turn','session')
                AND (json_extract(x.data,'$.payload.inputTokens') IS NOT NULL OR json_extract(x.data,'$.payload.outputTokens') IS NOT NULL)
            ORDER BY (json_extract(x.data,'$.payload.usageScope')='turn') DESC,x.sequence DESC LIMIT 1)
        WHERE json_extract(r.data,'$.connectionId')=?1 AND json_extract(r.data,'$.startedAt')>=?2
    ) SELECT json_extract(s.data,'$.payload'), CASE WHEN json_extract(s.data,'$.payload.usageScope')='session' THEN (
        SELECT json_extract(p.data,'$.payload') FROM runtime_events p WHERE p.session_id=s.session_id
            AND p.sequence<s.sequence AND p.run_id<>s.run_id
            AND json_extract(p.data,'$.type')='usage.updated' AND json_extract(p.data,'$.payload.usageScope')='session'
            AND json_extract(p.data,'$.payload.usageKey')=json_extract(s.data,'$.payload.usageKey')
            AND json_extract(p.data,'$.payload.connectionId')=?1
            AND json_extract(p.data,'$.payload.connectionRevision')=json_extract(s.data,'$.payload.connectionRevision')
            AND json_extract(p.data,'$.payload.agentInstanceId')=json_extract(s.data,'$.payload.agentInstanceId')
            AND (json_extract(p.data,'$.payload.inputTokens') IS NOT NULL OR json_extract(p.data,'$.payload.outputTokens') IS NOT NULL)
        ORDER BY p.sequence DESC LIMIT 1) END FROM snapshots s").map_err(db_fail)?;
    let mut rows = statement.query([id,since]).map_err(db_fail)?;
    let (mut tokens, mut eligible, mut hits) = (0u64, 0u64, 0u64);
    while let Some(row) = rows.next().map_err(db_fail)? {
        let current: String = row.get(0).map_err(db_fail)?;
        let previous: Option<String> = row.get(1).map_err(db_fail)?;
        let current: Value = serde_json::from_str(&current).unwrap_or(Value::Null);
        let previous: Option<Value> = previous.and_then(|value| serde_json::from_str(&value).ok());
        if current["usageScope"] == "session"
            && previous.as_ref().is_none_or(|old| {
                old["inputTokensIncludesCache"] != current["inputTokensIncludesCache"]
                    || ["inputTokens", "outputTokens", "cachedInputTokens", "cacheCreationInputTokens"].iter().any(|key| {
                        current[*key].as_u64().zip(old[*key].as_u64()).is_some_and(|(value, last)| value < last)
                    })
            }) { continue; }
        let counter = |field: &str| -> Option<u64> {
            let count = current[field].as_u64()?;
            match &previous { Some(old) => count.checked_sub(old[field].as_u64()?), None => Some(count) }
        };
        let input = counter("inputTokens");
        let output = counter("outputTokens");
        let cached = counter("cachedInputTokens");
        let written = counter("cacheCreationInputTokens");
        let input_total = if current["inputTokensIncludesCache"] == false {
            input.map(|count| count.saturating_add(cached.unwrap_or(0)).saturating_add(written.unwrap_or(0)))
        } else { input };
        tokens = tokens.saturating_add(input_total.unwrap_or(0)).saturating_add(output.unwrap_or(0));
        if let (Some(input), Some(cached)) = (input_total, cached) {
            if current["inputTokensIncludesCache"].is_boolean() && cached <= input {
                eligible = eligible.saturating_add(input);
                hits = hits.saturating_add(cached);
            }
        }
    }
    Ok((tokens, (eligible > 0).then(|| hits as f64 / eligible as f64 * 100.0)))
}
