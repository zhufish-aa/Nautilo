//! Core Daemon lifecycle + authenticated named-pipe request channel.
//! Mirrors apps/desktop/src/main/core-daemon-client.ts.

use serde::de::DeserializeOwned;
use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

#[derive(Debug, Deserialize)]
struct ReadyMessage {
    status: String,
    #[serde(rename = "socketPath")]
    socket_path: Option<String>,
}

/// Owns the daemon child process and the connection parameters.
pub struct CoreDaemonClient {
    inner: Mutex<CoreDaemonState>,
}

struct CoreDaemonState {
    process: Option<Child>,
    socket_path: Option<String>,
    token_path: Option<PathBuf>,
}

impl CoreDaemonClient {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(CoreDaemonState {
                process: None,
                socket_path: None,
                token_path: None,
            }),
        }
    }

    pub fn start(&self, data_dir: &Path) -> Result<(), String> {
        let mut state = self.inner.lock().map_err(|e| e.to_string())?;
        if state.process.is_some() {
            return Ok(());
        }
        let daemon_exe = resolve_daemon_exe()?;
        // A development shell and a portable build can run at the same time.
        // Each shell process therefore needs its own Windows named pipe.
        let socket_path = format!(r"\\.\pipe\agenthub-core-{}", std::process::id());
        let token_path = data_dir.join("core.token");
        let mut child = Command::new(&daemon_exe);
        child
            .arg("--serve")
            .current_dir(data_dir)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env("AGENTHUB_DATA_DIR", data_dir)
            .env("AGENTHUB_SOCKET", &socket_path)
            .env("AGENTHUB_TOKEN_PATH", &token_path);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            child.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = child.spawn().map_err(|e| format!("Failed to spawn Core Daemon: {e}"))?;

        let stdout = child.stdout.take().ok_or("Core Daemon stdout unavailable")?;
        let stderr = child.stderr.take();
        // Keep the last few stderr lines so a readiness failure can say WHY.
        let stderr_tail = std::sync::Arc::new(Mutex::new(std::collections::VecDeque::<String>::new()));
        if let Some(stderr) = stderr {
            let tail = std::sync::Arc::clone(&stderr_tail);
            std::thread::spawn(move || {
                use std::io::Read;
                let mut reader = std::io::BufReader::new(stderr);
                let mut buffer = Vec::new();
                let mut chunk = [0u8; 4096];
                loop {
                    match reader.read(&mut chunk) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            buffer.extend_from_slice(&chunk[..n]);
                            while let Some(pos) = buffer.iter().position(|b| *b == b'\n') {
                                let line: Vec<u8> = buffer.drain(..=pos).collect();
                                let text = String::from_utf8_lossy(&line).trim_end().to_string();
                                eprintln!("[core-daemon] {text}");
                                if let Ok(mut tail) = tail.lock() {
                                    if tail.len() >= 50 {
                                        tail.pop_front();
                                    }
                                    tail.push_back(text);
                                }
                            }
                        }
                    }
                }
            });
        }
        let ready = wait_for_ready(stdout, &mut child, &stderr_tail)?;
        state.socket_path = Some(ready.socket_path.unwrap_or(socket_path));
        state.token_path = Some(token_path);
        state.process = Some(child);
        Ok(())
    }

    fn connection_params(&self) -> Result<(String, PathBuf), String> {
        let state = self.inner.lock().map_err(|e| e.to_string())?;
        match (&state.socket_path, &state.token_path) {
            (Some(socket), Some(token)) => Ok((socket.clone(), token.clone())),
            _ => Err("Core Daemon is not ready".to_string()),
        }
    }

    /// One authenticated request/response round trip, matching the Electron
    /// client's line protocol: token line, ok line, request line, response line.
    pub async fn request(&self, request: serde_json::Value) -> Result<serde_json::Value, String> {
        let (socket_path, token_path) = self.connection_params()?;
        let token = std::fs::read_to_string(&token_path)
            .map_err(|_| "Core Daemon authentication token is missing".to_string())?
            .trim()
            .to_string();

        // The daemon accepts one pipe instance at a time; a client that
        // connects in the gap gets ERROR_PIPE_BUSY (os error 231) and must
        // wait for the next instance — Node's net.connect did this wait
        // internally, so the shell has to retry explicitly.
        // The daemon pre-creates a small pool of pipe instances, but a client
        // can still hit ERROR_PIPE_BUSY (os error 231) while the daemon is
        // busy (e.g. loading a large database on startup, or handling a burst
        // of IPC requests). Node's net.connect waited internally, so the shell
        // has to retry explicitly. Keep the window generous (up to ~20s) so a
        // busy daemon doesn't surface a spurious "connect failed" error.
        let mut stream = None;
        for attempt in 0..400 {
            match tokio::net::windows::named_pipe::ClientOptions::new().open(&socket_path) {
                Ok(pipe) => {
                    stream = Some(pipe);
                    break;
                }
                Err(error) if error.raw_os_error() == Some(231) && attempt < 399 => {
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
                Err(error) => return Err(format!("Core Daemon connect failed: {error}")),
            }
        }
        let mut stream = stream.ok_or("Core Daemon connect failed: pipe busy")?;
        let (reader, mut writer) = tokio::io::split(&mut stream);
        let mut lines = BufReader::new(reader).lines();

        writer
            .write_all(format!("{}\n", serde_json::json!({ "token": token })).as_bytes())
            .await
            .map_err(|e| e.to_string())?;
        let authenticated = read_json_line(&mut lines).await?;
        if !authenticated.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
            return Err("Core Daemon authentication failed".to_string());
        }

        writer
            .write_all(format!("{}\n", serde_json::json!({ "request": request })).as_bytes())
            .await
            .map_err(|e| e.to_string())?;
        let response = read_json_line(&mut lines).await?;
        if !response.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
            let error = response.get("error");
            let reason = error
                .and_then(|e| e.get("details"))
                .and_then(|d| d.get("reason"))
                .and_then(|r| r.as_str());
            let message = reason
                .map(|r| r.to_string())
                .or_else(|| {
                    error
                        .and_then(|e| e.get("message"))
                        .and_then(|m| m.as_str())
                        .map(|m| m.to_string())
                })
                .unwrap_or_else(|| "Core Daemon request failed".to_string());
            return Err(message);
        }
        Ok(response.get("data").cloned().unwrap_or(serde_json::Value::Null))
    }

    pub async fn request_typed<T: DeserializeOwned>(&self, method: &str, input: Option<serde_json::Value>) -> Result<T, String> {
        let mut request = serde_json::json!({ "method": method });
        if let Some(input) = input {
            request["input"] = input;
        }
        let data = self.request(request).await?;
        serde_json::from_value(data).map_err(|e| format!("Core Daemon response decode failed: {e}"))
    }

    pub fn stop(&self) {
        let mut state = match self.inner.lock() {
            Ok(state) => state,
            Err(_) => return,
        };
        state.socket_path = None;
        if let Some(mut child) = state.process.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn resolve_daemon_exe() -> Result<PathBuf, String> {
    if let Ok(path) = std::env::var("AGENTHUB_CORE_PATH") {
        let candidate = PathBuf::from(path);
        if candidate.exists() {
            return Ok(candidate);
        }
    }
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
        .unwrap_or_default();
    let candidates = [
        // Development layout: apps/desktop/src-tauri/target/debug/nautilo.exe
        // -> repository rust workspace build output.
        exe_dir.join("../../../../../rust/target/x86_64-pc-windows-gnu/debug/nautilo-core.exe"),
        exe_dir.join("../../../../../rust/target/x86_64-pc-windows-gnu/release/nautilo-core.exe"),
        // Packaged layout: daemon ships next to the shell binary.
        exe_dir.join("nautilo-core.exe"),
        exe_dir.join("core-daemon").join("nautilo-core.exe"),
    ];
    for candidate in &candidates {
        if candidate.exists() {
            return Ok(candidate.clone());
        }
    }
    Err(format!(
        "Core Daemon executable was not found: {}",
        candidates
            .iter()
            .map(|c| c.to_string_lossy().to_string())
            .collect::<Vec<_>>()
            .join(", ")
    ))
}

fn wait_for_ready(
    stdout: impl std::io::Read + Send + 'static,
    child: &mut Child,
    stderr_tail: &std::sync::Arc<Mutex<std::collections::VecDeque<String>>>,
) -> Result<ReadyMessage, String> {
    use std::io::Read;
    let (tx, rx) = std::sync::mpsc::channel::<ReadyMessage>();
    std::thread::spawn(move || {
        let mut reader = std::io::BufReader::new(stdout);
        let mut buffer = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            match reader.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    buffer.extend_from_slice(&chunk[..n]);
                    while let Some(pos) = buffer.iter().position(|b| *b == b'\n') {
                        let line: Vec<u8> = buffer.drain(..=pos).collect();
                        let text = String::from_utf8_lossy(&line);
                        let text = text.trim();
                        if text.is_empty() {
                            continue;
                        }
                        if let Ok(message) = serde_json::from_str::<ReadyMessage>(text) {
                            if message.status == "ok" {
                                let _ = tx.send(message);
                                // Keep draining so the child never blocks on a full pipe.
                                break;
                            }
                        }
                    }
                }
            }
        }
    });
    let deadline = std::time::Instant::now() + Duration::from_secs(60);
    loop {
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(message) => return Ok(message),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                if let Ok(Some(status)) = child.try_wait() {
                    return Err(format!("Core Daemon exited with {status}{}", stderr_context(stderr_tail)));
                }
                if std::time::Instant::now() > deadline {
                    return Err(format!("Core Daemon did not become ready{}", stderr_context(stderr_tail)));
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                return Err(format!("Core Daemon did not become ready{}", stderr_context(stderr_tail)));
            }
        }
    }
}

fn stderr_context(tail: &std::sync::Arc<Mutex<std::collections::VecDeque<String>>>) -> String {
    let lines: Vec<String> = tail.lock().map(|t| t.iter().cloned().collect()).unwrap_or_default();
    if lines.is_empty() {
        String::new()
    } else {
        format!("; daemon stderr: {}", lines.join(" | "))
    }
}

async fn read_json_line<T: tokio::io::AsyncRead + Unpin>(
    lines: &mut tokio::io::Lines<BufReader<tokio::io::ReadHalf<T>>>,
) -> Result<serde_json::Value, String> {
    loop {
        let line = lines
            .next_line()
            .await
            .map_err(|e| e.to_string())?
            .ok_or("Core Daemon closed the connection")?;
        if line.trim().is_empty() {
            continue;
        }
        return serde_json::from_str(&line).map_err(|e| format!("Core Daemon sent invalid JSON: {e}"));
    }
}
