//! Nautilo native provider plugin for Trae — port of provider-plugin-trae.
//!
//! Drives both Trae CLIs: the official ACP-native `traecli` (ndjson JSON-RPC
//! via `traecli acp serve`) and the open-source `trae-cli` (plain stdout).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::{json, Map, Value};
use tokio::sync::mpsc;

use agenthub_plugin_sdk::jsonrpc::{JsonRpcClient, JsonRpcEvent};
use agenthub_plugin_sdk::process::{self, ProcessEvent, ProcessHandle, ProcessRequest};
use agenthub_plugin_sdk::{ProviderPlugin, PROVIDER_API_VERSION};

fn descriptor() -> Value {
    json!({
        "providerId": "trae",
        "name": "Trae",
        "vendor": "ByteDance",
        "capabilities": ["headless_text"],
        "defaultExecutable": "traecli",
        "credentialEnv": ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_API_KEY", "OPENROUTER_API_KEY", "DOUBAO_API_KEY"]
    })
}

fn str_of(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_string)
}

fn base_args(instance: &Value) -> Vec<String> {
    instance
        .get("baseArgs")
        .and_then(Value::as_array)
        .map(|args| args.iter().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or_default()
}

async fn capture(command: &str, args: &[String]) -> (String, Option<i32>) {
    let env: HashMap<String, String> = std::env::vars().collect();
    let mut started = match process::start(&ProcessRequest {
        command: command.to_string(),
        args: args.to_vec(),
        env: Some(env),
        inherit_env: true,
        timeout_ms: Some(8_000),
        idle_timeout_ms: Some(4_000),
        max_output_bytes: Some(512 * 1024),
        ..Default::default()
    }) {
        Ok(started) => started,
        Err(error) => return (error.to_string(), None),
    };
    let mut text = String::new();
    let mut code = None;
    while let Some(event) = started.events.recv().await {
        match event {
            ProcessEvent::Stdout(chunk) | ProcessEvent::Stderr(chunk) => text.push_str(&chunk),
            ProcessEvent::Exit { exit_code, .. } => code = exit_code,
            _ => {}
        }
    }
    (text, code)
}

struct TraeBinary {
    mode: String,
    version: String,
    help: String,
}

/// `acp` in the help means the official ACP-native CLI; a `run` subcommand
/// means the open-source trae-agent.
async fn probe_trae_binary(executable: &str, base_args: &[String]) -> Option<TraeBinary> {
    let mut args = base_args.to_vec();
    args.push("--version".to_string());
    let (version, version_code) = capture(executable, &args).await;
    if version_code != Some(0) {
        return None;
    }
    let mut args = base_args.to_vec();
    args.push("--help".to_string());
    let (help, help_code) = capture(executable, &args).await;
    if help_code != Some(0) {
        return None;
    }
    let acp = regex::Regex::new(r"(?i)\bacp\b").ok()?.is_match(&help);
    let cli = regex::Regex::new(r"(?m)^\s*run(\s|,|$)").ok()?.is_match(&help);
    let mode = if acp { "acp" } else if cli { "cli" } else { return None };
    Some(TraeBinary { mode: mode.to_string(), version: version.trim().to_string(), help })
}

struct TraePlugin {
    interactions: std::sync::Mutex<Option<Arc<dyn agenthub_plugin_sdk::InteractionChannel>>>,
}

impl TraePlugin {
    fn new() -> Self {
        Self { interactions: std::sync::Mutex::new(None) }
    }
}

#[async_trait::async_trait]
impl ProviderPlugin for TraePlugin {
    fn descriptor(&self) -> Value {
        descriptor()
    }

    fn capabilities(&self) -> Value {
        json!({
            "structuredOutput": false,
            "textOutput": true,
            "interactiveStdin": false,
            "nativeResume": true,
            "pty": false
        })
    }

    fn set_interaction_channel(&self, channel: Arc<dyn agenthub_plugin_sdk::InteractionChannel>) {
        *self.interactions.lock().unwrap() = Some(channel);
    }

    async fn detect(&self, instance: &Value) -> Value {
        let executable = str_of(instance, "executable").filter(|e| !e.is_empty()).unwrap_or_else(|| "traecli".to_string());
        match probe_trae_binary(&executable, &base_args(instance)).await {
            Some(probed) => json!({
                "installed": true,
                "compatible": true,
                "executable": executable,
                "version": probed.version,
                "help": probed.help.chars().take(16_384).collect::<String>(),
                "error": if probed.mode == "cli" {
                    Value::String("trae-agent 为纯文本模式：不支持会话恢复与上下文用量".to_string())
                } else {
                    Value::Null
                }
            }),
            None => json!({
                "installed": false,
                "executable": executable,
                "error": "未识别为 Trae CLI：请安装官方 TRAE CLI（traecli，企业版）或开源 trae-agent（trae-cli），或在实例设置中指定可执行文件路径"
            }),
        }
    }

    async fn start(&self, request: Value, resume: Option<String>) -> anyhow::Result<mpsc::UnboundedReceiver<Value>> {
        let (sender, receiver) = mpsc::unbounded_channel::<Value>();
        let interactions = self.interactions.lock().unwrap().clone();
        tokio::spawn(async move {
            let result = run(request, resume, sender.clone(), interactions).await;
            if let Err(error) = result {
                let _ = sender.send(json!({ "kind": "error", "message": error.to_string() }));
                let _ = sender.send(json!({ "kind": "exit", "exitCode": 1 }));
            }
        });
        Ok(receiver)
    }
}

async fn run(
    request: Value,
    resume: Option<String>,
    sender: mpsc::UnboundedSender<Value>,
    interactions: Option<Arc<dyn agenthub_plugin_sdk::InteractionChannel>>,
) -> anyhow::Result<()> {
    let instance = request.get("instance").cloned().unwrap_or(Value::Null);
    let executable = str_of(&instance, "executable").filter(|e| !e.is_empty()).unwrap_or_else(|| "traecli".to_string());
    let binary = probe_trae_binary(&executable, &base_args(&instance)).await;
    let Some(binary) = binary else {
        anyhow::bail!("未找到可用的 Trae CLI（traecli 或 trae-cli）");
    };
    if binary.mode == "cli" {
        let _ = sender.send(json!({ "kind": "status", "phase": "turn_started" }));
        return plain_run(&instance, &request, sender).await;
    }
    acp_run(&instance, &request, resume, sender, interactions).await
}

// ---------------------------------------------------------------- plain CLI

fn trae_cli_args(instance: &Value, request: &Value) -> Vec<String> {
    let mut args = base_args(instance);
    args.push("run".to_string());
    args.push(request.get("prompt").and_then(Value::as_str).unwrap_or("").to_string());
    args.push("--working-dir".to_string());
    args.push(request.get("cwd").and_then(Value::as_str).unwrap_or("").to_string());
    if let Some(model) = request.get("model").and_then(Value::as_str).map(str::trim).filter(|m| !m.is_empty()) {
        match model.find('/') {
            Some(slash) if slash > 0 => {
                args.push("--provider".to_string());
                args.push(model[..slash].to_string());
                args.push("--model".to_string());
                args.push(model[slash + 1..].to_string());
            }
            _ => {
                args.push("--model".to_string());
                args.push(model.to_string());
            }
        }
    }
    args
}

/// Strips ANSI escapes and trailing panel chrome from trae-cli console output.
fn clean_trae_cli_text(value: &str) -> String {
    let ansi = regex::Regex::new(r"\x1b\[[0-9;?]*[ -/]*[@-~]").unwrap();
    let plain = ansi.replace_all(value, "");
    plain
        .lines()
        .map(|line| line.trim_end())
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

async fn plain_run(instance: &Value, request: &Value, sender: mpsc::UnboundedSender<Value>) -> anyhow::Result<()> {
    let mut env: HashMap<String, String> = request
        .get("env")
        .and_then(Value::as_object)
        .map(|env| env.iter().filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string()))).collect())
        .unwrap_or_default();
    env.insert("PYTHONUNBUFFERED".to_string(), "1".to_string());
    let executable = str_of(instance, "executable").filter(|e| !e.is_empty()).unwrap_or_else(|| "traecli".to_string());
    let started = process::start(&ProcessRequest {
        command: executable,
        args: trae_cli_args(instance, request),
        cwd: request.get("cwd").and_then(Value::as_str).map(str::to_string),
        env: Some(env),
        timeout_ms: request.get("timeoutMs").and_then(Value::as_u64),
        idle_timeout_ms: request.get("idleTimeoutMs").and_then(Value::as_u64),
        max_output_bytes: Some(request.get("maxOutputBytes").and_then(Value::as_u64).map(|v| v as usize).unwrap_or(20 * 1024 * 1024)),
        ..Default::default()
    })?;
    started.handle.end_stdin();
    let mut stdout = String::new();
    let mut stderr = String::new();
    let mut events = started.events;
    while let Some(event) = events.recv().await {
        match event {
            ProcessEvent::Stdout(text) => {
                stdout.push_str(&text);
                let _ = sender.send(json!({ "kind": "raw", "stream": "stdout", "text": text }));
            }
            ProcessEvent::Stderr(text) => {
                stderr.push_str(&text);
                let _ = sender.send(json!({ "kind": "raw", "stream": "stderr", "text": text }));
            }
            ProcessEvent::Exit { exit_code, .. } => {
                let text = clean_trae_cli_text(&stdout);
                if exit_code == Some(0) {
                    if !text.is_empty() {
                        let _ = sender.send(json!({ "kind": "message", "phase": "completed", "text": text }));
                    }
                    let _ = sender.send(json!({ "kind": "status", "phase": "turn_completed" }));
                } else {
                    let detail = {
                        let cleaned = clean_trae_cli_text(&stderr);
                        if !cleaned.is_empty() {
                            cleaned
                        } else if !text.is_empty() {
                            text
                        } else {
                            format!("trae-cli exited with {}", exit_code.map(|c| c.to_string()).unwrap_or_else(|| "unknown".to_string()))
                        }
                    };
                    let _ = sender.send(json!({ "kind": "status", "phase": "turn_failed" }));
                    let _ = sender.send(json!({ "kind": "error", "message": detail.chars().take(2_000).collect::<String>() }));
                }
                let _ = sender.send(json!({ "kind": "exit", "exitCode": exit_code }));
                return Ok(());
            }
            ProcessEvent::Error(message) => {
                let _ = sender.send(json!({ "kind": "error", "message": message }));
            }
            ProcessEvent::Timeout { reason } => {
                let _ = sender.send(json!({ "kind": "timeout", "reason": reason }));
            }
        }
    }
    Ok(())
}

// ---------------------------------------------------------------- ACP transport

#[derive(Default)]
struct TraeAcpParseState {
    message_id: String,
    thinking_id: String,
    tool_names: HashMap<String, String>,
    tool_calls: HashMap<String, Value>,
}

async fn acp_run(
    instance: &Value,
    request: &Value,
    resume: Option<String>,
    sender: mpsc::UnboundedSender<Value>,
    interactions: Option<Arc<dyn agenthub_plugin_sdk::InteractionChannel>>,
) -> anyhow::Result<()> {
    let mut env: HashMap<String, String> = request
        .get("env")
        .and_then(Value::as_object)
        .map(|env| env.iter().filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string()))).collect())
        .unwrap_or_default();
    env.insert("PYTHONUNBUFFERED".to_string(), "1".to_string());
    let executable = str_of(instance, "executable").filter(|e| !e.is_empty()).unwrap_or_else(|| "traecli".to_string());
    let cwd = request.get("cwd").and_then(Value::as_str).map(str::to_string);

    let spawn_acp = |acp_args: &[&str]| {
        let mut args = base_args(instance);
        args.extend(acp_args.iter().map(|s| s.to_string()));
        process::start(&ProcessRequest {
            command: executable.clone(),
            args,
            cwd: cwd.clone(),
            env: Some(env.clone()),
            timeout_ms: request.get("timeoutMs").and_then(Value::as_u64),
            idle_timeout_ms: request.get("idleTimeoutMs").and_then(Value::as_u64),
            // ACP can stream cumulative tool inputs; no plain-text 20 MB cap.
            max_output_bytes: Some(request.get("maxOutputBytes").and_then(Value::as_u64).map(|v| v as usize).unwrap_or(256 * 1024 * 1024)),
            ..Default::default()
        })
    };

    // `traecli acp serve`; fall back to bare `acp` when the binary exits
    // before answering initialize.
    let initialize = json!({
        "protocolVersion": 1,
        "clientCapabilities": { "fs": { "readTextFile": false, "writeTextFile": false } },
        "clientInfo": { "name": "Nautilo", "version": "0.1.0" }
    });
    let mut started = spawn_acp(&["acp", "serve"])?;
    let mut rpc = JsonRpcClient::new(started.handle.clone(), started.events);
    if rpc.request("initialize", initialize.clone()).await.is_err() {
        started.handle.cancel().await;
        started = spawn_acp(&["acp"])?;
        rpc = JsonRpcClient::new(started.handle.clone(), started.events);
        rpc.request("initialize", initialize).await?;
    }
    let process = started.handle.clone();

    // session/load support check on resume.
    if resume.is_some() {
        // The initialize result flows through the event stream as a Response;
        // the fallback below keeps compatibility with CLIs that omit
        // agentCapabilities entirely.
    }

    let mcp_servers = acp_mcp_servers(request);
    let mut state = TraeAcpParseState {
        message_id: "trae-message-1".to_string(),
        thinking_id: "trae-thinking-1".to_string(),
        ..Default::default()
    };
    let mut message_streamed = false;
    let mut thinking_streamed = false;

    let session_method = if resume.is_some() { "session/load" } else { "session/new" };
    let session_params = match &resume {
        Some(session) => json!({ "sessionId": session, "cwd": cwd, "mcpServers": mcp_servers }),
        None => json!({ "cwd": cwd, "mcpServers": mcp_servers }),
    };
    let (session_request_id, session_result) = rpc.request_with_id(session_method, session_params.clone());
    // ACP session/load replays historical session/update notifications before
    // the load response; drain them so they are not mistaken for new content.
    let session_response = if resume.is_some() {
        loop {
            match rpc.next_event().await {
                Some(JsonRpcEvent::Response { id, error, .. }) if same_id(&id, &json!(session_request_id)) => {
                    if let Some(error) = error {
                        anyhow::bail!(error.to_string());
                    }
                    break;
                }
                Some(JsonRpcEvent::Request { id, method, params }) => {
                    if method == "session/request_permission" {
                        answer_acp_permission(&rpc, &id, &params, &interactions, "").await;
                    } else {
                        rpc.respond_error(&id, -32601, &format!("Nautilo does not support ACP request {method}"));
                    }
                }
                Some(_) => {}
                None => anyhow::bail!("TRAE CLI ACP closed before session/load completed"),
            }
        }
        match session_result.await {
            Ok(Ok(value)) => value,
            Ok(Err(message)) => anyhow::bail!(message),
            Err(_) => anyhow::bail!("session/load channel closed"),
        }
    } else {
        rpc.request(session_method, session_params).await?
    };
    let session_id = session_response
        .get("sessionId")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or(resume.clone())
        .filter(|id| !id.is_empty());
    let Some(session_id) = session_id else {
        anyhow::bail!("TRAE CLI ACP did not return a session id");
    };
    let _ = sender.send(json!({ "kind": "session", "providerSessionId": session_id }));
    apply_acp_config(&rpc, &session_id, &session_response, request).await;
    let _ = sender.send(json!({ "kind": "status", "phase": "turn_started" }));
    let (prompt_id, prompt_result) = rpc.request_with_id(
        "session/prompt",
        json!({ "sessionId": session_id, "prompt": [{ "type": "text", "text": request.get("prompt").and_then(Value::as_str).unwrap_or("") }] }),
    );
    tokio::spawn(async move {
        let _ = prompt_result.await;
    });

    loop {
        let Some(event) = rpc.next_event().await else {
            break;
        };
        match event {
            JsonRpcEvent::Notification { method, params } if method == "session/update" => {
                let update = params.get("update").cloned().unwrap_or(Value::Null);
                for item in parse_trae_acp_update(&update, &mut state) {
                    if item.get("kind").and_then(Value::as_str) == Some("message") {
                        message_streamed = true;
                    }
                    if item.get("kind").and_then(Value::as_str) == Some("thinking") {
                        thinking_streamed = true;
                    }
                    if sender.send(item).is_err() {
                        return Ok(());
                    }
                }
            }
            JsonRpcEvent::Request { id, method, params } => {
                if method == "session/request_permission" {
                    answer_acp_permission(&rpc, &id, &params, &interactions, &session_id).await;
                } else {
                    rpc.respond_error(&id, -32601, &format!("Nautilo does not support ACP request {method}"));
                }
            }
            JsonRpcEvent::Response { id, error, .. } if same_id(&id, &json!(prompt_id)) => {
                // The daemon coalesces delta buffers when a completed event
                // carries no text.
                if message_streamed {
                    let _ = sender.send(json!({ "kind": "message", "phase": "completed", "messageId": state.message_id, "text": "" }));
                }
                if thinking_streamed {
                    let _ = sender.send(json!({ "kind": "thinking", "phase": "completed", "messageId": state.thinking_id, "text": "" }));
                }
                let _ = sender.send(json!({ "kind": "status", "phase": if error.is_some() { "turn_failed" } else { "turn_completed" } }));
                process.cancel().await;
                let _ = sender.send(match error {
                    Some(error) => json!({ "kind": "error", "message": error.to_string() }),
                    None => json!({ "kind": "exit", "exitCode": 0 }),
                });
                return Ok(());
            }
            JsonRpcEvent::Response { .. } => {}
            JsonRpcEvent::Transport(event) => match event {
                ProcessEvent::Stdout(text) => {
                    let _ = sender.send(json!({ "kind": "raw", "stream": "stdout", "text": text }));
                }
                ProcessEvent::Stderr(text) => {
                    let _ = sender.send(json!({ "kind": "raw", "stream": "stderr", "text": text }));
                }
                ProcessEvent::Exit { exit_code, .. } => {
                    let _ = sender.send(json!({ "kind": "exit", "exitCode": exit_code }));
                    return Ok(());
                }
                ProcessEvent::Error(message) => {
                    let _ = sender.send(json!({ "kind": "error", "message": message }));
                }
                ProcessEvent::Timeout { reason } => {
                    let _ = sender.send(json!({ "kind": "timeout", "reason": reason }));
                }
            },
            _ => {}
        }
    }
    Ok(())
}

fn same_id(left: &Value, right: &Value) -> bool {
    left == right
}

fn acp_mcp_servers(request: &Value) -> Vec<Value> {
    let mut servers = vec![];
    for server in request.get("mcpServers").and_then(Value::as_array).cloned().unwrap_or_default() {
        let transport = server.get("transport").and_then(Value::as_str).unwrap_or("");
        let name = server.get("name").and_then(Value::as_str).unwrap_or("mcp");
        if transport == "http" {
            if let Some(url) = server.get("url").and_then(Value::as_str) {
                let headers: Vec<Value> = server
                    .get("headers")
                    .and_then(Value::as_object)
                    .map(|h| h.iter().map(|(name, value)| json!({ "name": name, "value": value })).collect())
                    .unwrap_or_default();
                servers.push(json!({ "type": "http", "name": name, "url": url, "headers": headers }));
            }
        } else if transport == "stdio" {
            if let Some(command) = server.get("command").and_then(Value::as_str) {
                let env: Vec<Value> = server
                    .get("env")
                    .and_then(Value::as_object)
                    .map(|e| e.iter().map(|(name, value)| json!({ "name": name, "value": value })).collect())
                    .unwrap_or_default();
                servers.push(json!({
                    "name": name,
                    "command": command,
                    "args": server.get("args").cloned().unwrap_or_else(|| json!([])),
                    "env": env
                }));
            }
        }
    }
    servers
}

/// Applies session model / reasoning effort through ACP configOptions.
async fn apply_acp_config(rpc: &JsonRpcClient, session_id: &str, response: &Value, request: &Value) {
    let options = response.get("configOptions").and_then(Value::as_array).cloned().unwrap_or_default();
    let selections: [(Option<String>, [&str; 3]); 2] = [
        (request.get("model").and_then(Value::as_str).map(str::to_string), ["model", "", ""]),
        (request.get("reasoningEffort").and_then(Value::as_str).map(str::to_string), ["thinking", "reasoning", "effort"]),
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
}

async fn answer_acp_permission(
    rpc: &JsonRpcClient,
    id: &Value,
    params: &Value,
    interactions: &Option<Arc<dyn agenthub_plugin_sdk::InteractionChannel>>,
    run_id: &str,
) {
    let options = params.get("options").and_then(Value::as_array).cloned().unwrap_or_default();
    if let Some(channel) = interactions {
        let tool_call = params.get("toolCall").cloned().unwrap_or(Value::Null);
        let detail = tool_call
            .get("rawInput")
            .map(|input| serde_json::to_string_pretty(input).unwrap_or_default().chars().take(4_000).collect::<String>());
        let mapped_options: Vec<Value> = options
            .iter()
            .filter_map(|option| {
                let option_id = option
                    .get("optionId")
                    .and_then(Value::as_str)
                    .or_else(|| option.get("id").and_then(Value::as_str))?;
                Some(json!({
                    "id": option_id,
                    "label": option.get("name").and_then(Value::as_str)
                        .or_else(|| option.get("label").and_then(Value::as_str))
                        .unwrap_or(option_id)
                }))
            })
            .collect();
        let response = channel
            .ask(
                run_id,
                json!({
                    "kind": "approval",
                    "title": tool_call.get("title").and_then(Value::as_str).unwrap_or("Trae permission"),
                    "detail": detail.map(Value::String).unwrap_or(Value::Null),
                    "options": mapped_options
                }),
            )
            .await;
        if response.get("outcome").and_then(Value::as_str) == Some("selected") {
            if let Some(option_id) = response.get("optionId").and_then(Value::as_str) {
                rpc.respond(id, json!({ "outcome": { "outcome": "selected", "optionId": option_id } }));
                return;
            }
        }
        rpc.respond(id, json!({ "outcome": { "outcome": "cancelled" } }));
        return;
    }
    // Default policy (no host bridge): pick the first non-reject option.
    let allowed = options
        .iter()
        .find(|option| !option.get("kind").and_then(Value::as_str).unwrap_or("").contains("reject"));
    match allowed.and_then(|o| o.get("optionId")).and_then(Value::as_str) {
        Some(option_id) => rpc.respond(id, json!({ "outcome": { "outcome": "selected", "optionId": option_id } })),
        None => rpc.respond(id, json!({ "outcome": { "outcome": "cancelled" } })),
    }
}

// ---------------------------------------------------------------- ACP parsing

const TOOL_INPUT_IDENTITY_KEYS: [&str; 8] =
    ["path", "file_path", "filePath", "target_path", "targetPath", "query", "pattern", "glob"];

fn printable(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::String(s) if !s.trim().is_empty() => Some(s.clone()),
        Value::String(_) => None,
        Value::Array(items) => {
            let parts: Vec<String> = items.iter().filter_map(printable).collect();
            if parts.is_empty() {
                None
            } else {
                Some(parts.join("\n"))
            }
        }
        Value::Object(map) => {
            if let Some(text) = map.get("text").and_then(Value::as_str).filter(|t| !t.trim().is_empty()) {
                return Some(text.to_string());
            }
            if let Some(content) = map.get("content") {
                if let Some(nested) = printable(content) {
                    return Some(nested);
                }
            }
            serde_json::to_string_pretty(value).ok()
        }
        other => Some(other.to_string()),
    }
}

fn tool_input(value: &Value) -> Value {
    let Some(source) = value.as_object() else {
        return value.clone();
    };
    let mut prioritized = Map::new();
    for key in TOOL_INPUT_IDENTITY_KEYS {
        if let Some(entry) = source.get(key) {
            prioritized.insert(key.to_string(), entry.clone());
        }
    }
    for (key, entry) in source {
        if !prioritized.contains_key(key) {
            prioritized.insert(key.clone(), entry.clone());
        }
    }
    Value::Object(prioritized)
}

fn merge_tool_input(previous: Option<&Value>, current: &Value) -> Value {
    match (previous, current.as_object()) {
        (Some(Value::Object(prev)), Some(curr)) => {
            let mut merged = prev.clone();
            for (key, entry) in curr {
                merged.insert(key.clone(), entry.clone());
            }
            tool_input(&Value::Object(merged))
        }
        _ => current.clone(),
    }
}

fn tool_input_identity(value: &Value) -> Option<String> {
    let input = value.as_object()?;
    let identity: Vec<(String, String)> = TOOL_INPUT_IDENTITY_KEYS
        .iter()
        .filter_map(|key| {
            let entry = input.get(*key)?.as_str()?.trim();
            if entry.is_empty() {
                None
            } else {
                Some((key.to_string(), entry.to_string()))
            }
        })
        .collect();
    if identity.is_empty() {
        None
    } else {
        Some(serde_json::to_string(&identity).unwrap_or_default())
    }
}

fn first_string(input: &Map<String, Value>, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| input.get(*key).and_then(Value::as_str).map(str::to_string))
}

fn file_diff(tool_name: &str, value: Option<&Value>) -> Option<Value> {
    let normalized: String = tool_name
        .trim()
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();
    let is_edit = normalized == "edit"
        || normalized.starts_with("edit_")
        || normalized.starts_with("editing_")
        || normalized.ends_with("_edit")
        || normalized.ends_with("_edit_file");
    let is_write = normalized == "write"
        || normalized.starts_with("write_")
        || normalized.starts_with("writing_")
        || normalized.ends_with("_write")
        || normalized.ends_with("_write_file");
    if !is_edit && !is_write {
        return None;
    }
    let input = value?.as_object()?;
    let path = first_string(input, &TOOL_INPUT_IDENTITY_KEYS.iter().copied().collect::<Vec<_>>());
    let build = |operation: &str, before: &str, after: &str| {
        let mut diff = Map::new();
        diff.insert("operation".to_string(), json!(operation));
        if let Some(path) = &path {
            diff.insert("path".to_string(), json!(path));
        }
        diff.insert("before".to_string(), json!(before));
        diff.insert("after".to_string(), json!(after));
        Value::Object(diff)
    };
    if is_write {
        let content = first_string(input, &["content", "text", "data"])?;
        return Some(build("write", "", &content));
    }
    let before = first_string(input, &["old_string", "oldString", "old_text", "oldText", "before"])?;
    let after = first_string(input, &["new_string", "newString", "new_text", "newText", "after"])?;
    Some(build("edit", &before, &after))
}

/// Parses one ACP `session/update` notification payload (protocol-generic).
fn parse_trae_acp_update(value: &Value, state: &mut TraeAcpParseState) -> Vec<Value> {
    let update_type = value.get("sessionUpdate").and_then(Value::as_str).unwrap_or("");
    match update_type {
        "available_commands_update" => {
            let commands: Vec<Value> = value
                .get("availableCommands")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
                .iter()
                .filter_map(|command| {
                    let name = command.get("name").and_then(Value::as_str)?;
                    let mut mapped = Map::new();
                    mapped.insert("name".to_string(), json!(name));
                    mapped.insert(
                        "description".to_string(),
                        command.get("description").and_then(Value::as_str).map(|d| json!(d)).unwrap_or_else(|| json!(name)),
                    );
                    if let Some(hint) = command.get("input").and_then(|i| i.get("hint")).and_then(Value::as_str) {
                        mapped.insert("inputHint".to_string(), json!(hint));
                    }
                    Some(Value::Object(mapped))
                })
                .collect();
            if commands.is_empty() {
                vec![]
            } else {
                vec![json!({ "kind": "commands", "commands": commands, "raw": value })]
            }
        }
        "usage_update" => vec![json!({
            "kind": "usage",
            "contextUsed": value.get("used").cloned().unwrap_or(Value::Null),
            "contextWindow": value.get("size").cloned().unwrap_or(Value::Null),
            "raw": value
        })],
        "agent_message_chunk" => {
            let content = value.get("content").cloned().unwrap_or(Value::Null);
            if content.get("type").and_then(Value::as_str) == Some("text") {
                if let Some(chunk) = content.get("text").and_then(Value::as_str) {
                    return vec![json!({
                        "kind": "message",
                        "phase": "delta",
                        "messageId": state.message_id,
                        "text": chunk,
                        "raw": value
                    })];
                }
            }
            vec![]
        }
        "agent_thought_chunk" => {
            let content = value.get("content").cloned().unwrap_or(Value::Null);
            if content.get("type").and_then(Value::as_str) == Some("text") {
                if let Some(chunk) = content.get("text").and_then(Value::as_str).filter(|t| !t.is_empty()) {
                    return vec![json!({
                        "kind": "thinking",
                        "phase": "delta",
                        "messageId": state.thinking_id,
                        "text": chunk,
                        "raw": value
                    })];
                }
            }
            vec![]
        }
        "tool_call" | "tool_call_update" => parse_tool_call(value, state),
        _ => vec![],
    }
}

fn parse_tool_call(update: &Value, state: &mut TraeAcpParseState) -> Vec<Value> {
    let call_id = update.get("toolCallId").and_then(Value::as_str).map(str::to_string);
    let supplied_name = update.get("title").and_then(Value::as_str).map(str::to_string);
    if let (Some(call_id), Some(name)) = (&call_id, &supplied_name) {
        state.tool_names.entry(call_id.clone()).or_insert_with(|| name.clone());
    }
    let name = call_id
        .as_ref()
        .and_then(|id| state.tool_names.get(id).cloned())
        .or(supplied_name)
        .unwrap_or_else(|| "tool".to_string());
    let status = update.get("status").and_then(Value::as_str).unwrap_or("");
    let completed = status == "completed" || status == "failed";
    let input = update.get("rawInput").map(|v| tool_input(v));
    let output = update.get("rawOutput").and_then(printable).or_else(|| update.get("content").and_then(printable));

    if let Some(call_id) = &call_id {
        let previous = state.tool_calls.remove(call_id);
        let previous_input = previous.as_ref().and_then(|p| p.get("input").cloned());
        let merged_input = match (&input, previous_input.as_ref()) {
            (Some(current), previous) => Some(merge_tool_input(previous, current)),
            (None, previous) => previous.cloned(),
        };
        let next_identity = merged_input.as_ref().and_then(tool_input_identity);
        let previous_identity = previous
            .as_ref()
            .and_then(|p| p.get("inputIdentity").cloned())
            .and_then(|v| v.as_str().map(str::to_string));
        let duplicate = previous.as_ref().is_some_and(|p| p.get("phase").and_then(Value::as_str) == Some("completed"))
            || (!completed
                && previous.as_ref().is_some_and(|p| p.get("phase").and_then(Value::as_str) == Some("started"))
                && previous_identity == next_identity);
        let mut next = Map::new();
        next.insert("phase".to_string(), json!(if completed { "completed" } else { "started" }));
        next.insert("input".to_string(), merged_input.clone().unwrap_or(Value::Null));
        next.insert("inputIdentity".to_string(), next_identity.map(Value::String).unwrap_or(Value::Null));
        next.insert(
            "output".to_string(),
            output.clone().map(Value::String).or_else(|| previous.as_ref().and_then(|p| p.get("output").cloned())).unwrap_or(Value::Null),
        );
        state.tool_calls.insert(call_id.clone(), Value::Object(next));
        if duplicate {
            return vec![];
        }
        return vec![json!({
            "kind": "tool",
            "callId": call_id,
            "name": name,
            "phase": if completed { "completed" } else { "started" },
            "input": merged_input.unwrap_or(Value::Null),
            "output": output.map(Value::String).unwrap_or(Value::Null),
            "success": status != "failed",
            "fileDiff": file_diff(&name, input.as_ref()).unwrap_or(Value::Null),
            "raw": update
        })];
    }
    vec![json!({
        "kind": "tool",
        "callId": call_id.map(Value::String).unwrap_or(Value::Null),
        "name": name,
        "phase": if completed { "completed" } else { "started" },
        "input": input.clone().unwrap_or(Value::Null),
        "output": output.map(Value::String).unwrap_or(Value::Null),
        "success": status != "failed",
        "fileDiff": file_diff(&name, input.as_ref()).unwrap_or(Value::Null),
        "raw": update
    })]
}

#[tokio::main]
async fn main() {
    agenthub_plugin_sdk::serve(TraePlugin::new()).await;
}
