//! Runtime tool names + tool-call decision building —
//! port of runtime/orchestration/runtime-tool-names.ts and
//! runtime-tool-decision.ts.

pub const RUNTIME_TOOL_DELEGATE: &str = "agenthub_delegate";
pub const RUNTIME_TOOL_PLAN: &str = "agenthub_plan";
pub const RUNTIME_TOOL_WEB_SEARCH: &str = "agenthub_web_search";

/// Accepts legacy dotted names; newly registered tools use provider-safe names.
pub fn normalize_runtime_tool_name(name: &str) -> &str {
    match name {
        "agenthub.delegate" => RUNTIME_TOOL_DELEGATE,
        "agenthub.plan" => RUNTIME_TOOL_PLAN,
        other => other,
    }
}


pub use crate::runtime::orchestration::runtime_tool_decision::RuntimeToolDecisionBuilder;
