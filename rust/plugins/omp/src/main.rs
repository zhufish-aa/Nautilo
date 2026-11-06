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
            "OMP_AUTH_BROKER_URL", "OMP_AUTH_BROKER_TOKEN", "PI_CODING_AGENT_DIR",
            "PI_CONFIG_DIR", "PI_CONFIG_FILES", "OMP_PROFILE", "PI_PROFILE"
        ],
        "permissionModes": [
            { "value": "standard", "name": { "zh-CN": "标准", "en-US": "Standard" },
              "description": { "zh-CN": "加载项目级 omp 资源并沿用 omp 的工具配置", "en-US": "Load project-local omp resources and keep omp's configured tools" } },
            { "value": "auto", "name": { "zh-CN": "免审批", "en-US": "Auto-approve" },
              "description": { "zh-CN": "完全免审批：所有工具调用自动放行（omp yolo 模式）", "en-US": "No approvals: every tool call runs without prompting (omp yolo mode)" } },
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
        "contextWindowDiscovery": true,
        "nativeContextVersion": "persistent-session-v1"
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

use agenthub_plugin_sdk::session_pool::{SessionPool, ResidentProcess, TurnBudget};

struct OmpPlugin {
    pool: SessionPool<OmpResident>,
    channel: Mutex<Option<Arc<dyn DaemonChannel>>>,
    runs: Arc<Mutex<HashMap<String, agenthub_plugin_sdk::process::ProcessHandle>>>,
}
#[cfg(test)] #[path="../../../../tests/fixtures/native_session_checks.rs"] mod native_session_checks;
#[cfg(test)] #[tokio::test] async fn native_resident_conformance(){native_session_checks::exercise(&OmpPlugin::new(),"omp").await;}

impl OmpPlugin {
    fn new() -> Self {
        Self {
            pool: Default::default(),
            channel: Mutex::new(None),
            runs: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

#[async_trait::async_trait]
impl ProviderPlugin for OmpPlugin {
    fn native_terminal_supported(&self)->bool {true}
    async fn release_session(&self,request:&Value)->anyhow::Result<()> {if let Some(native)=self.pool.retire(request["localSessionId"].as_str().unwrap_or("")){native.close().await;}Ok(())}
    async fn terminal_plan(&self,request:&Value,resume:Option<String>)->anyhow::Result<Value> {
        let mut plan=prepare_omp(request,&resume,"terminal")?;
        if let Some(index)=plan.args.windows(2).position(|args|args==["--mode","rpc"]){plan.args.drain(index..index+2);}
        Ok(json!({"command":plan.command,"args":plan.args,"env":plan.env}))
    }
    fn descriptor(&self) -> Value {
        descriptor()
    }

    fn capabilities(&self) -> Value {
        json!({
            "structuredOutput": false,
            "textOutput": true,
            "interactiveStdin": true,
            "sessionBackgroundEvents": true,
            "nativeResume": true,
            "pty": false
        })
    }

    fn set_daemon_channel(&self, channel: Arc<dyn DaemonChannel>) {
        *self.channel.lock().unwrap() = Some(channel);
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

    async fn start(&self, run_id: &str, request: Value, resume: Option<String>) -> anyhow::Result<mpsc::UnboundedReceiver<Value>> {
        let (sender, receiver) = mpsc::unbounded_channel::<Value>();
        let channel = self.channel.lock().unwrap().clone();
        let run_handle_slot = Arc::new(Mutex::new(None::<agenthub_plugin_sdk::process::ProcessHandle>));
        let slot = run_handle_slot.clone();
        let runs = self.runs.clone();
        let pool = self.pool.clone();
        let run_id = run_id.to_string();
        tokio::spawn(async move {
            let result = run_omp(&run_id, request, resume, sender.clone(), channel, slot, runs, pool).await;
            if let Err(error) = result {
                let _ = sender.send(json!({ "kind": "error", "message": error.to_string() }));
                let _ = sender.send(json!({ "kind": "exit", "exitCode": 1 }));
            }
        });
        let _ = run_handle_slot;
        Ok(receiver)
    }

    async fn dispose(&self) { for native in self.pool.drain() { native.close().await; } }

    async fn cancel(&self, run_id: &str) {
        // Kill the child process tree: a stale omp keeps the session locked
        // and the next run resuming it stalls silently.
        let handle = self.runs.lock().unwrap().remove(run_id);
        if let Some(handle) = handle {
            handle.cancel().await;
        }
    }
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
    children: HashMap<String, OmpChildState>,
    pending_children: HashMap<String, Vec<Value>>,
    usage: agenthub_plugin_sdk::usage::TurnUsage,
    message_sequence: u32,
    current_message_id: Option<String>,
    current_thinking_id: Option<String>,
    streamed_text: bool,
    streamed_thinking: bool,
    last_assistant_stop_reason: Option<String>,
    model_error: bool,
    tool_args: HashMap<String, (String, Value)>,
}

struct OmpChildState {
    state: Box<OmpParseState>,
    dispatch_id: String,
    agent: String,
    description: String,
    status: String,
}

fn child_activity(value: &Value, state: &mut OmpParseState) -> Vec<Value> {
    let payload = &value["payload"];
    let Some(id) = payload["id"].as_str() else { return vec![] };
    if value["type"] == "subagent_event" {
        let Some(child) = state.children.get_mut(id) else {
            state.pending_children.entry(id.to_string()).or_default().push(value.clone());
            return vec![];
        };
        return parse_omp_rpc_event(&payload["event"], &mut child.state).into_iter().filter_map(|mut event| {
            if !["message", "thinking", "tool", "command"].contains(&event["kind"].as_str().unwrap_or("")) { return None; }
            event["subagentDispatchId"] = json!(child.dispatch_id);
            for key in ["messageId", "callId"] {
                if let Some(value) = event[key].as_str() { event[key] = json!(format!("{id}:{value}")); }
            }
            Some(event)
        }).collect();
    }
    let dispatch = payload["parentToolCallId"].as_str().map(str::to_string).unwrap_or_else(|| format!("omp-native:{id}"));
    let child = state.children.entry(id.to_string()).or_insert_with(|| OmpChildState {
        state:Box::default(), dispatch_id:dispatch.clone(), agent:String::new(), description:String::new(), status:String::new()
    });
    child.agent = payload["agent"].as_str().unwrap_or("Agent").to_string();
    child.description = payload["description"].as_str().unwrap_or(&child.agent).to_string();
    child.status = payload["status"].as_str().unwrap_or("started").to_string();
    let mut input = state.tool_args.get(&dispatch).map(|(_, args)| args.clone())
        .unwrap_or_else(|| json!({"agent":child.agent,"description":child.description}));
    let ids: Vec<_> = state.children.iter().filter(|(_, child)| child.dispatch_id == dispatch).map(|(id,_)| id.clone()).collect();
    let states: serde_json::Map<String, Value> = ids.iter().map(|id| {
        let child = &state.children[id];
        (id.clone(), json!({"status": if child.status == "aborted" {"failed"} else {child.status.as_str()}}))
    }).collect();
    input["receiverThreadIds"] = json!(ids);
    input["agentsStates"] = Value::Object(states);
    let stored = state.tool_args.get(&dispatch);
    let name = stored.map(|(name,_)| name.as_str()).unwrap_or("subagent");
    let synthetic = stored.is_none();
    let completed = ids.iter().all(|id| state.children[id].status != "started");
    let success = ids.iter().all(|id| state.children[id].status == "completed");
    let mut events = vec![json!({"kind":"tool","callId":dispatch,"name":name,"input":input,
        "phase":if synthetic && completed {"completed"} else if synthetic {"started"} else {"updated"},
        "success":if completed {json!(success)} else {Value::Null},"raw":value})];
    for pending in state.pending_children.remove(id).unwrap_or_default() { events.extend(child_activity(&pending, state)); }
    events
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
        "subagent_lifecycle" | "subagent_event" => child_activity(value, state),
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
            let thinking: String = content
                    .iter()
                    .filter(|part| part.get("type").and_then(Value::as_str) == Some("thinking"))
                    .filter_map(|part| part.get("thinking").and_then(Value::as_str))
                    .collect();
            if !state.streamed_thinking {
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
                    "text": thinking,
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
                    "usageScope": "context",
                    "inputTokensIncludesCache": false,
                    "inputTokens": usage.get("input").cloned().unwrap_or(Value::Null),
                    "cachedInputTokens": usage.get("cacheRead").cloned().unwrap_or(Value::Null),
                    "cacheCreationInputTokens": usage.get("cacheWrite").cloned().unwrap_or(Value::Null),
                    "outputTokens": usage.get("output").cloned().unwrap_or(Value::Null),
                    "reasoningOutputTokens": usage.get("reasoning").cloned().unwrap_or(Value::Null),
                    "contextUsed": (["input", "cacheRead", "cacheWrite"].iter()
                        .filter_map(|key| usage.get(key).and_then(Value::as_u64)).reduce(|a, b| a + b)),
                    "raw": value
                }));
            }
            if let Some(usage) = events.iter().find(|event| event["kind"] == "usage").cloned() {
                events.push(state.usage.update(&state.message_sequence.to_string(), &usage));
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
        "tool_execution_update" => {
            let call_id = value["toolCallId"].as_str().unwrap_or("");
            let stored = state.tool_args.get(call_id);
            let name = value["toolName"].as_str().or_else(|| stored.map(|(name, _)| name.as_str())).unwrap_or("tool");
            let args = value.get("args").or_else(|| stored.map(|(_, args)| args)).unwrap_or(&Value::Null);
            let output = tool_result_text(&value["partialResult"]);
            if name == "bash" {
                vec![json!({"kind":"command","callId":call_id,"command":args["command"],"phase":"updated","output":output,"raw":value})]
            } else {
                vec![json!({"kind":"tool","callId":call_id,"name":name,"phase":"updated","input":args,"output":output,"raw":value})]
            }
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

fn prepare_omp(request: &Value, resume: &Option<String>, run_id: &str) -> anyhow::Result<ProcessRequest> {
    let instance = request.get("instance").cloned().unwrap_or(Value::Null);
    let mut env = env_of(&request);
    if instance.pointer("/providerOptions/runtimeConnectionId").is_none() {
        for (key, value) in std::env::vars() { env.entry(key).or_insert(value); }
    }

    let permission_mode = request.get("permissionMode").and_then(Value::as_str).unwrap_or("standard");
    env = agenthub_plugin_sdk::connection::prepare_request(&request, env)?;
    let mut args = base_args(&instance);
    args.extend([
        "--mode".to_string(),
        "rpc".to_string(),
    ]);
    if let Some(extension) = env.get("NAUTILO_OMP_PROVIDER_EXTENSION") {
        args.extend(["--extension".into(), extension.clone()]);
    }
    if request["mcpServers"].as_array().is_some_and(|v|!v.is_empty()) || request["skills"].as_array().is_some_and(|v|!v.is_empty()) {
        let resources = agenthub_plugin_sdk::native_config::runtime_package(&request, "omp")?;
        args.extend(["--extension".into(), resources.to_string_lossy().into_owned()]);
    }
    // Every Nautilo conversation has its own native session directory. Never
    // continue another conversation from the CLI's global most-recent session.
    let local_id=request["localSessionId"].as_str().unwrap_or(run_id);
    anyhow::ensure!(!local_id.is_empty() && local_id.chars().all(|c|c.is_ascii_alphanumeric() || c=='-' || c=='_'),"Invalid local session identity");
    let session_root=env.get("NAUTILO_OMP_SESSION_ROOT").or_else(||env.get("PI_CODING_AGENT_DIR")).map(std::path::PathBuf::from)
        .unwrap_or_else(||env.get("USERPROFILE").or_else(||env.get("HOME")).map(std::path::PathBuf::from).unwrap_or_else(std::env::temp_dir).join(".omp/agent"));
    let sessions=session_root.join("nautilo-sessions").join(local_id);
    std::fs::create_dir_all(&sessions)?;
    args.extend(["--session-dir".into(),sessions.to_string_lossy().into_owned()]);
    if resume.is_some(){args.extend(["--resume".into(),resume.as_deref().unwrap().to_string()]);}
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
        "auto" => {
            args.push("--approval-mode".to_string());
            args.push("yolo".to_string());
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
        args.push(if instance.pointer("/providerOptions/runtimeConnectionId").is_some() { format!("nautilo/{model}") } else { model.to_string() });
    }
    if let Some(effort) = request.get("reasoningEffort").and_then(Value::as_str).filter(|e| !e.is_empty()) {
        args.push("--thinking".to_string());
        args.push(effort.to_string());
    }

    Ok(ProcessRequest {
        command: executable_of(&instance),
        args,
        cwd: request.get("cwd").and_then(Value::as_str).map(str::to_string),
        env: Some(env),
        timeout_ms: None,
        idle_timeout_ms: None,
        max_output_bytes: None,
        ..Default::default()
    })
}
struct OmpResident {
    runtime: ResidentProcess,
    state: Arc<Mutex<OmpParseState>>,
    chunks: Arc<Mutex<RpcChunkState>>,
}
impl std::ops::Deref for OmpResident {type Target=ResidentProcess;fn deref(&self)->&Self::Target {&self.runtime}}
impl std::ops::DerefMut for OmpResident {fn deref_mut(&mut self)->&mut Self::Target {&mut self.runtime}}
impl OmpResident {async fn close(self){self.runtime.close().await;}}
async fn open_omp(request:&Value,resume:&Option<String>,run_id:&str)->anyhow::Result<OmpResident>{Ok(OmpResident {
    runtime:ResidentProcess::new(process::start(&prepare_omp(request,resume,run_id)?)?),state:Arc::new(Mutex::new(OmpParseState::default())),chunks:Arc::new(Mutex::new(RpcChunkState::new()))
})}

#[allow(clippy::too_many_arguments)]
async fn run_omp(
    run_id: &str,
    request: Value,
    resume: Option<String>,
    sender: mpsc::UnboundedSender<Value>,
    channel: Option<Arc<dyn DaemonChannel>>,
    handle_slot: Arc<Mutex<Option<agenthub_plugin_sdk::process::ProcessHandle>>>,
    runs: Arc<Mutex<HashMap<String, agenthub_plugin_sdk::process::ProcessHandle>>>,
    pool: SessionPool<OmpResident>,
) -> anyhow::Result<()> {
    let local_images: Vec<Value> = agenthub_plugin_sdk::images::read_request_images(&request)?
        .into_iter().map(|image| json!({"type":"image", "mimeType":image.mime_type,
            "data":base64::engine::general_purpose::STANDARD.encode(image.bytes)})).collect();
    let identity = agenthub_plugin_sdk::session_pool::identity(&request);
    let key = request["localSessionId"].as_str().or(resume.as_deref()).unwrap_or(run_id).to_string();
    let attached=std::time::Instant::now();
    let cached = pool.take(&key);
    let mut reused = false;
    let mut native = if let Some((previous,cached)) = cached {
        if resume.is_some() && cached.session_id==resume && previous == identity && cached.process.as_ref().is_some_and(|process|process.handle.is_alive()) {reused=true; cached}
        else {cached.close().await; open_omp(&request,&resume,run_id).await?}
    } else {open_omp(&request,&resume,run_id).await?};
    let parse_state=native.state.clone();let chunks=native.chunks.clone();
    let native_session_id=native.session_id.clone();
    let started = native.process.as_mut().unwrap();
    started.events.pause().await;
    let handle = started.handle.clone();
    *handle_slot.lock().unwrap() = Some(handle.clone());
    runs.lock().unwrap().insert(run_id.to_string(), handle.clone());
    let _=sender.send(json!({"kind":"status","phase":"runtime_ready","raw":{"providerId":"omp","transport":"rpc","reused":reused,"pid":handle.pid,"attachMs":attached.elapsed().as_millis()}}));

    let runtime_tools: Vec<Value> = request.get("runtimeTools").and_then(Value::as_array).cloned().unwrap_or_default();
    // Keep the channel for extension UI interactions (approval prompts); host
    // tool calls are gated on runtime_tools at the call site below.

    let mut native_session_id=native_session_id;
    {let mut state=parse_state.lock().unwrap();state.model_error=false;state.last_assistant_stop_reason=None;}
    let mut settled = false;
    let mut terminal_status = false;
    let mut state_received = false;
    let mut negotiated = reused;
    let mut host_tools_sent = false;
    let prompt_sent = Arc::new(std::sync::atomic::AtomicBool::new(false));

    let prompt = request.get("prompt").and_then(Value::as_str).unwrap_or("").to_string();
    let provider_command = request.get("providerCommand").and_then(Value::as_str).map(str::to_string);
    let prompt_id=format!("agenthub-prompt:{run_id}");

    let handle_for_prompt = handle.clone();
    let prompt_sent_flag = prompt_sent.clone();
    let prompt_text = prompt.clone();
    let provider_command_clone = provider_command.clone();
    let local_images_clone = local_images.clone();
    let request_id=prompt_id.clone();
    let send_prompt = move || {
        if prompt_sent_flag.swap(true, std::sync::atomic::Ordering::SeqCst) {
            return;
        }
        let mut frame = Map::new();
        frame.insert("id".to_string(), json!(request_id));
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
                frame.insert("images".to_string(), json!(local_images_clone));
            }
        }
        handle_for_prompt.write(&format!("{}\n", Value::Object(frame)));
    };

    let _ = sender.send(json!({ "kind": "commands", "commands": native_commands() }));
    let _ = sender.send(json!({ "kind": "status", "phase": "turn_started" }));

    if reused {handle.write("{\"id\":\"agenthub-state\",\"type\":\"get_state\"}\n");}
    let mut budget = TurnBudget::new(&request);
    let events = &mut started.events;
    let mut buffer = String::new();
    let result: anyhow::Result<()> = async {
    'turn: while let Some(event) = budget.recv(events).await {
        match event {
            ProcessEvent::Stdout(text) => {
                buffer.push_str(&text);
                if buffer.len() > OMP_MAX_RPC_FRAME_BYTES {
                    anyhow::bail!("omp RPC frame exceeded {OMP_MAX_RPC_FRAME_BYTES} bytes");
                }
                while let Some(end)=buffer.find('\n') {
                    let line:String=buffer.drain(..=end).collect();
                    let line = line.trim_end_matches(['\r','\n']);
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
                    if let Some(reassembled) = chunks.lock().unwrap().push(&value) {
                        let value: Value = match serde_json::from_str(&reassembled) {
                            Ok(value) => value,
                            Err(_) => {
                                let _ = sender.send(json!({ "kind": "raw", "stream": "stderr", "text": format!("Invalid omp reassembled RPC frame\n") }));
                                continue;
                            }
                        };
                        if value["id"]=="agenthub-state" {native_session_id=value["data"]["sessionId"].as_str().map(str::to_string);}
                        if !handle_rpc_value(
                            run_id,
                            &value,
                            &mut parse_state.lock().unwrap(),
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
                            &prompt_id,
                        )? {
                            anyhow::bail!("omp event consumer closed");
                        }
                        if settled {break 'turn;}
                        continue;
                    }
                    if value["id"]=="agenthub-state" {native_session_id=value["data"]["sessionId"].as_str().map(str::to_string);}
                    if !handle_rpc_value(
                        run_id,
                        &value,
                        &mut parse_state.lock().unwrap(),
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
                        &prompt_id,
                    )? {
                        anyhow::bail!("omp event consumer closed");
                    }
                    if settled {break 'turn;}
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
                anyhow::bail!("omp turn exceeded {reason} limit");
            }
            ProcessEvent::Exit { exit_code, .. } => {
                let model_failed = {let state=parse_state.lock().unwrap();state.model_error || matches!(state.last_assistant_stop_reason.as_deref(),Some("error"|"aborted"))};
                if !terminal_status {
                    let phase = if settled && exit_code == Some(0) && !model_failed { "turn_completed" } else { "turn_failed" };
                    let _ = sender.send(json!({ "kind": "status", "phase": phase }));
                }
                let code = if model_failed && exit_code == Some(0) { Some(1) } else { exit_code };
                anyhow::ensure!(settled && code==Some(0),"omp exited before a successful native turn boundary");
                break;
            }
        }
    }
    anyhow::ensure!(settled,"omp event stream ended before the turn settled");
    Ok(())
    }.await;
    native.session_id=native_session_id;
    let failed={let state=parse_state.lock().unwrap();state.model_error || matches!(state.last_assistant_stop_reason.as_deref(),Some("error"|"aborted"))};
    runs.lock().unwrap().remove(run_id);
    if result.is_ok() && !failed && handle.is_alive() && !sender.is_closed() {
        if let (Some(host),Some(binding))=(&channel,request["sessionBindingId"].as_str()) {
            let idle_channel=agenthub_plugin_sdk::session_channel(&channel,&request);
            let sink=agenthub_plugin_sdk::session_sink(host.clone(),binding.into()).await;
            let idle_handle=handle.clone();let idle_run=run_id.to_string();
            native.process.as_ref().unwrap().events.observe_idle_with_pending(Arc::new(move |event| {
                match event {
                    ProcessEvent::Stdout(text)=>{
                        let value=serde_json::from_str::<Value>(text.trim()).ok().and_then(|value| {
                            if value["type"]=="rpc_chunk" {chunks.lock().unwrap().push(&value).and_then(|frame|serde_json::from_str(&frame).ok())} else {Some(value)}
                        });
                        if let Some(value)=value {
                            let(mut settled,mut terminal,mut state_received,mut negotiated,mut tools_sent)=(false,false,true,true,true);
                            let _=handle_rpc_value(&idle_run,&value,&mut parse_state.lock().unwrap(),&mut settled,&mut terminal,&mut state_received,&mut negotiated,&mut tools_sent,&idle_handle,&sink,&idle_channel,&runtime_tools,&||{},&None,"background");
                        }
                    },
                    ProcessEvent::Stderr(text)=>{let _=sink.send(json!({"kind":"raw","stream":"stderr","text":text}));},
                    ProcessEvent::Error(message)=>{let _=sink.send(json!({"kind":"error","message":message}));},
                    ProcessEvent::Exit{exit_code,signal}=>{let _=sink.send(json!({"kind":"exit","exitCode":exit_code,"signal":signal}));},
                    ProcessEvent::Timeout{reason}=>{let _=sink.send(json!({"kind":"timeout","reason":reason}));}
                }
            }),buffer);
        }
        pool.put(key,identity,native);
    }
    else {native.close().await;}
    result?;
    let _=sender.send(json!({"kind":"exit","exitCode":if failed {1}else{0}}));
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn handle_rpc_value(
    run_id: &str,
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
    prompt_id:&str,
) -> anyhow::Result<bool> {
    let value_type = value.get("type").and_then(Value::as_str).unwrap_or("");
    match value_type {
        "ready" => {
            let _=sender.send(json!({"kind":"status","phase":"runtime_capabilities","raw":{"providerId":"omp","source":"native-handshake","transport":"rpc","protocolVersion":value["protocolVersion"],"reported":{"supportedProtocolVersions":value["supportedProtocolVersions"]}}}));
            if !*negotiated {
                *negotiated = true;
                handle.write(&format!("{}\n", json!({ "id": "agenthub-negotiate", "type": "negotiate_protocol", "protocolVersion": 2 })));
            }
            Ok(true)
        }
        "response" => {
            if value["id"] == "agenthub-subagents" && value["success"] == false {
                let _ = sender.send(json!({"kind":"raw","stream":"stderr","text":"This omp version does not expose native subagent events.\n"}));
                return Ok(true);
            }
            if value["id"]=="agenthub-commands" || value["id"]=="agenthub-subagents" {
                if value["success"]==false {let _=sender.send(json!({"kind":"raw","stream":"stderr","text":format!("Optional native command unavailable: {}",value["command"])}));return Ok(true);}
            }
            if value["id"]=="agenthub-commands" {let _=sender.send(json!({"kind":"commands","commands":value["data"]["commands"],"raw":value}));return Ok(true);}
            if value["id"]==prompt_id && value["success"]!=false && value["data"]["agentInvoked"]==false {
                *settled=true;*terminal_status=true;let _=sender.send(json!({"kind":"message","phase":"completed","messageId":"omp-native-command","text":""}));let _=sender.send(json!({"kind":"status","phase":"turn_completed"}));return Ok(true);
            }
            let is_compact = value.get("id").and_then(Value::as_str) == Some(prompt_id)
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

                // Keep the event loop running: the process kill will surface as
                // ProcessEvent::Exit, which emits the final `exit` event.
                return Ok(true);
            }
            match value.get("id").and_then(Value::as_str) {
                Some("agenthub-negotiate") => {
                    handle.write(&format!("{}\n", json!({"id":"agenthub-subagents","type":"set_subagent_subscription","level":"events"})));
                    handle.write(&format!("{}\n", json!({ "id": "agenthub-state", "type": "get_state" })));
                }
                Some("agenthub-state") => {
                    handle.write("{\"id\":\"agenthub-commands\",\"type\":\"get_available_commands\"}\n");
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
        "available_commands_update" => {let _=sender.send(json!({"kind":"commands","commands":value["commands"],"raw":value}));Ok(true)},
        "command_output" => {let _=sender.send(json!({"kind":"message","messageId":"omp-native-command","phase":"delta","text":value["text"].as_str().unwrap_or(""),"raw":value}));Ok(true)},
        "prompt_result" if value["id"]==prompt_id && value["agentInvoked"]==false => {
            *settled=true;*terminal_status=true;let _=sender.send(json!({"kind":"message","phase":"completed","messageId":"omp-native-command","text":""}));let _=sender.send(json!({"kind":"status","phase":"turn_completed"}));Ok(true)
        },
        "host_tool_call" => {
            let id = value.get("id").cloned().unwrap_or(Value::Null);
            let name = value.get("toolName").and_then(Value::as_str).unwrap_or("tool").to_string();
            let arguments = value.get("arguments").cloned().unwrap_or_else(|| json!({}));
            if let (Some(channel), Some(id_str)) = (channel.as_ref().filter(|_| !runtime_tools.is_empty()), id.as_str()) {
                let channel=channel.clone(); let handle=handle.clone(); let run_id=run_id.to_string(); let id_str=id_str.to_string();
                tokio::spawn(async move {
                let result = channel.call_tool(&run_id, &name, arguments).await;
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
                });
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
            agenthub_plugin_sdk::extension_ui::dispatch(value, handle, sender, channel, run_id);
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
#[cfg(test)]
mod audit_tests {
    use super::*;
    #[test]
    fn tool_progress_reuses_the_call_and_does_not_finish_it() {
        let mut state = OmpParseState::default();
        parse_omp_rpc_event(&json!({"type":"tool_execution_start","toolCallId":"read-1","toolName":"read","args":{"path":"file"}}),&mut state);
        let progress=parse_omp_rpc_event(&json!({"type":"tool_execution_update","toolCallId":"read-1","partialResult":{"content":[{"type":"text","text":"working"}]}}),&mut state);
        assert_eq!(progress[0]["callId"],"read-1");
        assert_eq!(progress[0]["name"],"read");
        assert_eq!(progress[0]["phase"],"updated");
        assert_eq!(progress[0]["output"],"working");
        assert!(progress[0].get("success").is_none());
    }
    #[test]
    fn native_child_events_keep_parent_dispatch_and_separate_state() {
        let mut state = OmpParseState::default();
        parse_omp_rpc_event(&json!({"type":"tool_execution_start","toolCallId":"parent","toolName":"task","args":{"agent":"scout","task":"inspect"}}),&mut state);
        let lifecycle = parse_omp_rpc_event(&json!({"type":"subagent_lifecycle","payload":{"id":"child","parentToolCallId":"parent","agent":"scout","status":"started"}}),&mut state);
        assert_eq!(lifecycle[0]["callId"],"parent");
        assert_eq!(lifecycle[0]["phase"],"updated");
        parse_omp_rpc_event(&json!({"type":"subagent_event","payload":{"id":"child","event":{"type":"message_start","message":{"role":"assistant"}}}}),&mut state);
        let delta=parse_omp_rpc_event(&json!({"type":"subagent_event","payload":{"id":"child","event":{"type":"message_update","assistantMessageEvent":{"type":"thinking_delta","delta":"child thought"}}}}),&mut state);
        assert_eq!(delta[0]["subagentDispatchId"],"parent");
        assert!(delta[0]["messageId"].as_str().unwrap().starts_with("child:"));
        assert_eq!(state.message_sequence,0);
        let completed=parse_omp_rpc_event(&json!({"type":"subagent_lifecycle","payload":{"id":"child","parentToolCallId":"parent","agent":"scout","status":"completed"}}),&mut state);
        assert_eq!(completed[0]["input"]["agentsStates"]["child"]["status"],"completed");
    }
    #[test]
    fn request_usage_keeps_cache_creation_and_correct_context_size() {
        let mut state = OmpParseState::default();
        let events = parse_omp_rpc_event(&json!({"type":"message_end","message":{"role":"assistant","content":[],
            "usage":{"input":10,"output":7,"cacheRead":20,"cacheWrite":5,"totalTokens":42}}}), &mut state);
        let usage = events.iter().find(|e| e["kind"] == "usage").unwrap();
        assert_eq!(usage["cacheCreationInputTokens"], 5);
        assert_eq!(usage["contextUsed"], 35);
        assert_eq!(usage["usageScope"], "context");
        assert_eq!(usage["inputTokensIncludesCache"], false);
    }
}
