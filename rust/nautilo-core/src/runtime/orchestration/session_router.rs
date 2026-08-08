//! Session routing — port of runtime/orchestration/session-router.ts.

use std::sync::{Arc, Mutex};

use serde_json::{json, Map, Value};
use uuid::Uuid;

use crate::database::{Database, Repositories};
use crate::errors::{now_iso, CoreError, CoreResult, ErrorCode};

pub struct SessionRouter {
    db: Arc<Mutex<Database>>,
}

impl SessionRouter {
    pub fn new(db: Arc<Mutex<Database>>) -> Self {
        Self { db }
    }

    pub fn main(&self, project_run: &Value, team: &Value, existing_session_id: Option<&str>) -> CoreResult<Value> {
        if let Some(existing_id) = existing_session_id {
            let existing = Repositories::new(&self.db.lock().unwrap().raw).sessions().get(existing_id)?;
            if let Some(existing) = existing.filter(|s| {
                s.get("projectId").and_then(Value::as_str) == project_run.get("projectId").and_then(Value::as_str)
            }) {
                let mut updated = existing.as_object().cloned().unwrap_or_default();
                updated.insert("teamId".to_string(), team.get("id").cloned().unwrap_or(Value::Null));
                updated.insert("projectRunId".to_string(), project_run.get("id").cloned().unwrap_or(Value::Null));
                updated.insert("memberId".to_string(), project_run.get("mainMemberId").cloned().unwrap_or(Value::Null));
                updated.insert(
                    "agentInstanceId".to_string(),
                    project_run.get("mainAgentInstanceId").cloned().unwrap_or(Value::Null),
                );
                updated.insert("updatedAt".to_string(), json!(now_iso()));
                let updated = Value::Object(updated);
                Repositories::new(&self.db.lock().unwrap().raw).sessions().save(&updated)?;
                return Ok(updated);
            }
        }
        let goal = project_run.get("goal").and_then(Value::as_str).unwrap_or("");
        self.create(
            project_run,
            project_run.get("mainMemberId").and_then(Value::as_str).unwrap_or(""),
            &format!("Run: {}", goal.chars().take(80).collect::<String>()),
            &json!({
                "teamId": team.get("id").cloned().unwrap_or(Value::Null),
                "agentInstanceId": project_run.get("mainAgentInstanceId").cloned().unwrap_or(Value::Null)
            }),
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn delegated(
        &self,
        project_run: &Value,
        team: &Value,
        member: &Value,
        parent: &Value,
        task_id: &str,
        title: &str,
        target_session_id: Option<&str>,
    ) -> CoreResult<Value> {
        if let Some(target_id) = target_session_id {
            let target = Repositories::new(&self.db.lock().unwrap().raw).sessions().get(target_id)?;
            let member_id = member.get("id").and_then(Value::as_str).unwrap_or("");
            let parent_id = parent.get("id").and_then(Value::as_str).unwrap_or("");
            let valid = target.as_ref().is_some_and(|target| {
                target.get("projectId").and_then(Value::as_str) == project_run.get("projectId").and_then(Value::as_str)
                    && target.get("teamId").and_then(Value::as_str) == team.get("id").and_then(Value::as_str)
                    && target.get("memberId").and_then(Value::as_str) == Some(member_id)
                    && target.get("parentSessionId").and_then(Value::as_str) == Some(parent_id)
                    && target.get("id").and_then(Value::as_str) != Some(parent_id)
            });
            let Some(target) = target.filter(|_| valid) else {
                let mut details = Map::new();
                details.insert("reason".to_string(), json!("invalid_continue_session"));
                details.insert("targetSessionId".to_string(), json!(target_id));
                details.insert("memberId".to_string(), json!(member_id));
                return Err(CoreError::details(ErrorCode::PlanSchemaInvalid, details));
            };
            let mut continued = target.as_object().cloned().unwrap_or_default();
            continued.insert("projectRunId".to_string(), project_run.get("id").cloned().unwrap_or(Value::Null));
            continued.insert("parentSessionId".to_string(), json!(parent_id));
            continued.insert("taskId".to_string(), json!(task_id));
            continued.insert("status".to_string(), json!("idle"));
            continued.insert("updatedAt".to_string(), json!(now_iso()));
            let continued = Value::Object(continued);
            Repositories::new(&self.db.lock().unwrap().raw).sessions().save(&continued)?;
            return Ok(continued);
        }
        let member_id = member.get("id").and_then(Value::as_str).unwrap_or("");
        let project_id = project_run.get("projectId").and_then(Value::as_str).unwrap_or("");
        let existing = Repositories::new(&self.db.lock().unwrap().raw)
            .sessions()
            .list(project_id, Some(member_id))?
            .into_iter()
            .find(|session| {
                session.get("projectRunId").and_then(Value::as_str) == project_run.get("id").and_then(Value::as_str)
                    && session.get("taskId").and_then(Value::as_str) == Some(task_id)
            });
        if let Some(existing) = existing {
            return Ok(existing);
        }
        self.create(
            project_run,
            member_id,
            title,
            &json!({
                "teamId": team.get("id").cloned().unwrap_or(Value::Null),
                "parentSessionId": parent.get("id").cloned().unwrap_or(Value::Null),
                "taskId": task_id,
                "model": member.get("model").cloned().unwrap_or(Value::Null),
                "reasoningEffort": member.get("reasoningEffort").cloned().unwrap_or(Value::Null),
                "serviceTier": member.get("serviceTier").cloned().unwrap_or(Value::Null)
            }),
        )
    }

    pub fn replacement_main(&self, project_run: &Value, team: &Value, member_id: &str, previous: &Value) -> CoreResult<Value> {
        let member = team
            .get("members")
            .and_then(Value::as_array)
            .and_then(|members| members.iter().find(|m| m.get("id").and_then(Value::as_str) == Some(member_id)).cloned());
        let goal = project_run.get("goal").and_then(Value::as_str).unwrap_or("");
        self.create(
            project_run,
            member_id,
            &format!("Recovery: {}", goal.chars().take(80).collect::<String>()),
            &json!({
                "teamId": team.get("id").cloned().unwrap_or(Value::Null),
                "parentSessionId": previous.get("id").cloned().unwrap_or(Value::Null),
                "agentInstanceId": member.as_ref().and_then(|m| m.get("agentInstanceId").cloned()).unwrap_or(Value::Null),
                "model": member.as_ref().and_then(|m| m.get("model").cloned()).unwrap_or(Value::Null),
                "reasoningEffort": member.as_ref().and_then(|m| m.get("reasoningEffort").cloned()).unwrap_or(Value::Null),
                "serviceTier": member.as_ref().and_then(|m| m.get("serviceTier").cloned()).unwrap_or(Value::Null)
            }),
        )
    }

    fn create(&self, project_run: &Value, member_id: &str, title: &str, context: &Value) -> CoreResult<Value> {
        let now = now_iso();
        let nullable = |key: &str| context.get(key).cloned().filter(|v| !v.is_null());
        let session = json!({
            "id": Uuid::new_v4().to_string(),
            "projectId": project_run.get("projectId").cloned().unwrap_or(Value::Null),
            "projectRunId": project_run.get("id").cloned().unwrap_or(Value::Null),
            "teamId": nullable("teamId").or_else(|| project_run.get("teamId").cloned()).unwrap_or(Value::Null),
            "memberId": member_id,
            "title": title,
            "status": "idle",
            "unreadCount": 0,
            "createdAt": now,
            "updatedAt": now
        });
        let mut session = session.as_object().cloned().unwrap_or_default();
        for key in ["parentSessionId", "taskId", "agentInstanceId", "model", "reasoningEffort", "serviceTier"] {
            if let Some(value) = nullable(key) {
                session.insert(key.to_string(), value);
            }
        }
        let session = Value::Object(session);
        Repositories::new(&self.db.lock().unwrap().raw).sessions().save(&session)?;
        Ok(session)
    }
}
