use super::*;
use crate::runtime::workflow::NativeWork;

// Give the native tool transport time to return the committed receipt.
const SUBMISSION_RECEIPT_GRACE_MS: i64 = 500;

impl WorkflowService {
    pub(super) fn should_finish_submitted_turn(
        &self,
        run: &WorkflowRun,
        instance: &Instance,
        saved: &Value,
    ) -> CoreResult<bool> {
        let Some(run_id) = saved["id"].as_str() else { return Ok(false) };
        if instance.branches.is_none()
            || !matches!(saved["status"].as_str(), Some("running" | "starting"))
            || instance.run_id.as_deref().is_some_and(|id| id != run_id)
            || instance.execution_key.as_deref().is_some_and(|key| saved["queueKey"].as_str() != Some(key))
        {
            return Ok(false);
        }
        let settled_receipt = run.events.iter().rev().find(|event| {
            event.r#type == "node.submitted" && event.instance_id.as_deref() == Some(&instance.id)
        }).is_some_and(|event| now().saturating_sub(event.timestamp) >= SUBMISSION_RECEIPT_GRACE_MS);
        // Some Harnesses stop native children together with the foreground turn.
        Ok(settled_receipt && !self.read_native_work(instance, run_id)?.pending())
    }

    fn read_native_work(&self, instance: &Instance, run_id: &str) -> CoreResult<NativeWork> {
        let mut work = instance.native_work.clone()
            .filter(|work| work.run_id == run_id)
            .unwrap_or_else(|| NativeWork::new(run_id));
        for event in workflows::native_work_events(&self.db.lock().unwrap().raw, run_id, work.last_sequence)? {
            work.observe(&event);
        }
        Ok(work)
    }

    pub(super) fn control_node_retry(&self, run_id: &str, input: &Value) -> CoreResult<Value> {
        let id = input["instanceId"].as_str().ok_or_else(|| invalid("instanceId", "Select the node to retry"))?;
        let retry = input["action"] == "retry_node";
        if retry && input["confirmed"] != true {
            return Err(invalid("retry", "Confirm that it is safe to run this node again"));
        }
        if self.launching.lock().unwrap().contains(id)
            || self.workspace_busy(&format!("{run_id}:{id}:verify"))
            || self.workspace_busy(&format!("{run_id}:{id}:prepare"))
        {
            return Err(invalid("retry", "The previous attempt is still stopping"));
        }
        self.change_with_db(run_id, |db, run, _| {
            let instance = run.instances.iter().find(|instance| instance.id == id).ok_or("Unknown instance")?;
            if instance.native_work.as_ref().is_some_and(|work| work.pending())
                || !workflows::live_executions(db, run_id, id).map_err(|error| error.to_string())?.is_empty()
            {
                return Err("The previous native execution has not stopped".into());
            }
            if let Some(child) = instance.child_run_id.as_deref() {
                if workflows::get(db, child).map_err(|error|error.to_string())?.is_some_and(|child| {
                    child.active() || child.instances.iter().any(|item| item.native_work.as_ref().is_some_and(|work| work.pending()))
                }) {
                    return Err("The previous subworkflow has not stopped".into());
                }
            }
            if retry {
                if let Some(workspace) = &run.workspace {
                    if instance.workspace.as_ref().is_some_and(|workspace| matches!(workspace.stage.as_str(), "uncertain" | "preparing" | "verifying"))
                        || !Repositories::new(db).verifications().unsettled_workflow(&workspace.owner_run_id, Some(id)).map_err(|error| error.to_string())?.is_empty()
                    {
                        return Err("Reconcile the previous worktree operation before retrying this node".into());
                    }
                }
                return run.retry_node(id, now());
            }
            run.decline_retry(id, now())
        })?;
        self.inspect(run_id)
    }

    pub(super) fn finish_native_execution(
        &self,
        workflow_id: &str,
        instance_id: &str,
        attempt: u32,
        saved: &Value,
        output: Option<String>,
    ) -> CoreResult<()> {
        let current = self.get(workflow_id)?;
        let Some(instance) = current
            .instances
            .iter()
            .find(|i| i.id == instance_id && i.attempt == attempt)
        else {
            return Ok(());
        };
        if instance.status == "completed" {
            return Ok(());
        }
        let run_id = saved["id"].as_str().unwrap_or("");
        if instance
            .execution_key
            .as_ref()
            .is_some_and(|key| saved["queueKey"].as_str() != Some(key.as_str()))
        {
            return Ok(());
        }
        if !["starting", "running", "cancelled", "failed"].contains(&instance.status.as_str()) {
            return Ok(());
        }
        if instance.run_id.as_deref().is_some_and(|id| id != run_id) {
            return Ok(());
        }
        let work = self.read_native_work(instance, run_id)?;
        self.change(workflow_id, |run| {
            let index = run
                .instances
                .iter()
                .position(|i| i.id == instance_id)
                .ok_or("Missing instance")?;
            let instance = &mut run.instances[index];
            if instance.attempt != attempt
                || instance.status == "completed"
                || instance
                    .execution_key
                    .as_ref()
                    .is_some_and(|key| saved["queueKey"].as_str() != Some(key.as_str()))
                || !["starting", "running", "cancelled", "failed"]
                    .contains(&instance.status.as_str())
                || instance.run_id.as_deref().is_some_and(|id| id != run_id)
                || instance.native_work.as_ref().is_some_and(|current| {
                    current.run_id == run_id && current.last_sequence > work.last_sequence
                })
            {
                return Ok(());
            }
            let was_pending = instance
                .native_work
                .as_ref()
                .is_some_and(|work| work.pending());
            let changed = instance.native_work.as_ref() != Some(&work);
            instance.run_id = Some(run_id.into());
            instance.native_work = Some(work.clone());
            if changed && (!work.children.is_empty() || work.error.is_some()) {
                run.event(
                    "node.native_children",
                    Some(instance_id),
                    "Native child work updated",
                    json!({"nativeWork":work}),
                    now(),
                );
            }
            if ["cancelled", "failed"].contains(&run.instances[index].status.as_str()) {
                return Ok(());
            }
            if saved["status"] != "completed" || work.failure().is_some() {
                return run.execution_result(
                    instance_id,
                    attempt,
                    false,
                    work.failure()
                        .or_else(|| saved["failureCode"].as_str().map(str::to_owned)),
                    output,
                    now(),
                );
            }
            run.instances[index].status = "running".into();
            if work.pending() {
                if run.instances[index].deadline_at.is_none() {
                    run.instances[index].deadline_at = Some(
                        now()
                            + run
                                .definition
                                .node(&run.instances[index].node_id)
                                .submission_policy
                                .timeout_ms,
                    );
                }
                if let Some(output) = output {
                    run.instances[index].last_output = Some(output.chars().take(12000).collect());
                }
                return Ok(());
            }
            if was_pending {
                run.instances[index].deadline_at = None;
            }
            if run.instances[index].child_run_id.is_some() && !run.instances[index].dynamic_child_reported
                && run.definition.node(&run.instances[index].node_id).kind == "agent"
            {
                let instance = &mut run.instances[index];
                instance.status = "waiting_submission".into();
                instance.next_reminder_at = None;
                instance.deadline_at = None;
                run.event("node.waiting_subworkflow", Some(instance_id), "Waiting for the subworkflow outcome", Value::Null, now());
                return Ok(());
            }
            run.execution_result(instance_id, attempt, true, None, output, now())
        })
    }

    pub(super) async fn stop_native_children(
        &self,
        run: &WorkflowRun,
        instance: &Instance,
    ) -> CoreResult<()> {
        let Some(work) = instance.native_work.as_ref().filter(|work| work.pending()) else {
            return Ok(());
        };
        let session = match instance.session_id.as_deref() {
            Some(id) => Repositories::new(&self.db.lock().unwrap().raw)
                .sessions()
                .get(id)?,
            None => None,
        };
        let released = match session {
            Some(session) => {
                self.runs
                    .release_native_session_if_latest(&session, &work.run_id)
                    .await?
            }
            None => true,
        };
        self.change(&run.id,|run| {
            let instance = run.instances.iter_mut().find(|i|i.id == instance.id).ok_or("Missing instance")?;
            if let Some(current) = instance.native_work.as_mut().filter(|current|current.run_id == work.run_id) {
                current.released = released;
                current.detached = !released;
            }
            let id = instance.id.clone();
            run.event(if released {"node.native_children_stopped"}else{"node.native_children_detached"},Some(&id),
                if released {"Cancelled native child work"}else{"Native session now belongs to a later turn; retained its background work"},Value::Null,now());
            if !released { run.queue_main("The workflow stopped. Its child session has since been used by another turn, so native background work was retained in that session instead of interrupting the newer task.",now()); }
            Ok(())
        })
    }
}
