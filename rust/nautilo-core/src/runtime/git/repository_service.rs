//! Git repository inspection — port of runtime/git/repository-service.ts.

use serde_json::Value;

use crate::runtime::git::git_command::run_git;

pub struct GitRepositoryState {
    pub root_path: String,
    pub branch: String,
    pub default_branch: String,
    /// None for an initialized repository without its first commit.
    pub head_commit: Option<String>,
    pub dirty_paths: Vec<String>,
}

pub async fn inspect(root_path: &str) -> anyhow::Result<GitRepositoryState> {
    let top = run_git(root_path, &["rev-parse", "--show-toplevel"], false).await?;
    let branch = run_git(root_path, &["branch", "--show-current"], false).await?.stdout.trim().to_string();
    let head = run_git(root_path, &["rev-parse", "--verify", "HEAD"], true).await?;
    let head_commit = if head.exit_code == 0 { Some(head.stdout.trim().to_string()) } else { None };
    let remote_head = run_git(root_path, &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], true).await?;
    let status = run_git(root_path, &["status", "--porcelain=v1"], false).await?;
    let default_branch = if remote_head.exit_code == 0 {
        remote_head.stdout.trim().trim_start_matches("origin/").to_string()
    } else {
        branch.clone()
    };
    Ok(GitRepositoryState {
        root_path: top.stdout.trim().to_string(),
        branch,
        default_branch,
        head_commit,
        dirty_paths: status.stdout.lines().filter(|line| !line.is_empty()).map(|line| normalize_status_path(&line[3.min(line.len())..])).collect(),
    })
}

fn normalize_status_path(value: &str) -> String {
    let target = value.split(" -> ").last().unwrap_or(value);
    target.trim_matches('"').replace('\\', "/")
}

/// JSON view for callers that pass the state around as data.
pub fn state_to_json(state: &GitRepositoryState) -> Value {
    serde_json::json!({
        "rootPath": state.root_path,
        "branch": state.branch,
        "defaultBranch": state.default_branch,
        "headCommit": state.head_commit,
        "dirtyPaths": state.dirty_paths
    })
}
