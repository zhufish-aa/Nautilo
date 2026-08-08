//! Line-delimited JSON-RPC client over a child process — port of
//! adapters/json-rpc-process.ts. Requests are correlated by id; server
//! requests/notifications flow through the event channel.

use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot};

use crate::process_runtime::{ProcessEvent, ProcessHandle};

#[derive(Debug, Clone)]
pub enum JsonRpcProcessEvent {
    Notification { method: String, params: Value },
    Request { id: Value, method: String, params: Value },
    Response { id: Value, result: Option<Value>, error: Option<Value> },
    Transport(ProcessEvent),
}

pub struct JsonRpcProcessClient {
    process: ProcessHandle,
    pending: Arc<Mutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>>,
    next_id: AtomicI64,
    events: tokio::sync::Mutex<mpsc::UnboundedReceiver<JsonRpcProcessEvent>>,
}

impl JsonRpcProcessClient {
    pub fn new(process: ProcessHandle, process_events: mpsc::UnboundedReceiver<ProcessEvent>) -> Self {
        let (sender, receiver) = mpsc::unbounded_channel::<JsonRpcProcessEvent>();
        let pending: Arc<Mutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>> = Arc::new(Mutex::new(HashMap::new()));
        let pump_pending = pending.clone();
        let pump_process = process.clone();
        tokio::spawn(async move {
            let mut stdout = String::new();
            let mut events = process_events;
            loop {
                match events.recv().await {
                    Some(ProcessEvent::Stdout(text)) => {
                        stdout.push_str(&text);
                        let mut lines: Vec<String> = stdout.split('\n').map(str::to_string).collect();
                        stdout = lines.pop().unwrap_or_default();
                        for line in lines {
                            accept_line(&line, &sender, &pump_pending);
                        }
                    }
                    Some(event) => {
                        let is_exit = matches!(event, ProcessEvent::Exit { .. });
                        let _ = sender.send(JsonRpcProcessEvent::Transport(event));
                        if is_exit {
                            break;
                        }
                    }
                    None => break,
                }
            }
            if !stdout.trim().is_empty() {
                accept_line(&stdout, &sender, &pump_pending);
            }
            // Reject everything still pending, then close the event stream.
            let pending: Vec<oneshot::Sender<Result<Value, String>>> =
                pump_pending.lock().unwrap().drain().map(|(_, sender)| sender).collect();
            for sender in pending {
                let _ = sender.send(Err("JSON-RPC process closed before the request completed".to_string()));
            }
            drop(sender);
            let _ = pump_process;
        });
        Self {
            process,
            pending,
            next_id: AtomicI64::new(1),
            events: tokio::sync::Mutex::new(receiver),
        }
    }

    /// Next inbound event (notification / server request / transport).
    pub async fn next_event(&self) -> Option<JsonRpcProcessEvent> {
        self.events.lock().await.recv().await
    }

    pub fn process_handle(&self) -> ProcessHandle {
        self.process.clone()
    }

    /// Raw write passthrough (rarely needed; request/notify cover the RPC).
    pub fn process_write(&self, input: &str) {
        self.process.write(input);
    }

    pub fn request_with_id(&self, method: &str, params: Value) -> (i64, oneshot::Receiver<Result<Value, String>>) {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (sender, receiver) = oneshot::channel();
        self.pending.lock().unwrap().insert(id.to_string(), sender);
        self.send(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }));
        (id, receiver)
    }

    pub async fn request(&self, method: &str, params: Value) -> anyhow::Result<Value> {
        let (_, receiver) = self.request_with_id(method, params);
        match receiver.await {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(message)) => anyhow::bail!(message),
            Err(_) => anyhow::bail!("JSON-RPC process closed before the request completed"),
        }
    }

    pub fn notify(&self, method: &str, params: Value) {
        self.send(&json!({ "jsonrpc": "2.0", "method": method, "params": params }));
    }

    pub fn respond(&self, id: &Value, result: Value) {
        self.send(&json!({ "jsonrpc": "2.0", "id": id, "result": result }));
    }

    pub fn respond_error(&self, id: &Value, code: i64, message: &str) {
        self.send(&json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } }));
    }

    fn send(&self, message: &Value) {
        self.process.write(&format!("{}\n", message));
    }
}

fn rpc_error(value: &Value) -> String {
    if let Some(message) = value.get("message").and_then(Value::as_str) {
        return message.to_string();
    }
    value.as_str().map(str::to_string).unwrap_or_else(|| value.to_string())
}

fn accept_line(
    line: &str,
    sender: &mpsc::UnboundedSender<JsonRpcProcessEvent>,
    pending: &Arc<Mutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>>,
) {
    if line.trim().is_empty() {
        return;
    }
    let value: Value = match serde_json::from_str(line) {
        Ok(value) => value,
        Err(_) => {
            let _ = sender.send(JsonRpcProcessEvent::Transport(ProcessEvent::Stdout(line.to_string())));
            return;
        }
    };
    let id = value.get("id").filter(|id| !id.is_null()).cloned();
    let has_result = value.get("result").is_some();
    let has_error = value.get("error").is_some();
    let has_method = value.get("method").and_then(Value::as_str).is_some();
    if let Some(id) = &id {
        if (has_result || has_error) && !has_method {
            let key = id_key(id);
            let waiter = pending.lock().unwrap().remove(&key);
            if let Some(waiter) = waiter {
                if has_error {
                    let _ = waiter.send(Err(rpc_error(value.get("error").unwrap())));
                } else {
                    let _ = waiter.send(Ok(value.get("result").cloned().unwrap_or(Value::Null)));
                }
            }
            let _ = sender.send(JsonRpcProcessEvent::Response {
                id: id.clone(),
                result: value.get("result").cloned(),
                error: value.get("error").cloned(),
            });
            return;
        }
    }
    let Some(method) = value.get("method").and_then(Value::as_str) else {
        return;
    };
    let params = value.get("params").cloned().unwrap_or(Value::Null);
    match id {
        Some(id) => {
            let _ = sender.send(JsonRpcProcessEvent::Request { id, method: method.to_string(), params });
        }
        None => {
            let _ = sender.send(JsonRpcProcessEvent::Notification { method: method.to_string(), params });
        }
    }
}

fn id_key(id: &Value) -> String {
    match id {
        Value::Number(number) => number.to_string(),
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}
