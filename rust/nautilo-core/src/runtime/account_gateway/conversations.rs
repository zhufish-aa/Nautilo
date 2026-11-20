//! Match reusable native runs per model request. An endpoint is an account,
//! not one native conversation: cache misses start an independent native run.
use super::{hash, Conversation, Route};
use crate::database::Repositories;
use serde_json::{json, Value};
use std::{collections::HashMap, sync::{Arc, Mutex}, time::{Duration, Instant}};
use tokio::sync::OwnedMutexGuard;

fn follows(previous: &[String], incoming: &[String]) -> bool {
    previous.len() <= incoming.len() && previous.iter().zip(incoming).all(|(left, right)| left == right)
}

fn assistant_matches(message: Option<&Value>, expected: Option<&str>) -> bool {
    let (Some(message), Some(expected)) = (message, expected) else { return false };
    if message["role"] != "assistant" { return false; }
    let content = match &message["content"] {
        Value::String(text) => text.clone(),
        Value::Null => String::new(),
        Value::Array(parts) if parts.iter().all(|part| part["type"] == "text") =>
            parts.iter().filter_map(|part| part["text"].as_str()).collect::<Vec<_>>().join(""),
        _ => return false,
    };
    content == expected && message["tool_calls"].as_array().is_none_or(Vec::is_empty)
}

impl Route {
    pub(super) fn new_conversation(&self, identity: &str) -> Arc<Self> {
        let mut template = self.template.lock().unwrap().clone();
        template.local_session_id = Some(format!("relay-{identity}:request:{}", uuid::Uuid::new_v4()));
        Arc::new(Self {
            route_id: self.route_id.clone(), conversations: tokio::sync::Mutex::new(vec![]),
            url: self.url.clone(), key: self.key.clone(), connection: self.connection.clone(), db: self.db.clone(),
            codex: self.codex.clone(), opencode: self.opencode.clone(), antigravity: self.antigravity.clone(), adapter: self.adapter.clone(), template: Mutex::new(template),
            native_id: Arc::new(Mutex::new(None)), exchange: Arc::new(tokio::sync::Mutex::new(Conversation::default())),
            cancel: Mutex::new(None), pending: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    pub(super) async fn restore_conversations(&self, legacy: &Value) {
        if self.codex.is_some() || self.opencode.is_some() || self.antigravity.is_some() { return; }
        let saved = {
            let db = self.db.lock().unwrap();
            Repositories::new(&db.raw).account_gateway_sessions().list_default().unwrap_or_default()
                .into_iter().filter(|row| row["routeId"] == self.route_id).take(8).collect::<Vec<_>>()
        };
        let mut rows = saved;
        // Legacy records are candidates only; they never own the endpoint.
        if legacy["nativeSessionId"].is_string() { rows.push(legacy.clone()); }
        let mut workers = self.conversations.lock().await;
        for row in rows.into_iter().filter(|row| row["reusable"] != false && row["nativeSessionId"].is_string()) {
            let child = self.new_conversation(&self.route_id);
            *child.native_id.lock().unwrap() = row["nativeSessionId"].as_str().map(str::to_string);
            if let Some(id) = row["localSessionId"].as_str() { child.template.lock().unwrap().local_session_id = Some(id.into()); }
            {
                let mut state = child.exchange.lock().await;
                state.hashes = row["hashes"].as_array().into_iter().flatten().filter_map(Value::as_str).map(str::to_string).collect();
                state.tools = row["tools"].as_str().map(str::to_string);
                state.model = row["model"].as_str().map(str::to_string);
                state.last_assistant = row["lastAssistant"].as_str().map(str::to_string);
            }
            workers.push(child);
        }
    }

    pub(super) async fn select_conversation(&self, body: &Value, messages: &[Value], identity: &str) -> (Arc<Self>, OwnedMutexGuard<Conversation>) {
        let hashes = messages.iter().map(hash).collect::<Vec<_>>();
        let signature = hash(&json!(body["tools"].as_array().cloned().unwrap_or_default()));
        let model = body["model"].as_str().map(str::to_string).or_else(|| self.template.lock().unwrap().model.clone());
        let mut workers = self.conversations.lock().await;
        for child in workers.iter().rev() {
            let Ok(mut state) = child.exchange.clone().try_lock_owned() else { continue };
            if !state.reusable || state.model.as_ref().is_some_and(|old| Some(old) != model.as_ref()) { continue; }
            let (previous, tools) = state.pending_history.as_ref().map(|(hashes, tools)| (hashes.as_slice(), Some(tools)))
                .unwrap_or((state.hashes.as_slice(), state.tools.as_ref()));
            if tools != Some(&signature) || !follows(previous, &hashes) { continue; }
            let pending = if state.worker.is_some() {
                let calls = child.pending.lock().unwrap();
                messages.iter().any(|message| message["role"] == "tool" && message["tool_call_id"].as_str().is_some_and(|id| calls.contains_key(id)))
            } else { false };
            let next_turn = state.worker.is_none() && child.native_id.lock().unwrap().is_some()
                && assistant_matches(messages.get(previous.len()), state.last_assistant.as_deref())
                && messages[previous.len()..].iter().any(|message| message["role"] != "assistant" && message["role"] != "tool");
            if !pending && !next_turn { continue; }
            // Refresh run-owned callbacks and turn settings without changing identity.
            let current = self.template.lock().unwrap().clone();
            let local_id = child.template.lock().unwrap().local_session_id.clone();
            *child.template.lock().unwrap() = crate::adapters::AdapterStartRequest { local_session_id: local_id, ..current };
            state.used_at = Instant::now();
            return (child.clone(), state);
        }
        let child = self.new_conversation(identity);
        let mut state = child.exchange.clone().try_lock_owned().unwrap();
        state.model = model;
        workers.push(child.clone());
        (child, state)
    }

    pub(super) async fn prune_conversations(&self) {
        let retired = {
            let mut workers = self.conversations.lock().await;
            let mut retired = vec![];
            let mut idle = 0;
            let mut keep = vec![];
            for child in workers.drain(..).rev() {
                let retire = match child.exchange.try_lock() {
                    Ok(state) if state.worker.is_none() && child.pending.lock().unwrap().is_empty() => {
                        idle += 1;
                        !state.reusable || idle > 8 || state.used_at.elapsed() > Duration::from_secs(3600)
                    }
                    _ => false,
                };
                if retire { retired.push(child); } else { keep.push(child); }
            }
            keep.reverse(); *workers = keep;
            retired
        };
        for child in retired {
            child.stop();
            let request = child.template.lock().unwrap().clone();
            // Releasing the model worker does not delete native history or
            // stop another worker's process/background tasks.
            let _ = child.adapter.release_session(&request).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn matching_is_only_a_reuse_hint() {
        let prefix = vec!["system".into(), "first-user".into()];
        assert!(follows(&prefix, &["system".into(), "first-user".into(), "answer".into(), "next".into()]));
        assert!(!follows(&prefix, &["title-system".into(), "first-user".into()]));
        assert!(!follows(&prefix, &["compacted".into()]));
    }
}
