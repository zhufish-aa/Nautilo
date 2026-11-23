//! Runtime event journal — port of runtime/event-service.ts.

use std::sync::{Arc, Mutex};

use serde_json::{json, Map, Value};
use tokio::sync::broadcast;
use uuid::Uuid;
use std::io::Write;

use crate::database::Database;
use crate::errors::CoreResult;
use crate::runtime::security::redaction_service::RedactionSnapshot;
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

/// Prepares redacted envelopes inside a transaction without accessing storage.
pub(crate) struct SessionEventBuilder {
    redaction: RedactionSnapshot,
}

impl SessionEventBuilder {
    pub(crate) fn redact(&self, payload: &Value) -> Value {
        self.redaction.value(payload)
    }

    pub(crate) fn prepare_for_session(
        &self,
        session: &Value,
        context: &Value,
        event_type: &str,
        payload: Value,
    ) -> Value {
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
        if context["background"] == true { event.insert("background".into(), json!(true)); }
        event.insert("timestamp".to_string(), json!(now_iso()));
        event.insert("payload".to_string(), self.redact(&payload));
        Value::Object(event)
    }
}

impl EventService {
    pub(crate) fn wake_timeline(&self, session_id: &str) {
        let _ = self.sender.send(json!({"sessionId":session_id}));
    }

    pub fn publish_committed(&self,events:&[Value]) {
        for event in events {
            publish_browser_run(event);
            let _=self.sender.send(event.clone());
        }
    }
    pub fn new(db: Arc<Mutex<Database>>, redaction: RedactionService) -> Self {
        let (sender, _) = broadcast::channel(1024);
        Self { db, redaction, sender }
    }

    /// Take the credential snapshot before acquiring a database write guard.
    pub(crate) fn session_event_builder(&self) -> SessionEventBuilder {
        SessionEventBuilder { redaction: self.redaction.snapshot() }
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
        let mut event = self.session_event_builder().prepare_for_session(session, context, event_type, payload);
        {
            let db = self.db.lock().unwrap();
            // Allocates + inserts under one IMMEDIATE transaction and fills in
            // event.sequence; two daemons sharing a data dir cannot collide.
            Repositories::new(&db.raw).events().append_allocating_sequence(&mut event, Some(session_id), None)?;
        }
        publish_browser_run(&event);
        // Receivers lagging behind simply miss events; replay() is the
        // recovery path, so a send error here is not fatal.
        let _ = self.sender.send(event.clone());
        Ok(event)
    }

    pub fn timeline_open(&self, session_id: &str) -> CoreResult<Value> {
        crate::database::timeline::open(&self.db.lock().unwrap().raw, session_id)
    }

    pub async fn timeline_wait(&self, session_id: &str, revision: i64, timeout_ms: u64) -> CoreResult<Value> {
        if session_id.is_empty() { return Err(crate::errors::invalid("sessionId", "A session is required")); }
        let mut wake = self.sender.subscribe();
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(timeout_ms.clamp(50, 25_000));
        loop {
            let page = crate::database::timeline::changes(&self.db.lock().unwrap().raw, session_id, revision)?;
            if page["reset"] == true || page["revision"].as_i64() != Some(revision) || tokio::time::Instant::now() >= deadline {
                return Ok(page);
            }
            match tokio::time::timeout_at(deadline, wake.recv()).await {
                Ok(Ok(event)) if event["sessionId"] != session_id => continue,
                Ok(Ok(_)) | Ok(Err(broadcast::error::RecvError::Lagged(_))) => continue,
                _ => return crate::database::timeline::changes(&self.db.lock().unwrap().raw, session_id, revision),
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
                "taskId": run.get("taskId").cloned().unwrap_or(Value::Null),
                "background": run["backgroundEvent"]
            }),
            event_type,
            payload,
        )
    }

    pub fn subscribe_events(&self) -> broadcast::Receiver<Value> {
        self.sender.subscribe()
    }
}

fn browser_run_update(event: &Value) -> Option<Value> {
    let state = match event["type"].as_str()? {
        "run.started" => "running", "run.waiting" => "waiting",
        "run.completed" => "completed", "run.cancelled" => "cancelled", "run.failed" => "failed", _ => return None,
    };
    Some(json!({"event":"browser.run","sessionId":event["sessionId"].as_str()?,"runId":event["runId"].as_str()?,"sequence":event["sequence"].as_u64()?,"state":state}))
}
fn publish_browser_run(event: &Value) {
    if std::env::var("NAUTILO_BROWSER_STREAM").as_deref() != Ok("1") { return; }
    if let Some(packet) = browser_run_update(event) {
        let mut out = std::io::stdout().lock();
        let _ = writeln!(out,"{packet}");
        let _ = out.flush();
    }
}

#[cfg(test)]
mod browser_lifecycle_tests {
    use super::*;
    #[test]
    fn lifecycle_is_tied_to_runs_not_individual_tools() {
        for (kind,state) in [("run.started","running"),("run.waiting","waiting"),("run.completed","completed"),("run.failed","failed"),("run.cancelled","cancelled")] {
            let update=browser_run_update(&json!({"sessionId":"s","runId":"r","sequence":4,"type":kind,"payload":{"text":"not forwarded"}})).unwrap();
            assert_eq!(update["state"],state);assert!(update.get("payload").is_none());
        }
        assert!(browser_run_update(&json!({"sessionId":"s","runId":"r","sequence":5,"type":"tool.finished"})).is_none());
    }
}

