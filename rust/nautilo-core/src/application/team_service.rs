//! Team service — port of application/team-service.ts.

use std::sync::{Arc, Mutex};

use serde_json::{json, Map, Value};

use crate::database::{lock, Database, Repositories};
use crate::errors::{invalid, not_found, now_iso, CoreError, CoreResult, ErrorCode};


pub struct TeamService {
    db: Arc<Mutex<Database>>,
}

impl TeamService {
    pub fn new(db: Arc<Mutex<Database>>) -> Self {
        Self { db }
    }

    pub fn list(&self) -> CoreResult<Vec<Value>> {
        Repositories::new(&lock(&self.db).raw).teams().list_default()
    }

    pub fn get(&self, id: &str) -> CoreResult<Value> {
        Repositories::new(&lock(&self.db).raw).teams().get(id)?.ok_or_else(|| not_found("team", id))
    }

    pub fn upsert(&self, team: &Value) -> CoreResult<Value> {
        let updated_at = team.get("updatedAt").and_then(Value::as_str).unwrap_or("").to_string();
        Repositories::new(&lock(&self.db).raw).teams().save(team, &updated_at)?;
        Ok(team.clone())
    }

    pub fn remove(&self, id: &str) -> CoreResult<Value> {
        Repositories::new(&lock(&self.db).raw).teams().remove(id)?;
        Ok(json!({ "removed": true }))
    }
}
