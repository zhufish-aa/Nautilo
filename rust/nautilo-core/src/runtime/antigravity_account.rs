//! Account-model transport for the copied Magpie agy-cli implementation.
//! The regular Antigravity Harness adapter remains a separate native runtime.
use agenthub_plugin_sdk::process::{self, ProcessEvent, ProcessHandle, ProcessRequest};
use serde_json::{json, Value};
use std::{collections::HashMap, path::PathBuf, time::Duration};
use tokio::{
    io::AsyncReadExt,
    net::TcpStream,
    sync::{watch, Mutex},
};
mod resources;

struct Worker {
    process: ProcessHandle,
    url: String,
    key: String,
}
impl Drop for Worker {
    fn drop(&mut self) {
        self.process.end_stdin();
        let process = self.process.clone();
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                if tokio::time::timeout(Duration::from_secs(4), process.wait())
                    .await
                    .is_err()
                {
                    process.cancel().await;
                }
            });
        }
    }
}
pub struct AntigravityAccount {
    directory: PathBuf,
    env: HashMap<String, String>,
    cwd: String,
    worker: Mutex<Option<Worker>>,
}
impl AntigravityAccount {
    pub fn new(
        directory: PathBuf,
        mut env: HashMap<String, String>,
        instance: &Value,
        cwd: &str,
    ) -> Self {
        if let Some(executable) = instance["executable"].as_str().filter(|v| !v.is_empty()) {
            env.insert("AGY_PATH".into(), executable.into());
        }
        env.insert(
            "XDG_STATE_HOME".into(),
            directory.join("state").to_string_lossy().into(),
        );
        Self {
            directory,
            env,
            cwd: cwd.into(),
            worker: Mutex::new(None),
        }
    }
    async fn endpoint(&self) -> anyhow::Result<(String, String)> {
        let mut worker = self.worker.lock().await;
        if let Some(worker) = worker.as_ref().filter(|worker| worker.process.is_alive()) {
            return Ok((worker.url.clone(), worker.key.clone()));
        }
        for (name, contents) in resources::FILES {
            let file = self.directory.join(name);
            std::fs::create_dir_all(file.parent().unwrap())?;
            if std::fs::read(&file).ok().as_deref() != Some(contents.as_bytes()) {
                std::fs::write(&file, contents)?;
            }
        }
        let node = std::env::var("AGENTHUB_NODE_PATH").unwrap_or_else(|_| "node".into());
        let mut started = process::start(&ProcessRequest {
            command: node,
            args: vec![self.directory.join("server.mjs").to_string_lossy().into()],
            env: Some(self.env.clone()),
            cwd: Some(self.cwd.clone()),
            ..Default::default()
        })?;
        let key = uuid::Uuid::new_v4().to_string();
        // Readiness can be cancelled by the outer HTTP caller. Own the child
        // immediately so dropping that startup future also closes its stdin.
        let mut child = Worker {
            process: started.handle.clone(),
            url: String::new(),
            key: key.clone(),
        };
        started.handle.write(&format!("{}\n", json!({"token":key})));
        let ready = tokio::time::timeout(Duration::from_secs(30), async {
            let mut buffer = String::new();
            while let Some(event) = started.events.recv().await {
                match event {
                    ProcessEvent::Stdout(text) => {
                        buffer.push_str(&text);
                        while let Some(end) = buffer.find('\n') {
                            let line = buffer[..end].to_string();
                            buffer.drain(..=end);
                            if let Ok(frame) = serde_json::from_str::<Value>(&line) {
                                if frame["ready"] == true {
                                    return frame["url"].as_str().map(str::to_string).ok_or_else(
                                        || anyhow::anyhow!("Invalid account transport endpoint"),
                                    );
                                }
                            }
                        }
                    }
                    ProcessEvent::Exit { .. } | ProcessEvent::Error(_) => {
                        anyhow::bail!("Magpie agy model bridge could not start")
                    }
                    _ => {}
                }
            }
            anyhow::bail!("The native account transport closed before readiness")
        })
        .await;
        let url = match ready {
            Ok(Ok(url)) => url,
            other => {
                started.handle.cancel().await;
                return Err(anyhow::anyhow!(
                    "Antigravity model bridge startup failed: {other:?}"
                ));
            }
        };
        tokio::spawn(async move { while started.events.recv().await.is_some() {} });
        let endpoint = (url.clone(), key);
        child.url = url;
        *worker = Some(child);
        Ok(endpoint)
    }
    pub async fn relay(
        &self,
        socket: &mut TcpStream,
        body: &Value,
        mut cancelled: watch::Receiver<bool>,
        headers_started: &mut bool,
    ) -> anyhow::Result<()> {
        let mut disconnected = [0u8; 1];
        let (url, key) = tokio::select! {result=self.endpoint()=>result?,_=cancelled.changed()=>anyhow::bail!("Antigravity request cancelled"),_=socket.read(&mut disconnected)=>return Ok(())};
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(1800))
            .build()?;
        let response = tokio::select! {result=client.post(format!("{url}/chat/completions")).bearer_auth(key).json(body).send()=>result?,_=cancelled.changed()=>anyhow::bail!("Antigravity request cancelled"),_=socket.read(&mut disconnected)=>return Ok(())};
        if !response.status().is_success() {
            let status = response.status().as_u16();
            let body: Value = response.json().await.unwrap_or(Value::Null);
            return Err(crate::runtime::account_auth::ModelRequestError {
                status,
                message: format!(
                    "Antigravity model request returned HTTP {status}: {}",
                    body["error"]["message"]
                        .as_str()
                        .unwrap_or("The native provider rejected this request")
                ),
            }
            .into());
        }
        super::opencode_account::stream::relay(
            socket,
            response,
            body,
            super::opencode_account::CallerToolNames::default(),
            &mut cancelled,
            headers_started,
        )
        .await
    }
}
