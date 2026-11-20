//! Workflow execution uses pinned bases and candidate merges. Unverified code
//! never enters the integration worktree or the user's original working tree.
use super::*;
use crate::runtime::git::git_command::run_git;
use crate::runtime::workflow::{Instance, NodeWorkspace, WorkflowRun, Workspace};
use std::path::Path;
#[path = "task_workspace.rs"]
mod task_workspace;

pub enum WorkflowCheck {
    Complete(Value),
    Approval {
        ids: Vec<String>,
        checkpoint: Option<Value>,
    },
}

fn at_project(worktree: &str, context: &Value) -> CoreResult<String> {
    let relative = context["projectRelativePath"].as_str().unwrap_or("");
    if Path::new(relative).is_absolute()
        || Path::new(relative)
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        return Err(CoreError::reason(
            ErrorCode::PathPolicyViolation,
            "The pinned project directory escaped its repository",
        ));
    }
    let path = Path::new(worktree).join(relative);
    if !path.is_dir() {
        return Err(CoreError::reason(
            ErrorCode::PathPolicyViolation,
            "The project directory is absent from the pinned Git commit",
        ));
    }
    Ok(path.to_string_lossy().into_owned())
}

impl GitWorkflowService {
    pub async fn plan_workflow(
        &self,
        run: &WorkflowRun,
        force_isolated: bool,
    ) -> CoreResult<Workspace> {
        if run.workspace.as_ref().is_some_and(|workspace|workspace.context["adoptedProjectRunId"].is_string()) {
            return self.plan_task_workspace(run).await;
        }
        let project = run
            .workspace
            .as_ref()
            .map(|workspace| workspace.project.clone())
            .unwrap_or(self.require_project(&run.project_id)?);
        let isolated = project["workspaceMode"] == "git_isolated" || force_isolated;
        let root = project["rootPath"]
            .as_str()
            .ok_or_else(|| crate::errors::invalid("rootPath", "Project path missing"))?;
        let mut context = json!({"id":run.id,"workflowRunId":run.id,"projectId":run.project_id,"goal":run.definition.name.as_deref().unwrap_or(&run.definition.id),"workspaceMode":if isolated{"git_isolated"}else{"direct"},"workspacePath":root});
        if isolated {
            let repository = repository_service::inspect(root).await.map_err(git_fail)?;
            let base = repository.head_commit.ok_or_else(|| {
                crate::errors::invalid("workspace", "Git isolation requires a committed base")
            })?;
            let project_path =
                std::fs::canonicalize(root).map_err(|error| git_fail(error.into()))?;
            let repository_path = std::fs::canonicalize(repository.root_path)
                .map_err(|error| git_fail(error.into()))?;
            let relative = project_path.strip_prefix(&repository_path).map_err(|_| {
                crate::errors::invalid("workspace", "Project is outside its Git repository")
            })?;
            context["baseCommit"] = json!(base);
            context["baseBranch"] = json!(repository.branch);
            context["projectRelativePath"] = json!(relative.to_string_lossy());
        }
        Ok(Workspace {
            owner_run_id: run.id.clone(),
            stage: "planned".into(),
            project,
            context,
            approval_id: None,
            outcome: None,
            error: None,
        })
    }
    fn workflow_project(&self, workspace: &Workspace) -> CoreResult<Value> {
        let current = self.require_project(workspace.project["id"].as_str().unwrap_or(""))?;
        let path =
            |project: &Value| std::fs::canonicalize(project["rootPath"].as_str().unwrap_or(""));
        if path(&current).map_err(|error| git_fail(error.into()))?
            != path(&workspace.project).map_err(|error| git_fail(error.into()))?
        {
            return Err(crate::errors::invalid(
                "workspace",
                "The project directory changed after this workflow was planned",
            ));
        }
        let mut pinned = workspace.project.clone();
        pinned["policyId"] = current["policyId"].clone();
        Ok(pinned)
    }
    pub async fn prepare_workflow(&self, mut workspace: Workspace) -> CoreResult<Workspace> {
        let project = self.workflow_project(&workspace)?;
        if workspace.context["adoptedProjectRunId"].is_string() {
            if workspace.context["branchName"].is_string() {workflow_identity(workspace.context["workspacePath"].as_str().unwrap_or(""),&workspace.context,&project).await?;}
        } else if workspace.context["workspaceMode"] == "git_isolated" {
            let info = self
                .worktrees
                .ensure_workflow_run(
                    &project,
                    &workspace.owner_run_id,
                    workspace.context["baseCommit"].as_str().unwrap_or(""),
                )
                .await
                .map_err(git_fail)?;
            workspace.context["workspaceRoot"] = json!(info.path);
            workspace.context["workspacePath"] = json!(at_project(&info.path, &workspace.context)?);
            workspace.context["branchName"] = json!(info.branch_name);
        }
        workspace.stage = "ready".into();
        Ok(workspace)
    }
    pub async fn plan_workflow_node(
        &self,
        workspace: &Workspace,
        run: &WorkflowRun,
        instance: &Instance,
    ) -> CoreResult<NodeWorkspace> {
        self.workflow_project(workspace)?;
        let node = run.definition.node(&instance.node_id);
        let mut context = json!({"id":format!("{}-{}",instance.id,instance.attempt),"projectRunId":workspace.owner_run_id,"title":node.name.as_deref().unwrap_or(&node.id),"workspacePath":workspace.context["workspacePath"],"allowedPaths":node.workspace.as_ref().map(|policy|policy.allowed_paths.clone()).unwrap_or_default(),"verificationTemplates":node.workspace.as_ref().and_then(|policy|policy.verification_templates.clone())});
        let isolated=workspace.context["workspaceMode"] == "git_isolated" || node.workspace.as_ref().is_some_and(|policy|policy.mode == "isolated" || !policy.allowed_paths.is_empty());
        context["workspaceMode"]=json!(if isolated{"git_isolated"}else{"direct"});
        if let Some(source)=&run.task_projection {context["taskId"]=json!(source.tasks[&node.id].task_id);}
        if isolated {
            let root = workspace.context["workspacePath"].as_str().unwrap_or("");
            context["baseCommit"] = json!(run_git(root, &["rev-parse", "HEAD"], false)
                .await
                .map_err(git_fail)?
                .stdout
                .trim());
        }
        if let Some(saved)=run.task_projection.as_ref().and_then(|source|source.workspaces.get(&node.id)) {
            context=self.adopt_task_node(workspace,saved,context).await?;
        }
        Ok(NodeWorkspace {
            stage: "planned".into(),
            context,
            outcome: None,
            error: None,
        })
    }
    pub async fn prepare_workflow_node(
        &self,
        workspace: &Workspace,
        mut node: NodeWorkspace,
    ) -> CoreResult<NodeWorkspace> {
        let project = self.workflow_project(workspace)?;
        if node.context["adoptedWorkspace"] == true {
            if node.context["workspaceMode"] == "git_isolated" {workflow_identity(node.context["workspacePath"].as_str().unwrap_or(""),&node.context,&project).await?;}
        } else if node.context["workspaceMode"].as_str().unwrap_or_else(||workspace.context["workspaceMode"].as_str().unwrap_or("direct")) == "git_isolated" {
            let info = self
                .worktrees
                .ensure_workflow_task(
                    &project,
                    &workspace.owner_run_id,
                    node.context["id"].as_str().unwrap_or(""),
                    node.context["baseCommit"].as_str().unwrap_or(""),
                )
                .await
                .map_err(git_fail)?;
            node.context["workspaceRoot"] = json!(info.path);
            node.context["workspacePath"] = json!(at_project(&info.path, &workspace.context)?);
            node.context["branchName"] = json!(info.branch_name);
        }
        node.stage = "ready".into();
        Ok(node)
    }
    fn workflow_verification_context(
        &self,
        workspace: &Workspace,
        node: Option<&NodeWorkspace>,
        session: &Value,
        scope: &str,
        cancelled: tokio::sync::watch::Receiver<bool>,
    ) -> VerificationContext {
        let mut selected: Option<Vec<String>> = node
            .filter(|_| scope == "task")
            .and_then(|node| node.context["verificationTemplates"].as_array())
            .map(|ids| {
                ids.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            });
        if let Some(selected) = selected.as_mut() {
            for template in workspace.project["verificationTemplates"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|template| {
                    template["required"] != false
                        && template["scopes"]
                            .as_array()
                            .is_some_and(|scopes| scopes.iter().any(|value| value == scope))
                })
            {
                if let Some(id) = template["id"].as_str() {
                    if !selected.iter().any(|value| value == id) {
                        selected.push(id.into());
                    }
                }
            }
        }
        VerificationContext {
            project_run_id: workspace.context["artifactProjectRunId"].as_str().unwrap_or(&workspace.owner_run_id).into(),
            task_id: node
                .and_then(|node| node.context["taskId"].as_str().or_else(||node.context["id"].as_str()))
                .map(str::to_owned),
            session_id: session["id"].as_str().unwrap_or("").into(),
            scope: scope.into(),
            template_ids: selected,
            on_started: None,
            on_finished: None,
            cancelled: Some(cancelled),
            workflow: Some(json!({"runId":workspace.owner_run_id,"instanceId":node.and_then(|node| node.context["id"].as_str()),"scope":scope})),
        }
    }
    fn workflow_approvals(
        &self,
        project: &Value,
        cwd: &str,
        context: &VerificationContext,
    ) -> CoreResult<Vec<String>> {
        self.verification
            .preflight(project, cwd, context)
            .map(|records| {
                records
                    .into_iter()
                    .filter_map(|record| record["id"].as_str().map(str::to_owned))
                    .collect()
            })
    }
    pub async fn verify_workflow_node(
        &self,
        workspace: &Workspace,
        node: &NodeWorkspace,
        session: &Value,
        cancelled: tokio::sync::watch::Receiver<bool>,
    ) -> CoreResult<WorkflowCheck> {
        let project = self.workflow_project(workspace)?;
        let cwd = node.context["workspacePath"]
            .as_str()
            .ok_or_else(|| crate::errors::invalid("workspace", "Node directory missing"))?;
        let task_context = self.workflow_verification_context(
            workspace,
            Some(node),
            session,
            "task",
            cancelled.clone(),
        );
        let isolated = node.context["workspaceMode"].as_str().unwrap_or_else(||workspace.context["workspaceMode"].as_str().unwrap_or("direct")) == "git_isolated";
        if !isolated {
            let ids = self.workflow_approvals(&project, cwd, &task_context)?;
            if !ids.is_empty() {
                return Ok(WorkflowCheck::Approval {
                    ids,
                    checkpoint: None,
                });
            }
            let results = self.verification.run(&project, cwd, task_context).await?;
            return Ok(WorkflowCheck::Complete(
                json!({"ok":VerificationEngine::passed(&results),"message":if VerificationEngine::passed(&results){"Node acceptance passed"}else{"Required node verification failed"},"verificationResults":results}),
            ));
        }
        workflow_cancelled(&cancelled)?;
        workflow_identity(cwd, &node.context, &project).await?;
        let allowed: Vec<String> = node.context["allowedPaths"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect();
        let task_base = node.context["baseCommit"]
            .as_str()
            .ok_or_else(|| crate::errors::invalid("workspace", "Node base commit missing"))?;
        let mut checkpoint = node
            .outcome
            .clone()
            .filter(|value| value["taskVerified"] == true);
        if let Some(saved) = &checkpoint {
            let current = run_git(cwd, &["rev-parse", "HEAD"], false)
                .await
                .map_err(git_fail)?
                .stdout;
            let dirty = run_git(cwd, &["status", "--porcelain=v1"], false)
                .await
                .map_err(git_fail)?
                .stdout;
            if current.trim() != saved["sourceCommit"].as_str().unwrap_or("")
                || !dirty.trim().is_empty()
            {
                return Err(crate::errors::invalid("workspace","The node workspace changed after its verification checkpoint; retain it for inspection"));
            }
        } else {
            let files = change_collector::collect_since(cwd, task_base)
                .await
                .map_err(git_fail)?;
            if let Some(failure) = workflow_path_failure(cwd, &files, &allowed) {
                return Ok(WorkflowCheck::Complete(failure));
            }
            let ids = self.workflow_approvals(&project, cwd, &task_context)?;
            if !ids.is_empty() {
                return Ok(WorkflowCheck::Approval {
                    ids,
                    checkpoint: None,
                });
            }
            let results = self.verification.run(&project, cwd, task_context).await?;
            if !VerificationEngine::passed(&results) {
                return Ok(WorkflowCheck::Complete(
                    json!({"ok":false,"message":"Required node verification failed","verificationResults":results}),
                ));
            }
            workflow_cancelled(&cancelled)?;
            workflow_identity(cwd, &node.context, &project).await?;
            let files = change_collector::collect_since(cwd, task_base)
                .await
                .map_err(git_fail)?;
            if let Some(failure) = workflow_path_failure(cwd, &files, &allowed) {
                return Ok(WorkflowCheck::Complete(failure));
            }
            let artifact = if files.is_empty() {
                None
            } else {
                Some(self.save_diff(
                    workspace.context["artifactProjectRunId"].as_str().unwrap_or(&workspace.owner_run_id),
                    node.context["taskId"].as_str().or_else(||node.context["id"].as_str()),
                    session,
                    node.context["title"].as_str().unwrap_or("node"),
                    &files,
                )?)
            };
            self.worktrees
                .commit_all(
                    cwd,
                    &format!(
                        "agenthub workflow node {}",
                        node.context["id"].as_str().unwrap_or("")
                    ),
                )
                .await
                .map_err(git_fail)?;
            let source = run_git(cwd, &["rev-parse", "HEAD"], false)
                .await
                .map_err(git_fail)?
                .stdout
                .trim()
                .to_owned();
            if run_git(
                cwd,
                &["merge-base", "--is-ancestor", task_base, &source],
                true,
            )
            .await
            .map_err(git_fail)?
            .exit_code
                != 0
            {
                return Err(crate::errors::invalid(
                    "workspace",
                    "The node rewrote its pinned Git ancestry",
                ));
            }
            checkpoint = Some(
                json!({"taskVerified":true,"sourceCommit":source,"verificationResults":results,"files":workflow_file_summary(&files),"diffArtifactId":artifact.map(|artifact|artifact["id"].clone())}),
            );
        }
        let checkpoint = checkpoint.unwrap();
        let source = checkpoint["sourceCommit"].as_str().unwrap();
        if source == task_base {
            let mut result = checkpoint;
            result["ok"] = json!(true);
            return Ok(WorkflowCheck::Complete(result));
        }
        let integration = workspace.context["workspacePath"]
            .as_str()
            .ok_or_else(|| crate::errors::invalid("workspace", "Integration directory missing"))?;
        workflow_identity(integration, &workspace.context, &project).await?;
        let base = run_git(integration, &["rev-parse", "HEAD"], false)
            .await
            .map_err(git_fail)?
            .stdout
            .trim()
            .to_owned();
        if !run_git(integration, &["status", "--porcelain=v1"], false)
            .await
            .map_err(git_fail)?
            .stdout
            .trim()
            .is_empty()
        {
            return Err(crate::errors::invalid(
                "workspace",
                "The integration worktree has unconfirmed local edits; retain them for inspection",
            ));
        }
        let candidate_id = format!(
            "m-{}-{}",
            node.context["id"].as_str().unwrap_or(""),
            &base[..10]
        );
        let candidate = self
            .worktrees
            .ensure_workflow_task(&project, &workspace.owner_run_id, &candidate_id, &base)
            .await
            .map_err(git_fail)?;
        let candidate_cwd = at_project(&candidate.path, &workspace.context)?;
        let merge_context = self.workflow_verification_context(
            workspace,
            Some(node),
            session,
            "merge",
            cancelled.clone(),
        );
        let ids = self.workflow_approvals(&project, &candidate_cwd, &merge_context)?;
        if !ids.is_empty() {
            return Ok(WorkflowCheck::Approval {
                ids,
                checkpoint: Some(checkpoint),
            });
        }
        workflow_cancelled(&cancelled)?;
        let merged = merge_queue::merge_task(&candidate_cwd, source, &candidate.branch_name)
            .await
            .map_err(git_fail)?;
        if !merged.merged {
            return Ok(WorkflowCheck::Complete(
                json!({"ok":false,"message":"Node changes conflict with accepted workflow changes","conflicts":merged.conflicts,"taskCheckpoint":checkpoint,"candidatePath":candidate_cwd}),
            ));
        }
        let results = self
            .verification
            .run(&project, &candidate_cwd, merge_context)
            .await?;
        if !VerificationEngine::passed(&results) {
            return Ok(WorkflowCheck::Complete(
                json!({"ok":false,"message":"Merged candidate failed required verification; the integration branch was retained","verificationResults":results,"taskCheckpoint":checkpoint,"candidatePath":candidate_cwd}),
            ));
        }
        workflow_cancelled(&cancelled)?;
        let candidate_identity =
            json!({"workspaceRoot":candidate.path,"branchName":candidate.branch_name});
        workflow_identity(&candidate_cwd, &candidate_identity, &project).await?;
        let files = change_collector::collect_since(&candidate_cwd, &base)
            .await
            .map_err(git_fail)?;
        if let Some(mut failure) = workflow_path_failure(&candidate_cwd, &files, &allowed) {
            failure["candidatePath"] = json!(candidate_cwd);
            return Ok(WorkflowCheck::Complete(failure));
        }
        self.worktrees
            .commit_all(
                &candidate_cwd,
                &format!(
                    "agenthub workflow acceptance {}",
                    node.context["id"].as_str().unwrap_or("")
                ),
            )
            .await
            .map_err(git_fail)?;
        let verified = run_git(&candidate_cwd, &["rev-parse", "HEAD"], false)
            .await
            .map_err(git_fail)?
            .stdout
            .trim()
            .to_owned();
        // Advance the integration branch to the exact commit whose combined
        // changes passed. A failed candidate never requires a destructive reset.
        workflow_cancelled(&cancelled)?;
        if run_git(integration, &["rev-parse", "HEAD"], false)
            .await
            .map_err(git_fail)?
            .stdout
            .trim()
            != base
            || !run_git(integration, &["status", "--porcelain=v1"], false)
                .await
                .map_err(git_fail)?
                .stdout
                .trim()
                .is_empty()
        {
            return Err(crate::errors::invalid(
                "workspace",
                "The integration worktree changed during candidate verification",
            ));
        }
        run_git(integration, &["merge", "--ff-only", &verified], false)
            .await
            .map_err(git_fail)?;
        if !run_git(integration, &["status", "--porcelain=v1"], false)
            .await
            .map_err(git_fail)?
            .stdout
            .trim()
            .is_empty()
        {
            return Err(crate::errors::invalid("workspace","The integration worktree changed while accepting the verified commit; retain it for inspection"));
        }
        let mut result = checkpoint;
        result["ok"] = json!(true);
        result["mergeCommit"] = json!(verified);
        result["mergeVerificationResults"] = json!(results);
        result["candidatePath"] = json!(candidate_cwd);
        Ok(WorkflowCheck::Complete(result))
    }

    pub async fn verify_workflow(
        &self,
        workspace: &Workspace,
        session: &Value,
        cancelled: tokio::sync::watch::Receiver<bool>,
    ) -> CoreResult<WorkflowCheck> {
        let project = self.workflow_project(workspace)?;
        let cwd = workspace.context["workspacePath"]
            .as_str()
            .ok_or_else(|| crate::errors::invalid("workspace", "Workflow directory missing"))?;
        let isolated = workspace.context["workspaceMode"] == "git_isolated";
        if isolated {
            workflow_identity(cwd, &workspace.context, &project).await?;
            if !run_git(cwd, &["status", "--porcelain=v1"], false)
                .await
                .map_err(git_fail)?
                .stdout
                .trim()
                .is_empty()
            {
                if !workspace.context["adoptedProjectRunId"].is_string()
                    || workspace.context["branchName"] == workspace.context["baseBranch"]
                {
                    return Err(crate::errors::invalid("workspace","The integration worktree has unconfirmed local edits before final verification; retain them for inspection"));
                }
                workflow_cancelled(&cancelled)?;
                let base = workspace.context["baseCommit"].as_str().unwrap_or("");
                let files = change_collector::collect_since(cwd, base).await.map_err(git_fail)?;
                if let Some(failure) = workflow_path_failure(cwd, &files, &[]) {
                    return Ok(WorkflowCheck::Complete(failure));
                }
                self.worktrees.commit_all(cwd, "Nautilo main Agent changes before workflow acceptance").await.map_err(git_fail)?;
            }
        }
        let context =
            self.workflow_verification_context(workspace, None, session, "run", cancelled.clone());
        let ids = self.workflow_approvals(&project, cwd, &context)?;
        if !ids.is_empty() {
            return Ok(WorkflowCheck::Approval {
                ids,
                checkpoint: None,
            });
        }
        let results = self.verification.run(&project, cwd, context).await?;
        if !VerificationEngine::passed(&results) {
            return Ok(WorkflowCheck::Complete(
                json!({"ok":false,"message":"Final workflow verification failed","verificationResults":results}),
            ));
        }
        workflow_cancelled(&cancelled)?;
        let mut result =
            json!({"ok":true,"verificationResults":results,"needsMergeApproval":false});
        if isolated {
            workflow_identity(cwd, &workspace.context, &project).await?;
            let base = workspace.context["baseCommit"].as_str().unwrap_or("");
            if run_git(cwd, &["merge-base", "--is-ancestor", base, "HEAD"], true)
                .await
                .map_err(git_fail)?
                .exit_code
                != 0
            {
                return Err(crate::errors::invalid(
                    "workspace",
                    "Final verification rewrote the pinned Git ancestry",
                ));
            }
            let files = change_collector::collect_since(cwd, base)
                .await
                .map_err(git_fail)?;
            if let Some(failure) = workflow_path_failure(cwd, &files, &[]) {
                return Ok(WorkflowCheck::Complete(failure));
            }
            let artifact = if files.is_empty() {
                None
            } else {
                Some(self.save_diff(
                    workspace.context["artifactProjectRunId"].as_str().unwrap_or(&workspace.owner_run_id),
                    None,
                    session,
                    "Workflow changes",
                    &files,
                )?)
            };
            self.worktrees
                .commit_all(cwd, "agenthub workflow final verification")
                .await
                .map_err(git_fail)?;
            let source = run_git(cwd, &["rev-parse", "HEAD"], false)
                .await
                .map_err(git_fail)?
                .stdout
                .trim()
                .to_owned();
            result["sourceCommit"] = json!(source);
            result["files"] = json!(workflow_file_summary(&files));
            result["diffArtifactId"] = json!(artifact.map(|artifact| artifact["id"].clone()));
            result["needsMergeApproval"] = json!(
                source != base
                    && !workspace.context["baseBranch"]
                        .as_str()
                        .unwrap_or("")
                        .is_empty()
            );
        }
        Ok(WorkflowCheck::Complete(result))
    }

    pub async fn merge_workflow(
        &self,
        workspace: &Workspace,
        session: &Value,
    ) -> CoreResult<Value> {
        let project = self.workflow_project(workspace)?;
        let outcome = workspace
            .outcome
            .as_ref()
            .ok_or_else(|| crate::errors::invalid("workspace", "Verified merge receipt missing"))?;
        let source = outcome["sourceCommit"]
            .as_str()
            .ok_or_else(|| crate::errors::invalid("workspace", "Verified source commit missing"))?;
        let cwd = project["rootPath"].as_str().unwrap_or("");
        let repository = repository_service::inspect(cwd).await.map_err(git_fail)?;
        if repository.branch != workspace.context["baseBranch"].as_str().unwrap_or("") {
            return Err(crate::errors::invalid(
                "workspace",
                "The original branch changed after this workflow was planned",
            ));
        }
        // A committed merge is observable after a daemon restart; do not apply it twice.
        if run_git(cwd, &["merge-base", "--is-ancestor", source, "HEAD"], true)
            .await
            .map_err(git_fail)?
            .exit_code
            == 0
        {
            return Ok(json!({"merged":true,"commit":repository.head_commit,"reconciled":true}));
        }
        if repository.head_commit.as_deref() != workspace.context["baseCommit"].as_str()
            || !repository.dirty_paths.is_empty()
        {
            return Err(crate::errors::invalid("workspace","The original working tree changed after the reviewed base; retain the isolated result and review again"));
        }
        let integration = workspace.context["workspacePath"].as_str().unwrap_or("");
        workflow_identity(integration, &workspace.context, &project).await?;
        if run_git(integration, &["rev-parse", "HEAD"], false)
            .await
            .map_err(git_fail)?
            .stdout
            .trim()
            != source
            || !run_git(integration, &["status", "--porcelain=v1"], false)
                .await
                .map_err(git_fail)?
                .stdout
                .trim()
                .is_empty()
        {
            return Err(crate::errors::invalid(
                "workspace",
                "The isolated result changed after merge review",
            ));
        }
        run_git(cwd, &["merge", "--ff-only", source], false).await.map_err(git_fail)?;
        let _ = self.events.append_for_session(session,&json!({}),"git.merge_finished",json!({"workflowRunId":workspace.owner_run_id,"sourceCommit":source,"commit":source,"paths":[]}));
        Ok(json!({"merged":true,"commit":source,"conflicts":[]}))
    }

    pub async fn revalidate_workflow_base(&self, mut workspace: Workspace) -> CoreResult<Workspace> {
        if workspace.context["workspaceMode"] == "git_isolated" {
            let project = self.workflow_project(&workspace)?;
            let root = project["rootPath"].as_str().unwrap_or("");
            let original = repository_service::inspect(root).await.map_err(git_fail)?;
            if original.branch != workspace.context["baseBranch"].as_str().unwrap_or("")
                || !original.dirty_paths.is_empty()
            {
                return Err(crate::errors::invalid("workspace", "The original branch and clean working tree are required for revalidation"));
            }
            let old = workspace.context["baseCommit"].as_str().unwrap_or("");
            let base = original.head_commit.ok_or_else(|| crate::errors::invalid("workspace", "The original branch has no commit"))?;
            let cwd = workspace.context["workspacePath"].as_str().unwrap_or("");
            workflow_identity(cwd, &workspace.context, &project).await?;
            if base != old {
                if run_git(root, &["merge-base", "--is-ancestor", old, &base], true).await.map_err(git_fail)?.exit_code != 0 {
                    return Err(crate::errors::invalid("workspace", "The original branch was rewritten; retain the isolated result"));
                }
                if !run_git(cwd, &["status", "--porcelain=v1"], false).await.map_err(git_fail)?.stdout.trim().is_empty() {
                    return Err(crate::errors::invalid("workspace", "Commit or retain the isolated edits before revalidation"));
                }
                let merged = merge_queue::merge_task(cwd, &base, workspace.context["branchName"].as_str().unwrap_or("")).await.map_err(git_fail)?;
                if !merged.merged {
                    return Err(crate::errors::invalid("workspace", "The new original commit conflicts with the isolated work; retain it and resolve the conflicts"));
                }
                workspace.context["baseCommit"] = json!(base);
            }
        }
        workspace.stage = "ready".into();
        workspace.approval_id = None;
        workspace.error = None;
        workspace.outcome = None;
        Ok(workspace)
    }
}

fn workflow_cancelled(cancelled: &tokio::sync::watch::Receiver<bool>) -> CoreResult<()> {
    if *cancelled.borrow() {
        Err(CoreError::reason(
            ErrorCode::RecoveryRequired,
            "Workflow workspace operation was cancelled",
        ))
    } else {
        Ok(())
    }
}
async fn workflow_branch(cwd: &str, branch: &str) -> CoreResult<()> {
    if branch.is_empty()
        || run_git(cwd, &["branch", "--show-current"], false)
            .await
            .map_err(git_fail)?
            .stdout
            .trim()
            != branch
    {
        return Err(crate::errors::invalid(
            "workspace",
            "The reserved workflow branch changed before acceptance",
        ));
    }
    Ok(())
}
async fn workflow_identity(cwd: &str, context: &Value, project: &Value) -> CoreResult<()> {
    workflow_branch(cwd, context["branchName"].as_str().unwrap_or("")).await?;
    let top = run_git(cwd, &["rev-parse", "--show-toplevel"], false)
        .await
        .map_err(git_fail)?
        .stdout;
    let expected = context["workspaceRoot"]
        .as_str()
        .ok_or_else(|| crate::errors::invalid("workspace", "Reserved worktree root missing"))?;
    if std::fs::canonicalize(top.trim()).map_err(|error| git_fail(error.into()))?
        != std::fs::canonicalize(expected).map_err(|error| git_fail(error.into()))?
    {
        return Err(crate::errors::invalid(
            "workspace",
            "The reserved worktree root changed before acceptance",
        ));
    }
    async fn common(cwd: &str) -> CoreResult<std::path::PathBuf> {
        let value = run_git(cwd, &["rev-parse", "--git-common-dir"], false)
            .await
            .map_err(git_fail)?
            .stdout;
        let value = Path::new(value.trim());
        std::fs::canonicalize(if value.is_absolute() {
            value.to_path_buf()
        } else {
            Path::new(cwd).join(value)
        })
        .map_err(|error| git_fail(error.into()))
    }
    if common(cwd).await? != common(project["rootPath"].as_str().unwrap_or("")).await? {
        return Err(crate::errors::invalid(
            "workspace",
            "The node workspace no longer belongs to the pinned project repository",
        ));
    }
    Ok(())
}
fn workflow_path_failure(cwd: &str, files: &[Value], allowed: &[String]) -> Option<Value> {
    let paths: Vec<_> = files
        .iter()
        .filter_map(|file| file["path"].as_str().map(str::to_owned))
        .collect();
    let violations = path_policy::validate(cwd, &paths, allowed);
    (!violations.is_empty()).then(||json!({"ok":false,"message":format!("Changed paths are outside allowedPaths: {}",violations.join(", ")),"pathViolations":violations,"files":workflow_file_summary(files)}))
}
fn workflow_file_summary(files: &[Value]) -> Vec<Value> {
    files
        .iter()
        .map(|file| {
            let mut file = file.clone();
            if let Some(file) = file.as_object_mut() {
                file.remove("diff");
            }
            file
        })
        .collect()
}
