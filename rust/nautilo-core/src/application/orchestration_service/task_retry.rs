use super::*;

impl OrchestrationService {
    /// An explicit retry owns one task, never the main turn or successful siblings.
    pub fn retry_task(self: &Arc<Self>, project_run_id: &str, task_id: &str) -> CoreResult<Value> {
        let project = self.require_project_run(project_run_id)?;
        let team = self.require_team(project["teamId"].as_str().unwrap_or(""))?;
        let main = self.require_main_session(&project)?;
        let candidate = Repositories::new(&self.db.lock().unwrap().raw).tasks().get(task_id)?
            .filter(|task| task["projectRunId"] == project_run_id)
            .ok_or_else(|| crate::errors::not_found("task", task_id))?;
        self.members().resolve(&team, candidate["assignedMemberId"].as_str().unwrap_or(""), candidate["taskType"].as_str())?;
        if let Some(workflows) = self.workflows() {
            use std::collections::BTreeMap;
            use crate::application::workflow_service::TaskPlanOptions;
            if !matches!(candidate["status"].as_str(), Some("failed" | "cancelled")) {
                return Err(crate::errors::invalid("taskId", "Only a failed or stopped task can be retried"));
            }
            let completed = {
                let db = self.db.lock().unwrap();
                let repos = Repositories::new(&db.raw);
                let messages = repos.sessions().messages(main["id"].as_str().unwrap_or(""))?;
                let mut completed = BTreeMap::new();
                for dependency in candidate["dependencies"].as_array().into_iter().flatten() {
                    let id = dependency.as_str().unwrap_or("");
                    let task = repos.tasks().get(id)?.filter(|task| task["projectRunId"] == project_run_id && task["status"] == "completed")
                        .ok_or_else(|| crate::errors::invalid("taskId", "Finish the failed dependencies before retrying this task"))?;
                    let receipt = messages.iter().rev().find(|message| message["taskId"] == id && message["kind"] == "result");
                    let text = receipt.and_then(|message| message["text"].as_str())
                        .or_else(|| task["workflowResult"]["summary"].as_str()).unwrap_or("Accepted task; see the original run for evidence.");
                    completed.insert(id.into(), json!({"taskId":id,"projectRunId":project_run_id,"status":"completed","result":{"summary":text},"resultMessageId":receipt.map(|message| &message["id"]),"runId":task["runId"]}));
                }
                completed
            };
            let attempt = candidate["attempt"].as_u64().unwrap_or(1);
            let request_id = format!("retry:{task_id}:{attempt}");
            let input = self.compile_task_plan(&project, &team, std::slice::from_ref(&candidate), &request_id, &completed)?;
            workflows.start_task_plan_with(input, TaskPlanOptions { retry_attempt:Some(attempt), ..Default::default() })?;
            return Repositories::new(&self.db.lock().unwrap().raw).tasks().get(task_id)?
                .ok_or_else(|| crate::errors::not_found("task", task_id));
        }
        let task = {
            let db = self.db.lock().unwrap();
            let repos = Repositories::new(&db.raw);
            let tasks = repos.tasks().list(project_run_id)?;
            let task = tasks.iter().find(|t| t["id"] == task_id)
                .ok_or_else(|| crate::errors::not_found("task", task_id))?;
            if !["failed", "cancelled"].contains(&task["status"].as_str().unwrap_or("")) {
                return Err(crate::errors::invalid("taskId", "Only a failed or stopped task can be retried"));
            }
            let ready = task["dependencies"].as_array().into_iter().flatten()
                .all(|id| tasks.iter().any(|t| t["id"] == *id && t["status"] == "completed"));
            if !ready { return Err(crate::errors::invalid("taskId", "Finish the failed dependencies before retrying this task")); }
            let mut task = task.clone();
            // Reserve before spawning: the ordinary DAG scheduler must not also
            // pick this task while native workspace initialization is awaiting.
            task["status"] = json!("queued");
            task["attempt"] = json!(task["attempt"].as_u64().unwrap_or(1) + 1);
            task["updatedAt"] = json!(now_iso());
            repos.tasks().save(&task)?;
            task
        };
        self.emit_task(&main, &task);
        let service = self.clone();
        let selected = task.clone();
        tokio::spawn(async move {
            if let Err(error) = service.execute_task(&project, &team, &main, &selected, |_| {}).await {
                let current = Repositories::new(&service.db.lock().unwrap().raw).tasks()
                    .get(selected["id"].as_str().unwrap_or("")).ok().flatten();
                if let Some(current) = current {
                    let status = current["status"].as_str().unwrap_or("");
                    if !["completed", "failed", "cancelled"].contains(&status) {
                        let terminal = if ["queued", "ready", "blocked_dependency"].contains(&status) { "cancelled" } else { "failed" };
                        let _ = service.update_task(&main, &current, terminal, None);
                    }
                    let _ = service.return_result(&project, &main, &current, &error.to_string());
                }
            }
        });
        Ok(task)
    }
}
