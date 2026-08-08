//! Child-process plumbing for plugins: spawn with an event channel, overall/
//! idle/output limits, and tree-kill cancel. Mirrors the daemon's runtime so
//! plugin behavior matches the built-in adapters.

use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, ChildStdin};
use tokio::sync::{mpsc, watch};

#[derive(Debug, Clone)]
pub enum ProcessEvent {
    Stdout(String),
    Stderr(String),
    Exit { exit_code: Option<i32>, signal: Option<String> },
    Error(String),
    Timeout { reason: String },
}

#[derive(Debug, Default)]
pub struct ProcessRequest {
    pub command: String,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub env: Option<std::collections::HashMap<String, String>>,
    pub timeout_ms: Option<u64>,
    pub idle_timeout_ms: Option<u64>,
    pub max_output_bytes: Option<usize>,
    /// Append the process environment (default: env replaces it entirely).
    pub inherit_env: bool,
}

#[derive(Clone)]
pub struct ProcessHandle {
    pub pid: Option<u32>,
    exit_watch: watch::Receiver<bool>,
    kill_switch: mpsc::Sender<()>,
    stdin: Arc<tokio::sync::Mutex<Option<ChildStdin>>>,
    exit_code: Arc<Mutex<Option<i32>>>,
}

impl ProcessHandle {
    pub fn write(&self, input: &str) {
        let stdin = self.stdin.clone();
        let bytes = input.as_bytes().to_vec();
        tokio::spawn(async move {
            let mut guard = stdin.lock().await;
            if let Some(stdin) = guard.as_mut() {
                if stdin.write_all(&bytes).await.is_ok() {
                    let _ = stdin.flush().await;
                }
            }
        });
    }

    pub fn end_stdin(&self) {
        let stdin = self.stdin.clone();
        tokio::spawn(async move {
            let mut guard = stdin.lock().await;
            if let Some(mut stdin) = guard.take() {
                let _ = stdin.shutdown().await;
            }
        });
    }

    pub async fn cancel(&self) {
        let _ = self.kill_switch.send(()).await;
        let mut watch = self.exit_watch.clone();
        let _ = watch.wait_for(|done| *done).await;
    }

    pub async fn wait(&self) -> Option<i32> {
        let mut watch = self.exit_watch.clone();
        let _ = watch.wait_for(|done| *done).await;
        *self.exit_code.lock().unwrap()
    }
}

pub struct StartedProcess {
    pub handle: ProcessHandle,
    pub events: mpsc::UnboundedReceiver<ProcessEvent>,
}

pub fn start(request: &ProcessRequest) -> std::io::Result<StartedProcess> {
    let mut command = tokio::process::Command::new(&request.command);
    command.args(&request.args);
    if let Some(cwd) = &request.cwd {
        command.current_dir(cwd);
    }
    if request.inherit_env {
        if let Some(env) = &request.env {
            command.envs(env);
        }
    } else {
        command.env_clear();
        if let Some(env) = &request.env {
            command.envs(env);
        }
    }
    command.stdin(Stdio::piped());
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child: Child = command.spawn()?;
    let pid = child.id();
    let stdin = child.stdin.take();
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");

    let (sender, receiver) = mpsc::unbounded_channel::<ProcessEvent>();
    let (exit_sender, exit_watch) = watch::channel(false);
    let exit_code = Arc::new(Mutex::new(None::<i32>));
    let finished = Arc::new(Mutex::new(false));
    let output_bytes = Arc::new(Mutex::new(0usize));
    let idle_stamp = Arc::new(Mutex::new(Instant::now()));
    let (kill_switch, kill_rx) = mpsc::channel::<()>(4);

    for (reader, is_stdout) in [
        (Box::new(stdout) as Box<dyn AsyncRead + Unpin + Send>, true),
        (Box::new(stderr) as Box<dyn AsyncRead + Unpin + Send>, false),
    ] {
        let sender = sender.clone();
        let output_bytes = output_bytes.clone();
        let idle_stamp = idle_stamp.clone();
        let kill_switch = kill_switch.clone();
        let max_output = request.max_output_bytes;
        tokio::spawn(async move {
            let mut reader = reader;
            let mut buffer = [0u8; 8192];
            loop {
                match reader.read(&mut buffer).await {
                    Ok(0) => break,
                    Ok(count) => {
                        *idle_stamp.lock().unwrap() = Instant::now();
                        let exceeded = {
                            let mut total = output_bytes.lock().unwrap();
                            *total += count;
                            max_output.is_some_and(|max| *total > max)
                        };
                        if exceeded {
                            let _ = sender.send(ProcessEvent::Timeout { reason: "max_output".to_string() });
                            let _ = kill_switch.send(()).await;
                            break;
                        }
                        let text = String::from_utf8_lossy(&buffer[..count]).into_owned();
                        let event = if is_stdout { ProcessEvent::Stdout(text) } else { ProcessEvent::Stderr(text) };
                        if sender.send(event).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });
    }

    if let Some(timeout_ms) = request.timeout_ms {
        let sender = sender.clone();
        let kill_switch = kill_switch.clone();
        let finished = finished.clone();
        let mut exit_watch = exit_watch.clone();
        tokio::spawn(async move {
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_millis(timeout_ms)) => {
                    if *finished.lock().unwrap() {
                        return;
                    }
                    let _ = sender.send(ProcessEvent::Timeout { reason: "timeout".to_string() });
                    let _ = kill_switch.send(()).await;
                }
                changed = exit_watch.changed() => {
                    let _ = changed;
                }
            }
        });
    }
    if let Some(idle_ms) = request.idle_timeout_ms {
        let sender = sender.clone();
        let kill_switch = kill_switch.clone();
        let finished = finished.clone();
        let idle_stamp = idle_stamp.clone();
        let mut exit_watch = exit_watch.clone();
        tokio::spawn(async move {
            let interval = Duration::from_millis((idle_ms / 4).clamp(50, 5_000));
            loop {
                tokio::select! {
                    _ = tokio::time::sleep(interval) => {}
                    changed = exit_watch.changed() => {
                        let _ = changed;
                        return;
                    }
                }
                if *finished.lock().unwrap() {
                    return;
                }
                if idle_stamp.lock().unwrap().elapsed() >= Duration::from_millis(idle_ms) {
                    let _ = sender.send(ProcessEvent::Timeout { reason: "idle".to_string() });
                    let _ = kill_switch.send(()).await;
                    return;
                }
            }
        });
    }

    {
        let sender = sender.clone();
        let finished = finished.clone();
        let exit_code = exit_code.clone();
        let mut kill_rx = kill_rx;
        tokio::spawn(async move {
            let code;
            tokio::select! {
                status = child.wait() => {
                    code = status.ok().and_then(|s| s.code());
                }
                _ = kill_rx.recv() => {
                    #[cfg(windows)]
                    {
                        let killed = match pid {
                            Some(pid) => matches!(
                                tokio::process::Command::new("taskkill")
                                    .args(["/pid", &pid.to_string(), "/T", "/F"])
                                    .stdout(Stdio::null())
                                    .stderr(Stdio::null())
                                    .status()
                                    .await,
                                Ok(status) if status.success()
                            ),
                            None => false,
                        };
                        if !killed {
                            let _ = child.start_kill();
                        }
                    }
                    #[cfg(not(windows))]
                    {
                        let _ = child.start_kill();
                    }
                    code = child.wait().await.ok().and_then(|s| s.code());
                }
            }
            *finished.lock().unwrap() = true;
            *exit_code.lock().unwrap() = code;
            let _ = exit_sender.send(true);
            let _ = sender.send(ProcessEvent::Exit { exit_code: code, signal: None });
        });
    }

    let handle = ProcessHandle {
        pid,
        exit_watch,
        kill_switch,
        stdin: Arc::new(tokio::sync::Mutex::new(stdin)),
        exit_code,
    };
    Ok(StartedProcess { handle, events: receiver })
}
