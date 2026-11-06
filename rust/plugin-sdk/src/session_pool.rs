//! Native session ownership. Callers own protocol-specific turn boundaries.
use crate::process::ProcessEvent;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub struct ResidentProcess {
    pub process: Option<crate::process::StartedProcess>,
    pub session_id: Option<String>,
}
impl ResidentProcess {
    pub fn new(process: crate::process::StartedProcess) -> Self {
        Self {
            process: Some(process),
            session_id: None,
        }
    }
    pub async fn close(mut self) {
        if let Some(process) = self.process.take() {
            process.handle.cancel().await;
        }
    }
}
impl Drop for ResidentProcess {
    fn drop(&mut self) {
        if let Some(process) = self.process.take() {
            tokio::spawn(async move {
                process.handle.cancel().await;
            });
        }
    }
}

struct Entry<T> {
    identity: Value,
    value: T,
}
pub struct SessionPool<T> {
    inner: Arc<Mutex<(bool, HashMap<String, Entry<T>>)>>,
}
impl<T> Clone for SessionPool<T> {
    fn clone(&self) -> Self {
        Self {
            inner: self.inner.clone(),
        }
    }
}
impl<T> Default for SessionPool<T> {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new((false, HashMap::new()))),
        }
    }
}
impl<T: Send + 'static> SessionPool<T> {
    pub fn take(&self, key: &str) -> Option<(Value, T)> {
        self.inner
            .lock()
            .unwrap()
            .1
            .remove(key)
            .map(|entry| (entry.identity, entry.value))
    }
    pub fn put(&self, key: String, identity: Value, value: T) {
        {
            let mut inner = self.inner.lock().unwrap();
            if inner.0 {
                return;
            }
            inner.1.insert(key.clone(), Entry { identity, value });
        }
        // A completed foreground turn does not prove a native process is idle.
        // Child agents/extensions/jobs can still run. Release explicitly on
        // deletion, handoff, configuration change or shutdown, never by TTL.
    }
    pub fn drain(&self) -> Vec<T> {
        let mut inner = self.inner.lock().unwrap();
        inner.0 = true;
        inner.1.drain().map(|(_, entry)| entry.value).collect()
    }
    pub fn retire(&self, key: &str) -> Option<T> {
        self.inner
            .lock()
            .unwrap()
            .1
            .remove(key)
            .map(|entry| entry.value)
    }
}

/// Includes credentials/resources in memory, never in a log. Per-turn input,
/// command and images do not change native process configuration.
pub fn identity(request: &Value) -> Value {
    let instance = &request["instance"];
    json!({"instance":{"id":instance["id"],"providerId":instance["providerId"],"executable":instance["executable"],"baseArgs":instance["baseArgs"],"profile":instance["profile"],"providerOptions":instance["providerOptions"],"models":instance["models"]},"cwd":request["cwd"],"env":request["env"],
        "mcpServers":request["mcpServers"],"skills":request["skills"],"runtimeTools":request["runtimeTools"],
        "permissionMode":request["permissionMode"],"agentMode":request["agentMode"],
        "model":request["model"],"reasoningEffort":request["reasoningEffort"],"serviceTier":request["serviceTier"],"contextWindow":request["contextWindow"],"outputSchemaPath":request["outputSchemaPath"]})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn identity_tracks_configuration_not_activity() {
        let base = json!({"instance":{"id":"a","executable":"pi","status":"idle","updatedAt":"old"},"prompt":"first","model":"m"});
        let mut next = base.clone();
        next["instance"]["status"] = json!("running");
        next["instance"]["updatedAt"] = json!("new");
        next["prompt"] = json!("second");
        assert_eq!(identity(&base), identity(&next));
        next["outputSchemaPath"] = json!("schema.json");
        assert_ne!(identity(&base), identity(&next));
    }
}

/// A deadline/idle/output budget is reset for each turn, never for the lifetime
/// of a reused process. No timeout is silently dropped by keeping stdin open.
pub struct TurnBudget {
    started: Instant,
    last: Instant,
    bytes: usize,
    total: Option<Duration>,
    idle: Option<Duration>,
    max: Option<usize>,
}
impl TurnBudget {
    pub fn new(request: &Value) -> Self {
        Self {
            started: Instant::now(),
            last: Instant::now(),
            bytes: 0,
            total: request["timeoutMs"].as_u64().map(Duration::from_millis),
            idle: request["idleTimeoutMs"].as_u64().map(Duration::from_millis),
            max: request["maxOutputBytes"]
                .as_u64()
                .map(|value| value as usize),
        }
    }
    pub async fn recv(
        &mut self,
        events: &mut crate::event_stream::ProcessEvents,
    ) -> Option<ProcessEvent> {
        let remaining = self
            .total
            .map(|limit| limit.saturating_sub(self.started.elapsed()))
            .into_iter()
            .chain(
                self.idle
                    .map(|limit| limit.saturating_sub(self.last.elapsed())),
            )
            .min();
        let event = if let Some(remaining) = remaining {
            match tokio::time::timeout(remaining, events.recv()).await {
                Ok(event) => event,
                Err(_) => {
                    return Some(ProcessEvent::Timeout {
                        reason: if self
                            .total
                            .is_some_and(|limit| self.started.elapsed() >= limit)
                        {
                            "timeout"
                        } else {
                            "idle"
                        }
                        .into(),
                    })
                }
            }
        } else {
            events.recv().await
        };
        if let Some(ProcessEvent::Stdout(text) | ProcessEvent::Stderr(text)) = &event {
            self.last = Instant::now();
            self.bytes = self.bytes.saturating_add(text.len());
            if self.max.is_some_and(|max| self.bytes > max) {
                return Some(ProcessEvent::Timeout {
                    reason: "max_output".into(),
                });
            }
        }
        event
    }
}
