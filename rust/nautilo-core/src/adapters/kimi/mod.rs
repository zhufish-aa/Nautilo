//! Kimi Code adapter — port of adapters/kimi/{adapter,commands,events,
//! interaction,models}.ts. The ACP run loop lives in acp_run.rs.

use std::collections::HashMap;

use serde_json::{json, Value};

use crate::adapters::{
    AdapterDetectionResult, AdapterEvent, AdapterResumeRequest, AdapterRun, AdapterStartRequest, AgentCliAdapter,
};
use crate::errors::{CoreError, CoreResult, ErrorCode};
use crate::process_runtime::{ProcessEvent, ProcessRequest, ProcessRuntime};
use crate::errors::now_iso;

pub mod acp_events;
mod connection;
pub mod acp_run;
pub mod acp_segments;
pub mod session_usage;
pub mod subagent_wire;

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

fn default_args(request: Option<&AdapterStartRequest>) -> Vec<String> {
    match request.and_then(|r| r.model.as_deref()).filter(|m| !m.is_empty()) {
        Some(model) => vec!["--model".to_string(), model.to_string()],
        None => vec![],
    }
}

pub fn build_kimi_start_args(instance: &Value, prompt: &str, request: Option<&AdapterStartRequest>) -> Vec<String> {
    let custom = base_args(instance);
    let mut args = crate::adapters::process_adapter::merge_cli_args(custom, default_args(request));
    args.extend(["--prompt".to_string(), prompt.to_string(), "--output-format".to_string(), "stream-json".to_string()]);
    args
}

pub fn build_kimi_resume_args(
    instance: &Value,
    session_id: &str,
    prompt: &str,
    request: Option<&AdapterStartRequest>,
) -> Vec<String> {
    let custom = base_args(instance);
    let mut args = crate::adapters::process_adapter::merge_cli_args(custom, default_args(request));
    args.extend([
        "--session".to_string(),
        session_id.to_string(),
        "--prompt".to_string(),
        prompt.to_string(),
        "--output-format".to_string(),
        "stream-json".to_string(),
    ]);
    args
}

// ---------------------------------------------------------------- stream-json events (custom baseArgs path)

fn parse_arguments(value: &Value) -> Value {
    if let Some(text) = value.as_str() {
        return serde_json::from_str(text).unwrap_or_else(|_| value.clone());
    }
    value.clone()
}

/// Port of kimi/events.ts — the `kimi --output-format stream-json` line parser.
pub fn parse_kimi_json_event(value: &Value) -> Vec<AdapterEvent> {
    let role = value.get("role").and_then(Value::as_str).unwrap_or("");
    match role {
        "assistant" => {
            let mut events = vec![];
            if let Some(content) = value.get("content").and_then(Value::as_str).filter(|s| !s.is_empty()) {
                events.push(AdapterEvent::Message {
                    text: content.to_string(),
                    phase: None,
                    message_id: None,
                    subagent_dispatch_id: None,
                    raw: Some(value.clone()),
                });
            }
            if let Some(calls) = value.get("tool_calls").and_then(Value::as_array) {
                for call in calls {
                    if let Some(name) = call.get("function").and_then(|f| f.get("name")).and_then(Value::as_str) {
                        events.push(AdapterEvent::Tool {
                            call_id: call.get("id").and_then(Value::as_str).map(str::to_string),
                            name: name.to_string(),
                            phase: Some("started".to_string()),
                            input: call.get("function").and_then(|f| f.get("arguments")).map(parse_arguments),
                            output: None,
                            success: None,
                            file_diff: None,
                            subagent_dispatch_id: None,
                            raw: Some(value.clone()),
                        });
                    }
                }
            }
            events
        }
        "tool" => vec![AdapterEvent::Tool {
            call_id: value.get("tool_call_id").and_then(Value::as_str).map(str::to_string),
            name: value.get("tool_call_id").and_then(Value::as_str).unwrap_or("tool").to_string(),
            phase: Some("completed".to_string()),
            input: None,
            output: value.get("content").cloned(),
            success: None,
            file_diff: None,
            subagent_dispatch_id: None,
            raw: Some(value.clone()),
        }],
        "meta" if value.get("type").and_then(Value::as_str) == Some("session.resume_hint") => {
            match value.get("session_id").and_then(Value::as_str) {
                Some(id) => vec![AdapterEvent::Session { provider_session_id: id.to_string(), raw: Some(value.clone()) }],
                None => vec![],
            }
        }
        "error" => vec![AdapterEvent::Error {
            message: value
                .get("content")
                .and_then(Value::as_str)
                .or_else(|| value.get("message").and_then(Value::as_str))
                .unwrap_or("Kimi Code reported an error")
                .to_string(),
        }],
        _ => {
            if value.get("type").and_then(Value::as_str) == Some("error") {
                return vec![AdapterEvent::Error {
                    message: value
                        .get("content")
                        .and_then(Value::as_str)
                        .or_else(|| value.get("message").and_then(Value::as_str))
                        .unwrap_or("Kimi Code reported an error")
                        .to_string(),
                }];
            }
            crate::adapters::normalize_json(value)
        }
    }
}

// ---------------------------------------------------------------- permission interaction

/// Normalizes one ACP permission request without leaking provider JSON to UI.
pub fn normalize_kimi_permission_interaction(tool_call: &Value, options: &[Value]) -> Value {
    let title = tool_call.get("title").and_then(Value::as_str).unwrap_or("");
    let kind = tool_call.get("kind").and_then(Value::as_str).unwrap_or("");
    let plan_approval = crate::adapters::plan_interaction::is_plan_exit_tool(title)
        || crate::adapters::plan_interaction::is_plan_exit_tool(kind);
    let normalized_options: Vec<Value> = options
        .iter()
        .filter_map(|option| {
            let id = option.get("optionId").and_then(Value::as_str).unwrap_or("");
            if id.is_empty() {
                return None;
            }
            let mut mapped = serde_json::Map::new();
            mapped.insert("id".to_string(), json!(id));
            mapped.insert(
                "label".to_string(),
                option
                    .get("name")
                    .and_then(Value::as_str)
                    .map(|n| json!(n))
                    .unwrap_or_else(|| json!(id)),
            );
            if let Some(kind) = option.get("kind").and_then(Value::as_str) {
                mapped.insert("description".to_string(), json!(kind));
            }
            Some(Value::Object(mapped))
        })
        .collect();
    if plan_approval {
        return json!({
            "kind": "plan_approval",
            "title": "计划已就绪",
            "plan": crate::adapters::plan_interaction::extract_interaction_plan(
                tool_call.get("content").unwrap_or(tool_call)
            ),
            "options": with_plan_option_intents(normalized_options)
        });
    }
    let mut detail_parts: Vec<String> = vec![];
    if !kind.is_empty() {
        detail_parts.push(format!("类型: {kind}"));
    }
    if let Some(content) = tool_call.get("content") {
        let rendered = serde_json::to_string_pretty(content).unwrap_or_default();
        if !rendered.is_empty() && rendered != "null" {
            detail_parts.push(rendered.chars().take(4_000).collect());
        }
    }
    json!({
        "kind": "approval",
        "title": if title.is_empty() { "权限请求" } else { title },
        "detail": if detail_parts.is_empty() { Value::Null } else { json!(detail_parts.join("\n")) },
        "options": normalized_options
    })
}

fn with_plan_option_intents(options: Vec<Value>) -> Vec<Value> {
    // Reuse the codex-side helper semantics (same TS function).
    let infer = |option: &Value| -> Option<&'static str> {
        let text = format!(
            "{} {} {}",
            option.get("id").and_then(Value::as_str).unwrap_or(""),
            option.get("label").and_then(Value::as_str).unwrap_or(""),
            option.get("description").and_then(Value::as_str).unwrap_or("")
        )
        .to_lowercase();
        if regex::Regex::new(r"(?i)(reject|deny|decline|cancel|abort|拒绝|取消)").map(|re| re.is_match(&text)).unwrap_or(false) {
            return Some("reject");
        }
        if regex::Regex::new(r"(?i)(revise|refine|keep planning|continue planning|stay.+plan|修改|完善|继续计划)").map(|re| re.is_match(&text)).unwrap_or(false) {
            return Some("revise");
        }
        if regex::Regex::new(r"(?i)(allow|accept|approve|proceed|implement|build|yes|批准|执行|开始实现|同意)").map(|re| re.is_match(&text)).unwrap_or(false) {
            return Some("approve");
        }
        None
    };
    let mut inferred: Vec<Value> = options
        .iter()
        .map(|option| {
            let mut mapped = option.as_object().cloned().unwrap_or_default();
            if mapped.get("intent").is_none() {
                if let Some(intent) = infer(option) {
                    mapped.insert("intent".to_string(), json!(intent));
                }
            }
            Value::Object(mapped)
        })
        .collect();
    let has = |intent: &str, options: &[Value]| options.iter().any(|o| o.get("intent").and_then(Value::as_str) == Some(intent));
    if inferred.len() == 2 && !has("approve", &inferred) {
        inferred[0].as_object_mut().unwrap().insert("intent".to_string(), json!("approve"));
    }
    if inferred.len() == 2 && !has("revise", &inferred) && !has("reject", &inferred) {
        inferred[1].as_object_mut().unwrap().insert("intent".to_string(), json!("revise"));
    }
    inferred
}

// ---------------------------------------------------------------- models

pub fn parse_kimi_default_model(text: &str) -> Option<String> {
    regex::Regex::new(r"(?mi)^Default model:\s*(\S+)\s*$")
        .ok()?
        .captures(text)?
        .get(1)
        .map(|m| m.as_str().to_string())
}

pub fn parse_kimi_model_list(text: &str, default_model: Option<&str>) -> CoreResult<Value> {
    let root: Value = serde_json::from_str(text)
        .map_err(|_| CoreError::reason(ErrorCode::IpcInternalError, "Kimi 返回了无法解析的模型配置。"))?;
    let configured_default = root
        .get("defaultModel")
        .and_then(Value::as_str).map(str::trim).filter(|model| !model.is_empty())
        .or_else(|| root.get("default_model").and_then(Value::as_str).map(str::trim).filter(|model| !model.is_empty()))
        .map(str::to_string)
        .or_else(|| default_model.map(str::trim).filter(|model| !model.is_empty()).map(str::to_string));
    let models: Vec<Value> = root
        .get("models")
        .and_then(Value::as_object)
        .map(|entries| {
            entries
                .iter()
                .map(|(alias, model)| {
                    let mut entry = serde_json::Map::new();
                    entry.insert("id".to_string(), json!(alias));
                    entry.insert(
                        "displayName".to_string(),
                        model.get("displayName").and_then(Value::as_str).map(|d| json!(d)).unwrap_or_else(|| json!(alias)),
                    );
                    entry.insert("isDefault".to_string(), json!(Some(alias) == configured_default.as_ref()));
                    if let Some(window) = model.get("maxContextSize").and_then(Value::as_i64) {
                        entry.insert("contextWindow".to_string(), json!(window));
                    }
                    entry.insert(
                        "capabilities".to_string(),
                        model.get("capabilities").cloned().filter(|v| v.is_array()).unwrap_or_else(|| json!([])),
                    );
                    entry.insert(
                        "reasoningEfforts".to_string(),
                        model.get("supportEfforts").cloned().filter(|v| v.is_array()).unwrap_or_else(|| json!([])),
                    );
                    if let Some(effort) = model.get("defaultEffort").and_then(Value::as_str) {
                        entry.insert("defaultReasoningEffort".to_string(), json!(effort));
                    }
                    entry.insert("serviceTiers".to_string(), json!([]));
                    Value::Object(entry)
                })
                .collect()
        })
        .unwrap_or_default();
    let mut catalog = serde_json::Map::new();
    catalog.insert("providerId".to_string(), json!("kimi-code"));
    catalog.insert("models".to_string(), Value::Array(models));
    if let Some(default_model) = configured_default {
        catalog.insert("defaultModel".to_string(), json!(default_model));
    }
    catalog.insert("source".to_string(), json!("provider_cli"));
    catalog.insert("fetchedAt".to_string(), json!(now_iso()));
    Ok(Value::Object(catalog))
}

/// Reads only the locally configured Kimi aliases; credentials from the raw
/// JSON are discarded.
async fn discover_kimi_models(instance: &Value, env: Option<&HashMap<String, String>>) -> CoreResult<Value> {
    let executable = str_field(instance, "executable").unwrap_or("kimi").to_string();
    let capture = |args: Vec<String>| {
        let executable = executable.clone();
        let env = env.cloned();
        async move {
            let started = ProcessRuntime::start(&ProcessRequest {
                command: executable,
                args,
                env,
                timeout_ms: Some(8_000),
                idle_timeout_ms: Some(4_000),
                max_output_bytes: Some(512 * 1024),
                ..Default::default()
            })
            .map_err(|e| CoreError::reason(ErrorCode::IpcInternalError, e.to_string()))?;
            let mut events = started.events;
            let mut text = String::new();
            let mut code = None;
            while let Some(event) = events.recv().await {
                match event {
                    ProcessEvent::Stdout(chunk) | ProcessEvent::Stderr(chunk) => text.push_str(&chunk),
                    ProcessEvent::Exit { exit_code, .. } => code = exit_code,
                    _ => {}
                }
            }
            Ok::<(String, Option<i32>), CoreError>((text, code))
        }
    };
    let (json_text, json_code) = capture(vec!["provider".to_string(), "list".to_string(), "--json".to_string()]).await?;
    if json_code != Some(0) {
        return Err(CoreError::reason(
            ErrorCode::IpcInternalError,
            if json_text.trim().is_empty() {
                format!("kimi provider list --json exited with {}", json_code.map(|c| c.to_string()).unwrap_or_else(|| "unknown".to_string()))
            } else {
                json_text.trim().to_string()
            },
        ));
    }
    // JSON-provided selection avoids a second CLI process on modern Kimi.
    let configured = parse_kimi_model_list(&json_text, None)?;
    if configured.get("defaultModel").and_then(Value::as_str).is_some_and(|model| !model.trim().is_empty()) {
        return Ok(configured);
    }
    let mut default_model = None;
    if let Ok((text, code)) = capture(vec!["provider".to_string(), "list".to_string()]).await {
        if code == Some(0) {
            default_model = parse_kimi_default_model(&text);
        }
    }
    parse_kimi_model_list(&json_text, default_model.as_deref())
}

// ---------------------------------------------------------------- the adapter

pub struct KimiCodeAdapter;

impl Default for KimiCodeAdapter {
    fn default() -> Self {
        Self
    }
}

#[async_trait::async_trait]
impl AgentCliAdapter for KimiCodeAdapter {
    fn provider_id(&self) -> &str {
        "kimi-code"
    }

    fn descriptor(&self) -> Value {
        json!({
            "providerId": "kimi-code",
            "name": "Kimi Code",
            "vendor": "Moonshot AI",
            "capabilities": ["headless_structured", "pty_interactive"],
            "defaultExecutable": "kimi",
            "credentialEnv": ["KIMI_API_KEY"],
            "envPassthrough": ["KIMI_CODE_HOME"],
            "contextWindowDiscovery": true,
            "permissionModes": [
                { "value": "default", "name": { "zh-CN": "逐个询问", "en-US": "Ask every time" },
                  "description": { "zh-CN": "每次工具调用都向你确认（default）", "en-US": "Confirms every tool call with you (default)" } },
                { "value": "yolo", "name": { "zh-CN": "完全自主", "en-US": "Fully autonomous" },
                  "description": { "zh-CN": "自动批准一切，不再询问（yolo）", "en-US": "Auto-approve everything without asking (yolo)" } },
                { "value": "auto", "name": { "zh-CN": "自动批准安全操作", "en-US": "Auto-approve safe ops" },
                  "description": { "zh-CN": "安全操作自动通过，其余仍会询问（auto）", "en-US": "Safe operations are auto-approved; the rest still ask (auto)" } }
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
        let executable = str_field(instance, "executable").unwrap_or("kimi").to_string();
        let capture = |args: Vec<String>| {
            let executable = executable.clone();
            async move {
                let started = ProcessRuntime::start(&ProcessRequest {
                    command: executable,
                    args,
                    timeout_ms: Some(8_000),
                    idle_timeout_ms: Some(4_000),
                    max_output_bytes: Some(512 * 1024),
                    ..Default::default()
                })
                .map_err(|e| CoreError::reason(ErrorCode::IpcInternalError, e.to_string()))?;
                let mut events = started.events;
                let mut text = String::new();
                let mut code = None;
                while let Some(event) = events.recv().await {
                    match event {
                        ProcessEvent::Stdout(chunk) | ProcessEvent::Stderr(chunk) => text.push_str(&chunk),
                        ProcessEvent::Exit { exit_code, .. } => code = exit_code,
                        _ => {}
                    }
                }
                Ok::<(String, Option<i32>), CoreError>((text, code))
            }
        };
        let version = capture(vec!["--version".to_string()]).await;
        let Ok((version_text, version_code)) = version else {
            return AdapterDetectionResult {
                installed: false,
                executable,
                error: Some(version.err().map(|e| e.to_string()).unwrap_or_default()),
                ..Default::default()
            };
        };
        if version_code != Some(0) {
            return AdapterDetectionResult {
                installed: false,
                executable,
                error: Some(if version_text.is_empty() {
                    format!("exit {}", version_code.map(|c| c.to_string()).unwrap_or_else(|| "unknown".to_string()))
                } else {
                    version_text
                }),
                ..Default::default()
            };
        }
        let help = capture(vec!["--help".to_string()]).await;
        let (help_text, help_code) = help.unwrap_or_default();
        let compatibility_error = if help_code == Some(0) {
            if help_text.contains("stream-json") && help_text.contains("--session") {
                None
            } else {
                Some("Installed Kimi Code CLI does not expose stream-json and session resume support".to_string())
            }
        } else if !help_text.is_empty() {
            Some(help_text.clone())
        } else {
            Some(format!("help exited with {}", help_code.map(|c| c.to_string()).unwrap_or_else(|| "unknown".to_string())))
        };
        AdapterDetectionResult {
            installed: true,
            compatible: Some(compatibility_error.is_none()),
            executable,
            version: Some(version_text.trim().to_string()),
            help: Some(help_text.chars().take(16_384).collect()),
            error: compatibility_error,
        }
    }

    async fn list_models(&self, instance: &Value, context: Option<&Value>) -> Option<CoreResult<Value>> {
        let env: Option<HashMap<String, String>> = context
            .and_then(|c| c.get("env"))
            .and_then(Value::as_object)
            .map(|env| env.iter().filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string()))).collect());
        Some(discover_kimi_models(instance, env.as_ref()).await)
    }

    fn start(&self, mut request: AdapterStartRequest) -> CoreResult<AdapterRun> {
        let observer=crate::adapters::api_stream_observer::ApiStreamObserver::prepare(&mut request)?;
        let proxy=connection::prepare_protocol(&mut request)?;
        connection::prepare(&request.instance, request.env.get_or_insert_with(HashMap::new))?;
        // Kimi's older ACP server requires an OAuth login even when a custom
        // model has its own credentials. Prompt mode honors the native config
        // directly, so an API connection must never fall back to that login.
        if request.instance.pointer("/providerOptions/runtimeConnectionId").is_some() || !base_args(&request.instance).is_empty() {
            request.prompt = crate::adapters::images::prompt_with_image_files(&request)
                .map_err(|error|CoreError::reason(ErrorCode::RunStartFailed,error.to_string()))?;
            let args = build_kimi_start_args(&request.instance, &request.prompt, Some(&request));
            return start_simple(request, args).map(|run|{let run=connection::keep_protocol(run,proxy);match observer {Some(observer)=>observer.wrap(run),None=>run}});
        }
        acp_run::start_kimi_acp(request, None)
    }

    fn resume(&self, mut request: AdapterResumeRequest) -> CoreResult<AdapterRun> {
        let observer=crate::adapters::api_stream_observer::ApiStreamObserver::prepare(&mut request.start)?;
        let proxy=connection::prepare_protocol(&mut request.start)?;
        connection::prepare(&request.start.instance, request.start.env.get_or_insert_with(HashMap::new))?;
        if request.start.instance.pointer("/providerOptions/runtimeConnectionId").is_some() || !base_args(&request.start.instance).is_empty() {
            request.start.prompt = crate::adapters::images::prompt_with_image_files(&request.start)
                .map_err(|error|CoreError::reason(ErrorCode::RunStartFailed,error.to_string()))?;
            let args = build_kimi_resume_args(
                &request.start.instance,
                &request.provider_session_id,
                &request.start.prompt,
                Some(&request.start),
            );
            return start_simple(request.start, args).map(|run|{let run=connection::keep_protocol(run,proxy);match observer {Some(observer)=>observer.wrap(run),None=>run}});
        }
        acp_run::start_kimi_acp(request.start, Some(request.provider_session_id))
    }

    async fn dispose(&self) {acp_run::dispose().await;}
    async fn release_session(&self,request:&AdapterStartRequest)->CoreResult<()> {acp_run::release_session(request.local_session_id.as_deref().unwrap_or("")).await;Ok(())}
    async fn native_terminal(&self,mut request:AdapterStartRequest,resume:Option<String>)->CoreResult<crate::runtime::terminal_service::TerminalPlan> {
        let proxy=connection::prepare_protocol(&mut request)?;
        connection::prepare(&request.instance,request.env.get_or_insert_with(HashMap::new))?;
        let mut args=base_args(&request.instance);args.extend(default_args(Some(&request)));
        if let Some(resume)=resume {args.extend(["--session".into(),resume]);}
        if let Some(effort)=request.reasoning_effort {request.env.get_or_insert_with(HashMap::new).insert("KIMI_MODEL_THINKING_EFFORT".into(),effort);}
        Ok(crate::runtime::terminal_service::TerminalPlan{command:request.instance["executable"].as_str().unwrap_or("kimi").into(),args,env:request.env,cwd:request.cwd,resources:vec![Box::new(proxy)]})
    }
}

/// Native prompt mode for API connections and custom CLI invocations.
fn start_simple(request: AdapterStartRequest, args: Vec<String>) -> CoreResult<AdapterRun> {
    let mut env = request.env.clone().unwrap_or_default();
    if request.instance.pointer("/providerOptions/runtimeConnectionId").is_some() {
        if let Some(home) = env.get("KIMI_CODE_HOME") {
            agenthub_plugin_sdk::native_config::merge_mcp_file(&std::path::PathBuf::from(home).join("mcp.json"),
                Some(&json!(request.mcp_servers.as_deref().unwrap_or(&[]))))
                .map_err(|error| CoreError::reason(ErrorCode::RunStartFailed, error.to_string()))?;
        }
    }
    // KIMI_MODEL_THINKING_EFFORT carries the session's reasoning effort.
    if let Some(effort) = request.reasoning_effort.as_deref().filter(|e| !e.is_empty()) {
        env.insert("KIMI_MODEL_THINKING_EFFORT".to_string(), effort.to_string());
    }
    let started = ProcessRuntime::start(&ProcessRequest {
        command: request.instance.get("executable").and_then(Value::as_str).unwrap_or("kimi").to_string(),
        args,
        cwd: Some(request.cwd.clone()),
        env: Some(env),
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
        std::sync::Arc::new(|value, _stream| parse_kimi_json_event(value)),
    );
    Ok(AdapterRun::from_process(events, &handle))
}
