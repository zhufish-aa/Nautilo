//! Nautilo native provider plugin for Pi — port of provider-plugin-pi.
//! Pi is driven as a long-lived JSONL RPC child process for each turn.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::{json, Map, Value};
use tokio::sync::mpsc;
use uuid::Uuid;

use agenthub_plugin_sdk::process::{self, ProcessEvent, ProcessRequest};
use base64::Engine;
use agenthub_plugin_sdk::{DaemonChannel, ProviderPlugin};

/// The Pi extension loaded by every run (MCP bridge + PowerShell tool +
/// provider config). Written to a temp file; loaded via --extension.
const AGENTHUB_PI_EXTENSION: &str = include_str!("../agenthub_provider_extension.mjs");

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn native_commands() -> Value {
    json!([{
        "name": "compact",
        "description": "压缩当前 Pi 会话上下文，可附加保留内容说明",
        "inputHint": "可选的压缩说明",
        "providerCommand": "compact"
    }])
}

fn descriptor() -> Value {
    json!({
        "providerId": "pi",
        "name": "Pi",
        "vendor": "Pi",
        "capabilities": ["headless_structured", "native_resume", "tool_streaming"],
        "defaultExecutable": "pi",
        "credentialEnv": ["AGENTHUB_PI_API_KEY"],
        "baseUrlEnv": "AGENTHUB_PI_BASE_URL",
        "envPassthrough": [
            "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "AZURE_OPENAI_API_KEY", "DEEPSEEK_API_KEY",
            "GEMINI_API_KEY", "OPENROUTER_API_KEY", "KIMI_API_KEY", "MOONSHOT_API_KEY",
            "OPENCODE_API_KEY", "ZAI_API_KEY", "ZAI_CODING_CN_API_KEY", "AWS_PROFILE",
            "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION", "PI_CODING_AGENT_DIR",
            "PI_CODING_AGENT_SESSION_DIR"
        ],
        "permissionModes": [
            { "value": "standard", "name": { "zh-CN": "标准", "en-US": "Standard" },
              "description": { "zh-CN": "加载项目级 Pi 资源并沿用 Pi 的工具配置", "en-US": "Load project-local Pi resources and keep Pi's configured tools" } },
            { "value": "read-only", "name": { "zh-CN": "只读", "en-US": "Read only" },
              "description": { "zh-CN": "仅启用 read、grep、find 和 ls", "en-US": "Only enable read, grep, find, and ls" } },
            { "value": "isolated", "name": { "zh-CN": "忽略项目扩展", "en-US": "Ignore project extensions" },
              "description": { "zh-CN": "沿用 Pi 的工具配置，但不加载项目级 Pi 资源", "en-US": "Keep Pi's configured tools but ignore project-local Pi resources" } }
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
            "description": "压缩当前 Pi 会话上下文，可附加保留内容说明",
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
    str_of(instance, "executable").filter(|e| !e.is_empty()).unwrap_or_else(|| "pi".to_string())
}

const PI_API_TYPES: [&str; 4] = ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"];

fn has_agenthub_endpoint(instance: &Value) -> bool {
    instance
        .get("providerOptions")
        .and_then(|o| o.get("baseUrl"))
        .and_then(Value::as_str)
        .is_some_and(|v| !v.trim().is_empty())
}

fn effective_pi_model(instance: &Value, model: Option<&str>) -> Option<String> {
    let selected = model.map(str::trim).filter(|m| !m.is_empty())?;
    if !has_agenthub_endpoint(instance) {
        return Some(selected.to_string());
    }
    Some(if selected.starts_with("agenthub/") { selected.to_string() } else { format!("agenthub/{selected}") })
}

fn configure_pi_provider_environment(instance: &Value, env: &mut HashMap<String, String>) {
    if !has_agenthub_endpoint(instance) {
        return;
    }
    let configured_api = instance
        .get("providerOptions")
        .and_then(|o| o.get("apiType"))
        .and_then(Value::as_str)
        .filter(|api| PI_API_TYPES.contains(api));
    let models: Vec<Value> = instance
        .get("models")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .iter()
        .map(|model| {
            let id = model.get("id").and_then(Value::as_str).unwrap_or("");
            let id = id.strip_prefix("agenthub/").unwrap_or(id);
            let levels: Vec<String> = model
                .get("reasoningEfforts")
                .and_then(Value::as_array)
                .map(|levels| levels.iter().filter_map(Value::as_str).filter(|l| *l != "off").map(str::to_string).collect())
                .unwrap_or_default();
            let mut entry = Map::new();
            entry.insert("id".to_string(), json!(id));
            entry.insert(
                "name".to_string(),
                model.get("displayName").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(|s| json!(s)).unwrap_or_else(|| json!(id)),
            );
            entry.insert("reasoning".to_string(), json!(!levels.is_empty()));
            if !levels.is_empty() {
                let map: Map<String, Value> = levels.iter().map(|level| (level.clone(), json!(level))).collect();
                entry.insert("thinkingLevelMap".to_string(), Value::Object(map));
            }
            entry.insert("input".to_string(), json!(["text", "image"]));
            entry.insert(
                "contextWindow".to_string(),
                model.get("contextWindow").and_then(Value::as_i64).map(|w| json!(w)).unwrap_or_else(|| json!(128_000)),
            );
            entry.insert("maxTokens".to_string(), json!(16_384));
            entry.insert("cost".to_string(), json!({ "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }));
            Value::Object(entry)
        })
        .collect();
    let base_url = instance
        .get("providerOptions")
        .and_then(|o| o.get("baseUrl"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim_end_matches('/');
    env.insert(
        "AGENTHUB_PI_PROVIDER_CONFIG".to_string(),
        json!({
            "name": instance.get("displayName").and_then(Value::as_str).unwrap_or("AgentHub API"),
            "baseUrl": base_url,
            "api": configured_api.unwrap_or("openai-completions"),
            "models": models
        })
        .to_string(),
    );
}

fn configure_pi_mcp_environment(request: &Value, env: &mut HashMap<String, String>, extra_servers: Vec<Value>) {
    let mut servers: Vec<Value> = request.get("mcpServers").and_then(Value::as_array).cloned().unwrap_or_default();
    servers.extend(extra_servers);
    if servers.is_empty() {
        env.remove("AGENTHUB_PI_MCP_SERVERS");
        return;
    }
    env.insert("AGENTHUB_PI_MCP_SERVERS".to_string(), json!(servers).to_string());
}

fn agenthub_pi_extension_path() -> String {
    let directory = std::env::temp_dir().join("agenthub-pi-provider");
    let path = directory.join("agenthub-provider.mjs");
    let _ = std::fs::create_dir_all(&directory);
    if std::fs::read_to_string(&path).ok().as_deref() == Some(AGENTHUB_PI_EXTENSION) {
        return path.to_string_lossy().into_owned();
    }
    let _ = std::fs::write(&path, AGENTHUB_PI_EXTENSION);
    path.to_string_lossy().into_owned()
}

// ---------------------------------------------------------------- runtime tool bridge

/// Serves run-scoped daemon tools to the Pi extension over loopback HTTP.
/// One long-lived server per plugin process; each run registers under a
/// random URL token that acts as the capability.
struct PiRuntimeToolServer {
    port: Mutex<Option<u16>>,
    registrations: Arc<Mutex<HashMap<String, (Vec<Value>, Arc<dyn DaemonChannel>, String)>>>,
    shutdown: Mutex<Option<std::sync::mpsc::Sender<()>>>,
}

impl PiRuntimeToolServer {
    fn new() -> Self {
        Self { port: Mutex::new(None), registrations: Arc::new(Mutex::new(HashMap::new())), shutdown: Mutex::new(None) }
    }

    fn ensure_started(&self) -> std::io::Result<u16> {
        if let Some(port) = *self.port.lock().unwrap() {
            return Ok(port);
        }
        let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
        listener.set_nonblocking(true)?;
        let port = listener.local_addr()?.port();
        let (shutdown_sender, shutdown) = std::sync::mpsc::channel::<()>();
        let registrations = self.registrations.clone();
        std::thread::spawn(move || loop {
            if shutdown.try_recv().is_ok() {
                return;
            }
            match listener.accept() {
                Ok((stream, _)) => {
                    let registrations = registrations.clone();
                    std::thread::spawn(move || {
                        let _ = handle_bridge_connection(stream, &registrations);
                    });
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(std::time::Duration::from_millis(5));
                }
                Err(_) => return,
            }
        });
        *self.port.lock().unwrap() = Some(port);
        *self.shutdown.lock().unwrap() = Some(shutdown_sender);
        Ok(port)
    }

    fn register(&self, tools: Vec<Value>, channel: Arc<dyn DaemonChannel>, run_id: &str) -> Option<String> {
        let port = self.ensure_started().ok()?;
        let token = Uuid::new_v4().to_string().replace('-', "");
        self.registrations.lock().unwrap().insert(token.clone(), (tools, channel, run_id.to_string()));
        Some(format!("http://127.0.0.1:{port}/mcp/{token}"))
    }

    fn unregister(&self, url: Option<&str>) {
        let Some(url) = url else { return };
        let token = url.rsplit('/').next().unwrap_or("");
        self.registrations.lock().unwrap().remove(token);
    }

    fn close(&self) {
        self.registrations.lock().unwrap().clear();
        if let Some(sender) = self.shutdown.lock().unwrap().take() {
            let _ = sender.send(());
        }
        *self.port.lock().unwrap() = None;
    }
}

fn public_tool_name(name: &str) -> &str {
    name.strip_prefix("agenthub.").or_else(|| name.strip_prefix("agenthub_")).unwrap_or(name)
}

fn handle_bridge_connection(
    mut stream: std::net::TcpStream,
    registrations: &Arc<Mutex<HashMap<String, (Vec<Value>, Arc<dyn DaemonChannel>, String)>>>,
) -> std::io::Result<()> {
    use std::io::{BufRead, BufReader, Read, Write};
    stream.set_nonblocking(false)?;
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut request_line = String::new();
    if reader.read_line(&mut request_line)? == 0 {
        return Ok(());
    }
    let method = request_line.split_whitespace().next().unwrap_or("").to_string();
    let target = request_line.split_whitespace().nth(1).unwrap_or("/").to_string();
    let pathname = target.split('?').next().unwrap_or("/");
    let mut content_length = 0usize;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 {
            break;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            break;
        }
        if let Some((name, value)) = trimmed.split_once(':') {
            if name.eq_ignore_ascii_case("content-length") {
                content_length = value.trim().parse().unwrap_or(0);
            }
        }
    }
    let mut body = vec![0u8; content_length.min(20 * 1024 * 1024)];
    reader.read_exact(&mut body)?;

    let local = stream.peer_addr().map(|address| address.ip().is_loopback()).unwrap_or(false);
    let token = pathname.strip_prefix("/mcp/").unwrap_or("");
    let registration = registrations.lock().unwrap().get(token).cloned();
    if !local || registration.is_none() {
        stream.write_all(b"HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n")?;
        return Ok(());
    }
    let (tools, channel, run_id) = registration.unwrap();
    if method == "DELETE" {
        stream.write_all(b"HTTP/1.1 202 Accepted\r\ncontent-length: 0\r\nconnection: close\r\n\r\n")?;
        return Ok(());
    }
    if method != "POST" {
        stream.write_all(b"HTTP/1.1 405 Method Not Allowed\r\ncontent-length: 0\r\nconnection: close\r\n\r\n")?;
        return Ok(());
    }
    let message: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    let id = message.get("id").cloned();
    if id.is_none() || id == Some(Value::Null) {
        stream.write_all(b"HTTP/1.1 202 Accepted\r\ncontent-length: 0\r\nconnection: close\r\n\r\n")?;
        return Ok(());
    }
    let id = id.unwrap();
    let rpc_method = message.get("method").and_then(Value::as_str).unwrap_or("");
    let reply = |result: Value| json!({ "jsonrpc": "2.0", "id": id, "result": result });
    let fail = |code: i64, text: &str| json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": text } });
    let response = match rpc_method {
        "initialize" => reply(json!({
            "protocolVersion": "2024-11-05",
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "agenthub-runtime", "version": "0.1.0" }
        })),
        "tools/list" => reply(json!({
            "tools": tools.iter().map(|tool| json!({
                "name": public_tool_name(tool.get("name").and_then(Value::as_str).unwrap_or("")),
                "description": tool.get("description").cloned().unwrap_or(Value::Null),
                "inputSchema": tool.get("inputSchema").cloned().unwrap_or_else(|| json!({ "type": "object" }))
            })).collect::<Vec<_>>()
        })),
        "tools/call" => {
            let params = message.get("params").cloned().unwrap_or(Value::Null);
            let requested = params.get("name").and_then(Value::as_str).unwrap_or("");
            let tool = tools.iter().find(|entry| public_tool_name(entry.get("name").and_then(Value::as_str).unwrap_or("")) == requested);
            match tool {
                Some(tool) => {
                    let name = tool.get("name").and_then(Value::as_str).unwrap_or("").to_string();
                    let arguments = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
                    let channel = channel.clone();
                    let run_id = run_id.clone();
                    let result = std::thread::scope(|_| {
                        tokio::runtime::Handle::current().block_on(channel.call_tool(&run_id, &name, arguments))
                    });
                    let success = result.get("success").and_then(Value::as_bool).unwrap_or(false);
                    let content = result.get("content").and_then(Value::as_str).unwrap_or("").to_string();
                    reply(json!({ "isError": !success, "content": [{ "type": "text", "text": content }] }))
                }
                None => reply(json!({
                    "isError": true,
                    "content": [{ "type": "text", "text": format!("Unknown Nautilo tool: {requested}") }]
                })),
            }
        }
        other => fail(-32601, &format!("Method not found: {other}")),
    };
    let body = serde_json::to_vec(&response).unwrap_or_default();
    stream.write_all(
        format!("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n", body.len()).as_bytes(),
    )?;
    stream.write_all(&body)?;
    stream.flush()
}

// ---------------------------------------------------------------- RPC event parsing

#[derive(Default)]
struct PiParseState {
    message_sequence: u32,
    current_message_id: Option<String>,
    current_thinking_id: Option<String>,
    streamed_text: bool,
    streamed_thinking: bool,
    last_assistant_stop_reason: Option<String>,
    model_error: bool,
    tool_args: HashMap<String, (String, Value)>,
}

fn pi_file_diff(name: &str, args: &Value) -> Option<Value> {
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

fn parse_pi_rpc_event(value: &Value, state: &mut PiParseState) -> Vec<Value> {
    let event_type = value.get("type").and_then(Value::as_str).unwrap_or("");
    match event_type {
        "message_start" => {
            let message = value.get("message").cloned().unwrap_or(Value::Null);
            if message.get("role").and_then(Value::as_str) != Some("assistant") {
                return vec![];
            }
            state.message_sequence += 1;
            state.current_message_id = Some(format!("pi-message-{}", state.message_sequence));
            state.current_thinking_id = Some(format!("pi-thinking-{}", state.message_sequence));
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
                            .unwrap_or("Pi model response stream failed")
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
                        .unwrap_or_else(|| format!("Pi assistant stopped with {}", stop_reason.unwrap_or_else(|| "an unknown model error".to_string())))
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
                "fileDiff": pi_file_diff(&name, &args).unwrap_or(Value::Null),
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
                "fileDiff": stored.as_ref().and_then(|(name, args)| pi_file_diff(name, args)).unwrap_or(Value::Null),
                "raw": value
            })]
        }
        "auto_retry_start" => vec![json!({
            "kind": "raw",
            "stream": "stderr",
            "text": format!("Pi retry {} / {}: {}\n",
                value.get("attempt").and_then(Value::as_i64).map(|v| v.to_string()).unwrap_or_default(),
                value.get("maxAttempts").and_then(Value::as_i64).map(|v| v.to_string()).unwrap_or_default(),
                value.get("errorMessage").and_then(Value::as_str).unwrap_or(""))
        })],
        "extension_error" => vec![json!({
            "kind": "error",
            "message": value.get("error").and_then(Value::as_str).unwrap_or("Pi extension failed")
        })],
        _ => vec![],
    }
}

// ---------------------------------------------------------------- the plugin

struct PiPlugin {
    tool_server: PiRuntimeToolServer,
    channel: Mutex<Option<Arc<dyn DaemonChannel>>>,
    runs: Mutex<HashMap<String, agenthub_plugin_sdk::process::ProcessHandle>>,
}

impl PiPlugin {
    fn new() -> Self {
        Self {
            tool_server: PiRuntimeToolServer::new(),
            channel: Mutex::new(None),
            runs: Mutex::new(HashMap::new()),
        }
    }
}

#[async_trait::async_trait]
impl ProviderPlugin for PiPlugin {
    fn descriptor(&self) -> Value {
        descriptor()
    }

    fn capabilities(&self) -> Value {
        json!({
            "structuredOutput": false,
            "textOutput": true,
            "interactiveStdin": true,
            "nativeResume": true,
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
                "error": if version.trim().is_empty() { "Pi --version failed".to_string() } else { version.trim().to_string() }
            });
        }
        let mut args = base_args(instance);
        args.push("--help".to_string());
        let (help, help_code) = capture(&executable, &args).await;
        let compatible = help_code == Some(0)
            && regex::Regex::new(r"(?i)AI coding assistant").map(|re| re.is_match(&help)).unwrap_or(false)
            && regex::Regex::new(r"(?i)--mode\s+<mode>").map(|re| re.is_match(&help)).unwrap_or(false)
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
                Value::String("该 pi 可执行文件不是支持 JSONL RPC 的 Pi coding agent，或版本过旧".to_string())
            }
        })
    }

    async fn list_models(&self, instance: &Value, _context: &Value) -> anyhow::Result<Value> {
        let executable = executable_of(instance);
        let mut env: HashMap<String, String> = std::env::vars().collect();
        env.insert("PI_OFFLINE".to_string(), "1".to_string());
        configure_pi_provider_environment(instance, &mut env);
        let mut args = base_args(instance);
        args.extend(["--mode".to_string(), "rpc".to_string(), "--no-session".to_string(), "--no-approve".to_string(), "--offline".to_string()]);
        if has_agenthub_endpoint(instance) {
            args.push("--extension".to_string());
            args.push(agenthub_pi_extension_path());
        }
        let responses = rpc_capture(&executable, &args, &env, vec![
            json!({ "id": "agenthub-state", "type": "get_state" }),
            json!({ "id": "agenthub-models", "type": "get_available_models" }),
        ])
        .await?;
        let state_response = responses.iter().find(|item| {
            item.get("type").and_then(Value::as_str) == Some("response")
                && item.get("id").and_then(Value::as_str) == Some("agenthub-state")
        });
        let model_response = responses.iter().find(|item| {
            item.get("type").and_then(Value::as_str) == Some("response")
                && item.get("id").and_then(Value::as_str) == Some("agenthub-models")
        });
        let Some(model_response) = model_response else {
            anyhow::bail!("Pi did not return get_available_models");
        };
        if model_response.get("success").and_then(Value::as_bool) == Some(false) {
            anyhow::bail!(model_response.get("error").and_then(Value::as_str).unwrap_or("Pi did not return get_available_models").to_string());
        }
        Ok(parse_pi_models(
            model_response,
            state_response,
            if has_agenthub_endpoint(instance) { Some("agenthub") } else { None },
        ))
    }

    async fn start(&self, request: Value, resume: Option<String>) -> anyhow::Result<mpsc::UnboundedReceiver<Value>> {
        let (sender, receiver) = mpsc::unbounded_channel::<Value>();
        let channel = self.channel.lock().unwrap().clone();
        let run_handle_slot = Arc::new(Mutex::new(None::<agenthub_plugin_sdk::process::ProcessHandle>));
        let slot = run_handle_slot.clone();
        tokio::spawn(async move {
            let result = run_pi(request, resume, sender.clone(), channel, slot).await;
            if let Err(error) = result {
                let _ = sender.send(json!({ "kind": "error", "message": error.to_string() }));
                let _ = sender.send(json!({ "kind": "exit", "exitCode": 1 }));
            }
        });
        let _ = run_handle_slot;
        Ok(receiver)
    }

    async fn dispose(&self) {
        self.tool_server.close();
    }
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

async fn rpc_capture(
    command: &str,
    args: &[String],
    env: &HashMap<String, String>,
    commands: Vec<Value>,
) -> anyhow::Result<Vec<Value>> {
    let started = process::start(&ProcessRequest {
        command: command.to_string(),
        args: args.to_vec(),
        env: Some(env.clone()),
        timeout_ms: Some(15_000),
        max_output_bytes: Some(16 * 1024 * 1024),
        ..Default::default()
    })?;
    for item in &commands {
        started.handle.write(&format!("{item}\n"));
    }
    started.handle.end_stdin();
    let mut events = started.events;
    let mut stdout = String::new();
    let mut stderr = String::new();
    let mut exit_code = None;
    while let Some(event) = events.recv().await {
        match event {
            ProcessEvent::Stdout(chunk) => stdout.push_str(&chunk),
            ProcessEvent::Stderr(chunk) => stderr.push_str(&chunk),
            ProcessEvent::Exit { exit_code: code, .. } => exit_code = code,
            ProcessEvent::Timeout { .. } => anyhow::bail!("Pi RPC model discovery timed out"),
            _ => {}
        }
    }
    if exit_code != Some(0) {
        anyhow::bail!(if stderr.trim().is_empty() {
            format!("Pi RPC exited with {}", exit_code.map(|c| c.to_string()).unwrap_or_else(|| "unknown".to_string()))
        } else {
            stderr.trim().to_string()
        });
    }
    let mut values = vec![];
    for line in stdout.lines() {
        if line.trim().is_empty() {
            continue;
        }
        values.push(serde_json::from_str::<Value>(line)?);
    }
    Ok(values)
}

fn parse_pi_models(model_response: &Value, state_response: Option<&Value>, provider_filter: Option<&str>) -> Value {
    let data = model_response.get("data").cloned().unwrap_or(Value::Null);
    let raw_models: Vec<Value> = data
        .get("models")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|item| {
            provider_filter.is_none() || item.get("provider").and_then(Value::as_str) == provider_filter
        })
        .collect();
    let state_data = state_response.and_then(|r| r.get("data")).cloned().unwrap_or(Value::Null);
    let active = state_data.get("model").cloned().unwrap_or(Value::Null);
    let active_provider = active.get("provider").and_then(Value::as_str);
    let active_id = active.get("id").and_then(Value::as_str);
    let active_thinking = state_data.get("thinkingLevel").and_then(Value::as_str);
    let mut default_model: Option<String> = match (active_provider, active_id) {
        (Some(provider), Some(id)) => Some(if provider_filter == Some(provider) { id.to_string() } else { format!("{provider}/{id}") }),
        _ => None,
    };
    let mut models: Vec<Value> = raw_models
        .iter()
        .map(|item| {
            let provider = item.get("provider").and_then(Value::as_str).unwrap_or("unknown");
            let model_id = item.get("id").and_then(Value::as_str).unwrap_or("unknown");
            let id = if provider_filter == Some(provider) { model_id.to_string() } else { format!("{provider}/{model_id}") };
            let input: Vec<String> = item
                .get("input")
                .and_then(Value::as_array)
                .map(|values| values.iter().filter_map(Value::as_str).map(str::to_string).collect())
                .unwrap_or_default();
            let mapped_levels: Vec<String> = item
                .get("thinkingLevelMap")
                .and_then(Value::as_object)
                .map(|map| {
                    map.iter()
                        .filter(|(_, value)| !(value.is_null() || value.as_bool() == Some(false)))
                        .map(|(level, _)| level.clone())
                        .collect()
                })
                .unwrap_or_default();
            let reasoning = item.get("reasoning").and_then(Value::as_bool) == Some(true);
            let reasoning_efforts: Vec<String> = if reasoning {
                let mut efforts = vec!["off".to_string()];
                efforts.extend(if mapped_levels.is_empty() {
                    vec!["low".to_string(), "medium".to_string(), "high".to_string()]
                } else {
                    mapped_levels
                });
                efforts.dedup();
                efforts
            } else {
                vec![]
            };
            let mut capabilities = vec!["tool_use"];
            if reasoning {
                capabilities.push("reasoning");
            }
            if input.iter().any(|i| i == "image") {
                capabilities.push("vision");
            }
            let default_effort = if Some(id.as_str()) == default_model.as_deref()
                && active_thinking.is_some()
                && reasoning_efforts.iter().any(|e| Some(e.as_str()) == active_thinking)
            {
                active_thinking.unwrap_or("").to_string()
            } else if reasoning_efforts.iter().any(|e| e == "medium") {
                "medium".to_string()
            } else {
                reasoning_efforts.first().cloned().unwrap_or_default()
            };
            json!({
                "id": id,
                "displayName": item.get("name").and_then(Value::as_str).unwrap_or(model_id),
                "description": format!("{} · {}", provider, item.get("api").and_then(Value::as_str).unwrap_or("Pi")),
                "isDefault": Some(id.as_str()) == default_model.as_deref(),
                "contextWindow": item.get("contextWindow").cloned().unwrap_or(Value::Null),
                "capabilities": capabilities,
                "reasoningEfforts": reasoning_efforts,
                "defaultReasoningEffort": default_effort,
                "serviceTiers": []
            })
        })
        .collect();
    if provider_filter.is_some() {
        default_model = models
            .iter()
            .find(|model| model.get("isDefault").and_then(Value::as_bool) == Some(true))
            .and_then(|model| model.get("id").and_then(Value::as_str).map(str::to_string))
            .or_else(|| models.first().and_then(|m| m.get("id").and_then(Value::as_str).map(str::to_string)));
        for model in models.iter_mut() {
            let is_default = Some(model.get("id").and_then(Value::as_str).unwrap_or("")) == default_model.as_deref();
            model.as_object_mut().unwrap().insert("isDefault".to_string(), json!(is_default));
        }
    }
    json!({
        "providerId": "pi",
        "models": models,
        "defaultModel": default_model.map(Value::String).unwrap_or(Value::Null),
        "source": "provider_cli",
        "fetchedAt": now_iso()
    })
}

/// Fails closed when Pi accepted a switch command but did not apply it.
fn assert_pi_selection(state_response: &Value, expected_model: Option<&str>, expected_thinking: Option<&str>) -> anyhow::Result<()> {
    let data = state_response.get("data").cloned().unwrap_or(Value::Null);
    let model = data.get("model").cloned().unwrap_or(Value::Null);
    let provider = model.get("provider").and_then(Value::as_str);
    let model_id = model.get("id").and_then(Value::as_str);
    if let Some(expected) = expected_model {
        let matches = match expected.find('/') {
            Some(slash) if slash > 0 => provider == Some(&expected[..slash]) && model_id == Some(&expected[slash + 1..]),
            _ => model_id == Some(expected),
        };
        if !matches {
            let actual = match (provider, model_id) {
                (Some(provider), Some(id)) => format!("{provider}/{id}"),
                _ => "none".to_string(),
            };
            anyhow::bail!("Pi model switch did not apply: expected {expected}, got {actual}");
        }
    }
    if let Some(expected) = expected_thinking {
        let actual = data.get("thinkingLevel").and_then(Value::as_str);
        if actual != Some(expected) {
            anyhow::bail!("Pi thinking level did not apply: expected {expected}, got {}", actual.unwrap_or("none"));
        }
    }
    Ok(())
}

// ---------------------------------------------------------------- run loop

const PI_MAX_RPC_FRAME_BYTES: usize = 64 * 1024 * 1024;

async fn run_pi(
    request: Value,
    resume: Option<String>,
    sender: mpsc::UnboundedSender<Value>,
    channel: Option<Arc<dyn DaemonChannel>>,
    handle_slot: Arc<Mutex<Option<agenthub_plugin_sdk::process::ProcessHandle>>>,
) -> anyhow::Result<()> {
    let instance = request.get("instance").cloned().unwrap_or(Value::Null);
    let mut env = env_of(&request);
    for (key, value) in std::env::vars() {
        env.entry(key).or_insert(value);
    }
    env.insert("PI_OFFLINE".to_string(), "1".to_string());
    configure_pi_provider_environment(&instance, &mut env);

    let runtime_tools = request.get("runtimeTools").and_then(Value::as_array).cloned().unwrap_or_default();
    let tool_url = if !runtime_tools.is_empty() && channel.is_some() {
        // A dedicated server per plugin process; the channel is required.
        let channel = channel.clone().unwrap();
        let server = PiRuntimeToolServer::new();
        // The plugin process owns one shared server; register per run.
        let url = {
            let port = server.ensure_started().ok();
            port.map(|port| {
                let token = Uuid::new_v4().to_string().replace('-', "");
                server.registrations.lock().unwrap().insert(token.clone(), (runtime_tools.clone(), channel, String::new()));
                format!("http://127.0.0.1:{port}/mcp/{token}")
            })
        };
        url
    } else {
        None
    };
    if !runtime_tools.is_empty() && tool_url.is_none() {
        let _ = sender.send(json!({
            "kind": "raw",
            "stream": "stderr",
            "text": "AgentHub runtime tools were supplied but the Pi runtime tool endpoint is not ready yet; provider-native Pi tools remain available.\n"
        }));
    }
    let extra_servers: Vec<Value> = tool_url
        .as_ref()
        .map(|url| vec![json!({ "transport": "http", "name": "agenthub", "url": url })])
        .unwrap_or_default();
    configure_pi_mcp_environment(&request, &mut env, extra_servers);
    let permission_mode = request.get("permissionMode").and_then(Value::as_str).unwrap_or("standard");
    if cfg!(windows) && permission_mode != "read-only" {
        env.insert("AGENTHUB_PI_ENABLE_POWERSHELL".to_string(), "1".to_string());
    }

    let skills = materialize_pi_skills(request.get("skills").and_then(Value::as_array).cloned().unwrap_or_default())?;
    let mut args = base_args(&instance);
    args.extend(["--mode".to_string(), "rpc".to_string(), "--offline".to_string()]);
    if permission_mode == "isolated" {
        args.push("--no-approve".to_string());
    } else {
        args.push("--approve".to_string());
    }
    if permission_mode == "read-only" {
        args.push("--tools".to_string());
        args.push("read,grep,find,ls".to_string());
    }
    // The extension also supplies Windows-native PowerShell compatibility and
    // normalizes malformed empty provider errors, so load it for every run.
    args.push("--extension".to_string());
    args.push(agenthub_pi_extension_path());
    for path in &skills.paths {
        args.push("--skill".to_string());
        args.push(path.clone());
    }
    if let Some(session) = &resume {
        args.push("--session".to_string());
        args.push(session.clone());
    }
    let selected_model = effective_pi_model(&instance, request.get("model").and_then(Value::as_str));
    if let Some(model) = &selected_model {
        args.push("--model".to_string());
        args.push(model.clone());
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
        // Pi's message_update frames carry the complete growing snapshot in
        // addition to the delta; only enforce a caller-supplied cap.
        max_output_bytes: request.get("maxOutputBytes").and_then(Value::as_u64).map(|v| v as usize),
        ..Default::default()
    })?;
    let handle = started.handle.clone();
    *handle_slot.lock().unwrap() = Some(handle.clone());

    let mut state = PiParseState::default();
    let mut settled = false;
    let mut terminal_status = false;
    let mut state_received = false;
    let prompt_sent = Arc::new(std::sync::atomic::AtomicBool::new(false));

    let send = |value: Value| handle.write(&format!("{value}\n"));
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
    let reasoning_effort = request.get("reasoningEffort").and_then(Value::as_str).map(str::to_string);

    let send_prompt = {
        let prompt_sent = prompt_sent.clone();
        let handle = handle.clone();
        let prompt = prompt.clone();
        let provider_command = provider_command.clone();
        move || {
            if prompt_sent.swap(true, std::sync::atomic::Ordering::SeqCst) {
                return;
            }
            if provider_command.as_deref() == Some("compact") {
                let custom = regex::Regex::new(r"(?i)^\s*\/?compact\b")
                    .map(|re| re.replace(&prompt, "").trim().to_string())
                    .unwrap_or_else(|_| prompt.clone());
                let mut frame = Map::new();
                frame.insert("id".to_string(), json!("agenthub-prompt"));
                frame.insert("type".to_string(), json!("compact"));
                if !custom.is_empty() {
                    frame.insert("customInstructions".to_string(), json!(custom));
                }
                handle.write(&format!("{}\n", Value::Object(frame)));
            } else {
                let mut frame = Map::new();
                frame.insert("id".to_string(), json!("agenthub-prompt"));
                frame.insert("type".to_string(), json!("prompt"));
                frame.insert("message".to_string(), json!(prompt));
                if !local_images.is_empty() {
                    let images: Vec<Value> = local_images
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
                handle.write(&format!("{}\n", Value::Object(frame)));
            }
        }
    };
    let selected_model_for_flow = selected_model.clone();
    let reasoning_for_flow = reasoning_effort.clone();
    let handle_for_flow = handle.clone();
    let send_verification_or_prompt = {
        let send_prompt = send_prompt.clone();
        move || {
            if selected_model_for_flow.is_some() || reasoning_for_flow.is_some() {
                handle_for_flow.write(&format!("{}\n", json!({ "id": "agenthub-verify-state", "type": "get_state" })));
            } else {
                send_prompt();
            }
        }
    };
    let reasoning_for_thinking = reasoning_effort.clone();
    let handle_for_thinking = handle.clone();
    let send_thinking_or_verify = {
        let send_verification_or_prompt = send_verification_or_prompt.clone();
        move || {
            if let Some(effort) = &reasoning_for_thinking {
                handle_for_thinking.write(&format!(
                    "{}\n",
                    json!({ "id": "agenthub-set-thinking", "type": "set_thinking_level", "level": effort })
                ));
            } else {
                send_verification_or_prompt();
            }
        }
    };
    send(json!({ "id": "agenthub-state", "type": "get_state" }));

    let _ = sender.send(json!({ "kind": "commands", "commands": native_commands() }));
    let _ = sender.send(json!({ "kind": "status", "phase": "turn_started" }));

    let mut events = started.events;
    let mut buffer = String::new();
    while let Some(event) = events.recv().await {
        match event {
            ProcessEvent::Stdout(text) => {
                buffer.push_str(&text);
                if buffer.len() > PI_MAX_RPC_FRAME_BYTES {
                    anyhow::bail!("Pi RPC frame exceeded {PI_MAX_RPC_FRAME_BYTES} bytes");
                }
                let mut lines: Vec<String> = buffer.split('\n').map(str::to_string).collect();
                buffer = lines.pop().unwrap_or_default();
                for line in lines {
                    let line = line.trim_end_matches('\r');
                    if line.trim().is_empty() {
                        continue;
                    }
                    if line.len() > PI_MAX_RPC_FRAME_BYTES {
                        anyhow::bail!("Pi RPC frame exceeded {PI_MAX_RPC_FRAME_BYTES} bytes");
                    }
                    let value: Value = match serde_json::from_str(line) {
                        Ok(value) => value,
                        Err(_) => {
                            let _ = sender.send(json!({ "kind": "raw", "stream": "stderr", "text": format!("Invalid Pi RPC output: {line}\n") }));
                            continue;
                        }
                    };
                    if !handle_rpc_value(
                        &value,
                        &mut state,
                        &mut settled,
                        &mut terminal_status,
                        &mut state_received,
                        &handle,
                        &sender,
                        &send_thinking_or_verify,
                        &send_verification_or_prompt,
                        &send_prompt,
                        &selected_model,
                        &reasoning_effort,
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
                // Pi RPC itself exits 0 after a failed model turn; normalize
                // that so the failure is not overwritten as completed.
                let code = if model_failed && exit_code == Some(0) { Some(1) } else { exit_code };
                let _ = sender.send(json!({ "kind": "exit", "exitCode": code }));
                skills.cleanup();
                return Ok(());
            }
        }
    }
    if !state_received && !terminal_status {
        let _ = sender.send(json!({ "kind": "status", "phase": "turn_failed" }));
    }
    skills.cleanup();
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn handle_rpc_value(
    value: &Value,
    state: &mut PiParseState,
    settled: &mut bool,
    terminal_status: &mut bool,
    state_received: &mut bool,
    handle: &agenthub_plugin_sdk::process::ProcessHandle,
    sender: &mpsc::UnboundedSender<Value>,
    send_thinking_or_verify: &impl Fn(),
    send_verification_or_prompt: &impl Fn(),
    send_prompt: &impl Fn(),
    selected_model: &Option<String>,
    reasoning_effort: &Option<String>,
    provider_command: &Option<String>,
) -> anyhow::Result<bool> {
    let value_type = value.get("type").and_then(Value::as_str).unwrap_or("");
    if value_type == "response" {
        if provider_command.as_deref() == Some("compact") && value.get("id").and_then(Value::as_str) == Some("agenthub-prompt") {
            let error = value.get("error").and_then(Value::as_str);
            let nothing = value.get("success").and_then(Value::as_bool) == Some(false)
                && regex::Regex::new(r"(?i)^(?:Nothing to compact(?: \(session too small\))?|Already compacted)$")
                    .map(|re| error.is_some_and(|e| re.is_match(e)))
                    .unwrap_or(false);
            if value.get("success").and_then(Value::as_bool) == Some(false) && !nothing {
                anyhow::bail!(error.unwrap_or("Pi RPC compact command failed").to_string());
            }
            let _ = sender.send(json!({
                "kind": "message",
                "phase": "completed",
                "messageId": "pi-compact",
                "text": if nothing { "当前 Pi 会话没有可压缩的旧内容，无需压缩。" } else { "Pi 会话压缩完成。" },
                "raw": value
            }));
            *settled = true;
            if !*terminal_status {
                let _ = sender.send(json!({ "kind": "status", "phase": "turn_completed", "raw": value }));
                *terminal_status = true;
            }
            // Compact is an RPC command, not an agent turn: close stdin after
            // the response or a successful compaction would wait forever.
            handle.end_stdin();
            return Ok(true);
        }
        if value.get("success").and_then(Value::as_bool) == Some(false) {
            anyhow::bail!(value
                .get("error")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| format!("Pi RPC command {} failed", value.get("command").and_then(Value::as_str).unwrap_or("unknown"))));
        }
        match value.get("id").and_then(Value::as_str) {
            Some("agenthub-state") => {
                *state_received = true;
                let session_id = value
                    .get("data")
                    .and_then(|d| d.get("sessionId"))
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let Some(session_id) = session_id else {
                    anyhow::bail!("Pi get_state response did not include sessionId");
                };
                let _ = sender.send(json!({ "kind": "session", "providerSessionId": session_id, "raw": value }));
                if let Some(model) = selected_model {
                    if let Some(slash) = model.find('/') {
                        if slash > 0 {
                            handle.write(&format!(
                                "{}\n",
                                json!({
                                    "id": "agenthub-set-model",
                                    "type": "set_model",
                                    "provider": &model[..slash],
                                    "modelId": &model[slash + 1..]
                                })
                            ));
                            return Ok(true);
                        }
                    }
                }
                send_thinking_or_verify();
            }
            Some("agenthub-set-model") => send_thinking_or_verify(),
            Some("agenthub-set-thinking") => send_verification_or_prompt(),
            Some("agenthub-verify-state") => {
                assert_pi_selection(value, selected_model.as_deref(), reasoning_effort.as_deref())?;
                send_prompt();
            }
            _ => {}
        }
        return Ok(true);
    }
    if value_type == "extension_ui_request" {
        // Extension UI requests (notify/confirm/select/editor) — notify-type
        // ones surface as raw output; interactive ones are cancelled when no
        // interaction channel is available, matching the TS fallback.
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
        return Ok(true);
    }
    if value_type == "agent_settled" {
        *settled = true;
        let failed = state.model_error
            || state.last_assistant_stop_reason.as_deref() == Some("error")
            || state.last_assistant_stop_reason.as_deref() == Some("aborted");
        if !*terminal_status {
            let _ = sender.send(json!({ "kind": "status", "phase": if failed { "turn_failed" } else { "turn_completed" }, "raw": value }));
            *terminal_status = true;
        }
        handle.end_stdin();
        return Ok(true);
    }
    for event in parse_pi_rpc_event(value, state) {
        if sender.send(event).is_err() {
            return Ok(false);
        }
    }
    Ok(true)
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

// ---------------------------------------------------------------- skills

const PI_SKILL_FILE_NAMES: [&str; 4] = ["skill.md", "skills.md", "skill.markdown", "skills.markdown"];

struct PiSkills {
    paths: Vec<String>,
    root: Option<std::path::PathBuf>,
}

impl PiSkills {
    fn cleanup(self) {
        if let Some(root) = self.root {
            let _ = std::fs::remove_dir_all(root);
        }
    }
}

fn pi_skill_slug(value: &str) -> String {
    let mut slug = String::new();
    let mut last_dash = false;
    for ch in value.trim().to_lowercase().chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch);
            last_dash = false;
        } else if !last_dash && !slug.is_empty() {
            slug.push('-');
            last_dash = true;
        }
    }
    let slug = slug.trim_matches('-').to_string();
    if slug.is_empty() { "skill".to_string() } else { slug }
}

fn render_pi_skill(skill: &Value, slug: &str) -> String {
    let description: String = skill
        .get("description")
        .and_then(Value::as_str)
        .unwrap_or("")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let description = if description.is_empty() { slug.to_string() } else { description };
    let instructions = skill.get("instructions").and_then(Value::as_str).unwrap_or("").trim();
    let id = skill.get("id").and_then(Value::as_str).unwrap_or("");
    format!(
        "---\nname: {slug}\ndescription: {}\n---\n\n{instructions}\n\n<!-- agenthub:runtime-skill:{id} -->\n",
        json!(description)
    )
}

/// Materializes run-scoped Pi skills so the plugin owns Pi's native format.
fn materialize_pi_skills(skills: Vec<Value>) -> anyhow::Result<PiSkills> {
    if skills.is_empty() {
        return Ok(PiSkills { paths: vec![], root: None });
    }
    let root = std::env::temp_dir().join(format!("agenthub-pi-skills-{}", Uuid::new_v4()));
    let mut paths = vec![];
    let mut used = std::collections::HashSet::new();
    let result = (|| -> anyhow::Result<()> {
        for skill in &skills {
            let base = pi_skill_slug(skill.get("name").and_then(Value::as_str).unwrap_or("skill"));
            let mut slug = base.clone();
            let mut suffix = 2;
            while used.contains(&slug) {
                slug = format!("{base}-{suffix}");
                suffix += 1;
            }
            used.insert(slug.clone());
            let directory = root.join(&slug);
            std::fs::create_dir_all(&directory)?;
            std::fs::write(directory.join("SKILL.md"), render_pi_skill(skill, &slug))?;
            if let Some(source) = skill
                .get("resourceDir")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                let source_path = std::path::Path::new(source);
                if source_path.is_dir() {
                    for entry in std::fs::read_dir(source_path)?.flatten() {
                        let name = entry.file_name().to_string_lossy().to_lowercase();
                        if entry.path().is_file() && PI_SKILL_FILE_NAMES.contains(&name.as_str()) {
                            continue;
                        }
                        copy_recursive(&entry.path(), &directory.join(entry.file_name()))?;
                    }
                }
            }
            paths.push(directory.to_string_lossy().into_owned());
        }
        Ok(())
    })();
    if let Err(error) = result {
        let _ = std::fs::remove_dir_all(&root);
        return Err(error);
    }
    Ok(PiSkills { paths, root: Some(root) })
}

fn copy_recursive(source: &std::path::Path, target: &std::path::Path) -> std::io::Result<()> {
    if source.is_dir() {
        std::fs::create_dir_all(target)?;
        for entry in std::fs::read_dir(source)? {
            let entry = entry?;
            copy_recursive(&entry.path(), &target.join(entry.file_name()))?;
        }
    } else {
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::copy(source, target)?;
    }
    Ok(())
}

#[tokio::main]
async fn main() {
    agenthub_plugin_sdk::serve(PiPlugin::new()).await;
}
