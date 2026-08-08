//! Provider-initiated interactions — port of application/interaction-service.ts.
//! Bridges provider questions/permission prompts to the desktop user.
//! Records are in-memory: a pending interaction cannot outlive its provider
//! process, and a daemon restart kills the process anyway.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use tokio::sync::oneshot;
use uuid::Uuid;

use crate::database::{Database, Repositories};
use crate::errors::{now_iso, CoreError, CoreResult, ErrorCode};
use crate::runtime::event_service::EventService;

const RESOLVED_HISTORY_LIMIT: usize = 50;

struct PendingInteraction {
    record: Value,
    resolve: oneshot::Sender<Value>,
}

pub struct InteractionService {
    db: Arc<Mutex<Database>>,
    events: Arc<EventService>,
    pending: Mutex<HashMap<String, PendingInteraction>>,
    resolved_history: Mutex<Vec<Value>>,
}

impl InteractionService {
    pub fn new(db: Arc<Mutex<Database>>, events: Arc<EventService>) -> Self {
        Self { db, events, pending: Mutex::new(HashMap::new()), resolved_history: Mutex::new(vec![]) }
    }

    /// Called by RunService when an adapter asks for user input; blocks until
    /// respond() resolves it.
    pub async fn request(&self, session: &Value, run_id: Option<&str>, provider_id: &str, input: Value) -> Value {
        let mut record = input.as_object().cloned().unwrap_or_default();
        record.insert("id".to_string(), json!(Uuid::new_v4().to_string()));
        record.insert("sessionId".to_string(), session.get("id").cloned().unwrap_or(Value::Null));
        if let Some(run_id) = run_id {
            record.insert("runId".to_string(), json!(run_id));
        }
        record.insert("providerId".to_string(), json!(provider_id));
        record.insert("status".to_string(), json!("pending"));
        record.insert("createdAt".to_string(), json!(now_iso()));
        let record = Value::Object(record);
        let (sender, receiver) = oneshot::channel();
        self.pending.lock().unwrap().insert(record.get("id").and_then(Value::as_str).unwrap_or("").to_string(), PendingInteraction { record: record.clone(), resolve: sender });
        let _ = self.events.append_for_session(
            session,
            &json!({ "runId": run_id }),
            "interaction.requested",
            json!({ "interaction": record }),
        );
        receiver.await.unwrap_or_else(|_| json!({ "outcome": "cancelled" }))
    }

    pub fn respond(&self, interaction_id: &str, response: &Value) -> CoreResult<Value> {
        let pending = self.pending.lock().unwrap().remove(interaction_id);
        let Some(pending) = pending else {
            let mut details = serde_json::Map::new();
            details.insert("interactionId".to_string(), json!(interaction_id));
            return Err(CoreError::details(ErrorCode::InteractionNotFound, details));
        };
        let mut record = pending.record.as_object().cloned().unwrap_or_default();
        record.insert(
            "status".to_string(),
            json!(if response.get("outcome").and_then(Value::as_str) == Some("cancelled") { "cancelled" } else { "resolved" }),
        );
        record.insert("response".to_string(), response.clone());
        record.insert("resolvedAt".to_string(), json!(now_iso()));
        let record = Value::Object(record);
        let session_id = record.get("sessionId").and_then(Value::as_str).unwrap_or("");
        let session = Repositories::new(&self.db.lock().unwrap().raw)
            .sessions()
            .get(session_id)?
            .ok_or_else(|| crate::errors::not_found("session", session_id))?;
        let _ = self.events.append_for_session(
            &session,
            &json!({ "runId": record.get("runId").cloned().unwrap_or(Value::Null) }),
            "interaction.resolved",
            json!({ "interaction": record }),
        );
        self.remember(record.clone());
        let _ = pending.resolve.send(response.clone());
        Ok(record)
    }

    pub fn list(&self, session_id: Option<&str>, status: Option<&str>) -> Vec<Value> {
        let mut all: Vec<Value> = self
            .pending
            .lock()
            .unwrap()
            .values()
            .map(|entry| entry.record.clone())
            .chain(self.resolved_history.lock().unwrap().iter().cloned())
            .collect();
        all.retain(|record| {
            (session_id.is_none() || record.get("sessionId").and_then(Value::as_str) == session_id)
                && (status.is_none() || record.get("status").and_then(Value::as_str) == status)
        });
        all.sort_by(|a, b| {
            a.get("createdAt").and_then(Value::as_str).unwrap_or("").cmp(b.get("createdAt").and_then(Value::as_str).unwrap_or(""))
        });
        all
    }

    /// Auto-cancels everything a finished/cancelled run was still waiting on.
    pub fn cancel_for_run(&self, run_id: &str) {
        let entries: Vec<(String, PendingInteraction)> = {
            let mut pending = self.pending.lock().unwrap();
            let ids: Vec<String> = pending
                .iter()
                .filter(|(_, entry)| entry.record.get("runId").and_then(Value::as_str) == Some(run_id))
                .map(|(id, _)| id.clone())
                .collect();
            ids.into_iter().filter_map(|id| pending.remove(&id).map(|entry| (id, entry))).collect()
        };
        for (_, entry) in entries {
            let mut record = entry.record.as_object().cloned().unwrap_or_default();
            record.insert("status".to_string(), json!("cancelled"));
            record.insert("response".to_string(), json!({ "outcome": "cancelled" }));
            record.insert("resolvedAt".to_string(), json!(now_iso()));
            self.remember(Value::Object(record));
            let _ = entry.resolve.send(json!({ "outcome": "cancelled" }));
        }
    }

    fn remember(&self, record: Value) {
        let mut history = self.resolved_history.lock().unwrap();
        history.push(record);
        if history.len() > RESOLVED_HISTORY_LIMIT {
            history.remove(0);
        }
    }
}
