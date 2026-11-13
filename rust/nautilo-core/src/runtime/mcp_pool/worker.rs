use agenthub_plugin_sdk::process::{self, ProcessEvent, ProcessHandle, ProcessRequest};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use tokio::sync::mpsc;

type Inbox = mpsc::UnboundedSender<Value>;
struct Pending {
    client: String,
    original_id: Value,
    handshake: Option<String>,
}
enum Handshake {
    Waiting(Vec<(String, Value)>),
    Ready(Value),
}

pub(super) fn handshake_key(message: &Value) -> String {
    let mut params = message["params"].clone();
    if let Some(params) = params.as_object_mut() {
        params.remove("clientInfo");
    }
    if let Some(meta) = params.get_mut("_meta").and_then(Value::as_object_mut) {
        meta.remove("io.modelcontextprotocol/clientInfo");
    }
    json!({"method":message["method"],"params":params}).to_string()
}

pub(super) struct Worker {
    process: ProcessHandle,
    clients: Mutex<HashMap<String, Inbox>>,
    pending: Mutex<HashMap<String, Pending>>,
    shared: bool,
    handshakes: Mutex<HashMap<String, Handshake>>,
    initialized: AtomicBool,
    legacy_claimed: AtomicBool,
    stderr_tail: Mutex<String>,
}

impl Worker {
    pub fn start(spec: &Value, shared: bool) -> anyhow::Result<Arc<Self>> {
        let environment = spec["env"].as_object().map(|values| {
            values
                .iter()
                .filter_map(|(key, value)| {
                    value.as_str().map(|value| (key.clone(), value.to_string()))
                })
                .collect()
        });
        let mut started = process::start(&ProcessRequest {
            command: spec["command"].as_str().unwrap_or_default().into(),
            args: spec["args"]
                .as_array()
                .map(|values| {
                    values
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default(),
            env: environment,
            cwd: spec["cwd"].as_str().map(str::to_string),
            inherit_env: spec["inheritEnv"] != false,
            ..Default::default()
        })?;
        let worker = Arc::new(Self {
            process: started.handle,
            clients: Mutex::new(HashMap::new()),
            pending: Mutex::new(HashMap::new()),
            shared,
            handshakes: Mutex::new(HashMap::new()),
            initialized: AtomicBool::new(false),
            legacy_claimed: AtomicBool::new(false),
            stderr_tail: Mutex::new(String::new()),
        });
        let owner = worker.clone();
        tokio::spawn(async move {
            let mut buffer = String::new();
            while let Some(event) = started.events.recv().await {
                match event {
                    ProcessEvent::Stdout(text) => {
                        buffer.push_str(&text);
                        while let Some(end) = buffer.find('\n') {
                            let line: String = buffer.drain(..=end).collect();
                            let Ok(message) = serde_json::from_str::<Value>(&line) else {
                                continue;
                            };
                            owner.deliver(message);
                        }
                    }
                    ProcessEvent::Exit { .. }
                    | ProcessEvent::Error(_)
                    | ProcessEvent::Timeout { .. } => break,
                    ProcessEvent::Stderr(text) => {
                        let mut tail = owner.stderr_tail.lock().unwrap();
                        tail.push_str(&text);
                        if tail.len() > 8192 {
                            let mut start = tail.len() - 8192;
                            while !tail.is_char_boundary(start) {
                                start += 1;
                            }
                            tail.drain(..start);
                        }
                        for client in owner.clients.lock().unwrap().values() {
                            let _ = client.send(json!({"nautiloMcpRelay":"stderr","text":text}));
                        }
                    }
                }
            }
            owner.clients.lock().unwrap().clear();
            owner.pending.lock().unwrap().clear();
            owner.process.cancel().await;
        });
        Ok(worker)
    }

    pub fn alive(&self) -> bool {
        self.process.is_alive()
    }
    pub fn shared(&self) -> bool {
        self.shared
    }
    pub fn claim_legacy_probe(&self) -> bool {
        let handshakes = self.handshakes.lock().unwrap();
        let rejected_probe = handshakes.iter().any(|(key, reply)| {
            let key: Value = serde_json::from_str(key).unwrap_or_default();
            key["method"] == "server/discover" && matches!(reply, Handshake::Ready(reply) if reply.pointer("/error/code").and_then(Value::as_i64) == Some(-32601))
        });
        rejected_probe && !self.legacy_claimed.swap(true, Ordering::AcqRel)
    }
    pub fn attach(&self, id: &str) -> mpsc::UnboundedReceiver<Value> {
        let (sender, receiver) = mpsc::unbounded_channel();
        let tail = self.stderr_tail.lock().unwrap();
        if !tail.is_empty() {
            let _ = sender.send(json!({"nautiloMcpRelay":"stderr","text":*tail}));
        }
        self.clients.lock().unwrap().insert(id.into(), sender);
        receiver
    }
    pub fn send(&self, client: &str, mut message: Value) {
        if self.shared
            && message["method"] == "notifications/initialized"
            && self.initialized.swap(true, Ordering::AcqRel)
        {
            return;
        }
        let handshake = (self.shared
            && matches!(
                message["method"].as_str(),
                Some("initialize" | "server/discover")
            ))
        .then(|| handshake_key(&message));
        if let Some(key) = &handshake {
            let mut handshakes = self.handshakes.lock().unwrap();
            match handshakes.get_mut(key) {
                Some(Handshake::Ready(reply)) => {
                    let mut reply = reply.clone();
                    reply["id"] = message["id"].clone();
                    if let Some(sender) = self.clients.lock().unwrap().get(client) {
                        let _ = sender.send(reply);
                    }
                    return;
                }
                Some(Handshake::Waiting(waiters)) => {
                    waiters.push((client.into(), message["id"].clone()));
                    return;
                }
                None => {
                    handshakes.insert(key.clone(), Handshake::Waiting(Vec::new()));
                }
            }
        }
        if let Some(token) = message.pointer("/params/_meta/progressToken").cloned() {
            message["params"]["_meta"]["progressToken"] = json!(format!(
                "{client}:{}",
                URL_SAFE_NO_PAD.encode(token.to_string())
            ));
        }
        if message.get("method").is_some() && message.get("id").is_some() {
            let id = uuid::Uuid::new_v4().to_string();
            self.pending.lock().unwrap().insert(
                id.clone(),
                Pending {
                    client: client.into(),
                    original_id: message["id"].clone(),
                    handshake,
                },
            );
            message["id"] = json!(id);
        }
        if message["method"] == "notifications/cancelled" {
            let pending = self.pending.lock().unwrap();
            let id = pending
                .iter()
                .find(|(_, request)| {
                    request.client == client
                        && request.original_id == message["params"]["requestId"]
                })
                .map(|(id, _)| id.clone());
            let Some(id) = id else { return };
            message["params"]["requestId"] = json!(id);
        }
        self.process.write(&format!("{message}\n"));
    }
    fn deliver(&self, mut message: Value) {
        if message.get("method").is_none() {
            let request = message["id"]
                .as_str()
                .and_then(|id| self.pending.lock().unwrap().remove(id));
            if let Some(request) = request {
                if let Some(key) = request.handshake {
                    let previous = {
                        let mut handshakes = self.handshakes.lock().unwrap();
                        let descriptor: Value = serde_json::from_str(&key).unwrap_or_default();
                        let legacy_probe = descriptor["method"] == "server/discover"
                            && message.pointer("/error/code").and_then(Value::as_i64)
                                == Some(-32601);
                        if message.get("error").is_some() && !legacy_probe {
                            handshakes.remove(&key)
                        } else {
                            handshakes.insert(key, Handshake::Ready(message.clone()))
                        }
                    };
                    if let Some(Handshake::Waiting(waiters)) = previous {
                        for (client, id) in waiters {
                            let mut reply = message.clone();
                            reply["id"] = id;
                            if let Some(sender) = self.clients.lock().unwrap().get(&client) {
                                let _ = sender.send(reply);
                            }
                        }
                    }
                }
                message["id"] = request.original_id.clone();
                if let Some(meta) = message
                    .pointer_mut("/result/_meta")
                    .and_then(Value::as_object_mut)
                {
                    if meta.contains_key("io.modelcontextprotocol/subscriptionId") {
                        meta.insert(
                            "io.modelcontextprotocol/subscriptionId".into(),
                            request.original_id,
                        );
                    }
                }
                if let Some(client) = self.clients.lock().unwrap().get(&request.client) {
                    let _ = client.send(message);
                }
            }
        } else if message.get("id").is_some() {
            if message["method"] == "ping" {
                self.process.write(&format!(
                    "{}\n",
                    json!({"jsonrpc":"2.0","id":message["id"],"result":{}})
                ));
            } else if self.shared {
                self.process.write(&format!("{}\n", json!({"jsonrpc":"2.0","id":message["id"],"error":{"code":-32601,"message":"This MCP connection did not negotiate client callbacks"}})));
            } else if let Some(client) = self.clients.lock().unwrap().values().next() {
                // Callback-capable workers have one attached client.
                let _ = client.send(message);
            }
        } else {
            let subscription = message
                .pointer("/params/_meta/io.modelcontextprotocol~1subscriptionId")
                .and_then(Value::as_str);
            let cancellation = (message["method"] == "notifications/cancelled")
                .then(|| message.pointer("/params/requestId").and_then(Value::as_str))
                .flatten();
            if let Some(id) = subscription.or(cancellation) {
                let mut pending = self.pending.lock().unwrap();
                if let Some(request) = pending.get(id) {
                    let client = request.client.clone();
                    let original_id = request.original_id.clone();
                    if cancellation.is_some() {
                        let id = id.to_string();
                        pending.remove(&id);
                        message["params"]["requestId"] = original_id;
                    } else {
                        message["params"]["_meta"]["io.modelcontextprotocol/subscriptionId"] =
                            original_id;
                    }
                    if let Some(sender) = self.clients.lock().unwrap().get(&client) {
                        let _ = sender.send(message);
                    }
                }
                return;
            }
            if message["method"] == "notifications/progress" {
                let route = message["params"]["progressToken"]
                    .as_str()
                    .and_then(|token| token.split_once(':'))
                    .and_then(|(client, token)| {
                        Some((
                            client.to_string(),
                            serde_json::from_slice::<Value>(&URL_SAFE_NO_PAD.decode(token).ok()?)
                                .ok()?,
                        ))
                    });
                if let Some((client, token)) = route {
                    message["params"]["progressToken"] = token;
                    if let Some(sender) = self.clients.lock().unwrap().get(&client) {
                        let _ = sender.send(message);
                    }
                }
                return;
            }
            for client in self.clients.lock().unwrap().values() {
                let _ = client.send(message.clone());
            }
        }
    }
    pub fn detach(&self, client: &str) {
        self.clients.lock().unwrap().remove(client);
        for handshake in self.handshakes.lock().unwrap().values_mut() {
            if let Handshake::Waiting(waiters) = handshake {
                waiters.retain(|(owner, _)| owner != client);
            }
        }
        self.pending.lock().unwrap().retain(|id, request| {
            if request.client != client { return true; }
            if request.handshake.is_some() { return true; }
            self.process.write(&format!("{}\n", json!({"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":id,"reason":"MCP client disconnected"}})));
            false
        });
    }
    pub async fn close(&self) {
        self.process.cancel().await;
    }
}
