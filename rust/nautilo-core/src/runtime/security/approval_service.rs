//! Approval records — port of runtime/security/approval-service.ts.

use std::sync::{Arc, Mutex};

use serde_json::{json, Map, Value};

use crate::database::{lock, Database, Repositories};
use crate::errors::{invalid, not_found, now_iso, CoreError, CoreResult, ErrorCode};


pub struct ApprovalService {
    db: Arc<Mutex<Database>>,
}

impl ApprovalService {
    pub fn new(db: Arc<Mutex<Database>>) -> Self {
        Self { db }
    }

    pub fn list(&self, status: Option<&str>, project_run_id: Option<&str>) -> CoreResult<Vec<Value>> {
        Repositories::new(&lock(&self.db).raw).approvals().list(status, project_run_id)
    }

    /// Creates a pending approval record.
    pub fn request(&self, input: &Value) -> CoreResult<Value> {
        let mut record = input.as_object().cloned().unwrap_or_default();
        if record.get("id").and_then(Value::as_str).is_none() {
            record.insert("id".to_string(), json!(uuid::Uuid::new_v4().to_string()));
        }
        record.insert("status".to_string(), json!("pending"));
        record.insert("createdAt".to_string(), json!(now_iso()));
        let record = Value::Object(record);
        Repositories::new(&lock(&self.db).raw).approvals().save(&record)?;
        Ok(record)
    }

    /// Checks for a granted approval covering this operation + scope; "once"
    /// grants are consumed on first use.
    pub fn authorize(
        &self,
        operation: &str,
        project_id: Option<&str>,
        project_run_id: Option<&str>,
        task_id: Option<&str>,
    ) -> CoreResult<bool> {
        let grants = Repositories::new(&lock(&self.db).raw).approvals().list(Some("approved"), None)?;
        let grant = grants.into_iter().find(|record| {
            if record.get("operation").and_then(Value::as_str) != Some(operation) {
                return false;
            }
            match record.get("scope").and_then(Value::as_str) {
                Some("global") => true,
                Some("project") => record.get("projectId").and_then(Value::as_str).is_some() && record.get("projectId").and_then(Value::as_str) == project_id,
                Some("run") => record.get("projectRunId").and_then(Value::as_str).is_some() && record.get("projectRunId").and_then(Value::as_str) == project_run_id,
                Some("task") => record.get("taskId").and_then(Value::as_str).is_some() && record.get("taskId").and_then(Value::as_str) == task_id,
                Some("once") => record.get("consumedAt").is_none(),
                _ => false,
            }
        });
        let Some(grant) = grant else {
            return Ok(false);
        };
        let scope = grant.get("scope").and_then(Value::as_str);
        let consumed = grant.get("consumedAt").is_some();
        if scope == Some("once") && !consumed {
            let mut updated = grant.as_object().cloned().unwrap_or_default();
            updated.insert("consumedAt".to_string(), json!(now_iso()));
            Repositories::new(&lock(&self.db).raw).approvals().save(&Value::Object(updated))?;
        }
        Ok(scope != Some("once") || !consumed)
    }

    pub fn resolve(&self, id: &str, decision: &str, scope: &Value) -> CoreResult<Value> {
        let current = Repositories::new(&lock(&self.db).raw)
            .approvals()
            .get(id)?
            .filter(|record| record.get("status").and_then(Value::as_str) == Some("pending"))
            .ok_or_else(|| {
                let mut details = Map::new();
                details.insert("id".to_string(), json!(id));
                CoreError::details(ErrorCode::ApprovalNotFound, details)
            })?;
        let mut record = current;
        let object = record.as_object_mut().unwrap();
        object.insert("status".to_string(), json!(decision));
        object.insert("scope".to_string(), scope.clone());
        object.insert("resolvedBy".to_string(), json!("desktop-user"));
        object.insert("resolvedAt".to_string(), json!(now_iso()));
        Repositories::new(&lock(&self.db).raw).approvals().save(&record)?;
        Ok(record)
    }
}
