//! Codex adapter — port of adapters/codex/{adapter,commands,executable,
//! mcp-config,provider-config,models}.ts. The run loops live in
//! app_server.rs / chat_compat.rs; event parsers in events.rs.

use std::collections::HashMap;
use std::path::Path;

use serde_json::{json, Map, Value};

use crate::adapters::{
    AdapterDetectionResult, AdapterResumeRequest, AdapterRun, AdapterStartRequest, AgentCliAdapter,
};
use crate::errors::{CoreError, CoreResult, ErrorCode};
use crate::process_runtime::{ProcessEvent, ProcessRequest, ProcessRuntime};
use crate::errors::now_iso;

pub mod app_server;
pub mod chat_compat;
mod anthropic_compat;
pub mod events;
pub mod image_gen;

pub const AGENTHUB_CODEX_PROVIDER_ID: &str = "agenthub_proxy";
pub const AGENTHUB_CODEX_API_KEY_ENV: &str = "OPENAI_API_KEY";

fn str_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn base_args(instance: &Value) -> Vec<String> {
    instance
        .get("baseArgs")
        .and_then(Value::as_array)
        .map(|args| args.iter().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or_default()
}

fn provider_option<'a>(instance: &'a Value, key: &str) -> Option<&'a str> {
    instance.get("providerOptions").and_then(|o| o.get(key)).and_then(Value::as_str)
}

pub fn resolve_codex_wire_api(instance: &Value) -> &'static str {
    if provider_option(instance, "wireApi") == Some("anthropic") {
        "anthropic"
    } else if provider_option(instance, "wireApi") == Some("chat") {
        "chat"
    } else {
        "responses"
    }
}

fn toml_string(value: &str) -> String {
    json!(value).to_string()
}

fn toml_key(name: &str) -> String {
    if name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') && !name.is_empty() {
        name.to_string()
    } else {
        json!(name).to_string()
    }
}

/// Converts Nautilo's per-instance endpoint into invocation-scoped Codex
/// configuration (never touches the user's config.toml).
pub fn build_codex_provider_config_args(
    instance: &Value,
    environment: Option<&HashMap<String, String>>,
    wire_api_override: Option<&str>,
) -> CoreResult<Vec<String>> {
    let Some(base_url) = configured_base_url(instance)? else {
        return Ok(vec![]);
    };
    let wire_api = wire_api_override.unwrap_or_else(|| resolve_codex_wire_api(instance));
    let prefix = format!("model_providers.{AGENTHUB_CODEX_PROVIDER_ID}");
    let mut args = vec![
        "--config".to_string(),
        format!("model_provider={}", toml_string(AGENTHUB_CODEX_PROVIDER_ID)),
        "--config".to_string(),
        format!("{prefix}.name={}", toml_string("Nautilo custom endpoint")),
        "--config".to_string(),
        format!("{prefix}.base_url={}", toml_string(&base_url)),
        "--config".to_string(),
        format!("{prefix}.wire_api={}", toml_string(wire_api)),
    ];
    if environment.and_then(|env| env.get(AGENTHUB_CODEX_API_KEY_ENV)).is_some_and(|v| !v.is_empty()) {
        args.push("--config".to_string());
        args.push(format!("{prefix}.env_key={}", toml_string(AGENTHUB_CODEX_API_KEY_ENV)));
    }
    Ok(args)
}

pub fn configured_base_url(instance: &Value) -> CoreResult<Option<String>> {
    let raw = provider_option(instance, "baseUrl").map(str::trim).filter(|s| !s.is_empty());
    let Some(value) = raw else {
        return Ok(None);
    };
    if !(value.to_lowercase().starts_with("http://") || value.to_lowercase().starts_with("https://")) {
        return Err(CoreError::reason(ErrorCode::IpcInvalidRequest, format!("Invalid Codex API base URL: {value}")));
    }
    Ok(Some(value.trim_end_matches('/').to_string()))
}

/// Codex -c key=value config overrides for user-managed MCP servers
/// (TOML-encoded).
pub fn build_codex_mcp_config_args(servers: &[Value]) -> Vec<String> {
    let mut args = vec![];
    for server in servers {
        let name = server.get("name").and_then(Value::as_str).unwrap_or("mcp");
        let key = format!("mcp_servers.{}", toml_key(name));
        let transport = server.get("transport").and_then(Value::as_str).unwrap_or("");
        if transport == "stdio" {
            if let Some(command) = server.get("command").and_then(Value::as_str) {
                args.push("-c".to_string());
                args.push(format!("{key}.command={}", toml_string(command)));
                if let Some(list) = server.get("args").and_then(Value::as_array).filter(|a| !a.is_empty()) {
                    let values: Vec<String> = list.iter().filter_map(Value::as_str).map(toml_string).collect();
                    args.push("-c".to_string());
                    args.push(format!("{key}.args=[{}]", values.join(", ")));
                }
                if let Some(env) = server.get("env").and_then(Value::as_object).filter(|e| !e.is_empty()) {
                    let pairs: Vec<String> = env
                        .iter()
                        .map(|(k, v)| format!("{} = {}", toml_key(k), toml_string(v.as_str().unwrap_or(""))))
                        .collect();
                    args.push("-c".to_string());
                    args.push(format!("{key}.env={{ {} }}", pairs.join(", ")));
                }
                if let Some(cwd) = server.get("cwd").and_then(Value::as_str) {
                    args.push("-c".to_string());
                    args.push(format!("{key}.cwd={}", toml_string(cwd)));
                }
            }
        } else if transport == "http" {
            if let Some(url) = server.get("url").and_then(Value::as_str) {
                args.push("-c".to_string());
                args.push(format!("{key}.url={}", toml_string(url)));
                if let Some(headers) = server.get("headers").and_then(Value::as_object).filter(|h| !h.is_empty()) {
                    let pairs: Vec<String> = headers
                        .iter()
                        .map(|(k, v)| format!("{} = {}", toml_key(k), toml_string(v.as_str().unwrap_or(""))))
                        .collect();
                    args.push("-c".to_string());
                    args.push(format!("{key}.headers={{ {} }}", pairs.join(", ")));
                }
            }
        }
    }
    args
}

/// Maps the CLI-native permission mode onto Codex approval policy + sandbox.
pub fn codex_permission_config(instance: &Value, request: Option<&AdapterStartRequest>) -> Option<(&'static str, &'static str)> {
    let normalize = |value: Option<&str>| value.map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);
    let mode = normalize(request.and_then(|r| r.permission_mode.as_deref()))
        .or_else(|| normalize(provider_option(instance, "permissionMode")));
    match mode.as_deref() {
        Some("ask") => Some(("on-request", "workspace-write")),
        Some("auto") => Some(("on-failure", "workspace-write")),
        Some("full-access") => Some(("never", "danger-full-access")),
        _ => None,
    }
}

fn permission_args(instance: &Value, request: Option<&AdapterStartRequest>) -> Vec<String> {
    match codex_permission_config(instance, request) {
        Some((approval, sandbox)) => vec![
            "--ask-for-approval".to_string(),
            approval.to_string(),
            "--sandbox".to_string(),
            sandbox.to_string(),
        ],
        None => vec![],
    }
}

fn default_start_args(instance: &Value, request: Option<&AdapterStartRequest>) -> Vec<String> {
    let mut args = vec!["exec".to_string(), "--json".to_string()];
    args.extend(permission_args(instance, request));
    if let Some(request) = request {
        if let Some(model) = request.model.as_deref().filter(|m| !m.is_empty()) {
            args.push("--model".to_string());
            args.push(model.to_string());
        }
        if let Some(effort) = request.reasoning_effort.as_deref().filter(|e| !e.is_empty()) {
            args.push("--config".to_string());
            args.push(format!("model_reasoning_effort={}", toml_string(effort)));
        }
        if let Some(tier) = request.service_tier.as_deref().filter(|t| !t.is_empty() && *t != "standard") {
            args.push("--config".to_string());
            args.push(format!("service_tier={}", toml_string(tier)));
        }
    }
    if let Some(profile) = str_field(instance, "profile").filter(|p| !p.is_empty()) {
        args.push("--profile".to_string());
        args.push(profile.to_string());
    }
    args
}

fn default_resume_args(instance: &Value, request: Option<&AdapterStartRequest>) -> Vec<String> {
    let mut args = vec!["exec".to_string(), "resume".to_string(), "--json".to_string()];
    args.extend(permission_args(instance, request));
    if let Some(request) = request {
        if let Some(model) = request.model.as_deref().filter(|m| !m.is_empty()) {
            args.push("--model".to_string());
            args.push(model.to_string());
        }
        if let Some(effort) = request.reasoning_effort.as_deref().filter(|e| !e.is_empty()) {
            args.push("--config".to_string());
            args.push(format!("model_reasoning_effort={}", toml_string(effort)));
        }
        if let Some(tier) = request.service_tier.as_deref().filter(|t| !t.is_empty() && *t != "standard") {
            args.push("--config".to_string());
            args.push(format!("service_tier={}", toml_string(tier)));
        }
    }
    args
}

pub fn build_codex_start_args(instance: &Value, prompt: &str, request: Option<&AdapterStartRequest>) -> CoreResult<Vec<String>> {
    let custom = base_args(instance);
    let mut args = if custom.is_empty() { default_start_args(instance, request) } else { custom };
    args.extend(build_codex_provider_config_args(instance, request.and_then(|r| r.env.as_ref()), None)?);
    let schema = request
        .and_then(|r| r.output_schema_path.clone())
        .or_else(|| provider_option(instance, "outputSchemaPath").map(str::to_string));
    if let Some(schema) = schema {
        if !args.iter().any(|a| a == "--output-schema") {
            args.push("--output-schema".to_string());
            args.push(schema);
        }
    }
    args.push(prompt.to_string());
    Ok(args)
}

pub fn build_codex_resume_args(
    instance: &Value,
    session_id: &str,
    prompt: &str,
    request: Option<&AdapterStartRequest>,
) -> CoreResult<Vec<String>> {
    let custom = base_args(instance);
    let mut args = if custom.is_empty() {
        default_resume_args(instance, request)
    } else {
        custom.into_iter().chain(std::iter::once("resume".to_string())).collect()
    };
    args.extend(build_codex_provider_config_args(instance, request.and_then(|r| r.env.as_ref()), None)?);
    args.push(session_id.to_string());
    args.push(prompt.to_string());
    Ok(args)
}

/// Windows: npm codex shims resolve to the bundled node + codex.js when the
/// package layout is the official one (port of executable.ts).
pub fn resolve_codex_invocation(executable: &str, args: &[String], path_value: Option<&str>) -> (String, Vec<String>) {
    if !cfg!(windows) || executable.to_lowercase().ends_with(".exe") {
        return (executable.to_string(), args.to_vec());
    }
    let bin_directory = npm_bin_directory(executable, path_value);
    let Some(bin_directory) = bin_directory else {
        return (executable.to_string(), args.to_vec());
    };
    let entrypoint = Path::new(&bin_directory)
        .join("node_modules")
        .join("@openai")
        .join("codex")
        .join("bin")
        .join("codex.js");
    if !entrypoint.exists() {
        return (executable.to_string(), args.to_vec());
    }
    let bundled_node = Path::new(&bin_directory).join("node.exe");
    let node = if bundled_node.exists() {
        bundled_node.to_string_lossy().into_owned()
    } else {
        // The TS daemon fell back to process.execPath here, which WAS node;
        // in the Rust daemon current_exe() is nautilo-core itself and cannot
        // run a JS entrypoint. Find a real node on the effective PATH.
        find_on_path("node.exe", path_value).unwrap_or_else(|| "node".to_string())
    };
    let mut full_args = vec![entrypoint.to_string_lossy().into_owned()];
    full_args.extend(args.iter().cloned());
    (node, full_args)
}

fn npm_bin_directory(executable: &str, path_value: Option<&str>) -> Option<String> {
    if Path::new(executable).is_absolute() {
        return Path::new(executable).parent().map(|p| p.to_string_lossy().into_owned());
    }
    let path_value = match path_value {
        Some(value) => value.to_string(),
        None => std::env::var("PATH").unwrap_or_default(),
    };
    for directory in path_value.split(';').filter(|d| !d.is_empty()) {
        if Path::new(directory).join("node_modules").join("@openai").join("codex").join("bin").join("codex.js").exists() {
            return Some(directory.to_string());
        }
    }
    None
}

/// Locates an executable by name across the effective PATH (falling back to
/// the process PATH when the caller did not override it).
fn find_on_path(name: &str, path_value: Option<&str>) -> Option<String> {
    let path_value = match path_value {
        Some(value) => value.to_string(),
        None => std::env::var("PATH").unwrap_or_default(),
    };
    for directory in path_value.split(';').filter(|d| !d.is_empty()) {
        let candidate = Path::new(directory).join(name);
        if candidate.is_file() {
            return Some(candidate.to_string_lossy().into_owned());
        }
    }
    None
}

// ---------------------------------------------------------------- models

const CODEX_API_MODEL_REASONING_EFFORTS: [&str; 5] = ["minimal", "low", "medium", "high", "xhigh"];
const DEFAULT_CODEX_API_BASE_URL: &str = "https://api.openai.com/v1";

pub fn parse_codex_api_model_list(value: &Value) -> Value {
    let models: Vec<Value> = value
        .get("data")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter_map(|entry| {
            let id = entry.get("id").and_then(Value::as_str)?.trim().to_string();
            if id.is_empty() {
                return None;
            }
            Some(json!({
                "id": id,
                "displayName": id,
                "isDefault": false,
                "capabilities": [],
                "reasoningEfforts": CODEX_API_MODEL_REASONING_EFFORTS,
                "serviceTiers": []
            }))
        })
        .collect();
    json!({
        "providerId": "codex",
        "models": models,
        "source": "provider_api",
        "fetchedAt": now_iso()
    })
}

async fn discover_codex_models_via_api(instance: &Value, env: &HashMap<String, String>) -> CoreResult<Option<Value>> {
    let configured = provider_option(instance, "baseUrl").map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);
    let base_url_option = configured.or_else(|| env.get("OPENAI_BASE_URL").map(|v| v.trim().to_string()).filter(|s| !s.is_empty()));
    let api_key = env
        .get("OPENAI_API_KEY")
        .map(|v| v.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| env.get("CODEX_API_KEY").map(|v| v.trim().to_string()).filter(|s| !s.is_empty()));
    if base_url_option.is_none() && api_key.is_none() {
        return Ok(None);
    }
    let base_url = base_url_option.unwrap_or_else(|| DEFAULT_CODEX_API_BASE_URL.to_string());
    let base_url = crate::adapters::model_config::validated_model_endpoint(&base_url)?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_millis(10_000))
        .build()
        .map_err(|e| CoreError::reason(ErrorCode::IpcInternalError, e.to_string()))?;
    let mut request = client.get(format!("{base_url}/models")).header("accept", "application/json");
    if let Some(key) = &api_key {
        request = request.header("authorization", format!("Bearer {key}"));
    }
    let response = request.send().await.map_err(|e| CoreError::reason(ErrorCode::IpcInternalError, e.to_string()))?;
    if !response.status().is_success() {
        return Err(CoreError::reason(
            ErrorCode::IpcInternalError,
            format!("Codex API /models request failed ({})", response.status().as_u16()),
        ));
    }
    let body: Value = response.json().await.map_err(|e| CoreError::reason(ErrorCode::IpcInternalError, e.to_string()))?;
    let catalog = parse_codex_api_model_list(&body);
    if catalog.get("models").and_then(Value::as_array).is_none_or(|m| m.is_empty()) {
        return Err(CoreError::reason(ErrorCode::IpcInternalError, "Codex API /models returned an empty list"));
    }
    Ok(Some(catalog))
}

/// Uses Codex's app-server model/list endpoint for the local catalog.
async fn discover_codex_models_via_cli(instance: &Value, env: &HashMap<String, String>) -> CoreResult<Value> {
    let executable = str_field(instance, "executable").unwrap_or("codex");
    let args = app_server::build_codex_app_server_args(instance, Some(env), None, None)?;
    let (command, args) = resolve_codex_invocation(executable, &args, env.get("PATH").map(String::as_str));
    let started = ProcessRuntime::start(&ProcessRequest {
        command,
        args,
        env: Some(env.clone()),
        timeout_ms: Some(20_000),
        idle_timeout_ms: Some(12_000),
        max_output_bytes: Some(4 * 1024 * 1024),
        ..Default::default()
    })
    .map_err(|e| CoreError::reason(ErrorCode::IpcInternalError, e.to_string()))?;
    let handle = started.handle.clone();
    handle.write(&format!("{}\n", json!({ "method": "initialize", "id": 0, "params": app_server::codex_app_server_initialize_params() })));
    handle.write(&format!("{}\n", json!({ "method": "initialized" })));
    handle.write(&format!("{}\n", json!({ "method": "model/list", "id": 1, "params": { "limit": 200, "includeHidden": false } })));

    let mut events = started.events;
    let mut stdout = String::new();
    let mut result: Option<Value> = None;
    while let Some(event) = events.recv().await {
        match event {
            ProcessEvent::Stdout(text) => {
                stdout.push_str(&text);
                while let Some(index) = stdout.find('\n') {
                    let line = stdout[..index].trim().to_string();
                    stdout = stdout[index + 1..].to_string();
                    if line.is_empty() {
                        continue;
                    }
                    if let Ok(value) = serde_json::from_str::<Value>(&line) {
                        if value.get("id").and_then(Value::as_i64) == Some(1) {
                            result = Some(value);
                        }
                    }
                }
                if result.is_some() {
                    break;
                }
            }
            ProcessEvent::Exit { .. } | ProcessEvent::Timeout { .. } | ProcessEvent::Error(_) => break,
            _ => {}
        }
    }
    handle.cancel().await;
    let response = result.ok_or_else(|| CoreError::reason(ErrorCode::IpcInternalError, "Codex app-server did not answer model/list"))?;
    let data = response
        .get("result")
        .and_then(|r| r.get("data"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let models: Vec<Value> = data
        .iter()
        .filter_map(|entry| {
            let id = entry.get("id").and_then(Value::as_str)?.to_string();
            let mut model = Map::new();
            model.insert("id".to_string(), json!(id));
            model.insert(
                "displayName".to_string(),
                entry.get("displayName").and_then(Value::as_str).map(|s| json!(s)).unwrap_or_else(|| json!(id)),
            );
            model.insert("isDefault".to_string(), json!(entry.get("isDefault").and_then(Value::as_bool).unwrap_or(false)));
            for key in ["description", "contextWindow"] {
                if let Some(value) = entry.get(key) {
                    if !value.is_null() {
                        model.insert(key.to_string(), value.clone());
                    }
                }
            }
            for (key, target) in [("supportedReasoningEfforts", "reasoningEfforts"), ("capabilities", "capabilities"), ("serviceTiers", "serviceTiers")] {
                if let Some(value) = entry.get(key).and_then(Value::as_array) {
                    let mapped: Vec<Value> = if key == "supportedReasoningEfforts" {
                        value
                            .iter()
                            .filter_map(|effort| effort.get("effort").and_then(Value::as_str).map(|s| json!(s)).or_else(|| effort.as_str().map(|s| json!(s))))
                            .collect()
                    } else {
                        value.clone()
                    };
                    model.insert(target.to_string(), Value::Array(mapped));
                }
            }
            for key in ["reasoningEfforts", "capabilities", "serviceTiers"] {
                model.entry(key.to_string()).or_insert_with(|| json!([]));
            }
            Some(Value::Object(model))
        })
        .collect();
    let default_model = data
        .iter()
        .find(|entry| entry.get("isDefault").and_then(Value::as_bool).unwrap_or(false))
        .and_then(|entry| entry.get("id"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| models.first().and_then(|m| m.get("id")).and_then(Value::as_str).map(str::to_string));
    let mut catalog = Map::new();
    catalog.insert("providerId".to_string(), json!("codex"));
    catalog.insert("models".to_string(), Value::Array(models));
    if let Some(default_model) = default_model {
        catalog.insert("defaultModel".to_string(), json!(default_model));
    }
    catalog.insert("source".to_string(), json!("provider_cli"));
    catalog.insert("fetchedAt".to_string(), json!(now_iso()));
    Ok(Value::Object(catalog))
}

/// API-first discovery; only official-account discovery may fall back to the local CLI.
pub async fn discover_codex_models(instance: &Value, context: Option<&Value>) -> CoreResult<Value> {
    let env: HashMap<String, String> = context
        .and_then(|c| c.get("env"))
        .and_then(Value::as_object)
        .map(|env| env.iter().filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string()))).collect())
        .unwrap_or_default();
    let custom_endpoint = provider_option(instance, "baseUrl").map(str::trim).filter(|s| !s.is_empty())
        .or_else(|| env.get("OPENAI_BASE_URL").map(String::as_str).map(str::trim).filter(|s| !s.is_empty()));
    // Validation must happen outside any API-to-CLI fallback. A rejected URL
    // must never be delegated to a CLI along with the provider credential.
    if let Some(endpoint) = custom_endpoint {
        crate::adapters::model_config::validated_model_endpoint(endpoint)?;
    }
    let mut api_warning: Option<String> = None;
    match discover_codex_models_via_api(instance, &env).await {
        Ok(Some(catalog)) => return Ok(catalog),
        Ok(None) => {}
        Err(error) => {
            if custom_endpoint.is_some() { return Err(error); }
            eprintln!("[nautilo-core] official Codex API model discovery failed; trying local CLI");
            api_warning = Some("官方模型列表 API 请求失败，已回退到本机 CLI 获取。".to_string());
        }
    }
    let catalog = discover_codex_models_via_cli(instance, &env).await?;
    match api_warning {
        Some(warning) => {
            let mut object = catalog.as_object().cloned().unwrap_or_default();
            object.insert("warning".to_string(), json!(warning));
            Ok(Value::Object(object))
        }
        None => Ok(catalog),
    }
}

// ---------------------------------------------------------------- the adapter

pub struct CodexAdapter;

impl Default for CodexAdapter {
    fn default() -> Self {
        Self
    }
}

#[async_trait::async_trait]
impl AgentCliAdapter for CodexAdapter {
    fn provider_id(&self) -> &str {
        "codex"
    }

    fn descriptor(&self) -> Value {
        json!({
            "providerId": "codex",
            "name": "Codex",
            "vendor": "OpenAI",
            "capabilities": ["headless_structured", "long_running_stdin"],
            "defaultExecutable": "codex",
            "credentialEnv": ["OPENAI_API_KEY", "CODEX_API_KEY"],
            "envPassthrough": ["OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL"],
            "baseUrlEnv": "OPENAI_BASE_URL",
            "configProfile": true,
            "permissionModes": [
                { "value": "ask", "name": { "zh-CN": "请求批准", "en-US": "Request approval" },
                  "description": { "zh-CN": "编辑文件和执行命令前始终询问（on-request + workspace-write）", "en-US": "Always ask before edits and commands (on-request + workspace-write)" } },
                { "value": "auto", "name": { "zh-CN": "替我审批", "en-US": "Approve for me" },
                  "description": { "zh-CN": "仅对超出沙箱的风险操作请求批准（on-failure + workspace-write）", "en-US": "Only ask for risky operations outside the sandbox (on-failure + workspace-write)" } },
                { "value": "full-access", "name": { "zh-CN": "完全访问权限", "en-US": "Full access" },
                  "description": { "zh-CN": "不再询问，可访问任意文件与网络（never + danger-full-access）", "en-US": "Never asks; unrestricted file and network access (never + danger-full-access)" } }
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
        let executable = str_field(instance, "executable").unwrap_or("codex").to_string();
        let capture = |executable: &str, args: Vec<String>| -> CoreResult<(String, Option<i32>)> {
            let (command, args) = resolve_codex_invocation(executable, &args, None);
            let started = ProcessRuntime::start(&ProcessRequest {
                command,
                args,
                timeout_ms: Some(8_000),
                idle_timeout_ms: Some(4_000),
                max_output_bytes: Some(512 * 1024),
                ..Default::default()
            })
            .map_err(|e| CoreError::reason(ErrorCode::IpcInternalError, e.to_string()))?;
            let mut events = started.events;
            let (sender, receiver) = std::sync::mpsc::channel();
            tokio::spawn(async move {
                let mut text = String::new();
                let mut code = None;
                while let Some(event) = events.recv().await {
                    match event {
                        ProcessEvent::Stdout(chunk) | ProcessEvent::Stderr(chunk) => text.push_str(&chunk),
                        ProcessEvent::Exit { exit_code, .. } => code = exit_code,
                        _ => {}
                    }
                }
                let _ = sender.send((text, code));
            });
            receiver.recv().map_err(|_| CoreError::reason(ErrorCode::IpcInternalError, "capture channel closed"))
        };
        let detect_executable = executable.clone();
        let result = tokio::task::spawn_blocking(move || -> CoreResult<AdapterDetectionResult> {
            let executable = detect_executable;
            let (version_text, version_code) = capture(&executable, vec!["--version".to_string()])?;
            if version_code != Some(0) {
                return Ok(AdapterDetectionResult {
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
            let (help_text, help_code) = capture(&executable, vec!["exec".to_string(), "--help".to_string()])?;
            let compatibility_error = if help_code == Some(0) {
                if help_text.contains("--json") && help_text.contains("resume") {
                    None
                } else {
                    Some("Installed Codex CLI does not expose exec JSONL and resume support".to_string())
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
        })
        .await;
        match result {
            Ok(Ok(detection)) => detection,
            Ok(Err(error)) => AdapterDetectionResult { installed: false, executable, error: Some(error.to_string()), ..Default::default() },
            Err(error) => AdapterDetectionResult { installed: false, executable, error: Some(error.to_string()), ..Default::default() },
        }
    }

    async fn list_models(&self, instance: &Value, context: Option<&Value>) -> Option<CoreResult<Value>> {
        Some(discover_codex_models(instance, context).await)
    }

    fn start(&self, request: AdapterStartRequest) -> CoreResult<AdapterRun> {
        if matches!(resolve_codex_wire_api(&request.instance), "chat" | "anthropic") {
            return chat_compat::start_codex_chat_compat_app_server(request, None);
        }
        if !base_args(&request.instance).is_empty() {
            let args = build_codex_start_args(&request.instance, &request.prompt, Some(&request))?;
            return start_exec_process(request, args);
        }
        app_server::start_codex_app_server(request, None)
    }

    fn resume(&self, request: AdapterResumeRequest) -> CoreResult<AdapterRun> {
        if matches!(resolve_codex_wire_api(&request.start.instance), "chat" | "anthropic") {
            return chat_compat::start_codex_chat_compat_app_server(request.start, Some(request.provider_session_id));
        }
        if !base_args(&request.start.instance).is_empty() {
            let args = build_codex_resume_args(
                &request.start.instance,
                &request.provider_session_id,
                &request.start.prompt,
                Some(&request.start),
            )?;
            return start_exec_process(request.start, args);
        }
        app_server::start_codex_app_server(request.start, Some(request.provider_session_id))
    }
}

/// `codex exec --json` simple process path (custom baseArgs).
fn start_exec_process(request: AdapterStartRequest, args: Vec<String>) -> CoreResult<AdapterRun> {
    let executable = str_field(&request.instance, "executable").unwrap_or("codex").to_string();
    let path_env = request.env.as_ref().and_then(|env| env.get("PATH").cloned());
    let (command, args) = resolve_codex_invocation(&executable, &args, path_env.as_deref());
    let started = ProcessRuntime::start(&ProcessRequest {
        command,
        args,
        cwd: Some(request.cwd.clone()),
        env: request.env.clone(),
        timeout_ms: request.timeout_ms,
        idle_timeout_ms: request.idle_timeout_ms,
        max_output_bytes: Some(request.max_output_bytes.unwrap_or(20 * 1024 * 1024)),
    })
    .map_err(|e| CoreError::reason(ErrorCode::RunStartFailed, e.to_string()))?;
    let handle = started.handle.clone();
    handle.end_stdin(None);
    let events = crate::adapters::stream_events(
        started.events,
        true,
        std::sync::Arc::new(|value, _stream| events::parse_codex_json_event(value)),
    );
    Ok(AdapterRun::from_process(events, &handle))
}

#[cfg(test)]
mod native_discovery_security_tests {
    use super::*;
    #[tokio::test]
    async fn rejected_custom_discovery_endpoint_never_falls_back_to_cli() {
        let instance = json!({"executable":"nautilo-test-cli-must-not-be-launched", "providerOptions":{"baseUrl":"https://user:secret@example.invalid/v1"}});
        let error = discover_codex_models(&instance, Some(&json!({"env":{"OPENAI_API_KEY":"fixture-key"}}))).await.unwrap_err().to_string();
        assert!(error.contains("cannot contain credentials"));
        assert!(!error.contains("secret")); assert!(!error.contains("fixture-key"));
        let instance = json!({"executable":"nautilo-test-cli-must-not-be-launched"});
        let error = discover_codex_models(&instance, Some(&json!({"env":{"OPENAI_BASE_URL":"http://remote.invalid/v1","OPENAI_API_KEY":"fixture-key"}}))).await.unwrap_err().to_string();
        assert!(error.contains("HTTPS"));
    }
    #[tokio::test]
    async fn native_discovery_never_follows_credential_redirects() {
        use std::io::{Read, Write};
        use std::net::TcpListener;
        let target = TcpListener::bind("127.0.0.1:0").unwrap();
        target.set_nonblocking(true).unwrap();
        let source = TcpListener::bind("127.0.0.1:0").unwrap();
        let base_url = format!("http://{}", source.local_addr().unwrap());
        let target_url = format!("http://{}/models", target.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut stream, _) = source.accept().unwrap();
            let mut buffer = [0_u8; 4096];
            stream.read(&mut buffer).unwrap();
            write!(stream, "HTTP/1.1 302 Found\r\nLocation: {target_url}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
        });
        let instance = json!({"providerOptions": {"baseUrl": base_url}});
        let env = HashMap::from([("OPENAI_API_KEY".to_string(), "fixture-key".to_string())]);
        assert!(discover_codex_models_via_api(&instance, &env).await.is_err());
        server.join().unwrap();
        assert!(matches!(target.accept(), Err(error) if error.kind() == std::io::ErrorKind::WouldBlock));
    }
}
