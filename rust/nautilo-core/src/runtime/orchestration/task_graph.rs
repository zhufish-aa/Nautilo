//! Task graph — port of runtime/orchestration/task-graph.ts.

use std::sync::{Arc, Mutex};

use serde_json::{json, Map, Value};

use crate::database::{Database, Repositories};
use crate::domain::can_transition_task;
use crate::errors::{now_iso, CoreResult};

pub struct TaskGraph {
    db: Arc<Mutex<Database>>,
}

impl TaskGraph {
    pub fn new(db: Arc<Mutex<Database>>) -> Self {
        Self { db }
    }

    pub fn create(&self, project_run_id: &str, planned: &[Value], waiting_approval: bool) -> CoreResult<Vec<Value>> {
        let now = now_iso();
        let mut tasks = vec![];
        for (index, item) in planned.iter().enumerate() {
            let dependencies = item.get("dependencies").and_then(Value::as_array).cloned().unwrap_or_default();
            let status = if waiting_approval {
                "waiting_approval"
            } else if dependencies.is_empty() {
                "ready"
            } else {
                "blocked_dependency"
            };
            let mut task = Map::new();
            for key in ["id", "title", "objective", "taskType", "assignedMemberId", "targetSessionId", "allowedPaths", "acceptanceCriteria"] {
                if let Some(value) = item.get(key).cloned().filter(|v| !v.is_null()) {
                    task.insert(key.to_string(), value);
                }
            }
            task.insert("projectRunId".to_string(), json!(project_run_id));
            task.insert("dependencies".to_string(), Value::Array(dependencies));
            task.insert("status".to_string(), json!(status));
            task.insert("attempt".to_string(), json!(1));
            task.insert("priority".to_string(), json!(index));
            task.insert("createdAt".to_string(), json!(now_iso()));
            task.insert("updatedAt".to_string(), json!(now_iso()));
            let task = Value::Object(task);
            Repositories::new(&self.db.lock().unwrap().raw).tasks().save(&task)?;
            tasks.push(task);
        }
        Ok(tasks)
    }

    pub fn release_approval(&self, project_run_id: &str) -> CoreResult<Vec<Value>> {
        let tasks = Repositories::new(&self.db.lock().unwrap().raw).tasks().list(project_run_id)?;
        for task in &tasks {
            if task.get("status").and_then(Value::as_str) != Some("waiting_approval") {
                continue;
            }
            let has_dependencies = task.get("dependencies").and_then(Value::as_array).is_some_and(|d| !d.is_empty());
            self.save_status(task, if has_dependencies { "blocked_dependency" } else { "ready" }, None)?;
        }
        Repositories::new(&self.db.lock().unwrap().raw).tasks().list(project_run_id)
    }

    pub fn refresh(&self, project_run_id: &str) -> CoreResult<Vec<Value>> {
        let tasks = Repositories::new(&self.db.lock().unwrap().raw).tasks().list(project_run_id)?;
        for task in &tasks {
            if task.get("status").and_then(Value::as_str) != Some("blocked_dependency") {
                continue;
            }
            let completed = task
                .get("dependencies")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
                .iter()
                .all(|dependency| {
                    let id = dependency.as_str().unwrap_or("");
                    tasks
                        .iter()
                        .find(|candidate| candidate.get("id").and_then(Value::as_str) == Some(id))
                        .and_then(|candidate| candidate.get("status").and_then(Value::as_str))
                        == Some("completed")
                });
            if completed {
                self.save_status(task, "ready", None)?;
            }
        }
        Repositories::new(&self.db.lock().unwrap().raw).tasks().list(project_run_id)
    }

    pub fn ready(&self, project_run_id: &str) -> CoreResult<Vec<Value>> {
        let mut ready: Vec<Value> = self
            .refresh(project_run_id)?
            .into_iter()
            .filter(|task| task.get("status").and_then(Value::as_str) == Some("ready"))
            .collect();
        ready.sort_by_key(|task| task.get("priority").and_then(Value::as_i64).unwrap_or(0));
        Ok(ready)
    }

    pub fn save_status(&self, task: &Value, status: &str, patch: Option<Value>) -> CoreResult<Value> {
        let current = task.get("status").and_then(Value::as_str).unwrap_or("");
        if current != status && !can_transition_task(current, status) {
            let id = task.get("id").and_then(Value::as_str).unwrap_or("");
            return Err(crate::errors::CoreError::reason(
                crate::errors::ErrorCode::IpcInternalError,
                format!("Invalid task transition {current} -> {status} for {id}"),
            ));
        }
        let mut updated = task.as_object().cloned().unwrap_or_default();
        if let Some(patch) = patch.and_then(|p| p.as_object().cloned()) {
            for (key, value) in patch {
                updated.insert(key, value);
            }
        }
        updated.insert("status".to_string(), json!(status));
        updated.insert("updatedAt".to_string(), json!(now_iso()));
        let updated = Value::Object(updated);
        Repositories::new(&self.db.lock().unwrap().raw).tasks().save(&updated)?;
        Ok(updated)
    }

    pub fn cancel_dependents(&self, project_run_id: &str, failed_task_id: &str) -> CoreResult<Vec<Value>> {
        let tasks = Repositories::new(&self.db.lock().unwrap().raw).tasks().list(project_run_id)?;
        let mut cancelled: std::collections::HashSet<String> = [failed_task_id.to_string()].into_iter().collect();
        let mut changed = true;
        while changed {
            changed = false;
            for task in &tasks {
                let id = task.get("id").and_then(Value::as_str).unwrap_or("");
                if cancelled.contains(id) || task.get("status").and_then(Value::as_str) == Some("completed") {
                    continue;
                }
                let depends_on_cancelled = task
                    .get("dependencies")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default()
                    .iter()
                    .any(|dependency| dependency.as_str().is_some_and(|d| cancelled.contains(d)));
                if depends_on_cancelled {
                    cancelled.insert(id.to_string());
                    changed = true;
                }
            }
        }
        for task in &tasks {
            let id = task.get("id").and_then(Value::as_str).unwrap_or("");
            let status = task.get("status").and_then(Value::as_str).unwrap_or("");
            if id != failed_task_id && cancelled.contains(id) && !["completed", "cancelled"].contains(&status) {
                self.save_status(task, "cancelled", None)?;
            }
        }
        Repositories::new(&self.db.lock().unwrap().raw).tasks().list(project_run_id)
    }
}
