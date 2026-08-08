//! Long-poll event subscriptions — port of runtime/event-subscription-service.ts.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::{json, Map, Value};
use tokio::sync::broadcast;
use uuid::Uuid;

use crate::errors::{CoreError, CoreResult, ErrorCode};
use crate::runtime::event_service::EventService;

struct SubscriptionEntry {
    project_run_id: Option<String>,
    session_id: Option<String>,
    last_used_at: std::time::Instant,
}

/// Desktop clients never explicitly unsubscribe, so idle subscriptions are
/// pruned lazily after this TTL (10 minutes, same as the TS daemon).
const SUBSCRIPTION_TTL: std::time::Duration = std::time::Duration::from_secs(10 * 60);

pub struct EventSubscriptionService {
    events: Arc<EventService>,
    subscriptions: Mutex<HashMap<String, SubscriptionEntry>>,
}

impl EventSubscriptionService {
    pub fn new(events: Arc<EventService>) -> Self {
        Self { events, subscriptions: Mutex::new(HashMap::new()) }
    }

    pub fn subscribe(&self, project_run_id: Option<String>, session_id: Option<String>) -> CoreResult<Value> {
        if project_run_id.is_none() && session_id.is_none() {
            let mut details = Map::new();
            details.insert("field".to_string(), json!("event scope"));
            return Err(CoreError::details(ErrorCode::IpcInvalidRequest, details));
        }
        self.prune();
        let subscription_id = Uuid::new_v4().to_string();
        self.subscriptions.lock().unwrap().insert(
            subscription_id.clone(),
            SubscriptionEntry { project_run_id, session_id, last_used_at: std::time::Instant::now() },
        );
        Ok(json!({ "subscriptionId": subscription_id }))
    }

    pub fn replay(&self, subscription_id: &str, after_sequence: i64) -> CoreResult<Value> {
        let entry = self.touch(subscription_id)?;
        let events = self.events.replay(
            entry.session_id.as_deref(),
            entry.project_run_id.as_deref(),
            None,
            Some(after_sequence),
        )?;
        let last_sequence = events.last().and_then(|e| e.get("sequence")).and_then(Value::as_i64).unwrap_or(after_sequence);
        Ok(json!({ "events": events, "lastSequence": last_sequence }))
    }

    pub async fn wait(&self, subscription_id: &str, after_sequence: i64, timeout_ms: Option<u64>) -> CoreResult<Value> {
        self.prune();
        let entry = self.touch(subscription_id)?;
        let scope_session = entry.session_id.clone();
        let scope_project_run = entry.project_run_id.clone();

        // Anything already stored wins immediately, matching the TS order:
        // subscribe for live events first, then check the backlog.
        let mut receiver = self.events.subscribe_events();
        let available = self.replay(subscription_id, after_sequence)?;
        if available.get("events").and_then(Value::as_array).is_some_and(|e| !e.is_empty()) {
            return Ok(available);
        }

        let timeout = timeout_ms.unwrap_or(20_000).clamp(250, 25_000);
        let matches = |event: &Value| -> bool {
            let sequence = event.get("sequence").and_then(Value::as_i64).unwrap_or(0);
            if sequence <= after_sequence {
                return false;
            }
            if let Some(scope) = &scope_session {
                if event.get("sessionId").and_then(Value::as_str) != Some(scope.as_str()) {
                    return false;
                }
            }
            if let Some(scope) = &scope_project_run {
                if event.get("projectRunId").and_then(Value::as_str) != Some(scope.as_str()) {
                    return false;
                }
            }
            true
        };
        let notified = async {
            loop {
                match receiver.recv().await {
                    Ok(event) if matches(&event) => return true,
                    Ok(_) => continue,
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => return false,
                }
            }
        };
        let _ = tokio::time::timeout(std::time::Duration::from_millis(timeout), notified).await;
        let events = self.replay(subscription_id, after_sequence)?;
        Ok(events)
    }

    fn touch(&self, subscription_id: &str) -> CoreResult<SubscriptionEntrySnapshot> {
        let mut subscriptions = self.subscriptions.lock().unwrap();
        let entry = subscriptions.get_mut(subscription_id).ok_or_else(|| {
            let mut details = Map::new();
            details.insert("resource".to_string(), json!("eventSubscription"));
            details.insert("id".to_string(), json!(subscription_id));
            CoreError::details(ErrorCode::IpcNotFound, details)
        })?;
        entry.last_used_at = std::time::Instant::now();
        Ok(SubscriptionEntrySnapshot {
            project_run_id: entry.project_run_id.clone(),
            session_id: entry.session_id.clone(),
        })
    }

    fn prune(&self) {
        let now = std::time::Instant::now();
        self.subscriptions
            .lock()
            .unwrap()
            .retain(|_, entry| now.duration_since(entry.last_used_at) <= SUBSCRIPTION_TTL);
    }
}

struct SubscriptionEntrySnapshot {
    project_run_id: Option<String>,
    session_id: Option<String>,
}
