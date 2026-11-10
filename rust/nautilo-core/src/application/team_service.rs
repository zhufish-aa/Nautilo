//! Team service — port of application/team-service.ts.

use std::sync::{Arc, Mutex};

use serde_json::{json, Map, Value};

use crate::database::{lock, Database, Repositories};
use crate::errors::{invalid, not_found, now_iso, CoreError, CoreResult, ErrorCode};


pub struct TeamService {
    db: Arc<Mutex<Database>>,
}

impl TeamService {
    pub fn new(db: Arc<Mutex<Database>>) -> Self {
        Self { db }
    }

    pub fn list(&self) -> CoreResult<Vec<Value>> {
        Repositories::new(&lock(&self.db).raw).teams().list_default()
    }

    pub fn get(&self, id: &str) -> CoreResult<Value> {
        Repositories::new(&lock(&self.db).raw).teams().get(id)?.ok_or_else(|| not_found("team", id))
    }

    pub fn upsert(&self, team: &Value) -> CoreResult<Value> {
        let mut saved = team.clone();
        let db = lock(&self.db);
        let repos = Repositories::new(&db.raw);
        let previous = repos.teams().get(saved["id"].as_str().unwrap_or(""))?;
        if let Some(members) = saved.get_mut("members").and_then(Value::as_array_mut) {
            for member in members {
                if member.get("connectionId").and_then(Value::as_str).is_none() { continue; }
                let agent_id = member["agentInstanceId"].as_str().unwrap_or("");
                let agent = Repositories::new(&db.raw).agents().get(agent_id)?.ok_or_else(|| not_found("harness", agent_id))?;
                let mut binding = json!({"connectionId":member["connectionId"],"connectionRevision":member["connectionRevision"]});
                crate::application::connection_service::bind_session(&db.raw, &mut binding, None)?;
                crate::application::connection_service::resolve_session_connection(&db.raw, &binding, &agent)?;
                member["connectionRevision"] = binding["connectionRevision"].clone();
            }
        }
        let updated_at = saved.get("updatedAt").and_then(Value::as_str).unwrap_or("");
        Repositories::new(&db.raw).teams().save(&saved, updated_at)?;
        if previous.as_ref().is_some_and(|previous| delegation_members(previous) != delegation_members(&saved)) {
            for mut session in repos.sessions().list_all()? {
                if session["teamId"] != saved["id"] || session.get("parentSessionId").is_some_and(|id| !id.is_null()) { continue; }
                let agent = repos.agents().get(session["agentInstanceId"].as_str().unwrap_or(""))?;
                if agent.is_some_and(|agent| agent["providerId"] == "codex") {
                    // Codex's dynamic tool allowlist belongs to its native
                    // thread. Rebuild it next turn through the existing saved
                    // history recovery path, retaining the visible conversation.
                    session["runtimeToolVersion"] = json!(0);
                    repos.sessions().save(&session)?;
                }
            }
        }
        Ok(saved)
    }

    pub fn remove(&self, id: &str) -> CoreResult<Value> {
        Repositories::new(&lock(&self.db).raw).teams().remove(id)?;
        Ok(json!({ "removed": true }))
    }
}

fn delegation_members(team: &Value) -> Vec<String> {
    if team["delegationPolicy"] == "direct_only" { return vec![]; }
    let mut ids = team["members"].as_array().into_iter().flatten()
        .filter(|member| member["enabled"] == true && member.get("id") != team.get("mainMemberId"))
        .filter_map(|member| member["id"].as_str().map(str::to_string)).collect::<Vec<_>>();
    ids.sort();
    ids
}
