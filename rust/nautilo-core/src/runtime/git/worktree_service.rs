//! Worktree management — port of runtime/git/worktree-service.ts.

use std::path::{Path, PathBuf};

use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::runtime::git::git_command::run_git;
use crate::runtime::git::repository_service;

pub struct WorktreeInfo {
    pub path: String,
    pub branch_name: String,
    pub base_commit: String,
}

pub struct WorktreeService {
    root: PathBuf,
}

impl WorktreeService {
    /// Workflow intents pin their base commit before creating a worktree. A
    /// restarted dispatcher can repeat this operation without choosing a new HEAD.
    pub async fn ensure_workflow_run(&self, project: &Value, run_id: &str, base: &str) -> anyhow::Result<WorktreeInfo> {
        let branch=format!("agenthub/run/{}",safe(run_id));
        let path=self.workflow_target(project["id"].as_str().unwrap_or(""),run_id,"main")?;
        self.ensure_pinned(project,&path,&branch,base).await
    }
    pub async fn ensure_workflow_task(&self, project: &Value, run_id: &str, task_id: &str, base: &str) -> anyhow::Result<WorktreeInfo> {
        let branch=format!("agenthub/task/{}/{}",safe(run_id),safe(task_id));
        let path=self.workflow_task_path(project["id"].as_str().unwrap_or(""),run_id,task_id)?;
        self.ensure_pinned(project,&path,&branch,base).await
    }
    /// Bound directory names independently of project IDs and nested app-data
    /// roots. Full identities remain in branches and durable workflow context.
    pub fn workflow_task_path(&self, project_id:&str, run_id:&str, task_id:&str)->anyhow::Result<PathBuf> {
        self.workflow_target(project_id,run_id,&format!("n-{}",&format!("{:x}",Sha256::digest(task_id.as_bytes()))[..24]))
    }
    fn workflow_target(&self,project_id:&str,run_id:&str,leaf:&str)->anyhow::Result<PathBuf> {
        let scope=format!("{:x}",Sha256::digest(format!("{project_id}\0{run_id}").as_bytes()));
        let target=self.root.join("workflow").join(&scope[..24]).join(leaf);
        if !target.starts_with(&self.root){anyhow::bail!("Workflow path escaped the configured root");}
        Ok(target)
    }
    async fn ensure_pinned(&self, project: &Value, target: &Path, branch: &str, base: &str) -> anyhow::Result<WorktreeInfo> {
        if base.len() < 40 || !base.chars().all(|value|value.is_ascii_hexdigit()) { anyhow::bail!("A pinned Git commit is required"); }
        let repository=project["rootPath"].as_str().ok_or_else(||anyhow::anyhow!("Project path missing"))?;
        let path=target.to_string_lossy().into_owned();
        self.add(repository,&path,branch,base).await?;
        let top=run_git(&path,&["rev-parse","--show-toplevel"],false).await?.stdout;
        if std::fs::canonicalize(top.trim())? != std::fs::canonicalize(target)? { anyhow::bail!("Workflow worktree root does not match its reserved directory"); }
        let actual_branch=run_git(&path,&["branch","--show-current"],false).await?.stdout;
        let head=run_git(&path,&["rev-parse","HEAD"],false).await?.stdout;
        let status=run_git(&path,&["status","--porcelain=v1"],false).await?.stdout;
        let common=|cwd:String|async move {
            let common=run_git(&cwd,&["rev-parse","--git-common-dir"],false).await?.stdout;
            let common=Path::new(common.trim());
            Ok::<_,anyhow::Error>(std::fs::canonicalize(if common.is_absolute(){common.to_path_buf()}else{Path::new(&cwd).join(common)})?)
        };
        if common(repository.into()).await? != common(path.clone()).await? || actual_branch.trim() != branch
            || head.trim() != base || !status.trim().is_empty()
        { anyhow::bail!("Reserved workflow worktree changed before execution was confirmed; retain it for inspection"); }
        Ok(WorktreeInfo {path,branch_name:branch.into(),base_commit:base.into()})
    }
    pub fn new(root_path: &str) -> Self {
        let root = std::fs::canonicalize(root_path).unwrap_or_else(|_| Path::new(root_path).to_path_buf());
        let _ = std::fs::create_dir_all(&root);
        Self { root }
    }

    pub async fn create_run(&self, project: &Value, project_run_id: &str) -> anyhow::Result<WorktreeInfo> {
        let root_path = project.get("rootPath").and_then(Value::as_str).unwrap_or("");
        let repository = repository_service::inspect(root_path).await?;
        let Some(head_commit) = repository.head_commit else {
            anyhow::bail!("Git repository {root_path} has no commit to use as a worktree base");
        };
        let branch_name = format!("agenthub/run/{}", safe(project_run_id));
        let path = self.target(project.get("id").and_then(Value::as_str).unwrap_or(""), project_run_id, "main")?.to_string_lossy().into_owned();
        self.add(root_path, &path, &branch_name, &head_commit).await?;
        Ok(WorktreeInfo { path, branch_name, base_commit: head_commit })
    }

    pub async fn create_task(&self, project: &Value, project_run: &Value, task: &Value) -> anyhow::Result<WorktreeInfo> {
        let branch = project_run.get("branchName").and_then(Value::as_str);
        let base = project_run.get("baseCommit").and_then(Value::as_str);
        let (Some(run_branch), Some(_)) = (branch, base) else {
            anyhow::bail!("Project run {} has no Git workspace", project_run.get("id").and_then(Value::as_str).unwrap_or(""));
        };
        let project_run_id = project_run.get("id").and_then(Value::as_str).unwrap_or("");
        let task_id = task.get("id").and_then(Value::as_str).unwrap_or("");
        let root_path = project.get("rootPath").and_then(Value::as_str).unwrap_or("");
        let branch_name = format!("agenthub/task/{}/{}", safe(project_run_id), safe(task_id));
        let path = self.target(project.get("id").and_then(Value::as_str).unwrap_or(""), project_run_id, &format!("task-{}", safe(task_id)))?.to_string_lossy().into_owned();
        let base_commit = run_git(root_path, &["rev-parse", run_branch], false).await?.stdout.trim().to_string();
        self.add(root_path, &path, &branch_name, run_branch).await?;
        Ok(WorktreeInfo { path, branch_name, base_commit })
    }

    pub async fn commit_all(&self, worktree_path: &str, message: &str) -> anyhow::Result<Option<String>> {
        run_git(worktree_path, &["add", "-A"], false).await?;
        let status = run_git(worktree_path, &["status", "--porcelain=v1"], false).await?;
        if status.stdout.trim().is_empty() {
            return Ok(None);
        }
        run_git(
            worktree_path,
            &["-c", "user.name=Nautilo", "-c", "user.email=agenthub@local", "commit", "-m", message],
            false,
        )
        .await?;
        Ok(Some(run_git(worktree_path, &["rev-parse", "HEAD"], false).await?.stdout.trim().to_string()))
    }

    async fn add(&self, repository_path: &str, target_path: &str, branch_name: &str, start_point: &str) -> anyhow::Result<()> {
        if Path::new(target_path).exists() {
            let current = run_git(target_path, &["rev-parse", "--is-inside-work-tree"], true).await?;
            if current.exit_code == 0 {
                return Ok(());
            }
            anyhow::bail!("Worktree target already exists and is not a Git worktree: {target_path}");
        }
        if let Some(parent) = Path::new(target_path).parent() {
            std::fs::create_dir_all(parent)?;
        }
        let branch = run_git(repository_path, &["show-ref", "--verify", &format!("refs/heads/{branch_name}")], true).await?;
        if branch.exit_code == 0 {
            run_git(repository_path, &["worktree", "add", target_path, branch_name], false).await?;
        } else {
            run_git(repository_path, &["worktree", "add", "-b", branch_name, target_path, start_point], false).await?;
        }
        Ok(())
    }

    fn target(&self, project_id: &str, project_run_id: &str, leaf: &str) -> anyhow::Result<PathBuf> {
        let target = self.root.join(safe(project_id)).join(safe(project_run_id)).join(leaf);
        if !target.starts_with(&self.root) {
            anyhow::bail!("Worktree path escaped the configured root");
        }
        Ok(target)
    }
}

fn safe(value: &str) -> String {
    value
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' { c } else { '-' })
        .collect::<String>()
        .chars()
        .take(64)
        .collect()
}
