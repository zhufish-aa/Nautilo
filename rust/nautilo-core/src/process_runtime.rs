//! Child-process runtime — port of process-runtime.ts.
//! Events flow over an unbounded channel; timeouts/idle/max-output are
//! enforced here exactly like the Node version.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, ChildStdin};
use tokio::sync::{mpsc, watch};

use crate::win_command::resolve_spawn_command;
use tokio::sync::Mutex as AsyncMutex;

#[derive(Debug, Clone)]
pub enum ProcessEvent {
    Stdout(String),
    Stderr(String),
    Exit { exit_code: Option<i32>, signal: Option<String> },
    Error(String),
    Timeout { reason: TimeoutReason },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TimeoutReason {
    Timeout,
    Idle,
    MaxOutput,
}

impl TimeoutReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Timeout => "timeout",
            Self::Idle => "idle",
            Self::MaxOutput => "max_output",
        }
    }
}

#[derive(Debug, Default)]
pub struct ProcessRequest {
    pub command: String,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    /// Exact child environment (the TS daemon passes a fully-built map).
    pub env: Option<HashMap<String, String>>,
    pub timeout_ms: Option<u64>,
    pub idle_timeout_ms: Option<u64>,
    pub max_output_bytes: Option<usize>,
}

struct SharedState {
    finished: bool,
    exit_code: Option<i32>,
}

#[derive(Clone)]
pub struct ProcessHandle {
    pub pid: Option<u32>,
    state: Arc<Mutex<SharedState>>,
    exit_watch: watch::Receiver<bool>,
    kill_switch: mpsc::Sender<()>,
    stdin: Arc<AsyncMutex<Option<ChildStdin>>>,
}

impl ProcessHandle {
    /// True while the child process is still running (false after a natural
    /// exit or a kill). Lets a reused app-server connection detect that its
    /// backing process died before handing it to the next turn.
    pub fn is_alive(&self) -> bool {
        !*self.exit_watch.borrow()
    }

    /// Node's child.stdin.write(); delivery is best-effort and asynchronous.
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

    /// Node's child.stdin.end(), optionally writing a final chunk first.
    pub fn end_stdin(&self, final_input: Option<String>) {
        let stdin = self.stdin.clone();
        tokio::spawn(async move {
            let mut guard = stdin.lock().await;
            if let Some(mut stdin) = guard.take() {
                if let Some(input) = final_input {
                    let _ = stdin.write_all(input.as_bytes()).await;
                }
                let _ = stdin.shutdown().await;
            }
        });
    }

    pub async fn cancel(&self) {
        let _ = self.kill_switch.send(()).await;
        let mut watch = self.exit_watch.clone();
        let _ = watch.wait_for(|finished| *finished).await;
    }

    pub async fn wait(&self) -> (Option<i32>, Option<String>) {
        let mut watch = self.exit_watch.clone();
        let _ = watch.wait_for(|finished| *finished).await;
        let code = self.state.lock().unwrap().exit_code;
        (code, None)
    }
}

pub struct StartedProcess {
    pub handle: ProcessHandle,
    pub events: mpsc::UnboundedReceiver<ProcessEvent>,
}

pub struct ProcessRuntime;

impl ProcessRuntime {
    pub fn start(request: &ProcessRequest) -> std::io::Result<StartedProcess> {
        let resolved = resolve_spawn_command(&request.command, &request.args, request.env.as_ref());
        let mut command = tokio::process::Command::new(&resolved.command);
        if resolved.verbatim {
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                // cmd /s /c strips exactly one outer quote pair; the wrapped
                // line must reach cmd untouched, so it goes as a raw arg.
                command.args(["/d", "/s", "/c"]);
                command.raw_arg(resolved.args.last().cloned().unwrap_or_default());
            }
            #[cfg(not(windows))]
            {
                command.args(&resolved.args);
            }
        } else {
            command.args(&resolved.args);
        }
        if let Some(cwd) = &request.cwd {
            command.current_dir(cwd);
        }
        // The TS runtime passes `env: request.env ?? {}` — never inherited.
        // Callers that pass NO env (detection probes) get the default
        // allowlist environment: a completely empty environment leaves
        // cmd.exe unable to execute .cmd shims, so every npm-installed CLI
        // would probe as "not installed".
        command.env_clear();
        match &request.env {
            Some(env) => command.envs(env),
            None => command.envs(crate::runtime::security::environment_policy::build_environment(None, Default::default())),
        };
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
        let state = Arc::new(Mutex::new(SharedState { finished: false, exit_code: None }));
        let output_bytes = Arc::new(Mutex::new(0usize));
        let idle_stamp = Arc::new(Mutex::new(Instant::now()));
        let (kill_switch, kill_rx) = mpsc::channel::<()>(4);

        let mark_finished = |state: &Arc<Mutex<SharedState>>, code: Option<i32>| {
            let mut guard = state.lock().unwrap();
            guard.finished = true;
            guard.exit_code = code;
            let _ = exit_sender.send(true);
        };

        // stdout / stderr pumps
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
                                let _ = sender.send(ProcessEvent::Timeout { reason: TimeoutReason::MaxOutput });
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

        // overall timeout; the sender clone must drop on process exit, or the
        // event stream would stay open until the full timeout elapses.
        if let Some(timeout_ms) = request.timeout_ms {
            let sender = sender.clone();
            let kill_switch = kill_switch.clone();
            let state = state.clone();
            let mut exit_watch = exit_watch.clone();
            tokio::spawn(async move {
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_millis(timeout_ms)) => {
                        if state.lock().unwrap().finished {
                            return;
                        }
                        let _ = sender.send(ProcessEvent::Timeout { reason: TimeoutReason::Timeout });
                        let _ = kill_switch.send(()).await;
                    }
                    changed = exit_watch.changed() => {
                        let _ = changed;
                    }
                }
            });
        }

        // idle timeout, polled against the last-output stamp
        if let Some(idle_ms) = request.idle_timeout_ms {
            let sender = sender.clone();
            let kill_switch = kill_switch.clone();
            let state = state.clone();
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
                    if state.lock().unwrap().finished {
                        return;
                    }
                    if idle_stamp.lock().unwrap().elapsed() >= Duration::from_millis(idle_ms) {
                        let _ = sender.send(ProcessEvent::Timeout { reason: TimeoutReason::Idle });
                        let _ = kill_switch.send(()).await;
                        return;
                    }
                }
            });
        }

        // reaper: owns the child, resolves natural exits and kill requests
        {
            let state = state.clone();
            let sender = sender.clone();
            let mut kill_rx = kill_rx;
            tokio::spawn(async move {
                let exit_code;
                tokio::select! {
                    status = child.wait() => {
                        exit_code = status.ok().and_then(|s| s.code());
                    }
                    _ = kill_rx.recv() => {
                        if state.lock().unwrap().finished {
                            exit_code = None;
                        } else {
                            state.lock().unwrap().finished = true;
                            #[cfg(windows)]
                            {
                                // Kill the whole tree; fall back to a direct kill
                                // when taskkill is denied (see the TS comment).
                                let killed = match pid {
                                    Some(pid) => {
                                        #[cfg(windows)]
                                        {
                                            use std::os::windows::process::CommandExt;
                                            let mut kill = tokio::process::Command::new("taskkill");
                                            kill.args(["/pid", &pid.to_string(), "/T", "/F"])
                                                .stdout(Stdio::null())
                                                .stderr(Stdio::null())
                                                // CREATE_NO_WINDOW — no console flash when killing.
                                                .creation_flags(0x0800_0000);
                                            matches!(kill.status().await, Ok(status) if status.success())
                                        }
                                        #[cfg(not(windows))]
                                        {
                                            matches!(
                                                tokio::process::Command::new("kill")
                                                    .args(["-9", &pid.to_string()])
                                                    .stdout(Stdio::null())
                                                    .stderr(Stdio::null())
                                                    .status()
                                                    .await,
                                                Ok(status) if status.success()
                                            )
                                        }
                                    }
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
                            exit_code = child.wait().await.ok().and_then(|s| s.code());
                        }
                    }
                }
                {
                    let mut guard = state.lock().unwrap();
                    guard.finished = true;
                    guard.exit_code = exit_code;
                }
                let _ = exit_sender.send(true);
                let _ = sender.send(ProcessEvent::Exit { exit_code, signal: None });
                // Dropping the sender closes the event stream for consumers.
            });
        }

        let handle = ProcessHandle { pid, state, exit_watch, kill_switch, stdin: Arc::new(AsyncMutex::new(stdin)) };
        Ok(StartedProcess { handle, events: receiver })
    }
}
