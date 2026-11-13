//! Daemon-owned MCP processes. The stdio relay keeps the native MCP wire format.
mod relay;
#[cfg(test)]
mod tests;
mod worker;
pub use relay::run_relay;

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use tokio::{
    io::{AsyncWriteExt, BufReader},
    net::{TcpListener, TcpStream},
};
use worker::Worker;

pub struct McpPool {
    address: String,
    token: String,
    workers: Mutex<HashMap<String, Arc<Worker>>>,
    listener: Mutex<Option<tokio::task::JoinHandle<()>>>,
    closed: AtomicBool,
}

impl McpPool {
    pub fn start() -> anyhow::Result<Arc<Self>> {
        let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
        listener.set_nonblocking(true)?;
        let address = listener.local_addr()?.to_string();
        let listener = TcpListener::from_std(listener)?;
        let pool = Arc::new(Self {
            address,
            token: uuid::Uuid::new_v4().to_string(),
            workers: Mutex::new(HashMap::new()),
            listener: Mutex::new(None),
            closed: AtomicBool::new(false),
        });
        let weak = Arc::downgrade(&pool);
        *pool.listener.lock().unwrap() = Some(tokio::spawn(async move {
            while let Ok((socket, _)) = listener.accept().await {
                let Some(pool) = weak.upgrade() else { break };
                tokio::spawn(async move {
                    let _ = pool.serve(socket).await;
                });
            }
        }));
        Ok(pool)
    }

    pub fn environment(&self) -> HashMap<String, String> {
        HashMap::from([
            ("NAUTILO_MCP_POOL_ADDR".into(), self.address.clone()),
            ("NAUTILO_MCP_POOL_TOKEN".into(), self.token.clone()),
            (
                "NAUTILO_MCP_POOL_EXE".into(),
                std::env::current_exe()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into(),
            ),
        ])
    }

    pub fn bind(&self, server: &Value, cwd: &str) -> Value {
        if server["transport"] != "stdio" {
            return server.clone();
        }
        let mut spec = server.clone();
        if !spec["cwd"].is_string() {
            spec["cwd"] = json!(cwd);
        }
        let mut env = self.environment();
        env.insert("NAUTILO_MCP_POOL_SPEC".into(), spec.to_string());
        json!({"name":server["name"],"transport":"stdio","command":env["NAUTILO_MCP_POOL_EXE"],"args":["--mcp-relay"],"env":env,"cwd":spec["cwd"]})
    }

    pub fn prewarm(&self, server: &Value, cwd: &str) {
        if server["transport"] != "stdio" {
            return;
        }
        let mut spec = server.clone();
        if !spec["cwd"].is_string() {
            spec["cwd"] = json!(cwd);
        }
        let prefix = format!("{:x}:", Sha256::digest(spec.to_string()));
        let mut workers = self.workers.lock().unwrap();
        if self.closed.load(Ordering::Acquire) {
            return;
        }
        workers.retain(|_, worker| worker.alive());
        if workers
            .iter()
            .any(|(key, worker)| key.starts_with(&prefix) && worker.alive())
        {
            return;
        }
        if let Ok(worker) = Worker::start(&spec, true) {
            workers.insert(format!("{prefix}warm"), worker);
        }
    }

    fn worker(&self, spec: &Value, first: &Value, dedicated: bool) -> anyhow::Result<Arc<Worker>> {
        let mut workers = self.workers.lock().unwrap();
        anyhow::ensure!(
            !self.closed.load(Ordering::Acquire),
            "MCP pool is shutting down"
        );
        if dedicated {
            let worker = Worker::start(spec, false)?;
            workers.retain(|_, worker| worker.alive());
            workers.insert(
                format!("dedicated:{}", uuid::Uuid::new_v4()),
                worker.clone(),
            );
            return Ok(worker);
        }
        let prefix = format!("{:x}:", Sha256::digest(spec.to_string()));
        let key = format!("{prefix}{}", connection_key(first));
        if let Some(worker) = workers.get(&key).filter(|worker| worker.alive()) {
            return Ok(worker.clone());
        }
        let probe = (first["method"] == "initialize")
            .then(|| {
                workers.iter().find_map(|(key, worker)| {
                    (key.starts_with(&prefix) && worker.alive() && worker.claim_legacy_probe())
                        .then(|| worker.clone())
                })
            })
            .flatten();
        let warm = probe.or_else(|| {
            workers
                .remove(&format!("{prefix}warm"))
                .filter(|worker| worker.alive())
        });
        let worker = match warm {
            Some(worker) => worker,
            None => Worker::start(spec, true)?,
        };
        workers.insert(key, worker.clone());
        Ok(worker)
    }

    async fn serve(&self, socket: TcpStream) -> anyhow::Result<()> {
        let (read, mut write) = socket.into_split();
        let mut read = BufReader::new(read);
        let hello = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            relay::read_message(&mut read),
        )
        .await??;
        anyhow::ensure!(
            hello["token"].as_str() == Some(&self.token),
            "Invalid MCP pool credential"
        );
        let spec = &hello["spec"];
        anyhow::ensure!(
            spec["transport"] == "stdio" && spec["command"].is_string(),
            "Invalid MCP process configuration"
        );
        let first = relay::read_message(&mut read).await?;
        let initialize = matches!(
            first["method"].as_str(),
            Some("initialize" | "server/discover")
        ) || first
            .pointer("/params/_meta/io.modelcontextprotocol~1protocolVersion")
            .and_then(Value::as_str)
            .is_some();
        // Clients with callbacks receive a dedicated, fully negotiated channel.
        // Their roots, sampling and elicitation requests stay with that client.
        let mut dedicated = !initialize || has_callbacks(&first);
        let mut worker = self.worker(spec, &first, dedicated)?;
        let id = uuid::Uuid::new_v4().to_string();
        let mut inbox = worker.attach(&id);
        worker.send(&id, first);
        let (input, mut messages) = tokio::sync::mpsc::channel(64);
        let reader = tokio::spawn(async move {
            while let Ok(message) = relay::read_message(&mut read).await {
                if input.send(message).await.is_err() {
                    break;
                }
            }
        });
        loop {
            tokio::select! {
                message = messages.recv() => {
                    let Some(message) = message else { break };
                    if worker.shared() && has_callbacks(&message) {
                        worker.detach(&id);
                        worker = self.worker(spec, &message, true)?;
                        inbox = worker.attach(&id);
                        dedicated = true;
                    }
                    worker.send(&id, message);
                }
                message = inbox.recv() => {
                    let Some(message) = message else { break };
                    if write.write_all(format!("{message}\n").as_bytes()).await.is_err() { break; }
                }
            }
        }
        reader.abort();
        worker.detach(&id);
        if dedicated {
            worker.close().await;
        }
        Ok(())
    }

    pub async fn close(&self) {
        self.closed.store(true, Ordering::Release);
        if let Some(listener) = self.listener.lock().unwrap().take() {
            listener.abort();
        }
        let workers = self
            .workers
            .lock()
            .unwrap()
            .drain()
            .map(|(_, worker)| worker)
            .collect::<Vec<_>>();
        for worker in workers {
            worker.close().await;
        }
    }
}

fn has_callbacks(message: &Value) -> bool {
    message
        .pointer("/params/capabilities")
        .and_then(Value::as_object)
        .is_some_and(|values| !values.is_empty())
        || message
            .pointer("/params/_meta/io.modelcontextprotocol~1clientCapabilities")
            .and_then(Value::as_object)
            .is_some_and(|values| !values.is_empty())
}

fn connection_key(message: &Value) -> String {
    if let Some(version) = message
        .pointer("/params/_meta/io.modelcontextprotocol~1protocolVersion")
        .and_then(Value::as_str)
    {
        return json!({"version":version,"capabilities":message.pointer("/params/_meta/io.modelcontextprotocol~1clientCapabilities").cloned().unwrap_or(json!({}))}).to_string();
    }
    worker::handshake_key(message)
}
