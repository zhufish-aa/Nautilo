//! Runtime event journal — port of runtime/event-service.ts.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::{json, Map, Value};
use tokio::sync::broadcast;
use uuid::Uuid;

use crate::database::Database;
use crate::errors::{CoreError, CoreResult, ErrorCode};
use crate::runtime::security::RedactionService;
use crate::database::Repositories;

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub struct EventService {
    db: Arc<Mutex<Database>>,
    redaction: RedactionService,
    sender: broadcast::Sender<Value>,
}

impl EventService {
    pub fn new(db: Arc<Mutex<Database>>, redaction: RedactionService) -> Self {
        let (sender, _) = broadcast::channel(1024);
        Self { db, redaction, sender }
    }

    /// appendForSession: builds, persists, and fans out a runtime event.
    pub fn append_for_session(
        &self,
        session: &Value,
        context: &Value,
        event_type: &str,
        payload: Value,
    ) -> CoreResult<Value> {
        let session_id = session.get("id").and_then(Value::as_str).unwrap_or("");
        let sequence = {
            let db = self.db.lock().unwrap();
            Repositories::new(&db.raw).events().next_sequence(Some(session_id), None)?
        };
        let mut event = Map::new();
        event.insert("schemaVersion".to_string(), json!(1));
        event.insert("eventId".to_string(), json!(Uuid::new_v4().to_string()));
        event.insert("sequence".to_string(), json!(sequence));
        if let Some(project_id) = session.get("projectId").cloned() {
            event.insert("projectId".to_string(), project_id);
        }
        for key in ["runId", "projectRunId", "taskId"] {
            if let Some(value) = context.get(key).cloned().filter(|v| !v.is_null()) {
                event.insert(key.to_string(), value);
            }
        }
        event.insert("sessionId".to_string(), json!(session_id));
        event.insert("type".to_string(), json!(event_type));
        event.insert("timestamp".to_string(), json!(now_iso()));
        event.insert("payload".to_string(), self.redaction.value(&payload));
        let event = Value::Object(event);
        {
            let db = self.db.lock().unwrap();
            Repositories::new(&db.raw).events().append(&event)?;
        }
        // Receivers lagging behind simply miss events; replay() is the
        // recovery path, so a send error here is not fatal.
        let _ = self.sender.send(event.clone());
        Ok(event)
    }

    pub fn replay(
        &self,
        session_id: Option<&str>,
        project_run_id: Option<&str>,
        run_id: Option<&str>,
        after_sequence: Option<i64>,
    ) -> CoreResult<Vec<Value>> {
        let db = self.db.lock().unwrap();
        Repositories::new(&db.raw).events().replay(session_id, project_run_id, run_id, after_sequence)
    }

    /// append(session, run, ...): builds the run-scoped context like the TS
    /// EventService.append convenience wrapper.
    pub fn append(&self, run: &Value, session: &Value, event_type: &str, payload: Value) -> CoreResult<Value> {
        self.append_for_session(
            session,
            &json!({
                "runId": run.get("id").cloned().unwrap_or(Value::Null),
                "projectRunId": run.get("projectRunId").cloned().unwrap_or(Value::Null),
                "taskId": run.get("taskId").cloned().unwrap_or(Value::Null)
            }),
            event_type,
            payload,
        )
    }

    pub fn subscribe_events(&self) -> broadcast::Receiver<Value> {
        self.sender.subscribe()
    }
}

