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

/// A workflow must also inspect commits created by its native Agent. Looking
/// only at `git status` would omit those changes from both path checks and merge.
/// This helper is used only in an isolated worktree owned by the workflow.
pub async fn collect_since(worktree_path: &str, base_commit: &str) -> anyhow::Result<Vec<Value>> {
    let top=run_git(worktree_path,&["rev-parse","--show-toplevel"],false).await?.stdout;
    let top=std::fs::canonicalize(top.trim())?;
    let cwd=std::fs::canonicalize(worktree_path)?;
    let prefix=cwd.strip_prefix(&top)?;
    let depth=prefix.components().count();
    let prefix=prefix.to_string_lossy().replace('\\',"/");
    let repository=top.to_string_lossy().into_owned();
    let untracked=run_git(&repository,&["ls-files","--others","--exclude-standard","-z"],false).await?;
    let paths:Vec<_>=untracked.stdout.split('\0').filter(|path|!path.is_empty()).collect();
    for paths in paths.chunks(100) {
        let mut args=vec!["add","-N","--"];args.extend(paths.iter().copied());
        run_git(&repository,&args,false).await?;
    }
    let status=run_git(&repository,&["diff","--no-renames","--name-status","-z",base_commit,"--"],false).await?;
    let fields:Vec<_>=status.stdout.split('\0').filter(|part|!part.is_empty()).collect();
    if fields.len()%2 != 0 { anyhow::bail!("Git returned an incomplete workflow change list"); }
    let mut files=vec![];
    for entry in fields.chunks(2) {
        let path=entry[1];
        let diff=run_git(&repository,&["diff","--no-ext-diff","--binary",base_commit,"--",path],false).await?;
        let stats=run_git(&repository,&["diff","--numstat",base_commit,"--",path],false).await?;
        let mut stats=stats.stdout.split_whitespace();
        let additions=stats.next().and_then(|value|value.parse::<i64>().ok()).unwrap_or(0);
        let deletions=stats.next().and_then(|value|value.parse::<i64>().ok()).unwrap_or(0);
        let relative=if prefix.is_empty(){path.to_owned()}else{path.strip_prefix(&format!("{prefix}/")).map(str::to_owned).unwrap_or_else(||format!("{}{path}","../".repeat(depth)))};
        files.push(json!({"path":relative,"changeType":change_type(entry[0]),"additions":additions,"deletions":deletions,"diff":diff.stdout}));
    }
    Ok(files)
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
