//! Snapshot-consistent incremental read models shared with the TS daemon.
use rusqlite::{params, Connection};
use serde_json::{json, Value};
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
