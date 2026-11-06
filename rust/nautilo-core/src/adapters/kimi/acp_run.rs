//! Kimi ACP run loop — port of adapters/kimi/acp-run.ts.
//! Speaks ACP (JSON-RPC over stdio) to `kimi acp`.

use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use tokio::sync::mpsc;
use agenthub_plugin_sdk::session_pool::SessionPool;
use std::sync::{OnceLock, atomic::{AtomicBool, Ordering}};

use crate::adapters::json_rpc_process::{JsonRpcProcessClient, JsonRpcProcessEvent};
use crate::adapters::kimi::session_usage::read_kimi_session_usage;
use crate::adapters::kimi::subagent_wire::KimiSubagentWireWatcher;
use crate::adapters::runtime_mcp_bridge::start_runtime_mcp_bridge;
use crate::adapters::{AdapterEvent, AdapterRun, AdapterStartRequest, TimeoutKind};
use crate::errors::{CoreError, CoreResult, ErrorCode};
use crate::process_runtime::{ProcessEvent, ProcessRequest, ProcessRuntime, TimeoutReason};

const KIMI_SUBAGENT_POLL_MS: u64 = 300;
#[path = "acp_pipeline.rs"] mod pipeline;
#[path = "acp_background.rs"] mod background;
use pipeline::Pipeline;

fn is_kimi_agent_tool(event: &AdapterEvent) -> bool {
    match event {
        AdapterEvent::Tool { name, .. } => {
            let normalized: String = name.trim().to_lowercase().chars().filter(|c| c.is_ascii_alphanumeric()).collect();
            normalized == "agent"
        }
        _ => false,
    }
}

fn tool_call_id(event: &AdapterEvent) -> Option<String> {
    match event {
        AdapterEvent::Tool { call_id, .. } => call_id.clone(),
        _ => None,
    }
}

fn tool_phase(event: &AdapterEvent) -> Option<String> {
    match event {
        AdapterEvent::Tool { phase, .. } => phase.clone(),
        _ => None,
    }
}

fn resolve_permission_mode(instance: &Value, request: &AdapterStartRequest) -> Option<String> {
    let normalize = |value: Option<&str>| value.map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);
    normalize(request.permission_mode.as_deref()).or_else(|| {
        normalize(
            instance
                .get("providerOptions")
                .and_then(|o| o.get("permissionMode"))
                .and_then(Value::as_str),
        )
    })
}

/// Re-applies model/effort/mode on every (re)connect; resume spawns a fresh
/// CLI process whose settings reset to defaults.
async fn apply_config(
    rpc: &JsonRpcProcessClient,
    session_id: &str,
    session_response: &Value,
    request: &AdapterStartRequest,
) -> anyhow::Result<()> {
    let mut options = session_response.get("configOptions").and_then(Value::as_array).cloned().unwrap_or_default();
    let selections: [(Option<String>, [&str; 3]); 2] = [
        (request.model.clone(), ["model", "", ""]),
        (request.reasoning_effort.clone(), ["thinking", "reasoning", "effort"]),
    ];
    for (value, hints) in selections {
        let Some(value) = value.filter(|v| !v.is_empty()) else { continue };
        let option = options.iter().find(|item| {
            let haystack = format!(
                "{} {} {}",
                item.get("id").and_then(Value::as_str).unwrap_or(""),
                item.get("name").and_then(Value::as_str).unwrap_or(""),
                item.get("label").and_then(Value::as_str).unwrap_or("")
            )
            .to_lowercase();
            hints.iter().any(|hint| !hint.is_empty() && haystack.contains(hint))
        });
        if let Some(id) = option.and_then(|o| o.get("id")).and_then(Value::as_str) {
            let result = rpc
                .request("session/set_config_option", json!({ "sessionId": session_id, "configId": id, "value": value }))
                .await.map_err(|error| anyhow::anyhow!("Kimi rejected {id}={value}: {error}"))?;
            if let Some(updated) = result["configOptions"].as_array() { options = updated.clone(); }
        } else {
            let is_model = hints[0] == "model";
            let marker = if is_model {"NAUTILO_BRIDGE_MODEL"} else {"NAUTILO_BRIDGE_EFFORT"};
            if request.env.as_ref().and_then(|env|env.get(marker)).is_some_and(|bound|bound == &value) { continue; }
            if is_model && session_response.pointer("/models/currentModelId").and_then(Value::as_str) == Some(value.as_str()) { continue; }
            if is_model && session_response.pointer("/models/availableModels").and_then(Value::as_array)
                .is_some_and(|models|models.iter().any(|model|model["modelId"] == value)) {
                rpc.request("session/set_model",json!({"sessionId":session_id,"modelId":value})).await?;
            } else {
                anyhow::bail!("Kimi did not advertise a way to apply {}={value}", if is_model {"model"} else {"reasoning effort"});
            }
        }
    }
    // Permission mode must match exactly — a fuzzy "mode" hint would also hit
    // the model option. Session-level override wins over the instance setting.
    if let Some(mode) = resolve_permission_mode(&request.instance, request) {
        let option = options.iter().find(|item| {
            let id = item.get("id").and_then(Value::as_str).unwrap_or("").to_lowercase();
            let name = item.get("name").and_then(Value::as_str).unwrap_or("").to_lowercase();
            id == "mode" || name == "mode" || id == "permission" || name == "permission"
        });
        // Older Nautilo builds saved "manual"; the CLI calls that "default".
        let value = if mode == "manual" { "default" } else { mode.as_str() };
        if let Some(id) = option.and_then(|o| o.get("id")).and_then(Value::as_str) {
            rpc
                .request("session/set_config_option", json!({ "sessionId": session_id, "configId": id, "value": value }))
                .await?;
        } else if session_response.pointer("/modes/availableModes").and_then(Value::as_array)
            .is_some_and(|modes| modes.iter().any(|mode| mode["id"] == value)) {
            rpc.request("session/set_mode", json!({"sessionId":session_id,"modeId":value})).await?;
        } else if value != "default" {
            anyhow::bail!("Kimi CLI does not advertise the selected permission mode: {value}");
        }
    }
    Ok(())
}

struct Resident {
    rpc: Arc<JsonRpcProcessClient>,
    callbacks: Arc<Mutex<AdapterStartRequest>>,
    bridge: Option<crate::adapters::runtime_mcp_bridge::RuntimeMcpBridge>,
    session: Option<Value>,
    pipeline: Arc<tokio::sync::Mutex<Pipeline>>,
    background: Option<tokio::task::JoinHandle<()>>,
}
impl Drop for Resident {
    fn drop(&mut self) {
        let rpc = self.rpc.clone(); let bridge = self.bridge.take();
        tokio::spawn(async move {rpc.process_handle().cancel().await; drop(bridge);});
    }
}
impl Resident { async fn close(self) { self.rpc.process_handle().cancel().await; } }
fn pool() -> &'static SessionPool<Resident> {static POOL:OnceLock<SessionPool<Resident>>=OnceLock::new(); POOL.get_or_init(Default::default)}
pub async fn dispose() {for native in pool().drain(){native.close().await;}}
pub async fn release_session(local_id:&str) {if let Some(native)=pool().retire(local_id){native.close().await;}}

fn open(request:&AdapterStartRequest) -> anyhow::Result<Resident> {
    let started = ProcessRuntime::start(&ProcessRequest {
        command: request.instance.get("executable").and_then(Value::as_str).unwrap_or("kimi").to_string(),
        args: {let mut args=super::base_args(&request.instance);args.push("acp".to_string());args},
        cwd: Some(request.cwd.clone()),
        env: request.env.clone(),
        timeout_ms: None,
        idle_timeout_ms: None,
        // ACP can stream cumulative tool inputs (not user-visible output), so
        // transport bytes grow quadratically for file writes. Honor an
        // explicit caller limit; no plain-text 20 MB default here.
        max_output_bytes: None,
    })
    .map_err(|e| CoreError::reason(ErrorCode::RunStartFailed, e.to_string()))?;
    let rpc = Arc::new(JsonRpcProcessClient::new(started.handle, started.events));
    Ok(Resident {rpc,callbacks:Arc::new(Mutex::new(request.clone())),bridge:None,session:None,
        pipeline:Arc::new(tokio::sync::Mutex::new(Pipeline::default())),background:None})
}

pub fn start_kimi_acp(request: AdapterStartRequest, resume_session: Option<String>) -> CoreResult<AdapterRun> {
    let (sender, receiver) = mpsc::unbounded_channel::<AdapterEvent>();
    let session_slot = Arc::new(Mutex::new(None::<String>));
    let rpc_slot = Arc::new(Mutex::new(None::<Arc<JsonRpcProcessClient>>));
    let cancelled = Arc::new(AtomicBool::new(false));
    let pump = {
        let rpc_slot = rpc_slot.clone(); let cancelled = cancelled.clone();
        let sender = sender.clone();
        let session_slot = session_slot.clone();
        async move {
            let attached=std::time::Instant::now();
            let wire = crate::adapters::start_request_to_json(&request);
            let identity = agenthub_plugin_sdk::session_pool::identity(&wire);
            let key = request.local_session_id.clone().or(resume_session.clone()).unwrap_or_else(||uuid::Uuid::new_v4().to_string());
            let result: anyhow::Result<()> = async {
                let mut native = if let Some((old,native))=pool().take(&key) {
                    if resume_session.is_some() && native.session.as_ref().and_then(|session|session["sessionId"].as_str())==resume_session.as_deref() && old==identity && native.rpc.process_handle().is_alive() {native}
                    else {native.close().await; open(&request)?}
                } else {open(&request)?};
                background::resume(&mut native).await?;
                *rpc_slot.lock().unwrap()=Some(native.rpc.clone());
                let _=sender.send(AdapterEvent::Status{phase:"runtime_ready".into(),raw:Some(json!({"providerId":"kimi-code","transport":"acp","reused":native.session.is_some(),"pid":native.rpc.process_handle().pid,"attachMs":attached.elapsed().as_millis()}))});
                *native.callbacks.lock().unwrap()=request.clone();
                if cancelled.load(Ordering::Acquire){native.close().await; anyhow::bail!("Kimi startup was cancelled");}
                let turn=run_acp(&mut native,request.clone(),resume_session,session_slot,sender.clone());
                let result=if let Some(ms)=request.timeout_ms {
                    match tokio::time::timeout(std::time::Duration::from_millis(ms),turn).await {
                        Ok(result)=>result,Err(_)=>{let _=sender.send(AdapterEvent::Timeout{reason:TimeoutKind::Timeout});Err(anyhow::anyhow!("Kimi turn timed out"))}
                    }
                } else {turn.await};
                if result.is_ok() && !cancelled.load(Ordering::Acquire) && !sender.is_closed() && native.rpc.process_handle().is_alive() {
                    background::park(&mut native,&request).await?;
                    pool().put(key,identity,native);
                }
                else {native.close().await;}
                result
            }.await;
            if let Err(error) = &result {
                let _ = sender.send(AdapterEvent::Error { message: error.to_string() });
            }
            let _=sender.send(AdapterEvent::Exit{exit_code:Some(if result.is_ok(){0}else{1}),signal:None});
        }
    };
    tokio::spawn(pump);

    let cancel_rpc = rpc_slot.clone();
    let cancel_slot = session_slot.clone();
    let run = AdapterRun::new(
        receiver,
        move || {
            Box::pin(async move {
                cancelled.store(true,Ordering::Release);
                let session_id = cancel_slot.lock().unwrap().clone();
                let rpc=cancel_rpc.lock().unwrap().clone();
                if let Some(rpc)=rpc {
                    if let Some(session_id) = session_id { rpc.notify("session/cancel", json!({ "sessionId": session_id })); }
                    rpc.process_handle().cancel().await;
                }
            }) as crate::adapters::BoxFuture<()>
        },
        move |input| {
            if let Some(rpc)=rpc_slot.lock().unwrap().as_ref(){rpc.process_write(&input);}
        },
    );
    Ok(run)
}

async fn run_acp(
    native: &mut Resident,
    request: AdapterStartRequest,
    resume_session: Option<String>,
    session_slot: Arc<Mutex<Option<String>>>,
    sender: mpsc::UnboundedSender<AdapterEvent>,
) -> anyhow::Result<()> {

    // MCP servers: the run-scoped tool bridge plus user-managed servers.
    let mut mcp_servers: Vec<Value> = vec![];
    let runtime_tools = request.runtime_tools.as_ref().and_then(Value::as_array).cloned().unwrap_or_default();
    if native.bridge.is_none() && !runtime_tools.is_empty() && request.execute_runtime_tool.is_some() {
        let callbacks=native.callbacks.clone();
        let execute:crate::adapters::runtime_mcp_bridge::ToolExecutor=Arc::new(move |input| {
            let callbacks = callbacks.lock().unwrap();
            let execute=callbacks.session_tool.clone().or_else(||callbacks.execute_runtime_tool.clone());
            Box::pin(async move {match execute {Some(execute)=>execute(input).await,None=>anyhow::bail!("No active Kimi tool callback")}})
        });
        native.bridge=Some(start_runtime_mcp_bridge("kimi-code",runtime_tools,Some(execute),None)?);
    }
    if let Some(bridge)=&native.bridge {mcp_servers.push(json!({"type":"http","name":"agenthub","url":bridge.url,"headers":[]}));}
    for server in request.mcp_servers.as_deref().unwrap_or(&[]) {
        let transport = server.get("transport").and_then(Value::as_str).unwrap_or("");
        let name = server.get("name").and_then(Value::as_str).unwrap_or("mcp");
        if transport == "http" {
            if let Some(url) = server.get("url").and_then(Value::as_str) {
                let headers: Vec<Value> = server
                    .get("headers")
                    .and_then(Value::as_object)
                    .map(|h| h.iter().map(|(name, value)| json!({ "name": name, "value": value })).collect())
                    .unwrap_or_default();
                mcp_servers.push(json!({ "type": "http", "name": name, "url": url, "headers": headers }));
            }
        } else if transport == "stdio" {
            if let Some(command) = server.get("command").and_then(Value::as_str) {
                let env: Vec<Value> = server
                    .get("env")
                    .and_then(Value::as_object)
                    .map(|e| e.iter().map(|(name, value)| json!({ "name": name, "value": value })).collect())
                    .unwrap_or_default();
                mcp_servers.push(json!({
                    "name": name,
                    "command": command,
                    "args": server.get("args").cloned().unwrap_or_else(|| json!([])),
                    "env": env
                }));
            }
        }
    }

    let pipeline = native.pipeline.clone();
    let mut pipeline = pipeline.lock().await;
    pipeline.usage_received = false;
    let result = run_acp_inner(
        native.rpc.clone(),
        &request,
        resume_session,
        session_slot,
        sender,
        &mut pipeline,
        mcp_servers,
        &mut native.session,
    )
    .await;
    result
}

#[allow(clippy::too_many_arguments)]
async fn run_acp_inner(
    rpc: Arc<JsonRpcProcessClient>,
    request: &AdapterStartRequest,
    resume_session: Option<String>,
    session_slot: Arc<Mutex<Option<String>>>,
    sender: mpsc::UnboundedSender<AdapterEvent>,
    pipeline: &mut Pipeline,
    mcp_servers: Vec<Value>,
    cached_session: &mut Option<Value>,
) -> anyhow::Result<()> {
    let kimi_home = request.env.as_ref().and_then(|env| env.get("KIMI_CODE_HOME")).cloned();
    let session_response = if let Some(session)=cached_session.clone() {session} else {
    let negotiated=rpc.request("initialize", json!({
        "protocolVersion": 1,
        "clientCapabilities": { "fs": { "readTextFile": false, "writeTextFile": false } },
        "clientInfo": { "name": "Nautilo", "version": "0.1.0" }
    }))
    .await?;
    let _=sender.send(AdapterEvent::Status{phase:"runtime_capabilities".into(),raw:Some(json!({"providerId":"kimi-code","source":"native-handshake","transport":"acp","protocolVersion":negotiated["protocolVersion"],"cliVersion":negotiated["agentInfo"]["version"],"reported":negotiated["agentCapabilities"]}))});
    let session_params = match &resume_session {
        Some(session) => json!({ "sessionId": session, "cwd": request.cwd, "mcpServers": mcp_servers }),
        None => json!({ "cwd": request.cwd, "mcpServers": mcp_servers }),
    };
    let session_response = rpc
        .request(if resume_session.is_some() { "session/resume" } else { "session/new" }, session_params)
        .await?;
    *cached_session=Some(session_response.clone());
    session_response
    };
    let session_id = session_response
        .get("sessionId")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| resume_session.clone())
        .filter(|id| !id.is_empty());
    let Some(session_id) = session_id else {
        anyhow::bail!("Kimi ACP did not return a session id");
    };
    *session_slot.lock().unwrap() = Some(session_id.clone());
    let _ = sender.send(AdapterEvent::Session { provider_session_id: session_id.clone(), raw: None });

    if pipeline.wires.is_none() {
        let mut wires = KimiSubagentWireWatcher::new(&session_id, kimi_home.as_deref());
        wires.initialize().await; pipeline.wires = Some(wires);
    }
    apply_config(&rpc, &session_id, &session_response, request).await?;
    let _ = sender.send(AdapterEvent::Status { phase: "turn_started".to_string(), raw: None });
    let (prompt_id_num, prompt_result) = rpc.request_with_id(
        "session/prompt",
        json!({ "sessionId": session_id, "prompt": crate::adapters::images::prompt_blocks(request, false)? }),
    );
    let prompt_id = json!(prompt_id_num);
    tokio::spawn(async move {
        let _ = prompt_result.await;
    });

    let mut received=std::time::Instant::now();
    let mut output_bytes=0usize;
    loop {
        if request.idle_timeout_ms.is_some_and(|ms|received.elapsed().as_millis()>=ms as u128) {
            let _=sender.send(AdapterEvent::Timeout{reason:TimeoutKind::Idle}); anyhow::bail!("Kimi turn exceeded idle limit");
        }
        // Poll the sub-agent wires while an Agent dispatch is active.
        let next = if pipeline.has_active() || request.idle_timeout_ms.is_some() {
            let wait=request.idle_timeout_ms.map(|ms|std::time::Duration::from_millis(ms).saturating_sub(received.elapsed()).min(std::time::Duration::from_millis(KIMI_SUBAGENT_POLL_MS)))
                .unwrap_or(std::time::Duration::from_millis(KIMI_SUBAGENT_POLL_MS));
            match tokio::time::timeout(wait, rpc.next_event()).await {
                Ok(event) => Some(event),
                Err(_) => {
                    for item in pipeline.poll().await {
                        if sender.send(item).is_err() {
                            return Ok(());
                        }
                    }
                    continue;
                }
            }
        } else {
            Some(rpc.next_event().await)
        };
        let Some(event) = next.flatten() else {
            anyhow::bail!("Kimi event stream ended before the prompt response");
        };
        received=std::time::Instant::now();
        output_bytes=output_bytes.saturating_add(format!("{event:?}").len());
        if request.max_output_bytes.is_some_and(|max|output_bytes>max){let _=sender.send(AdapterEvent::Timeout{reason:TimeoutKind::MaxOutput});anyhow::bail!("Kimi turn exceeded output limit");}
        match event {
            JsonRpcProcessEvent::Notification { method, params } if method == "session/update" && background::owns(&params,&session_id) => {
                let update = params.get("update").cloned().unwrap_or(Value::Null);
                for item in pipeline.update(&update).await {
                    if sender.send(item).is_err() {
                        return Ok(());
                    }
                }
            }
            JsonRpcProcessEvent::Request { id, method, params } => {
                background::respond(rpc.clone(),id,method,params,request,&session_id);
            }
            JsonRpcProcessEvent::Response { id, error, .. } if same_id(&id, &prompt_id) => {
                for child_item in pipeline.poll().await {
                    if sender.send(child_item).is_err() {
                        return Ok(());
                    }
                }
                for completed in pipeline.flush() {
                    if sender.send(completed).is_err() {
                        return Ok(());
                    }
                }
                if !pipeline.usage_received {
                    let config_options = session_response.get("configOptions").and_then(Value::as_array).cloned().unwrap_or_default();
                    let model_option = config_options.iter().find(|option| {
                        format!(
                            "{} {}",
                            option.get("id").and_then(Value::as_str).unwrap_or(""),
                            option.get("name").and_then(Value::as_str).unwrap_or("")
                        )
                        .to_lowercase()
                        .contains("model")
                    });
                    let model_values = model_option
                        .and_then(|o| o.get("options"))
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_default();
                    let selected_model = request.model.clone().or_else(|| {
                        model_option
                            .and_then(|o| o.get("currentValue").or_else(|| o.get("value")))
                            .and_then(Value::as_str)
                            .map(str::to_string)
                    });
                    let context_window = model_values
                        .iter()
                        .find(|option| {
                            option.get("value").or_else(|| option.get("id")).and_then(Value::as_str) == selected_model.as_deref()
                        })
                        .and_then(|option| option.get("contextWindow").or_else(|| option.get("context_window")))
                        .and_then(Value::as_i64)
                        .or(request.context_window)
                        .filter(|window| *window > 0);
                    if let Some(fallback) = read_kimi_session_usage(&session_id, context_window, kimi_home.as_deref()).await {
                        let _ = sender.send(fallback);
                    }
                }
                let failed = error.is_some();
                let _ = sender.send(AdapterEvent::Status {
                    phase: if failed { "turn_failed".to_string() } else { "turn_completed".to_string() },
                    raw: None,
                });
                if let Some(error) = error {
                    anyhow::bail!(error.to_string());
                }
                return Ok(());
            }
            JsonRpcProcessEvent::Response { .. } => {}
            JsonRpcProcessEvent::Transport(process_event) => match process_event {
                ProcessEvent::Stdout(text) => {
                    let _ = sender.send(AdapterEvent::Raw { stream: "stdout".to_string(), text });
                }
                ProcessEvent::Stderr(text) => {
                    let _ = sender.send(AdapterEvent::Raw { stream: "stderr".to_string(), text });
                }
                ProcessEvent::Exit { exit_code, signal } => {
                    anyhow::bail!("Kimi exited before the native prompt response ({exit_code:?}, {signal:?})");
                }
                ProcessEvent::Error(message) => {
                    let _ = sender.send(AdapterEvent::Error { message });
                }
                ProcessEvent::Timeout { reason } => {
                    let kind = match reason {
                        TimeoutReason::Timeout => TimeoutKind::Timeout,
                        TimeoutReason::Idle => TimeoutKind::Idle,
                        TimeoutReason::MaxOutput => TimeoutKind::MaxOutput,
                    };
                    let _ = sender.send(AdapterEvent::Timeout { reason: kind });
                }
            },
            _ => {}
        }
    }
}

fn same_id(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Number(a), Value::Number(b)) => a == b,
        (Value::String(a), Value::String(b)) => a == b,
        (a, b) => a == b,
    }
}
