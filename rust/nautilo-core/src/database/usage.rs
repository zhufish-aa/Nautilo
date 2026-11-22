use rusqlite::{params, Connection};
use serde_json::{json, Value};

use crate::database::connection::db_fail;
use crate::errors::{invalid, CoreResult};

pub fn read(db: &Connection, input: &Value) -> CoreResult<Value> {
    let mut query = db.prepare(include_str!("../../../../packages/schemas/src/usage-source.sql")).map_err(db_fail)?;
    let rows = query.query_map(params![
        input["projectId"].as_str().unwrap_or(""),
        input["sessionId"].as_str().unwrap_or("")
    ], |row| row.get::<_, String>(0)).map_err(db_fail)?;
    let rows = rows.map(|row| {
        serde_json::from_str::<Value>(&row.map_err(db_fail)?).map_err(|error| invalid("usage", &error.to_string()))
    }).collect::<CoreResult<Vec<_>>>()?;
    Ok(json!({ "rows": rows }))
}
