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
    /// Latest unsent delta per stream + whether a flush task is scheduled.
    /// Streaming deltas are journaled with cumulative text, so every poll
    /// wake re-transfers the whole accumulated row; coalescing broadcasts to
    /// 100 ms keeps poll churn linear instead of per-chunk.
    pending_deltas: Arc<Mutex<(HashMap<String, Value>, bool)>>,
}

impl EventService {
    pub fn new(db: Arc<Mutex<Database>>, redaction: RedactionService) -> Self {
        let (sender, _) = broadcast::channel(1024);
        Self { db, redaction, sender, pending_deltas: Arc::new(Mutex::new((HashMap::new(), false))) }
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
        let mut event = Map::new();
        event.insert("schemaVersion".to_string(), json!(1));
        event.insert("eventId".to_string(), json!(Uuid::new_v4().to_string()));
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
        let mut event = Value::Object(event);
        {
            let db = self.db.lock().unwrap();
            // Allocates + inserts under one IMMEDIATE transaction and fills in
            // event.sequence; two daemons sharing a data dir cannot collide.
            Repositories::new(&db.raw).events().append_allocating_sequence(&mut event, Some(session_id), None)?;
        }
        // Receivers lagging behind simply miss events; replay() is the
        // recovery path, so a send error here is not fatal.
        if event_type.ends_with("_delta") {
            self.queue_delta_broadcast(session_id, event_type, &event);
        } else {
            // A structural/terminal event must not overtake a pending delta of
            // the same session — flush first, or a poller could advance past
            // the final chunk of a stream and freeze its text mid-way.
            self.flush_pending_deltas(Some(session_id));
            let _ = self.sender.send(event.clone());
        }
        Ok(event)
    }

    /// Coalesced delta broadcast: stash the newest snapshot per stream and
    /// flush all streams 100 ms later (at most ~10 wakes/sec instead of one
    /// wake per chunk, each re-sending the full accumulated text).
    fn queue_delta_broadcast(&self, session_id: &str, event_type: &str, event: &Value) {
        let message_id = event.pointer("/payload/messageId").and_then(Value::as_str).unwrap_or("");
        let key = format!("{session_id}:{event_type}:{message_id}");
        let schedule = {
            let mut pending = self.pending_deltas.lock().unwrap();
            pending.0.insert(key, event.clone());
            if pending.1 {
                false
            } else {
                pending.1 = true;
                true
            }
        };
        if schedule {
            let pending = self.pending_deltas.clone();
            let sender = self.sender.clone();
            tokio::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                let events = {
                    let mut pending = pending.lock().unwrap();
                    pending.1 = false;
                    pending.0.drain().map(|(_, event)| event).collect::<Vec<_>>()
                };
                for event in events {
                    let _ = sender.send(event);
                }
            });
        }
    }

    /// Immediately broadcasts stashed deltas (optionally one session only).
    fn flush_pending_deltas(&self, session_id: Option<&str>) {
        let events = {
            let mut pending = self.pending_deltas.lock().unwrap();
            match session_id {
                Some(session_id) => {
                    let mut drained = Vec::new();
                    pending.0.retain(|_, event| {
                        if event.get("sessionId").and_then(Value::as_str) == Some(session_id) {
                            drained.push(std::mem::take(event));
                            false
                        } else {
                            true
                        }
                    });
                    drained
                }
                None => pending.0.drain().map(|(_, event)| event).collect(),
            }
        };
        for event in events {
            if !event.is_null() {
                let _ = self.sender.send(event);
            }
        }
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

