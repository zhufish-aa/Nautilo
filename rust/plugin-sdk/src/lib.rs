//! agenthub-plugin-sdk — the native provider plugin contract.
//!
//! A Nautilo provider plugin is a standalone native executable. The daemon
//! (nautilo-core) spawns it and talks newline-delimited JSON over stdio:
//!
//!   daemon → plugin   {"type":"handshake","apiVersion":1}
//!   plugin → daemon   {"type":"ready","descriptor":{...},"capabilities":{...}}
//!
//!   daemon → plugin   {"type":"call","id":1,"method":"detect","input":{...}}
//!   plugin → daemon   {"type":"response","id":1,"ok":true,"data":{...}}
//!
//!   daemon → plugin   {"type":"start","runId":"…","resume":null|"provider-session-id","request":{...}}
//!   plugin → daemon   {"type":"event","runId":"…","event":{...}}   (repeated)
//!   daemon → plugin   {"type":"cancel","runId":"…"}
//!   daemon → plugin   {"type":"steer","runId":"…","input":"…"}
//!
//! `call` methods: detect, listModels, dispose. Runs stream AdapterEvents
//! (same JSON shape as the TS provider-sdk) and end with an `exit` event.

use serde_json::{json, Value};

pub mod jsonrpc;
pub mod process;
pub mod serve;

pub use serve::serve;

pub const PROVIDER_API_VERSION: u32 = 1;

/// Plugin → daemon question bridge: the plugin sends
/// {"type":"interaction","id":N,"runId":"…","input":{...}} and the daemon
/// answers {"type":"interaction_response","id":N,"response":{...}}.
///
/// One message from the daemon to the plugin.
#[derive(Debug, Clone)]
pub enum HostMessage {
    Handshake { api_version: u32 },
    Call { id: i64, method: String, input: Value },
    Start { run_id: String, resume: Option<String>, request: Value },
    Cancel { run_id: String },
    Steer { run_id: String, input: String },
    InteractionResponse { id: i64, response: Value },
    ToolResponse { id: i64, result: Value },
}

impl HostMessage {
    pub fn parse(line: &str) -> Option<Self> {
        let value: Value = serde_json::from_str(line).ok()?;
        match value.get("type").and_then(Value::as_str)? {
            "handshake" => Some(Self::Handshake {
                api_version: value.get("apiVersion").and_then(Value::as_u64).unwrap_or(0) as u32,
            }),
            "call" => Some(Self::Call {
                id: value.get("id").and_then(Value::as_i64)?,
                method: value.get("method").and_then(Value::as_str)?.to_string(),
                input: value.get("input").cloned().unwrap_or(Value::Null),
            }),
            "start" => Some(Self::Start {
                run_id: value.get("runId").and_then(Value::as_str)?.to_string(),
                resume: value.get("resume").and_then(Value::as_str).map(str::to_string),
                request: value.get("request").cloned().unwrap_or(Value::Null),
            }),
            "cancel" => Some(Self::Cancel { run_id: value.get("runId").and_then(Value::as_str)?.to_string() }),
            "steer" => Some(Self::Steer {
                run_id: value.get("runId").and_then(Value::as_str)?.to_string(),
                input: value.get("input").and_then(Value::as_str).unwrap_or("").to_string(),
            }),
            "interaction_response" => Some(Self::InteractionResponse {
                id: value.get("id").and_then(Value::as_i64)?,
                response: value.get("response").cloned().unwrap_or(Value::Null),
            }),
            "tool_response" => Some(Self::ToolResponse {
                id: value.get("id").and_then(Value::as_i64)?,
                result: value.get("result").cloned().unwrap_or(Value::Null),
            }),
            _ => None,
        }
    }
}

/// The plugin's side of the wire.
pub mod emit {
    use serde_json::{json, Value};

    pub fn interaction(id: i64, run_id: &str, input: &Value) -> Value {
        json!({ "type": "interaction", "id": id, "runId": run_id, "input": input })
    }

    /// Reverse tool execution: the provider CLI invoked one of the daemon's
    /// runtime tools (agenthub_delegate / agenthub_plan); the plugin forwards
    /// the call and the daemon executes it.
    pub fn tool_call(id: i64, run_id: &str, name: &str, arguments: &Value) -> Value {
        json!({ "type": "tool_call", "id": id, "runId": run_id, "name": name, "arguments": arguments })
    }

    pub fn ready(descriptor: &Value, capabilities: &Value) -> Value {
        json!({ "type": "ready", "descriptor": descriptor, "capabilities": capabilities })
    }

    pub fn response(id: i64, data: Value) -> Value {
        json!({ "type": "response", "id": id, "ok": true, "data": data })
    }

    pub fn failure(id: i64, message: &str) -> Value {
        json!({ "type": "response", "id": id, "ok": false, "error": message })
    }

    pub fn event(run_id: &str, event: &Value) -> Value {
        json!({ "type": "event", "runId": run_id, "event": event })
    }
}

/// Reverse call channel into the daemon (interactions + runtime tools).
pub trait DaemonChannel: Send + Sync {
    fn ask(
        &self,
        run_id: &str,
        input: Value,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Value> + Send + '_>>;
    fn call_tool(
        &self,
        run_id: &str,
        name: &str,
        arguments: Value,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Value> + Send + '_>>;
}

/// Implemented by the SDK's serve loop; provider CLIs' permission/question
/// prompts reach the desktop user through it.
pub trait InteractionChannel: Send + Sync {
    fn ask(
        &self,
        run_id: &str,
        input: Value,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Value> + Send + '_>>;
}

/// The plugin author's contract. `start` returns a channel receiver that
/// streams AdapterEvent JSON values; the SDK forwards them to the daemon.
#[async_trait::async_trait]
pub trait ProviderPlugin: Send + Sync {
    /// The ProviderDescriptor JSON (kept in sync with agenthub-plugin.json).
    fn descriptor(&self) -> Value;
    /// {structuredOutput, textOutput, interactiveStdin, nativeResume, pty}
    fn capabilities(&self) -> Value {
        json!({
            "structuredOutput": false,
            "textOutput": true,
            "interactiveStdin": false,
            "nativeResume": false,
            "pty": false
        })
    }
    async fn detect(&self, instance: &Value) -> Value;
    async fn list_models(&self, instance: &Value, context: &Value) -> anyhow::Result<Value> {
        let _ = (instance, context);
        anyhow::bail!("models_unavailable")
    }
    /// Receives the daemon interaction channel at startup.
    fn set_interaction_channel(&self, _channel: std::sync::Arc<dyn InteractionChannel>) {}

    /// Starts (or resumes) a provider turn. Events must end with `exit`.
    async fn start(
        &self,
        request: Value,
        resume: Option<String>,
    ) -> anyhow::Result<tokio::sync::mpsc::UnboundedReceiver<Value>>;
    /// Mid-turn guidance. Default: unsupported.
    async fn steer(&self, _run_id: &str, _input: &str) -> anyhow::Result<()> {
        anyhow::bail!("steer_unsupported")
    }
    /// Cancels an in-flight run.
    async fn cancel(&self, _run_id: &str) {}
    /// Releases long-lived resources before unload.
    async fn dispose(&self) {}
}
