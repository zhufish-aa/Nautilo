//! Provider adapter contract — port of @agenthub/provider-sdk types and the
//! ProcessAdapter base class. Events travel over unbounded channels instead
//! of AsyncIterables; everything else mirrors the TS contract one-to-one.

use std::collections::HashMap;
use std::pin::Pin;
use std::sync::Arc;

use serde_json::Value;
use tokio::sync::mpsc;

use crate::errors::{CoreResult, CoreError, ErrorCode};
use crate::process_runtime::ProcessHandle;

pub mod claude;
pub mod images;
pub mod custom;
pub mod registry;
pub mod codex;
pub mod json_rpc_process;
pub mod kimi;
pub mod model_config;
mod model_catalog_cache;
pub mod normalize;
pub mod plan_interaction;
pub mod process_adapter;
pub mod runtime_mcp_bridge;
pub mod api_stream_observer;
#[cfg(test)] mod resident_tests;

pub use normalize::normalize_json;
pub use process_adapter::stream_events;



pub type BoxFuture<T> = Pin<Box<dyn std::future::Future<Output = T> + Send>>;

/// AdapterEvent in the TS SDK. `raw` payloads stay as JSON values.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag="kind", rename_all="snake_case", rename_all_fields="camelCase")]
pub enum AdapterEvent {
    Message { text: String, phase: Option<String>, message_id: Option<String>, subagent_dispatch_id: Option<String>, raw: Option<Value> },
    Thinking { text: String, phase: Option<String>, message_id: Option<String>, subagent_dispatch_id: Option<String>, raw: Option<Value> },
    Tool {
        call_id: Option<String>,
        name: String,
        phase: Option<String>,
        input: Option<Value>,
        output: Option<Value>,
        success: Option<bool>,
        file_diff: Option<Value>,
        subagent_dispatch_id: Option<String>,
        raw: Option<Value>,
    },
    Command {
        call_id: Option<String>,
        command: String,
        phase: Option<String>,
        exit_code: Option<i32>,
        output: Option<String>,
        subagent_dispatch_id: Option<String>,
        raw: Option<Value>,
    },
    TurnDiff { diff: String, thread_id: String, turn_id: String, raw: Option<Value> },
    File { path: String, change_type: Option<String>, additions: Option<i64>, deletions: Option<i64>, diff: Option<String>, raw: Option<Value> },
    Session { provider_session_id: String, raw: Option<Value> },
    Status { phase: String, raw: Option<Value> },
    /// Replacement snapshot: context footprint, turn execution, or provider session total.
    /// Reported cost is accounting metadata, never evidence of a billed payment.
    Usage {
        usage_scope: Option<String>,
        usage_key: Option<String>,
        input_tokens_includes_cache: Option<bool>,
        cache_creation_input_tokens: Option<i64>,
        reported_cost: Option<f64>,
        estimated_cost: Option<f64>,
        currency: Option<String>,
        input_tokens: Option<i64>,
        cached_input_tokens: Option<i64>,
        output_tokens: Option<i64>,
        reasoning_output_tokens: Option<i64>,
        context_used: Option<i64>,
        context_window: Option<i64>,
        raw: Option<Value>,
    },
    Commands { commands: Value, raw: Option<Value> },
    Artifact { artifact_type: String, name: String, mime_type: Option<String>, data: Option<String>, path: Option<String>, raw: Option<Value> },
    Raw { stream: String, text: String },
    Exit { exit_code: Option<i32>, signal: Option<String> },
    Error { message: String },
    Timeout { reason: TimeoutKind },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all="snake_case")]
pub enum TimeoutKind {
    Timeout,
    Idle,
    MaxOutput,
}

impl TimeoutKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Timeout => "timeout",
            Self::Idle => "idle",
            Self::MaxOutput => "max_output",
        }
    }
}

/// Everything a run needs to launch a provider turn (AdapterStartRequest).
#[derive(Clone)]
pub struct ImageGenerationExecutor {
    pub generate: Arc<dyn Fn(Value) -> BoxFuture<anyhow::Result<Value>> + Send + Sync>,
    pub cancel: Arc<dyn Fn() + Send + Sync>,
}

#[derive(Clone, Default)]
pub struct AdapterStartRequest {
    pub instance: Value,
    /// Stable Nautilo identity for local transport isolation, not a provider thread ID.
    pub local_session_id: Option<String>,
    /// History-only evidence from the PTY owner; never a provider launch flag.
    pub native_terminal_live: Option<bool>,
    pub prompt: String,
    pub cwd: String,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub agent_mode: Option<String>,
    pub service_tier: Option<String>,
    pub permission_mode: Option<String>,
    pub context_window: Option<i64>,
    pub env: Option<HashMap<String, String>>,
    pub timeout_ms: Option<u64>,
    pub idle_timeout_ms: Option<u64>,
    pub max_output_bytes: Option<usize>,
    pub output_schema_path: Option<String>,
    pub local_image_paths: Option<Vec<String>>,
    pub runtime_tools: Option<Value>,
    /// Tools supplied by Nautilo for this provider session (delegation etc.).
    pub execute_runtime_tool: Option<Arc<dyn Fn(Value) -> BoxFuture<anyhow::Result<Value>> + Send + Sync>>,
    pub image_generation: Option<ImageGenerationExecutor>,
    /// Provider-initiated user interaction; blocks until the user responds.
    pub request_interaction: Option<Arc<dyn Fn(Value) -> BoxFuture<anyhow::Result<Value>> + Send + Sync>>,
    pub session_events: Option<Arc<dyn Fn(AdapterEvent) + Send + Sync>>,
    pub session_interaction: Option<Arc<dyn Fn(Value) -> BoxFuture<anyhow::Result<Value>> + Send + Sync>>,
    pub session_tool: Option<Arc<dyn Fn(Value) -> BoxFuture<anyhow::Result<Value>> + Send + Sync>>,
    pub skills: Option<Vec<Value>>,
    pub mcp_servers: Option<Vec<Value>>,
    pub provider_command: Option<String>,
}

#[derive(Clone)]
pub struct AdapterResumeRequest {
    pub start: AdapterStartRequest,
    pub provider_session_id: String,
}

pub struct AdapterRun {
    pub events: mpsc::UnboundedReceiver<AdapterEvent>,
    cancel: Box<dyn FnOnce() -> BoxFuture<()> + Send>,
    steer: Option<Arc<dyn Fn(String) -> BoxFuture<CoreResult<()>> + Send + Sync>>,
    write: Box<dyn Fn(String) + Send + Sync>,
}

impl AdapterRun {
    pub fn new(
        events: mpsc::UnboundedReceiver<AdapterEvent>,
        cancel: impl FnOnce() -> BoxFuture<()> + Send + 'static,
        write: impl Fn(String) + Send + Sync + 'static,
    ) -> Self {
        Self { events, cancel: Box::new(cancel), steer: None, write: Box::new(write) }
    }

    pub fn with_steer(mut self, steer: Arc<dyn Fn(String) -> BoxFuture<CoreResult<()>> + Send + Sync>) -> Self {
        self.steer = Some(steer);
        self
    }

    pub fn from_process(events: mpsc::UnboundedReceiver<AdapterEvent>, handle: &ProcessHandle) -> Self {
        let cancel_handle = handle.clone();
        let write_handle = handle.clone();
        Self::new(
            events,
            move || Box::pin(async move { cancel_handle.cancel().await }),
            move |input| write_handle.write(&input),
        )
    }

    pub async fn cancel(self) {
        (self.cancel)().await;
    }

    pub fn can_steer(&self) -> bool {
        self.steer.is_some()
    }

    pub async fn steer(&self, input: String) -> CoreResult<()> {
        let steer = self.steer.as_ref().ok_or_else(|| {
            CoreError::reason(ErrorCode::IpcInvalidRequest, "The active provider does not support immediate guidance.")
        })?;
        steer(input).await
    }

    pub fn write(&self, input: &str) {
        (self.write)(input.to_string());
    }

    /// Shares the steer hook so wrapper runs (chat compat proxy) can forward it.
    pub fn steer_handle(&self) -> Option<Arc<dyn Fn(String) -> BoxFuture<CoreResult<()>> + Send + Sync>> {
        self.steer.clone()
    }

    /// Decomposes the run for wrappers that intercept cancellation.
    pub fn into_parts(
        self,
    ) -> (
        mpsc::UnboundedReceiver<AdapterEvent>,
        Box<dyn FnOnce() -> BoxFuture<()> + Send>,
        Option<Arc<dyn Fn(String) -> BoxFuture<CoreResult<()>> + Send + Sync>>,
        Box<dyn Fn(String) + Send + Sync>,
    ) {
        (self.events, self.cancel, self.steer, self.write)
    }
}

#[derive(Debug, Clone, Copy)]
pub struct AdapterCapabilities {
    pub structured_output: bool,
    pub text_output: bool,
    pub interactive_stdin: bool,
    pub native_resume: bool,
    pub pty: bool,
}

#[derive(Debug, Clone, Default)]
pub struct AdapterDetectionResult {
    pub installed: bool,
    pub compatible: Option<bool>,
    pub executable: String,
    pub version: Option<String>,
    pub help: Option<String>,
    pub error: Option<String>,
}

#[async_trait::async_trait]
pub trait AgentCliAdapter: Send + Sync {
    async fn list_modes(&self, _instance: &Value, _context: Option<&Value>) -> CoreResult<Value> {
        Ok(serde_json::json!({"modes":[]}))
    }
    fn provider_id(&self) -> &str;
    /// The ProviderDescriptor JSON served to the renderer via provider.catalog.
    fn descriptor(&self) -> Value;
    fn capabilities(&self) -> AdapterCapabilities;
    fn native_capabilities(&self,instance:&Value)->Value {
        let caps=self.capabilities();
        agenthub_plugin_sdk::capabilities::describe(self.provider_id(),instance,&serde_json::json!({"structuredOutput":caps.structured_output,"textOutput":caps.text_output,"interactiveStdin":caps.interactive_stdin,"nativeResume":caps.native_resume,"pty":caps.pty}))
    }
    fn supports_structured_output(&self) -> bool {
        self.capabilities().structured_output
    }
    fn supports_resume(&self) -> bool {
        self.capabilities().native_resume
    }
    async fn detect(&self, instance: &Value) -> AdapterDetectionResult;
    /// None -> the registry falls back to the "unavailable" catalog.
    async fn list_models(&self, _instance: &Value, _context: Option<&Value>) -> Option<CoreResult<Value>> {
        None
    }
    fn start(&self, request: AdapterStartRequest) -> CoreResult<AdapterRun>;
    fn resume(&self, _request: AdapterResumeRequest) -> CoreResult<AdapterRun> {
        Err(CoreError::reason(
            ErrorCode::IpcInvalidRequest,
            format!("{} does not support native session resume", self.provider_id()),
        ))
    }
    async fn dispose(&self) {}
    async fn release_session(&self, _request:&AdapterStartRequest) -> CoreResult<()> {Ok(())}
    async fn read_session_history(&self,_request:&AdapterStartRequest,_session:&str)->CoreResult<Option<Value>> {Ok(None)}
    fn native_history_supported(&self,_instance:&Value)->bool {false}
    /// History readback alone does not prove stream message/call IDs are native.
    fn native_message_ids_supported(&self,_instance:&Value)->bool {false}
    async fn resume_terminal_events(&self,_request:&AdapterStartRequest,_session:&str,_snapshot:&Value)->CoreResult<()> {Ok(())}
    async fn prepare_native_terminal(&self,request:AdapterStartRequest,resume:Option<String>)->CoreResult<crate::runtime::terminal_service::TerminalPlan> {
        self.release_session(&request).await?;
        self.native_terminal(request,resume).await
    }
    async fn native_terminal(&self,_request:AdapterStartRequest,_resume:Option<String>)->CoreResult<crate::runtime::terminal_service::TerminalPlan> {
        Err(crate::errors::invalid("providerId","This adapter has not declared a native terminal launch plan"))
    }
}


// ---------------------------------------------------------------- plugin wire mapping

/// Converts a plugin-emitted event JSON frame back into an AdapterEvent.
/// The frame shape matches the TS AdapterEvent union (camelCase fields).
pub fn event_from_json(value: &Value) -> AdapterEvent {
    let opt_str = |key: &str| value.get(key).and_then(Value::as_str).map(str::to_string);
    let opt_i64 = |key: &str| value.get(key).and_then(Value::as_i64);
    let raw = value.get("raw").cloned();
    match value.get("kind").and_then(Value::as_str).unwrap_or("") {
        "message" => AdapterEvent::Message {
            text: opt_str("text").unwrap_or_default(),
            phase: opt_str("phase"),
            message_id: opt_str("messageId"),
            subagent_dispatch_id: opt_str("subagentDispatchId"),
            raw,
        },
        "thinking" => AdapterEvent::Thinking {
            text: opt_str("text").unwrap_or_default(),
            phase: opt_str("phase"),
            message_id: opt_str("messageId"),
            subagent_dispatch_id: opt_str("subagentDispatchId"),
            raw,
        },
        "tool" => AdapterEvent::Tool {
            call_id: opt_str("callId"),
            name: opt_str("name").unwrap_or_else(|| "tool".to_string()),
            phase: opt_str("phase"),
            input: value.get("input").cloned().filter(|v| !v.is_null()),
            output: value.get("output").cloned().filter(|v| !v.is_null()),
            success: value.get("success").and_then(Value::as_bool),
            file_diff: value.get("fileDiff").cloned().filter(|v| !v.is_null()),
            subagent_dispatch_id: opt_str("subagentDispatchId"),
            raw,
        },
        "command" => AdapterEvent::Command {
            call_id: opt_str("callId"),
            command: opt_str("command").unwrap_or_default(),
            phase: opt_str("phase"),
            exit_code: opt_i64("exitCode").map(|c| c as i32),
            output: opt_str("output"),
            subagent_dispatch_id: opt_str("subagentDispatchId"),
            raw,
        },
        "turn_diff" => AdapterEvent::TurnDiff {
            diff: opt_str("diff").unwrap_or_default(),
            thread_id: opt_str("threadId").unwrap_or_default(),
            turn_id: opt_str("turnId").unwrap_or_default(), raw,
        },
        "file" => AdapterEvent::File {
            path: opt_str("path").unwrap_or_default(),
            change_type: opt_str("changeType"),
            additions: opt_i64("additions"),
            deletions: opt_i64("deletions"),
            diff: opt_str("diff"),
            raw,
        },
        "session" => AdapterEvent::Session { provider_session_id: opt_str("providerSessionId").unwrap_or_default(), raw },
        "extension_ui" => AdapterEvent::Status { phase: "extension_ui".into(), raw: Some(value.clone()) },
        "status" => AdapterEvent::Status { phase: opt_str("phase").unwrap_or_default(), raw },
        "usage" => AdapterEvent::Usage {
            usage_scope: opt_str("usageScope"),
            usage_key: opt_str("usageKey"),
            input_tokens_includes_cache: value.get("inputTokensIncludesCache").and_then(Value::as_bool),
            cache_creation_input_tokens: opt_i64("cacheCreationInputTokens"),
            reported_cost: value.get("reportedCost").and_then(Value::as_f64),
            estimated_cost: value.get("estimatedCost").and_then(Value::as_f64),
            currency: opt_str("currency"),
            input_tokens: opt_i64("inputTokens"),
            cached_input_tokens: opt_i64("cachedInputTokens"),
            output_tokens: opt_i64("outputTokens"),
            reasoning_output_tokens: opt_i64("reasoningOutputTokens"),
            context_used: opt_i64("contextUsed"),
            context_window: opt_i64("contextWindow"),
            raw,
        },
        "commands" => AdapterEvent::Commands { commands: value.get("commands").cloned().unwrap_or(Value::Null), raw },
        "artifact" => AdapterEvent::Artifact {
            artifact_type: opt_str("artifactType").unwrap_or_else(|| "file".to_string()),
            name: opt_str("name").unwrap_or_default(),
            mime_type: opt_str("mimeType"),
            data: opt_str("data"),
            path: opt_str("path"),
            raw,
        },
        "raw" => AdapterEvent::Raw {
            stream: opt_str("stream").unwrap_or_else(|| "stdout".to_string()),
            text: opt_str("text").unwrap_or_default(),
        },
        "exit" => AdapterEvent::Exit { exit_code: opt_i64("exitCode").map(|c| c as i32), signal: opt_str("signal") },
        "error" => AdapterEvent::Error { message: opt_str("message").unwrap_or_else(|| "plugin error".to_string()) },
        "timeout" => AdapterEvent::Timeout {
            reason: match opt_str("reason").as_deref() {
                Some("idle") => TimeoutKind::Idle,
                Some("max_output") => TimeoutKind::MaxOutput,
                _ => TimeoutKind::Timeout,
            },
        },
        _ => AdapterEvent::Raw { stream: "stdout".to_string(), text: value.to_string() },
    }
}

/// Serializes an AdapterStartRequest for the plugin wire (function fields are
/// not serializable; interactions/tools travel over reverse channels).
pub fn start_request_to_json(request: &AdapterStartRequest) -> Value {
    let mut map = serde_json::Map::new();
    if let Some(live)=request.native_terminal_live {map.insert("nativeTerminalLive".into(),Value::Bool(live));}
    if let Some(mode)=&request.agent_mode { map.insert("agentMode".into(),Value::String(mode.clone())); }
    if let Some(id)=&request.local_session_id {map.insert("localSessionId".into(),Value::String(id.clone()));}
    map.insert("instance".to_string(), request.instance.clone());
    map.insert("prompt".to_string(), Value::String(request.prompt.clone()));
    map.insert("cwd".to_string(), Value::String(request.cwd.clone()));
    if let Some(model) = &request.model {
        map.insert("model".to_string(), Value::String(model.clone()));
    }
    if let Some(effort) = &request.reasoning_effort {
        map.insert("reasoningEffort".to_string(), Value::String(effort.clone()));
    }
    if let Some(tier) = &request.service_tier {
        map.insert("serviceTier".to_string(), Value::String(tier.clone()));
    }
    if let Some(mode) = &request.permission_mode {
        map.insert("permissionMode".to_string(), Value::String(mode.clone()));
    }
    if let Some(window) = request.context_window {
        map.insert("contextWindow".to_string(), Value::from(window));
    }
    if let Some(env) = &request.env {
        map.insert("env".to_string(), serde_json::to_value(env).unwrap_or(Value::Null));
    }
    if let Some(timeout) = request.timeout_ms {
        map.insert("timeoutMs".to_string(), Value::from(timeout));
    }
    if let Some(idle) = request.idle_timeout_ms {
        map.insert("idleTimeoutMs".to_string(), Value::from(idle));
    }
    if let Some(max) = request.max_output_bytes {
        map.insert("maxOutputBytes".to_string(), Value::from(max));
    }
    if let Some(paths) = &request.local_image_paths {
        map.insert("localImagePaths".to_string(), serde_json::to_value(paths).unwrap_or(Value::Null));
    }
    if let Some(tools) = &request.runtime_tools {
        map.insert("runtimeTools".to_string(), tools.clone());
    }
    if let Some(skills) = &request.skills {
        map.insert("skills".to_string(), Value::Array(skills.clone()));
    }
    if let Some(servers) = &request.mcp_servers {
        map.insert("mcpServers".to_string(), Value::Array(servers.clone()));
    }
    if let Some(command) = &request.provider_command {
        map.insert("providerCommand".to_string(), Value::String(command.clone()));
    }
    if let Some(schema) = &request.output_schema_path {
        map.insert("outputSchemaPath".to_string(), Value::String(schema.clone()));
    }
    Value::Object(map)
}
