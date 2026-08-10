//! Nautilo native provider plugin for Oh My Pi (`omp`).
//!
//! omp is a fork of Pi (badlogic/pi-mono) and keeps the same JSONL RPC wire
//! shape for agent events, but:
//!   - requires a `negotiate_protocol` handshake before commands are read,
//!   - injects host tools via the native `set_host_tools` frame (no `.mjs`
//!     extension + loopback HTTP MCP bridge needed),
//!   - discovers models via the `omp models --json` CLI (or the RPC
//!     `get_available_models` command),
//!   - authenticates through omp's own provider stack (`/login` OAuth, API-key
//!     env vars, config.yml) instead of Nautilo-injected env vars.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::{json, Map, Value};
use tokio::sync::mpsc;

use agenthub_plugin_sdk::process::{self, ProcessEvent, ProcessRequest};
use base64::Engine;
use agenthub_plugin_sdk::{DaemonChannel, ProviderPlugin};

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn native_commands() -> Value {
    json!([{
        "name": "compact",
        "description": "压缩当前 omp 会话上下文，可附带保留内容说明",
        "inputHint": "可选的压缩说明",
        "providerCommand": "compact"
    }])
}

fn descriptor() -> Value {
    json!({
        "providerId": "omp",
        "name": "Oh My Pi",
        "vendor": "Oh My Pi",
        "capabilities": ["headless_structured", "tool_streaming"],
        "defaultExecutable": "omp",
        "credentialEnv": [
            "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY",
            "DEEPSEEK_API_KEY", "KIMI_API_KEY", "MOONSHOT_API_KEY", "OPENROUTER_API_KEY"
        ],
        "baseUrlEnv": "AGENTHUB_OMP_BASE_URL",
        "envPassthrough": [
            "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "AZURE_OPENAI_API_KEY",
            "DEEPSEEK_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY",
            "KIMI_API_KEY", "MOONSHOT_API_KEY", "OPENCODE_API_KEY",
            "ZAI_API_KEY", "ZAI_CODING_CN_API_KEY", "AWS_PROFILE",
            "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION",
            "OMP_AUTH_BROKER_URL", "OMP_AUTH_BROKER_TOKEN"
        ],
        "permissionModes": [
            { "value": "standard", "name": { "zh-CN": "标准", "en-US": "Standard" },
              "description": { "zh-CN": "加载项目级 omp 资源并沿用 omp 的工具配置", "en-US": "Load project-local omp resources and keep omp's configured tools" } },
            { "value": "read-only", "name": { "zh-CN": "只读", "en-US": "Read only" },
              "description": { "zh-CN": "仅启用 read、grep、find 和 ls", "en-US": "Only enable read, grep, find, and ls" } },
            { "value": "isolated", "name": { "zh-CN": "忽略项目扩展", "en-US": "Ignore project extensions" },
              "description": { "zh-CN": "沿用 omp 的工具配置，但不加载项目级 omp 资源", "en-US": "Keep omp's configured tools but ignore project-local omp resources" } }
        ],
        "apiTypes": [
            { "value": "openai-completions", "name": { "zh-CN": "OpenAI Chat Completions", "en-US": "OpenAI Chat Completions" },
              "description": { "zh-CN": "适用于 /chat/completions 兼容接口", "en-US": "For /chat/completions-compatible endpoints" } },
            { "value": "openai-responses", "name": { "zh-CN": "OpenAI Responses", "en-US": "OpenAI Responses" },
              "description": { "zh-CN": "适用于 OpenAI Responses 兼容接口", "en-US": "For OpenAI Responses-compatible endpoints" } },
            { "value": "anthropic-messages", "name": { "zh-CN": "Anthropic Messages", "en-US": "Anthropic Messages" },
              "description": { "zh-CN": "适用于 Anthropic Messages 兼容接口", "en-US": "For Anthropic Messages-compatible endpoints" } },
            { "value": "google-generative-ai", "name": { "zh-CN": "Google Generative AI", "en-US": "Google Generative AI" },
              "description": { "zh-CN": "适用于 Gemini/Google Generative AI 接口", "en-US": "For Gemini/Google Generative AI endpoints" } }
        ],
        "nativeCommands": [{
            "name": "compact",
            "description": "压缩当前 omp 会话上下文，可附带保留内容说明",
            "inputHint": "可选的压缩说明",
            "providerCommand": "compact"
        }],
        "contextWindowDiscovery": true
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

fn env_of(request: &Value) -> HashMap<String, String> {
    request
        .get("env")
        .and_then(Value::as_object)
        .map(|env| env.iter().filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string()))).collect())
        .unwrap_or_default()
}

fn executable_of(instance: &Value) -> String {
    str_of(instance, "executable").filter(|e| !e.is_empty()).unwrap_or_else(|| "omp".to_string())
}

// ---------------------------------------------------------------- capture helpers

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

// ---------------------------------------------------------------- the plugin

struct OmpPlugin {
    channel: Mutex<Option<Arc<dyn DaemonChannel>>>,
    runs: Mutex<HashMap<String, agenthub_plugin_sdk::process::ProcessHandle>>,
}

impl OmpPlugin {
    fn new() -> Self {
        Self {
            channel: Mutex::new(None),
            runs: Mutex::new(HashMap::new()),
        }
    }
}

#[async_trait::async_trait]
impl ProviderPlugin for OmpPlugin {
    fn descriptor(&self) -> Value {
        descriptor()
    }

    fn capabilities(&self) -> Value {
        json!({
            "structuredOutput": false,
            "textOutput": true,
            "interactiveStdin": true,
            "nativeResume": false,
            "pty": false
        })
    }

    fn set_interaction_channel(&self, channel: Arc<dyn agenthub_plugin_sdk::InteractionChannel>) {
        *self.channel.lock().unwrap() = Some(unsafe { std::mem::transmute(channel) });
    }

    async fn detect(&self, instance: &Value) -> Value {
        let executable = executable_of(instance);
        let mut args = base_args(instance);
        args.push("--version".to_string());
        let (version, version_code) = capture(&executable, &args).await;
        if version_code != Some(0) {
            return json!({
                "installed": false,
                "executable": executable,
                "error": if version.trim().is_empty() { "omp --version failed".to_string() } else { version.trim().to_string() }
            });
        }
        let mut args = base_args(instance);
        args.push("--help".to_string());
        let (help, help_code) = capture(&executable, &args).await;
        let compatible = help_code == Some(0)
            && regex::Regex::new(r"(?i)omp").map(|re| re.is_match(&help)).unwrap_or(false)
            && regex::Regex::new(r"(?i)--mode=<value>").map(|re| re.is_match(&help)).unwrap_or(false)
            && regex::Regex::new(r"(?i)\brpc\b").map(|re| re.is_match(&help)).unwrap_or(false);
        json!({
            "installed": true,
            "compatible": compatible,
            "executable": executable,
            "version": version.trim(),
            "help": help.chars().take(16_384).collect::<String>(),
            "error": if compatible {
                Value::Null
            } else {
                Value::String("检测到 omp 可执行文件不是支持 JSONL RPC 的 Oh My Pi coding agent，或版本过旧".to_string())
            }
        })
    }

    async fn list_models(&self, instance: &Value, _context: &Value) -> anyhow::Result<Value> {
        let executable = executable_of(instance);
        let mut args = base_args(instance);
        args.extend(["models".to_string(), "--json".to_string()]);
        let (text, code) = capture(&executable, &args).await;
        if code != Some(0) {
            anyhow::bail!(if text.trim().is_empty() {
                format!("omp models --json exited with {}", code.map(|c| c.to_string()).unwrap_or_else(|| "unknown".to_string()))
            } else {
                text.trim().to_string()
            });
        }
        let output: Value = serde_json::from_str(&text)
            .map_err(|error| anyhow::anyhow!("omp models --json returned invalid JSON: {error}"))?;
        Ok(parse_omp_models(&output))
    }

    async fn start(&self, request: Value, resume: Option<String>) -> anyhow::Result<mpsc::UnboundedReceiver<Value>> {
        let (sender, receiver) = mpsc::unbounded_channel::<Value>();
        let channel = self.channel.lock().unwrap().clone();
        let run_handle_slot = Arc::new(Mutex::new(None::<agenthub_plugin_sdk::process::ProcessHandle>));
        let slot = run_handle_slot.clone();
        tokio::spawn(async move {
            let result = run_omp(request, resume, sender.clone(), channel, slot).await;
            if let Err(error) = result {
                let _ = sender.send(json!({ "kind": "error", "message": error.to_string() }));
                let _ = sender.send(json!({ "kind": "exit", "exitCode": 1 }));
            }
        });
        let _ = run_handle_slot;
        Ok(receiver)
    }

    async fn dispose(&self) {}
}

// ---------------------------------------------------------------- model discovery

fn parse_omp_models(output: &Value) -> Value {
    let raw_models: Vec<Value> = output
        .get("models")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut models: Vec<Value> = Vec::with_capacity(raw_models.len());
    let mut default_model: Option<String> = None;
    let mut first_id: Option<String> = None;
    for item in &raw_models {
        let provider = item.get("provider").and_then(Value::as_str).unwrap_or("unknown");
        let model_id = item.get("id").and_then(Value::as_str).unwrap_or("unknown");
        let selector = item.get("selector").and_then(Value::as_str);
        let id = selector
            .filter(|s| !s.is_empty())
            .unwrap_or(&format!("{provider}/{model_id}"))
            .to_string();
        if first_id.is_none() {
            first_id = Some(id.clone());
        }
        let name = item.get("name").and_then(Value::as_str).unwrap_or(model_id);
        let reasoning = item.get("reasoning").and_then(Value::as_bool) == Some(true);
        let mut efforts: Vec<String> = item
            .get("thinking")
            .and_then(Value::as_array)
            .map(|levels| levels.iter().filter_map(Value::as_str).map(str::to_string).collect())
            .unwrap_or_default();
        efforts.dedup();
        let input: Vec<String> = item
            .get("input")
            .and_then(Value::as_array)
            .map(|values| values.iter().filter_map(Value::as_str).map(str::to_string).collect())
            .unwrap_or_default();
        let mut capabilities = vec!["tool_use".to_string()];
        if reasoning {
            capabilities.push("reasoning".to_string());
        }
        if input.iter().any(|i| i == "image") {
            capabilities.push("vision".to_string());
        }
        let reasoning_efforts: Vec<String> = if reasoning {
            let mut list = vec!["off".to_string()];
            list.extend(if efforts.is_empty() {
                vec!["low".to_string(), "medium".to_string(), "high".to_string()]
            } else {
                efforts.clone()
            });
            list.dedup();
            list
        } else {
            vec![]
        };
        let default_effort = if reasoning_efforts.iter().any(|e| e == "medium") {
            "medium".to_string()
        } else {
            reasoning_efforts.first().cloned().unwrap_or_default()
        };
        if default_model.is_none() && reasoning {
            default_model = Some(id.clone());
        }
        models.push(json!({
            "id": id,
            "displayName": name,
            "description": format!("{provider} · {model_id}"),
            "isDefault": false,
            "contextWindow": item.get("contextWindow").cloned().unwrap_or(Value::Null),
            "maxTokens": item.get("maxTokens").cloned().unwrap_or(Value::Null),
            "capabilities": capabilities,
            "reasoningEfforts": reasoning_efforts,
            "defaultReasoningEffort": default_effort,
            "serviceTiers": []
        }));
    }
    let default = default_model.or(first_id);
    if let Some(default_id) = &default {
        for model in models.iter_mut() {
            let is_default = Some(model.get("id").and_then(Value::as_str).unwrap_or("").to_string()) == Some(default_id.clone());
            if is_default {
                model.as_object_mut().unwrap().insert("isDefault".to_string(), json!(true));
                break;
            }
        }
    }
    json!({
        "providerId": "omp",
        "models": models,
        "defaultModel": default.map(Value::String).unwrap_or(Value::Null),
        "source": "provider_cli",
        "fetchedAt": now_iso()
    })
}

// ---------------------------------------------------------------- RPC event parsing

#[derive(Default)]
struct OmpParseState {
    message_sequence: u32,
    current_message_id: Option<String>,
    current_thinking_id: Option<String>,
    streamed_text: bool,
    streamed_thinking: bool,
    last_assistant_stop_reason: Option<String>,
    model_error: bool,
    tool_args: HashMap<String, (String, Value)>,
}

fn omp_file_diff(name: &str, args: &Value) -> Option<Value> {
    let path = args.get("path").and_then(Value::as_str)?;
    let build = |operation: &str, before: &str, after: &str| {
        json!({ "operation": operation, "path": path, "before": before, "after": after })
    };
    if name == "write" {
        return Some(build("write", "", args.get("content").and_then(Value::as_str).unwrap_or("")));
    }
    if name != "edit" {
        return None;
    }
    let edits = args.get("edits").and_then(Value::as_array).cloned().unwrap_or_default();
    if edits.len() == 1 {
        return Some(build(
            "edit",
            edits[0].get("oldText").and_then(Value::as_str).unwrap_or(""),
            edits[0].get("newText").and_then(Value::as_str).unwrap_or(""),
        ));
    }
    if let (Some(before), Some(after)) = (args.get("oldText").and_then(Value::as_str), args.get("newText").and_then(Value::as_str)) {
        return Some(build("edit", before, after));
    }
    None
}

fn tool_result_text(value: &Value) -> String {
    let content: Vec<String> = value
        .get("content")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter(|part| part.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|part| part.get("text").and_then(Value::as_str).map(str::to_string))
        .collect();
    let text = content.join("\n");
    if !text.is_empty() {
        text
    } else if let Some(text) = value.as_str() {
        text.to_string()
    } else {
        value.to_string()
    }
}

/// Maps an omp RPC event to zero or more Nautilo adapter events.
fn parse_omp_rpc_event(value: &Value, state: &mut OmpParseState) -> Vec<Value> {
    let event_type = value.get("type").and_then(Value::as_str).unwrap_or("");
    match event_type {
        "message_start" => {
            let message = value.get("message").cloned().unwrap_or(Value::Null);
            if message.get("role").and_then(Value::as_str) != Some("assistant") {
                return vec![];
            }
            state.message_sequence += 1;
            state.current_message_id = Some(format!("omp-message-{}", state.message_sequence));
            state.current_thinking_id = Some(format!("omp-thinking-{}", state.message_sequence));
            state.streamed_text = false;
            state.streamed_thinking = false;
            vec![]
        }
        "message_update" => {
            let delta = value.get("assistantMessageEvent").cloned().unwrap_or(Value::Null);
            match delta.get("type").and_then(Value::as_str) {
                Some("text_delta") => {
                    state.streamed_text = true;
                    vec![json!({
                        "kind": "message",
                        "text": delta.get("delta").and_then(Value::as_str).unwrap_or(""),
                        "phase": "delta",
                        "messageId": state.current_message_id.clone().map(Value::String).unwrap_or(Value::Null),
                        "raw": value
                    })]
                }
                Some("thinking_delta") => {
                    state.streamed_thinking = true;
                    vec![json!({
                        "kind": "thinking",
                        "text": delta.get("delta").and_then(Value::as_str).unwrap_or(""),
                        "phase": "delta",
                        "messageId": state.current_thinking_id.clone().map(Value::String).unwrap_or(Value::Null),
                        "raw": value
                    })]
                }
                Some("error") => {
                    state.model_error = true;
                    vec![json!({
                        "kind": "error",
                        "message": delta.get("error").and_then(Value::as_str)
                            .or_else(|| delta.get("reason").and_then(Value::as_str))
                            .unwrap_or("omp model response stream failed")
                    })]
                }
                _ => vec![],
            }
        }
        "message_end" => {
            let message = value.get("message").cloned().unwrap_or(Value::Null);
            if message.get("role").and_then(Value::as_str) != Some("assistant") {
                return vec![];
            }
            let content = message.get("content").and_then(Value::as_array).cloned().unwrap_or_default();
            let stop_reason = message.get("stopReason").and_then(Value::as_str).map(str::to_string);
            state.last_assistant_stop_reason = stop_reason.clone();
            state.model_error = stop_reason.as_deref() == Some("error") || stop_reason.as_deref() == Some("aborted");
            let mut events = vec![];
            if !state.streamed_text {
                let text: String = content
                    .iter()
                    .filter(|part| part.get("type").and_then(Value::as_str) == Some("text"))
                    .filter_map(|part| part.get("text").and_then(Value::as_str))
                    .collect();
                if !text.is_empty() {
                    events.push(json!({
                        "kind": "message",
                        "text": text,
                        "phase": "delta",
                        "messageId": state.current_message_id.clone().map(Value::String).unwrap_or(Value::Null),
                        "raw": value
                    }));
                }
            }
            if !state.streamed_thinking {
                let thinking: String = content
                    .iter()
                    .filter(|part| part.get("type").and_then(Value::as_str) == Some("thinking"))
                    .filter_map(|part| part.get("thinking").and_then(Value::as_str))
                    .collect();
                if !thinking.is_empty() {
                    events.push(json!({
                        "kind": "thinking",
                        "text": thinking,
                        "phase": "delta",
                        "messageId": state.current_thinking_id.clone().map(Value::String).unwrap_or(Value::Null),
                        "raw": value
                    }));
                }
            }
            if state.streamed_thinking || content.iter().any(|part| part.get("type").and_then(Value::as_str) == Some("thinking")) {
                events.push(json!({
                    "kind": "thinking",
                    "text": "",
                    "phase": "completed",
                    "messageId": state.current_thinking_id.clone().map(Value::String).unwrap_or(Value::Null),
                    "raw": value
                }));
            }
            events.push(json!({
                "kind": "message",
                "text": "",
                "phase": "completed",
                "messageId": state.current_message_id.clone().map(Value::String).unwrap_or(Value::Null),
                "raw": value
            }));
            let usage = message.get("usage").cloned().unwrap_or(Value::Null);
            if usage.is_object() && !usage.as_object().is_none_or(|u| u.is_empty()) {
                events.push(json!({
                    "kind": "usage",
                    "inputTokens": usage.get("input").cloned().unwrap_or(Value::Null),
                    "cachedInputTokens": usage.get("cacheRead").cloned().unwrap_or(Value::Null),
                    "outputTokens": usage.get("output").cloned().unwrap_or(Value::Null),
                    "reasoningOutputTokens": usage.get("reasoning").cloned().unwrap_or(Value::Null),
                    "contextUsed": usage.get("totalTokens").cloned().unwrap_or(Value::Null),
                    "raw": value
                }));
            }
            if state.model_error {
                events.push(json!({
                    "kind": "error",
                    "message": message.get("errorMessage").and_then(Value::as_str).map(str::to_string)
                        .unwrap_or_else(|| format!("omp assistant stopped with {}", stop_reason.unwrap_or_else(|| "an unknown model error".to_string())))
                }));
            }
            events
        }
        "tool_execution_start" => {
            let call_id = value.get("toolCallId").and_then(Value::as_str).unwrap_or("").to_string();
            let name = value.get("toolName").and_then(Value::as_str).unwrap_or("tool").to_string();
            let args = value.get("args").cloned().unwrap_or(Value::Null);
            state.tool_args.insert(call_id.clone(), (name.clone(), args.clone()));
            if name == "bash" {
                return vec![json!({
                    "kind": "command",
                    "callId": call_id,
                    "command": args.get("command").and_then(Value::as_str).unwrap_or(""),
                    "phase": "started",
                    "raw": value
                })];
            }
            vec![json!({
                "kind": "tool",
                "callId": call_id,
                "name": name,
                "phase": "started",
                "input": args,
                "fileDiff": omp_file_diff(&name, &args).unwrap_or(Value::Null),
                "raw": value
            })]
        }
        "tool_execution_end" => {
            let call_id = value.get("toolCallId").and_then(Value::as_str).unwrap_or("").to_string();
            let stored = state.tool_args.get(&call_id).cloned();
            let name = value
                .get("toolName")
                .and_then(Value::as_str)
                .map(str::to_string)
                .or_else(|| stored.as_ref().map(|(name, _)| name.clone()))
                .unwrap_or_else(|| "tool".to_string());
            let output = tool_result_text(value.get("result").unwrap_or(&Value::Null));
            let success = value.get("isError").and_then(Value::as_bool) != Some(true);
            if name == "bash" {
                return vec![json!({
                    "kind": "command",
                    "callId": call_id,
                    "command": stored.as_ref().and_then(|(_, args)| args.get("command").and_then(Value::as_str).map(str::to_string)).unwrap_or_default(),
                    "phase": "completed",
                    "exitCode": if success { 0 } else { 1 },
                    "output": output,
                    "raw": value
                })];
            }
            vec![json!({
                "kind": "tool",
                "callId": call_id,
                "name": name,
                "phase": "completed",
                "input": stored.as_ref().map(|(_, args)| args.clone()).unwrap_or(Value::Null),
                "output": output,
                "success": success,
                "fileDiff": stored.as_ref().and_then(|(name, args)| omp_file_diff(name, args)).unwrap_or(Value::Null),
                "raw": value
            })]
        }
        "auto_retry_start" => vec![json!({
            "kind": "raw",
            "stream": "stderr",
            "text": format!("omp retry {} / {}: {}\n",
                value.get("attempt").and_then(Value::as_i64).map(|v| v.to_string()).unwrap_or_default(),
                value.get("maxAttempts").and_then(Value::as_i64).map(|v| v.to_string()).unwrap_or_default(),
                value.get("errorMessage").and_then(Value::as_str).unwrap_or(""))
        })],
        "extension_error" => vec![json!({
            "kind": "error",
            "message": value.get("error").and_then(Value::as_str).unwrap_or("omp extension failed")
        })],
        _ => vec![],
    }
}

fn mime_type_of(path: &str) -> &'static str {
    let lower = path.to_lowercase();
    if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
        "image/jpeg"
    } else if lower.ends_with(".gif") {
        "image/gif"
    } else if lower.ends_with(".webp") {
        "image/webp"
    } else {
        "image/png"
    }
}

// ---------------------------------------------------------------- protocol v2 chunk reassembly

/// Protocol v2 splits oversized frames into `rpc_chunk` physical lines.
struct RpcChunkState {
    parts: HashMap<String, Vec<(usize, String)>>,
    counts: HashMap<String, usize>,
}

impl RpcChunkState {
    fn new() -> Self {
        Self { parts: HashMap::new(), counts: HashMap::new() }
    }

    /// Feed one parsed JSON line; returns a fully reassembled frame when this
    /// line completes a chunk group, otherwise `None`.
    fn push(&mut self, value: &Value) -> Option<String> {
        if value.get("type").and_then(Value::as_str) != Some("rpc_chunk") {
            return None;
        }
        let chunk_id = value.get("chunkId").and_then(Value::as_str).unwrap_or("").to_string();
        let index = value.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
        let count = value.get("count").and_then(Value::as_u64).unwrap_or(0) as usize;
        let data = value.get("data").and_then(Value::as_str).unwrap_or("").to_string();
        let entry = self.parts.entry(chunk_id.clone()).or_default();
        if !entry.iter().any(|(i, _)| *i == index) {
            entry.push((index, data));
        }
        self.counts.insert(chunk_id.clone(), count);
        let ready = entry.len() == count && count > 0;
        if !ready {
            return None;
        }
        entry.sort_by_key(|(index, _)| *index);
        let mut frame = String::new();
        for (_, data) in entry.drain(..) {
            frame.push_str(&data);
        }
        self.parts.remove(&chunk_id);
        self.counts.remove(&chunk_id);
        Some(frame)
    }
}

// ---------------------------------------------------------------- the run loop

const OMP_MAX_RPC_FRAME_BYTES: usize = 64 * 1024 * 1024;

#[allow(clippy::too_many_arguments)]
async fn run_omp(
    request: Value,
    _resume: Option<String>,
    sender: mpsc::UnboundedSender<Value>,
    channel: Option<Arc<dyn DaemonChannel>>,
    handle_slot: Arc<Mutex<Option<agenthub_plugin_sdk::process::ProcessHandle>>>,
) -> anyhow::Result<()> {
    let instance = request.get("instance").cloned().unwrap_or(Value::Null);
    let mut env = env_of(&request);
    for (key, value) in std::env::vars() {
        env.entry(key).or_insert(value);
    }

    let permission_mode = request.get("permissionMode").and_then(Value::as_str).unwrap_or("standard");
    let mut args = base_args(&instance);
    args.extend([
        "--mode".to_string(),
        "rpc".to_string(),
        "--no-session".to_string(),
        "--no-title".to_string(),
    ]);
    match permission_mode {
        "read-only" => {
            args.push("--approval-mode".to_string());
            args.push("always-ask".to_string());
            args.push("--tools".to_string());
            args.push("read,grep,find,ls".to_string());
        }
        "isolated" => {
            args.push("--approval-mode".to_string());
            args.push("always-ask".to_string());
            args.push("--no-extensions".to_string());
            args.push("--no-skills".to_string());
            args.push("--no-rules".to_string());
        }
        _ => {
            args.push("--approval-mode".to_string());
            args.push("write".to_string());
        }
    }
    if let Some(cwd) = request.get("cwd").and_then(Value::as_str).filter(|c| !c.is_empty()) {
        args.push("--cwd".to_string());
        args.push(cwd.to_string());
    }
    if let Some(model) = request.get("model").and_then(Value::as_str).filter(|m| !m.is_empty()) {
        args.push("--model".to_string());
        args.push(model.to_string());
    }
    if let Some(effort) = request.get("reasoningEffort").and_then(Value::as_str).filter(|e| !e.is_empty()) {
        args.push("--thinking".to_string());
        args.push(effort.to_string());
    }

    let started = process::start(&ProcessRequest {
        command: executable_of(&instance),
        args,
        cwd: request.get("cwd").and_then(Value::as_str).map(str::to_string),
        env: Some(env),
        timeout_ms: request.get("timeoutMs").and_then(Value::as_u64),
        idle_timeout_ms: request.get("idleTimeoutMs").and_then(Value::as_u64),
        max_output_bytes: request.get("maxOutputBytes").and_then(Value::as_u64).map(|v| v as usize),
        ..Default::default()
    })?;
    let handle = started.handle.clone();
    *handle_slot.lock().unwrap() = Some(handle.clone());

    let runtime_tools: Vec<Value> = request.get("runtimeTools").and_then(Value::as_array).cloned().unwrap_or_default();
    let channel = channel.filter(|_| !runtime_tools.is_empty());

    let mut state = OmpParseState::default();
    let mut settled = false;
    let mut terminal_status = false;
    let mut state_received = false;
    let mut negotiated = false;
    let mut host_tools_sent = false;
    let mut chunk_state = RpcChunkState::new();
    let prompt_sent = Arc::new(std::sync::atomic::AtomicBool::new(false));

    let prompt = request.get("prompt").and_then(Value::as_str).unwrap_or("").to_string();
    let provider_command = request.get("providerCommand").and_then(Value::as_str).map(str::to_string);
    let local_images: Vec<String> = request
        .get("localImagePaths")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect();

    let handle_for_prompt = handle.clone();
    let prompt_sent_flag = prompt_sent.clone();
    let prompt_text = prompt.clone();
    let provider_command_clone = provider_command.clone();
    let local_images_clone = local_images.clone();
    let send_prompt = move || {
        if prompt_sent_flag.swap(true, std::sync::atomic::Ordering::SeqCst) {
            return;
        }
        let mut frame = Map::new();
        frame.insert("id".to_string(), json!("agenthub-prompt"));
        if provider_command_clone.as_deref() == Some("compact") {
            frame.insert("type".to_string(), json!("compact"));
            let custom = regex::Regex::new(r"(?i)^\s*\/?compact\b")
                .map(|re| re.replace(&prompt_text, "").trim().to_string())
                .unwrap_or_else(|_| prompt_text.clone());
            if !custom.is_empty() {
                frame.insert("customInstructions".to_string(), json!(custom));
            }
        } else {
            frame.insert("type".to_string(), json!("prompt"));
            frame.insert("message".to_string(), json!(prompt_text));
            if !local_images_clone.is_empty() {
                let images: Vec<Value> = local_images_clone
                    .iter()
                    .filter_map(|path| {
                        let bytes = std::fs::read(path).ok()?;
                        Some(json!({
                            "type": "image",
                            "data": base64::engine::general_purpose::STANDARD.encode(&bytes),
                            "mimeType": mime_type_of(path)
                        }))
                    })
                    .collect();
                frame.insert("images".to_string(), Value::Array(images));
            }
        }
        handle_for_prompt.write(&format!("{}\n", Value::Object(frame)));
    };

    let _ = sender.send(json!({ "kind": "commands", "commands": native_commands() }));
    let _ = sender.send(json!({ "kind": "status", "phase": "turn_started" }));

    let mut events = started.events;
    let mut buffer = String::new();
    while let Some(event) = events.recv().await {
        match event {
            ProcessEvent::Stdout(text) => {
                buffer.push_str(&text);
                if buffer.len() > OMP_MAX_RPC_FRAME_BYTES {
                    anyhow::bail!("omp RPC frame exceeded {OMP_MAX_RPC_FRAME_BYTES} bytes");
                }
                let mut lines: Vec<String> = buffer.split('\n').map(str::to_string).collect();
                buffer = lines.pop().unwrap_or_default();
                for line in lines {
                    let line = line.trim_end_matches('\r');
                    if line.trim().is_empty() {
                        continue;
                    }
                    if line.len() > OMP_MAX_RPC_FRAME_BYTES {
                        anyhow::bail!("omp RPC frame exceeded {OMP_MAX_RPC_FRAME_BYTES} bytes");
                    }
                    let value: Value = match serde_json::from_str(line) {
                        Ok(value) => value,
                        Err(_) => {
                            let _ = sender.send(json!({ "kind": "raw", "stream": "stderr", "text": format!("Invalid omp RPC output: {line}\n") }));
                            continue;
                        }
                    };
                    // Protocol v2 chunk reassembly: a completed group yields the
                    // logical frame, which we then feed through the same path.
                    if let Some(reassembled) = chunk_state.push(&value) {
                        let value: Value = match serde_json::from_str(&reassembled) {
                            Ok(value) => value,
                            Err(_) => {
                                let _ = sender.send(json!({ "kind": "raw", "stream": "stderr", "text": format!("Invalid omp reassembled RPC frame\n") }));
                                continue;
                            }
                        };
                        if !handle_rpc_value(
                            &value,
                            &mut state,
                            &mut settled,
                            &mut terminal_status,
                            &mut state_received,
                            &mut negotiated,
                            &mut host_tools_sent,
                            &handle,
                            &sender,
                            &channel,
                            &runtime_tools,
                            &send_prompt,
                            &provider_command,
                        )? {
                            return Ok(());
                        }
                        continue;
                    }
                    if !handle_rpc_value(
                        &value,
                        &mut state,
                        &mut settled,
                        &mut terminal_status,
                        &mut state_received,
                        &mut negotiated,
                        &mut host_tools_sent,
                        &handle,
                        &sender,
                        &channel,
                        &runtime_tools,
                        &send_prompt,
                        &provider_command,
                    )? {
                        return Ok(());
                    }
                }
            }
            ProcessEvent::Stderr(text) => {
                let _ = sender.send(json!({ "kind": "raw", "stream": "stderr", "text": text }));
            }
            ProcessEvent::Error(message) => {
                let _ = sender.send(json!({ "kind": "error", "message": message }));
            }
            ProcessEvent::Timeout { reason } => {
                let _ = sender.send(json!({ "kind": "timeout", "reason": reason }));
            }
            ProcessEvent::Exit { exit_code, .. } => {
                let model_failed = state.model_error
                    || state.last_assistant_stop_reason.as_deref() == Some("error")
                    || state.last_assistant_stop_reason.as_deref() == Some("aborted");
                if !terminal_status {
                    let phase = if settled && exit_code == Some(0) && !model_failed { "turn_completed" } else { "turn_failed" };
                    let _ = sender.send(json!({ "kind": "status", "phase": phase }));
                }
                let code = if model_failed && exit_code == Some(0) { Some(1) } else { exit_code };
                let _ = sender.send(json!({ "kind": "exit", "exitCode": code }));
                return Ok(());
            }
        }
    }
    if !state_received && !terminal_status {
        let _ = sender.send(json!({ "kind": "status", "phase": "turn_failed" }));
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn handle_rpc_value(
    value: &Value,
    state: &mut OmpParseState,
    settled: &mut bool,
    terminal_status: &mut bool,
    state_received: &mut bool,
    negotiated: &mut bool,
    host_tools_sent: &mut bool,
    handle: &agenthub_plugin_sdk::process::ProcessHandle,
    sender: &mpsc::UnboundedSender<Value>,
    channel: &Option<Arc<dyn DaemonChannel>>,
    runtime_tools: &[Value],
    send_prompt: &impl Fn(),
    provider_command: &Option<String>,
) -> anyhow::Result<bool> {
    let value_type = value.get("type").and_then(Value::as_str).unwrap_or("");
    match value_type {
        "ready" => {
            if !*negotiated {
                *negotiated = true;
                handle.write(&format!("{}\n", json!({ "id": "agenthub-negotiate", "type": "negotiate_protocol", "protocolVersion": 2 })));
            }
            Ok(true)
        }
        "response" => {
            let is_compact = value.get("id").and_then(Value::as_str) == Some("agenthub-prompt")
                && provider_command.as_deref() == Some("compact");
            if value.get("success").and_then(Value::as_bool) == Some(false) && !is_compact {
                anyhow::bail!(value
                    .get("error")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .unwrap_or_else(|| format!("omp RPC command {} failed", value.get("command").and_then(Value::as_str).unwrap_or("unknown"))));
            }
            if is_compact {
                let error = value.get("error").and_then(Value::as_str);
                let nothing = regex::Regex::new(r"(?i)^(?:Nothing to compact(?: \(session too small\))?|Already compacted)$")
                    .map(|re| error.is_some_and(|e| re.is_match(e)))
                    .unwrap_or(false);
                if error.is_some() && !nothing {
                    anyhow::bail!(error.unwrap_or("omp compact command failed").to_string());
                }
                let _ = sender.send(json!({
                    "kind": "message",
                    "phase": "completed",
                    "messageId": "omp-compact",
                    "text": if nothing { "当前 omp 会话没有可压缩的旧内容，无需压缩。" } else { "omp 会话压缩完成。" },
                    "raw": value
                }));
                *settled = true;
                if !*terminal_status {
                    let _ = sender.send(json!({ "kind": "status", "phase": "turn_completed", "raw": value }));
                    *terminal_status = true;
                }
                handle.end_stdin();
                let terminate = handle.clone();
                tokio::spawn(async move { terminate.cancel().await; });
                // Keep the event loop running: the process kill will surface as
                // ProcessEvent::Exit, which emits the final `exit` event.
                return Ok(true);
            }
            match value.get("id").and_then(Value::as_str) {
                Some("agenthub-negotiate") => {
                    handle.write(&format!("{}\n", json!({ "id": "agenthub-state", "type": "get_state" })));
                }
                Some("agenthub-state") => {
                    *state_received = true;
                    let session_id = value
                        .get("data")
                        .and_then(|d| d.get("sessionId"))
                        .and_then(Value::as_str)
                        .map(str::to_string);
                    if let Some(session_id) = session_id {
                        let _ = sender.send(json!({ "kind": "session", "providerSessionId": session_id, "raw": value }));
                    }
                    if !runtime_tools.is_empty() && channel.is_some() {
                        *host_tools_sent = true;
                        let tools: Vec<Value> = runtime_tools
                            .iter()
                            .map(|tool| {
                                let name = tool.get("name").and_then(Value::as_str).unwrap_or("tool");
                                let name = name.strip_prefix("agenthub.").or_else(|| name.strip_prefix("agenthub_")).unwrap_or(name);
                                json!({
                                    "name": name,
                                    "description": tool.get("description").and_then(Value::as_str).unwrap_or(""),
                                    "parameters": tool.get("inputSchema").cloned()
                                        .unwrap_or_else(|| json!({ "type": "object", "properties": {} })),
                                    "loadMode": "eager"
                                })
                            })
                            .collect();
                        handle.write(&format!("{}\n", json!({ "id": "agenthub-tools", "type": "set_host_tools", "tools": tools })));
                    } else {
                        send_prompt();
                    }
                }
                Some("agenthub-tools") => {
                    send_prompt();
                }
                _ => {}
            }
            Ok(true)
        }
        "host_tool_call" => {
            let id = value.get("id").cloned().unwrap_or(Value::Null);
            let name = value.get("toolName").and_then(Value::as_str).unwrap_or("tool").to_string();
            let arguments = value.get("arguments").cloned().unwrap_or_else(|| json!({}));
            if let (Some(channel), Some(id_str)) = (channel, id.as_str()) {
                let run_id = String::new();
                let result = tokio::runtime::Handle::current().block_on(channel.call_tool(&run_id, &name, arguments));
                let success = result.get("success").and_then(Value::as_bool).unwrap_or(false);
                let content = result.get("content").and_then(Value::as_str).unwrap_or("").to_string();
                handle.write(&format!(
                    "{}\n",
                    json!({
                        "type": "host_tool_result",
                        "id": id_str,
                        "result": { "content": [{ "type": "text", "text": content }], "isError": !success },
                        "isError": !success
                    })
                ));
            } else {
                // No runtime channel: fail the tool so the model adapts.
                let id_str = id.as_str().unwrap_or("").to_string();
                handle.write(&format!(
                    "{}\n",
                    json!({
                        "type": "host_tool_result",
                        "id": id_str,
                        "result": { "content": [{ "type": "text", "text": "host tool execution unavailable" }], "isError": true },
                        "isError": true
                    })
                ));
            }
            Ok(true)
        }
        "host_tool_cancel" => Ok(true),
        "host_tool_update" => Ok(true),
        "extension_ui_request" => {
            let method = value.get("method").and_then(Value::as_str).unwrap_or("");
            if ["notify", "setStatus", "setWidget", "setTitle", "set_editor_text"].contains(&method) {
                let text = value
                    .get("message")
                    .and_then(Value::as_str)
                    .or_else(|| value.get("statusText").and_then(Value::as_str))
                    .or_else(|| value.get("title").and_then(Value::as_str));
                if let Some(text) = text {
                    let stream = if value.get("notifyType").and_then(Value::as_str) == Some("error") { "stderr" } else { "stdout" };
                    let _ = sender.send(json!({ "kind": "raw", "stream": stream, "text": format!("{text}\n") }));
                }
                return Ok(true);
            }
            let id = value.get("id").cloned().unwrap_or(Value::Null);
            handle.write(&format!("{}\n", json!({ "type": "extension_ui_response", "id": id, "cancelled": true })));
            Ok(true)
        }
        "agent_end" => {
            // agent_end.isTerminal === false means an async delivery will resume
            // the session; only settle when the turn is terminal.
            let is_terminal = value.get("isTerminal").and_then(Value::as_bool).unwrap_or(true);
            if !is_terminal {
                return Ok(true);
            }
            *settled = true;
            let failed = state.model_error
                || state.last_assistant_stop_reason.as_deref() == Some("error")
                || state.last_assistant_stop_reason.as_deref() == Some("aborted");
            if !*terminal_status {
                let _ = sender.send(json!({ "kind": "status", "phase": if failed { "turn_failed" } else { "turn_completed" }, "raw": value }));
                *terminal_status = true;
            }
            handle.end_stdin();
            let terminate = handle.clone();
            tokio::spawn(async move { terminate.cancel().await; });
            Ok(true)
        }
        _ => {
            for event in parse_omp_rpc_event(value, state) {
                if sender.send(event).is_err() {
                    return Ok(false);
                }
            }
            Ok(true)
        }
    }
}

#[tokio::main]
async fn main() {
    agenthub_plugin_sdk::serve(OmpPlugin::new()).await;
}
