//! Claude Code adapter — port of adapters/claude/*.
//! Spawns `claude -p --output-format stream-json --verbose` and parses the
//! event stream, with the runtime MCP bridge for tools/permission prompts.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::{json, Map, Value};

use crate::adapters::{
    normalize_json, stream_events, AdapterDetectionResult, AdapterEvent, AdapterResumeRequest, AdapterRun,
    AdapterStartRequest, AgentCliAdapter,
};
use crate::errors::CoreResult;
use crate::process_runtime::{ProcessRequest, ProcessRuntime};
use crate::adapters::runtime_mcp_bridge::{start_runtime_mcp_bridge, PERMISSION_PROMPT_TOOL_NAME};

pub mod models;

pub const CLAUDE_RUNTIME_MCP_SERVER: &str = "agenthub";
const CLAUDE_PERMISSION_MODES: [&str; 6] = ["default", "acceptEdits", "plan", "bypassPermissions", "auto", "dontAsk"];
const CLAUDE_ENV_OVERRIDE_KEYS: [&str; 3] = ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"];

fn text_of(value: &Value) -> Option<String> {
    value.as_str().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)
}

fn number_of(value: &Value) -> Option<i64> {
    value.as_i64().or_else(|| value.as_f64().map(|f| f as i64))
}

fn resolve_permission_mode(instance: &Value, request: Option<&AdapterStartRequest>) -> Option<String> {
    let normalize = |value: Option<&str>| value.map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);
    normalize(request.and_then(|r| r.permission_mode.as_deref())).or_else(|| {
        normalize(instance.get("providerOptions").and_then(|o| o.get("permissionMode")).and_then(Value::as_str))
    })
}

fn claude_permission_args(instance: &Value, request: Option<&AdapterStartRequest>) -> Vec<String> {
    match resolve_permission_mode(instance, request) {
        Some(mode) if CLAUDE_PERMISSION_MODES.contains(&mode.as_str()) => vec!["--permission-mode".to_string(), mode],
        _ => vec![],
    }
}

fn model_args(request: Option<&AdapterStartRequest>) -> Vec<String> {
    // "default" is a Nautilo catalog entry meaning "whatever the CLI is configured with".
    match request.and_then(|r| r.model.as_deref()) {
        Some(model) if model != "default" => vec!["--model".to_string(), model.to_string()],
        _ => vec![],
    }
}

fn effort_args(request: Option<&AdapterStartRequest>) -> Vec<String> {
    match request.and_then(|r| r.reasoning_effort.as_deref()) {
        Some(effort) if models::CLAUDE_EFFORT_LEVELS.contains(&effort) => vec!["--effort".to_string(), effort.to_string()],
        _ => vec![],
    }
}

/// ~/.claude/settings.json `env` wins over the inherited process environment,
/// so deliberately configured values would silently lose. CLI --settings has
/// higher precedence and merges per-key.
fn claude_settings_args(request: Option<&AdapterStartRequest>) -> Vec<String> {
    let mut env = Map::new();
    if let Some(request_env) = request.and_then(|r| r.env.as_ref()) {
        for key in CLAUDE_ENV_OVERRIDE_KEYS {
            if let Some(value) = request_env.get(key).map(|v| v.trim()).filter(|v| !v.is_empty()) {
                env.insert(key.to_string(), json!(value));
            }
        }
    }
    if env.is_empty() {
        vec![]
    } else {
        vec!["--settings".to_string(), json!({ "env": env }).to_string()]
    }
}

/// Headless MCP config: user-managed servers merged with the run-scoped
/// Nautilo tool bridge.
fn claude_runtime_mcp_args(bridge_url: Option<&str>, servers: &[Value]) -> Vec<String> {
    let mut mcp_servers = Map::new();
    for server in servers {
        let name = server.get("name").and_then(Value::as_str).unwrap_or("mcp");
        let transport = server.get("transport").and_then(Value::as_str).unwrap_or("");
        if transport == "http" {
            if let Some(url) = server.get("url").and_then(Value::as_str) {
                let mut spec = Map::new();
                spec.insert("type".to_string(), json!("http"));
                spec.insert("url".to_string(), json!(url));
                if let Some(headers) = server.get("headers").and_then(Value::as_object).filter(|h| !h.is_empty()) {
                    spec.insert("headers".to_string(), Value::Object(headers.clone()));
                }
                mcp_servers.insert(name.to_string(), Value::Object(spec));
            }
        } else if transport == "stdio" {
            if let Some(command) = server.get("command").and_then(Value::as_str) {
                let mut spec = Map::new();
                spec.insert("command".to_string(), json!(command));
                if let Some(args) = server.get("args").and_then(Value::as_array).filter(|a| !a.is_empty()) {
                    spec.insert("args".to_string(), Value::Array(args.clone()));
                }
                if let Some(env) = server.get("env").and_then(Value::as_object).filter(|e| !e.is_empty()) {
                    spec.insert("env".to_string(), Value::Object(env.clone()));
                }
                mcp_servers.insert(name.to_string(), Value::Object(spec));
            }
        }
    }
    if let Some(url) = bridge_url {
        mcp_servers.insert(
            CLAUDE_RUNTIME_MCP_SERVER.to_string(),
            json!({ "type": "http", "url": url }),
        );
    }
    if mcp_servers.is_empty() {
        return vec![];
    }
    let mut args = vec![
        "--mcp-config".to_string(),
        json!({ "mcpServers": Value::Object(mcp_servers.clone()) }).to_string(),
        "--allowedTools".to_string(),
    ];
    for name in mcp_servers.keys() {
        args.push(format!("mcp__{name}"));
    }
    args
}

fn claude_permission_prompt_tool_args(request: &AdapterStartRequest, bridge_active: bool) -> Vec<String> {
    if bridge_active && request.request_interaction.is_some() {
        vec![
            "--permission-prompt-tool".to_string(),
            format!("mcp__{CLAUDE_RUNTIME_MCP_SERVER}__{PERMISSION_PROMPT_TOOL_NAME}"),
        ]
    } else {
        vec![]
    }
}

pub fn build_claude_start_args(instance: &Value, prompt: &str, request: Option<&AdapterStartRequest>) -> Vec<String> {
    let base_args: Vec<String> = instance
        .get("baseArgs")
        .and_then(Value::as_array)
        .map(|args| args.iter().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or_default();
    if !base_args.is_empty() {
        return base_args.into_iter().chain(std::iter::once(prompt.to_string())).collect();
    }
    let mut args = vec![
        "-p".to_string(),
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--verbose".to_string(),
        "--include-partial-messages".to_string(),
    ];
    args.extend(model_args(request));
    args.extend(effort_args(request));
    args.extend(claude_permission_args(instance, request));
    args.extend(claude_settings_args(request));
    args.push(prompt.to_string());
    args
}

pub fn build_claude_resume_args(
    instance: &Value,
    session_id: &str,
    prompt: &str,
    request: Option<&AdapterStartRequest>,
) -> Vec<String> {
    let base_args: Vec<String> = instance
        .get("baseArgs")
        .and_then(Value::as_array)
        .map(|args| args.iter().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or_default();
    if !base_args.is_empty() {
        return base_args
            .into_iter()
            .chain(["--resume".to_string(), session_id.to_string(), prompt.to_string()])
            .collect();
    }
    let mut args = vec![
        "-p".to_string(),
        "--resume".to_string(),
        session_id.to_string(),
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--verbose".to_string(),
        "--include-partial-messages".to_string(),
    ];
    args.extend(model_args(request));
    args.extend(effort_args(request));
    args.extend(claude_permission_args(instance, request));
    args.extend(claude_settings_args(request));
    args.push(prompt.to_string());
    args
}

// ---------------------------------------------------------------- event parsing

#[derive(Default)]
pub struct ClaudeParseState {
    /// tool_use_id → tool name, so tool_result completions keep their identity.
    tool_names: HashMap<String, String>,
    /// Current streaming message id (partial messages mode).
    stream_message_id: Option<String>,
    /// content_block index → block type (text vs thinking attribution).
    stream_blocks: HashMap<i64, String>,
    /// Latest single-request prompt size — the real context footprint.
    last_context_used: Option<i64>,
    /// Sticky context window learned from result modelUsage.
    context_window: Option<i64>,
}

pub type SharedClaudeParseState = Arc<Mutex<ClaudeParseState>>;

pub fn create_claude_parse_state() -> SharedClaudeParseState {
    Arc::new(Mutex::new(ClaudeParseState::default()))
}

fn printable(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::String(text) => text_of(value),
        Value::Array(items) => {
            let parts: Vec<String> = items
                .iter()
                .filter_map(|item| {
                    if item.get("type").and_then(Value::as_str) == Some("text") {
                        item.get("text").and_then(text_of)
                    } else {
                        printable(item)
                    }
                })
                .collect();
            if parts.is_empty() {
                None
            } else {
                Some(parts.join("\n"))
            }
        }
        other => serde_json::to_string_pretty(other).ok().filter(|s| !s.is_empty()),
    }
}

fn file_diff(tool_name: &str, input: &Value) -> Option<Value> {
    let normalized = tool_name.trim().to_lowercase();
    let build = |operation: &str, path: Option<String>, before: String, after: String| {
        let mut diff = Map::new();
        diff.insert("operation".to_string(), json!(operation));
        if let Some(path) = path {
            diff.insert("path".to_string(), json!(path));
        }
        diff.insert("before".to_string(), json!(before));
        diff.insert("after".to_string(), json!(after));
        Value::Object(diff)
    };
    match normalized.as_str() {
        "write" => {
            let content = input.get("content").and_then(text_of)?;
            Some(build("write", input.get("file_path").and_then(text_of), String::new(), content))
        }
        "edit" => {
            let before = input.get("old_string").and_then(text_of)?;
            let after = input.get("new_string").and_then(text_of)?;
            Some(build("edit", input.get("file_path").and_then(text_of), before, after))
        }
        "multiedit" => {
            let edits = input.get("edits").and_then(Value::as_array)?;
            if edits.is_empty() {
                return None;
            }
            let before = edits
                .iter()
                .map(|edit| edit.get("old_string").and_then(text_of).unwrap_or_default())
                .collect::<Vec<_>>()
                .join("\n");
            let after = edits
                .iter()
                .map(|edit| edit.get("new_string").and_then(text_of).unwrap_or_default())
                .collect::<Vec<_>>()
                .join("\n");
            Some(build("edit", input.get("file_path").and_then(text_of), before, after))
        }
        "notebookedit" => {
            let after = input.get("new_source").and_then(text_of)?;
            Some(build("edit", input.get("notebook_path").and_then(text_of), String::new(), after))
        }
        _ => None,
    }
}

fn parse_init(event: &Value, raw: &Value) -> Vec<AdapterEvent> {
    let mut events = vec![];
    if let Some(session_id) = event.get("session_id").and_then(text_of) {
        events.push(AdapterEvent::Session { provider_session_id: session_id, raw: Some(raw.clone()) });
    }
    let commands: Vec<Value> = event
        .get("slash_commands")
        .and_then(Value::as_array)
        .map(|names| {
            names
                .iter()
                .filter_map(Value::as_str)
                .map(|name| name.trim_start_matches('/').trim().to_string())
                .filter(|name| !name.is_empty())
                .map(|name| json!({ "name": name, "description": name }))
                .collect()
        })
        .unwrap_or_default();
    if !commands.is_empty() {
        events.push(AdapterEvent::Commands { commands: Value::Array(commands), raw: Some(raw.clone()) });
    }
    events
}

fn parse_assistant(event: &Value, state: &mut ClaudeParseState, raw: &Value, subagent_dispatch_id: Option<String>) -> Vec<AdapterEvent> {
    let message = event.get("message").cloned().unwrap_or(Value::Null);
    let message_id = message.get("id").and_then(text_of);
    let content = message.get("content").and_then(Value::as_array).cloned().unwrap_or_default();
    let mut events = vec![];
    for block in &content {
        match block.get("type").and_then(Value::as_str) {
            Some("text") => {
                if let Some(value) = block.get("text").and_then(text_of) {
                    events.push(AdapterEvent::Message {
                        text: value,
                        phase: Some("completed".to_string()),
                        message_id: message_id.clone(),
                        subagent_dispatch_id: subagent_dispatch_id.clone(),
                        raw: Some(raw.clone()),
                    });
                }
            }
            Some("thinking") => {
                if let Some(value) = block.get("thinking").and_then(text_of) {
                    events.push(AdapterEvent::Thinking {
                        text: value,
                        phase: Some("completed".to_string()),
                        message_id: message_id.as_ref().map(|id| format!("{id}-thinking")),
                        subagent_dispatch_id: subagent_dispatch_id.clone(),
                        raw: Some(raw.clone()),
                    });
                }
            }
            Some("tool_use") => {
                let call_id = block.get("id").and_then(text_of);
                let name = block.get("name").and_then(text_of).unwrap_or_else(|| "tool".to_string());
                if let Some(call_id) = &call_id {
                    state.tool_names.insert(call_id.clone(), name.clone());
                }
                let input = block.get("input").cloned().unwrap_or(Value::Null);
                events.push(AdapterEvent::Tool {
                    call_id,
                    name: name.clone(),
                    phase: Some("started".to_string()),
                    input: Some(input.clone()),
                    output: None,
                    success: None,
                    file_diff: file_diff(&name, &input),
                    subagent_dispatch_id: subagent_dispatch_id.clone(),
                    raw: Some(raw.clone()),
                });
            }
            _ => {}
        }
    }
    // Per-request usage is the only truthful context-footprint source; the
    // result event's usage is cumulative across the CLI session. Sub-agent
    // requests must not move the indicator.
    if subagent_dispatch_id.is_none() {
        let usage = message.get("usage").cloned().unwrap_or(Value::Null);
        let input_tokens = usage.get("input_tokens").and_then(number_of);
        let cached = usage.get("cache_read_input_tokens").and_then(number_of).unwrap_or(0)
            + usage.get("cache_creation_input_tokens").and_then(number_of).unwrap_or(0);
        if input_tokens.is_some() || cached > 0 {
            let context_used = input_tokens.unwrap_or(0) + cached;
            state.last_context_used = Some(context_used);
            events.push(AdapterEvent::Usage {
                input_tokens,
                cached_input_tokens: if cached > 0 { Some(cached) } else { None },
                output_tokens: usage.get("output_tokens").and_then(number_of),
                reasoning_output_tokens: None,
                context_used: Some(context_used),
                context_window: state.context_window,
                raw: Some(raw.clone()),
            });
        }
    }
    events
}

fn parse_user(event: &Value, state: &mut ClaudeParseState, raw: &Value, subagent_dispatch_id: Option<String>) -> Vec<AdapterEvent> {
    let message = event.get("message").cloned().unwrap_or(Value::Null);
    let content = message.get("content").and_then(Value::as_array).cloned().unwrap_or_default();
    let mut events = vec![];
    for block in &content {
        if block.get("type").and_then(Value::as_str) != Some("tool_result") {
            continue;
        }
        let call_id = block.get("tool_use_id").and_then(text_of);
        let name = call_id
            .as_ref()
            .and_then(|id| state.tool_names.get(id).cloned())
            .unwrap_or_else(|| "tool".to_string());
        events.push(AdapterEvent::Tool {
            call_id,
            name,
            phase: Some("completed".to_string()),
            input: None,
            output: block.get("content").and_then(printable).map(Value::String),
            success: Some(block.get("is_error").and_then(Value::as_bool) != Some(true)),
            file_diff: None,
            subagent_dispatch_id: subagent_dispatch_id.clone(),
            raw: Some(raw.clone()),
        });
    }
    events
}

fn parse_result(event: &Value, state: &mut ClaudeParseState, raw: &Value) -> Vec<AdapterEvent> {
    let mut events = vec![];
    if let Some(session_id) = event.get("session_id").and_then(text_of) {
        events.push(AdapterEvent::Session { provider_session_id: session_id, raw: Some(raw.clone()) });
    }
    let usage = event.get("usage").cloned().unwrap_or(Value::Null);
    let context_window = event
        .get("modelUsage")
        .and_then(Value::as_object)
        .and_then(|usage_map| usage_map.values().find_map(|entry| entry.get("contextWindow").and_then(number_of)));
    if let Some(context_window) = context_window {
        state.context_window = Some(context_window);
    }
    // result.usage totals are cumulative; contextUsed stays with the latest
    // single request tracked in parse_assistant.
    let input_tokens = usage.get("input_tokens").and_then(number_of);
    let cached = usage.get("cache_read_input_tokens").and_then(number_of).unwrap_or(0)
        + usage.get("cache_creation_input_tokens").and_then(number_of).unwrap_or(0);
    let output_tokens = usage.get("output_tokens").and_then(number_of);
    if input_tokens.is_some() || cached > 0 || output_tokens.is_some() {
        events.push(AdapterEvent::Usage {
            input_tokens,
            cached_input_tokens: if cached > 0 { Some(cached) } else { None },
            output_tokens,
            reasoning_output_tokens: None,
            context_used: state.last_context_used,
            context_window,
            raw: Some(raw.clone()),
        });
    }
    let failed = event.get("is_error").and_then(Value::as_bool) == Some(true);
    events.push(AdapterEvent::Status {
        phase: if failed { "turn_failed".to_string() } else { "turn_completed".to_string() },
        raw: Some(raw.clone()),
    });
    if failed {
        let detail = event
            .get("result")
            .and_then(text_of)
            .unwrap_or_else(|| {
                format!(
                    "Claude Code turn failed ({})",
                    event.get("subtype").and_then(text_of).unwrap_or_else(|| "unknown".to_string())
                )
            });
        events.push(AdapterEvent::Error { message: detail });
    }
    events
}

fn parse_stream_event(
    wrapper: &Value,
    state: &mut ClaudeParseState,
    raw: &Value,
    subagent_dispatch_id: Option<String>,
) -> Vec<AdapterEvent> {
    let event = wrapper.get("event").cloned().unwrap_or(Value::Null);
    let event_type = event.get("type").and_then(Value::as_str).unwrap_or("");
    match event_type {
        "message_start" => {
            state.stream_message_id = event.get("message").and_then(|m| m.get("id")).and_then(text_of);
            state.stream_blocks.clear();
            vec![]
        }
        "content_block_start" => {
            let index = event.get("index").and_then(number_of);
            let block_type = event.get("content_block").and_then(|b| b.get("type")).and_then(text_of);
            if let (Some(index), Some(block_type)) = (index, block_type) {
                state.stream_blocks.insert(index, block_type);
            }
            vec![]
        }
        "content_block_stop" => {
            if let Some(index) = event.get("index").and_then(number_of) {
                state.stream_blocks.remove(&index);
            }
            vec![]
        }
        "content_block_delta" => {
            let index = event.get("index").and_then(number_of);
            let block_type = index.and_then(|i| state.stream_blocks.get(&i).cloned());
            let delta = event.get("delta").cloned().unwrap_or(Value::Null);
            let delta_type = delta.get("type").and_then(Value::as_str);
            // Whitespace-only deltas are meaningful (paragraph breaks).
            let delta_text = |value: Option<&Value>| -> Option<String> {
                value.and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string)
            };
            let message_id = state.stream_message_id.clone();
            if delta_type == Some("text_delta") || (delta_type.is_none() && block_type.as_deref() == Some("text")) {
                return delta_text(delta.get("text"))
                    .map(|value| {
                        vec![AdapterEvent::Message {
                            text: value,
                            phase: Some("delta".to_string()),
                            message_id,
                            subagent_dispatch_id,
                            raw: Some(raw.clone()),
                        }]
                    })
                    .unwrap_or_default();
            }
            if delta_type == Some("thinking_delta") || (delta_type.is_none() && block_type.as_deref() == Some("thinking")) {
                return delta_text(delta.get("thinking"))
                    .map(|value| {
                        vec![AdapterEvent::Thinking {
                            text: value,
                            phase: Some("delta".to_string()),
                            message_id: message_id.map(|id| format!("{id}-thinking")),
                            subagent_dispatch_id,
                            raw: Some(raw.clone()),
                        }]
                    })
                    .unwrap_or_default();
            }
            vec![]
        }
        _ => vec![],
    }
}

/// Parses one `claude -p --output-format stream-json --verbose` line.
pub fn parse_claude_json_event(value: &Value, state: &SharedClaudeParseState) -> Vec<AdapterEvent> {
    let event_type = value.get("type").and_then(Value::as_str).unwrap_or("");
    // Sub-agent activity carries parent_tool_use_id pointing at the
    // dispatching Agent/Task tool call.
    let subagent_dispatch_id = value.get("parent_tool_use_id").and_then(text_of);
    let mut state = state.lock().unwrap();
    match event_type {
        "system" if value.get("subtype").and_then(Value::as_str) == Some("init") => parse_init(value, value),
        "stream_event" => parse_stream_event(value, &mut state, value, subagent_dispatch_id),
        "assistant" => parse_assistant(value, &mut state, value, subagent_dispatch_id),
        "user" => parse_user(value, &mut state, value, subagent_dispatch_id),
        "result" => {
            let events = parse_result(value, &mut state, value);
            state.tool_names.clear();
            state.stream_message_id = None;
            state.stream_blocks.clear();
            events
        }
        _ => vec![],
    }
}

// ---------------------------------------------------------------- permission prompt

/// Maps Claude Code's --permission-prompt-tool calls onto Nautilo
/// interactions (port of claude/permission-prompt.ts).
pub fn build_claude_permission_prompt_handler(
    request_interaction: Arc<dyn Fn(Value) -> crate::adapters::BoxFuture<anyhow::Result<Value>> + Send + Sync>,
) -> crate::adapters::runtime_mcp_bridge::PermissionPromptHandler {
    Arc::new(move |tool_name: Value, input: Value| {
        let request_interaction = request_interaction.clone();
        Box::pin(async move {
            let tool_name = tool_name.as_str().unwrap_or("").to_string();
            if tool_name == "AskUserQuestion" {
                let questions: Vec<Value> = input
                    .get("questions")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default()
                    .iter()
                    .enumerate()
                    .map(|(index, question)| {
                        let text = question
                            .get("question")
                            .and_then(Value::as_str)
                            .map(str::to_string)
                            .unwrap_or_else(|| format!("question-{}", index + 1));
                        let mut mapped = Map::new();
                        mapped.insert("id".to_string(), json!(text));
                        if let Some(header) = question.get("header").and_then(Value::as_str) {
                            mapped.insert("header".to_string(), json!(header));
                        }
                        mapped.insert("question".to_string(), json!(text));
                        if question.get("multiSelect").and_then(Value::as_bool) == Some(true) {
                            mapped.insert("multiSelect".to_string(), json!(true));
                        }
                        let options: Vec<Value> = question
                            .get("options")
                            .and_then(Value::as_array)
                            .map(|options| {
                                options
                                    .iter()
                                    .filter_map(|option| {
                                        let label = option.get("label").and_then(Value::as_str)?;
                                        let mut mapped = Map::new();
                                        mapped.insert("id".to_string(), json!(label));
                                        mapped.insert("label".to_string(), json!(label));
                                        if let Some(description) = option.get("description").and_then(Value::as_str) {
                                            mapped.insert("description".to_string(), json!(description));
                                        }
                                        Some(Value::Object(mapped))
                                    })
                                    .collect()
                            })
                            .unwrap_or_default();
                        if !options.is_empty() {
                            mapped.insert("options".to_string(), Value::Array(options));
                        }
                        Value::Object(mapped)
                    })
                    .collect();
                let response = request_interaction(json!({ "kind": "question", "title": "提问", "questions": questions })).await?;
                if response.get("outcome").and_then(Value::as_str) != Some("selected") {
                    return Ok(json!({ "behavior": "deny", "message": "User cancelled the question." }));
                }
                let mut answers = Map::new();
                for question in &questions {
                    let id = question.get("id").and_then(Value::as_str).unwrap_or("");
                    let values: Vec<&str> = response
                        .get("answers")
                        .and_then(|a| a.get(id))
                        .and_then(Value::as_array)
                        .map(|values| values.iter().filter_map(Value::as_str).collect())
                        .unwrap_or_default();
                    if !values.is_empty() {
                        answers.insert(id.to_string(), json!(values.join(", ")));
                    }
                }
                let mut updated = input.as_object().cloned().unwrap_or_default();
                updated.insert("answers".to_string(), Value::Object(answers));
                return Ok(json!({ "behavior": "allow", "updatedInput": Value::Object(updated) }));
            }
            if crate::adapters::plan_interaction::is_plan_exit_tool(&tool_name) {
                let response = request_interaction(json!({
                    "kind": "plan_approval",
                    "title": "计划已就绪",
                    "plan": crate::adapters::plan_interaction::extract_interaction_plan(&input),
                    "options": [
                        { "id": "allow", "label": "Approve", "intent": "approve" },
                        { "id": "deny", "label": "Revise", "intent": "revise" }
                    ]
                }))
                .await?;
                if response.get("outcome").and_then(Value::as_str) == Some("selected")
                    && response.get("optionId").and_then(Value::as_str) == Some("allow")
                {
                    return Ok(json!({ "behavior": "allow", "updatedInput": input }));
                }
                return Ok(json!({ "behavior": "deny", "message": "User chose to continue refining the plan in Nautilo." }));
            }
            let response = request_interaction(json!({
                "kind": "approval",
                "title": if tool_name.is_empty() { "权限请求" } else { tool_name.as_str() },
                "detail": serde_json::to_string_pretty(&input).unwrap_or_default().chars().take(4_000).collect::<String>(),
                "options": [ { "id": "allow", "label": "allow" }, { "id": "deny", "label": "deny" } ]
            }))
            .await?;
            if response.get("outcome").and_then(Value::as_str) == Some("selected")
                && response.get("optionId").and_then(Value::as_str) == Some("allow")
            {
                return Ok(json!({ "behavior": "allow", "updatedInput": input }));
            }
            Ok(json!({ "behavior": "deny", "message": "User denied this action in Nautilo." }))
        }) as crate::adapters::BoxFuture<anyhow::Result<Value>>
    })
}

// ---------------------------------------------------------------- the adapter

pub struct ClaudeCodeAdapter {
    /// Fallback parse state for the custom baseArgs path.
    fallback_state: SharedClaudeParseState,
}

impl Default for ClaudeCodeAdapter {
    fn default() -> Self {
        Self::new()
    }
}

impl ClaudeCodeAdapter {
    pub fn new() -> Self {
        Self { fallback_state: create_claude_parse_state() }
    }

    fn capture(command: &str, args: &[String]) -> CoreResult<(String, Option<i32>)> {
        let started = ProcessRuntime::start(&ProcessRequest {
            command: command.to_string(),
            args: args.to_vec(),
            timeout_ms: Some(8_000),
            idle_timeout_ms: Some(4_000),
            max_output_bytes: Some(512 * 1024),
            ..Default::default()
        })
        .map_err(|error| crate::errors::CoreError::reason(crate::errors::ErrorCode::IpcInternalError, error.to_string()))?;
        let handle = started.handle.clone();
        let mut events = started.events;
        let (sender, receiver) = std::sync::mpsc::channel();
        tokio::spawn(async move {
            let mut text = String::new();
            let mut exit_code = None;
            while let Some(event) = events.recv().await {
                match event {
                    crate::process_runtime::ProcessEvent::Stdout(chunk) | crate::process_runtime::ProcessEvent::Stderr(chunk) => text.push_str(&chunk),
                    crate::process_runtime::ProcessEvent::Exit { exit_code: code, .. } => exit_code = code,
                    _ => {}
                }
            }
            let _ = handle;
            let _ = sender.send((text, exit_code));
        });
        // detect() is async; bridge the blocking wait through the runtime.
        let (text, exit_code) = receiver.recv().map_err(|_| {
            crate::errors::CoreError::reason(crate::errors::ErrorCode::IpcInternalError, "capture channel closed")
        })?;
        Ok((text, exit_code))
    }
}

#[async_trait::async_trait]
impl AgentCliAdapter for ClaudeCodeAdapter {
    fn provider_id(&self) -> &str {
        "claude-code"
    }

    fn descriptor(&self) -> Value {
        json!({
            "providerId": "claude-code",
            "name": "Claude Code",
            "vendor": "Anthropic",
            "capabilities": ["headless_structured", "long_running_stdin", "pty_interactive"],
            "defaultExecutable": "claude",
            "credentialEnv": ["ANTHROPIC_API_KEY"],
            "envPassthrough": ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"],
            "baseUrlEnv": "ANTHROPIC_BASE_URL",
            "contextWindowDiscovery": true,
            "permissionModes": [
                { "value": "default", "name": { "zh-CN": "默认", "en-US": "Default" },
                  "description": { "zh-CN": "由 CLI 按自身规则决定何时询问", "en-US": "The CLI decides when to ask, per its own rules" } },
                { "value": "acceptEdits", "name": { "zh-CN": "自动接受编辑", "en-US": "Auto-accept edits" },
                  "description": { "zh-CN": "文件编辑自动通过，其余操作仍按默认规则", "en-US": "File edits pass automatically; everything else follows default rules" } },
                { "value": "plan", "name": { "zh-CN": "计划模式", "en-US": "Plan mode" },
                  "description": { "zh-CN": "只读探索，先产出计划再动手", "en-US": "Read-only exploration; produce a plan first" } },
                { "value": "bypassPermissions", "name": { "zh-CN": "跳过全部权限", "en-US": "Bypass all permissions" },
                  "description": { "zh-CN": "不做任何权限询问，请谨慎使用", "en-US": "No permission prompts at all — use with care" } }
            ]
        })
    }

    fn capabilities(&self) -> crate::adapters::AdapterCapabilities {
        crate::adapters::AdapterCapabilities {
            structured_output: true,
            text_output: true,
            interactive_stdin: false,
            native_resume: true,
            pty: false,
        }
    }

    async fn detect(&self, instance: &Value) -> AdapterDetectionResult {
        let executable = instance.get("executable").and_then(Value::as_str).unwrap_or("claude").to_string();
        let result = tokio::task::spawn_blocking({
            let executable = executable.clone();
            move || {
                let (version_text, version_code) = Self::capture(&executable, &["--version".to_string()])?;
                if version_code != Some(0) {
                    return Ok::<AdapterDetectionResult, crate::errors::CoreError>(AdapterDetectionResult {
                        installed: false,
                        executable: executable.clone(),
                        error: Some(if version_text.is_empty() {
                            format!("exit {}", version_code.map(|c| c.to_string()).unwrap_or_else(|| "unknown".to_string()))
                        } else {
                            version_text
                        }),
                        ..Default::default()
                    });
                }
                let (help_text, help_code) = Self::capture(&executable, &["--help".to_string()])?;
                let compatibility_error = if help_code == Some(0) {
                    if help_text.contains("stream-json") && help_text.contains("--resume") && help_text.contains("--include-partial-messages") {
                        None
                    } else {
                        Some("Installed Claude Code CLI does not expose stream-json output, partial messages, and session resume support".to_string())
                    }
                } else if !help_text.is_empty() {
                    Some(help_text.clone())
                } else {
                    Some(format!("help exited with {}", help_code.map(|c| c.to_string()).unwrap_or_else(|| "unknown".to_string())))
                };
                Ok(AdapterDetectionResult {
                    installed: true,
                    compatible: Some(compatibility_error.is_none()),
                    executable: executable.clone(),
                    version: Some(version_text.trim().to_string()),
                    help: Some(help_text.chars().take(16_384).collect()),
                    error: compatibility_error,
                })
            }
        })
        .await;
        match result {
            Ok(Ok(detection)) => detection,
            Ok(Err(error)) => AdapterDetectionResult { installed: false, executable, error: Some(error.to_string()), ..Default::default() },
            Err(error) => AdapterDetectionResult { installed: false, executable, error: Some(error.to_string()), ..Default::default() },
        }
    }

    async fn list_models(&self, _instance: &Value, context: Option<&Value>) -> Option<CoreResult<Value>> {
        let env = context.and_then(|c| c.get("env")).cloned();
        Some(models::discover_claude_models(env.as_ref()).await)
    }

    fn start(&self, request: AdapterStartRequest) -> CoreResult<AdapterRun> {
        let has_base_args = request
            .instance
            .get("baseArgs")
            .and_then(Value::as_array)
            .is_some_and(|args| !args.is_empty());
        if has_base_args {
            // Custom baseArgs take over the whole CLI surface; MCP config
            // cannot be injected. Parse with the shared fallback state and
            // fall back to the generic normalizer per line.
            let state = self.fallback_state.clone();
            return start_simple_process(request, move |value, _stream| {
                let parsed = parse_claude_json_event(value, &state);
                if parsed.is_empty() {
                    normalize_json(value)
                } else {
                    parsed
                }
            });
        }
        self.launch(request, None)
    }

    fn resume(&self, request: AdapterResumeRequest) -> CoreResult<AdapterRun> {
        let has_base_args = request
            .start
            .instance
            .get("baseArgs")
            .and_then(Value::as_array)
            .is_some_and(|args| !args.is_empty());
        if has_base_args {
            let state = self.fallback_state.clone();
            let session_id = request.provider_session_id;
            let start_request = request.start;
            let args = build_claude_resume_args(&start_request.instance, &session_id, &start_request.prompt, None);
            return start_simple_process_with_args(start_request, args, move |value, _stream| {
                let parsed = parse_claude_json_event(value, &state);
                if parsed.is_empty() {
                    normalize_json(value)
                } else {
                    parsed
                }
            });
        }
        let session_id = request.provider_session_id;
        self.launch(request.start, Some(session_id))
    }
}

/// Simple process launch (no MCP bridge), used by the custom-baseArgs path.
fn start_simple_process(
    request: AdapterStartRequest,
    parse: impl Fn(&Value, &str) -> Vec<AdapterEvent> + Send + Sync + 'static,
) -> CoreResult<AdapterRun> {
    let instance = request.instance.clone();
    let args = build_claude_start_args(&instance, &request.prompt, Some(&request));
    start_simple_process_with_args(request, args, parse)
}

fn start_simple_process_with_args(
    request: AdapterStartRequest,
    args: Vec<String>,
    parse: impl Fn(&Value, &str) -> Vec<AdapterEvent> + Send + Sync + 'static,
) -> CoreResult<AdapterRun> {
    let executable = request.instance.get("executable").and_then(Value::as_str).unwrap_or("claude").to_string();
    let started = ProcessRuntime::start(&ProcessRequest {
        command: executable,
        args,
        cwd: Some(request.cwd.clone()),
        env: request.env.clone(),
        timeout_ms: request.timeout_ms,
        idle_timeout_ms: request.idle_timeout_ms,
        max_output_bytes: Some(request.max_output_bytes.unwrap_or(20 * 1024 * 1024)),
    })
    .map_err(|error| crate::errors::CoreError::reason(crate::errors::ErrorCode::RunStartFailed, error.to_string()))?;
    let handle = started.handle.clone();
    handle.end_stdin(None);
    let events = stream_events(started.events, true, std::sync::Arc::new(parse));
    Ok(AdapterRun::from_process(events, &handle))
}

impl ClaudeCodeAdapter {
    /// Default headless path. The MCP bridge URL is only known once the
    /// loopback server is listening, but --mcp-config is a CLI flag — so the
    /// process is spawned lazily inside the event-pump task.
    fn launch(&self, request: AdapterStartRequest, resume_session: Option<String>) -> CoreResult<AdapterRun> {
        let (sender, receiver) = tokio::sync::mpsc::unbounded_channel::<AdapterEvent>();
        let (ready_sender, ready_receiver) = tokio::sync::oneshot::channel::<CoreResult<crate::process_runtime::ProcessHandle>>();
        let parse_state = create_claude_parse_state();
        tokio::spawn(async move {
            let result = launch_inner(request, resume_session, parse_state, sender.clone()).await;
            match result {
                Ok((handle, pump)) => {
                    let _ = ready_sender.send(Ok(handle));
                    pump.await;
                }
                Err(error) => {
                    let _ = ready_sender.send(Err(error));
                }
            }
        });
        let handle_placeholder = shared_handle_slot();
        let cancel_slot = handle_placeholder.clone();
        let write_slot = handle_placeholder.clone();
        tokio::spawn(async move {
            if let Ok(Ok(handle)) = ready_receiver.await {
                *handle_placeholder.lock().unwrap() = Some(handle);
            }
        });
        let run = AdapterRun::new(
            receiver,
            move || {
                Box::pin(async move {
                    let handle = cancel_slot.lock().unwrap().clone();
                    if let Some(handle) = handle {
                        handle.cancel().await;
                    }
                }) as crate::adapters::BoxFuture<()>
            },
            move |input| {
                if let Some(handle) = write_slot.lock().unwrap().as_ref() {
                    handle.write(&input);
                }
            },
        );
        Ok(run)
    }
}

fn shared_handle_slot() -> Arc<Mutex<Option<crate::process_runtime::ProcessHandle>>> {
    Arc::new(Mutex::new(None))
}

async fn launch_inner(
    request: AdapterStartRequest,
    resume_session: Option<String>,
    parse_state: SharedClaudeParseState,
    sender: tokio::sync::mpsc::UnboundedSender<AdapterEvent>,
) -> CoreResult<(crate::process_runtime::ProcessHandle, impl std::future::Future<Output = ()>)> {
    let instance = request.instance.clone();
    let needs_bridge = request.runtime_tools.is_some() || request.request_interaction.is_some();
    let bridge = if needs_bridge {
        let tools = request.runtime_tools.as_ref().and_then(Value::as_array).cloned().unwrap_or_default();
        let handler = request.request_interaction.clone().map(build_claude_permission_prompt_handler);
        Some(
            start_runtime_mcp_bridge("claude-code", tools, request.execute_runtime_tool.clone(), handler)
                .map_err(|error| crate::errors::CoreError::reason(crate::errors::ErrorCode::RunStartFailed, error.to_string()))?,
        )
    } else {
        None
    };
    let mut args = match &resume_session {
        Some(session_id) => build_claude_resume_args(&instance, session_id, &request.prompt, Some(&request)),
        None => build_claude_start_args(&instance, &request.prompt, Some(&request)),
    };
    let mut injected = claude_runtime_mcp_args(bridge.as_ref().map(|b| b.url.as_str()), request.mcp_servers.as_deref().unwrap_or(&[]));
    injected.extend(claude_permission_prompt_tool_args(&request, bridge.is_some()));
    if !injected.is_empty() {
        // Keep the prompt in the final position after injecting MCP flags.
        let prompt = args.pop().unwrap_or_default();
        args.extend(injected);
        args.push(prompt);
    }
    let mut env = request.env.clone().unwrap_or_default();
    // The CLI gates output_config.effort behind a model-name allowlist, so an
    // explicit user effort is silently dropped for other models. Opt out via
    // the CLI's override; a user-set value still wins.
    if request.reasoning_effort.is_some() {
        env.entry("CLAUDE_CODE_ALWAYS_ENABLE_EFFORT".to_string()).or_insert_with(|| "1".to_string());
    }
    let started = ProcessRuntime::start(&ProcessRequest {
        command: instance.get("executable").and_then(Value::as_str).unwrap_or("claude").to_string(),
        args,
        cwd: Some(request.cwd.clone()),
        env: Some(env),
        timeout_ms: request.timeout_ms,
        idle_timeout_ms: request.idle_timeout_ms,
        max_output_bytes: Some(request.max_output_bytes.unwrap_or(20 * 1024 * 1024)),
    })
    .map_err(|error| {
        if let Some(bridge) = &bridge {
            bridge.close();
        }
        crate::errors::CoreError::reason(crate::errors::ErrorCode::RunStartFailed, error.to_string())
    })?;
    let handle = started.handle.clone();
    handle.end_stdin(None);
    let events = stream_events(started.events, true, Arc::new(move |value, _stream| parse_claude_json_event(value, &parse_state)));
    let pump = async move {
        let mut events = events;
        while let Some(event) = events.recv().await {
            if sender.send(event).is_err() {
                break;
            }
        }
        if let Some(bridge) = bridge {
            bridge.close();
        }
    };
    Ok((handle, pump))
}
