//! Official CLI browser login. No auth output, credential files or tokens enter IPC.
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountLoginInput { profile_id: String, provider_id: String, executable: String, directory: String }
struct LoginJob { child: Option<Child>, directory: String, started: Instant, status: Value }
pub struct AccountLoginRegistry(Mutex<HashMap<String, LoginJob>>);
impl AccountLoginRegistry { pub fn new() -> Self { Self(Mutex::new(HashMap::new())) } }
impl Drop for AccountLoginRegistry {
    fn drop(&mut self) { if let Ok(jobs) = self.0.get_mut() { for job in jobs.values_mut() { if let Some(child) = job.child.as_mut() { let _ = child.kill(); let _ = child.wait(); } } } }
}
fn valid(input: &AccountLoginInput) -> bool {
    !input.profile_id.is_empty() && ["codex", "claude-code"].contains(&input.provider_id.as_str())
        && Path::new(&input.directory).is_absolute() && !input.executable.trim().is_empty()
        && !input.directory.chars().chain(input.executable.chars()).any(|c| c == '\0' || c == '\r' || c == '\n')
        && ![".cmd", ".bat", ".ps1"].iter().any(|ext| input.executable.to_lowercase().ends_with(ext))
}
fn refresh(job: &mut LoginJob) {
    if let Some(child) = job.child.as_mut() {
        if job.started.elapsed() >= Duration::from_secs(300) {
            let _ = child.kill(); let _ = child.wait();
            job.status = json!({ "state": "failed", "reason": "Login timed out after five minutes" }); job.child = None;
        } else { match child.try_wait() {
            Ok(Some(status)) => { job.status = if status.success() { json!({ "state": "succeeded" }) } else { json!({ "state": "failed", "reason": "Login did not finish. Use the official CLI in a terminal if interactive input is required." }) }; job.child = None; },
            Err(_) => { let _ = child.kill(); let _ = child.wait(); job.status = json!({ "state": "failed", "reason": "Could not check login process" }); job.child = None; },
            _ => {}
        } }
    }
}
#[tauri::command]
pub fn account_login_start(app: AppHandle, input: AccountLoginInput) -> Value {
    if !valid(&input) { return json!({ "ok": false, "reason": "Use an absolute directory and a native Codex or Claude executable. Shell shims are not supported for login." }); }
    let registry = app.state::<AccountLoginRegistry>();
    let Ok(mut jobs) = registry.0.lock() else { return json!({ "ok": false, "reason": "Login registry unavailable" }); };
    for job in jobs.values_mut() { refresh(job); }
    if jobs.get(&input.profile_id).is_some_and(|job| job.child.is_some()) { return json!({ "ok": false, "reason": "Login is already running" }); }
    let mut builder = std::fs::DirBuilder::new(); builder.recursive(true);
    #[cfg(unix)] { use std::os::unix::fs::DirBuilderExt; builder.mode(0o700); }
    if builder.create(&input.directory).is_err() { return json!({ "ok": false, "reason": "Cannot create account directory" }); }
    let Ok(directory) = std::fs::canonicalize(&input.directory) else { return json!({ "ok": false, "reason": "Cannot resolve account directory" }); };
    let directory_key = directory.to_string_lossy().to_string();
    if jobs.values().any(|job| job.child.is_some() && job.directory == directory_key) { return json!({ "ok": false, "reason": "This directory already has a login in progress" }); }
    let mut command = Command::new(&input.executable);
    command.env_clear();
    let allowed = ["PATH", "PATHEXT", "SystemRoot", "WINDIR", "ComSpec", "TEMP", "TMP", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "HOME", "TMPDIR", "SHELL", "LANG", "LC_ALL", "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"];
    for (key, value) in std::env::vars() { if allowed.iter().any(|name| key.eq_ignore_ascii_case(name)) { command.env(key, value); } }
    if input.provider_id == "codex" { command.args(["login"]).env("CODEX_HOME", &input.directory); }
    else { command.args(["auth", "login"]).env("CLAUDE_CONFIG_DIR", &input.directory).env("ANTHROPIC_CONFIG_DIR", Path::new(&input.directory).join("anthropic")); }
    command.current_dir(&directory).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)] { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
    match command.spawn() {
        Ok(child) => {
            let started = Instant::now();
            let profile_id = input.profile_id.clone();
            jobs.insert(input.profile_id, LoginJob { child: Some(child), directory: directory_key, started, status: json!({ "state": "running" }) });
            let app = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(300));
                let registry = app.state::<AccountLoginRegistry>();
                if let Ok(mut jobs) = registry.0.lock() { if let Some(job) = jobs.get_mut(&profile_id) { if job.started == started { refresh(job); } } };
            });
            json!({ "ok": true })
        },
        Err(_) => json!({ "ok": false, "reason": "Could not start native CLI. Check its executable path." })
    }
}
#[tauri::command]
pub fn account_login_status(app: AppHandle, profile_id: String) -> Value {
    let registry = app.state::<AccountLoginRegistry>();
    let Ok(mut jobs) = registry.0.lock() else { return json!({ "state": "failed", "reason": "Login registry unavailable" }); };
    if let Some(job) = jobs.get_mut(&profile_id) {
        let was_running = job.status["state"] == "running";
        refresh(job);
        let status = job.status.clone();
        drop(jobs);
        // Return to the app only on the CLI's success transition. Polling an
        // already completed login must not repeatedly steal window focus.
        if was_running && status["state"] == "succeeded" {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }
        status
    } else { json!({ "state": "idle" }) }
}
#[tauri::command]
pub fn account_login_cancel(app: AppHandle, profile_id: String) {
    let registry = app.state::<AccountLoginRegistry>();
    if let Ok(mut jobs) = registry.0.lock() { if let Some(job) = jobs.get_mut(&profile_id) { if let Some(child) = job.child.as_mut() { let _ = child.kill(); let _ = child.wait(); job.child = None; job.status = json!({ "state": "cancelled" }); } } };
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn only_supported_native_login_profiles() {
        let mut input = AccountLoginInput { profile_id: "a".into(), provider_id: "codex".into(), executable: "codex".into(), directory: std::env::temp_dir().to_string_lossy().to_string() };
        assert!(valid(&input)); input.executable = "codex.cmd".into(); assert!(!valid(&input));
        input.executable = "codex".into(); input.provider_id = "kimi".into(); assert!(!valid(&input));
    }
}
