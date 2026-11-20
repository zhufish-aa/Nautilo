//! Runtime tool provider contract — port of runtime/runtime-tool-provider.ts.
//! The orchestration layer supplies the concrete implementation.

use serde_json::Value;

pub const RUNTIME_TOOL_SCHEMA_VERSION: i64 = 3;

pub struct RuntimeToolBinding {
    pub tools: Vec<Value>,
    /// Native adapters/MCP bridges consume {success: bool, content: string}.
    /// The content is JSON text when a tool returns a structured receipt.
    pub execute: std::sync::Arc<dyn Fn(Value) -> crate::adapters::BoxFuture<anyhow::Result<Value>> + Send + Sync>,
}

pub trait RuntimeToolProvider: Send + Sync {
    fn for_run(&self, session: &Value, context: &Value, agent: &Value) -> Option<RuntimeToolBinding>;
}
