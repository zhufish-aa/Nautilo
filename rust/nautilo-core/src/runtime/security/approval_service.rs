//! Approval records — port of runtime/security/approval-service.ts.

use std::sync::{Arc, Mutex};

use serde_json::{json, Map, Value};

use crate::database::{lock, Database, Repositories};
use crate::errors::{invalid, now_iso, CoreError, CoreResult, ErrorCode};


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
        let db = lock(&self.db);
        let approvals = Repositories::new(&db.raw).approvals();
        if input["category"] == "command" {
            if let Some(existing) = approvals.list(Some("pending"), None)?.into_iter().find(|record| same_request(record, input)) {
                return Ok(existing);
            }
        }
        let mut record = input.as_object().cloned().unwrap_or_default();
        if record.get("id").and_then(Value::as_str).is_none() {
            record.insert("id".to_string(), json!(uuid::Uuid::new_v4().to_string()));
        }
        record.insert("status".to_string(), json!("pending"));
        record.insert("createdAt".to_string(), json!(now_iso()));
        let record = Value::Object(record);
        approvals.save(&record)?;
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
        session_id: Option<&str>,
    ) -> CoreResult<bool> {
        // Keep selecting and consuming a one-shot grant under the same lock.
        let db = lock(&self.db);
        let approvals = Repositories::new(&db.raw).approvals();
        let grants = approvals.list(Some("approved"), None)?;
        let grant = grants.into_iter().find(|record| {
            if record.get("operation").and_then(Value::as_str) != Some(operation) {
                return false;
            }
            match record.get("scope").and_then(Value::as_str) {
                Some("global") => true,
                Some("project") => record.get("projectId").and_then(Value::as_str).is_some() && record.get("projectId").and_then(Value::as_str) == project_id,
                Some("run") => match record["projectRunId"].as_str() {
                    Some(id) => Some(id) == project_run_id,
                    None => record["sessionId"].as_str().is_some() && record["sessionId"].as_str() == session_id,
                },
                Some("task") => record.get("taskId").and_then(Value::as_str).is_some() && record.get("taskId").and_then(Value::as_str) == task_id,
                Some("once") => record.get("consumedAt").is_none()
                    && [("projectId", project_id), ("projectRunId", project_run_id), ("taskId", task_id), ("sessionId", session_id)]
                        .iter().all(|(key, expected)| record[*key].as_str().is_none_or(|value| Some(value) == *expected)),
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
            approvals.save(&Value::Object(updated))?;
        }
        Ok(scope != Some("once") || !consumed)
    }

    pub fn resolve(&self, id: &str, decision: &str, scope: &Value) -> CoreResult<Value> {
        Ok(self.resolve_many(id, decision, scope)?.remove(0))
    }

    /// Older versions could create several pending cards for the same blocked
    /// launch. Resolve that permission once, without issuing extra one-shot grants.
    pub fn resolve_many(&self, id: &str, decision: &str, scope: &Value) -> CoreResult<Vec<Value>> {
        if !["approved", "rejected"].contains(&decision) { return Err(invalid("decision", "Unknown approval decision")); }
        if !scope.as_str().is_some_and(|value| ["once", "run", "task", "project", "global"].contains(&value)) { return Err(invalid("scope", "Unknown approval scope")); }
        let db = lock(&self.db);
        let transaction = db.raw.unchecked_transaction().map_err(crate::database::connection::db_fail)?;
        let approvals = Repositories::new(&transaction).approvals();
        let current = approvals.get(id)?
            .ok_or_else(|| {
                let mut details = Map::new();
                details.insert("id".to_string(), json!(id));
                CoreError::details(ErrorCode::ApprovalNotFound, details)
            })?;
        if current["status"] != "pending" {
            if current["status"] == decision && current["scope"] == *scope { return Ok(vec![current]); }
            return Err(CoreError::new(ErrorCode::ApprovalNotFound));
        }
        let mut records = vec![current.clone()];
        if current["category"] == "command" {
            records.extend(approvals.list(Some("pending"), None)?.into_iter().filter(|record| record["id"] != current["id"] && same_request(record, &current)));
        }
        let now = now_iso();
        for record in &mut records {
            record["status"] = json!(decision);
            record["scope"] = scope.clone();
            record["resolvedBy"] = json!("desktop-user");
            record["resolvedAt"] = json!(now);
            if record["id"] != current["id"] && scope == "once" && decision == "approved" { record["consumedAt"] = json!(now); }
            approvals.save(record)?;
        }
        transaction.commit().map_err(crate::database::connection::db_fail)?;
        Ok(records)
    }
}

fn same_request(left: &Value, right: &Value) -> bool {
    ["category", "operation", "projectId", "projectRunId", "taskId", "sessionId", "requestedBy"]
        .iter().all(|key| left[*key].as_str() == right[*key].as_str())
        && (left["operation"].as_str().is_some_and(|value| !value.is_empty()) || left["summary"] == right["summary"])
}

#[cfg(test)]
mod tests {
    use super::*;
    fn service() -> ApprovalService {
        ApprovalService::new(Arc::new(Mutex::new(Database::open(std::path::Path::new(":memory:")).unwrap())))
    }
    fn launch(session: &str) -> Value {
        json!({"category":"command","operation":"agent.launch:pi","summary":"Launch Pi","projectId":"p","sessionId":session,"requestedBy":"user"})
    }
    #[test]
    fn repeated_launch_approval_is_coalesced_and_scoped_to_its_session() {
        let approvals = service();
        let first = approvals.request(&launch("s")).unwrap();
        assert_eq!(approvals.request(&launch("s")).unwrap()["id"], first["id"]);
        assert_ne!(approvals.request(&launch("other")).unwrap()["id"], first["id"]);
        approvals.resolve(first["id"].as_str().unwrap(), "approved", &json!("run")).unwrap();
        assert!(approvals.authorize("agent.launch:pi", Some("p"), None, None, Some("s")).unwrap());
        assert!(!approvals.authorize("agent.launch:pi", Some("p"), None, None, Some("other")).unwrap());
    }
    #[test]
    fn legacy_duplicates_resolve_once_without_extra_one_shot_grants() {
        let approvals = service();
        let first = approvals.request(&launch("s")).unwrap();
        for id in ["legacy-2", "legacy-3"] {
            let mut duplicate = first.clone();
            duplicate["id"] = json!(id);
            Repositories::new(&lock(&approvals.db).raw).approvals().save(&duplicate).unwrap();
        }
        let resolved = approvals.resolve_many(first["id"].as_str().unwrap(), "approved", &json!("once")).unwrap();
        assert_eq!(resolved.len(), 3);
        assert!(!approvals.authorize("agent.launch:pi", Some("p"), None, None, Some("other")).unwrap());
        assert!(approvals.authorize("agent.launch:pi", Some("p"), None, None, Some("s")).unwrap());
        assert!(!approvals.authorize("agent.launch:pi", Some("p"), None, None, Some("s")).unwrap());
        assert!(approvals.list(Some("pending"), None).unwrap().is_empty());
        assert!(approvals.resolve(first["id"].as_str().unwrap(), "rejected", &json!("once")).is_err());
    }
    #[test]
    fn resolving_twice_preserves_the_original_decision_and_scope() {
        let approvals = service();
        let first = approvals.request(&launch("s")).unwrap();
        let id = first["id"].as_str().unwrap();
        let resolved = approvals.resolve(id, "rejected", &json!("once")).unwrap();
        assert_eq!(approvals.resolve(id, "rejected", &json!("once")).unwrap(), resolved);
        assert!(approvals.resolve(id, "approved", &json!("global")).is_err());
        assert!(!approvals.authorize("agent.launch:pi", Some("p"), None, None, Some("s")).unwrap());
    }
}
