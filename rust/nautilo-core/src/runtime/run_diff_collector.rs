//! Per-run diff collection — port of runtime/run-diff-collector.ts.

use std::collections::HashMap;
use std::path::Path;

use serde_json::{json, Value};

use crate::runtime::git::git_command::run_git;
use crate::runtime::run_workspace_snapshot::WorkspaceSnapshot;

const MAX_FALLBACK_TEXT_BYTES: u64 = 1024 * 1024;

pub struct TouchedFile {
    pub path: String,
    pub change_type: String,
}

pub async fn is_git_workspace(cwd: &str) -> bool {
    let result = run_git(cwd, &["rev-parse", "--is-inside-work-tree"], true).await;
    matches!(result, Ok(output) if output.exit_code == 0 && output.stdout.trim() == "true")
}

/// Only an explicit Git diagnostic confirms a non-Git workspace; execution
/// errors and unrelated Git failures must not be reported as non-Git.
pub async fn is_non_git_workspace(cwd: &str) -> bool {
    match run_git(cwd, &["rev-parse", "--is-inside-work-tree"], true).await {
        Ok(result) => result.exit_code != 0 && result.stderr.to_lowercase().contains("not a git repository"),
        Err(_) => false,
    }
}

/// Collects displayable diffs for files reported by a provider during one run.
pub async fn collect(cwd: &str, touched: &[TouchedFile], baseline: Option<&WorkspaceSnapshot>) -> Vec<Value> {
    if touched.is_empty() {
        return vec![];
    }
    let root_result = run_git(cwd, &["rev-parse", "--show-toplevel"], true).await;
    match root_result {
        Ok(output) if output.exit_code == 0 => collect_git_diffs(output.stdout.trim(), cwd, touched).await,
        _ => collect_snapshot_diff(cwd, touched, baseline).await,
    }
}

async fn collect_git_diffs(root: &str, cwd: &str, touched: &[TouchedFile]) -> Vec<Value> {
    let normalized = unique_touched_files(root, cwd, touched);
    let mut files = vec![];
    for item in normalized {
        let status = run_git(
            root,
            &["status", "--porcelain=v1", "--untracked-files=all", "--", &item.path],
            true,
        )
        .await;
        let Ok(status) = status else { continue };
        let Some(line) = status.stdout.lines().find(|line| !line.is_empty()) else { continue };
        let code = &line[..line.len().min(2)];
        let change_type = status_change_type(code, &item.change_type);
        let untracked = code == "??";
        let absolute = Path::new(root).join(&item.path).to_string_lossy().into_owned();
        let (diff_args, numstat_args): (Vec<String>, Vec<String>) = if untracked {
            (
                vec!["diff".into(), "--no-index".into(), "--no-ext-diff".into(), "--binary".into(), "--".into(), "/dev/null".into(), absolute.clone()],
                vec!["diff".into(), "--no-index".into(), "--numstat".into(), "--".into(), "/dev/null".into(), absolute.clone()],
            )
        } else {
            (
                vec!["diff".into(), "--no-ext-diff".into(), "--binary".into(), "HEAD".into(), "--".into(), item.path.clone()],
                vec!["diff".into(), "--numstat".into(), "HEAD".into(), "--".into(), item.path.clone()],
            )
        };
        let diff_refs: Vec<&str> = diff_args.iter().map(String::as_str).collect();
        let numstat_refs: Vec<&str> = numstat_args.iter().map(String::as_str).collect();
        let diff = run_git(root, &diff_refs, true).await;
        let numstat = run_git(root, &numstat_refs, true).await;
        let (added, deleted) = numstat
            .map(|output| {
                let mut parts = output.stdout.trim().split_whitespace();
                let added = parts.next().and_then(|v| v.parse::<i64>().ok()).unwrap_or(0);
                let deleted = parts.next().and_then(|v| v.parse::<i64>().ok()).unwrap_or(0);
                (added, deleted)
            })
            .unwrap_or((0, 0));
        let diff_text = diff.map(|output| normalize_no_index_diff(&output.stdout, root)).unwrap_or_default();
        files.push(json!({
            "path": item.path,
            "changeType": change_type,
            "additions": added,
            "deletions": deleted,
            "diff": diff_text
        }));
    }
    files
}

async fn collect_snapshot_diff(cwd: &str, touched: &[TouchedFile], baseline: Option<&WorkspaceSnapshot>) -> Vec<Value> {
    // Missing baseline is unknown, not evidence that every file was added.
    // Provider-supplied patches still survive in file.changed events.
    if baseline.is_none() {
        return vec![];
    }
    let mut files = vec![];
    for item in unique_touched_files(cwd, cwd, touched) {
        let absolute = Path::new(cwd).join(&item.path);
        let snapshot = baseline.unwrap();
        let before = snapshot.files.get(&item.path).cloned();
        let before_unknown = before.is_none() && (!snapshot.traversal_complete || snapshot.unavailable_paths.contains(&item.path)
            || item.path.match_indices('/').any(|(index, _)| snapshot.unavailable_paths.contains(&item.path[..=index])));
        let metadata = std::fs::symlink_metadata(&absolute);
        let missing = metadata.as_ref().err().is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound);
        let after = metadata.ok().filter(|info| info.is_file() && info.len() <= MAX_FALLBACK_TEXT_BYTES)
            .and_then(|_| std::fs::read_to_string(&absolute).ok()).filter(|content| !content.contains('\0'));
        let after_unknown = !missing && after.is_none();
        if before_unknown || after_unknown {
            files.push(json!({ "path": item.path, "changeType": item.change_type, "additions": 0, "deletions": 0, "diff": "",
                "comparisonUnavailable": true, "reason": if before_unknown { "baseline_file_unavailable" } else { "current_file_unavailable" } }));
            continue;
        }
        if before.is_none() && after.is_none() {
            continue;
        }
        if before == after {
            continue;
        }
        let change_type = if before.is_none() {
            "added"
        } else if after.is_none() {
            "deleted"
        } else {
            item.change_type.as_str()
        };
        files.push(build_text_diff(&item.path, before.as_deref().unwrap_or(""), after.as_deref().unwrap_or(""), change_type));
    }
    files
}

fn unique_touched_files(root: &str, cwd: &str, touched: &[TouchedFile]) -> Vec<TouchedFile> {
    let mut by_path: HashMap<String, TouchedFile> = HashMap::new();
    for item in touched {
        let absolute = if Path::new(&item.path).is_absolute() {
            Path::new(&item.path).to_path_buf()
        } else {
            Path::new(cwd).join(&item.path)
        };
        let root_path = Path::new(root);
        let Ok(relative) = absolute.strip_prefix(root_path.canonicalize().unwrap_or_else(|_| root_path.to_path_buf())) else {
            // Fall back to a lexical strip when canonicalization fails.
            let relative = absolute
                .to_string_lossy()
                .replace('\\', "/")
                .trim_start_matches(&format!("{}/", root_path.to_string_lossy().replace('\\', "/")))
                .to_string();
            if relative.is_empty() || relative.starts_with("..") {
                continue;
            }
            by_path.insert(relative.clone(), TouchedFile { path: relative, change_type: item.change_type.clone() });
            continue;
        };
        let relative = relative.to_string_lossy().replace('\\', "/");
        if relative.is_empty() || relative.starts_with("..") {
            continue;
        }
        by_path.insert(relative.clone(), TouchedFile { path: relative, change_type: item.change_type.clone() });
    }
    by_path.into_values().collect()
}

fn status_change_type(code: &str, fallback: &str) -> String {
    if code.contains('R') {
        "renamed"
    } else if code.contains('D') {
        "deleted"
    } else if code == "??" || code.contains('A') {
        "added"
    } else if !code.trim().is_empty() {
        "modified"
    } else {
        fallback
    }
    .to_string()
}

fn normalize_no_index_diff(diff: &str, root: &str) -> String {
    let normalized_root = root.replace('\\', "/");
    diff.replace(&normalized_root, "")
}

fn build_text_diff(path: &str, before: &str, after: &str, change_type: &str) -> Value {
    let split = |content: &str| -> Vec<String> {
        if content.is_empty() {
            return vec![];
        }
        let mut lines: Vec<String> = content.replace("\r\n", "\n").split('\n').map(str::to_string).collect();
        if lines.last().is_some_and(|l| l.is_empty()) {
            lines.pop();
        }
        lines
    };
    let old_lines = split(before);
    let new_lines = split(after);
    let mut prefix = 0;
    while prefix < old_lines.len() && prefix < new_lines.len() && old_lines[prefix] == new_lines[prefix] {
        prefix += 1;
    }
    let mut suffix = 0;
    while suffix < old_lines.len() - prefix
        && suffix < new_lines.len() - prefix
        && old_lines[old_lines.len() - 1 - suffix] == new_lines[new_lines.len() - 1 - suffix]
    {
        suffix += 1;
    }
    let context_start = prefix.saturating_sub(3);
    let old_end = (old_lines.len() - suffix + 3).min(old_lines.len());
    let new_end = (new_lines.len() - suffix + 3).min(new_lines.len());
    let removed = &old_lines[prefix..old_lines.len() - suffix];
    let added = &new_lines[prefix..new_lines.len() - suffix];
    let mut lines: Vec<String> = vec![format!("diff --git a/{path} b/{path}")];
    match change_type {
        "added" => {
            lines.push("new file mode 100644".to_string());
            lines.push("--- /dev/null".to_string());
            lines.push(format!("+++ b/{path}"));
        }
        "deleted" => {
            lines.push("deleted file mode 100644".to_string());
            lines.push(format!("--- a/{path}"));
            lines.push("+++ /dev/null".to_string());
        }
        _ => {
            lines.push(format!("--- a/{path}"));
            lines.push(format!("+++ b/{path}"));
        }
    }
    lines.push(format!("@@ -{},{} +{},{} @@", context_start + 1, old_end - context_start, context_start + 1, new_end - context_start));
    for line in &old_lines[context_start..prefix] {
        lines.push(format!(" {line}"));
    }
    for line in removed {
        lines.push(format!("-{line}"));
    }
    for line in added {
        lines.push(format!("+{line}"));
    }
    for line in &new_lines[new_lines.len() - suffix..new_end] {
        lines.push(format!(" {line}"));
    }
    json!({
        "path": path,
        "changeType": change_type,
        "additions": added.len(),
        "deletions": removed.len(),
        "diff": lines.join("\n") + "\n"
    })
}
