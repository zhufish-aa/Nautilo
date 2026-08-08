//! Planner decision parser — port of runtime/orchestration/planner-decision-parser.ts.
//! Converts the small, model-facing planning language into the complete
//! internal task contract.

use serde_json::{json, Map, Value};
use uuid::Uuid;

fn text(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)
}

fn strings(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(|item| text(Some(item))).collect())
        .unwrap_or_default()
}

fn differs_by_at_most_one(left: &str, right: &str) -> bool {
    if left == right {
        return true;
    }
    let left: Vec<char> = left.chars().collect();
    let right: Vec<char> = right.chars().collect();
    if left.len().abs_diff(right.len()) > 1 {
        return false;
    }
    let (short, long) = if left.len() > right.len() { (&right, &left) } else { (&left, &right) };
    let mut short_index = 0;
    let mut long_index = 0;
    let mut differences = 0;
    while short_index < short.len() && long_index < long.len() {
        if short[short_index] == long[long_index] {
            short_index += 1;
            long_index += 1;
            continue;
        }
        differences += 1;
        if differences > 1 {
            return false;
        }
        if short.len() == long.len() {
            short_index += 1;
        }
        long_index += 1;
    }
    differences + usize::from(long_index < long.len()) <= 1
}

fn criteria(value: Option<&Value>, task_id: &str) -> Vec<Value> {
    let Some(items) = value.and_then(Value::as_array) else {
        return vec![];
    };
    items
        .iter()
        .enumerate()
        .filter_map(|(index, item)| {
            if let Some(description) = text(Some(item)) {
                return Some(json!({
                    "id": format!("{task_id}-criterion-{}", index + 1),
                    "description": description,
                    "required": true
                }));
            }
            let source = item.as_object()?;
            let description = text(source.get("description"))?;
            let mut criterion = Map::new();
            criterion.insert(
                "id".to_string(),
                json!(text(source.get("id")).unwrap_or_else(|| format!("{task_id}-criterion-{}", index + 1))),
            );
            criterion.insert("description".to_string(), json!(description));
            if let Some(template) = text(source.get("commandTemplateId")) {
                criterion.insert("commandTemplateId".to_string(), json!(template));
            }
            criterion.insert(
                "required".to_string(),
                json!(source.get("required").and_then(Value::as_bool).unwrap_or(true)),
            );
            Some(Value::Object(criterion))
        })
        .collect()
}

fn context_needs(value: Option<&Value>) -> Vec<Value> {
    let Some(items) = value.and_then(Value::as_array) else {
        return vec![];
    };
    items
        .iter()
        .filter_map(|item| {
            let source = item.as_object()?;
            let kind = text(source.get("kind"))?;
            let reference = text(source.get("reference"))?;
            let reason = text(source.get("reason"))?;
            if !["file", "artifact", "decision", "verification"].contains(&kind.as_str()) {
                return None;
            }
            Some(json!({ "kind": kind, "reference": reference, "reason": reason }))
        })
        .collect()
}

pub struct PlannerDecisionParser;

impl PlannerDecisionParser {
    pub fn new() -> Self {
        Self
    }

    pub fn parse(&self, value: &Value, team: &Value) -> Value {
        let Some(source) = value.as_object() else {
            return value.clone();
        };
        let mode = text(source.get("mode"));
        let rationale = text(source.get("rationale"))
            .or_else(|| text(source.get("reason")))
            .unwrap_or_else(|| format!("main_agent_selected_{}", mode.clone().unwrap_or_else(|| "unknown".to_string())));
        match mode.as_deref() {
            Some("direct") => return json!({ "mode": "direct", "rationale": rationale }),
            Some("delegate") => {
                let task_source = match source.get("task") {
                    Some(Value::String(task)) => json!({
                        "task": task,
                        "memberId": source.get("memberId").cloned().unwrap_or(Value::Null),
                        "continueSessionId": source.get("continueSessionId").cloned().unwrap_or(Value::Null)
                    }),
                    other => other.cloned().unwrap_or(Value::Null),
                };
                if !task_source.is_object() {
                    return value.clone();
                }
                let task = self.task(&task_source, 0, &rationale, team);
                return json!({ "mode": "delegate", "rationale": rationale, "task": task });
            }
            Some("plan") => {
                if let Some(tasks) = source.get("tasks").and_then(Value::as_array) {
                    let mapped: Vec<Value> = tasks
                        .iter()
                        .enumerate()
                        .map(|(index, item)| self.task(item, index, &rationale, team))
                        .collect();
                    return json!({ "mode": "plan", "rationale": rationale, "tasks": mapped });
                }
            }
            _ => {}
        }
        value.clone()
    }

    fn task(&self, source: &Value, index: usize, rationale: &str, team: &Value) -> Value {
        let id = text(source.get("id")).unwrap_or_else(|| format!("task-{}", index + 1));
        let objective = text(source.get("objective"))
            .or_else(|| text(source.get("task")))
            .or_else(|| text(source.get("title")))
            .unwrap_or_default();
        let requested_member = text(source.get("assignedMemberId")).or_else(|| text(source.get("memberId"))).unwrap_or_default();
        let member = self.member(team, &requested_member);
        let allowed: Vec<String> = member
            .as_ref()
            .and_then(|m| m.get("allowedTaskTypes").and_then(Value::as_array).cloned())
            .map(|types| types.iter().filter_map(Value::as_str).map(str::to_string).collect())
            .unwrap_or_default();
        let task_type = text(source.get("taskType"))
            .or_else(|| text(source.get("type")))
            .unwrap_or_else(|| allowed.iter().find(|t| *t != "*").cloned().unwrap_or_else(|| "general".to_string()));

        let mut task = Map::new();
        task.insert("id".to_string(), json!(id));
        task.insert(
            "title".to_string(),
            json!(text(source.get("title")).unwrap_or_else(|| objective.chars().take(80).collect::<String>())),
        );
        task.insert("objective".to_string(), json!(objective));
        task.insert("taskType".to_string(), json!(task_type));
        task.insert(
            "assignedMemberId".to_string(),
            json!(member
                .as_ref()
                .and_then(|m| m.get("id"))
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or(requested_member)),
        );
        if let Some(continue_session) = text(source.get("continueSessionId")).or_else(|| text(source.get("targetSessionId"))) {
            task.insert("targetSessionId".to_string(), json!(continue_session));
        }
        // dependencies/dependsOn: the first present list wins, matching the
        // TS `source.dependencies ?? source.dependsOn` semantics.
        let dependencies = match source.get("dependencies") {
            Some(value) if value.is_array() => strings(Some(value)),
            _ => strings(source.get("dependsOn")),
        };
        task.insert("dependencies".to_string(), json!(dependencies));
        task.insert(
            "allowedPaths".to_string(),
            json!(match source.get("allowedPaths") {
                Some(value) if value.is_array() => strings(Some(value)),
                _ => strings(source.get("paths")),
            }),
        );
        task.insert(
            "acceptanceCriteria".to_string(),
            Value::Array(criteria(
                match source.get("acceptanceCriteria") {
                    Some(value) if value.is_array() => Some(value),
                    _ => source.get("acceptance"),
                },
                task.get("id").and_then(Value::as_str).unwrap_or(""),
            )),
        );
        task.insert("contextNeeds".to_string(), Value::Array(context_needs(source.get("contextNeeds"))));
        task.insert(
            "assignmentReason".to_string(),
            json!(text(source.get("assignmentReason")).or_else(|| text(source.get("reason"))).unwrap_or_else(|| rationale.to_string())),
        );
        Value::Object(task)
    }

    /// Auto-routes only when the configured team leaves exactly one enabled
    /// candidate; exact id and single name matches come first.
    fn member(&self, team: &Value, requested: &str) -> Option<Value> {
        let main_member_id = team.get("mainMemberId").and_then(Value::as_str);
        let enabled: Vec<Value> = team
            .get("members")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter(|member| {
                member.get("enabled").and_then(Value::as_bool) == Some(true)
                    && member.get("id").and_then(Value::as_str) != main_member_id
            })
            .collect();
        if let Some(exact) = enabled.iter().find(|member| member.get("id").and_then(Value::as_str) == Some(requested)) {
            return Some(exact.clone());
        }
        let by_name: Vec<&Value> = enabled
            .iter()
            .filter(|member| {
                member
                    .get("displayName")
                    .and_then(Value::as_str)
                    .is_some_and(|name| name.eq_ignore_ascii_case(requested))
            })
            .collect();
        if by_name.len() == 1 {
            return Some(by_name[0].clone());
        }
        if enabled.len() == 1 {
            let only = &enabled[0];
            let only_id = only.get("id").and_then(Value::as_str).unwrap_or("");
            if requested.is_empty() || differs_by_at_most_one(only_id, requested) {
                return Some(only.clone());
            }
        }
        None
    }
}

impl Default for PlannerDecisionParser {
    fn default() -> Self {
        Self::new()
    }
}

/// RuntimeToolDecisionBuilder support: fresh task ids for tool-call plans.
pub fn runtime_tool_task_id() -> String {
    Uuid::new_v4().to_string()
}
