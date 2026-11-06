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
use crate::runtime::run_log;

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
    let stdout_plugin_id = plugin_id.to_string();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            reader_client.accept_line(&line).await;
        }
        run_log::log(json!({ "event": "plugin_stdout_eof", "pluginId": stdout_plugin_id }));
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
    let wait_plugin_id = plugin_id.to_string();
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
        run_log::log(json!({ "event": "plugin_process_exited", "pluginId": wait_plugin_id }));
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
struct SessionChannel {
    session_id:String,
    held:bool,
    events:Option<Arc<dyn Fn(AdapterEvent)+Send+Sync>>,
    interaction:Option<Arc<dyn Fn(Value)->crate::adapters::BoxFuture<anyhow::Result<Value>>+Send+Sync>>,
    tool:Option<Arc<dyn Fn(Value)->crate::adapters::BoxFuture<anyhow::Result<Value>>+Send+Sync>>,
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
    sessions: Mutex<HashMap<String,SessionChannel>>,
    reverse_calls: Mutex<HashMap<i64,tokio::task::AbortHandle>>,
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
            sessions: Mutex::new(HashMap::new()),
            reverse_calls: Mutex::new(HashMap::new()),
            ready_sender: Mutex::new(Some(sender)),
            ready_receiver: Mutex::new(Some(receiver)),
        }
    }

    /// Asks the plugin to exit, waits briefly for it to terminate, then
    /// force-kills it. Must run before touching the plugin's files: a live
    /// process locks the exe on Windows, so uninstall/overwrite fails with
    /// os error 32/5.
    async fn stop(&self) {
        self.sessions.lock().unwrap().clear();
        for (_,call) in self.reverse_calls.lock().unwrap().drain(){call.abort();}
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
            Some("cancel_reverse_call")=>{if let Some(id)=value["id"].as_i64(){if let Some(call)=self.reverse_calls.lock().unwrap().remove(&id){call.abort();}}}
            Some("session_binding") => {
                let mut sessions=self.sessions.lock().unwrap();let binding=value["bindingId"].as_str().unwrap_or("");
                if value["active"]==true {if let Some(entry)=sessions.get_mut(binding){entry.held=true;}}else{sessions.remove(binding);}
            }
            Some("session_event") => {
                let callback=self.sessions.lock().unwrap().get(value["bindingId"].as_str().unwrap_or("")).and_then(|entry|entry.events.clone());
                if let Some(callback)=callback {callback(crate::adapters::event_from_json(&value["event"]));}
            }
            Some("session_interaction") | Some("session_tool") => {
                let client=self.clone();let interaction=value["type"]=="session_interaction";
                let id=value["id"].as_i64().unwrap_or(0);
                let handler=self.sessions.lock().unwrap().get(value["bindingId"].as_str().unwrap_or("")).and_then(|entry|if interaction{entry.interaction.clone()}else{entry.tool.clone()});
                let(start,started)=oneshot::channel();
                let task=tokio::spawn(async move {
                    let _=started.await;
                    let input=if interaction{value["input"].clone()}else{value.clone()};
                    let result=match handler {Some(handler)=>handler(input).await.unwrap_or_else(|error|json!({"success":false,"content":error.to_string(),"outcome":"cancelled"})),None=>json!({"outcome":"cancelled","success":false,"content":"Native session was released"})};
                    client.write(&if interaction{json!({"type":"interaction_response","id":value["id"],"response":result})}else{json!({"type":"tool_response","id":value["id"],"result":result})}).await;
                    client.reverse_calls.lock().unwrap().remove(&id);
                });
                self.reverse_calls.lock().unwrap().insert(id,task.abort_handle());let _=start.send(());
            }
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
                if is_exit {
                    run_log::run_event(run_id, "plugin_exit_frame", json!({}));
                }
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
                    let mut sessions=self.sessions.lock().unwrap();
                    if sessions.get(run_id).is_some_and(|entry|!entry.held) {sessions.remove(run_id);}
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
        self.sessions.lock().unwrap().clear();
        for (_,call) in self.reverse_calls.lock().unwrap().drain(){call.abort();}
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
    fn native_capabilities(&self,instance:&Value)->Value {
        let mut profile=agenthub_plugin_sdk::capabilities::describe(self.provider_id(),instance,&self.capabilities);
        profile["interactions"]["nativeTerminal"]=json!(self.capabilities["terminalPlan"]==true);
        profile["evidence"]["pluginNativeExperienceVersion"]=self.capabilities["nativeExperienceVersion"].clone();profile
    }
    async fn release_session(&self,request:&AdapterStartRequest)->CoreResult<()> {
        self.inner.sessions.lock().unwrap().retain(|_,entry|Some(entry.session_id.as_str())!=request.local_session_id.as_deref());
        self.inner.call("releaseSession",crate::adapters::start_request_to_json(request)).await.map(|_|()).map_err(|error|crate::errors::invalid("terminal",&error.to_string()))
    }
    async fn native_terminal(&self,request:AdapterStartRequest,resume:Option<String>)->CoreResult<crate::runtime::terminal_service::TerminalPlan> {
        let plan=self.inner.call("terminalPlan",json!({"request":crate::adapters::start_request_to_json(&request),"resume":resume})).await.map_err(|error|crate::errors::invalid("terminal",&error.to_string()))?;
        let mut resources:Vec<Box<dyn Send>>=vec![];
        if let Some(token)=plan["token"].as_str(){resources.push(Box::new(PluginTerminalLease{inner:self.inner.clone(),token:token.into()}));}
        Ok(crate::runtime::terminal_service::TerminalPlan{command:plan["command"].as_str().ok_or_else(||crate::errors::invalid("terminal","Plugin did not return an executable"))?.into(),
            args:plan["args"].as_array().into_iter().flatten().filter_map(Value::as_str).map(str::to_string).collect(),
            env:plan["env"].as_object().map(|env|env.iter().filter_map(|(key,value)|value.as_str().map(|value|(key.clone(),value.into()))).collect()),cwd:request.cwd,resources})
    }
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

    async fn list_modes(&self, instance: &Value, context: Option<&Value>) -> CoreResult<Value> {
        self.inner.call("listModes",json!({"instance":instance,"context":context})).await
            .map_err(|error|CoreError::reason(ErrorCode::IpcInternalError,error.to_string()))
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

struct PluginTerminalLease {inner:Arc<PluginClientInner>,token:String}
impl Drop for PluginTerminalLease {fn drop(&mut self){let inner=self.inner.clone();let token=self.token.clone();tokio::spawn(async move{let _=inner.call("closeTerminal",json!({"token":token})).await;});}}

impl PluginClient {
    fn launch(&self, mut request: AdapterStartRequest, resume: Option<String>) -> CoreResult<AdapterRun> {
        let observer=if self.descriptor["observeApiOutput"]==true {crate::adapters::api_stream_observer::ApiStreamObserver::prepare(&mut request)?}else{None};
        let run_id = uuid::Uuid::new_v4().to_string();
        self.inner.sessions.lock().unwrap().insert(run_id.clone(),SessionChannel{session_id:request.local_session_id.clone().unwrap_or_default(),held:false,events:request.session_events.clone(),interaction:request.session_interaction.clone(),tool:request.session_tool.clone()});
        let (sender, receiver) = mpsc::unbounded_channel::<Value>();
        self.inner.runs.lock().unwrap().insert(
            run_id.clone(),
            RunChannel {
                events: sender,
                interaction: request.request_interaction.clone(),
                tool_executor: request.execute_runtime_tool.clone(),
            },
        );
        let inner_cancel = self.inner.clone();
        let cancel_run_id = run_id.clone();
        let inner_steer = self.inner.clone();
        let steer_run_id = run_id.clone();
        let steer_acknowledgement = self.capabilities["steerAcknowledgement"] == true;
        let cancelled = Arc::new(AtomicBool::new(false));
        let cancel_flag = cancelled.clone();
        // Convert plugin wire frames into AdapterEvents.
        let (adapter_sender, adapter_receiver) = mpsc::unbounded_channel::<AdapterEvent>();
        let descriptor = self.descriptor.clone();
        let inner = self.inner.clone();
        tokio::spawn(async move {
            // The plugin chooses its native wire and owns CLI configuration.
            // The host supplies reusable protocol bridges without CLI names.
            let preparation = async {
                let mut responses_proxy = None;
                let mut messages_proxy = None;
                if request.instance.pointer("/providerOptions/runtimeConnectionId").is_some() {
                    let native = if descriptor["connectionProtocolDiscovery"] == true {
                        inner.call("connectionProtocol", crate::adapters::start_request_to_json(&request)).await?
                    } else { descriptor["nativeApiProtocol"].clone() };
                    let source = request.instance.pointer("/providerOptions/apiType").and_then(Value::as_str);
                    if native == "responses" && matches!(source, Some("openai-completions" | "anthropic-messages")) {
                        let base = request.instance.pointer("/providerOptions/baseUrl").and_then(Value::as_str).unwrap_or("").to_string();
                        let proxy = crate::adapters::codex::chat_compat::ChatCompatProxy::start_protocol(base, request.env.clone().unwrap_or_default(), false, source == Some("anthropic-messages"))?;
                        let env = request.env.get_or_insert_with(HashMap::new);
                        let upstream_key = env.get("NAUTILO_CONNECTION_API_KEY").cloned().unwrap_or_default();
                        let local_key = uuid::Uuid::new_v4().to_string();
                        for value in env.values_mut() { if !upstream_key.is_empty() && value == &upstream_key { *value = local_key.clone(); } }
                        env.insert("OPENAI_BASE_URL".into(), proxy.base_url());
                        request.instance["providerOptions"]["baseUrl"] = json!(proxy.base_url());
                        request.instance["providerOptions"]["apiType"] = json!("openai-responses");
                        responses_proxy = Some(proxy);
                    } else if native == "anthropic" {
                        messages_proxy = crate::adapters::claude::api_proxy::ApiProxy::prepare(&mut request)?;
                        if messages_proxy.is_some() {
                            let base = request.env.as_ref().and_then(|env|env.get("ANTHROPIC_BASE_URL")).cloned();
                            request.instance["providerOptions"]["baseUrl"] = json!(base);
                            request.instance["providerOptions"]["apiType"] = json!("anthropic-messages");
                        }
                    }
                }
                Ok::<_, anyhow::Error>((responses_proxy, messages_proxy))
            }.await;
            let (responses_proxy, messages_proxy) = match preparation {
                Ok(proxies) => proxies,
                Err(error) => {
                    inner.runs.lock().unwrap().remove(&run_id);
                    let _ = adapter_sender.send(AdapterEvent::Error { message: error.to_string() });
                    let _ = adapter_sender.send(AdapterEvent::Exit { exit_code: Some(1), signal: None });
                    return;
                }
            };
            if cancelled.load(Ordering::Acquire) { return; }
            let mut wire_request=crate::adapters::start_request_to_json(&request);
            wire_request["sessionBindingId"]=json!(run_id);
            inner.write(&json!({
                "type": "start", "runId": run_id,
                "resume": resume.map(Value::String).unwrap_or(Value::Null),
                "request": wire_request
            })).await;
            let mut receiver = receiver;
            while let Some(frame) = receiver.recv().await {
                if adapter_sender.send(crate::adapters::event_from_json(&frame)).is_err() {
                    break;
                }
            }
            drop(responses_proxy);
            drop(messages_proxy);
        });
        let run = AdapterRun::new(
            adapter_receiver,
            move || {
                Box::pin(async move {
                    cancel_flag.store(true, Ordering::Release);
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
                if steer_acknowledgement {
                    inner.call("steer",json!({"runId":run_id,"input":input})).await
                        .map_err(|error|CoreError::reason(ErrorCode::IpcInternalError,error.to_string()))?;
                    return Ok(());
                }
                inner.write(&json!({ "type": "steer", "runId": run_id, "input": input })).await;
                Ok(())
            }) as crate::adapters::BoxFuture<CoreResult<()>>
        }));
        Ok(match observer { Some(observer)=>observer.wrap(run),None=>run })
    }
}

#[cfg(test)]
mod background_wire_tests {
    use super::*;
    struct Dropped(Arc<AtomicBool>);
    impl Drop for Dropped {fn drop(&mut self){self.0.store(true,Ordering::Release);}}
    #[tokio::test]
    async fn background_binding_survives_exit_and_cancels_abandoned_reverse_calls() {
        let mut command=tokio::process::Command::new("node");
        command.args(["-e","process.stdin.resume()"]).stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
        #[cfg(windows)] {command.creation_flags(0x08000000);}
        let mut child=command.spawn().unwrap();let stdin=child.stdin.take().unwrap();
        let client=Arc::new(PluginClientInner::new("fixture",stdin,child));
        let seen=Arc::new(Mutex::new(Vec::new()));let output=seen.clone();let dropped=Arc::new(AtomicBool::new(false));let cancelled=dropped.clone();
        client.sessions.lock().unwrap().insert("binding".into(),SessionChannel{session_id:"s".into(),held:false,
            events:Some(Arc::new(move|event|output.lock().unwrap().push(event))),
            interaction:Some(Arc::new(move|_|{let guard=Dropped(cancelled.clone());Box::pin(async move{let _guard=guard;std::future::pending().await})})),tool:None});
        client.accept_line(&json!({"type":"session_binding","bindingId":"binding","active":true}).to_string()).await;
        client.accept_line(&json!({"type":"event","runId":"binding","event":{"kind":"exit","exitCode":0}}).to_string()).await;
        assert!(client.sessions.lock().unwrap().contains_key("binding"));
        client.accept_line(&json!({"type":"session_event","bindingId":"binding","event":{"kind":"tool","callId":"late","name":"Read","phase":"completed","success":true}}).to_string()).await;
        assert!(matches!(&seen.lock().unwrap()[0],AdapterEvent::Tool{call_id,..} if call_id.as_deref()==Some("late")));
        client.accept_line(&json!({"type":"session_interaction","bindingId":"binding","id":42,"input":{"kind":"question"}}).to_string()).await;
        tokio::task::yield_now().await;assert_eq!(client.reverse_calls.lock().unwrap().len(),1);
        client.accept_line(&json!({"type":"cancel_reverse_call","id":42}).to_string()).await;
        tokio::task::yield_now().await;assert!(dropped.load(Ordering::Acquire));assert!(client.reverse_calls.lock().unwrap().is_empty());
        client.accept_line(&json!({"type":"session_binding","bindingId":"binding","active":false}).to_string()).await;
        assert!(client.sessions.lock().unwrap().is_empty());
        client.accept_line(&json!({"type":"session_event","bindingId":"binding","event":{"kind":"message","text":"released"}}).to_string()).await;
        assert_eq!(seen.lock().unwrap().len(),1);
        if let Some(child)=client.child.lock().await.as_mut(){let _=child.kill().await;};
    }
}
