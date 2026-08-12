//! Plugin subprocess client — the daemon side of the plugin wire protocol.
//! One long-lived process per plugin; runs multiplex by runId.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin};
use tokio::sync::{mpsc, oneshot};

use crate::adapters::{
    AdapterCapabilities, AdapterDetectionResult, AdapterEvent, AdapterResumeRequest, AdapterRun, AdapterStartRequest,
    AgentCliAdapter,
};
use crate::errors::{CoreError, CoreResult, ErrorCode};

/// Spawns a plugin binary and performs the handshake. Returns the adapter
/// once the plugin's descriptor/capabilities are known.
pub async fn launch_plugin(plugin_id: &str, executable: &std::path::Path, dir: &std::path::Path) -> anyhow::Result<PluginClient> {
    let mut command = tokio::process::Command::new(executable);
    command.current_dir(dir);
    command.stdin(std::process::Stdio::piped());
    command.stdout(std::process::Stdio::piped());
    command.stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child: Child = command.spawn()?;
    let stdin = child.stdin.take().expect("piped stdin");
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");

    let client = Arc::new(PluginClientInner::new(&plugin_id.to_string(), stdin, child));
    let reader_client = client.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            reader_client.accept_line(&line).await;
        }
        reader_client.shutdown().await;
    });
    // Plugin stderr is diagnostics only.
    let stderr_plugin_id = plugin_id.to_string();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            eprintln!("[plugin:{stderr_plugin_id}] {line}");
        }
    });
    // Reap the child once it exits. The handle stays in PluginClientInner so
    // stop() can poll/kill it; this task only takes it after try_wait confirms
    // the process is gone, then flags the exit. (Taking it eagerly would make
    // stop() believe the process exited and never force-kill it.)
    let wait_child = client.child.clone();
    let wait_exited = client.exited.clone();
    tokio::spawn(async move {
        loop {
            let mut guard = wait_child.lock().await;
            match guard.as_mut() {
                Some(child) => match child.try_wait() {
                    Ok(Some(_)) => {
                        guard.take(); // reap
                        break;
                    }
                    Ok(None) => {
                        drop(guard);
                        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                    }
                    Err(_) => {
                        guard.take();
                        break;
                    }
                },
                None => break, // stop() force-killed and reaped it
            }
        }
        wait_exited.store(true, Ordering::Relaxed);
    });

    client.write(&json!({ "type": "handshake", "apiVersion": agenthub_plugin_api_version() })).await;
    let ready = client.wait_ready().await?;
    Ok(PluginClient { inner: client, descriptor: ready.0, capabilities: ready.1 })
}

fn agenthub_plugin_api_version() -> u32 {
    1
}

struct RunChannel {
    events: mpsc::UnboundedSender<Value>,
    interaction: Option<Arc<dyn Fn(Value) -> crate::adapters::BoxFuture<anyhow::Result<Value>> + Send + Sync>>,
    tool_executor: Option<Arc<dyn Fn(Value) -> crate::adapters::BoxFuture<anyhow::Result<Value>> + Send + Sync>>,
}

struct PluginClientInner {
    plugin_id: String,
    stdin: tokio::sync::Mutex<ChildStdin>,
    /// The spawned process. The reap task takes it out only after try_wait
    /// confirms the process exited; stop() polls it and force-kills when the
    /// plugin does not terminate on its own. Dropping this handle without
    /// killing leaks the process, which keeps the exe locked on Windows
    /// (os error 32/5 on uninstall and reinstall).
    child: Arc<tokio::sync::Mutex<Option<Child>>>,
    /// Set once the process has fully exited (reaped).
    exited: Arc<AtomicBool>,
    next_call_id: AtomicI64,
    pending_calls: Mutex<HashMap<i64, oneshot::Sender<Value>>>,
    runs: Mutex<HashMap<String, RunChannel>>,
    ready_sender: Mutex<Option<oneshot::Sender<(Value, Value)>>>,
    ready_receiver: Mutex<Option<oneshot::Receiver<(Value, Value)>>>,
}

impl PluginClientInner {
    fn new(plugin_id: &str, stdin: ChildStdin, child: Child) -> Self {
        let (sender, receiver) = oneshot::channel();
        Self {
            plugin_id: plugin_id.to_string(),
            stdin: tokio::sync::Mutex::new(stdin),
            child: Arc::new(tokio::sync::Mutex::new(Some(child))),
            exited: Arc::new(AtomicBool::new(false)),
            next_call_id: AtomicI64::new(1),
            pending_calls: Mutex::new(HashMap::new()),
            runs: Mutex::new(HashMap::new()),
            ready_sender: Mutex::new(Some(sender)),
            ready_receiver: Mutex::new(Some(receiver)),
        }
    }

    /// Asks the plugin to exit, waits briefly for it to terminate, then
    /// force-kills it. Must run before touching the plugin's files: a live
    /// process locks the exe on Windows, so uninstall/overwrite fails with
    /// os error 32/5.
    async fn stop(&self) {
        // Fire-and-forget: the SDK exits on dispose without a response frame,
        // so a call() would just sit until its timeout.
        self.write(&json!({ "type": "dispose" })).await;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        loop {
            if self.exited.load(Ordering::Relaxed) {
                return;
            }
            let mut guard = self.child.lock().await;
            if let Some(child) = guard.as_mut() {
                if let Ok(Some(_)) = child.try_wait() {
                    return;
                }
            }
            drop(guard);
            if std::time::Instant::now() >= deadline {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        // Force-kill: releases the exe lock on Windows.
        let mut guard = self.child.lock().await;
        if let Some(child) = guard.as_mut() {
            let _ = child.kill().await;
        }
    }

    async fn write(&self, frame: &Value) {
        let mut payload = serde_json::to_vec(frame).unwrap_or_default();
        payload.push(b'\n');
        let mut stdin = self.stdin.lock().await;
        let _ = stdin.write_all(&payload).await;
        let _ = stdin.flush().await;
    }

    async fn wait_ready(&self) -> anyhow::Result<(Value, Value)> {
        let receiver = self
            .ready_receiver
            .lock()
            .unwrap()
            .take()
            .ok_or_else(|| anyhow::anyhow!("plugin handshake already consumed"))?;
        let (descriptor, capabilities) = tokio::time::timeout(std::time::Duration::from_secs(15), receiver)
            .await
            .map_err(|_| anyhow::anyhow!("plugin did not answer the handshake in time"))??;
        Ok((descriptor, capabilities))
    }

    async fn call(&self, method: &str, input: Value) -> anyhow::Result<Value> {
        let id = self.next_call_id.fetch_add(1, Ordering::SeqCst);
        let (sender, receiver) = oneshot::channel();
        self.pending_calls.lock().unwrap().insert(id, sender);
        self.write(&json!({ "type": "call", "id": id, "method": method, "input": input })).await;
        let frame = tokio::time::timeout(std::time::Duration::from_secs(60), receiver)
            .await
            .map_err(|_| anyhow::anyhow!("plugin call {method} timed out"))??;
        if frame.get("ok").and_then(Value::as_bool) == Some(true) {
            Ok(frame.get("data").cloned().unwrap_or(Value::Null))
        } else {
            anyhow::bail!(frame.get("error").and_then(Value::as_str).unwrap_or("plugin call failed").to_string())
        }
    }

    async fn accept_line(self: &Arc<Self>, line: &str) {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            return;
        };
        match value.get("type").and_then(Value::as_str) {
            Some("ready") => {
                let sender = self.ready_sender.lock().unwrap().take();
                if let Some(sender) = sender {
                    let _ = sender.send((
                        value.get("descriptor").cloned().unwrap_or(Value::Null),
                        value.get("capabilities").cloned().unwrap_or(Value::Null),
                    ));
                }
            }
            Some("response") => {
                if let Some(id) = value.get("id").and_then(Value::as_i64) {
                    let sender = self.pending_calls.lock().unwrap().remove(&id);
                    if let Some(sender) = sender {
                        let _ = sender.send(value);
                    }
                }
            }
            Some("event") => {
                let run_id = value.get("runId").and_then(Value::as_str).unwrap_or("");
                let is_exit = value.get("event").and_then(|event| event.get("kind")).and_then(Value::as_str) == Some("exit");
                let sender = self.runs.lock().unwrap().get(run_id).map(|run| run.events.clone());
                if let Some(sender) = sender {
                    let _ = sender.send(value.get("event").cloned().unwrap_or(Value::Null));
                }
                if is_exit {
                    // Remove the channel so the run stream actually ends: the
                    // sender living in this map is the only thing keeping it
                    // open, and an open stream means the turn never finalizes
                    // (no run.failed/run.completed — the UI spins forever).
                    self.runs.lock().unwrap().remove(run_id);
                }
            }
            Some("interaction") => {
                // Never await the user's answer inline: a pending approval
                // would block the line reader and every later event (from
                // other runs too) queues behind it until the UI responds —
                // the "messages stop arriving after Cancel, then all appear
                // after the next Cancel" hang. Handle it in its own task.
                let client = self.clone();
                let id = value.get("id").and_then(Value::as_i64).unwrap_or(0);
                let run_id = value.get("runId").and_then(Value::as_str).unwrap_or("").to_string();
                let input = value.get("input").cloned().unwrap_or(Value::Null);
                tokio::spawn(async move {
                    let handler = client.runs.lock().unwrap().get(&run_id).and_then(|run| run.interaction.clone());
                    let response = match handler {
                        Some(handler) => handler(input).await.unwrap_or_else(|_| json!({ "outcome": "cancelled" })),
                        None => json!({ "outcome": "cancelled" }),
                    };
                    client.write(&json!({ "type": "interaction_response", "id": id, "response": response })).await;
                });
            }
            Some("tool_call") => {
                // Same reasoning as interaction: a slow runtime tool call must
                // not stall the reader for other runs' events.
                let client = self.clone();
                let id = value.get("id").and_then(Value::as_i64).unwrap_or(0);
                let run_id = value.get("runId").and_then(Value::as_str).unwrap_or("").to_string();
                let call = value.clone();
                tokio::spawn(async move {
                    let executor = client.runs.lock().unwrap().get(&run_id).and_then(|run| run.tool_executor.clone());
                    let result = match executor {
                        Some(executor) => executor(call).await.unwrap_or_else(|error| {
                            json!({ "success": false, "content": error.to_string() })
                        }),
                        None => json!({ "success": false, "content": "runtime tools unavailable" }),
                    };
                    client.write(&json!({ "type": "tool_response", "id": id, "result": result })).await;
                });
            }
            Some("fatal") => {
                eprintln!("[plugin:{}] fatal: {}", self.plugin_id, value.get("error").and_then(Value::as_str).unwrap_or(""));
            }
            _ => {}
        }
    }

    async fn shutdown(&self) {
        let pending: Vec<oneshot::Sender<Value>> = self.pending_calls.lock().unwrap().drain().map(|(_, s)| s).collect();
        for sender in pending {
            let _ = sender.send(json!({ "ok": false, "error": "plugin process exited" }));
        }
        let runs: Vec<RunChannel> = self.runs.lock().unwrap().drain().map(|(_, r)| r).collect();
        for run in runs {
            let _ = run.events.send(json!({ "kind": "error", "message": "plugin process exited" }));
            // Deliberately NO fake "exit" frame: consume() uses the
            // presence of a real exit event to distinguish a completed
            // run from one whose process died mid-run.
        }
    }
}

/// The registered adapter facade for one loaded plugin.
pub struct PluginClient {
    inner: Arc<PluginClientInner>,
    descriptor: Value,
    capabilities: Value,
}

#[async_trait::async_trait]
impl AgentCliAdapter for PluginClient {
    fn provider_id(&self) -> &str {
        self.descriptor.get("providerId").and_then(Value::as_str).unwrap_or("plugin")
    }

    fn descriptor(&self) -> Value {
        self.descriptor.clone()
    }

    fn capabilities(&self) -> AdapterCapabilities {
        let flag = |key: &str| self.capabilities.get(key).and_then(Value::as_bool).unwrap_or(false);
        AdapterCapabilities {
            structured_output: flag("structuredOutput"),
            text_output: flag("textOutput"),
            interactive_stdin: flag("interactiveStdin"),
            native_resume: flag("nativeResume"),
            pty: flag("pty"),
        }
    }

    async fn detect(&self, instance: &Value) -> AdapterDetectionResult {
        match self.inner.call("detect", instance.clone()).await {
            Ok(value) => AdapterDetectionResult {
                installed: value.get("installed").and_then(Value::as_bool).unwrap_or(false),
                compatible: value.get("compatible").and_then(Value::as_bool),
                executable: value.get("executable").and_then(Value::as_str).unwrap_or("").to_string(),
                version: value.get("version").and_then(Value::as_str).map(str::to_string),
                help: value.get("help").and_then(Value::as_str).map(str::to_string),
                error: value.get("error").and_then(Value::as_str).map(str::to_string),
            },
            Err(error) => AdapterDetectionResult {
                installed: false,
                executable: instance.get("executable").and_then(Value::as_str).unwrap_or("").to_string(),
                error: Some(error.to_string()),
                ..Default::default()
            },
        }
    }

    async fn list_models(&self, instance: &Value, context: Option<&Value>) -> Option<CoreResult<Value>> {
        let input = json!({
            "instance": instance,
            "context": context.cloned().unwrap_or(Value::Null)
        });
        // The plugin SDK call passes (instance, context) — send both.
        match self.inner.call("listModels", input).await {
            Ok(catalog) => Some(Ok(catalog)),
            Err(error) => Some(Err(CoreError::reason(ErrorCode::IpcInternalError, error.to_string()))),
        }
    }

    fn start(&self, request: AdapterStartRequest) -> CoreResult<AdapterRun> {
        self.launch(request, None)
    }

    fn resume(&self, request: AdapterResumeRequest) -> CoreResult<AdapterRun> {
        self.launch(request.start, Some(request.provider_session_id))
    }

    async fn dispose(&self) {
        // Terminate the process (dispose frame, then force-kill if needed) so
        // the plugin's files can be removed or replaced.
        self.inner.stop().await;
    }
}

impl PluginClient {
    fn launch(&self, request: AdapterStartRequest, resume: Option<String>) -> CoreResult<AdapterRun> {
        let run_id = uuid::Uuid::new_v4().to_string();
        let (sender, receiver) = mpsc::unbounded_channel::<Value>();
        let request_json = crate::adapters::start_request_to_json(&request);
        self.inner.runs.lock().unwrap().insert(
            run_id.clone(),
            RunChannel {
                events: sender,
                interaction: request.request_interaction.clone(),
                tool_executor: request.execute_runtime_tool.clone(),
            },
        );
        let inner = self.inner.clone();
        let frame = json!({
            "type": "start",
            "runId": run_id,
            "resume": resume.map(Value::String).unwrap_or(Value::Null),
            "request": request_json
        });
        // Fire-and-forget write: the plugin acknowledges by streaming events.
        tokio::spawn(async move {
            inner.write(&frame).await;
        });

        let inner_cancel = self.inner.clone();
        let cancel_run_id = run_id.clone();
        let inner_steer = self.inner.clone();
        let steer_run_id = run_id.clone();
        // Convert plugin wire frames into AdapterEvents.
        let (adapter_sender, adapter_receiver) = mpsc::unbounded_channel::<AdapterEvent>();
        tokio::spawn(async move {
            let mut receiver = receiver;
            while let Some(frame) = receiver.recv().await {
                if adapter_sender.send(crate::adapters::event_from_json(&frame)).is_err() {
                    break;
                }
            }
        });
        let run = AdapterRun::new(
            adapter_receiver,
            move || {
                Box::pin(async move {
                    inner_cancel.runs.lock().unwrap().remove(&cancel_run_id);
                    inner_cancel.write(&json!({ "type": "cancel", "runId": cancel_run_id })).await;
                }) as crate::adapters::BoxFuture<()>
            },
            move |_input| {},
        )
        .with_steer(Arc::new(move |input: String| {
            let inner = inner_steer.clone();
            let run_id = steer_run_id.clone();
            Box::pin(async move {
                inner.write(&json!({ "type": "steer", "runId": run_id, "input": input })).await;
                Ok(())
            }) as crate::adapters::BoxFuture<CoreResult<()>>
        }));
        Ok(run)
    }
}
