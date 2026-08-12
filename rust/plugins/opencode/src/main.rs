//! Nautilo native provider plugin for OpenCode — port of
//! provider-plugin-opencode. Uses OpenCode's headless server API and reuses
//! one server per configured instance/workspace.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use tokio::sync::mpsc;

use agenthub_plugin_sdk::process::{self, ProcessEvent, ProcessRequest};
use agenthub_plugin_sdk::ProviderPlugin;

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn descriptor() -> Value {
    json!({
        "providerId": "opencode",
        "name": "OpenCode",
        "vendor": "OpenCode",
        "capabilities": ["headless_text", "provider_server"],
        "defaultExecutable": "opencode",
        "credentialEnv": ["OPENCODE_API_KEY"],
        "permissionModes": [
            { "value": "build", "name": { "zh-CN": "执行模式", "en-US": "Build mode" },
              "description": { "zh-CN": "正常执行，可修改文件", "en-US": "Normal execution with file edits" } },
            { "value": "plan", "name": { "zh-CN": "计划模式", "en-US": "Plan mode" },
              "description": { "zh-CN": "只读探索，批准计划后再执行", "en-US": "Read-only planning until the plan is approved" } }
        ]
    })
}

/// Native commands reported at the start of every run; `compact` opts into
/// the daemon's dedicated-transport flow (server summarize endpoint).
fn native_commands() -> Value {
    json!([{ "name": "compact", "description": "压缩当前会话上下文（OpenCode summarize）", "providerCommand": "compact" }])
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

/// Converts one Nautilo `AdapterMcpServer` spec into an opencode `mcp` config
/// entry (`{ name: { type, command, environment, ... } }`).
fn opencode_mcp_entry(server: &Value) -> Option<(String, Value)> {
    let name = server.get("name").and_then(Value::as_str).unwrap_or("mcp").to_string();
    let transport = server.get("transport").and_then(Value::as_str).unwrap_or("");
    if transport == "http" {
        let url = server.get("url").and_then(Value::as_str)?;
        let mut entry = Map::new();
        entry.insert("type".to_string(), json!("remote"));
        entry.insert("url".to_string(), json!(url));
        if let Some(headers) = server.get("headers").and_then(Value::as_object).filter(|h| !h.is_empty()) {
            entry.insert("headers".to_string(), Value::Object(headers.clone()));
        }
        entry.insert("enabled".to_string(), json!(true));
        Some((name, Value::Object(entry)))
    } else {
        let command = server.get("command").and_then(Value::as_str)?;
        let mut cmd = vec![Value::String(command.to_string())];
        if let Some(args) = server.get("args").and_then(Value::as_array) {
            cmd.extend(args.iter().cloned());
        }
        let mut entry = Map::new();
        entry.insert("type".to_string(), json!("local"));
        entry.insert("command".to_string(), Value::Array(cmd));
        if let Some(env) = server.get("env").and_then(Value::as_object).filter(|e| !e.is_empty()) {
            entry.insert("environment".to_string(), Value::Object(env.clone()));
        }
        entry.insert("enabled".to_string(), json!(true));
        Some((name, Value::Object(entry)))
    }
}

/// Builds an opencode `mcp` config object from the request's `mcpServers`.
fn build_opencode_mcp_config(servers: Option<&Value>) -> Option<Value> {
    let servers = servers?.as_array()?;
    let mut mcp = Map::new();
    for server in servers {
        if let Some((name, entry)) = opencode_mcp_entry(server) {
            mcp.insert(name, entry);
        }
    }
    if mcp.is_empty() {
        return None;
    }
    Some(json!({ "mcp": Value::Object(mcp) }))
}

/// Injects Nautilo-managed MCP servers by writing `.opencode/opencode.json`
/// in `cwd` (merged over any existing file; opencode loads and deep-merges
/// this project-scoped config on top of the global one). Returns the previous
/// state for restoration: `(cwd, previous_content_or_none, written_content)`.
fn write_opencode_mcp_config(cwd: &str, servers: Option<&Value>) -> Option<(String, Option<String>, Option<String>)> {
    let config = build_opencode_mcp_config(servers)?;
    if cwd.is_empty() {
        return None;
    }
    let dir = std::path::Path::new(cwd).join(".opencode");
    let path = dir.join("opencode.json");
    let previous = std::fs::read_to_string(&path).ok();
    let mut merged: Value = previous
        .as_deref()
        .and_then(|text| serde_json::from_str(text).ok())
        .unwrap_or_else(|| json!({}));
    if let Some(object) = merged.as_object_mut() {
        if let Some(mcp) = config.get("mcp").cloned() {
            object.insert("mcp".to_string(), mcp);
        }
    }
    let written = serde_json::to_string_pretty(&merged).unwrap_or_default();
    if std::fs::create_dir_all(&dir).is_err() {
        return None;
    }
    if std::fs::write(&path, &written).is_err() {
        return None;
    }
    Some((cwd.to_string(), previous, Some(written)))
}

/// Restores (or removes) the injected `.opencode/opencode.json`. Only touches
/// the file if it still contains exactly what we wrote, so a concurrent write
/// from another server is never clobbered.
fn restore_opencode_mcp_config(cleanup: Option<&(String, Option<String>, Option<String>)>) {
    let Some((cwd, previous, written)) = cleanup else { return };
    let path = std::path::Path::new(cwd).join(".opencode").join("opencode.json");
    let owns = written
        .as_deref()
        .map(|content| std::fs::read_to_string(&path).ok().as_deref() == Some(content))
        .unwrap_or(false);
    if !owns {
        return;
    }
    match previous {
        Some(content) => {
            let _ = std::fs::write(&path, content);
        }
        None => {
            let _ = std::fs::remove_file(&path);
            // Best-effort: drop the now-empty .opencode dir.
            let _ = std::fs::remove_dir(path.parent().unwrap_or(std::path::Path::new("")));
        }
    }
}

fn executable_of(instance: &Value) -> String {
    instance
        .get("executable")
        .and_then(Value::as_str)
        .filter(|e| !e.is_empty())
        .unwrap_or("opencode")
        .to_string()
}

async fn capture(command: &str, args: &[&str], env: Option<HashMap<String, String>>) -> (String, Option<i32>) {
    let mut started = match process::start(&ProcessRequest {
        command: command.to_string(),
        args: args.iter().map(|s| s.to_string()).collect(),
        env,
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

// ---------------------------------------------------------------- server management

struct ManagedServer {
    base_url: String,
    handle: agenthub_plugin_sdk::process::ProcessHandle,
    active_runs: usize,
    retire_when_idle: bool,
    /// Injected `.opencode/opencode.json` state to restore when the server retires:
    /// (cwd, previous content or None, written content).
    config_cleanup: Option<(String, Option<String>, Option<String>)>,
}

#[derive(Default)]
struct ServerPool {
    servers: HashMap<String, Arc<Mutex<ManagedServer>>>,
}

struct OpenCodePlugin {
    pool: Mutex<ServerPool>,
    interactions: Mutex<Option<Arc<dyn agenthub_plugin_sdk::InteractionChannel>>>,
}

impl OpenCodePlugin {
    fn new() -> Self {
        Self { pool: Mutex::new(ServerPool::default()), interactions: Mutex::new(None) }
    }

    fn server_key(request: &Value) -> String {
        let instance = request.get("instance").cloned().unwrap_or(Value::Null);
        let env = env_of(request);
        let mut pairs: Vec<(&String, &String)> = env.iter().collect();
        pairs.sort();
        let env_json = serde_json::to_string(&pairs).unwrap_or_default();
        let hash = format!("{:x}", Sha256::digest(env_json.as_bytes()));
        [
            instance.get("id").and_then(Value::as_str).unwrap_or("").to_string(),
            std::fs::canonicalize(request.get("cwd").and_then(Value::as_str).unwrap_or(""))
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_else(|_| request.get("cwd").and_then(Value::as_str).unwrap_or("").to_string()),
            executable_of(&instance),
            hash,
        ]
        .join("\0")
    }

    async fn server_for(&self, request: &Value) -> anyhow::Result<Arc<Mutex<ManagedServer>>> {
        let key = Self::server_key(request);
        if let Some(existing) = self.pool.lock().unwrap().servers.get(&key).cloned() {
            return Ok(existing);
        }
        let server = self.launch_server(request).await?;
        let server = Arc::new(Mutex::new(server));
        self.pool.lock().unwrap().servers.insert(key, server.clone());
        Ok(server)
    }

    async fn launch_server(&self, request: &Value) -> anyhow::Result<ManagedServer> {
        let instance = request.get("instance").cloned().unwrap_or(Value::Null);
        let cwd = request.get("cwd").and_then(Value::as_str).unwrap_or("").to_string();
        // Inject Nautilo-managed MCP servers via a project-scoped opencode
        // config before the server starts (opencode reads it at startup).
        let config_cleanup = write_opencode_mcp_config(&cwd, request.get("mcpServers"));
        let port = std::net::TcpListener::bind("127.0.0.1:0")?.local_addr()?.port();
        let started = process::start(&ProcessRequest {
            command: executable_of(&instance),
            args: vec!["serve".to_string(), "--hostname".to_string(), "127.0.0.1".to_string(), "--port".to_string(), port.to_string()],
            cwd: request.get("cwd").and_then(Value::as_str).map(str::to_string),
            env: Some(env_of(request)),
            idle_timeout_ms: None,
            ..Default::default()
        })
        .map_err(|error| {
            restore_opencode_mcp_config(config_cleanup.as_ref());
            error
        })?;
        let base_url = format!("http://127.0.0.1:{port}");
        let handle = started.handle.clone();
        // Keep the server output flowing so its buffers never fill.
        tokio::spawn(async move {
            let mut events = started.events;
            while events.recv().await.is_some() {}
        });
        match wait_for_server(&base_url, &cwd).await {
            Ok(()) => Ok(ManagedServer { base_url, handle, active_runs: 0, retire_when_idle: false, config_cleanup }),
            Err(error) => {
                restore_opencode_mcp_config(config_cleanup.as_ref());
                handle.cancel().await;
                Err(error)
            }
        }
    }
}

async fn wait_for_server(base_url: &str, cwd: &str) -> anyhow::Result<()> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    let client = reqwest::Client::new();
    while std::time::Instant::now() < deadline {
        let url = directory_url(base_url, cwd, "/session/status");
        if let Ok(response) = client.get(&url).timeout(std::time::Duration::from_secs(5)).send().await {
            if response.status().is_success() {
                return Ok(());
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(80)).await;
    }
    anyhow::bail!("Timed out waiting for OpenCode server")
}

fn directory_url(base_url: &str, cwd: &str, path: &str) -> String {
    format!("{}{}?directory={}", base_url, path, urlencoding(cwd))
}

fn urlencoding(value: &str) -> String {
    value
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => (b as char).to_string(),
            other => format!("%{other:02X}"),
        })
        .collect()
}

async fn api_json(base_url: &str, cwd: &str, path: &str, method: &str, body: Option<Value>) -> anyhow::Result<Value> {
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(30)).build()?;
    let url = directory_url(base_url, cwd, path);
    let request = match method {
        "POST" => client.post(&url),
        _ => client.get(&url),
    };
    let request = match &body {
        Some(body) => request.header("content-type", "application/json").json(body),
        None => request,
    };
    let response = request.send().await?;
    let status = response.status();
    if !status.is_success() {
        let detail = response.text().await.unwrap_or_default();
        anyhow::bail!(
            "OpenCode server {method} {path} failed ({}){}",
            status.as_u16(),
            if detail.is_empty() { String::new() } else { format!(": {}", detail.chars().take(500).collect::<String>()) }
        );
    }
    if status.as_u16() == 204 {
        return Ok(Value::Null);
    }
    let text = response.text().await?;
    Ok(if text.is_empty() { Value::Null } else { serde_json::from_str(&text).unwrap_or(Value::Null) })
}

// ---------------------------------------------------------------- event parsing

fn parse_opencode_part(part: &Value, raw: &Value, delta: Option<&str>) -> Vec<Value> {
    let part_type = part.get("type").and_then(Value::as_str).unwrap_or("");
    if part_type == "text" || part_type == "reasoning" {
        let kind = if part_type == "text" { "message" } else { "thinking" };
        let message_id = part.get("messageID").and_then(Value::as_str);
        if let Some(delta) = delta {
            return vec![json!({
                "kind": kind,
                "phase": "delta",
                "messageId": message_id.map(str::to_string).map(Value::String).unwrap_or(Value::Null),
                "text": delta,
                "raw": raw
            })];
        }
        if part.get("time").and_then(|t| t.get("end")).is_none() {
            return vec![];
        }
    }
    let mapped_type = if part_type == "tool" { "tool_use" } else { &part_type.replace('-', "_") };
    parse_opencode_event(&json!({
        "type": mapped_type,
        "sessionID": part.get("sessionID").cloned().unwrap_or(Value::Null),
        "part": part,
        "raw": raw
    }))
}

/// Parses one `opencode run --format json` event (verified against 1.18.7).
fn parse_opencode_event(value: &Value) -> Vec<Value> {
    let mut events = vec![];
    if let Some(session_id) = value.get("sessionID").and_then(Value::as_str).filter(|s| !s.is_empty()) {
        events.push(json!({ "kind": "session", "providerSessionId": session_id, "raw": value }));
    }
    let part = value.get("part").cloned().unwrap_or(Value::Null);
    let message_id = part.get("messageID").and_then(Value::as_str);
    match value.get("type").and_then(Value::as_str).unwrap_or("") {
        "text" => {
            if let Some(text) = part.get("text").and_then(Value::as_str).filter(|t| !t.is_empty()) {
                events.push(json!({
                    "kind": "message",
                    "phase": "completed",
                    "messageId": message_id.map(str::to_string).map(Value::String).unwrap_or(Value::Null),
                    "text": text,
                    "raw": value
                }));
            }
        }
        "reasoning" => {
            if let Some(text) = part.get("text").and_then(Value::as_str).filter(|t| !t.is_empty()) {
                events.push(json!({
                    "kind": "thinking",
                    "phase": "completed",
                    "messageId": message_id.map(str::to_string).map(Value::String).unwrap_or(Value::Null),
                    "text": text,
                    "raw": value
                }));
            }
        }
        "tool_use" => {
            let state = part.get("state").cloned().unwrap_or(Value::Null);
            let status = state.get("status").and_then(Value::as_str).unwrap_or("");
            events.push(json!({
                "kind": "tool",
                "callId": part.get("callID").cloned().unwrap_or(Value::Null),
                "name": part.get("tool").and_then(Value::as_str).unwrap_or("tool"),
                "phase": if status == "completed" || status == "error" { "completed" } else { "started" },
                "input": state.get("input").cloned().unwrap_or(Value::Null),
                "output": state.get("output").cloned().or_else(|| state.get("error").cloned()).unwrap_or(Value::Null),
                "success": if status == "completed" { json!(true) } else if status == "error" { json!(false) } else { Value::Null },
                "raw": value
            }));
        }
        "step_finish" => {
            if let Some(tokens) = part.get("tokens").filter(|t| t.is_object()) {
                let input = tokens.get("input").and_then(Value::as_i64);
                let cache_read = tokens.get("cache").and_then(|c| c.get("read")).and_then(Value::as_i64);
                let cache_write = tokens.get("cache").and_then(|c| c.get("write")).and_then(Value::as_i64);
                // Prompt-side footprint of the latest request: uncached input
                // + cache reads/writes.
                let context_used = if input.is_some() || cache_read.is_some() || cache_write.is_some() {
                    Some(input.unwrap_or(0) + cache_read.unwrap_or(0) + cache_write.unwrap_or(0))
                } else {
                    None
                };
                events.push(json!({
                    "kind": "usage",
                    "inputTokens": input.map(Value::from).unwrap_or(Value::Null),
                    "outputTokens": tokens.get("output").and_then(Value::as_i64).map(Value::from).unwrap_or(Value::Null),
                    "reasoningOutputTokens": tokens.get("reasoning").and_then(Value::as_i64).map(Value::from).unwrap_or(Value::Null),
                    "cachedInputTokens": cache_read.map(Value::from).unwrap_or(Value::Null),
                    "contextUsed": context_used.map(Value::from).unwrap_or(Value::Null),
                    "raw": value
                }));
            }
        }
        "error" => {
            let error = value.get("error").cloned().unwrap_or(Value::Null);
            let message = error
                .get("data")
                .and_then(|d| d.get("message"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|m| !m.is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| error.get("name").and_then(Value::as_str).unwrap_or("opencode run failed").to_string());
            events.push(json!({ "kind": "status", "phase": "turn_failed", "raw": value }));
            events.push(json!({ "kind": "error", "message": message }));
        }
        _ => {}
    }
    events
}

fn with_subagent_dispatch(events: Vec<Value>, dispatch_id: &str) -> Vec<Value> {
    events
        .into_iter()
        .map(|event| {
            let kind = event.get("kind").and_then(Value::as_str).unwrap_or("");
            if ["message", "thinking", "tool", "command"].contains(&kind) {
                let mut mapped = event.as_object().cloned().unwrap_or_default();
                mapped.insert("subagentDispatchId".to_string(), json!(dispatch_id));
                Value::Object(mapped)
            } else {
                event
            }
        })
        .collect()
}

// ---------------------------------------------------------------- question/permission bridges

fn classify_question(properties: &Value) -> (bool, Vec<Value>, Vec<Value>) {
    let questions: Vec<Value> = properties
        .get("questions")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .iter()
        .enumerate()
        .map(|(index, question)| {
            let options: Vec<Value> = question
                .get("options")
                .and_then(Value::as_array)
                .map(|options| {
                    options
                        .iter()
                        .enumerate()
                        .map(|(option_index, option)| {
                            let label = option
                                .get("label")
                                .and_then(Value::as_str)
                                .or_else(|| option.get("value").and_then(Value::as_str))
                                .map(str::to_string)
                                .unwrap_or_else(|| format!("option-{}", option_index + 1));
                            let mut mapped = Map::new();
                            mapped.insert("id".to_string(), json!(label));
                            mapped.insert("label".to_string(), json!(label));
                            if let Some(description) = option.get("description").and_then(Value::as_str) {
                                mapped.insert("description".to_string(), json!(description));
                            }
                            Value::Object(mapped)
                        })
                        .collect()
                })
                .unwrap_or_default();
            let mut mapped = Map::new();
            mapped.insert(
                "id".to_string(),
                question
                    .get("id")
                    .and_then(Value::as_str)
                    .map(|s| json!(s))
                    .unwrap_or_else(|| json!(format!("question-{}", index + 1))),
            );
            if let Some(header) = question.get("header").and_then(Value::as_str) {
                mapped.insert("header".to_string(), json!(header));
            }
            mapped.insert("question".to_string(), question.get("question").cloned().unwrap_or_else(|| json!("")));
            if question.get("multiple").and_then(Value::as_bool) == Some(true)
                || question.get("multiSelect").and_then(Value::as_bool) == Some(true)
            {
                mapped.insert("multiSelect".to_string(), json!(true));
            }
            if question.get("custom").and_then(Value::as_bool) == Some(true) {
                mapped.insert("isOther".to_string(), json!(true));
            }
            if !options.is_empty() {
                mapped.insert("options".to_string(), Value::Array(options));
            }
            Value::Object(mapped)
        })
        .collect();
    let is_plan = questions.len() == 1 && is_plan_question(&questions[0], properties);
    let options = if is_plan {
        questions[0]
            .get("options")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .iter()
            .map(|option| {
                let text = format!(
                    "{} {} {}",
                    option.get("id").and_then(Value::as_str).unwrap_or(""),
                    option.get("label").and_then(Value::as_str).unwrap_or(""),
                    option.get("description").and_then(Value::as_str).unwrap_or("")
                );
                let intent = if regex::Regex::new(r"(?i)(^|\b)(yes|approve|implement|build|proceed)(\b|$)|批准|执行|开始实现")
                    .map(|re| re.is_match(&text))
                    .unwrap_or(false)
                {
                    Some("approve")
                } else if regex::Regex::new(r"(?i)(^|\b)(no|revise|refine|keep planning|stay)(\b|$)|修改|继续计划")
                    .map(|re| re.is_match(&text))
                    .unwrap_or(false)
                {
                    Some("revise")
                } else if regex::Regex::new(r"(?i)(reject|deny|cancel|拒绝|取消)").map(|re| re.is_match(&text)).unwrap_or(false) {
                    Some("reject")
                } else {
                    None
                };
                let mut mapped = option.as_object().cloned().unwrap_or_default();
                if let Some(intent) = intent {
                    mapped.insert("intent".to_string(), json!(intent));
                }
                Value::Object(mapped)
            })
            .collect()
    } else {
        vec![]
    };
    (is_plan, questions, options)
}

fn is_plan_question(question: &Value, properties: &Value) -> bool {
    let tool = properties.get("tool").cloned().unwrap_or(Value::Null);
    let text = [
        tool.get("name").and_then(Value::as_str).or_else(|| tool.get("tool").and_then(Value::as_str)).unwrap_or("").to_string(),
        question.get("header").and_then(Value::as_str).unwrap_or("").to_string(),
        question.get("question").and_then(Value::as_str).unwrap_or("").to_string(),
        question
            .get("options")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .iter()
            .flat_map(|o| {
                vec![
                    o.get("label").and_then(Value::as_str).unwrap_or("").to_string(),
                    o.get("description").and_then(Value::as_str).unwrap_or("").to_string(),
                ]
            })
            .collect::<Vec<_>>()
            .join(" "),
    ]
    .join(" ");
    let plan = regex::Regex::new(r"(?i)(plan_exit|plan exit|plan|计划)").map(|re| re.is_match(&text)).unwrap_or(false);
    let action = regex::Regex::new(r"(?i)(build agent|implement|switch|start|执行|开始实现|切换)").map(|re| re.is_match(&text)).unwrap_or(false);
    plan && action
}

async fn read_plan(cwd: &str, question: &Value) -> Value {
    let text = question.get("question").and_then(Value::as_str).unwrap_or("");
    let path = regex::Regex::new(r"(?i)Plan at (.+?) is complete")
        .ok()
        .and_then(|re| re.captures(text))
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().trim().to_string());
    let Some(path) = path else {
        return json!({ "content": "" });
    };
    let absolute = if std::path::Path::new(&path).is_absolute() {
        std::path::PathBuf::from(&path)
    } else {
        std::path::Path::new(cwd).join(&path)
    };
    let lower = absolute.to_string_lossy().to_lowercase();
    if !(lower.ends_with(".md") || lower.ends_with(".mdown")) {
        return json!({ "content": "", "sourcePath": path });
    }
    let content = std::fs::read_to_string(&absolute).unwrap_or_default();
    json!({ "content": content, "sourcePath": path })
}

// ---------------------------------------------------------------- the run loop

#[async_trait::async_trait]
impl ProviderPlugin for OpenCodePlugin {
    fn descriptor(&self) -> Value {
        descriptor()
    }

    fn capabilities(&self) -> Value {
        json!({
            "structuredOutput": true,
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
        let executable = executable_of(instance);
        let (version, version_code) = capture(&executable, &["--version"], None).await;
        if version_code != Some(0) {
            return json!({
                "installed": false,
                "executable": executable,
                "error": if version.is_empty() { format!("exit {}", version_code.map(|c| c.to_string()).unwrap_or_else(|| "unknown".to_string())) } else { version }
            });
        }
        let (help, help_code) = capture(&executable, &["--help"], None).await;
        json!({
            "installed": true,
            "compatible": help_code == Some(0),
            "executable": executable,
            "version": version.trim(),
            "help": help.chars().take(16_384).collect::<String>(),
            "error": if help_code == Some(0) { Value::Null } else { Value::String(if help.is_empty() { format!("help exited with {}", help_code.map(|c| c.to_string()).unwrap_or_else(|| "unknown".to_string())) } else { help }) }
        })
    }

    async fn list_models(&self, instance: &Value, _context: &Value) -> anyhow::Result<Value> {
        let executable = executable_of(instance);
        let (text, code) = capture(&executable, &["models", "--verbose"], None).await;
        if code != Some(0) {
            anyhow::bail!(if text.trim().is_empty() {
                format!("opencode models --verbose exited with {}", code.map(|c| c.to_string()).unwrap_or_else(|| "unknown".to_string()))
            } else {
                text.trim().to_string()
            });
        }
        Ok(parse_opencode_models(&text))
    }

    async fn start(&self, _run_id: &str, request: Value, resume: Option<String>) -> anyhow::Result<mpsc::UnboundedReceiver<Value>> {
        let provider_command = request.get("providerCommand").and_then(Value::as_str).map(str::to_string);
        if provider_command.as_deref() == Some("compact") && resume.is_none() {
            anyhow::bail!("OpenCode context compaction requires an existing provider session");
        }
        let instance = request.get("instance").cloned().unwrap_or(Value::Null);
        let has_base_args = !base_args(&instance).is_empty();
        // Provider commands always use the server transport; `run` has no
        // headless summarize surface.
        if has_base_args && resume.is_none() {
            let args = start_args(&instance, &request);
            return self.spawn_run(request, args).await;
        }
        if has_base_args && provider_command.is_none() {
            let mut args = base_args(&instance);
            args.push("--session".to_string());
            args.push(resume.clone().unwrap_or_default());
            args.push(request.get("prompt").and_then(Value::as_str).unwrap_or("").to_string());
            return self.spawn_run(request, args).await;
        }
        let interactions = self.interactions.lock().unwrap().clone();
        self.server_run(request, resume, interactions).await
    }

    async fn dispose(&self) {
        let servers: Vec<Arc<Mutex<ManagedServer>>> = self.pool.lock().unwrap().servers.drain().map(|(_, s)| s).collect();
        for server in servers {
            let (handle, cleanup) = {
                let mut server = server.lock().unwrap();
                server.retire_when_idle = true;
                if server.active_runs == 0 {
                    (Some(server.handle.clone()), server.config_cleanup.clone())
                } else {
                    (None, None)
                }
            };
            if let Some(handle) = handle {
                restore_opencode_mcp_config(cleanup.as_ref());
                handle.cancel().await;
            }
        }
    }
}

impl OpenCodePlugin {
    async fn spawn_run(&self, request: Value, args: Vec<String>) -> anyhow::Result<mpsc::UnboundedReceiver<Value>> {
        let instance = request.get("instance").cloned().unwrap_or(Value::Null);
        let started = process::start(&ProcessRequest {
            command: executable_of(&instance),
            args,
            cwd: request.get("cwd").and_then(Value::as_str).map(str::to_string),
            env: Some(env_of(&request)),
            timeout_ms: request.get("timeoutMs").and_then(Value::as_u64),
            idle_timeout_ms: request.get("idleTimeoutMs").and_then(Value::as_u64),
            max_output_bytes: Some(request.get("maxOutputBytes").and_then(Value::as_u64).map(|v| v as usize).unwrap_or(20 * 1024 * 1024)),
            ..Default::default()
        })?;
        started.handle.end_stdin();
        let (sender, receiver) = mpsc::unbounded_channel::<Value>();
        tokio::spawn(async move {
            let _ = sender.send(json!({ "kind": "commands", "commands": native_commands() }));
            let mut pending_stdout = String::new();
            let mut pending_stderr = String::new();
            let mut events = started.events;
            while let Some(event) = events.recv().await {
                let is_stdout = matches!(&event, ProcessEvent::Stdout(_));
                match event {
                    ProcessEvent::Stdout(text) | ProcessEvent::Stderr(text) => {
                        let buffer = if is_stdout { &mut pending_stdout } else { &mut pending_stderr };
                        buffer.push_str(&text);
                        let mut lines: Vec<String> = buffer.split('\n').map(str::to_string).collect();
                        *buffer = lines.pop().unwrap_or_default();
                        for line in lines {
                            let line = line.trim_end_matches('\r');
                            if line.trim().is_empty() {
                                continue;
                            }
                            let parsed = serde_json::from_str::<Value>(line).ok().map(|v| parse_opencode_event(&v)).unwrap_or_default();
                            if parsed.is_empty() {
                                let _ = sender.send(json!({ "kind": "raw", "stream": if is_stdout { "stdout" } else { "stderr" }, "text": line }));
                            } else {
                                for event in parsed {
                                    if sender.send(event).is_err() {
                                        return;
                                    }
                                }
                            }
                        }
                    }
                    ProcessEvent::Exit { exit_code, .. } => {
                        let _ = sender.send(json!({ "kind": "exit", "exitCode": exit_code }));
                        return;
                    }
                    ProcessEvent::Error(message) => {
                        let _ = sender.send(json!({ "kind": "error", "message": message }));
                    }
                    ProcessEvent::Timeout { reason } => {
                        let _ = sender.send(json!({ "kind": "timeout", "reason": reason }));
                    }
                }
            }
        });
        Ok(receiver)
    }

    async fn server_run(
        &self,
        request: Value,
        resume: Option<String>,
        interactions: Option<Arc<dyn agenthub_plugin_sdk::InteractionChannel>>,
    ) -> anyhow::Result<mpsc::UnboundedReceiver<Value>> {
        let (sender, receiver) = mpsc::unbounded_channel::<Value>();
        let server = self.server_for(&request).await?;
        server.lock().unwrap().active_runs += 1;
        let server_for_task = server.clone();
        tokio::spawn(async move {
            let result = server_run_loop(request, resume, server, sender.clone(), interactions).await;
            if let Err(error) = result {
                let _ = sender.send(json!({ "kind": "error", "message": error.to_string() }));
                let _ = sender.send(json!({ "kind": "exit", "exitCode": 1 }));
            }
            let (handle, cleanup) = {
                let mut server = server_for_task.lock().unwrap();
                server.active_runs = server.active_runs.saturating_sub(1);
                if server.retire_when_idle && server.active_runs == 0 {
                    (Some(server.handle.clone()), server.config_cleanup.clone())
                } else {
                    (None, None)
                }
            };
            if let Some(handle) = handle {
                restore_opencode_mcp_config(cleanup.as_ref());
                handle.cancel().await;
            }
        });
        Ok(receiver)
    }
}

async fn server_run_loop(
    request: Value,
    resume: Option<String>,
    server: Arc<Mutex<ManagedServer>>,
    sender: mpsc::UnboundedSender<Value>,
    interactions: Option<Arc<dyn agenthub_plugin_sdk::InteractionChannel>>,
) -> anyhow::Result<()> {
    let (base_url, cwd) = {
        let server = server.lock().unwrap();
        (server.base_url.clone(), request.get("cwd").and_then(Value::as_str).unwrap_or("").to_string())
    };
    let _ = sender.send(json!({ "kind": "commands", "commands": native_commands() }));

    // Open the SSE event stream first so no event is missed.
    let client = reqwest::Client::new();
    let stream_response = client
        .get(directory_url(&base_url, &cwd, "/event"))
        .header("accept", "text/event-stream")
        .send()
        .await?;
    if !stream_response.status().is_success() {
        anyhow::bail!("OpenCode event stream failed ({})", stream_response.status().as_u16());
    }

    let mut session_id = resume;
    if session_id.is_none() {
        let title = request.get("prompt").and_then(Value::as_str).unwrap_or("").chars().take(80).collect::<String>();
        let created = api_json(&base_url, &cwd, "/session", "POST", Some(json!({ "title": title }))).await?;
        session_id = created.get("id").and_then(Value::as_str).map(str::to_string);
        if session_id.is_none() {
            anyhow::bail!("OpenCode server did not return a session id");
        }
    }
    let session_id = session_id.unwrap();
    let _ = sender.send(json!({ "kind": "session", "providerSessionId": session_id }));
    let _ = sender.send(json!({ "kind": "status", "phase": "turn_started" }));

    if request.get("providerCommand").and_then(Value::as_str) == Some("compact") {
        let model = resolve_summarize_model(&base_url, &cwd, &session_id, request.get("model").and_then(Value::as_str)).await?;
        api_json(
            &base_url,
            &cwd,
            &format!("/session/{}/summarize", urlencoding(&session_id)),
            "POST",
            Some(model),
        )
        .await?;
    } else {
        let instance = request.get("instance").cloned().unwrap_or(Value::Null);
        let mode = request
            .get("permissionMode")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|m| !m.is_empty())
            .map(str::to_string)
            .or_else(|| {
                instance
                    .get("providerOptions")
                    .and_then(|o| o.get("permissionMode"))
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|m| !m.is_empty())
                    .map(str::to_string)
            });
        let mut parts = vec![json!({ "type": "text", "text": request.get("prompt").and_then(Value::as_str).unwrap_or("") })];
        for path in request.get("localImagePaths").and_then(Value::as_array).cloned().unwrap_or_default() {
            if let Some(path) = path.as_str() {
                let filename = path.split(['/', '\\']).next_back().unwrap_or("image");
                parts.push(json!({
                    "type": "file",
                    "url": format!("file:///{path}"),
                    "filename": filename,
                    "mime": "application/octet-stream"
                }));
            }
        }
        let mut body = Map::new();
        if let Some(model) = opencode_model(request.get("model").and_then(Value::as_str)) {
            body.insert("model".to_string(), model);
        }
        if let Some(mode) = mode.as_deref() {
            if mode == "plan" || mode == "build" {
                body.insert("agent".to_string(), json!(mode));
            }
        }
        body.insert("parts".to_string(), Value::Array(parts));
        api_json(
            &base_url,
            &cwd,
            &format!("/session/{}/prompt_async", urlencoding(&session_id)),
            "POST",
            Some(Value::Object(body)),
        )
        .await?;
    }

    // Sub-agent (task tool) child sessions also publish on the event bus.
    let mut pending_task_parts: Vec<String> = vec![];
    let mut child_sessions: HashMap<String, String> = HashMap::new();
    let mut rejected_sessions: std::collections::HashSet<String> = std::collections::HashSet::new();
    // Part-id -> part type ("text"/"reasoning"/"tool"/...). OpenCode >=1.18.x
    // streams incremental output through `message.part.delta` events which only
    // carry a partID; we learn the part type from the preceding
    // `message.part.updated` events.
    let mut part_types: HashMap<String, String> = HashMap::new();
    // Deltas that arrive before their part type is known (rare reordering) are
    // buffered here until the matching `message.part.updated` arrives.
    let mut pending_deltas: HashMap<String, Vec<Value>> = HashMap::new();

    let mut stream = stream_response;
    let mut pending = String::new();
    loop {
        let chunk = match tokio::time::timeout(std::time::Duration::from_secs(600), stream.chunk()).await {
            Ok(Ok(Some(chunk))) => chunk,
            Ok(Ok(None)) => break,
            Ok(Err(error)) => anyhow::bail!(error.to_string()),
            Err(_) => anyhow::bail!("OpenCode event stream timed out"),
        };
        pending.push_str(&String::from_utf8_lossy(&chunk));
        let mut frames: Vec<String> = pending.split("\n\n").map(str::to_string).collect();
        pending = frames.pop().unwrap_or_default();
        for frame in frames {
            let data = frame
                .lines()
                .filter(|line| line.starts_with("data:"))
                .map(|line| line[5..].trim_start())
                .collect::<Vec<_>>()
                .join("\n");
            if data.is_empty() {
                continue;
            }
            let Ok(raw) = serde_json::from_str::<Value>(&data) else { continue };
            let event = unwrap_server_event(&raw);
            let properties = event.get("properties").cloned().unwrap_or(Value::Null);
            let event_type = event.get("type").and_then(Value::as_str).unwrap_or("").to_string();
            let event_session_id = properties.get("sessionID").and_then(Value::as_str).unwrap_or("").to_string();
            let known_child = !event_session_id.is_empty() && child_sessions.contains_key(&event_session_id);
            if !event_session_id.is_empty()
                && event_session_id != session_id
                && !known_child
                && event_type != "message.part.updated"
                && event_type != "message.part.delta"
            {
                continue;
            }
            match event_type.as_str() {
                "message.part.updated" => {
                    let part = properties.get("part").cloned().unwrap_or(Value::Null);
                    let part_session_id = part.get("sessionID").and_then(Value::as_str).unwrap_or("").to_string();
                    let is_main = part_session_id.is_empty() || part_session_id == session_id;
                    if is_main
                        && part.get("type").and_then(Value::as_str) == Some("tool")
                        && part.get("tool").and_then(Value::as_str) == Some("task")
                    {
                        let call_id = part
                            .get("callID")
                            .and_then(Value::as_str)
                            .or_else(|| part.get("id").and_then(Value::as_str))
                            .unwrap_or("")
                            .to_string();
                        if !call_id.is_empty() && !pending_task_parts.contains(&call_id) {
                            pending_task_parts.push(call_id.clone());
                        }
                        // Exact pairing: opencode puts the child session id into
                        // the task part's metadata before the child starts.
                        let child_id = part
                            .get("state")
                            .and_then(|s| s.get("metadata"))
                            .and_then(|m| m.get("sessionId"))
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string();
                        if !call_id.is_empty() && !child_id.is_empty() && !child_sessions.contains_key(&child_id) {
                            child_sessions.insert(child_id, call_id.clone());
                            if let Some(index) = pending_task_parts.iter().position(|p| p == &call_id) {
                                pending_task_parts.remove(index);
                            }
                        }
                    }
                    let mut dispatch_id: Option<String> = None;
                    if !is_main {
                        dispatch_id = child_sessions.get(&part_session_id).cloned();
                        if dispatch_id.is_none() && !rejected_sessions.contains(&part_session_id) {
                            let parent = fetch_session_parent(&base_url, &cwd, &part_session_id).await;
                            if parent.as_deref() == Some(session_id.as_str()) {
                                if !pending_task_parts.is_empty() {
                                    let dispatch = pending_task_parts.remove(0);
                                    child_sessions.insert(part_session_id.clone(), dispatch.clone());
                                    dispatch_id = Some(dispatch);
                                }
                            } else {
                                rejected_sessions.insert(part_session_id.clone());
                            }
                        }
                        if dispatch_id.is_none() {
                            continue;
                        }
                    }
                    // Remember the part's type so later `message.part.delta`
                    // events for the same part can be classified as
                    // thinking/message, and flush any deltas that arrived
                    // before this update (out-of-order frames).
                    let part_id = part
                        .get("id")
                        .and_then(Value::as_str)
                        .or_else(|| part.get("partID").and_then(Value::as_str))
                        .map(str::to_string);
                    if let Some(part_id) = &part_id {
                        if let Some(part_type) = part.get("type").and_then(Value::as_str) {
                            part_types.insert(part_id.clone(), part_type.to_string());
                            if let Some(pending) = pending_deltas.remove(part_id) {
                                for event in match &dispatch_id {
                                    Some(id) => with_subagent_dispatch(pending, id),
                                    None => pending,
                                } {
                                    if sender.send(event).is_err() {
                                        return Ok(());
                                    }
                                }
                            }
                        }
                    }
                    let delta = properties.get("delta").and_then(Value::as_str);
                    let events = parse_opencode_part(&part, &raw, delta);
                    for event in match dispatch_id {
                        Some(id) => with_subagent_dispatch(events, &id),
                        None => events,
                    } {
                        if sender.send(event).is_err() {
                            return Ok(());
                        }
                    }
                }
                // OpenCode >=1.18.x streams part output as dedicated
                // `message.part.delta` events (properties.partID / delta).
                // Older versions carried the delta on `message.part.updated`
                // instead; both are handled so the plugin keeps working across
                // opencode versions.
                "message.part.delta" => {
                    let part_id = properties.get("partID").and_then(Value::as_str).unwrap_or("").to_string();
                    let delta_text = properties.get("delta").and_then(Value::as_str).unwrap_or("").to_string();
                    if part_id.is_empty() || delta_text.is_empty() {
                        continue;
                    }
                    let message_id = properties
                        .get("messageID")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                        .map(Value::String)
                        .unwrap_or(Value::Null);
                    let mut dispatch_id: Option<String> = None;
                    if !event_session_id.is_empty() && event_session_id != session_id {
                        dispatch_id = child_sessions.get(&event_session_id).cloned();
                        if dispatch_id.is_none() && !rejected_sessions.contains(&event_session_id) {
                            let parent = fetch_session_parent(&base_url, &cwd, &event_session_id).await;
                            if parent.as_deref() == Some(session_id.as_str()) {
                                if !pending_task_parts.is_empty() {
                                    let dispatch = pending_task_parts.remove(0);
                                    child_sessions.insert(event_session_id.clone(), dispatch.clone());
                                    dispatch_id = Some(dispatch);
                                }
                            } else {
                                rejected_sessions.insert(event_session_id.clone());
                            }
                        }
                        if dispatch_id.is_none() {
                            continue;
                        }
                    }
                    let part_type = part_types.get(&part_id).map(|s| s.as_str()).unwrap_or("");
                    let kind = if part_type == "reasoning" { "thinking" } else { "message" };
                    let event = json!({
                        "kind": kind,
                        "phase": "delta",
                        "messageId": message_id,
                        "text": delta_text,
                        "raw": raw
                    });
                    if part_type.is_empty() {
                        pending_deltas.entry(part_id).or_default().push(event);
                    } else {
                        let event = match &dispatch_id {
                            Some(id) => with_subagent_dispatch(vec![event], id).remove(0),
                            None => event,
                        };
                        if sender.send(event).is_err() {
                            return Ok(());
                        }
                    }
                }
                "question.asked" => {
                    if !event_session_id.is_empty() && event_session_id != session_id {
                        continue;
                    }
                    handle_question(&base_url, &cwd, &request, &properties, interactions.clone()).await;
                }
                "permission.asked" => {
                    if !event_session_id.is_empty() && event_session_id != session_id {
                        continue;
                    }
                    handle_permission(&base_url, &cwd, &properties, interactions.clone(), &session_id).await;
                }
                "session.status" => {
                    if !event_session_id.is_empty() && event_session_id != session_id {
                        continue;
                    }
                    let status_type = properties
                        .get("status")
                        .and_then(|s| s.get("type"))
                        .and_then(Value::as_str)
                        .or_else(|| properties.get("status").and_then(Value::as_str))
                        .unwrap_or("");
                    if status_type != "idle" {
                        continue;
                    }
                    let _ = sender.send(json!({ "kind": "status", "phase": "turn_completed", "raw": raw }));
                    let _ = sender.send(json!({ "kind": "exit", "exitCode": 0 }));
                    return Ok(());
                }
                "session.error" => {
                    if !event_session_id.is_empty() && event_session_id != session_id {
                        continue;
                    }
                    let message = properties
                        .get("error")
                        .and_then(|e| e.get("data"))
                        .and_then(|d| d.get("message"))
                        .and_then(Value::as_str)
                        .or_else(|| properties.get("error").and_then(|e| e.get("message")).and_then(Value::as_str))
                        .unwrap_or("OpenCode session failed");
                    let _ = sender.send(json!({ "kind": "status", "phase": "turn_failed", "raw": raw }));
                    let _ = sender.send(json!({ "kind": "error", "message": message }));
                    // Every terminal path must end the stream — the daemon
                    // finalizes the turn only when the exit frame arrives.
                    let _ = sender.send(json!({ "kind": "exit", "exitCode": 1 }));
                    return Ok(());
                }
                _ => {}
            }
        }
    }
    Ok(())
}

fn unwrap_server_event(value: &Value) -> Value {
    let payload = value.get("payload").cloned().unwrap_or(Value::Null);
    if payload.get("type").is_some() {
        payload
    } else {
        value.clone()
    }
}

fn opencode_model(model: Option<&str>) -> Option<Value> {
    let model = model?;
    let slash = model.find('/')?;
    if slash == 0 {
        return None;
    }
    Some(json!({ "providerID": &model[..slash], "modelID": &model[slash + 1..] }))
}

async fn resolve_summarize_model(base_url: &str, cwd: &str, session_id: &str, model: Option<&str>) -> anyhow::Result<Value> {
    if let Some(model) = opencode_model(model) {
        return Ok(model);
    }
    let messages = api_json(base_url, cwd, &format!("/session/{}/message", urlencoding(session_id)), "GET", None).await?;
    let list = messages.as_array().cloned().unwrap_or_default();
    for entry in list.iter().rev() {
        let info = entry.get("info").cloned().unwrap_or(Value::Null);
        if info.get("role").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        let provider = info.get("providerID").and_then(Value::as_str);
        let model = info.get("modelID").and_then(Value::as_str);
        if let (Some(provider), Some(model)) = (provider, model) {
            return Ok(json!({ "providerID": provider, "modelID": model }));
        }
    }
    anyhow::bail!("OpenCode summarize needs a model; pick a session model first")
}

async fn fetch_session_parent(base_url: &str, cwd: &str, child_session_id: &str) -> Option<String> {
    let info = api_json(base_url, cwd, &format!("/session/{}", urlencoding(child_session_id)), "GET", None).await.ok()?;
    info.get("parentID").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string)
}

async fn handle_question(
    base_url: &str,
    cwd: &str,
    request: &Value,
    properties: &Value,
    interactions: Option<Arc<dyn agenthub_plugin_sdk::InteractionChannel>>,
) {
    let request_id = properties
        .get("id")
        .and_then(Value::as_str)
        .or_else(|| properties.get("requestID").and_then(Value::as_str))
        .unwrap_or("")
        .to_string();
    if request_id.is_empty() {
        return;
    }
    let reject_path = format!("/question/{}/reject", urlencoding(&request_id));
    let reject = || api_json(base_url, cwd, &reject_path, "POST", None);
    let Some(channel) = interactions else {
        let _ = reject().await;
        return;
    };
    let channel = channel.clone();
    let (is_plan, questions, options) = classify_question(properties);
    if is_plan {
        let question = questions.first().cloned().unwrap_or(Value::Null);
        let plan = read_plan(cwd, &question).await;
        let response = channel
            .ask("", json!({ "kind": "plan_approval", "title": "计划已就绪", "plan": plan, "options": options }))
            .await;
        let option_id = response.get("optionId").and_then(Value::as_str);
        let selected = options.iter().find(|option| option.get("id").and_then(Value::as_str) == option_id);
        if response.get("outcome").and_then(Value::as_str) == Some("selected") {
            if let Some(selected) = selected {
                let label = selected.get("label").cloned().unwrap_or(Value::Null);
                let _ = api_json(
                    base_url,
                    cwd,
                    &format!("/question/{}/reply", urlencoding(&request_id)),
                    "POST",
                    Some(json!({ "answers": [[label]] })),
                )
                .await;
                return;
            }
        }
        let _ = reject().await;
        return;
    }
    let response = channel
        .ask("", json!({ "kind": "question", "title": "OpenCode question", "questions": questions }))
        .await;
    if response.get("outcome").and_then(Value::as_str) != Some("selected") {
        let _ = reject().await;
        return;
    }
    let answers: Vec<Value> = questions
        .iter()
        .map(|question| {
            let id = question.get("id").and_then(Value::as_str).unwrap_or("");
            response.get("answers").and_then(|a| a.get(id)).cloned().unwrap_or_else(|| json!([]))
        })
        .collect();
    let _ = api_json(
        base_url,
        cwd,
        &format!("/question/{}/reply", urlencoding(&request_id)),
        "POST",
        Some(json!({ "answers": answers })),
    )
    .await;
    let _ = request;
}

async fn handle_permission(
    base_url: &str,
    cwd: &str,
    properties: &Value,
    interactions: Option<Arc<dyn agenthub_plugin_sdk::InteractionChannel>>,
    run_id: &str,
) {
    let request_id = properties
        .get("id")
        .and_then(Value::as_str)
        .or_else(|| properties.get("requestID").and_then(Value::as_str))
        .unwrap_or("")
        .to_string();
    if request_id.is_empty() {
        return;
    }
    let mut reply = "reject".to_string();
    if let Some(channel) = interactions.clone() {
        let patterns: Vec<String> = properties
            .get("patterns")
            .and_then(Value::as_array)
            .map(|p| p.iter().filter_map(Value::as_str).map(str::to_string).collect())
            .unwrap_or_default();
        let mut detail_parts = patterns;
        if let Some(metadata) = properties.get("metadata") {
            detail_parts.push(serde_json::to_string_pretty(metadata).unwrap_or_default());
        }
        let response = channel
            .ask(
                run_id,
                json!({
                    "kind": "approval",
                    "title": properties.get("permission").and_then(Value::as_str).unwrap_or("OpenCode permission"),
                    "detail": detail_parts.join("\n"),
                    "options": [
                        { "id": "once", "label": "Allow once" },
                        { "id": "always", "label": "Always allow" },
                        { "id": "reject", "label": "Reject" }
                    ]
                }),
            )
            .await;
        if response.get("outcome").and_then(Value::as_str) == Some("selected") {
            if let Some(option_id) = response.get("optionId").and_then(Value::as_str) {
                reply = match option_id {
                    "once" | "always" => option_id.to_string(),
                    _ => "reject".to_string(),
                };
            }
        }
    }
    let _ = api_json(
        base_url,
        cwd,
        &format!("/permission/{}/reply", urlencoding(&request_id)),
        "POST",
        Some(json!({ "reply": reply })),
    )
    .await;
}

// ---------------------------------------------------------------- models

/// Parses `opencode models --verbose`: one provider/model id line per model,
/// each followed by a pretty-printed JSON block.
fn parse_opencode_models(text: &str) -> Value {
    let mut models: Vec<Value> = vec![];
    let mut json_lines: Option<Vec<String>> = None;
    let id_line = regex::Regex::new(r"^[\w.-]+/[\w.:-]+$").unwrap();
    for line in text.lines() {
        if let Some(buffer) = &mut json_lines {
            buffer.push(line.to_string());
            // Only a brace at column 0 closes the model's block.
            if line == "}" {
                let block = buffer.join("\n");
                json_lines = None;
                if let Some(last) = models.last_mut() {
                    enrich_model(last, &block);
                }
            }
            continue;
        }
        let trimmed = line.trim();
        if line == "{" {
            json_lines = Some(vec![line.to_string()]);
        } else if id_line.is_match(trimmed) {
            models.push(json!({
                "id": trimmed,
                "displayName": trimmed,
                "isDefault": false,
                "capabilities": [],
                "reasoningEfforts": [],
                "serviceTiers": []
            }));
        }
    }
    json!({
        "providerId": "opencode",
        "models": models,
        "source": "provider_cli",
        "fetchedAt": now_iso()
    })
}

fn enrich_model(model: &mut Value, json_text: &str) {
    let Ok(meta) = serde_json::from_str::<Value>(json_text) else {
        return;
    };
    let Some(object) = model.as_object_mut() else { return };
    if let Some(name) = meta.get("name").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()) {
        object.insert("displayName".to_string(), json!(name));
    }
    if let Some(context) = meta.get("limit").and_then(|l| l.get("context")).and_then(Value::as_i64) {
        object.insert("contextWindow".to_string(), json!(context));
    }
    if let Some(status) = meta.get("status").and_then(Value::as_str) {
        if status != "active" {
            object.insert("description".to_string(), json!(format!("status: {status}")));
        }
    }
    // Reasoning efforts are the model's variant keys (run --variant <key>).
    if let Some(variants) = meta.get("variants").and_then(Value::as_object) {
        object.insert("reasoningEfforts".to_string(), json!(variants.keys().collect::<Vec<_>>()));
    }
}

fn start_args(instance: &Value, request: &Value) -> Vec<String> {
    let custom = base_args(instance);
    if !custom.is_empty() {
        return custom.into_iter().chain(std::iter::once(request.get("prompt").and_then(Value::as_str).unwrap_or("").to_string())).collect();
    }
    let mut args = vec!["run".to_string(), "--format".to_string(), "json".to_string()];
    if let Some(model) = request.get("model").and_then(Value::as_str).filter(|m| !m.is_empty()) {
        args.push("--model".to_string());
        args.push(model.to_string());
    }
    // OpenCode's reasoning effort is a model "variant" (run --variant).
    if let Some(effort) = request.get("reasoningEffort").and_then(Value::as_str).filter(|e| !e.is_empty()) {
        args.push("--variant".to_string());
        args.push(effort.to_string());
    }
    args.push(request.get("prompt").and_then(Value::as_str).unwrap_or("").to_string());
    args
}

#[tokio::main]
async fn main() {
    agenthub_plugin_sdk::serve(OpenCodePlugin::new()).await;
}
