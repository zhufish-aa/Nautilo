//! Nautilo native provider plugin for Command Code (`command-code`).
//!
//! Command Code (https://commandcode.ai, npm `command-code`) is an agentic
//! coding CLI. One Nautilo run maps to one headless invocation:
//!
//!   command-code -p --output-format json [flags]
//!
//! with the user prompt piped to stdin (avoids Windows arg-length/quoting
//! limits). The CLI streams NDJSON on stdout:
//!
//!   {"type":"event","event":{...}}   AgentEvent passthrough (unknown types ignored)
//!   {"type":"result","subtype":"success|error|max_turns","sessionId"?,
//!    "usage":{inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens},
//!    "durationMs","finalText","error"?}
//!
//! AgentEvents translate 1:1 into Nautilo AdapterEvents; the result line
//! finalizes the run (session id, fallback final message, usage totals,
//! terminal status, exit). Session resume maps to `--resume <sessionId>`.
//! Bound API connections use an isolated BYOK config and local-only mode;
//! unbound invocations use Command Code's own account login. Image
//! attachments (`localImagePaths`) are not forwarded in this integration.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod native_experience;
mod history;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use tokio::sync::mpsc;

use agenthub_plugin_sdk::process::{self, ProcessEvent, ProcessHandle, ProcessRequest};
use agenthub_plugin_sdk::ProviderPlugin;

/// Hard cap for a single buffered NDJSON line (safety valve against runaway output).
const MAX_LINE_BYTES: usize = 16 * 1024 * 1024;
/// trae/opencode default: 20 MiB of CLI output per run unless the host asks otherwise.
const DEFAULT_MAX_OUTPUT_BYTES: u64 = 20 * 1024 * 1024;

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
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
    str_of(instance, "executable")
        .filter(|e| !e.is_empty())
        .unwrap_or_else(|| "command-code".to_string())
}

fn descriptor() -> Value {
    json!({
        "providerId": "commandcode",
        "name": "Command Code",
        "vendor": "Command Code",
        "capabilities": ["headless_structured", "tool_streaming"],
        "defaultExecutable": "command-code",
        "credentialEnv": [],
        "envPassthrough": [],
        "permissionModes": [
            { "value": "standard", "name": { "zh-CN": "标准", "en-US": "Standard" },
              "description": { "zh-CN": "Command Code 无头默认权限：允许读取和搜索，写入与命令会被拒绝", "en-US": "Command Code headless default: reads and searches allowed, edits and shell commands are blocked" } },
            { "value": "auto-accept", "name": { "zh-CN": "自动接受", "en-US": "Auto-accept" },
              "description": { "zh-CN": "自动接受文件编辑（--auto-accept）", "en-US": "Auto-accept file edits (--auto-accept)" } },
            { "value": "dont-ask", "name": { "zh-CN": "不询问", "en-US": "Don't ask" },
              "description": { "zh-CN": "fail-closed 白名单模式，适合 CI 场景（--permission-mode dont-ask）", "en-US": "Fail-closed allowlist mode for CI (--permission-mode dont-ask)" } },
            { "value": "plan", "name": { "zh-CN": "计划模式", "en-US": "Plan mode" },
              "description": { "zh-CN": "只读分析，不执行修改（--plan）", "en-US": "Read-only analysis, no modifications (--plan)" } },
            { "value": "yolo", "name": { "zh-CN": "完全放行", "en-US": "Full autonomy" },
              "description": { "zh-CN": "所有工具调用自动放行，不再请求确认（--yolo）", "en-US": "Every tool call runs without prompting (--yolo)" } }
        ],
        "contextWindowDiscovery": false
    })
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

// ---------------------------------------------------------------- model discovery

/// A bare token that plausibly is a model id (defensive parse of the
/// `--list-models` text output; the exact format is not contractual).
fn is_model_id_line(line: &str) -> bool {
    if line.is_empty() || line.len() > 128 {
        return false;
    }
    if line.starts_with('#') || line.starts_with("http") {
        return false;
    }
    // Skip bare numbers (row counts etc.).
    if line.chars().all(|c| c.is_ascii_digit()) {
        return false;
    }
    line.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | '/' | ':'))
        && line.chars().any(|c| c.is_ascii_alphabetic())
}

fn parse_commandcode_models(text: &str) -> Value {
    let mut ids: Vec<String> = Vec::new();
    let mut names: HashMap<String, String> = HashMap::new();
    if let Ok(value) = serde_json::from_str::<Value>(text.trim()) {
        let items: Vec<Value> = match &value {
            Value::Array(items) => items.clone(),
            Value::Object(_) => value.get("models").and_then(Value::as_array).cloned().unwrap_or_default(),
            _ => vec![],
        };
        for item in &items {
            let (id, name) = match item {
                Value::String(s) => (s.clone(), s.clone()),
                Value::Object(_) => (
                    str_of(item, "id").or_else(|| str_of(item, "name")).unwrap_or_default(),
                    str_of(item, "name")
                        .or_else(|| str_of(item, "displayName"))
                        .unwrap_or_default(),
                ),
                _ => continue,
            };
            if !id.is_empty() && !ids.contains(&id) {
                if !name.is_empty() {
                    names.insert(id.clone(), name);
                }
                ids.push(id);
            }
        }
    } else {
        for line in text.lines() {
            let line = line.trim();
            if is_model_id_line(line) && !ids.iter().any(|id| id == line) {
                ids.push(line.to_string());
            }
        }
    }
    let models: Vec<Value> = ids
        .iter()
        .enumerate()
        .map(|(index, id)| {
            json!({
                "id": id,
                "displayName": names.get(id).cloned().unwrap_or_else(|| id.clone()),
                "description": "",
                "isDefault": index == 0,
                "contextWindow": Value::Null,
                "maxTokens": Value::Null,
                "capabilities": ["tool_use"],
                "reasoningEfforts": [],
                "defaultReasoningEffort": "",
                "serviceTiers": []
            })
        })
        .collect();
    json!({
        "providerId": "commandcode",
        "models": models,
        "defaultModel": ids.first().cloned().map(Value::String).unwrap_or(Value::Null),
        "source": "provider_cli",
        "fetchedAt": now_iso()
    })
}

// ---------------------------------------------------------------- event translation

#[derive(Default)]
struct CcParseState {
    message_sequence: u32,
    current_message_id: Option<String>,
    current_thinking_id: Option<String>,
    streamed_text: bool,
    streamed_thinking: bool,
    session_emitted: bool,
    model_error: bool,
    error_reported: bool,
    settled: bool,
    tool_names: HashMap<String, String>,
}

impl CcParseState {
    fn message_id(&self) -> Value {
        self.current_message_id.clone().map(Value::String).unwrap_or(Value::Null)
    }

    fn thinking_id(&self) -> Value {
        self.current_thinking_id.clone().map(Value::String).unwrap_or(Value::Null)
    }

    fn report_error(&mut self, message: String) -> Vec<Value> {
        self.model_error = true;
        self.error_reported = true;
        vec![json!({ "kind": "error", "message": message })]
    }
}

/// Joins printable text out of a tool result: a plain string, an array of
/// content blocks (`{"type":"text","text":…}`), or anything else stringified.
fn blocks_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter(|part| part.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .map(str::to_string)
            .collect::<Vec<_>>()
            .join("\n"),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

fn error_text_of(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Object(_) => value
            .get("message")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| value.to_string()),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

fn usage_event(usage: &Value, raw: &Value, scope: &str) -> Value {
    let input = usage.get("inputTokens").and_then(Value::as_u64);
    let cache_read = usage.get("cacheReadTokens").and_then(Value::as_u64);
    let cache_write = usage.get("cacheWriteTokens").and_then(Value::as_u64);
    let context_used = if scope == "context" {
        [input, cache_read, cache_write].into_iter().flatten().reduce(|a,b| a+b)
    } else { None };
    json!({
        "kind": "usage",
        "usageScope": scope,
        "inputTokensIncludesCache": false,
        "inputTokens": usage.get("inputTokens").cloned().unwrap_or(Value::Null),
        "cachedInputTokens": usage.get("cacheReadTokens").cloned().unwrap_or(Value::Null),
        "cacheCreationInputTokens": usage.get("cacheWriteTokens").cloned().unwrap_or(Value::Null),
        "outputTokens": usage.get("outputTokens").cloned().unwrap_or(Value::Null),
        "contextUsed": context_used,
        "raw": raw
    })
}

// A process may close stdout immediately after its final JSON object.
fn take_json_lines(buffer: &mut String, at_eof: bool) -> Vec<String> {
    let mut lines: Vec<String> = buffer.split('\n').map(str::to_string).collect();
    *buffer = lines.pop().unwrap_or_default();
    if at_eof && !buffer.trim().is_empty() {
        lines.push(std::mem::take(buffer));
    }
    lines
}

/// Maps one Command Code AgentEvent to zero or more Nautilo AdapterEvents.
/// Unknown event types are ignored (the CLI is forward-compatible).
fn translate_agent_event(event: &Value, state: &mut CcParseState) -> Vec<Value> {
    let kind = event.get("type").and_then(Value::as_str).unwrap_or("");
    match kind {
        "run_start" => {
            let mut out = vec![];
            if !state.session_emitted {
                if let Some(session_id) = str_of(event, "sessionId").filter(|s| !s.is_empty()) {
                    state.session_emitted = true;
                    out.push(json!({ "kind": "session", "providerSessionId": session_id, "raw": event }));
                }
            }
            out
        }
        "message_start" => {
            state.message_sequence += 1;
            state.current_message_id = Some(format!("cc-message-{}", state.message_sequence));
            state.current_thinking_id = Some(format!("cc-thinking-{}", state.message_sequence));
            state.streamed_text = false;
            state.streamed_thinking = false;
            vec![]
        }
        "text_delta" => {
            state.streamed_text = true;
            vec![json!({
                "kind": "message",
                "text": event.get("delta").and_then(Value::as_str).unwrap_or(""),
                "phase": "delta",
                "messageId": state.message_id(),
                "raw": event
            })]
        }
        "thinking_start" => vec![],
        "thinking_delta" => {
            state.streamed_thinking = true;
            vec![json!({
                "kind": "thinking",
                "text": event.get("delta").and_then(Value::as_str).unwrap_or(""),
                "phase": "delta",
                "messageId": state.thinking_id(),
                "raw": event
            })]
        }
        "thinking_end" => {
            let text = str_of(event, "text").unwrap_or_default();
            let mut out = vec![];
            if !state.streamed_thinking && !text.is_empty() {
                state.streamed_thinking = true;
                out.push(json!({
                    "kind": "thinking",
                    "text": text,
                    "phase": "delta",
                    "messageId": state.thinking_id(),
                    "raw": event
                }));
            }
            if state.streamed_thinking {
                out.push(json!({
                    "kind": "thinking",
                    "text": text,
                    "phase": "completed",
                    "messageId": state.thinking_id(),
                    "raw": event
                }));
            }
            out
        }
        // message_update duplicates message_end's full content; the end frame is authoritative.
        "message_update" => vec![],
        "message_end" => {
            let content = event.get("content").and_then(Value::as_array).cloned().unwrap_or_default();
            let mut out = vec![];
            if !state.streamed_text {
                let text: String = content
                    .iter()
                    .filter(|part| part.get("type").and_then(Value::as_str) == Some("text"))
                    .filter_map(|part| part.get("text").and_then(Value::as_str))
                    .map(str::to_string)
                    .collect::<Vec<_>>()
                    .join("");
                if !text.is_empty() {
                    state.streamed_text = true;
                    out.push(json!({
                        "kind": "message",
                        "text": text,
                        "phase": "delta",
                        "messageId": state.message_id(),
                        "raw": event
                    }));
                }
            }
            let thinking: String = content
                    .iter()
                    .filter(|part| part.get("type").and_then(Value::as_str) == Some("thinking"))
                    .filter_map(|part| {
                        part.get("thinking")
                            .and_then(Value::as_str)
                            .or_else(|| part.get("text").and_then(Value::as_str))
                    })
                    .map(str::to_string)
                    .collect::<Vec<_>>()
                    .join("\n");
            if !state.streamed_thinking {
                if !thinking.is_empty() {
                    state.streamed_thinking = true;
                    out.push(json!({
                        "kind": "thinking",
                        "text": thinking,
                        "phase": "delta",
                        "messageId": state.thinking_id(),
                        "raw": event
                    }));
                }
            }
            if state.streamed_thinking {
                out.push(json!({
                    "kind": "thinking",
                    "text": thinking,
                    "phase": "completed",
                    "messageId": state.thinking_id(),
                    "raw": event
                }));
            }
            out.push(json!({
                "kind": "message",
                "text": "",
                "phase": "completed",
                "messageId": state.message_id(),
                "raw": event
            }));
            out
        }
        "model_request_end" => {
            let usage = event.get("usage").cloned().unwrap_or(Value::Null);
            if usage.is_object() {
                vec![usage_event(&usage, event, "context")]
            } else {
                vec![]
            }
        }
        "tool_running" => {
            let call_id = str_of(event, "toolCallId").unwrap_or_default();
            let name = str_of(event, "toolName").unwrap_or_else(|| "tool".to_string());
            state.tool_names.insert(call_id.clone(), name.clone());
            vec![json!({
                "kind": "tool",
                "callId": call_id,
                "name": name,
                "phase": "started",
                "input": { "description": event.get("description").cloned().unwrap_or(Value::Null) },
                "fileDiff": Value::Null,
                "raw": event
            })]
        }
        "tool_completed" => {
            let call_id = str_of(event, "toolCallId").unwrap_or_default();
            let name = str_of(event, "toolName")
                .or_else(|| state.tool_names.get(&call_id).cloned())
                .unwrap_or_else(|| "tool".to_string());
            vec![json!({
                "kind": "tool",
                "callId": call_id,
                "name": name,
                "phase": "completed",
                "input": Value::Null,
                "output": blocks_text(event.get("result").unwrap_or(&Value::Null)),
                "success": true,
                "fileDiff": Value::Null,
                "raw": event
            })]
        }
        "tool_errored" => {
            let call_id = str_of(event, "toolCallId").unwrap_or_default();
            let name = str_of(event, "toolName")
                .or_else(|| state.tool_names.get(&call_id).cloned())
                .unwrap_or_else(|| "tool".to_string());
            let error = error_text_of(event.get("error").unwrap_or(&Value::Null));
            vec![json!({
                "kind": "tool",
                "callId": call_id,
                "name": name,
                "phase": "completed",
                "input": Value::Null,
                "output": if error.is_empty() { "工具执行失败".to_string() } else { error },
                "success": false,
                "fileDiff": Value::Null,
                "raw": event
            })]
        }
        "tool_denied" | "tool_hook_blocked" => {
            let call_id = str_of(event, "toolCallId").unwrap_or_default();
            let name = str_of(event, "toolName")
                .or_else(|| state.tool_names.get(&call_id).cloned())
                .unwrap_or_else(|| "tool".to_string());
            let reason = if kind == "tool_denied" {
                "工具调用被权限策略拒绝"
            } else {
                "工具调用被 hook 拦截"
            };
            vec![json!({
                "kind": "tool",
                "callId": call_id,
                "name": name,
                "phase": "completed",
                "input": Value::Null,
                "output": reason,
                "success": false,
                "fileDiff": Value::Null,
                "raw": event
            })]
        }
        "run_error" => state.report_error({
            let text = error_text_of(event.get("error").unwrap_or(&Value::Null));
            if text.is_empty() { "Command Code 运行失败".to_string() } else { text }
        }),
        "auth_required" => state.report_error(
            "Command Code 需要登录：请在终端运行 `command-code login` 后重试".to_string(),
        ),
        "api_retry" => vec![json!({
            "kind": "raw",
            "stream": "stderr",
            "text": format!(
                "command-code retry #{} in {}ms: {}\n",
                event.get("attempt").and_then(Value::as_u64).map(|v| v.to_string()).unwrap_or_default(),
                event.get("delayMs").and_then(Value::as_u64).map(|v| v.to_string()).unwrap_or_default(),
                error_text_of(event.get("error").unwrap_or(&Value::Null))
            )
        })],
        "stream_restart" => vec![json!({
            "kind": "raw",
            "stream": "stderr",
            "text": format!(
                "command-code stream restarted (attempt {}/{}), discarded partial output\n",
                event.get("attempt").and_then(Value::as_u64).map(|v| v.to_string()).unwrap_or_default(),
                event.get("maxAttempts").and_then(Value::as_u64).map(|v| v.to_string()).unwrap_or_default()
            )
        })],
        _ => vec![],
    }
}

fn exit_code_hint(code: Option<i32>) -> String {
    match code {
        Some(1) => "Command Code 运行失败（exit 1）".to_string(),
        Some(3) => "Command Code 未登录（exit 3），请先在终端运行 `command-code login`".to_string(),
        Some(4) => "Command Code 权限不足（exit 4）：当前权限模式阻止了该操作".to_string(),
        Some(5) => "Command Code 触发限流（exit 5）".to_string(),
        Some(6) => "Command Code 网络错误（exit 6）".to_string(),
        Some(7) => "Command Code 服务端错误（exit 7）".to_string(),
        Some(8) => "Command Code 达到最大轮次上限（exit 8）".to_string(),
        Some(9) => "Command Code 未产生响应（exit 9）".to_string(),
        Some(10) => "Command Code 账户余额不足（exit 10）".to_string(),
        Some(130) => "Command Code 被中断（exit 130）".to_string(),
        Some(c) => format!("Command Code 异常退出（exit {c}）"),
        None => "Command Code 进程被信号终止或未能启动".to_string(),
    }
}

// ---------------------------------------------------------------- the run loop

/// Builds the CLI argument list for one headless run. The prompt itself is
/// written to stdin by the caller (never passed as an argument).
fn build_args(request: &Value, instance: &Value, resume: Option<String>) -> Vec<String> {
    let mut args = base_args(instance);
    if instance.pointer("/providerOptions/runtimeConnectionId").is_some() { args.push("--local-only".into()); }
    args.extend(["-p".to_string(), "--output-format".to_string(), "json".to_string()]);
    let permission_mode = request.get("permissionMode").and_then(Value::as_str).unwrap_or("standard");
    match permission_mode {
        "yolo" | "auto" => args.push("--yolo".to_string()),
        "auto-accept" => args.push("--auto-accept".to_string()),
        "dont-ask" => args.extend(["--permission-mode".to_string(), "dont-ask".to_string()]),
        "plan" | "read-only" => args.push("--plan".to_string()),
        // "standard": Command Code's headless default (reads allowed, writes blocked).
        _ => {}
    }
    if let Some(model) = request.get("model").and_then(Value::as_str).filter(|m| !m.is_empty()) {
        args.extend(["--model".to_string(), if instance.pointer("/providerOptions/runtimeConnectionId").is_some() { format!("nautilo/{model}") } else { model.to_string() }]);
    }
    if let Some(effort) = request
        .get("reasoningEffort")
        .and_then(Value::as_str)
        .filter(|e| ["low", "medium", "high", "xhigh", "max"].contains(e))
    {
        args.extend(["--effort".to_string(), effort.to_string()]);
    }
    if let Some(session_id) = resume.filter(|s| !s.is_empty()) {
        args.extend(["--resume".to_string(), session_id]);
    }
    args
}

async fn run_commandcode(
    run_id: &str,
    request: Value,
    resume: Option<String>,
    sender: mpsc::UnboundedSender<Value>,
    runs: Arc<Mutex<HashMap<String, ProcessHandle>>>,
) -> anyhow::Result<()> {
    let instance = request.get("instance").cloned().unwrap_or(Value::Null);
    let prompt = agenthub_plugin_sdk::images::prompt_with_image_files(&request)?;
    if prompt.trim().is_empty() {
        anyhow::bail!("Command Code 需要非空的 prompt（无头模式通过 stdin 传入）");
    }
    let mut env = env_of(&request);
    if instance.pointer("/providerOptions/runtimeConnectionId").is_none() {
        for (key, value) in std::env::vars() { env.entry(key).or_insert(value); }
    }
    env = agenthub_plugin_sdk::connection::prepare_request(&request, env)?;

    let started = process::start(&ProcessRequest {
        command: executable_of(&instance),
        args: build_args(&request, &instance, resume),
        cwd: request.get("cwd").and_then(Value::as_str).map(str::to_string).filter(|c| !c.is_empty()),
        env: Some(env),
        timeout_ms: request.get("timeoutMs").and_then(Value::as_u64),
        idle_timeout_ms: request.get("idleTimeoutMs").and_then(Value::as_u64),
        max_output_bytes: Some(
            request
                .get("maxOutputBytes")
                .and_then(Value::as_u64)
                .unwrap_or(DEFAULT_MAX_OUTPUT_BYTES) as usize,
        ),
        ..Default::default()
    })?;
    let handle = started.handle.clone();
    runs.lock().unwrap().insert(run_id.to_string(), handle.clone());

    // Prompt via stdin, then close it: command-code reads the piped prompt
    // until EOF and starts the run.
    handle.write(&prompt);
    handle.end_stdin();

    let _ = sender.send(json!({ "kind": "status", "phase": "turn_started" }));

    let mut state = CcParseState::default();
    let terminal_status = false;
    let mut result_subtype: Option<String> = None;
    let mut result_error = String::new();
    let mut final_text = String::new();
    let mut result_usage = Value::Null;

    let mut events = started.events;
    let mut buffer = String::new();
    while let Some(event) = events.recv().await {
        if let ProcessEvent::Stdout(text) = &event {
            buffer.push_str(text);
            if buffer.len() > MAX_LINE_BYTES {
                anyhow::bail!("command-code JSON line exceeded {MAX_LINE_BYTES} bytes");
            }
        }
        let exiting = matches!(&event, ProcessEvent::Exit { .. });
        if matches!(&event, ProcessEvent::Stdout(_)) || exiting {
            let lines = take_json_lines(&mut buffer, exiting);
            for line in lines {
                let line = line.trim_end_matches('\r');
                if line.trim().is_empty() {
                    continue;
                }
                let value: Value = match serde_json::from_str(line) {
                    Ok(value) => value,
                    Err(_) => {
                        let _ = sender.send(
                            json!({ "kind": "raw", "stream": "stderr", "text": format!("command-code 输出无法解析: {line}\n") }),
                        );
                        continue;
                    }
                };
                match value.get("type").and_then(Value::as_str).unwrap_or("") {
                    "event" => {
                        let inner = value.get("event").cloned().unwrap_or(Value::Null);
                        for translated in translate_agent_event(&inner, &mut state) {
                            if sender.send(translated).is_err() {
                                return Ok(());
                            }
                        }
                    }
                    "result" => {
                        state.settled = true;
                        result_subtype = str_of(&value, "subtype");
                        result_error = value
                            .get("error")
                            .map(error_text_of)
                            .unwrap_or_default();
                        final_text = str_of(&value, "finalText").unwrap_or_default();
                        result_usage = value.get("usage").cloned().unwrap_or(Value::Null);
                        if !state.session_emitted {
                            if let Some(session_id) = str_of(&value, "sessionId").filter(|s| !s.is_empty()) {
                                state.session_emitted = true;
                                let _ = sender.send(json!({ "kind": "session", "providerSessionId": session_id, "raw": value }));
                            }
                        }
                    }
                    _ => {
                        let _ = sender.send(json!({ "kind": "raw", "stream": "stdout", "text": format!("{line}\n") }));
                    }
                }
            }
        }
        match event {
            ProcessEvent::Stdout(_) => {}
            ProcessEvent::Stderr(text) => {
                let _ = sender.send(json!({ "kind": "raw", "stream": "stderr", "text": text }));
            }
            ProcessEvent::Error(message) => {
                let _ = sender.send(json!({ "kind": "error", "message": message }));
                state.error_reported = true;
            }
            ProcessEvent::Timeout { reason } => {
                let _ = sender.send(json!({ "kind": "timeout", "reason": reason }));
            }
            ProcessEvent::Exit { exit_code, .. } => {
                let success = state.settled
                    && exit_code == Some(0)
                    && !state.model_error
                    && result_subtype.as_deref() != Some("error")
                    && result_subtype.as_deref() != Some("max_turns");
                // If nothing streamed as deltas, surface the final answer text.
                if success && !state.streamed_text && !final_text.is_empty() {
                    let _ = sender.send(json!({
                        "kind": "message",
                        "phase": "completed",
                        "messageId": state.message_id(),
                        "text": final_text
                    }));
                }
                if result_usage.is_object() {
                    let _ = sender.send(usage_event(&result_usage, &result_usage, "turn"));
                }
                if !success && !state.error_reported {
                    let message = if result_subtype.as_deref() == Some("max_turns") {
                        "Command Code 达到最大轮次上限（--max-turns）".to_string()
                    } else if !result_error.is_empty() {
                        result_error.clone()
                    } else {
                        exit_code_hint(exit_code)
                    };
                    let _ = sender.send(json!({ "kind": "error", "message": message }));
                }
                if !terminal_status {
                    let _ = sender.send(json!({
                        "kind": "status",
                        "phase": if success { "turn_completed" } else { "turn_failed" }
                    }));
                }
                let _ = sender.send(json!({ "kind": "exit", "exitCode": exit_code }));
                runs.lock().unwrap().remove(run_id);
                return Ok(());
            }
        }
    }
    if !terminal_status {
        let _ = sender.send(json!({ "kind": "status", "phase": "turn_failed" }));
    }
    runs.lock().unwrap().remove(run_id);
    Ok(())
}

// ---------------------------------------------------------------- the plugin

struct CommandCodePlugin {
    runs: Arc<Mutex<HashMap<String, ProcessHandle>>>,
}

impl CommandCodePlugin {
    fn new() -> Self {
        Self { runs: Arc::new(Mutex::new(HashMap::new())) }
    }
}

#[async_trait::async_trait]
impl ProviderPlugin for CommandCodePlugin {
    async fn read_session_history(&self,request:&Value,session:&str)->anyhow::Result<Option<Value>>{history::read(request,session).await.map(Some)}
    fn native_terminal_supported(&self)->bool {true}
    async fn terminal_plan(&self,request:&Value,resume:Option<String>)->anyhow::Result<Value> {
        let mut args=build_args(request,&request["instance"],resume);
        if let Some(index)=args.iter().position(|arg|arg=="-p"){args.remove(index);}
        if let Some(index)=args.iter().position(|arg|arg=="--output-format"){args.drain(index..index+2);}
        let env=agenthub_plugin_sdk::connection::prepare_request(request,env_of(request))?;
        Ok(json!({"command":executable_of(&request["instance"]),"args":args,"env":env}))
    }
    fn descriptor(&self) -> Value {
        descriptor()
    }

    fn capabilities(&self)->Value {
        agenthub_plugin_sdk::capabilities::with_profile(json!({
            "structuredOutput": false,
            "textOutput": true,
            "interactiveStdin": false,
            "nativeHistory": true,
            "nativeResume": true,
            "pty": false
        }),native_experience::declarations())
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
                "error": if version.trim().is_empty() {
                    "未找到 command-code 可执行文件，请先安装：npm install -g command-code（命令名为 command-code / cmdc / cmd）".to_string()
                } else {
                    version.trim().to_string()
                }
            });
        }
        let mut args = base_args(instance);
        args.push("--help".to_string());
        let (help, help_code) = capture(&executable, &args).await;
        let compatible = help_code == Some(0) && help.contains("--print") && help.contains("--output-format");
        json!({
            "installed": true,
            "compatible": compatible,
            "executable": executable,
            "version": version.trim(),
            "help": help.chars().take(16_384).collect::<String>(),
            "error": if compatible {
                Value::Null
            } else {
                Value::String("检测到的 Command Code CLI 不支持无头 JSON 输出（缺少 --print 或 --output-format），请升级：npm update -g command-code".to_string())
            }
        })
    }

    async fn list_models(&self, instance: &Value, _context: &Value) -> anyhow::Result<Value> {
        let executable = executable_of(instance);
        let mut args = base_args(instance);
        args.push("--list-models".to_string());
        let (text, code) = capture(&executable, &args).await;
        if code != Some(0) {
            anyhow::bail!(if text.trim().is_empty() {
                format!(
                    "command-code --list-models exited with {}",
                    code.map(|c| c.to_string()).unwrap_or_else(|| "unknown".to_string())
                )
            } else {
                text.trim().to_string()
            });
        }
        Ok(parse_commandcode_models(&text))
    }

    async fn start(
        &self,
        run_id: &str,
        request: Value,
        resume: Option<String>,
    ) -> anyhow::Result<mpsc::UnboundedReceiver<Value>> {
        let (sender, receiver) = mpsc::unbounded_channel::<Value>();
        let runs = self.runs.clone();
        let run_id = run_id.to_string();
        tokio::spawn(async move {
            let result = run_commandcode(&run_id, request, resume, sender.clone(), runs).await;
            if let Err(error) = result {
                let _ = sender.send(json!({ "kind": "error", "message": error.to_string() }));
                let _ = sender.send(json!({ "kind": "exit", "exitCode": 1 }));
            }
        });
        Ok(receiver)
    }

    async fn cancel(&self, run_id: &str) {
        // Kill the child process tree: a stale command-code keeps its session
        // locked and the next run resuming it stalls silently.
        let handle = self.runs.lock().unwrap().remove(run_id);
        if let Some(handle) = handle {
            handle.cancel().await;
        }
    }

    async fn dispose(&self) {}
}

#[tokio::main]
async fn main() {
    agenthub_plugin_sdk::serve(CommandCodePlugin::new()).await;
}
#[cfg(test)]
mod audit_tests {
    use super::*;
    #[test]
    fn final_result_without_a_newline_is_not_lost() {
        let mut buffer = "{\"type\":\"event\"}\n{\"type\":\"res".to_string();
        assert_eq!(take_json_lines(&mut buffer, false), vec!["{\"type\":\"event\"}"]);
        buffer.push_str("ult\",\"subtype\":\"success\",\"finalText\":\"done\"}");
        assert!(take_json_lines(&mut buffer, false).is_empty());
        let frames = take_json_lines(&mut buffer, true);
        let result: Value = serde_json::from_str(&frames[0]).unwrap();
        assert_eq!(result["finalText"], "done");
        assert!(take_json_lines(&mut buffer, true).is_empty());
    }
    #[test]
    fn request_usage_and_turn_usage_do_not_overwrite_each_other() {
        let native = json!({"inputTokens":10,"outputTokens":7,"cacheReadTokens":20,"cacheWriteTokens":5});
        let request = usage_event(&native, &Value::Null, "context");
        let turn = usage_event(&native, &Value::Null, "turn");
        assert_eq!(request["cacheCreationInputTokens"], 5);
        assert_eq!(request["contextUsed"], 35);
        assert_eq!(request["usageScope"], "context");
        assert_eq!(turn["usageScope"], "turn");
        assert!(turn["contextUsed"].is_null());
        assert_eq!(turn["inputTokensIncludesCache"], false);
    }
}
