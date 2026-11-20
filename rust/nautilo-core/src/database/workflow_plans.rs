use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;

use crate::database::connection::db_fail;
use crate::errors::{invalid, CoreResult};

pub fn get(db: &Connection, session_id: &str, id: &str) -> CoreResult<Option<Value>> {
    let raw: Option<String> = db.query_row(
        "SELECT data FROM workflow_plans WHERE id=?1 AND session_id=?2",
        params![id, session_id],
        |row| row.get(0),
    ).optional().map_err(db_fail)?;
    raw.map(|value| serde_json::from_str(&value).map_err(|error| invalid("workflowPlan", &error.to_string())))
        .transpose()
}

pub fn insert(db: &Connection, plan: &Value) -> CoreResult<()> {
    db.execute(
        "INSERT INTO workflow_plans(id,session_id,status,data) VALUES(?1,?2,'pending',?3)",
        params![plan["id"].as_str(), plan["sessionId"].as_str(), plan.to_string()],
    ).map_err(db_fail)?;
    Ok(())
}

pub fn decide(db: &Connection, plan: &Value) -> CoreResult<()> {
    let changed = db.execute(
        "UPDATE workflow_plans SET status=?3,data=?4 WHERE id=?1 AND session_id=?2 AND status='pending'",
        params![plan["id"].as_str(), plan["sessionId"].as_str(), plan["status"].as_str(), plan.to_string()],
    ).map_err(db_fail)?;
    if changed != 1 {
        return Err(invalid("workflowPlan", "This workflow plan has already been decided"));
    }
    Ok(())
}
