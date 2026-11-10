//! Bounded Git I/O for the interactive source-control workspace.
use std::process::Stdio;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};

pub struct Output {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
    pub truncated: bool,
}
pub struct ByteOutput {
    pub code: i32,
    pub stdout: Vec<u8>,
    pub stderr: String,
    pub truncated: bool,
}
async fn collect(
    mut stream: impl AsyncRead + Unpin,
    limit: usize,
) -> std::io::Result<(Vec<u8>, bool)> {
    let mut result = Vec::new();
    let mut buffer = vec![0u8; 8192];
    let mut truncated = false;
    loop {
        let size = stream.read(&mut buffer).await?;
        if size == 0 {
            break;
        }
        let remaining = limit.saturating_sub(result.len());
        result.extend_from_slice(&buffer[..size.min(remaining)]);
        truncated |= size > remaining;
    }
    Ok((result, truncated))
}
pub async fn git(
    cwd: &str,
    args: &[&str],
    input: Option<&str>,
    limit: usize,
) -> anyhow::Result<Output> {
    let result = Box::pin(git_bytes(cwd, args, input, limit)).await?;
    let stdout = if result.truncated {
        String::from_utf8_lossy(&result.stdout).into_owned()
    } else {
        String::from_utf8(result.stdout)
            .map_err(|_| anyhow::anyhow!("Git 返回了无法识别的文件名或文本编码"))?
    };
    Ok(Output { code: result.code, stdout, stderr: result.stderr, truncated: result.truncated })
}
pub async fn git_bytes(
    cwd: &str,
    args: &[&str],
    input: Option<&str>,
    limit: usize,
) -> anyhow::Result<ByteOutput> {
    let mut command = tokio::process::Command::new("git");
    command
        .args([
            "--no-pager",
            "--literal-pathspecs",
            "-c",
            "core.quotepath=false",
            "-c",
            "color.ui=false",
            "-C",
            cwd,
        ])
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "Never")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        command.creation_flags(0x08000000);
    }
    let mut child = command.spawn()?;
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let stdin = child.stdin.take();
    let result = tokio::time::timeout(std::time::Duration::from_secs(120), async {
        let write = async {
            if let (Some(mut stream), Some(input)) = (stdin, input) {
                stream.write_all(input.as_bytes()).await?;
                stream.shutdown().await?;
            }
            Ok::<_, std::io::Error>(())
        };
        let (status, out, err, _) = tokio::try_join!(
            child.wait(),
            collect(stdout, limit),
            collect(stderr, 64 * 1024),
            write
        )?;
        Ok::<_, anyhow::Error>(ByteOutput {
            code: status.code().unwrap_or(-1),
            stdout: out.0,
            stderr: String::from_utf8_lossy(&err.0).into_owned(),
            truncated: out.1 || err.1,
        })
    })
    .await;
    match result {
        Ok(result) => result,
        Err(_) => {
            let _ = child.kill().await;
            anyhow::bail!("Git 操作超时，请检查仓库、凭据或钩子后重试。")
        }
    }
}
pub async fn checked(cwd: &str, args: &[&str], input: Option<&str>) -> anyhow::Result<String> {
    // Keep the bounded pipe readers out of every caller's async stack frame.
    let output = Box::pin(git(cwd, args, input, 4 * 1024 * 1024)).await?;
    if output.code != 0 {
        anyhow::bail!(
            "{}",
            if output.stderr.trim().is_empty() {
                output.stdout.trim()
            } else {
                output.stderr.trim()
            }
        );
    }
    if output.truncated {
        anyhow::bail!("Git 输出过大，请缩小操作范围后重试。");
    }
    Ok(output.stdout)
}
