use super::*;

impl RemoteRepository {
    /// Display metadata only: native configuration and credentials stay on the PC.
    pub fn mobile_teams(&self) -> Result<Vec<Value>> {
        let db = self.db.lock().unwrap();
        let repos = Repositories::new(&db.raw);
        repos.teams().list_default()?.into_iter().map(|team| {
            let members = team["members"].as_array().into_iter().flatten()
                .filter(|member| member["enabled"] != false)
                .map(|member| {
                    let agent = member["agentInstanceId"].as_str()
                        .map(|id| repos.agents().get(id)).transpose()?.flatten();
                    Ok(json!({"id":member["id"],"name":member["displayName"],
                        "harness":agent.as_ref().map(|a| &a["displayName"]),
                        "providerId":agent.as_ref().map(|a| &a["providerId"]),"model":member["model"]}))
                }).collect::<Result<Vec<_>>>()?;
            Ok(json!({"id":team["id"],"name":team["name"],
                "delegationPolicy":team["delegationPolicy"],"members":members}))
        }).collect()
    }

    pub fn mobile_select_team(&self, input: &mut Value, params: &Value) -> Result<()> {
        let Some(requested) = params.get("teamId") else { return Ok(()) };
        anyhow::ensure!(requested.is_null() || requested.as_str().is_some_and(|id| id.len() <= 128), "INVALID_TEAM");
        let id = requested.as_str().filter(|id| !id.is_empty());
        if let Some(id) = id {
            let db = self.db.lock().unwrap();
            let team = Repositories::new(&db.raw).teams().get(id)?
                .ok_or_else(|| anyhow::anyhow!("TEAM_NOT_AVAILABLE"))?;
            anyhow::ensure!(team["members"].as_array().is_some_and(|members|
                members.iter().any(|member| member["enabled"] != false)), "TEAM_HAS_NO_MEMBERS");
        }
        input["teamId"] = id.map(|id| json!(id)).unwrap_or(Value::Null);
        Ok(())
    }

    /// Use desktop orchestration for the first turn, then reuse its project run.
    /// Delegated conversations retain their existing member routing.
    pub fn mobile_team_start(&self, session_id: &str, message: &Value) -> Result<Option<Value>> {
        let db = self.db.lock().unwrap();
        let repos = Repositories::new(&db.raw);
        let session = repos.sessions().get(session_id)?
            .ok_or_else(|| anyhow::anyhow!("SESSION_NOT_FOUND"))?;
        let Some(team_id) = session["teamId"].as_str().filter(|id| !id.is_empty()) else { return Ok(None) };
        if session["parentSessionId"].as_str().is_some_and(|id| !id.is_empty()) { return Ok(None) }
        let current = session["projectRunId"].as_str().map(|id| repos.project_runs().get(id)).transpose()?.flatten();
        if current.is_some_and(|run| run["teamId"] == team_id &&
            !matches!(run["status"].as_str(), Some("completed" | "failed" | "cancelled"))) { return Ok(None) }
        let agent = crate::application::session_service::effective_agent_id(&db.raw, &session)?;
        let mut input = json!({"projectId":session["projectId"],"teamId":team_id,
            "agentInstanceId":agent,"sessionId":session_id,"goal":message["text"],"messageId":message["messageId"]});
        if let Some(attachments) = message.get("attachments") { input["attachments"] = attachments.clone(); }
        Ok(Some(input))
    }
}
