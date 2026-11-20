use super::*;
use crate::runtime::git_workflow_service::{GitWorkflowService, WorkflowCheck};
use crate::runtime::workflow::{Acceptance, NodeWorkspace, Workspace};

pub(super) struct WorkspaceJob {
    run_id: String,
    instance_id: Option<String>,
    cancelled: tokio::sync::watch::Sender<bool>,
    handle: tokio::task::JoinHandle<()>,
}
enum Effect {
    Root(Workspace),
    Node(NodeWorkspace),
    NodeChecked(WorkflowCheck),
    FinalChecked(WorkflowCheck),
    Merged(Value),
    Deferred,
}

impl WorkflowService {
    pub fn set_git_workflows(&self, git: Arc<GitWorkflowService>) {
        let _ = self.git_workflows.set(git);
    }
    pub(super) fn workspace_requirements(&self, definition: &Definition, project: &Value) -> CoreResult<bool> {
        let mut isolated = false;
        for node in &definition.nodes {
            if let Some(ids) = node
                .workspace
                .as_ref()
                .and_then(|policy| policy.verification_templates.as_ref())
            {
                for id in ids {
                    if !project["verificationTemplates"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .any(|template| {
                            template["id"] == id.as_str()
                                && template["scopes"].as_array().is_some_and(|scopes| {
                                    scopes.iter().any(|scope| scope == "task")
                                })
                        })
                    {
                        return Err(invalid(
                            "workspace",
                            &format!(
                                "Node {} selects unregistered task verification {id}",
                                node.id
                            ),
                        ));
                    }
                }
            }
            if node
                .workspace
                .as_ref()
                .is_some_and(|policy| policy.mode == "isolated" || !policy.allowed_paths.is_empty())
            {
                isolated = true;
            }
            if let Some(reference) = &node.reference {
                let saved =
                    self.get_template(&json!({"id":reference.id,"revision":reference.revision}))?;
                let child: Definition = serde_json::from_value(saved["definition"].clone())
                    .map_err(|error| invalid("definition", &error.to_string()))?;
                isolated |= self.workspace_requirements(&child, project)?;
            }
        }
        Ok(isolated)
    }
    pub(super) fn capture_workspace(&self, run: &mut WorkflowRun) -> CoreResult<()> {
        if self.git_workflows.get().is_none() || !run.active() || run.parent_run_id.is_some() {
            return Ok(());
        }
        let project = Repositories::new(&self.db.lock().unwrap().raw)
            .projects()
            .get(&run.project_id)?
            .ok_or_else(|| not_found("project", &run.project_id))?;
        let required = self.workspace_requirements(&run.definition, &project)?;
        let isolated = project["workspaceMode"] == "git_isolated" || required;
        run.workspace = Some(Workspace {
            owner_run_id: run.id.clone(),
            stage: "unplanned".into(),
            project,
            context: json!({"workspaceMode":if isolated{"git_isolated"}else{"direct"}}),
            approval_id: None,
            outcome: None,
            error: None,
        });
        run.acceptance = Some(Acceptance::default());
        for instance in run
            .instances
            .iter_mut()
            .filter(|instance| run.definition.node(&instance.node_id).kind == "agent")
        {
            instance.acceptance = Some(Acceptance::default());
        }
        Ok(())
    }
    pub(super) fn workspace_node_ready(&self, run: &WorkflowRun, instance: &Instance) -> bool {
        run.workspace.is_none()
            || run.definition.node(&instance.node_id).kind == "call"
            || instance
                .workspace
                .as_ref()
                .is_some_and(|workspace| workspace.stage == "ready")
    }
    fn workspace_lock(&self, owner: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut locks = self.workspace_locks.lock().unwrap();
        locks.retain(|_, lock| lock.strong_count() > 0);
        if let Some(lock) = locks.get(owner).and_then(std::sync::Weak::upgrade) {
            return lock;
        }
        let lock = Arc::new(tokio::sync::Mutex::new(()));
        locks.insert(owner.into(), Arc::downgrade(&lock));
        lock
    }
    pub(super) fn workspace_busy(&self, key: &str) -> bool {
        self.workspace_jobs
            .lock()
            .unwrap()
            .get(key)
            .is_some_and(|job| !job.handle.is_finished())
    }
    fn workspace_job<F, Fut>(
        self: &Arc<Self>,
        key: String,
        run: WorkflowRun,
        instance: Option<Instance>,
        operation: F,
    ) where
        F: FnOnce(Arc<Self>, tokio::sync::watch::Receiver<bool>) -> Fut + Send + 'static,
        Fut: std::future::Future<Output = CoreResult<Effect>> + Send + 'static,
    {
        let mut jobs = self.workspace_jobs.lock().unwrap();
        if jobs.get(&key).is_some_and(|job| !job.handle.is_finished()) {
            return;
        }
        let (cancelled, receiver) = tokio::sync::watch::channel(false);
        let service = self.clone();
        let job_key = key.clone();
        let run_id = run.id.clone();
        let instance_id = instance.as_ref().map(|instance| instance.id.clone());
        let handle = tokio::spawn(async move {
            let outcome = operation(service.clone(), receiver).await;
            if let Err(error) = service.workspace_effect(&run, instance.as_ref(), outcome) {
                let reason = error.to_string();
                let _ = service.change(&run.id, |run| {
                    run.escalate(&reason, now());
                    Ok(())
                });
            }
            service.workspace_jobs.lock().unwrap().remove(&job_key);
            service.wake.notify_one();
        });
        jobs.insert(
            key,
            WorkspaceJob {
                run_id,
                instance_id,
                cancelled,
                handle,
            },
        );
    }

    fn workspace_effect(
        &self,
        original: &WorkflowRun,
        original_instance: Option<&Instance>,
        outcome: CoreResult<Effect>,
    ) -> CoreResult<()> {
        self.change_with_db(&original.id, |db, run, _| {
            let index=original_instance.and_then(|original|run.instances.iter().position(|instance|instance.id == original.id && instance.attempt == original.attempt));
            if original_instance.is_some() && index.is_none() {return Ok(());}
            match outcome {
                Ok(Effect::Root(mut workspace))=>{
                    if !run.active(){workspace.stage="cancelled".into();}
                    let stage=workspace.stage.clone();let context=workspace.context.clone();run.workspace=Some(workspace);
                    run.event("workflow.workspace",None,"Workflow workspace prepared",json!({"stage":stage,"context":context}),now());
                }
                Ok(Effect::Node(mut workspace))=>{
                    let instance=&mut run.instances[index.unwrap()];if !instance.active(){workspace.stage="cancelled".into();}
                    let snapshot=workspace.clone();let id=instance.id.clone();instance.workspace=Some(workspace);
                    run.event("node.workspace",Some(&id),"Node workspace prepared",json!({"workspace":snapshot}),now());
                }
                Ok(Effect::Deferred)=>{
                    if let Some(index)=index {
                        let active=run.active() && run.instances[index].active();
                        if let Some(workspace)=run.instances[index].workspace.as_mut(){workspace.stage=if active{"ready".into()}else{"cancelled".into()};}
                        if let Some(gate)=run.instances[index].acceptance.as_mut(){gate.status=if active{"pending".into()}else{"cancelled".into()};}
                    }
                }
                Ok(Effect::NodeChecked(WorkflowCheck::Approval{ids,checkpoint}))=>{
                    let instance=&mut run.instances[index.unwrap()];
                    if let Some(workspace)=instance.workspace.as_mut(){workspace.stage="waiting_approval".into();workspace.context["approvalIds"]=json!(ids);if checkpoint.is_some(){workspace.outcome=checkpoint;}}
                    if let Some(gate)=instance.acceptance.as_mut(){gate.status="waiting_approval".into();gate.details=json!({"approvalIds":ids});}
                    let snapshot=json!({"approvalIds":ids,"workspace":instance.workspace,"acceptance":instance.acceptance});
                    run.event("node.verification_approval",Some(&original_instance.unwrap().id),"Verification commands require approval",snapshot,now());
                }
                Ok(Effect::NodeChecked(WorkflowCheck::Complete(result)))=>{
                    let active=run.active() && run.instances[index.unwrap()].active();
                    let instance=&mut run.instances[index.unwrap()];
                    if let Some(workspace)=instance.workspace.as_mut(){workspace.stage=if !active{"cancelled".into()}else if result["ok"] == true {"passed".into()}else{"failed".into()};workspace.outcome=Some(result.clone());}
                    if !active {if let Some(gate)=instance.acceptance.as_mut(){gate.status="cancelled".into();gate.ended_at=Some(now());gate.details=result.clone();}}
                    let snapshot=json!({"workspace":instance.workspace});
                    run.event("node.workspace_checked",Some(&original_instance.unwrap().id),"Node workspace verification recorded",snapshot,now());
                    run.verification_finished(&original_instance.unwrap().id,result["ok"] == true,result,now())?;
                }
                Ok(Effect::FinalChecked(WorkflowCheck::Approval{ids,..}))=>{
                    if let Some(workspace)=run.workspace.as_mut(){workspace.stage="waiting_approval".into();workspace.context["approvalIds"]=json!(ids);}
                    if let Some(gate)=run.acceptance.as_mut(){gate.status="waiting_approval".into();gate.details=json!({"approvalIds":ids});}
                    run.event("workflow.verification_approval",None,"Final verification commands require approval",json!({"approvalIds":ids}),now());
                }
                Ok(Effect::FinalChecked(WorkflowCheck::Complete(mut result)))=>{
                    let workspace=run.workspace.as_mut().ok_or("Workspace missing")?;
                    result["workspacePath"]=workspace.context["workspacePath"].clone();result["branchName"]=workspace.context["branchName"].clone();
                    workspace.outcome=Some(result.clone());
                    if result["ok"] == true && result["needsMergeApproval"] == true && run.status == "finalizing" {
                        let approval_id=Uuid::new_v4().to_string();
                        Repositories::new(db).approvals().save(&json!({"id":approval_id,"category":"merge","operation":format!("workflow.merge:{}",result["sourceCommit"].as_str().unwrap_or("")),"workflowRunId":run.id,"projectId":run.project_id,"projectRunId":run.task_projection.as_ref().map(|source|&source.project_run_id),"sessionId":run.session_id,"summary":format!("Merge workflow {} into {}",run.definition.name.as_deref().unwrap_or(&run.definition.id),workspace.context["baseBranch"].as_str().unwrap_or("")),"status":"pending","sourceCommit":result["sourceCommit"],"baseCommit":workspace.context["baseCommit"],"diffArtifactId":result["diffArtifactId"],"createdAt":now_iso()})).map_err(|error|error.to_string())?;
                        workspace.approval_id=Some(approval_id.clone());workspace.stage="waiting_merge".into();run.acceptance.as_mut().unwrap().status="waiting_approval".into();
                        run.event("workflow.merge_requested",None,"Verified changes are ready for merge review",json!({"approvalId":approval_id,"result":result}),now());
                    } else {
                        workspace.stage=if run.status == "cancelled"{"cancelled".into()}else if result["ok"] == true {"complete".into()}else{"failed".into()};
                        if run.status == "cancelled"{if let Some(gate)=run.acceptance.as_mut(){gate.status="cancelled".into();gate.ended_at=Some(now());gate.details=result.clone();}}
                        run.final_verification_finished(result["ok"] == true,result,now())?;
                    }
                }
                Ok(Effect::Merged(result))=>{
                    let mut details=run.workspace.as_ref().and_then(|workspace|workspace.outcome.clone()).unwrap_or_else(||json!({}));details["merge"]=result.clone();
                    if let Some(workspace)=run.workspace.as_mut(){workspace.stage=if result["merged"] == true {"complete".into()}else{"failed".into()};workspace.outcome=Some(details.clone());}
                    if result["merged"] != true {details["message"]=json!("Final merge could not be applied; the isolated result was retained");}
                    run.event("workflow.merge_recorded",None,"Final merge result recorded",json!({"result":result}),now());
                    run.final_verification_finished(result["merged"] == true,details,now())?;
                }
                Err(error)=>{
                    let reason=error.to_string();
                    if let Some(index)=index {
                        let active=run.active() && run.instances[index].active();
                        let workspace=run.instances[index].workspace.get_or_insert_with(||NodeWorkspace{stage:"uncertain".into(),context:json!({}),outcome:None,error:None});
                        workspace.stage=if active{"uncertain".into()}else{"cancelled".into()};workspace.error=Some(reason.clone());
                        if active {
                            let id=run.instances[index].id.clone();
                            if run.instances[index].status == "verifying" {
                                run.verification_finished(&id,false,json!({"message":reason,"code":error.0.code}),now())?;
                            } else {
                                if let Some(gate)=run.instances[index].acceptance.as_mut(){gate.status="failed".into();gate.ended_at=Some(now());gate.details=json!({"message":reason,"code":error.0.code});}
                                run.fail(&id,&reason,now())?;
                            }
                        }
                    } else {
                        let active=run.active();
                        if let Some(workspace)=run.workspace.as_mut(){workspace.stage=if active{"uncertain".into()}else{"cancelled".into()};workspace.error=Some(reason.clone());}
                        if !active{if let Some(gate)=run.acceptance.as_mut(){gate.status="cancelled".into();gate.ended_at=Some(now());gate.details=json!({"message":reason});}}
                        run.escalate(&reason,now());
                    }
                }
            }
            Ok(())
        })
    }

    pub(super) async fn drive_workspaces(self: &Arc<Self>, run: &WorkflowRun) -> CoreResult<bool> {
        let Some(git) = self.git_workflows.get().cloned() else {
            return Ok(true);
        };
        {
            let mut jobs = self.workspace_jobs.lock().unwrap();
            jobs.retain(|_, job| !job.handle.is_finished());
            for job in jobs.values().filter(|job| job.run_id == run.id) {
                if !run.active()
                    || job.instance_id.as_ref().is_some_and(|id| {
                        run.instances
                            .iter()
                            .find(|instance| &instance.id == id)
                            .is_none_or(|instance| !instance.active())
                    })
                {
                    let _ = job.cancelled.send(true);
                }
            }
        }
        let Some(workspace) = run.workspace.clone() else {
            if run.active() {
                if run
                    .instances
                    .iter()
                    .any(|instance| instance.run_id.is_some())
                {
                    return Err(invalid("workspace","This workflow began without a pinned workspace; retain its native sessions and review before continuing"));
                }
                let mut snapshot = run.clone();
                self.capture_workspace(&mut snapshot)?;
                self.change(&run.id, |run| {
                    run.workspace = snapshot.workspace;
                    run.acceptance = snapshot.acceptance;
                    for instance in &mut run.instances {
                        if run.definition.node(&instance.node_id).kind == "agent" {
                            instance.acceptance = Some(Acceptance::default());
                        }
                    }
                    Ok(())
                })?;
            }
            return Ok(false);
        };
        self.resolve_workspace_approvals(run)?;
        self.reconcile_workspace_cleanup(&self.get(&run.id)?)?;
        if !run.active() {
            return Ok(false);
        }
        let owner = self.get(&workspace.owner_run_id)?;
        let workspace = owner
            .workspace
            .clone()
            .ok_or_else(|| invalid("workspace", "Workspace owner missing"))?;
        let root_key = format!("{}:workspace", run.id);
        if workspace.owner_run_id == run.id
            && ["unplanned", "planning"].contains(&workspace.stage.as_str())
        {
            if !self.workspace_busy(&root_key) && (run.status == "running" || run.status == "finalizing") {
                self.change(&run.id, |run| {
                    run.workspace.as_mut().unwrap().stage = "planning".into();
                    Ok(())
                })?;
                let snapshot = run.clone();
                let force = workspace.context["workspaceMode"] == "git_isolated";
                self.workspace_job(root_key, run.clone(), None, move |_, _| async move {
                    git.plan_workflow(&snapshot, force).await.map(Effect::Root)
                });
            }
            return Ok(false);
        }
        if workspace.owner_run_id == run.id
            && ["planned", "preparing"].contains(&workspace.stage.as_str())
        {
            if !self.workspace_busy(&root_key) && run.status == "running" {
                self.change(&run.id, |run| {
                    run.workspace.as_mut().unwrap().stage = "preparing".into();
                    Ok(())
                })?;
                self.workspace_job(root_key, run.clone(), None, move |_, _| async move {
                    git.prepare_workflow(workspace).await.map(Effect::Root)
                });
            }
            return Ok(false);
        }
        if run.status == "running" && workspace.stage == "ready" {
            let available = run.definition.limits.max_parallel.saturating_sub(
                run.instances
                    .iter()
                    .filter(|instance| instance.occupies_slot())
                    .count(),
            );
            for instance in run
                .instances
                .iter()
                .filter(|instance| {
                    instance.status == "ready"
                        && run.definition.node(&instance.node_id).kind == "agent"
                })
                .take(available)
            {
                let key = format!("{}:{}:prepare", run.id, instance.id);
                if self.workspace_busy(&key) {
                    continue;
                }
                let git = git.clone();
                let root = workspace.clone();
                let snapshot = run.clone();
                let child = instance.clone();
                if instance.workspace.is_none() {
                    self.workspace_job(
                        key,
                        run.clone(),
                        Some(instance.clone()),
                        move |_, _| async move {
                            git.plan_workflow_node(&root, &snapshot, &child)
                                .await
                                .map(Effect::Node)
                        },
                    );
                } else if instance.workspace.as_ref().is_some_and(|workspace| {
                    ["planned", "preparing"].contains(&workspace.stage.as_str())
                }) {
                    let node = instance.workspace.clone().unwrap();
                    self.change(&run.id, |run| {
                        run.instances
                            .iter_mut()
                            .find(|i| i.id == instance.id)
                            .unwrap()
                            .workspace
                            .as_mut()
                            .unwrap()
                            .stage = "preparing".into();
                        Ok(())
                    })?;
                    self.workspace_job(
                        key,
                        run.clone(),
                        Some(instance.clone()),
                        move |_, _| async move {
                            git.prepare_workflow_node(&root, node)
                                .await
                                .map(Effect::Node)
                        },
                    );
                }
            }
        }
        for instance in run
            .instances
            .iter()
            .filter(|instance| instance.status == "verifying")
        {
            let key = format!("{}:{}:verify", run.id, instance.id);
            if self.workspace_busy(&key) {
                continue;
            }
            let Some(node) = instance.workspace.clone() else {
                return Err(invalid("workspace", "Node acceptance directory missing"));
            };
            if node.stage == "verifying" {
                self.change(&run.id, |run| {
                    let instance = run.instances.iter_mut().find(|i| i.id == instance.id).unwrap();
                    let workspace = instance.workspace.as_mut().unwrap();
                    workspace.stage = "uncertain".into();
                    workspace.error = Some("The daemon stopped during acceptance. Verify the previous command before retrying.".into());
                    instance.acceptance.as_mut().unwrap().status = "uncertain".into();
                    let id = instance.id.clone();
                    let snapshot = workspace.clone();
                    run.event("node.workspace_uncertain", Some(&id), "Verification needs reconciliation", json!({"workspace":snapshot}), now());
                    Ok(())
                })?;
                continue;
            }
            if node.stage != "ready" || run.status != "running" {
                continue;
            }
            let session = Repositories::new(&self.db.lock().unwrap().raw)
                .sessions()
                .get(instance.session_id.as_deref().unwrap_or(""))?
                .ok_or_else(|| invalid("session", "Node session missing"))?;
            self.change(&run.id, |run| {
                run.instances
                    .iter_mut()
                    .find(|i| i.id == instance.id)
                    .unwrap()
                    .workspace
                    .as_mut()
                    .unwrap()
                    .stage = "verifying".into();
                run.verification_started(&instance.id, now()).map(|_| ())
            })?;
            let root = workspace.clone();
            let git = git.clone();
            let node = node.clone();
            let run_id = run.id.clone();
            let instance = instance.clone();
            self.workspace_job(key,run.clone(),Some(instance.clone()),move|service,cancelled|async move{
                let _guard=service.workspace_lock(root.context["integrationKey"].as_str().unwrap_or(&root.owner_run_id)).lock_owned().await;
                let current=service.get(&run_id)?;
                if current.status == "paused" {return Ok(Effect::Deferred);}
                if !current.active() || current.instances.iter().find(|i|i.id == instance.id).is_none_or(|instance|!instance.active()) {return Err(invalid("workspace","Acceptance was cancelled"));}
                let latest=Repositories::new(&service.db.lock().unwrap().raw).runs().latest_for_session(session["id"].as_str().unwrap_or(""))?;
                if latest.as_ref().and_then(|run|run["id"].as_str()) != instance.run_id.as_deref(){return Err(invalid("workspace","The node session has been used by a later turn; retain its work for inspection"));}
                git.verify_workflow_node(&root,&node,&session,cancelled).await.map(Effect::NodeChecked)
            });
        }
        if run.parent_run_id.is_none() && run.status == "finalizing"
            && run.task_projection.as_ref().and_then(|source| source.project_plan.as_ref()).is_none_or(|plan| plan.stage == "acceptance")
        {
            self.drive_final_workspace(run, &workspace, git)?;
        }
        Ok(workspace.stage == "ready")
    }

    /// A stopped projection must eventually leave the dispatcher's pending
    /// queue, even when a daemon restart lost the in-process job handle.
    /// Retain uncertain external effects instead of reporting an unobserved kill.
    fn reconcile_workspace_cleanup(&self, run: &WorkflowRun) -> CoreResult<()> {
        let root_orphan = run.workspace.as_ref().is_some_and(|workspace| {
            workspace.owner_run_id == run.id
                && !run.active()
                && ["planning", "preparing", "verifying", "merging"]
                    .contains(&workspace.stage.as_str())
                && !self.workspace_busy(&format!("{}:workspace", run.id))
                && !self.workspace_busy(&format!("{}:final", run.id))
        });
        let node_ids: Vec<String> = run
            .instances
            .iter()
            .filter(|instance| {
                (!run.active() || !instance.active())
                    && instance.workspace.as_ref().is_some_and(|workspace| {
                        ["preparing", "verifying"].contains(&workspace.stage.as_str())
                    })
                    && !self.workspace_busy(&format!("{}:{}:prepare", run.id, instance.id))
                    && !self.workspace_busy(&format!("{}:{}:verify", run.id, instance.id))
            })
            .map(|instance| instance.id.clone())
            .collect();
        if !root_orphan && node_ids.is_empty() {
            return Ok(());
        }
        self.change(&run.id,|run|{
            if root_orphan {
                let workspace=run.workspace.as_mut().unwrap();
                let uncertain=["verifying","merging"].contains(&workspace.stage.as_str());
                workspace.stage=if uncertain{"uncertain".into()}else{"cancelled".into()};
                if uncertain{workspace.error=Some("The daemon stopped before the external operation was reconciled; inspect its worktree and receipts before continuing".into());}
                let stage=workspace.stage.clone();
                if let Some(gate)=run.acceptance.as_mut(){gate.status=stage.clone();gate.ended_at=Some(now());}
                run.event("workflow.workspace_stopped",None,"Stopped workspace operation retained for inspection",json!({"stage":stage}),now());
            }
            for id in &node_ids {
                let instance=run.instances.iter_mut().find(|instance|&instance.id == id).unwrap();
                let workspace=instance.workspace.as_mut().unwrap();
                let uncertain=workspace.stage == "verifying";
                workspace.stage=if uncertain{"uncertain".into()}else{"cancelled".into()};
                if uncertain{workspace.error=Some("The daemon stopped before the verification process was reconciled; inspect existing receipts before continuing".into());}
                let stage=workspace.stage.clone();
                if let Some(gate)=instance.acceptance.as_mut(){gate.status=stage;gate.ended_at=Some(now());}
                let snapshot=workspace.clone();
                run.event("node.workspace_stopped",Some(id),"Stopped node workspace retained for inspection",json!({"workspace":snapshot}),now());
            }
            Ok(())
        })
    }

    fn approval_statuses(&self, ids: &[String]) -> CoreResult<Vec<String>> {
        let db = self.db.lock().unwrap();
        let approvals = Repositories::new(&db.raw).approvals();
        ids.iter()
            .map(|id| {
                approvals
                    .get(id)?
                    .and_then(|record| record["status"].as_str().map(str::to_owned))
                    .ok_or_else(|| invalid("approval", "A verification approval record is missing"))
            })
            .collect()
    }
    fn reject_pending(&self, ids: &[String]) -> CoreResult<()> {
        for id in ids {
            let pending = Repositories::new(&self.db.lock().unwrap().raw)
                .approvals()
                .get(id)?
                .is_some_and(|record| record["status"] == "pending");
            if pending {
                crate::runtime::security::ApprovalService::new(self.db.clone()).resolve(
                    id,
                    "rejected",
                    &json!("once"),
                )?;
            }
        }
        Ok(())
    }
    fn resolve_workspace_approvals(&self, run: &WorkflowRun) -> CoreResult<()> {
        for instance in run.instances.iter().filter(|instance| {
            instance
                .workspace
                .as_ref()
                .is_some_and(|workspace| workspace.stage == "waiting_approval")
        }) {
            let ids = approval_ids(&instance.workspace.as_ref().unwrap().context);
            let states = self.approval_statuses(&ids)?;
            if !run.active() || !instance.active() || states.iter().any(|state| state == "rejected")
            {
                self.reject_pending(&ids)?;
                self.change(&run.id, |run| {
                    let target = run
                        .instances
                        .iter_mut()
                        .find(|target| target.id == instance.id)
                        .unwrap();
                    target.workspace.as_mut().unwrap().stage = "failed".into();
                    if target.active() {
                        run.verification_finished(
                            &instance.id,
                            false,
                            json!({"message":"Required verification command was rejected"}),
                            now(),
                        )?;
                    }
                    Ok(())
                })?;
            } else if !ids.is_empty() && states.iter().all(|state| state == "approved") {
                self.change(&run.id, |run| {
                    let target = run
                        .instances
                        .iter_mut()
                        .find(|target| target.id == instance.id)
                        .unwrap();
                    target.workspace.as_mut().unwrap().stage = "ready".into();
                    target.acceptance.as_mut().unwrap().status = "pending".into();
                    Ok(())
                })?;
            }
        }
        if let Some(workspace) = run
            .workspace
            .as_ref()
            .filter(|workspace| workspace.owner_run_id == run.id)
        {
            if !run.active() {
                let mut ids = approval_ids(&workspace.context);
                ids.extend(workspace.approval_id.clone());
                self.reject_pending(&ids)?;
                if ["waiting_approval", "waiting_merge"].contains(&workspace.stage.as_str()) {
                    self.change(&run.id, |run| {
                        run.workspace.as_mut().unwrap().stage = "cancelled".into();
                        Ok(())
                    })?;
                }
            } else if workspace.stage == "waiting_approval" {
                let ids = approval_ids(&workspace.context);
                let states = self.approval_statuses(&ids)?;
                if states.iter().any(|state| state == "rejected") {
                    self.reject_pending(&ids)?;
                    self.change(&run.id, |run| {
                        run.workspace.as_mut().unwrap().stage = "failed".into();
                        run.final_verification_finished(
                            false,
                            json!({"message":"Final verification command was rejected"}),
                            now(),
                        )
                    })?;
                } else if !ids.is_empty() && states.iter().all(|state| state == "approved") {
                    self.change(&run.id, |run| {
                        run.workspace.as_mut().unwrap().stage = "ready".into();
                        run.acceptance.as_mut().unwrap().status = "pending".into();
                        Ok(())
                    })?;
                }
            }
        }
        Ok(())
    }
    fn drive_final_workspace(
        self: &Arc<Self>,
        run: &WorkflowRun,
        workspace: &Workspace,
        git: Arc<GitWorkflowService>,
    ) -> CoreResult<()> {
        let key = format!("{}:final", run.id);
        if self.workspace_busy(&key) {
            return Ok(());
        }
        let session = Repositories::new(&self.db.lock().unwrap().raw)
            .sessions()
            .get(&run.session_id)?
            .ok_or_else(|| not_found("session", &run.session_id))?;
        if workspace.stage == "recheck_requested" {
            self.change(&run.id, |run| {
                run.workspace.as_mut().unwrap().stage = "rechecking".into();
                Ok(())
            })?;
            let workspace = workspace.clone();
            self.workspace_job(key, run.clone(), None, move |service, cancelled| async move {
                let _guard = service.workspace_lock(workspace.context["integrationKey"].as_str().unwrap_or(&workspace.owner_run_id)).lock_owned().await;
                if *cancelled.borrow() || service.get(&workspace.owner_run_id)?.status != "finalizing" {
                    return Err(invalid("workspace", "Revalidation was stopped"));
                }
                git.revalidate_workflow_base(workspace).await.map(Effect::Root)
            });
        } else if workspace.stage == "ready" {
            self.change(&run.id, |run| {
                run.workspace.as_mut().unwrap().stage = "verifying".into();
                let gate = run.acceptance.as_mut().unwrap();
                gate.status = "running".into();
                gate.started_at = Some(now());
                Ok(())
            })?;
            let workspace = workspace.clone();
            self.workspace_job(
                key,
                run.clone(),
                None,
                move |service, cancelled| async move {
                    let _guard = service
                        .workspace_lock(workspace.context["integrationKey"].as_str().unwrap_or(&workspace.owner_run_id))
                        .lock_owned()
                        .await;
                    if service.get(&workspace.owner_run_id)?.status != "finalizing" {
                        return Err(invalid("workspace", "Final acceptance was cancelled"));
                    }
                    git.verify_workflow(&workspace, &session, cancelled)
                        .await
                        .map(Effect::FinalChecked)
                },
            );
        } else if matches!(workspace.stage.as_str(), "verifying" | "rechecking") {
            self.change(&run.id, |run| {
                let workspace = run.workspace.as_mut().unwrap();
                workspace.stage = "uncertain".into();
                workspace.error = Some("The daemon stopped before acceptance completed. Inspect the working tree and previous commands.".into());
                run.acceptance.as_mut().unwrap().status = "uncertain".into();
                run.event("workflow.workspace_uncertain", None, "Acceptance needs reconciliation", Value::Null, now());
                Ok(())
            })?;
        } else if ["waiting_merge", "merging"].contains(&workspace.stage.as_str()) {
            let id = workspace
                .approval_id
                .as_deref()
                .ok_or_else(|| invalid("approval", "Merge approval missing"))?;
            let record = Repositories::new(&self.db.lock().unwrap().raw)
                .approvals()
                .get(id)?
                .ok_or_else(|| invalid("approval", "Merge approval record missing"))?;
            if record["status"] == "rejected" {
                self.change(&run.id, |run| {
                    let workspace = run.workspace.as_mut().unwrap();
                    workspace.stage = "retained".into();
                    let mut details = workspace.outcome.clone().unwrap_or_else(|| json!({}));
                    details["retained"] = json!(true);
                    workspace.outcome = Some(details.clone());
                    run.final_verification_finished(true, details, now())
                })?;
            } else if record["status"] == "approved" {
                self.change_with_db(&run.id, |db, run, _| {
                    let workspace = run.workspace.as_mut().unwrap();
                    workspace.stage = "merging".into();
                    let mut record = Repositories::new(db)
                        .approvals()
                        .get(id)
                        .map_err(|error| error.to_string())?
                        .ok_or("Merge approval missing")?;
                    if record["status"] != "approved" {
                        return Err("Merge approval changed".into());
                    }
                    if record.get("consumedAt").is_none() {
                        record["consumedAt"] = json!(now_iso());
                        Repositories::new(db)
                            .approvals()
                            .save(&record)
                            .map_err(|error| error.to_string())?;
                    }
                    Ok(())
                })?;
                let workspace = workspace.clone();
                self.workspace_job(
                    key,
                    run.clone(),
                    None,
                    move |service, cancelled| async move {
                        let _guard = service
                            .workspace_lock(workspace.context["integrationKey"].as_str().unwrap_or(&workspace.owner_run_id))
                            .lock_owned()
                            .await;
                        if *cancelled.borrow()
                            || service.get(&workspace.owner_run_id)?.status != "finalizing"
                        {
                            return Err(invalid(
                                "workspace",
                                "Merge was cancelled before it began",
                            ));
                        }
                        git.merge_workflow(&workspace, &session)
                            .await
                            .map(Effect::Merged)
                    },
                );
            }
        }
        Ok(())
    }
    pub(super) fn workspace_control(&self, input: &Value) -> CoreResult<bool> {
        let action = input["action"].as_str().unwrap_or("");
        if matches!(action, "recheck_workspace" | "retain_workspace") {
            self.recover_workspace(input)?;
            return Ok(true);
        }
        if ![
            "approve_merge",
            "reject_merge",
            "approve_verification",
            "reject_verification",
        ]
        .contains(&action)
        {
            return Ok(false);
        }
        let run = self.get(input["runId"].as_str().unwrap_or(""))?;
        if !run.active() {
            return Err(invalid(
                "approval",
                "This workflow has stopped; its pending operations cannot be approved",
            ));
        }
        let ids = if action.ends_with("merge") {
            run.workspace
                .as_ref()
                .filter(|workspace| workspace.stage == "waiting_merge")
                .and_then(|workspace| workspace.approval_id.clone())
                .map(|id| vec![id])
                .ok_or_else(|| invalid("approval", "No pending workflow merge"))?
        } else if let Some(instance) = input["instanceId"].as_str() {
            run.instances
                .iter()
                .find(|node| node.id == instance)
                .and_then(|node| node.workspace.as_ref())
                .filter(|workspace| workspace.stage == "waiting_approval")
                .map(|workspace| approval_ids(&workspace.context))
                .ok_or_else(|| invalid("approval", "No pending node verification"))?
        } else {
            run.workspace
                .as_ref()
                .filter(|workspace| workspace.stage == "waiting_approval")
                .map(|workspace| approval_ids(&workspace.context))
                .ok_or_else(|| invalid("approval", "No pending final verification"))?
        };
        for id in ids {
            crate::runtime::security::ApprovalService::new(self.db.clone()).resolve(
                &id,
                if action.starts_with("approve") {
                    "approved"
                } else {
                    "rejected"
                },
                &json!("once"),
            )?;
        }
        self.wake.notify_one();
        Ok(true)
    }

    fn recover_workspace(&self, input: &Value) -> CoreResult<()> {
        let id = input["runId"].as_str().unwrap_or("");
        let node_id = input["instanceId"].as_str();
        let retain = input["action"] == "retain_workspace";
        if !retain && input["confirmed"] != true {
            return Err(invalid("workspace", "Confirm that the previous operation has stopped before rerunning verification"));
        }
        self.change_with_db(id, |db, run, _| {
            let repos = Repositories::new(db);
            let root = run.workspace.as_ref().ok_or("Workflow workspace is missing")?;
            if let Some(source) = &run.task_projection {
                if let Some(plan) = &source.project_plan {
                    let mut project = repos.project_runs().get(&source.project_run_id).map_err(|error|error.to_string())?.ok_or("Project run is missing")?;
                    if project["mainSessionId"] != run.session_id || project["status"] == "cancelled" {
                        return Err("The project no longer owns this workflow".into());
                    }
                    if node_id.is_none() {
                        if project["workflowFinalizerId"] != id || !matches!(plan.stage.as_str(), "acceptance" | "done") {
                            return Err("This workflow is no longer responsible for the project's final acceptance".into());
                        }
                        if !retain && workflows::project_has_foreground_work(db, &source.project_run_id).map_err(|error|error.to_string())? {
                            return Err("Wait for the project Agents to finish before revalidating".into());
                        }
                        project["status"] = json!(if retain {"review_required"} else {"verifying"});
                        project.as_object_mut().unwrap().remove("mergeApprovalId");
                        repos.project_runs().save(&project).map_err(|error|error.to_string())?;
                    }
                }
            }
            if !retain {
                for mut receipt in repos.verifications().unsettled_workflow(&root.owner_run_id, node_id).map_err(|error|error.to_string())? {
                    if let Some(pid) = receipt["processId"].as_u64().and_then(|pid| u32::try_from(pid).ok()) {
                        match crate::runtime::verification_engine::process_identity(pid) {
                            Ok(None) => {},
                            Ok(Some(actual)) if receipt["processIdentity"].as_str().is_some_and(|saved| saved != actual) => {},
                            Ok(Some(_)) => return Err(format!("Verification process {pid} is still running")),
                            Err(error) => return Err(format!("Cannot confirm verification process {pid}: {error}")),
                        }
                    }
                    receipt["status"] = json!("interrupted");
                    receipt["reviewedAt"] = json!(now_iso());
                    repos.verifications().save(&receipt).map_err(|error|error.to_string())?;
                }
            }
            if let Some(node_id) = node_id {
                let instance = run.instances.iter_mut().find(|instance| instance.id == node_id).ok_or("Unknown node")?;
                let workspace = instance.workspace.as_mut().filter(|workspace|workspace.stage == "uncertain").ok_or("This node has no unconfirmed verification")?;
                if !retain && (run.status != "running" || instance.status != "verifying") {
                    return Err("This node no longer has a pending acceptance step".into());
                }
                workspace.stage = if retain {"retained"} else {"ready"}.into();
                if !retain {
                    instance.acceptance = Some(Acceptance::default());
                    workspace.error = None;
                    // Commands reported as interrupted must get fresh policy
                    // approval. Completed checkpoints remain usable.
                    workspace.context.as_object_mut().unwrap().remove("approvalIds");
                }
                let snapshot = workspace.clone();
                run.event("node.workspace_reviewed", Some(node_id), "Node acceptance recovery requested", json!({"workspace":snapshot,"retained":retain}), now());
                if retain && run.active() {
                    run.fail(node_id, "The node's unverified changes were kept for inspection", now())?;
                }
            } else {
                let workspace = run.workspace.as_mut().filter(|workspace|workspace.owner_run_id == id && matches!(workspace.stage.as_str(), "uncertain" | "failed")).ok_or("This workflow has no final acceptance to review")?;
                if !matches!(run.status.as_str(), "finalizing" | "needs_decision") || run.acceptance.is_none() {
                    return Err("This workflow is not waiting on final acceptance".into());
                }
                if retain {
                    workspace.stage = "retained".into();
                    run.escalate("The isolated work was retained without applying it", now());
                } else {
                    workspace.stage = "recheck_requested".into();
                    workspace.approval_id = None;
                    run.acceptance = Some(Acceptance::default());
                    run.status = "finalizing".into();
                    run.error = None;
                }
                if let Some(plan) = run.task_projection.as_mut().and_then(|source| source.project_plan.as_mut()) {
                    plan.stage = if retain {"done"} else {"acceptance"}.into();
                }
                run.event("workflow.workspace_reviewed", None, "Final acceptance recovery requested", json!({"retained":retain}), now());
            }
            Ok(())
        })
    }
}
fn approval_ids(context: &Value) -> Vec<String> {
    context["approvalIds"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}
