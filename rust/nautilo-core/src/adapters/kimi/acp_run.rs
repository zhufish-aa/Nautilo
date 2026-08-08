//! Kimi ACP run loop — port of adapters/kimi/acp-run.ts.
//! Speaks ACP (JSON-RPC over stdio) to `kimi acp`.

use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use tokio::sync::mpsc;

use crate::adapters::json_rpc_process::{JsonRpcProcessClient, JsonRpcProcessEvent};
use crate::adapters::kimi::acp_events::{parse_kimi_acp_update, KimiAcpParseState};
use crate::adapters::kimi::acp_segments::KimiAcpTurnSegments;
use crate::adapters::kimi::session_usage::read_kimi_session_usage;
use crate::adapters::kimi::subagent_wire::KimiSubagentWireWatcher;
use crate::adapters::runtime_mcp_bridge::start_runtime_mcp_bridge;
use crate::adapters::{AdapterEvent, AdapterRun, AdapterStartRequest, TimeoutKind};
use crate::errors::{CoreError, CoreResult, ErrorCode};
use crate::process_runtime::{ProcessEvent, ProcessRequest, ProcessRuntime, TimeoutReason};

const KIMI_SUBAGENT_POLL_MS: u64 = 300;

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
) {
    let options = session_response.get("configOptions").and_then(Value::as_array).cloned().unwrap_or_default();
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
            let _ = rpc
                .request("session/set_config_option", json!({ "sessionId": session_id, "configId": id, "value": value }))
                .await;
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
            let _ = rpc
                .request("session/set_config_option", json!({ "sessionId": session_id, "configId": id, "value": value }))
                .await;
        }
    }
}

pub fn start_kimi_acp(request: AdapterStartRequest, resume_session: Option<String>) -> CoreResult<AdapterRun> {
    let started = ProcessRuntime::start(&ProcessRequest {
        command: request.instance.get("executable").and_then(Value::as_str).unwrap_or("kimi").to_string(),
        args: vec!["acp".to_string()],
        cwd: Some(request.cwd.clone()),
        env: request.env.clone(),
        timeout_ms: request.timeout_ms,
        idle_timeout_ms: request.idle_timeout_ms,
        // ACP can stream cumulative tool inputs (not user-visible output), so
        // transport bytes grow quadratically for file writes. Honor an
        // explicit caller limit; no plain-text 20 MB default here.
        max_output_bytes: request.max_output_bytes,
    })
    .map_err(|e| CoreError::reason(ErrorCode::RunStartFailed, e.to_string()))?;
    let process = started.handle.clone();
    let rpc = Arc::new(JsonRpcProcessClient::new(started.handle, started.events));
    let (sender, receiver) = mpsc::unbounded_channel::<AdapterEvent>();
    let session_slot = Arc::new(Mutex::new(None::<String>));

    let pump = {
        let rpc = rpc.clone();
        let sender = sender.clone();
        let session_slot = session_slot.clone();
        let process = process.clone();
        async move {
            let result = run_acp(rpc.clone(), request, resume_session, session_slot, sender.clone()).await;
            if let Err(error) = result {
                let _ = sender.send(AdapterEvent::Error { message: error.to_string() });
                process.cancel().await;
            }
        }
    };
    tokio::spawn(pump);

    let cancel_rpc = rpc.clone();
    let cancel_slot = session_slot.clone();
    let cancel_process = process.clone();
    let run = AdapterRun::new(
        receiver,
        move || {
            Box::pin(async move {
                let session_id = cancel_slot.lock().unwrap().clone();
                if let Some(session_id) = session_id {
                    cancel_rpc.notify("session/cancel", json!({ "sessionId": session_id }));
                }
                cancel_process.cancel().await;
            }) as crate::adapters::BoxFuture<()>
        },
        move |input| {
            rpc.process_write(&input);
        },
    );
    Ok(run)
}

async fn run_acp(
    rpc: Arc<JsonRpcProcessClient>,
    request: AdapterStartRequest,
    resume_session: Option<String>,
    session_slot: Arc<Mutex<Option<String>>>,
    sender: mpsc::UnboundedSender<AdapterEvent>,
) -> anyhow::Result<()> {
    let mut state = KimiAcpParseState::default();
    let mut segments = KimiAcpTurnSegments::new();
    let mut usage_received = false;

    // MCP servers: the run-scoped tool bridge plus user-managed servers.
    let mut mcp_servers: Vec<Value> = vec![];
    let runtime_tools = request.runtime_tools.as_ref().and_then(Value::as_array).cloned().unwrap_or_default();
    let runtime_mcp = if !runtime_tools.is_empty() && request.execute_runtime_tool.is_some() {
        let bridge = start_runtime_mcp_bridge("kimi-code", runtime_tools, request.execute_runtime_tool.clone(), None)?;
        mcp_servers.push(json!({ "type": "http", "name": "agenthub", "url": bridge.url, "headers": [] }));
        Some(bridge)
    } else {
        None
    };
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

    let result = run_acp_inner(
        rpc,
        &request,
        resume_session,
        session_slot,
        sender,
        &mut state,
        &mut segments,
        &mut usage_received,
        mcp_servers,
    )
    .await;
    if let Some(bridge) = runtime_mcp {
        bridge.close();
    }
    result
}

#[allow(clippy::too_many_arguments)]
async fn run_acp_inner(
    rpc: Arc<JsonRpcProcessClient>,
    request: &AdapterStartRequest,
    resume_session: Option<String>,
    session_slot: Arc<Mutex<Option<String>>>,
    sender: mpsc::UnboundedSender<AdapterEvent>,
    state: &mut KimiAcpParseState,
    segments: &mut KimiAcpTurnSegments,
    usage_received: &mut bool,
    mcp_servers: Vec<Value>,
) -> anyhow::Result<()> {
    let kimi_home = request.env.as_ref().and_then(|env| env.get("KIMI_CODE_HOME")).cloned();
    rpc.request("initialize", json!({
        "protocolVersion": 1,
        "clientCapabilities": { "fs": { "readTextFile": false, "writeTextFile": false } },
        "clientInfo": { "name": "Nautilo", "version": "0.1.0" }
    }))
    .await?;
    let session_params = match &resume_session {
        Some(session) => json!({ "sessionId": session, "cwd": request.cwd, "mcpServers": mcp_servers }),
        None => json!({ "cwd": request.cwd, "mcpServers": mcp_servers }),
    };
    let session_response = rpc
        .request(if resume_session.is_some() { "session/resume" } else { "session/new" }, session_params)
        .await?;
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

    let mut subagent_wires = KimiSubagentWireWatcher::new(&session_id, kimi_home.as_deref());
    subagent_wires.initialize().await;
    apply_config(&rpc, &session_id, &session_response, request).await;
    let _ = sender.send(AdapterEvent::Status { phase: "turn_started".to_string(), raw: None });
    let (prompt_id_num, prompt_result) = rpc.request_with_id(
        "session/prompt",
        json!({ "sessionId": session_id, "prompt": [{ "type": "text", "text": request.prompt }] }),
    );
    let prompt_id = json!(prompt_id_num);
    tokio::spawn(async move {
        let _ = prompt_result.await;
    });

    let mut finished = false;
    loop {
        // Poll the sub-agent wires while an Agent dispatch is active.
        let next = if subagent_wires.has_active() {
            match tokio::time::timeout(std::time::Duration::from_millis(KIMI_SUBAGENT_POLL_MS), rpc.next_event()).await {
                Ok(event) => Some(event),
                Err(_) => {
                    for item in subagent_wires.poll().await {
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
            break;
        };
        match event {
            JsonRpcProcessEvent::Notification { method, params } if method == "session/update" => {
                let update = params.get("update").cloned().unwrap_or(Value::Null);
                let parsed = parse_kimi_acp_update(&update, state);
                for boundary in segments.flush_before(&parsed, state) {
                    if sender.send(boundary).is_err() {
                        return Ok(());
                    }
                }
                for item in parsed {
                    if is_kimi_agent_tool(&item) && tool_phase(&item).as_deref() == Some("started") {
                        if let Some(call_id) = tool_call_id(&item) {
                            let input = match &item {
                                AdapterEvent::Tool { input, .. } => input.clone(),
                                _ => None,
                            };
                            subagent_wires.track(&call_id, input.as_ref());
                        }
                    }
                    if is_kimi_agent_tool(&item) && tool_phase(&item).as_deref() == Some("completed") {
                        for child_item in subagent_wires.poll().await {
                            if sender.send(child_item).is_err() {
                                return Ok(());
                            }
                        }
                    }
                    segments.append(&item);
                    if matches!(item, AdapterEvent::Usage { .. }) {
                        *usage_received = true;
                    }
                    let completed_agent = is_kimi_agent_tool(&item) && tool_phase(&item).as_deref() == Some("completed");
                    let call_id = tool_call_id(&item);
                    if sender.send(item).is_err() {
                        return Ok(());
                    }
                    if completed_agent {
                        if let Some(call_id) = call_id {
                            subagent_wires.release(&call_id);
                        }
                    }
                }
            }
            JsonRpcProcessEvent::Request { id, method, params } if method == "session/request_permission" => {
                let options = params.get("options").and_then(Value::as_array).cloned().unwrap_or_default();
                if let Some(handler) = request.request_interaction.clone() {
                    let tool_call = params.get("toolCall").cloned().unwrap_or(Value::Null);
                    let interaction = super::normalize_kimi_permission_interaction(&tool_call, &options);
                    match handler(interaction).await {
                        Ok(response) => {
                            let outcome = if response.get("outcome").and_then(Value::as_str) == Some("selected") {
                                match response.get("optionId").and_then(Value::as_str) {
                                    Some(option_id) => json!({ "outcome": { "outcome": "selected", "optionId": option_id } }),
                                    None => json!({ "outcome": { "outcome": "cancelled" } }),
                                }
                            } else {
                                json!({ "outcome": { "outcome": "cancelled" } })
                            };
                            rpc.respond(&id, outcome);
                        }
                        Err(_) => rpc.respond(&id, json!({ "outcome": { "outcome": "cancelled" } })),
                    }
                } else {
                    let allowed = options.iter().find(|option| {
                        !option.get("kind").and_then(Value::as_str).unwrap_or("").contains("reject")
                    });
                    match allowed.and_then(|o| o.get("optionId")).and_then(Value::as_str) {
                        Some(option_id) => rpc.respond(&id, json!({ "outcome": { "outcome": "selected", "optionId": option_id } })),
                        None => rpc.respond(&id, json!({ "outcome": { "outcome": "cancelled" } })),
                    }
                }
            }
            JsonRpcProcessEvent::Request { id, method, .. } => {
                rpc.respond_error(&id, -32601, &format!("Nautilo does not support ACP request {method}"));
            }
            JsonRpcProcessEvent::Response { id, error, .. } if same_id(&id, &prompt_id) => {
                for child_item in subagent_wires.poll().await {
                    if sender.send(child_item).is_err() {
                        return Ok(());
                    }
                }
                for completed in segments.flush_message(state).into_iter().chain(segments.flush_thinking(state)) {
                    if sender.send(completed).is_err() {
                        return Ok(());
                    }
                }
                if !*usage_received {
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
                finished = true;
                rpc.process_handle().cancel().await;
                if let Some(error) = error {
                    let _ = sender.send(AdapterEvent::Error { message: error.to_string() });
                } else {
                    let _ = sender.send(AdapterEvent::Exit { exit_code: Some(0), signal: None });
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
                    if !finished {
                        let _ = sender.send(AdapterEvent::Exit { exit_code, signal });
                    }
                    return Ok(());
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
    Ok(())
}

fn same_id(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Number(a), Value::Number(b)) => a == b,
        (Value::String(a), Value::String(b)) => a == b,
        (a, b) => a == b,
    }
}
