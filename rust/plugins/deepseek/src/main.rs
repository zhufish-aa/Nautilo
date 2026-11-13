#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod config;
mod events;
mod interactions;
mod runtime;
#[cfg(windows)]
mod windows_workspace;

mod native_experience;

use agenthub_plugin_sdk::process::{self, ProcessEvent, ProcessHandle, ProcessRequest};
use agenthub_plugin_sdk::{DaemonChannel, ProviderPlugin};
use runtime::{IdleRuntime, RunRoute, RuntimePool, SessionRoutes};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, oneshot};

#[derive(Clone)]
struct Native {
    process: ProcessHandle,
    client: reqwest::Client,
    alive: Arc<AtomicBool>,
    routes: Arc<Mutex<SessionRoutes>>,
    interactions: Arc<Mutex<HashMap<String, tokio::task::AbortHandle>>>,
    endpoint: Arc<Mutex<Option<String>>>,
    session: Arc<Mutex<String>>,
    token: String,
    barriers: Arc<Mutex<HashMap<String, oneshot::Sender<()>>>>,
    opened: tokio::sync::watch::Sender<bool>,
    ending: Arc<AtomicBool>,
    cancelled: Arc<AtomicBool>,
    guidance: Arc<AtomicU64>,
    admission: Arc<tokio::sync::Mutex<()>>,
}
impl Native {
    async fn call(&self, path: &str, body: Value) -> anyhow::Result<Value> {
        let base = self
            .endpoint
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| anyhow::anyhow!("DeepSeek runtime is still starting"))?;
        let response = self
            .client
            .post(format!("{base}{path}"))
            .bearer_auth(&self.token)
            .timeout(Duration::from_secs(
                if path == "/wait" || path == "/compact" {
                    1800
                } else if path == "/plugins" {
                    780
                } else {
                    60
                },
            ))
            .json(&body)
            .send()
            .await?;
        let status = response.status();
        let value: Value = response.json().await?;
        anyhow::ensure!(
            status.is_success(),
            "{}",
            value["error"]
                .as_str()
                .unwrap_or("DeepSeek runtime request failed")
        );
        Ok(value)
    }
    async fn close(&self) {
        self.alive.store(false, Ordering::Release);
        self.ending.store(true, Ordering::Release);
        self.opened.send_replace(true);
        self.process.end_stdin();
        self.process.cancel().await;
    }
    async fn drain(&self) -> anyhow::Result<()> {
        let id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        self.barriers.lock().unwrap().insert(id.clone(), tx);
        self.call("/drain", json!({"id":id})).await?;
        tokio::time::timeout(Duration::from_secs(5), rx).await??;
        Ok(())
    }
}

#[derive(Default)]
struct DeepSeek {
    #[cfg(windows)]
    workspace_access: Arc<windows_workspace::WorkspaceAccess>,
    active: Arc<Mutex<HashMap<String, Native>>>,
    daemon: Mutex<Option<Arc<dyn DaemonChannel>>>,
    pool: Arc<Mutex<RuntimePool>>,
    plugin_management: tokio::sync::Mutex<()>,
    // The native workspace registry takes a snapshot on startup. Publish a new
    // session's membership before another runtime opens the same registry.
    workspace_open: Arc<tokio::sync::Mutex<()>>,
    plugin_resource_id: std::sync::OnceLock<String>,
}

fn descriptor() -> Value {
    serde_json::from_str::<Value>(include_str!("../agenthub-plugin.json")).unwrap()["descriptor"]
        .clone()
}

fn launch(
    request: &Value,
    cfg: &config::Config,
    route: RunRoute,
) -> anyhow::Result<(Native, oneshot::Receiver<Result<(), String>>)> {
    let mut started = process::start(&ProcessRequest {
        command: cfg.executable.clone(),
        args: cfg.args.clone(),
        cwd: request["cwd"].as_str().map(str::to_string),
        env: Some(cfg.env.clone()),
        inherit_env: true,
        // Limits belong to a turn, not to the lifetime of the reused server.
        timeout_ms: None,
        idle_timeout_ms: None,
        max_output_bytes: None,
    })?;
    let native = Native {
        process: started.handle,
        client: reqwest::Client::builder().no_proxy().build()?,
        alive: Arc::new(AtomicBool::new(true)),
        routes: Arc::new(Mutex::new(SessionRoutes::default())),
        interactions: Arc::new(Mutex::new(HashMap::new())),
        endpoint: Arc::new(Mutex::new(None)),
        session: Arc::new(Mutex::new(String::new())),
        token: cfg.token.clone(),
        barriers: Arc::new(Mutex::new(HashMap::new())),
        opened: tokio::sync::watch::channel(false).0,
        ending: Arc::new(AtomicBool::new(false)),
        cancelled: Arc::new(AtomicBool::new(false)),
        guidance: Arc::new(AtomicU64::new(0)),
        admission: Arc::new(tokio::sync::Mutex::new(())),
    };
    native.routes.lock().unwrap().begin(route, "");
    let pump = native.clone();
    let (ready, readiness) = oneshot::channel();
    tokio::spawn(async move {
        let mut ready = Some(ready);
        let mut buffer = String::new();
        while let Some(event) = started.events.recv().await {
            match event {
                ProcessEvent::Stdout(text) => {
                    buffer.push_str(&text);
                    while let Some(end) = buffer.find('\n') {
                        let line = buffer[..end].trim_end_matches('\r').to_string();
                        buffer.drain(..=end);
                        let Some(payload) = line.strip_prefix("@nautilo-dsh:") else {
                            // The Web profile may print its own URL or diagnostics.
                            continue;
                        };
                        let Ok(value) = serde_json::from_str::<Value>(payload) else {
                            continue;
                        };
                        if value["kind"] == "barrier" {
                            if let Some(waiter) = pump
                                .barriers
                                .lock()
                                .unwrap()
                                .remove(value["id"].as_str().unwrap_or(""))
                            {
                                let _ = waiter.send(());
                            }
                            continue;
                        }
                        if value["kind"] == "ready" {
                            if let Some(port) =
                                value["port"].as_u64().filter(|p| *p > 0 && *p < 65536)
                            {
                                *pump.endpoint.lock().unwrap() =
                                    Some(format!("http://127.0.0.1:{port}"));
                                if let Some(ready) = ready.take() {
                                    let _ = ready.send(Ok(()));
                                }
                            }
                            continue;
                        }
                        if value["kind"] == "approval"
                            || value["kind"] == "host_tool"
                            || value["kind"] == "question"
                        {
                            interactions::dispatch(&pump, value);
                        } else if value["kind"] == "interaction_cancel" {
                            if let Some(task) = pump.interactions.lock().unwrap()
                                .remove(value["id"].as_str().unwrap_or("")) { task.abort(); }
                        } else {
                            let root = pump.session.lock().unwrap().clone();
                            pump.routes.lock().unwrap().accept(&value, &root, payload.len());
                        }
                    }
                }
                ProcessEvent::Stderr(text) => {
                    pump.activity(text.len());
                    pump.emit(json!({"kind":"raw","stream":"stderr","text":text}));
                }
                ProcessEvent::Error(error) => {
                    if let Some(ready) = ready.take() {
                        let _ = ready.send(Err(error.clone()));
                    }
                    pump.emit(json!({"kind":"error","message":error,"retryable":true}));
                }
                ProcessEvent::Timeout { reason } => {
                    pump.emit(json!({"kind":"error","message":reason,"retryable":true}));
                }
                ProcessEvent::Exit { exit_code, signal } => {
                    pump.routes.lock().unwrap().close(json!({"kind":"exit","exitCode":exit_code,"signal":signal}));
                    break;
                }
            }
        }
        pump.alive.store(false, Ordering::Release);
        for (_, task) in pump.interactions.lock().unwrap().drain() { task.abort(); }
        pump.routes.lock().unwrap().close(json!({"kind":"exit","exitCode":null}));
        pump.barriers.lock().unwrap().clear();
        if let Some(ready) = ready.take() {
            let _ = ready.send(Err(
                "DeepSeek Harness exited before its transport was ready".into(),
            ));
        }
    });
    Ok((native, readiness))
}

async fn ready(readiness: oneshot::Receiver<Result<(), String>>) -> anyhow::Result<()> {
    match tokio::time::timeout(Duration::from_secs(60), readiness).await {
        Ok(Ok(Ok(()))) => Ok(()),
        Ok(Ok(Err(error))) => anyhow::bail!(error),
        _ => anyhow::bail!("DeepSeek Harness did not finish starting within 60 seconds"),
    }
}

impl DeepSeek {
    async fn catalog(&self, instance: &Value, context: &Value) -> anyhow::Result<Value> {
        self.profile_operation(instance, context, "/catalog", json!({})).await
    }

    async fn profile_operation(&self, instance: &Value, context: &Value, path: &str, body: Value) -> anyhow::Result<Value> {
        let cwd = context["cwd"]
            .as_str()
            .map(str::to_string)
            .unwrap_or_else(|| {
                std::env::current_dir()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned()
            });
        let resource_id = if path == "/plugins" {
            self.plugin_resource_id.get_or_init(|| format!("plugins-{}", uuid::Uuid::new_v4())).clone()
        } else {
            format!("catalog-{}", uuid::Uuid::new_v4())
        };
        let request = json!({"instance":instance,"cwd":cwd,"env":context["env"],"localSessionId":resource_id,"timeoutMs":90_000,
            "pluginManagementWrite":path == "/plugins" && body["action"] != "list"});
        let cfg = config::prepare(&request)?;
        let (sender, mut receiver) = mpsc::unbounded_channel();
        let (native, readiness) = launch(&request, &cfg, RunRoute::new(String::new(), sender, None, None, None))?;
        tokio::spawn(async move { while receiver.recv().await.is_some() {} });
        let result = async {
            ready(readiness).await?;
            native.call(path, body).await
        }
        .await;
        native.close().await;
        result
    }
}

#[async_trait::async_trait]
impl ProviderPlugin for DeepSeek {
    fn descriptor(&self) -> Value {
        descriptor()
    }
    fn capabilities(&self)->Value {
        agenthub_plugin_sdk::capabilities::with_profile(json!({"structuredOutput":true,"textOutput":true,"interactiveStdin":true,"nativeResume":true,"pty":false,"steerAcknowledgement":true,"sessionBackgroundEvents":true}),native_experience::declarations())
    }
    fn set_daemon_channel(&self, channel: Arc<dyn DaemonChannel>) {
        *self.daemon.lock().unwrap() = Some(channel);
    }
    async fn detect(&self, instance: &Value) -> Value {
        let executable = instance["executable"]
            .as_str()
            .filter(|v| !v.is_empty())
            .unwrap_or("dsh");
        let result = process::start(&ProcessRequest {
            command: executable.into(),
            args: vec!["--version".into()],
            inherit_env: true,
            timeout_ms: Some(10_000),
            ..Default::default()
        });
        let Ok(mut started) = result else {
            return json!({"installed":false,"executable":executable,"error":result.err().unwrap().to_string()});
        };
        let mut text = String::new();
        let mut success = false;
        while let Some(event) = started.events.recv().await {
            match event {
                ProcessEvent::Stdout(s) => text.push_str(&s),
                ProcessEvent::Exit { exit_code, .. } => success = exit_code == Some(0),
                _ => {}
            }
        }
        json!({"installed":success,"executable":executable,"version":text.trim()})
    }
    async fn list_models(&self, instance: &Value, context: &Value) -> anyhow::Result<Value> {
        let catalog = self.catalog(instance, context).await?;
        let mut models = vec![];
        for group in catalog["models"]["groups"].as_array().into_iter().flatten() {
            for model in group["models"].as_array().into_iter().flatten() {
                let id = format!(
                    "{}::{}",
                    group["id"].as_str().unwrap_or(""),
                    model["id"].as_str().unwrap_or("")
                );
                models.push(json!({"id":id,"displayName":model["name"],"isDefault":false,"capabilities":[],"serviceTiers":[],
                    "reasoningEfforts":model["reasoning"]["efforts"].as_array().into_iter().flatten().filter_map(|v|v["id"].as_str()).collect::<Vec<_>>(),
                    "defaultReasoningEffort":model["reasoning"]["defaultEffort"] }));
            }
        }
        let default = &catalog["models"]["default"];
        let default_id = format!(
            "{}::{}",
            default["provider"].as_str().unwrap_or(""),
            default["model"].as_str().unwrap_or("")
        );
        for model in &mut models {
            model["isDefault"] = json!(model["id"] == default_id);
        }
        Ok(
            json!({"providerId":"deepseek","models":models,"source":"provider_cli","fetchedAt":chrono::Utc::now().to_rfc3339(),"defaultModel":default_id}),
        )
    }
    async fn harness_plugins(&self, instance: &Value, context: &Value, operation: &Value) -> anyhow::Result<Value> {
        let _guard = self.plugin_management.lock().await;
        self.profile_operation(instance, context, "/plugins", operation.clone()).await
    }

    async fn list_modes(&self, instance: &Value, context: &Value) -> anyhow::Result<Value> {
        let catalog = self.catalog(instance, context).await?;
        Ok(json!({"modes":catalog["modes"],"defaultMode":catalog["defaultMode"]}))
    }
    async fn start(
        &self,
        run_id: &str,
        request: Value,
        resume: Option<String>,
    ) -> anyhow::Result<mpsc::UnboundedReceiver<Value>> {
        let started_at = Instant::now();
        let session = resume.clone().unwrap_or_else(|| {
            format!(
                "nautilo-{}",
                request["localSessionId"].as_str().unwrap_or(run_id)
            )
        });
        anyhow::ensure!(
            !self
                .active
                .lock()
                .unwrap()
                .values()
                .any(|native| *native.session.lock().unwrap() == session),
            "DeepSeek session already has an active turn"
        );
        let identity = runtime::identity(&request);
        let cache_key = request["localSessionId"].as_str().unwrap_or(&session).to_string();
        let cached = self.pool.lock().unwrap().take(&cache_key);
        let (sender, receiver) = mpsc::unbounded_channel();
        let daemon = self.daemon.lock().unwrap().clone();
        let session_channel = agenthub_plugin_sdk::session_channel(&daemon, &request);
        let background = if let (Some(channel), Some(binding)) = (&daemon, request["sessionBindingId"].as_str()) {
            Some(agenthub_plugin_sdk::session_sink(channel.clone(), binding.into()).await)
        } else { None };
        let route = RunRoute::new(run_id.into(), sender.clone(), daemon.clone(), background, session_channel);
        let reusable = cached.as_ref().is_some_and(|cached| {
            resume.is_some()
                && cached.identity == identity
                && cached.native.alive.load(Ordering::Acquire)
        });
        let workspace_open = if reusable { None } else {
            Some(self.workspace_open.clone().lock_owned().await)
        };
        let (native, readiness, provider, model) = if reusable {
            let cached = cached.unwrap();
            // Flush already emitted frames through their old route before
            // admitting a new prompt. Children retain their own original route.
            if let Err(error) = cached.native.drain().await {
                cached.native.close().await;
                return Err(error);
            }
            let native = cached.native.next_turn(route);
            (native, None, cached.provider, cached.model)
        } else {
            if let Some(cached) = cached {
                cached.native.close().await;
            }
            let cfg = config::prepare(&request)?;
            #[cfg(windows)]
            let cfg = {
                let mut cfg = cfg;
                self.workspace_access.configure_temp(&mut cfg.env)?;
                cfg
            };
            let (native, readiness) = launch(&request, &cfg, route)?;
            *native.session.lock().unwrap() = session.clone();
            (native, Some(readiness), cfg.provider, cfg.model)
        };
        self.active
            .lock()
            .unwrap()
            .insert(run_id.into(), native.clone());
        let active = self.active.clone();
        let pool = self.pool.clone();
        #[cfg(windows)]
        let workspace_access = self.workspace_access.clone();
        let run_id = run_id.to_string();
        let prepared_ms = started_at.elapsed().as_millis() as u64;
        tokio::spawn(async move {
            let work = async {
                if let Some(readiness) = readiness {
                    ready(readiness).await?;
                }
                let process_ready_ms = started_at.elapsed().as_millis() as u64;
                let catalog = if provider.is_none() {
                    Some(native.call("/catalog", json!({})).await?)
                } else {
                    None
                };
                let default = catalog
                    .as_ref()
                    .map(|v| v["models"]["default"].clone())
                    .unwrap_or(Value::Null);
                let reasoning_effort = match (request["instance"]["providerOptions"]["apiType"].as_str(), request["reasoningEffort"].as_str()) {
                    (Some("openai-responses"), Some("none")) => Some("off"),
                    (_, effort) => effort,
                };
                let opened=native.call("/open",json!({"sessionId":session,"resume":resume.is_some(),"cwd":request["cwd"],
                    "agentMode":request["agentMode"],"provider":provider.clone().or_else(||default["provider"].as_str().map(str::to_string)),
                    "model":model.clone().or_else(||default["model"].as_str().map(str::to_string)),"reasoningEffort":reasoning_effort,
                    "permissionMode":request["permissionMode"]})).await?;
                drop(workspace_open);
                let attach_ms = started_at.elapsed().as_millis() as u64;
                native.emit(json!({"kind":"status","phase":"runtime_ready","raw":{
                    "providerId":"deepseek","transport":"native-web","reused":reusable,
                    "pid":native.process.pid,"attachMs":attach_ms,
                    "startupTimings":{"prepareMs":prepared_ms,"bootstrapMs":process_ready_ms.saturating_sub(prepared_ms),"sessionOpenMs":attach_ms.saturating_sub(process_ready_ms),"openDetails":opened["timings"]}
                }}));
                if std::env::var_os("NAUTILO_DSH_TIMING").is_some() {
                    eprintln!(
                        "{}",
                        json!({"deepseekRuntime":if reusable {"reused"} else {"started"},"setupMs":started_at.elapsed().as_millis(),"pid":native.process.pid})
                    );
                }
                let session_id = opened["sessionId"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("DeepSeek did not return a session identity"))?
                    .to_string();
                *native.session.lock().unwrap() = session_id.clone();
                let _ = sender.send(json!({"kind":"session","providerSessionId":session_id}));
                #[cfg(windows)]
                if opened["permissionMode"] == "workspace-write" && request["providerCommand"] != "compact" {
                    let cwd = request["cwd"].as_str().unwrap_or("");
                    workspace_access.prepare(std::path::Path::new(cwd), &run_id, daemon.as_ref(), &native.cancelled).await?;
                }
                let commands = if opened["supportsCompact"] == true {
                    json!([{"name":"compact","description":"压缩当前 DeepSeek 会话","providerCommand":"compact"}])
                } else {
                    json!([])
                };
                let _ = sender.send(json!({"kind":"commands","commands":commands}));
                if request["providerCommand"] == "compact" {
                    native
                        .call("/compact", json!({"sessionId":session_id}))
                        .await?;
                } else {
                    let mut content = agenthub_plugin_sdk::images::acp_prompt(&request)?;
                    for block in &mut content {
                        if block["type"] == "image" {
                            block["mediaType"] = block["mimeType"].take();
                        }
                    }
                    native
                        .call("/prompt", json!({"sessionId":session_id,"content":content}))
                        .await?;
                    native.opened.send_replace(true);
                    loop {
                        let generation = native.guidance.load(Ordering::Acquire);
                        native
                            .call("/wait", json!({"sessionId":session_id}))
                            .await?;
                        let _admission = native.admission.lock().await;
                        if generation == native.guidance.load(Ordering::Acquire) {
                            native.ending.store(true, Ordering::Release);
                            break;
                        }
                    }
                }
                native.drain().await?;
                if let Some(error) = native.turn_error(&request, started_at) {
                    return Err(error);
                }
                Ok::<(), anyhow::Error>(())
            };
            let result = tokio::select! {
                result = work => result,
                error = native.watch_turn(&request, started_at) => Err(error),
            };
            active.lock().unwrap().remove(&run_id);
            if let Err(error) = &result {
                let _ = sender
                    .send(json!({"kind":"error","message":error.to_string(),"retryable":true}));
            }
            native.ending.store(true, Ordering::Release);
            native.opened.send_replace(true);
            native.routes.lock().unwrap().park();
            if result.is_ok()
                && !native.cancelled.load(Ordering::Acquire)
                && native.alive.load(Ordering::Acquire)
            {
                runtime::retain(
                    &pool,
                    cache_key,
                    IdleRuntime {
                        native,
                        identity,
                        provider,
                        model,
                    },
                );
            } else {
                native.close().await;
            }
            let _ = sender.send(json!({"kind":"exit","exitCode":if result.is_ok(){0}else{1}}));
        });
        Ok(receiver)
    }
    async fn steer(&self, run_id: &str, input: &str) -> anyhow::Result<()> {
        let native = self
            .active
            .lock()
            .unwrap()
            .get(run_id)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("DeepSeek run is no longer active"))?;
        let mut opened = native.opened.subscribe();
        tokio::time::timeout(Duration::from_secs(55), opened.wait_for(|ready| *ready)).await??;
        let _admission = native.admission.lock().await;
        anyhow::ensure!(
            !native.ending.load(Ordering::Acquire),
            "DeepSeek turn has ended; send this as the next message"
        );
        let session = native.session.lock().unwrap().clone();
        native.call("/prompt",json!({"sessionId":session,"mode":"steer","content":[{"type":"text","text":input}]})).await?;
        native.guidance.fetch_add(1, Ordering::Release);
        Ok(())
    }
    async fn cancel(&self, run_id: &str) {
        let native = self.active.lock().unwrap().get(run_id).cloned();
        if let Some(native) = native {
            {
                let _admission = native.admission.lock().await;
                if native.ending.swap(true, Ordering::AcqRel) {
                    return;
                }
                native.cancelled.store(true, Ordering::Release);
                native.opened.send_replace(true);
            }
            let session = native.session.lock().unwrap().clone();
            let _ = tokio::time::timeout(
                Duration::from_secs(3),
                native.call("/cancel", json!({"sessionId":session})),
            )
            .await;
            let _ = tokio::time::timeout(
                Duration::from_secs(3),
                native.call("/wait", json!({"sessionId":session})),
            )
            .await;
            native.close().await;
        }
    }
    async fn dispose(&self) {
        let active: Vec<_> = self
            .active
            .lock()
            .unwrap()
            .drain()
            .map(|(_, v)| v)
            .collect();
        let idle = self.pool.lock().unwrap().drain();
        for native in active.into_iter().chain(idle) {
            native.close().await;
        }
    }

    async fn release_session(&self, request: &Value) -> anyhow::Result<()> {
        let Some(session) = request["localSessionId"].as_str() else { return Ok(()) };
        let native = self.pool.lock().unwrap().release(session);
        if let Some(native) = native { native.close().await; }
        Ok(())
    }
}

#[tokio::main]
async fn main() {
    agenthub_plugin_sdk::serve(DeepSeek::default()).await;
}

#[cfg(test)]
mod tests;
