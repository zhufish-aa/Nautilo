//! Runtime tool decision building — port of
//! runtime/orchestration/runtime-tool-decision.ts.

use serde_json::{json, Map, Value};
use uuid::Uuid;

use crate::errors::{CoreError, CoreResult, ErrorCode};
use crate::runtime::orchestration::decision_validator::DecisionValidator;
use crate::runtime::orchestration::runtime_tool_names::{normalize_runtime_tool_name, RUNTIME_TOOL_DELEGATE, RUNTIME_TOOL_PLAN};

/// Converts the compact provider-tool arguments into the internal validated
/// task contract.
pub struct RuntimeToolDecisionBuilder<'a> {
    decisions: &'a DecisionValidator,
}

impl<'a> RuntimeToolDecisionBuilder<'a> {
    pub fn new(decisions: &'a DecisionValidator) -> Self {
        Self { decisions }
    }

    pub fn build(&self, tool_name: &str, input: &Value, team: &Value) -> CoreResult<Value> {
        let normalized = normalize_runtime_tool_name(tool_name);
        let candidate = if normalized == RUNTIME_TOOL_DELEGATE {
            json!({
                "mode": "delegate",
                "rationale": "runtime_tool",
                "task": {
                    "id": Uuid::new_v4().to_string(),
                    "memberId": input.get("memberId").cloned().unwrap_or(Value::Null),
                    "task": input.get("task").cloned().unwrap_or(Value::Null),
                    "continueSessionId": input.get("continueSessionId").cloned().unwrap_or(Value::Null)
                }
            })
        } else if normalized == RUNTIME_TOOL_PLAN {
            let raw_tasks = input.get("tasks").and_then(Value::as_array).cloned().unwrap_or_default();
            let mut local_ids: Map<String, Value> = Map::new();
            for task in &raw_tasks {
                let local_id = task.get("id").and_then(Value::as_str).unwrap_or("").trim().to_string();
                if !local_id.is_empty() && !local_ids.contains_key(&local_id) {
                    local_ids.insert(local_id, json!(Uuid::new_v4().to_string()));
                }
            }
            let tasks: Vec<Value> = raw_tasks
                .iter()
                .map(|task| {
                    let local_id = task.get("id").and_then(Value::as_str).unwrap_or("").trim().to_string();
                    let depends_on: Vec<Value> = task
                        .get("dependsOn")
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_default()
                        .iter()
                        .map(|id| {
                            let key = id.as_str().unwrap_or("").trim();
                            local_ids.get(key).cloned().unwrap_or_else(|| json!(key))
                        })
                        .collect();
                    json!({
                        "id": local_ids.get(&local_id).cloned().unwrap_or_else(|| json!(Uuid::new_v4().to_string())),
                        "memberId": task.get("memberId").cloned().unwrap_or(Value::Null),
                        "task": task.get("task").cloned().unwrap_or(Value::Null),
                        "continueSessionId": task.get("continueSessionId").cloned().unwrap_or(Value::Null),
                        "dependsOn": depends_on
                    })
                })
                .collect();
            json!({ "mode": "plan", "rationale": "runtime_tool", "tasks": tasks })
        } else {
            let mut details = Map::new();
            details.insert("field".to_string(), json!("toolName"));
            details.insert("value".to_string(), json!(tool_name));
            return Err(CoreError::details(ErrorCode::IpcInvalidRequest, details));
        };
        let decision = self.decisions.planner(&candidate, team)?;
        if decision.get("mode").and_then(Value::as_str) == Some("direct") {
            let mut details = Map::new();
            details.insert("reason".to_string(), json!("runtime_tool_direct_mode"));
            return Err(CoreError::details(ErrorCode::PlanSchemaInvalid, details));
        }
        Ok(decision)
    }
}
