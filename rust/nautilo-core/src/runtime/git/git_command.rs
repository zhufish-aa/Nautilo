//! Git command runner — port of runtime/git/git-command.ts.
//! Executes Git without a shell and with interactive prompts disabled.

use std::process::Stdio;

pub struct GitCommandResult {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
}

pub async fn run_git(cwd: &str, args: &[&str], allow_failure: bool) -> anyhow::Result<GitCommandResult> {
    run_git_limited(cwd, args, allow_failure, 20 * 1024 * 1024).await
}

pub async fn run_git_limited(
    cwd: &str,
    args: &[&str],
    allow_failure: bool,
    max_output_bytes: usize,
) -> anyhow::Result<GitCommandResult> {
    let mut command = tokio::process::Command::new("git");
    command.arg("--no-pager").arg("-C").arg(cwd).args(args);
    command.env("GIT_TERMINAL_PROMPT", "0");
    command.env("GCM_INTERACTIVE", "Never");
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());
    command.stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let output = command.output().await?;
    let stdout = String::from_utf8_lossy(&output.stdout[..output.stdout.len().min(max_output_bytes)]).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr[..output.stderr.len().min(max_output_bytes)]).into_owned();
    let result = GitCommandResult { exit_code: output.status.code().unwrap_or(-1), stdout, stderr };
    if result.exit_code != 0 && !allow_failure {
        let detail = if !result.stderr.trim().is_empty() {
            result.stderr.trim().to_string()
        } else if !result.stdout.trim().is_empty() {
            result.stdout.trim().to_string()
        } else {
            format!("git exited with {}", result.exit_code)
        };
        anyhow::bail!(detail);
    }
    Ok(result)
}
