//! Merge queue — port of runtime/git/merge-queue.ts.

use serde_json::{json, Value};

use crate::runtime::git::git_command::run_git;

/// merged: Some((commit, previous_commit)) on success; None with conflicts.
pub struct MergeOutcome {
    pub merged: bool,
    pub commit: Option<String>,
    pub previous_commit: Option<String>,
    pub conflicts: Vec<Value>,
}

pub async fn merge_task(target_worktree: &str, source_branch: &str, target_branch: &str) -> anyhow::Result<MergeOutcome> {
    merge(target_worktree, source_branch, target_branch, "task_merge").await
}

pub async fn merge_final(repository_path: &str, source_branch: &str, target_branch: &str) -> anyhow::Result<MergeOutcome> {
    let status = run_git(repository_path, &["status", "--porcelain=v1"], false).await?;
    if !status.stdout.trim().is_empty() {
        return Ok(MergeOutcome {
            merged: false,
            commit: None,
            previous_commit: None,
            conflicts: status
                .stdout
                .lines()
                .filter(|line| !line.is_empty())
                .map(|line| {
                    json!({
                        "path": &line[3.min(line.len())..],
                        "operation": "final_merge",
                        "sourceBranch": source_branch,
                        "targetBranch": target_branch
                    })
                })
                .collect(),
        });
    }
    merge(repository_path, source_branch, target_branch, "final_merge").await
}

pub async fn rollback(target_path: &str, commit: &str) -> anyhow::Result<()> {
    run_git(target_path, &["reset", "--hard", commit], false).await?;
    Ok(())
}

async fn merge(target_path: &str, source_branch: &str, target_branch: &str, operation: &str) -> anyhow::Result<MergeOutcome> {
    let previous_commit = run_git(target_path, &["rev-parse", "HEAD"], false).await?.stdout.trim().to_string();
    let result = run_git(
        target_path,
        &["-c", "user.name=Nautilo", "-c", "user.email=agenthub@local", "merge", "--no-ff", "--no-edit", source_branch],
        true,
    )
    .await?;
    if result.exit_code == 0 {
        let commit = run_git(target_path, &["rev-parse", "HEAD"], false).await?.stdout.trim().to_string();
        return Ok(MergeOutcome { merged: true, commit: Some(commit), previous_commit: Some(previous_commit), conflicts: vec![] });
    }
    let conflicts = run_git(target_path, &["diff", "--name-only", "--diff-filter=U"], true)
        .await?
        .stdout
        .lines()
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();
    let _ = run_git(target_path, &["merge", "--abort"], true).await;
    let conflicts = if conflicts.is_empty() { vec!["unknown".to_string()] } else { conflicts };
    Ok(MergeOutcome {
        merged: false,
        commit: None,
        previous_commit: None,
        conflicts: conflicts
            .into_iter()
            .map(|path| json!({ "path": path, "operation": operation, "sourceBranch": source_branch, "targetBranch": target_branch }))
            .collect(),
    })
}
