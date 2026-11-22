//! Snapshot-consistent incremental read models shared with the TS daemon.
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use crate::database::connection::db_fail;
use crate::errors::CoreResult;

pub fn read_snapshot<T>(db: &Connection, read: impl FnOnce() -> CoreResult<T>) -> CoreResult<T> {
    db.execute_batch("SAVEPOINT history_projection_read").map_err(db_fail)?;
    match read() {
        Ok(value) => {
            db.execute_batch("RELEASE history_projection_read").map_err(db_fail)?;
            Ok(value)
        }
        Err(error) => {
            let _ = db.execute_batch("ROLLBACK TO history_projection_read; RELEASE history_projection_read");
            Err(error)
        }
    }
}

pub fn read_projection(db: &Connection, table: &str, scope: &str, cursor: Option<&Value>) -> CoreResult<Value> {
    // Callers supply one of these literals; never interpolate IPC input into SQL.
    assert!(table == "messages" || table == "artifacts");
    let (epoch, revision): (String, i64) = db.query_row(
        "SELECT epoch, revision FROM read_projection_clock WHERE id = 1", [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    ).map_err(db_fail)?;
    let invalidation: i64 = db.query_row(
        "SELECT COALESCE((SELECT revision FROM read_projection_invalidations WHERE scope = ?1), 0)",
        [scope], |row| row.get(0),
    ).map_err(db_fail)?;
    let after = cursor.and_then(|value| value.get("revision")).and_then(Value::as_i64);
    let reset = !cursor.is_some_and(|value| {
        value.get("epoch").and_then(Value::as_str) == Some(epoch.as_str())
            && value.get("scope").and_then(Value::as_str) == Some(scope)
            && after.is_some_and(|after| after >= invalidation && after >= 0 && after <= revision && after <= 9_007_199_254_740_991)
    });
    let scope_guard = if table == "messages" {
        "revision.scope = 'messages:session:' || entity.session_id"
    } else {
        "(revision.scope = 'artifacts:session:' || entity.session_id OR revision.scope = 'artifacts:projectRun:' || entity.project_run_id)"
    };
    let mut stmt = db.prepare(&format!(
        "SELECT entity.data, entity.created_at, entity.rowid FROM read_projection_rows AS revision \
         JOIN {table} AS entity ON entity.id = revision.item_id \
         WHERE revision.scope = ?1 AND revision.revision > ?2 AND {scope_guard} ORDER BY entity.created_at, entity.rowid"
    )).map_err(db_fail)?;
    let items = stmt.query_map(params![scope, if reset { -1 } else { after.unwrap_or(0) }], |row| {
        let data: String = row.get(0)?;
        let created_at: String = row.get(1)?;
        let ordinal: i64 = row.get(2)?;
        Ok(json!({ "value": serde_json::from_str::<Value>(&data).unwrap_or(Value::Null), "order": { "createdAt": created_at, "ordinal": ordinal } }))
    }).map_err(db_fail)?.collect::<Result<Vec<_>, _>>().map_err(db_fail)?;
    Ok(json!({ "cursor": { "epoch": epoch, "scope": scope, "revision": revision }, "reset": reset, "items": items }))
}

/// Old OMP processes reused numbered message IDs after a restart. Repair the
/// read model only when the journal shows a cancelled origin and a new process
/// answering a later user turn. Leave saved messages and events untouched.
pub(super) fn recover_legacy_omp_replies(
    db: &Connection,
    session: &str,
    items: &mut [Value],
) -> CoreResult<HashMap<String, (String, i64)>> {
    let candidates: HashMap<_, _> = items.iter().filter_map(|item| {
        let message = &item["value"];
        if message["sender"] != "agent" || message["background"] != true { return None; }
        Some((message["id"].as_str()?, message["runId"].as_str()?))
    }).collect();
    if candidates.is_empty() { return Ok(HashMap::new()); }

    let mut statement = db.prepare("SELECT data FROM runtime_events WHERE session_id = ?1 AND (
        json_extract(data, '$.type') IN ('run.started','run.cancelled','run.failed','run.completed','provider.runtime_ready')
        OR (json_extract(data, '$.type') = 'agent.message' AND json_extract(data, '$.background') = 1
            AND json_extract(data, '$.payload.messageId') IN (SELECT value FROM json_each(?2))))
        ORDER BY sequence, rowid").map_err(db_fail)?;
    let ids = json!(candidates.keys().collect::<Vec<_>>()).to_string();
    let log = statement.query_map(params![session, ids], |row| row.get::<_, String>(0)).map_err(db_fail)?;
    let mut active = None;
    let mut omp_processes = HashMap::new();
    let mut cancelled = HashSet::new();
    let mut recovered = HashMap::new();
    for raw in log {
        let event: Value = serde_json::from_str(&raw.map_err(db_fail)?).unwrap_or(Value::Null);
        let Some(run) = event["runId"].as_str() else { continue; };
        let payload = &event["payload"];
        match event["type"].as_str().unwrap_or("") {
            "run.started" if event["background"] != true => {
                active = payload["userMessageId"].as_str().map(|_| run.to_owned());
            }
            "provider.runtime_ready" if event["background"] != true && payload["providerId"] == "omp" => {
                if let Some(pid) = payload["pid"].as_u64().filter(|pid| *pid > 0) {
                    omp_processes.insert(run.to_owned(), (pid, payload["reused"] == false));
                }
            }
            "run.completed" | "run.failed" | "run.cancelled" => {
                if event["type"] == "run.cancelled" { cancelled.insert(run.to_owned()); }
                if active.as_deref() == Some(run) { active = None; }
            }
            "agent.message" if cancelled.contains(run) && payload["subagentDispatchId"].is_null() => {
                let Some(target) = active.as_ref().filter(|target| target.as_str() != run) else { continue; };
                let Some((old_pid, _)) = omp_processes.get(run) else { continue; };
                let Some((new_pid, true)) = omp_processes.get(target) else { continue; };
                if old_pid == new_pid { continue; }
                let Some(id) = payload["messageId"].as_str() else { continue; };
                let native_id = payload["providerMessageId"].as_str().and_then(|id| id.strip_prefix("omp-message-"));
                if candidates.get(id) == Some(&run) && native_id.is_some_and(|id| !id.is_empty() && id.bytes().all(|ch| ch.is_ascii_digit())) {
                    if let Some(sequence) = event["sequence"].as_i64() {
                        recovered.insert(id.to_owned(), (target.clone(), sequence));
                    }
                }
            }
            _ => {}
        }
    }
    for item in items {
        if let Some((run, _)) = item["value"]["id"].as_str().and_then(|id| recovered.get(id)) {
            item["value"]["runId"] = json!(run);
            item["value"].as_object_mut().unwrap().remove("background");
        }
    }
    Ok(recovered)
}
