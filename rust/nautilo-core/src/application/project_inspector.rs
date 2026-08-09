//! Project inspection — port of application/project-inspector.ts.

use std::path::Path;
use std::process::Command;

use serde_json::{json, Map, Value};

use crate::errors::now_iso;

/// Port of application/project-inspector.ts.
pub fn inspect_project(project: &Value) -> Value {
    let project_id = project.get("id").and_then(Value::as_str).unwrap_or("");
    let root_path = project.get("rootPath").and_then(Value::as_str).unwrap_or("");
    let root = Path::new(root_path);
    let git = inspect_git(root);
    let mut stacks: Vec<Value> = vec![];
    if root.join("tsconfig.json").exists() {
        stacks.push(json!({ "name": "TypeScript", "kind": "language", "confidence": 99 }));
    }
    if root.join("pnpm-workspace.yaml").exists() {
        stacks.push(json!({ "name": "pnpm workspace", "kind": "tooling", "confidence": 99 }));
    }
    if root.join("go.mod").exists() {
        stacks.push(json!({ "name": "Go", "kind": "language", "confidence": 99 }));
    }
    if root.join("Cargo.toml").exists() {
        stacks.push(json!({ "name": "Rust", "kind": "language", "confidence": 99 }));
    }
    if let Ok(raw) = std::fs::read_to_string(root.join("package.json")) {
        if let Ok(package) = serde_json::from_str::<Value>(&raw) {
            for (dependency, name, kind) in [
                ("react", "React", "framework"),
                ("vue", "Vue", "framework"),
                ("electron", "Electron", "runtime"),
                ("vite", "Vite", "tooling"),
            ] {
                let version = package
                    .get("dependencies")
                    .and_then(|d| d.get(dependency))
                    .or_else(|| package.get("devDependencies").and_then(|d| d.get(dependency)))
                    .and_then(Value::as_str);
                if let Some(version) = version {
                    stacks.push(json!({ "name": name, "kind": kind, "detail": version, "confidence": 98 }));
                }
            }
        }
    }
    let existing = |candidates: &[&str]| -> Vec<Value> {
        candidates.iter().filter(|candidate| root.join(candidate).exists()).map(|c| json!(c)).collect()
    };
    let frontend_paths = existing(&["apps/web", "apps/desktop/src/renderer", "src/components", "src/pages", "app"]);
    let backend_paths = existing(&["apps/api", "packages/core-daemon", "server", "api", "src/services"]);
    let risks = if root.exists() {
        json!([])
    } else {
        json!([{ "id": "path-missing", "level": "critical", "textKey": "risk.pathMissing", "detail": root_path }])
    };
    json!({
        "projectId": project_id,
        "scannedAt": now_iso(),
        "git": git,
        "stacks": stacks,
        "frontendPaths": frontend_paths,
        "backendPaths": backend_paths,
        "risks": risks,
    })
}

fn git(root: &Path, args: &[&str]) -> (bool, String) {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(root).args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW — a GUI shell must not flash a console per git probe.
        cmd.creation_flags(0x0800_0000);
    }
    let output = cmd.output();
    match output {
        Ok(out) if out.status.success() => (true, String::from_utf8_lossy(&out.stdout).trim().to_string()),
        Ok(out) => (false, String::from_utf8_lossy(&out.stdout).trim().to_string()),
        Err(_) => (false, String::new()),
    }
}

fn inspect_git(root: &Path) -> Value {
    if !root.exists() {
        return json!({ "isRepo": false, "dirtyFiles": 0 });
    }
    let (ok, _) = git(root, &["rev-parse", "--show-toplevel"]);
    if !ok {
        return json!({ "isRepo": false, "dirtyFiles": 0 });
    }
    let (_, status) = git(root, &["status", "--porcelain"]);
    let (_, branch) = git(root, &["branch", "--show-current"]);
    let (remote_ok, remote) = git(root, &["remote", "get-url", "origin"]);
    let (_, default_branch_raw) = git(root, &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
    let default_branch = default_branch_raw.trim_start_matches("origin/").to_string();
    let dirty_files = if status.is_empty() { 0 } else { status.lines().filter(|line| !line.is_empty()).count() };
    let mut result = Map::new();
    result.insert("isRepo".to_string(), json!(true));
    if !branch.is_empty() {
        result.insert("branch".to_string(), json!(branch.clone()));
    }
    let resolved_default = if !default_branch.is_empty() { default_branch } else { branch.clone() };
    if !resolved_default.is_empty() {
        result.insert("defaultBranch".to_string(), json!(resolved_default));
    }
    if remote_ok {
        result.insert("remote".to_string(), json!(remote));
    }
    result.insert("dirtyFiles".to_string(), json!(dirty_files));
    Value::Object(result)
}
