use super::*;
use crate::application::workflow_service::{TaskPlanOptions, TaskPlanStart};
use crate::runtime::workflow::{Limits, WorkflowRun};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

impl OrchestrationService {
    pub(super) fn start_runtime_workflow(
        &self,
        workflows: &WorkflowService,
        project: &Value,
        main: &Value,
        team: &Value,
        invoking_run_id: Option<&str>,
        call: &Value,
    ) -> CoreResult<Value> {
        let tool_name = call["name"].as_str().unwrap_or("");
        let invocation = json!({
            "projectRunId":project["id"],
            "tool":crate::runtime::orchestration::runtime_tool_names::normalize_runtime_tool_name(tool_name),
            "arguments":call["arguments"],
        });
        let request_id = if let Some(call_id) = call["callId"].as_str().filter(|id| !id.is_empty()) {
            // Scope protocol IDs to their native turn. Identical arguments in
            // two separate tool calls must still be able to create two tasks.
            let identity = json!([invoking_run_id, call["providerId"], call_id]);
            format!("runtime:{:x}", Sha256::digest(identity.to_string().as_bytes()))
        } else {
            format!("runtime:{}", Uuid::new_v4())
        };
        let view = if let Some(existing) = workflows.replay_task_plan(
            main["id"].as_str().unwrap_or(""),
            &request_id,
            &invocation,
        )? {
            existing
        } else {
            let validator = self.decisions();
            let decision = RuntimeToolDecisionBuilder::new(&validator).build(
                tool_name, &call["arguments"], team,
            )?;
            self.start_decision_workflow(
                workflows, project, team, &decision, &request_id, invoking_run_id,
                Some(&invocation), true,
            )?
        };
        let run = workflows.get(view["id"].as_str().unwrap_or(""))?;
        let content = self.dispatch_receipt(&run)?;
        Ok(json!({"success":true,"content":content.to_string()}))
    }

    pub(super) fn start_decision_workflow(
        &self,
        workflows: &WorkflowService,
        project: &Value,
        team: &Value,
        decision: &Value,
        request_id: &str,
        invoking_run_id: Option<&str>,
        invocation: Option<&Value>,
        finalize: bool,
    ) -> CoreResult<Value> {
        let project_run_id = project["id"].as_str().unwrap_or("");
        let planned = if decision["mode"] == "delegate" {
            std::slice::from_ref(&decision["task"])
        } else {
            decision["tasks"].as_array().map(Vec::as_slice).unwrap_or_default()
        };
        let tasks = TaskGraph::materialize(
            project_run_id, planned, team["delegationPolicy"] == "ask_before_delegate",
        );
        let input = self.compile_task_plan(project, team, &tasks, request_id, &BTreeMap::new())?;
        workflows.start_task_plan_with(input, TaskPlanOptions {
            new_tasks: &tasks,
            decision: Some(decision),
            invocation,
            invoking_run_id,
            finalize,
            ..Default::default()
        })
    }

    pub(super) fn compile_task_plan(
        &self,
        project: &Value,
        team: &Value,
        tasks: &[Value],
        request_id: &str,
        completed: &BTreeMap<String, Value>,
    ) -> CoreResult<TaskPlanStart> {
        let plan = workflow_plan::compile(
            project, request_id, tasks, team, completed,
            Limits { max_parallel: 50, ..Default::default() },
        ).map_err(|error| crate::errors::invalid("plan", &error))?;
        Ok(TaskPlanStart {
            project_run_id: project["id"].as_str().unwrap_or("").into(),
            request_id: request_id.into(),
            definition: plan.definition,
            inputs: plan.inputs,
            bindings: plan.bindings,
            task_nodes: plan.task_nodes,
            target_sessions: plan.target_sessions,
            approval_id: None,
            return_to_main: false,
        })
    }

    fn dispatch_receipt(&self, run: &WorkflowRun) -> CoreResult<Value> {
        let source = run.task_projection.as_ref().ok_or_else(|| {
            crate::errors::invalid("workflow", "The workflow has no task dispatch receipt")
        })?;
        let db = self.db.lock().unwrap();
        let repos = Repositories::new(&db.raw);
        let mut tasks = Vec::new();
        for (node_id, task) in &source.tasks {
            let current = repos.tasks().get(&task.task_id)?.unwrap_or(Value::Null);
            let status = if current["workflowRunId"] == run.id {
                current["status"].clone()
            } else {
                json!("superseded")
            };
            tasks.push(json!({
                "taskId":task.task_id,
                "memberId":task.member_id,
                "sessionId":source.sessions[node_id]["session"]["id"],
                "status":status,
            }));
        }
        Ok(json!({
            "accepted":run.approval_id.is_none() && run.status != "cancelled",
            "approvalRequired":run.approval_id.is_some(),
            "approvalId":run.approval_id,
            "workflowRunId":run.id,
            "mode":source.project_plan.as_ref().map(|plan| &plan.mode),
            "tasks":tasks,
        }))
    }
}
