//! Change collection — port of runtime/git/change-collector.ts.

use serde_json::{json, Value};

use crate::runtime::git::git_command::run_git;

pub async fn collect(worktree_path: &str) -> anyhow::Result<Vec<Value>> {
    let status = run_git(worktree_path, &["status", "--porcelain=v1"], false).await?;
    let entries: Vec<(String, String)> = status.stdout.lines().filter(|line| !line.is_empty()).map(parse_status).collect();
    let untracked: Vec<&str> = entries.iter().filter(|(code, _)| code == "??").map(|(_, path)| path.as_str()).collect();
    if !untracked.is_empty() {
        let mut args = vec!["add", "-N", "--"];
        args.extend(untracked);
        run_git(worktree_path, &args, false).await?;
    }
    let mut files = vec![];
    for (code, path) in entries {
        let diff = run_git(worktree_path, &["diff", "--no-ext-diff", "--binary", "HEAD", "--", &path], false).await?;
        let numstat = run_git(worktree_path, &["diff", "--numstat", "HEAD", "--", &path], false).await?;
        let mut parts = numstat.stdout.trim().split_whitespace();
        let added = parts.next().and_then(|v| v.parse::<i64>().ok()).unwrap_or(0);
        let deleted = parts.next().and_then(|v| v.parse::<i64>().ok()).unwrap_or(0);
        files.push(json!({
            "path": path,
            "changeType": change_type(&code),
            "additions": added,
            "deletions": deleted,
            "diff": diff.stdout
        }));
    }
    Ok(files)
}

pub async fn collect_commit_diff(worktree_path: &str, base_commit: &str, head_commit: &str) -> anyhow::Result<String> {
    Ok(run_git(worktree_path, &["diff", "--no-ext-diff", "--binary", base_commit, head_commit], false).await?.stdout)
}

fn parse_status(line: &str) -> (String, String) {
    let code = line[..2.min(line.len())].to_string();
    let raw = &line[3.min(line.len())..];
    let path = raw.split(" -> ").last().unwrap_or(raw).trim_matches('"').replace('\\', "/");
    (code, path)
}

fn change_type(code: &str) -> &'static str {
    if code.contains('R') {
        "renamed"
    } else if code.contains('D') {
        "deleted"
    } else if code == "??" || code.contains('A') {
        "added"
    } else {
        "modified"
    }
}
