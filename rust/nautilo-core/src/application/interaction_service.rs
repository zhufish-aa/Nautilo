//! Provider-initiated interactions — port of application/interaction-service.ts.
//! Bridges provider questions/permission prompts to the desktop user.
//! Records are in-memory: a pending interaction cannot outlive its provider
//! process, and a daemon restart kills the process anyway.

use std::collections::{HashMap, HashSet, VecDeque};
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
#[derive(Default)]
struct Lifecycle {closed:HashSet<String>,order:VecDeque<String>,cancelled_native:HashSet<(String,String)>}

pub struct InteractionService {
    db: Arc<Mutex<Database>>,
    events: Arc<EventService>,
    pending: Mutex<HashMap<String, PendingInteraction>>,
    resolved_history: Mutex<Vec<Value>>,
    /// Sessions whose journal was already scanned for orphaned requests in
    /// this process — the scan is idempotent, so run it once per session.
    healed_sessions: Mutex<HashSet<String>>,
    lifecycle:Mutex<Lifecycle>,
}

impl InteractionService {
    pub fn new(db: Arc<Mutex<Database>>, events: Arc<EventService>) -> Self {
        Self {
            db,
            events,
            pending: Mutex::new(HashMap::new()),
            resolved_history: Mutex::new(vec![]),
            healed_sessions: Mutex::new(HashSet::new()),
            lifecycle:Mutex::new(Lifecycle::default()),
        }
    }

    /// Called by RunService when an adapter asks for user input; blocks until
    /// respond() resolves it.
    pub async fn request(&self, session: &Value, run_id: Option<&str>, provider_id: &str, input: Value) -> Value {
        let (record,receiver)={
        let native_key = (run_id.map(str::to_string).unwrap_or_else(||format!("session:{}",session["id"].as_str().unwrap_or(""))), input["nativeRequestId"].as_str().unwrap_or("").to_string());
        let lifecycle=self.lifecycle.lock().unwrap();
        if run_id.is_some_and(|id|lifecycle.closed.contains(id)) || lifecycle.cancelled_native.contains(&native_key) { return json!({"outcome":"cancelled"}); }
        if let Some(run_id)=run_id {
            if Repositories::new(&self.db.lock().unwrap().raw).runs().get(run_id).ok().flatten().is_some_and(|run|matches!(run["status"].as_str(),Some("completed"|"cancelled"|"failed"|"crashed"|"timed_out"))){return json!({"outcome":"cancelled"});}
        }
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
        let recorded = self.events.append_for_session(
            session,
            &json!({ "runId": run_id }),
            "interaction.requested",
            json!({ "interaction": record }),
        );
        if recorded.is_err(){self.pending.lock().unwrap().remove(record["id"].as_str().unwrap_or(""));return json!({"outcome":"cancelled"});}
        drop(lifecycle);
        (record,receiver)
        };
        let _pending_guard=PendingRequestGuard{service:self,id:record["id"].as_str().unwrap_or("").to_string()};
        if let Some(ms) = input["timeoutMs"].as_u64() {
            match tokio::time::timeout(std::time::Duration::from_millis(ms), receiver).await {
                Ok(response) => response.unwrap_or_else(|_|json!({"outcome":"cancelled"})),
                Err(_) => { let _ = self.respond(record["id"].as_str().unwrap_or(""), &json!({"outcome":"cancelled"})); json!({"outcome":"cancelled"}) }
            }
        } else { receiver.await.unwrap_or_else(|_| json!({ "outcome": "cancelled" })) }
    }

    pub fn cancel_native(&self, run_id: &str, native_id: &str) {
        let mut lifecycle=self.lifecycle.lock().unwrap();
        lifecycle.cancelled_native.insert((run_id.to_string(), native_id.to_string()));
        let ids: Vec<String> = self.pending.lock().unwrap().iter().filter(|(_, entry)|
            entry.record["runId"] == run_id && entry.record["nativeRequestId"] == native_id).map(|(id, _)|id.clone()).collect();
        for id in ids { let _ = self.respond(&id, &json!({"outcome":"cancelled"})); }
    }
    pub fn cancel_session_native(&self, session_id: &str, native_id: &str) {
        let mut lifecycle=self.lifecycle.lock().unwrap();
        lifecycle.cancelled_native.insert((format!("session:{session_id}"),native_id.to_string()));
        let ids:Vec<String>=self.pending.lock().unwrap().iter().filter(|(_,entry)|entry.record["sessionId"]==session_id && entry.record["runId"].is_null() && entry.record["nativeRequestId"]==native_id).map(|(id,_)|id.clone()).collect();
        for id in ids {let _=self.respond(&id,&json!({"outcome":"cancelled"}));}
    }
    pub fn cancel_for_session(&self, session_id:&str) {
        let ids:Vec<String>=self.pending.lock().unwrap().iter().filter(|(_,entry)|entry.record["sessionId"]==session_id).map(|(id,_)|id.clone()).collect();
        for id in ids {let _=self.respond(&id,&json!({"outcome":"cancelled"}));}
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

    /// Journals a cancellation for every interaction.requested in this
    /// session's journal that has no matching interaction.resolved. Pending
    /// records are in-memory by design, so a daemon restart orphans them and
    /// every full event replay would resurrect the card as pending forever.
    /// Runs once per session per process; best-effort.
    pub fn heal_orphaned(&self, session_id: &str) {
        if session_id.is_empty() || !self.healed_sessions.lock().unwrap().insert(session_id.to_string()) {
            return;
        }
        let journal: Vec<Value> = {
            let db = self.db.lock().unwrap();
            let mut statement = match db.raw.prepare(
                "SELECT data FROM runtime_events WHERE session_id = ?1 \
                 AND json_extract(data, '$.type') IN ('interaction.requested', 'interaction.resolved') \
                 ORDER BY sequence, rowid",
            ) {
                Ok(statement) => statement,
                Err(_) => return,
            };
            let rows = match statement.query_map([session_id], |row| row.get::<_, String>(0)) {
                Ok(rows) => rows.filter_map(|row| row.ok()).filter_map(|data| serde_json::from_str(&data).ok()).collect(),
                Err(_) => return,
            };
            rows
        };
        // Fold in journal order: a resolved id cancels its request; a repeated
        // request id (cannot happen with UUIDs, but stay safe) re-opens it.
        let mut open: Vec<(String, Value)> = Vec::new();
        for event in &journal {
            let interaction = event.get("payload").and_then(|payload| payload.get("interaction")).cloned().unwrap_or(Value::Null);
            let id = interaction.get("id").and_then(Value::as_str).unwrap_or("").to_string();
            if id.is_empty() {
                continue;
            }
            open.retain(|(open_id, _)| open_id != &id);
            if event.get("type").and_then(Value::as_str) == Some("interaction.requested") {
                open.push((id, interaction));
            }
        }
        if open.is_empty() {
            return;
        }
        let session = {
            let db = self.db.lock().unwrap();
            Repositories::new(&db.raw).sessions().get(session_id).ok().flatten()
        };
        let Some(session) = session else { return };
        for (_, interaction) in open {
            let mut record = interaction.as_object().cloned().unwrap_or_default();
            record.insert("status".to_string(), json!("cancelled"));
            record.insert("response".to_string(), json!({ "outcome": "cancelled" }));
            record.insert("resolvedAt".to_string(), json!(now_iso()));
            let record = Value::Object(record);
            let appended = self.events.append_for_session(
                &session,
                &json!({ "runId": record.get("runId").cloned().unwrap_or(Value::Null) }),
                "interaction.resolved",
                json!({ "interaction": record.clone() }),
            );
            if appended.is_ok() {
                self.remember(record);
            }
        }
    }

    /// Auto-cancels everything a finished/cancelled run was still waiting on.
    pub fn cancel_for_run(&self, run_id: &str) {
        let mut lifecycle=self.lifecycle.lock().unwrap();
        lifecycle.cancelled_native.retain(|(run, _)|run != run_id);
        if lifecycle.closed.insert(run_id.into()){lifecycle.order.push_back(run_id.into());}
        while lifecycle.order.len()>4096{if let Some(old)=lifecycle.order.pop_front(){lifecycle.closed.remove(&old);}}
        let entries: Vec<(String, PendingInteraction)> = {
            let mut pending = self.pending.lock().unwrap();
            let ids: Vec<String> = pending
                .iter()
                .filter(|(_, entry)| entry.record.get("runId").and_then(Value::as_str) == Some(run_id))
                .map(|(id, _)| id.clone())
                .collect();
            ids.into_iter().filter_map(|id| pending.remove(&id).map(|entry| (id, entry))).collect()
        };
        drop(lifecycle);
        for (_, entry) in entries {
            let mut record = entry.record.as_object().cloned().unwrap_or_default();
            record.insert("status".to_string(), json!("cancelled"));
            record.insert("response".to_string(), json!({ "outcome": "cancelled" }));
            record.insert("resolvedAt".to_string(), json!(now_iso()));
            let record = Value::Object(record);
            // Journal the cancellation like respond() does — otherwise a
            // replay resurrects the auto-cancelled card as pending forever.
            let session_id = record.get("sessionId").and_then(Value::as_str).unwrap_or("").to_string();
            let session = Repositories::new(&self.db.lock().unwrap().raw).sessions().get(&session_id).ok().flatten();
            if let Some(session) = session {
                let _ = self.events.append_for_session(
                    &session,
                    &json!({ "runId": record.get("runId").cloned().unwrap_or(Value::Null) }),
                    "interaction.resolved",
                    json!({ "interaction": record }),
                );
            }
            self.remember(record);
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

/// Aborting a reverse call must also dismiss its pending desktop question.
struct PendingRequestGuard<'a>{service:&'a InteractionService,id:String}
impl Drop for PendingRequestGuard<'_> {
    fn drop(&mut self){if self.service.pending.lock().unwrap().contains_key(&self.id){let _=self.service.respond(&self.id,&json!({"outcome":"cancelled"}));}}
}


#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn native_interactions_timeout_and_ignore_late_requests() {
        let path=std::env::temp_dir().join(format!("nautilo-ui-{}.sqlite",Uuid::new_v4()));
        let db=Arc::new(Mutex::new(Database::open(&path).unwrap()));
        let session=json!({"id":"s","projectId":"p","memberId":"a","updatedAt":now_iso()});
        {
            let db=db.lock().unwrap();let repos=Repositories::new(&db.raw);
            repos.projects().save(&json!({"id":"p"}),&now_iso()).unwrap();
            repos.sessions().save(&session).unwrap();
        }
        let events=Arc::new(EventService::new(db.clone(),Default::default()));
        let ui=Arc::new(InteractionService::new(db.clone(),events));
        let response=ui.request(&session,Some("r"),"pi",json!({"kind":"question","title":"Edit","nativeRequestId":"edit","timeoutMs":5})).await;
        assert_eq!(response,json!({"outcome":"cancelled"}));
        assert!(ui.list(None,Some("pending")).is_empty());
        ui.cancel_native("next","select");
        assert_eq!(ui.request(&session,Some("next"),"omp",json!({"nativeRequestId":"select"})).await,response);
        ui.cancel_for_run("closed");
        assert_eq!(ui.request(&session,Some("closed"),"pi",json!({"nativeRequestId":"late"})).await,response);
        let journal=Repositories::new(&db.lock().unwrap().raw).events().replay(Some("s"),None,None,None).unwrap();
        assert_eq!(journal.iter().filter(|event|event["type"]=="interaction.requested").count(),1);
        assert_eq!(journal.iter().filter(|event|event["type"]=="interaction.resolved").count(),1);
        drop(ui);drop(db);
        let _=std::fs::remove_file(path);
    }
    #[tokio::test]
    async fn aborted_background_question_is_dismissed_and_native_ids_are_session_scoped() {
        let db=Arc::new(Mutex::new(Database::open(std::path::Path::new(":memory:")).unwrap()));
        let events=Arc::new(EventService::new(db.clone(),Default::default()));
        let ui=Arc::new(InteractionService::new(db.clone(),events));
        let first=json!({"id":"s1","projectId":"p","updatedAt":now_iso()});let second=json!({"id":"s2","projectId":"p","updatedAt":now_iso()});
        {let db=db.lock().unwrap();let repos=Repositories::new(&db.raw);repos.projects().save(&json!({"id":"p"}),&now_iso()).unwrap();repos.sessions().save(&first).unwrap();repos.sessions().save(&second).unwrap();}
        ui.cancel_session_native("s1","question");
        let pending=ui.clone();let session=second.clone();
        let task=tokio::spawn(async move{pending.request(&session,None,"pi",json!({"kind":"question","nativeRequestId":"question"})).await});
        tokio::task::yield_now().await;
        assert_eq!(ui.pending.lock().unwrap().len(),1,"cancelling another session must not dismiss this question");
        task.abort();let _=task.await;
        assert!(ui.pending.lock().unwrap().is_empty());
        let journal=Repositories::new(&db.lock().unwrap().raw).events().replay(Some("s2"),None,None,None).unwrap();
        assert_eq!(journal.last().unwrap()["type"],"interaction.resolved");
        assert_eq!(journal.last().unwrap()["payload"]["interaction"]["status"],"cancelled");
    }
}
