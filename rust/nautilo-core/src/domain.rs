//! Domain state machines + planner decision validation —
//! port of packages/domain/src/state.ts and the planner/recovery validators
//! in packages/schemas/src/index.ts.

use serde_json::Value;

fn transitions(from: &str, table: &'static [(&'static str, &'static [&'static str])]) -> Vec<&'static str> {
    table.iter().find(|(key, _)| *key == from).map(|(_, to)| to.to_vec()).unwrap_or_default()
}

const TASK_TRANSITIONS: &[(&str, &[&str])] = &[
    ("draft", &["ready", "cancelled"]),
    ("ready", &["queued", "blocked_dependency", "cancelled"]),
    ("blocked_dependency", &["ready", "cancelled"]),
    ("queued", &["running", "cancelled"]),
    ("running", &["waiting_user", "waiting_approval", "verifying", "completed", "failed", "cancelled"]),
    ("waiting_user", &["running", "failed", "cancelled"]),
    ("waiting_approval", &["ready", "blocked_dependency", "running", "failed", "cancelled"]),
    ("verifying", &["review_required", "merge_ready", "completed", "failed"]),
    ("review_required", &["merge_ready", "running", "failed"]),
    ("merge_ready", &["completed", "running", "failed"]),
    ("completed", &[]),
    ("failed", &["ready", "queued", "cancelled"]),
    ("cancelled", &["ready"]),
];

const PROJECT_RUN_TRANSITIONS: &[(&str, &[&str])] = &[
    ("planning", &["plan_review", "executing", "waiting_user", "paused", "failed", "cancelled"]),
    ("plan_review", &["planning", "executing", "cancelled"]),
    ("executing", &["waiting_user", "paused", "verifying", "completed", "failed", "cancelled"]),
    ("waiting_user", &["executing", "failed", "cancelled"]),
    ("paused", &["planning", "executing", "cancelled"]),
    ("verifying", &["paused", "review_required", "merge_ready", "completed", "failed"]),
    ("review_required", &["merge_ready", "executing", "failed"]),
    ("merge_ready", &["merging", "review_required", "executing", "failed"]),
    ("merging", &["paused", "completed", "review_required", "failed"]),
    // A chat session may receive another user turn after a previously
    // completed orchestration cycle; runtime-tool delegation reopens it.
    ("completed", &["executing", "waiting_user"]),
    ("failed", &["planning", "executing", "cancelled"]),
    ("cancelled", &[]),
];

const SESSION_TRANSITIONS: &[(&str, &[&str])] = &[
    ("idle", &["running", "archived"]),
    ("running", &["waiting_input", "waiting_approval", "completed", "failed", "idle"]),
    ("waiting_input", &["running", "failed", "archived"]),
    ("waiting_approval", &["running", "failed", "archived"]),
    ("completed", &["idle", "archived"]),
    ("failed", &["idle", "running", "archived"]),
    ("archived", &["idle"]),
];

pub fn can_transition_task(from: &str, to: &str) -> bool {
    transitions(from, TASK_TRANSITIONS).contains(&to)
}

pub fn can_transition_project_run(from: &str, to: &str) -> bool {
    transitions(from, PROJECT_RUN_TRANSITIONS).contains(&to)
}

pub fn can_transition_session(from: &str, to: &str) -> bool {
    transitions(from, SESSION_TRANSITIONS).contains(&to)
}

pub fn available_actions(input: &Value) -> Vec<&'static str> {
    let mut actions: Vec<&'static str> = vec![];
    let mut push = |action: &'static str| {
        if !actions.contains(&action) {
            actions.push(action);
        }
    };
    let session_status = input.get("sessionStatus").and_then(Value::as_str);
    if let Some(status) = session_status {
        if !["archived", "completed"].contains(&status) {
            push("send_message");
        }
    }
    match input.get("runStatus").and_then(Value::as_str) {
        Some("running" | "waiting_input") => push("stop_run"),
        Some("failed" | "crashed" | "timed_out") => push("retry_run"),
        Some("cancelled" | "cancelling") => push("resume_run"),
        _ => {}
    }
    if input.get("approvalRequired").and_then(Value::as_bool) == Some(true) {
        push("approve");
        push("reject");
    }
    match input.get("taskStatus").and_then(Value::as_str) {
        Some("running" | "waiting_user") => push("cancel_task"),
        Some("failed") => push("retry_task"),
        Some("merge_ready") => push("merge"),
        _ => {}
    }
    actions
}

// ---------------------------------------------------------------- planner decisions

fn is_acceptance_criterion(value: &Value) -> bool {
    value.get("id").and_then(Value::as_str).is_some()
        && value.get("description").and_then(Value::as_str).is_some()
        && value.get("required").and_then(Value::as_bool).is_some()
}

fn is_context_need(value: &Value) -> bool {
    let kind = value.get("kind").and_then(Value::as_str).unwrap_or("");
    ["file", "artifact", "decision", "verification"].contains(&kind)
        && value.get("reference").and_then(Value::as_str).is_some()
        && value.get("reason").and_then(Value::as_str).is_some()
}

fn is_string_array(value: Option<&Value>) -> bool {
    value.and_then(Value::as_array).is_some_and(|items| items.iter().all(|item| item.is_string()))
}

pub fn is_planned_task(value: &Value) -> bool {
    value.get("id").and_then(Value::as_str).is_some()
        && value.get("title").and_then(Value::as_str).is_some()
        && value.get("objective").and_then(Value::as_str).is_some()
        && value.get("taskType").and_then(Value::as_str).is_some()
        && value.get("assignedMemberId").and_then(Value::as_str).is_some()
        && value.get("targetSessionId").is_none_or(|v| v.is_string() || v.is_null())
        && is_string_array(value.get("dependencies"))
        && is_string_array(value.get("allowedPaths"))
        && value
            .get("acceptanceCriteria")
            .and_then(Value::as_array)
            .is_some_and(|items| items.iter().all(is_acceptance_criterion))
        && value.get("contextNeeds").and_then(Value::as_array).is_some_and(|items| items.iter().all(is_context_need))
        && value.get("assignmentReason").and_then(Value::as_str).is_some()
}

pub fn is_planner_decision(value: &Value) -> bool {
    if !value.is_object() {
        return false;
    }
    if value.get("rationale").and_then(Value::as_str).is_none() {
        return false;
    }
    match value.get("mode").and_then(Value::as_str) {
        Some("direct") => true,
        Some("delegate") => value.get("task").is_some_and(is_planned_task),
        Some("plan") => value
            .get("tasks")
            .and_then(Value::as_array)
            .is_some_and(|tasks| !tasks.is_empty() && tasks.iter().all(is_planned_task)),
        _ => false,
    }
}

pub fn is_recovery_decision(value: &Value) -> bool {
    if !value.is_object() {
        return false;
    }
    let action = value.get("action").and_then(Value::as_str).unwrap_or("");
    if !["retry", "take_over", "continue"].contains(&action) {
        return false;
    }
    if value.get("taskId").and_then(Value::as_str).is_none() || value.get("rationale").and_then(Value::as_str).is_none() {
        return false;
    }
    action != "retry" || value.get("assignedMemberId").is_none_or(|v| v.is_string() || v.is_null())
}
