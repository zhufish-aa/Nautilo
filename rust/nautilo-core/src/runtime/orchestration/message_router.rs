//! Message routing — port of runtime/orchestration/message-router.ts.

use std::sync::{Arc, Mutex};

use serde_json::{json, Map, Value};
use uuid::Uuid;

use crate::database::{Database, Repositories};
use crate::errors::{now_iso, CoreResult};

pub struct MessageRouter {
    db: Arc<Mutex<Database>>,
}

impl MessageRouter {
    pub fn new(db: Arc<Mutex<Database>>) -> Self {
        Self { db }
    }

    pub fn user_goal(&self, session: &Value, project_run: &Value) -> CoreResult<Value> {
        self.save(
            session,
            &json!({
                "sender": "user",
                "kind": "chat",
                "projectRunId": project_run.get("id").cloned().unwrap_or(Value::Null),
                "toMemberId": project_run.get("mainMemberId").cloned().unwrap_or(Value::Null),
                "attachmentIds": [],
                "text": project_run.get("goal").cloned().unwrap_or(Value::Null)
            }),
        )
    }

    pub fn delegation(&self, main: &Value, child: &Value, project_run: &Value, task: &Value) -> CoreResult<()> {
        let correlation_id = Uuid::new_v4().to_string();
        let route = json!({
            "sender": "system",
            "kind": "delegation",
            "projectRunId": project_run.get("id").cloned().unwrap_or(Value::Null),
            "taskId": task.get("id").cloned().unwrap_or(Value::Null),
            "fromMemberId": project_run.get("mainMemberId").cloned().unwrap_or(Value::Null),
            "toMemberId": task.get("assignedMemberId").cloned().unwrap_or(Value::Null),
            "correlationId": correlation_id,
            "text": format!("Delegated task {}: {}", task.get("id").and_then(Value::as_str).unwrap_or(""), task.get("title").and_then(Value::as_str).unwrap_or(""))
        });
        self.save(main, &route)?;
        self.save(child, &route)?;
        Ok(())
    }

    pub fn result(&self, main: &Value, project_run: &Value, task: &Value, text: &str) -> CoreResult<Value> {
        self.save(
            main,
            &json!({
                "sender": "system",
                "kind": "result",
                "projectRunId": project_run.get("id").cloned().unwrap_or(Value::Null),
                "taskId": task.get("id").cloned().unwrap_or(Value::Null),
                "fromMemberId": task.get("assignedMemberId").cloned().unwrap_or(Value::Null),
                "toMemberId": project_run.get("mainMemberId").cloned().unwrap_or(Value::Null),
                "text": text
            }),
        )
    }

    pub fn system(&self, session: &Value, project_run: &Value, text: &str, kind: &str) -> CoreResult<Value> {
        self.save(
            session,
            &json!({
                "sender": "system",
                "kind": kind,
                "projectRunId": project_run.get("id").cloned().unwrap_or(Value::Null),
                "text": text
            }),
        )
    }

    fn save(&self, session: &Value, fields: &Value) -> CoreResult<Value> {
        let mut message = Map::new();
        message.insert("id".to_string(), json!(Uuid::new_v4().to_string()));
        message.insert("sessionId".to_string(), session.get("id").cloned().unwrap_or(Value::Null));
        message.insert("createdAt".to_string(), json!(now_iso()));
        if let Some(fields) = fields.as_object() {
            for (key, value) in fields {
                if value.is_null() {
                    continue;
                }
                message.insert(key.clone(), value.clone());
            }
        }
        let message = Value::Object(message);
        Repositories::new(&self.db.lock().unwrap().raw).sessions().save_message(&message)?;
        Ok(message)
    }
}
