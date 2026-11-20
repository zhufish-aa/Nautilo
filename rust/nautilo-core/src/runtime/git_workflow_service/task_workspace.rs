//! Adopt an existing project's integration worktree without cloning its main
//! session or creating a second, invisible integration branch.
use super::*;

impl GitWorkflowService {
    pub(super) async fn plan_task_workspace(&self, run: &WorkflowRun) -> CoreResult<Workspace> {
        let mut workspace = run.workspace.clone().ok_or_else(|| {
            crate::errors::invalid("workspace", "The task plan has no pinned workspace")
        })?;
        let source = run.task_projection.as_ref().ok_or_else(|| {
            crate::errors::invalid(
                "workspace",
                "Only a trusted task plan can adopt a project workspace",
            )
        })?;
        let parent = &workspace.context["parentWorkspace"];
        let latest = Repositories::new(&self.db.lock().unwrap().raw)
            .project_runs()
            .get(&source.project_run_id)?
            .ok_or_else(|| not_found("projectRun", &source.project_run_id))?;
        if workspace.context["adoptedProjectRunId"] != source.project_run_id
            || parent["id"] != source.project_run_id
            || [
                "projectId",
                "workspacePath",
                "workspaceMode",
                "branchName",
                "baseCommit",
                "baseBranch",
            ]
            .iter()
            .any(|key| parent[*key] != latest[*key])
        {
            return Err(crate::errors::invalid(
                "workspace",
                "The owning project workspace changed before the task graph was prepared",
            ));
        }
        let project = self.workflow_project(&workspace)?;
        let root = project["rootPath"]
            .as_str()
            .ok_or_else(|| crate::errors::invalid("workspace", "Project directory missing"))?;
        let cwd = parent["workspacePath"].as_str().unwrap_or(root);
        let isolated = parent["branchName"].is_string()
            && parent["baseCommit"].is_string()
            && parent["workspaceMode"] == "git_isolated";
        let node_isolation = run.definition.nodes.iter().any(|node| {
            node.workspace
                .as_ref()
                .is_some_and(|policy| policy.mode == "isolated" || !policy.allowed_paths.is_empty())
        });
        let mut context = json!({"id":run.id,"workflowRunId":run.id,"projectId":run.project_id,"goal":run.definition.name.as_deref().unwrap_or(&run.definition.id),"workspaceMode":if isolated{"git_isolated"}else{"direct"},"workspacePath":cwd,"adoptedProjectRunId":source.project_run_id,"artifactProjectRunId":source.project_run_id,"integrationKey":format!("task-plan:{}",source.project_run_id)});
        if isolated || node_isolation {
            let original = repository_service::inspect(root).await.map_err(git_fail)?;
            let integration = repository_service::inspect(cwd).await.map_err(git_fail)?;
            let project_path =
                std::fs::canonicalize(root).map_err(|error| git_fail(error.into()))?;
            let original_root = std::fs::canonicalize(&original.root_path)
                .map_err(|error| git_fail(error.into()))?;
            let relative = project_path.strip_prefix(&original_root).map_err(|_| {
                crate::errors::invalid("workspace", "Project directory escaped its repository")
            })?;
            context["workspaceRoot"] = json!(integration.root_path);
            context["projectRelativePath"] = json!(relative.to_string_lossy());
            let project_cwd = at_project(integration.root_path.as_str(), &context)?;
            // Keep the original spelling for native CLIs that use the cwd in
            // their session key. Canonical paths are only identity evidence.
            context["workspacePath"] = json!(if std::fs::canonicalize(cwd)
                .map_err(|error| git_fail(error.into()))?
                == std::fs::canonicalize(&project_cwd).map_err(|error| git_fail(error.into()))?
            {
                cwd.to_owned()
            } else {
                project_cwd
            });
            context["branchName"] = json!(integration.branch);
            context["baseCommit"] = parent
                .get("baseCommit")
                .filter(|value| !value.is_null())
                .cloned()
                .unwrap_or(json!(original.head_commit));
            context["baseBranch"] = parent
                .get("baseBranch")
                .filter(|value| !value.is_null())
                .cloned()
                .unwrap_or(json!(original.branch));
            if isolated
                && (parent["branchName"] != integration.branch
                    || context["baseCommit"].as_str().is_none())
            {
                return Err(crate::errors::invalid(
                    "workspace",
                    "The original integration branch no longer matches its pinned identity",
                ));
            }
            workflow_identity(
                context["workspacePath"].as_str().unwrap_or(""),
                &context,
                &project,
            )
            .await?;
            let head = integration.head_commit.ok_or_else(|| {
                crate::errors::invalid("workspace", "Task isolation requires a committed Git base")
            })?;
            if run_git(
                context["workspacePath"].as_str().unwrap_or(""),
                &[
                    "merge-base",
                    "--is-ancestor",
                    context["baseCommit"].as_str().unwrap_or(""),
                    &head,
                ],
                true,
            )
            .await
            .map_err(git_fail)?
            .exit_code
                != 0
            {
                return Err(crate::errors::invalid(
                    "workspace",
                    "The integration workspace rewrote its original ancestry",
                ));
            }
        } else {
            let expected = std::fs::canonicalize(root).map_err(|error| git_fail(error.into()))?;
            let actual = std::fs::canonicalize(cwd).map_err(|error| git_fail(error.into()))?;
            if actual != expected {
                return Err(crate::errors::invalid(
                    "workspace",
                    "A shared task workspace must be the original project directory",
                ));
            }
        }
        workspace.context = context;
        workspace.stage = "planned".into();
        Ok(workspace)
    }

    pub(super) async fn adopt_task_node(
        &self,
        root: &Workspace,
        saved: &Value,
        mut context: Value,
    ) -> CoreResult<Value> {
        let cwd = saved["workspacePath"].as_str().ok_or_else(|| {
            crate::errors::invalid("workspace", "The prior task directory is missing")
        })?;
        if saved["branchName"].is_string() && saved["baseCommit"].is_string() {
            let repository = repository_service::inspect(cwd).await.map_err(git_fail)?;
            context["workspaceMode"] = json!("git_isolated");
            context["workspacePath"] = json!(cwd);
            context["workspaceRoot"] = json!(repository.root_path);
            context["branchName"] = saved["branchName"].clone();
            context["baseCommit"] = saved["baseCommit"].clone();
            workflow_identity(cwd, &context, &root.project).await?;
            if run_git(
                cwd,
                &[
                    "merge-base",
                    "--is-ancestor",
                    context["baseCommit"].as_str().unwrap_or(""),
                    "HEAD",
                ],
                true,
            )
            .await
            .map_err(git_fail)?
            .exit_code
                != 0
            {
                return Err(crate::errors::invalid(
                    "workspace",
                    "The previous task rewrote its pinned Git ancestry",
                ));
            }
        } else {
            let integration = root.context["workspacePath"].as_str().unwrap_or("");
            if context["workspaceMode"] == "git_isolated"
                || std::fs::canonicalize(cwd).map_err(|error| git_fail(error.into()))?
                    != std::fs::canonicalize(integration).map_err(|error| git_fail(error.into()))?
            {
                return Err(crate::errors::invalid("workspace","The previous shared task has edits that need reconciliation before it can move to an isolated workspace"));
            }
            context["workspacePath"] = json!(cwd);
        }
        context["adoptedWorkspace"] = json!(true);
        Ok(context)
    }
}
