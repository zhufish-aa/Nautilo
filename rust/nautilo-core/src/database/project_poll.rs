//! One project poll shares a WAL snapshot; event cursors remain session-local.
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use crate::database::Repositories;
use crate::database::connection::db_fail;
use crate::database::history_projection::read_snapshot;
use crate::errors::{CoreError, CoreResult, ErrorCode};

fn string<'a>(value: &'a Value, key: &str) -> &'a str { value.get(key).and_then(Value::as_str).unwrap_or("") }
fn sessions(db: &Connection, input: &Value) -> CoreResult<Vec<Value>> {
    if string(input, "projectRunId").is_empty() || ["sessions", "visibleSessionIds"].iter().any(|key| {
        input.get(*key).is_some_and(|value| value.as_array().is_none_or(|items| items.len() > 2048))
    }) { return Err(CoreError::reason(ErrorCode::IpcInvalidRequest, "projectRun.poll requires a project run and at most 2048 session cursors")); }
    let repos = Repositories::new(db);
    let project = repos.project_runs().get(string(input, "projectRunId"))?.ok_or_else(|| CoreError::reason(ErrorCode::IpcNotFound, "project run not found"))?;
    Ok(repos.sessions().list(string(&project, "projectId"), None)?.into_iter().filter(|session| string(session, "projectRunId") == string(input, "projectRunId")).collect())
}
fn clock(db: &Connection) -> CoreResult<(String, i64)> {
    db.query_row("SELECT epoch, revision FROM read_projection_clock WHERE id = 1", [], |row| Ok((row.get(0)?, row.get(1)?))).map_err(db_fail)
}
pub fn last_sequence(db: &Connection, id: &str) -> CoreResult<i64> {
    db.query_row("SELECT COALESCE(MAX(sequence), 0) FROM runtime_events WHERE session_id = ?1", [id], |row| row.get(0)).map_err(db_fail)
}
fn reset(db: &Connection, id: &str, cursor: Option<&Value>, epoch: &str, revision: i64, sequence: i64) -> CoreResult<bool> {
    let invalidation: i64 = db.query_row("SELECT COALESCE(MAX(revision), 0) FROM read_projection_invalidations WHERE scope IN (?1, ?2)", params![format!("events:session:{id}"), format!("messages:session:{id}")], |row| row.get(0)).map_err(db_fail)?;
    Ok(!cursor.is_some_and(|cursor| {
        string(cursor, "epoch") == epoch && string(cursor, "scope") == format!("events:session:{id}")
            && cursor.get("sequence").and_then(Value::as_i64).is_some_and(|after| after >= 0 && after <= sequence)
            && cursor.get("revision").and_then(Value::as_i64).is_some_and(|after| after >= invalidation && after <= revision && after <= 9_007_199_254_740_991)
    }))
}
fn cursors(input: &Value) -> HashMap<&str, &Value> {
    input.get("sessions").and_then(Value::as_array).into_iter().flatten().map(|item| (string(item, "sessionId"), item)).collect()
}
pub fn heal_ids(db: &Connection, input: &Value) -> CoreResult<Vec<String>> {
    read_snapshot(db, || {
        let (epoch, revision) = clock(db)?;
        let cursors = cursors(input);
        let mut ids = Vec::new();
        let sessions = sessions(db, input)?;
        if sessions.len() > 64 { return Ok(ids); }
        for session in sessions {
            let id = string(&session, "id");
            if reset(db, id, cursors.get(id).and_then(|item| item.get("eventCursor")), &epoch, revision, last_sequence(db, id)?)? { ids.push(id.to_string()); }
        }
        Ok(ids)
    })
}
pub fn read(db: &Connection, input: &Value, follow_ups: Vec<Value>) -> CoreResult<Value> {
    read_snapshot(db, || {
        let sessions = sessions(db, input)?;
        let repos = Repositories::new(db);
        let project = repos.project_runs().get(string(input, "projectRunId"))?.ok_or_else(|| CoreError::reason(ErrorCode::IpcNotFound, "project run not found"))?;
        if sessions.len() > 64 { return Ok(json!({ "fallback": true, "projectRun": project })); }
        let (epoch, revision) = clock(db)?;
        let cursors = cursors(input);
        let mut needed: HashSet<String> = input.get("visibleSessionIds").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str)
            .filter(|id| sessions.iter().any(|session| string(session, "id") == *id)).map(str::to_string).collect();
        loop {
            let before = needed.len();
            for session in &sessions { if needed.contains(string(session, "parentSessionId")) { needed.insert(string(session, "id").to_string()); } }
            if needed.len() == before { break; }
        }
        let mut feeds = Vec::new();
        let mut histories = Vec::new();
        for session in &sessions {
            let id = string(session, "id");
            let previous = cursors.get(id).and_then(|item| item.get("eventCursor"));
            let sequence = last_sequence(db, id)?;
            let reset = reset(db, id, previous, &epoch, revision, sequence)?;
            let after = if reset { 0 } else { previous.and_then(|cursor| cursor.get("sequence")).and_then(Value::as_i64).unwrap_or(0) };
            let events = repos.events().replay(Some(id), None, None, Some(after))?;
            feeds.push(json!({ "sessionId": id, "reset": reset, "events": events, "cursor": { "epoch": epoch, "revision": revision, "scope": format!("events:session:{id}"), "sequence": sequence } }));
            if needed.contains(id) { histories.push(repos.sessions().history(id, cursors.get(id).and_then(|item| item.get("historyCursor")))?); }
        }
        let mut statement = db.prepare("SELECT runs.data FROM runs JOIN sessions ON sessions.id = runs.session_id WHERE sessions.project_id = ?1 AND json_extract(sessions.data, '$.projectRunId') = ?2 ORDER BY runs.updated_at DESC").map_err(db_fail)?;
        let runs = statement.query_map(params![string(&project, "projectId"), string(input, "projectRunId")], |row| row.get::<_, String>(0)).map_err(db_fail)?.collect::<Result<Vec<_>, _>>().map_err(db_fail)?.into_iter().map(|data| serde_json::from_str::<Value>(&data).unwrap_or(Value::Null)).collect::<Vec<_>>();
        let follow_ups = follow_ups.into_iter().filter(|item| sessions.iter().any(|session| string(session, "id") == string(item, "sessionId"))).collect::<Vec<_>>();
        Ok(json!({
            "projectRun": project, "sessions": sessions, "runs": runs,
            "tasks": repos.tasks().list(string(input, "projectRunId"))?,
            "verifications": repos.verifications().list(string(input, "projectRunId"), None)?,
            "artifacts": repos.artifacts().changes(&json!({ "projectRunId": input.get("projectRunId"), "cursor": input.get("artifactCursor") }))?,
            "feeds": feeds, "histories": histories, "followUps": follow_ups
        }))
    })
}
