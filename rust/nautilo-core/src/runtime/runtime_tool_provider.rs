//! Runtime tool provider contract — port of runtime/runtime-tool-provider.ts.
//! The orchestration layer supplies the concrete implementation.

use serde_json::Value;

pub const RUNTIME_TOOL_SCHEMA_VERSION: i64 = 3;

pub struct RuntimeToolBinding {
    pub tools: Vec<Value>,
    pub execute: std::sync::Arc<dyn Fn(Value) -> crate::adapters::BoxFuture<anyhow::Result<Value>> + Send + Sync>,
}

pub trait RuntimeToolProvider: Send + Sync {
    fn for_run(&self, session: &Value, context: &Value, agent: &Value) -> Option<RuntimeToolBinding>;
}
