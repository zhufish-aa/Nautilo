//! Decision validation — port of runtime/orchestration/decision-validator.ts.

use serde_json::{Map, Value};

use crate::domain;
use crate::errors::{CoreError, CoreResult, ErrorCode};
use crate::runtime::orchestration::member_router::MemberRouter;
use crate::runtime::orchestration::planner_decision_parser::PlannerDecisionParser;

fn plan_invalid(details: &[(&str, Value)]) -> CoreError {
    let mut map = Map::new();
    for (key, value) in details {
        map.insert(key.to_string(), value.clone());
    }
    CoreError::details(ErrorCode::PlanSchemaInvalid, map)
}

pub struct DecisionValidator {
    members: MemberRouter,
    parser: PlannerDecisionParser,
}

impl DecisionValidator {
    pub fn new(members: MemberRouter) -> Self {
        Self { members, parser: PlannerDecisionParser::new() }
    }

    pub fn planner(&self, value: &Value, team: &Value) -> CoreResult<Value> {
        let parsed = self.parser.parse(value, team);
        if !domain::is_planner_decision(&parsed) {
            return Err(plan_invalid(&[]));
        }
        let mode = parsed.get("mode").and_then(Value::as_str).unwrap_or("");
        if mode == "direct" {
            return Ok(parsed);
        }
        if team.get("delegationPolicy").and_then(Value::as_str) == Some("direct_only") {
            let mut details = Map::new();
            details.insert("teamId".to_string(), team.get("id").cloned().unwrap_or(Value::Null));
            return Err(CoreError::details(ErrorCode::PlanDelegationNotAllowed, details));
        }
        let tasks: Vec<Value> = if mode == "delegate" {
            vec![parsed.get("task").cloned().unwrap_or(Value::Null)]
        } else {
            parsed.get("tasks").and_then(Value::as_array).cloned().unwrap_or_default()
        };
        self.validate_tasks(&tasks, team)?;
        Ok(parsed)
    }

    pub fn recovery(&self, value: &Value, task: &Value, team: &Value) -> CoreResult<Value> {
        if !domain::is_recovery_decision(value) {
            let mut details = Map::new();
            details.insert("taskId".to_string(), task.get("id").cloned().unwrap_or(Value::Null));
            return Err(CoreError::details(ErrorCode::RecoverySchemaInvalid, details));
        }
        let task_id = task.get("id").and_then(Value::as_str).unwrap_or("");
        if value.get("taskId").and_then(Value::as_str) != Some(task_id) {
            let mut details = Map::new();
            details.insert("expectedTaskId".to_string(), json_str(task_id));
            details.insert("actualTaskId".to_string(), value.get("taskId").cloned().unwrap_or(Value::Null));
            return Err(CoreError::details(ErrorCode::RecoverySchemaInvalid, details));
        }
        if value.get("action").and_then(Value::as_str) == Some("retry") {
            if let Some(member_id) = value.get("assignedMemberId").and_then(Value::as_str) {
                self.members.resolve(team, member_id, task.get("taskType").and_then(Value::as_str))?;
            }
        }
        Ok(value.clone())
    }

    fn validate_tasks(&self, tasks: &[Value], team: &Value) -> CoreResult<()> {
        if tasks.len() > 50 {
            return Err(plan_invalid(&[("reason", json_str("too_many_tasks")), ("maximum", Value::from(50))]));
        }
        let mut ids = std::collections::HashSet::new();
        for task in tasks {
            let blank = ["id", "title", "objective", "taskType"]
                .iter()
                .any(|key| task.get(*key).and_then(Value::as_str).map(str::trim).unwrap_or("").is_empty());
            if blank {
                return Err(plan_invalid(&[
                    ("taskId", task.get("id").cloned().unwrap_or(Value::Null)),
                    ("reason", json_str("blank_required_field")),
                ]));
            }
            let id = task.get("id").and_then(Value::as_str).unwrap_or("");
            if !ids.insert(id.to_string()) {
                return Err(plan_invalid(&[("taskId", json_str(id)), ("reason", json_str("duplicate_task_id"))]));
            }
            self.members.resolve(
                team,
                task.get("assignedMemberId").and_then(Value::as_str).unwrap_or(""),
                task.get("taskType").and_then(Value::as_str),
            )?;
        }
        for task in tasks {
            let task_id = task.get("id").and_then(Value::as_str).unwrap_or("");
            for dependency in task.get("dependencies").and_then(Value::as_array).cloned().unwrap_or_default() {
                let dependency = dependency.as_str().unwrap_or("");
                if !ids.contains(dependency) {
                    let mut details = Map::new();
                    details.insert("taskId".to_string(), json_str(task_id));
                    details.insert("dependency".to_string(), json_str(dependency));
                    return Err(CoreError::details(ErrorCode::PlanDependencyNotFound, details));
                }
                if dependency == task_id {
                    let mut details = Map::new();
                    details.insert("taskId".to_string(), json_str(task_id));
                    return Err(CoreError::details(ErrorCode::PlanDependencyCycle, details));
                }
            }
        }
        self.assert_acyclic(tasks)
    }

    fn assert_acyclic(&self, tasks: &[Value]) -> CoreResult<()> {
        let mut visiting = std::collections::HashSet::new();
        let mut visited = std::collections::HashSet::new();
        for task in tasks {
            self.visit(task.get("id").and_then(Value::as_str).unwrap_or(""), tasks, &mut visiting, &mut visited)?;
        }
        Ok(())
    }

    fn visit(
        &self,
        task_id: &str,
        tasks: &[Value],
        visiting: &mut std::collections::HashSet<String>,
        visited: &mut std::collections::HashSet<String>,
    ) -> CoreResult<()> {
        if visiting.contains(task_id) {
            let mut details = Map::new();
            details.insert("taskId".to_string(), json_str(task_id));
            return Err(CoreError::details(ErrorCode::PlanDependencyCycle, details));
        }
        if visited.contains(task_id) {
            return Ok(());
        }
        visiting.insert(task_id.to_string());
        let dependencies = tasks
            .iter()
            .find(|task| task.get("id").and_then(Value::as_str) == Some(task_id))
            .and_then(|task| task.get("dependencies").and_then(Value::as_array).cloned())
            .unwrap_or_default();
        for dependency in dependencies {
            if let Some(dependency) = dependency.as_str() {
                self.visit(dependency, tasks, visiting, visited)?;
            }
        }
        visiting.remove(task_id);
        visited.insert(task_id.to_string());
        Ok(())
    }
}

fn json_str(value: &str) -> Value {
    Value::String(value.to_string())
}
