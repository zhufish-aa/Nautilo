//! Member routing — port of runtime/orchestration/member-router.ts.
//! Resolves only user-persisted team members; never infers or hardcodes roles.

use std::sync::{Arc, Mutex};

use serde_json::{json, Map, Value};

use crate::database::{Database, Repositories};
use crate::errors::{CoreError, CoreResult, ErrorCode};

fn member_not_found(details: &[(&str, &str)]) -> CoreError {
    let mut map = Map::new();
    for (key, value) in details {
        map.insert(key.to_string(), json!(value));
    }
    CoreError::details(ErrorCode::PlanMemberNotFound, map)
}

pub struct ResolvedMember {
    pub member: Value,
    pub agent: Value,
    pub role: Option<Value>,
}

pub struct MemberRouter {
    db: Arc<Mutex<Database>>,
}

impl MemberRouter {
    pub fn new(db: Arc<Mutex<Database>>) -> Self {
        Self { db }
    }

    pub fn resolve(&self, team: &Value, member_id: &str, task_type: Option<&str>) -> CoreResult<ResolvedMember> {
        let members = team.get("members").and_then(Value::as_array).cloned().unwrap_or_default();
        let member = members.iter().find(|candidate| candidate.get("id").and_then(Value::as_str) == Some(member_id)).cloned();
        let team_id = team.get("id").and_then(Value::as_str).unwrap_or("");
        let Some(member) = member.filter(|m| m.get("enabled").and_then(Value::as_bool) == Some(true)) else {
            return Err(member_not_found(&[("teamId", team_id), ("memberId", member_id)]));
        };
        if let Some(task_type) = task_type {
            let allowed: Vec<&str> = member
                .get("allowedTaskTypes")
                .and_then(Value::as_array)
                .map(|types| types.iter().filter_map(Value::as_str).collect())
                .unwrap_or_default();
            if !allowed.is_empty() && !allowed.contains(&"*") && !allowed.contains(&task_type) {
                let mut details = Map::new();
                details.insert("memberId".to_string(), json!(member_id));
                details.insert("taskType".to_string(), json!(task_type));
                return Err(CoreError::details(ErrorCode::PlanTaskTypeNotAllowed, details));
            }
        }
        let agent_instance_id = member.get("agentInstanceId").and_then(Value::as_str).unwrap_or("");
        let agent = Repositories::new(&self.db.lock().unwrap().raw).agents().get(agent_instance_id)?;
        let Some(agent) = agent.filter(|a| {
            a.get("enabled").and_then(Value::as_bool) == Some(true)
                && a.get("status").and_then(Value::as_str) != Some("disabled")
        }) else {
            return Err(member_not_found(&[("memberId", member_id), ("agentInstanceId", agent_instance_id)]));
        };
        let role_id = member.get("roleId").and_then(Value::as_str);
        let role = team
            .get("roles")
            .and_then(Value::as_array)
            .and_then(|roles| roles.iter().find(|role| role.get("id").and_then(Value::as_str) == role_id).cloned());
        Ok(ResolvedMember { member, agent, role })
    }

    pub fn main(&self, team: &Value) -> CoreResult<ResolvedMember> {
        let main_member_id = team.get("mainMemberId").and_then(Value::as_str);
        let Some(main_member_id) = main_member_id else {
            let mut details = Map::new();
            details.insert("teamId".to_string(), team.get("id").cloned().unwrap_or(Value::Null));
            details.insert("reason".to_string(), json!("main_agent_not_selected_by_session"));
            return Err(CoreError::details(ErrorCode::PlanMemberNotFound, details));
        };
        self.resolve(team, main_member_id, None)
    }

    pub fn session_main(&self, team: &Value, agent_instance_id: Option<&str>) -> CoreResult<ResolvedMember> {
        let Some(agent_instance_id) = agent_instance_id else {
            return self.main(team);
        };
        let main_member_id = team.get("mainMemberId").and_then(Value::as_str);
        let legacy_main = main_member_id.and_then(|id| {
            team.get("members").and_then(Value::as_array).and_then(|members| {
                members
                    .iter()
                    .find(|m| {
                        m.get("id").and_then(Value::as_str) == Some(id)
                            && m.get("agentInstanceId").and_then(Value::as_str) == Some(agent_instance_id)
                    })
                    .cloned()
            })
        });
        if let Some(member) = legacy_main {
            return self.resolve(team, member.get("id").and_then(Value::as_str).unwrap_or(""), None);
        }
        let agent = Repositories::new(&self.db.lock().unwrap().raw).agents().get(agent_instance_id)?;
        let Some(agent) = agent.filter(|a| {
            a.get("enabled").and_then(Value::as_bool) == Some(true)
                && a.get("status").and_then(Value::as_str) != Some("disabled")
        }) else {
            let mut details = Map::new();
            details.insert("agentInstanceId".to_string(), json!(agent_instance_id));
            return Err(CoreError::details(ErrorCode::AgentNotFound, details));
        };
        let member = json!({
            "id": format!("main:{}", agent.get("id").and_then(Value::as_str).unwrap_or("")),
            "displayName": agent.get("displayName").cloned().unwrap_or(Value::Null),
            "agentInstanceId": agent.get("id").cloned().unwrap_or(Value::Null),
            "roleId": "session-main",
            "strengths": {},
            "allowedTaskTypes": [],
            "maxConcurrentTasks": 1,
            "enabled": true
        });
        Ok(ResolvedMember { member, agent, role: None })
    }

    pub fn resolve_session(&self, session: &Value) -> CoreResult<Value> {
        let session_id = session.get("id").and_then(Value::as_str).unwrap_or("");
        let agent_not_found = || {
            let mut details = Map::new();
            details.insert("sessionId".to_string(), json!(session_id));
            CoreError::details(ErrorCode::AgentNotFound, details)
        };
        if let Some(agent_instance_id) = session.get("agentInstanceId").and_then(Value::as_str) {
            let agent = Repositories::new(&self.db.lock().unwrap().raw).agents().get(agent_instance_id)?;
            return agent
                .filter(|a| {
                    a.get("enabled").and_then(Value::as_bool) == Some(true)
                        && a.get("status").and_then(Value::as_str) != Some("disabled")
                })
                .ok_or_else(agent_not_found);
        }
        if let Some(team_id) = session.get("teamId").and_then(Value::as_str) {
            let team = Repositories::new(&self.db.lock().unwrap().raw).teams().get(team_id)?;
            let Some(team) = team else {
                return Err(crate::errors::not_found("team", team_id));
            };
            let member_id = session.get("memberId").and_then(Value::as_str).unwrap_or("");
            return Ok(self.resolve(&team, member_id, None)?.agent);
        }
        let member_id = session.get("memberId").and_then(Value::as_str).unwrap_or("");
        let agent = Repositories::new(&self.db.lock().unwrap().raw).agents().get(member_id)?;
        agent
            .filter(|a| {
                a.get("enabled").and_then(Value::as_bool) == Some(true)
                    && a.get("status").and_then(Value::as_str) != Some("disabled")
            })
            .ok_or_else(agent_not_found)
    }
}
