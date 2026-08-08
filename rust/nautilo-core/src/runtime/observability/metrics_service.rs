//! Runtime metrics — port of runtime/observability/metrics-service.ts.

use std::sync::{Arc, Mutex};

use serde_json::{json, Map, Value};

use crate::database::{lock, Database, Repositories};
use crate::errors::{invalid, not_found, now_iso, CoreError, CoreResult, ErrorCode};


pub struct MetricsService {
    db: Arc<Mutex<Database>>,
}

impl MetricsService {
    pub fn new(db: Arc<Mutex<Database>>) -> Self {
        Self { db }
    }

    pub fn snapshot(&self, project_id: Option<&str>) -> CoreResult<Value> {
        let db = lock(&self.db);
        let repos = Repositories::new(&db.raw);
        let project_run_ids: std::collections::HashSet<String> = repos
            .project_runs()
            .list_all()?
            .into_iter()
            .filter(|run| project_id.is_none() || run.get("projectId").and_then(Value::as_str) == project_id)
            .filter_map(|run| run.get("id").and_then(Value::as_str).map(str::to_string))
            .collect();
        let runs: Vec<Value> = repos
            .runs()
            .list()?
            .into_iter()
            .filter(|run| {
                run.get("projectRunId").and_then(Value::as_str).is_none_or(|id| project_run_ids.contains(id))
            })
            .collect();
        let tasks: Vec<Value> = repos
            .tasks()
            .list_all()?
            .into_iter()
            .filter(|task| task.get("projectRunId").and_then(Value::as_str).is_some_and(|id| project_run_ids.contains(id)))
            .collect();
        let verifications: Vec<Value> = repos
            .verifications()
            .list_all()?
            .into_iter()
            .filter(|item| item.get("projectRunId").and_then(Value::as_str).is_some_and(|id| project_run_ids.contains(id)))
            .collect();
        let events: Vec<Value> = repos
            .events()
            .replay(None, None, None, None)?
            .into_iter()
            .filter(|event| {
                event.get("projectRunId").and_then(Value::as_str).is_none_or(|id| project_run_ids.contains(id))
            })
            .collect();
        let durations: Vec<i64> = runs
            .iter()
            .filter_map(|run| {
                let started = run.get("startedAt").and_then(Value::as_str)?;
                let ended = run.get("endedAt").and_then(Value::as_str)?;
                let start = chrono::DateTime::parse_from_rfc3339(started).ok()?.timestamp_millis();
                let end = chrono::DateTime::parse_from_rfc3339(ended).ok()?.timestamp_millis();
                Some(end - start)
            })
            .collect();
        let count = |items: &[Value], pred: fn(&Value) -> bool| items.iter().filter(|item| pred(item)).count();
        let failed = |run: &Value| matches!(run.get("status").and_then(Value::as_str), Some("failed" | "crashed" | "timed_out"));
        Ok(json!({
            "totalRuns": runs.len(),
            "completedRuns": count(&runs, |run| run.get("status").and_then(Value::as_str) == Some("completed")),
            "failedRuns": count(&runs, failed),
            "retriedTasks": count(&tasks, |task| task.get("attempt").and_then(Value::as_i64).unwrap_or(0) > 1),
            "conflicts": count(&events, |event| event.get("type").and_then(Value::as_str) == Some("git.conflict")),
            "verificationTotal": verifications.len(),
            "verificationPassed": count(&verifications, |item| item.get("passed").and_then(Value::as_bool).unwrap_or(false)),
            "averageRunDurationMs": if durations.is_empty() { 0 } else { durations.iter().sum::<i64>() / durations.len() as i64 },
        }))
    }
}
