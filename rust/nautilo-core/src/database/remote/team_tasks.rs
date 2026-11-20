use super::*;

impl RemoteRepository {
    pub fn mobile_team_tasks(&self, session_id: &str) -> Result<Value> {
        let teams = self.mobile_teams()?;
        let db = self.db.lock().unwrap();
        let repos = Repositories::new(&db.raw);
        let session = repos.sessions().get(session_id)?.ok_or_else(|| anyhow::anyhow!("SESSION_NOT_FOUND"))?;
        let team = teams.into_iter().find(|team| team["id"] == session["teamId"]);
        let project = repos.projects().get(session["projectId"].as_str().unwrap_or(""))?;
        let project_run = session["projectRunId"].as_str().map(|id| repos.project_runs().get(id)).transpose()?.flatten();
        let run_id = project_run.as_ref().and_then(|run| run["id"].as_str()).unwrap_or("");
        let tasks = if run_id.is_empty() { vec![] } else { repos.tasks().list(run_id)? };
        let sessions = repos.sessions().list(session["projectId"].as_str().unwrap_or(""), None)?;
        let runs = repos.runs().list()?.into_iter().filter(|run| run["projectRunId"] == run_id).collect::<Vec<_>>();
        let mut query = db.raw.prepare("SELECT data FROM runtime_events WHERE project_run_id=?1 AND json_extract(data,'$.type') IN ('tool.started','tool.updated','tool.finished','command.started','command.updated','command.finished','file.changed','agent.message','run.failed') ORDER BY sequence DESC LIMIT 1000")?;
        let events = query.query_map([run_id], |row| row.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?.into_iter()
            .filter_map(|raw| serde_json::from_str::<Value>(&raw).ok()).collect::<Vec<_>>();
        let members = team.as_ref().map(|team| team["members"].as_array().cloned().unwrap_or_default()).unwrap_or_default();
        let tasks = tasks.into_iter().map(|task| {
            let member = members.iter().find(|member| member["id"] == task["assignedMemberId"]);
            let task_session = sessions.iter().find(|session| session["taskId"] == task["id"])
                .or_else(|| sessions.iter().find(|session| session["id"] == task["targetSessionId"]));
            let task_run = runs.iter().filter(|run| run["taskId"] == task["id"])
                .max_by_key(|run| run["startedAt"].as_str().unwrap_or(""));
            let relevant = events.iter().filter(|event| event["taskId"] == task["id"] ||
                task_run.is_some_and(|run| event["runId"] == run["id"])).collect::<Vec<_>>();
            let activity = relevant.iter().find(|event| matches!(event["type"].as_str(), Some("tool.started" | "tool.updated" | "tool.finished" | "command.started" | "command.updated" | "command.finished")))
                .map(|event| {
                    let payload = &event["payload"];
                    let command = event["type"].as_str().is_some_and(|kind| kind.starts_with("command."));
                    json!({"type":event["type"],"name":payload["toolName"].as_str().or(command.then_some("exec_command")),
                        "text":bounded_text(if command && payload["inputSummary"].as_str().is_none_or(str::is_empty) { &payload["command"] } else { &payload["inputSummary"] }, 240)})
                });
            let summary = relevant.iter().find(|event| event["type"] == "agent.message")
                .map(|event| bounded_text(&event["payload"]["text"], 240));
            let files = relevant.iter().filter(|event| event["type"] == "file.changed")
                .filter_map(|event| event["payload"]["path"].as_str()).collect::<std::collections::HashSet<_>>().len();
            json!({"id":task["id"],"title":task["title"],"status":task["status"],"dependencies":task["dependencies"],
                "memberId":task["assignedMemberId"],"memberName":member.map(|member| &member["name"]),
                "harness":member.map(|member| &member["harness"]),"sessionId":task_session.map(|session| &session["id"]).or_else(|| task_run.map(|run| &run["sessionId"])),
                "createdAt":task["createdAt"],"activity":activity,"summary":summary,"fileCount":files})
        }).collect::<Vec<_>>();
        let members = members.into_iter().map(|mut member| {
            let active = runs.iter().filter(|run| run["memberId"] == member["id"])
                .any(|run| !matches!(run["status"].as_str(), Some("completed" | "failed" | "cancelled" | "crashed" | "timed_out")));
            member["status"] = json!(if active { "running" } else { "idle" });
            member
        }).collect::<Vec<_>>();
        let workflow_todos: Vec<Value> = crate::database::workflows::list(&db.raw, Some(session_id), false)?
            .into_iter().flat_map(|workflow| workflow.attention()).take(30).collect();
        Ok(json!({"sessionId":session_id,"team":team,"members":members,"tasks":tasks,
            "workflowTodos":workflow_todos,
            "projectName":project.as_ref().map(|project| &project["name"]),
            "run":project_run.as_ref().map(|run| json!({"id":run["id"],"goal":run["goal"],"status":run["status"],"createdAt":run["createdAt"],
                "endedAt":run.get("endedAt").filter(|v| !v.is_null()).or_else(||
                    matches!(run["status"].as_str(), Some("completed" | "failed" | "cancelled")).then(|| &run["updatedAt"]))}))}))
    }

    pub fn mobile_team_run_id(&self, session_id: &str) -> Result<String> {
        let db = self.db.lock().unwrap();
        let session = Repositories::new(&db.raw).sessions().get(session_id)?.ok_or_else(|| anyhow::anyhow!("SESSION_NOT_FOUND"))?;
        session["projectRunId"].as_str().filter(|id| !id.is_empty()).map(str::to_owned)
            .ok_or_else(|| anyhow::anyhow!("TEAM_RUN_NOT_AVAILABLE"))
    }
}

fn bounded_text(value: &Value, length: usize) -> String {
    value.as_str().unwrap_or("").chars().take(length).collect()
}
