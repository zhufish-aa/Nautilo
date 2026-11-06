//! Child-process plumbing for plugins: spawn with an event channel, overall/
//! idle/output limits, and tree-kill cancel. Mirrors the daemon's runtime so
//! plugin behavior matches the built-in adapters.

use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::Child;
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
    stdin: mpsc::UnboundedSender<StdinCommand>,
    exit_code: Arc<Mutex<Option<i32>>>,
}

/// Ordered stdin instructions for the single writer task. write() used to
/// spawn one task per call; tasks raced the stdin lock, so a close could win
/// over a pending write and silently drop it (Pi model discovery died this
/// way), and two writes could arrive out of order.
enum StdinCommand {
    Write(Vec<u8>),
    Close,
}

impl ProcessHandle {
    pub fn is_alive(&self) -> bool { !*self.exit_watch.borrow() }
    pub fn write(&self, input: &str) {
        let _ = self.stdin.send(StdinCommand::Write(input.as_bytes().to_vec()));
    }

    pub fn end_stdin(&self) {
        let _ = self.stdin.send(StdinCommand::Close);
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
    pub events: crate::event_stream::ProcessEvents,
}

// ---------------------------------------------------------------- win-command
// Mirrors the daemon's win_command.rs: Windows cannot spawn .cmd/.bat shims
// directly, so they are wrapped in `cmd.exe /d /s /c "<line>"` (verbatim).

struct ResolvedSpawnCommand {
    command: String,
    args: Vec<String>,
    verbatim: bool,
}

fn resolve_spawn_command(
    command: &str,
    args: &[String],
    env: Option<&std::collections::HashMap<String, String>>,
) -> ResolvedSpawnCommand {
    if !cfg!(windows) {
        return ResolvedSpawnCommand { command: command.to_string(), args: args.to_vec(), verbatim: false };
    }
    let path_env = env_value(env, "PATH").unwrap_or_default();
    let pathext_env = env_value(env, "PATHEXT");
    let Some(resolved) = find_on_path(command, &path_env, pathext_env.as_deref()) else {
        return ResolvedSpawnCommand { command: command.to_string(), args: args.to_vec(), verbatim: false };
    };
    if !resolved.to_lowercase().ends_with(".cmd") && !resolved.to_lowercase().ends_with(".bat") {
        return ResolvedSpawnCommand { command: resolved, args: args.to_vec(), verbatim: false };
    }
    let line = format!(
        "\"{}\"",
        std::iter::once(quote_cmd_arg(&resolved))
            .chain(args.iter().map(|arg| quote_cmd_arg(arg)))
            .collect::<Vec<_>>()
            .join(" ")
    );
    ResolvedSpawnCommand { command: "cmd.exe".to_string(), args: vec![line], verbatim: true }
}

/// Case-insensitive env lookup: Windows typically spells it "Path".
fn env_value(env: Option<&std::collections::HashMap<String, String>>, key: &str) -> Option<String> {
    if let Some(value) = env.and_then(|values|values.get(key)) { return Some(value.clone()); }
    let merged_process: std::collections::HashMap<String, String> = std::env::vars().collect();
    for (name, value) in env.into_iter().flatten().chain(merged_process.iter()) {
        if name.eq_ignore_ascii_case(key) {
            return Some(value.clone());
        }
    }
    None
}

fn find_on_path(command: &str, path_env: &str, pathext_env: Option<&str>) -> Option<String> {
    let has_directory = command.contains(['/', '\\']) || command.len() >= 2 && command.as_bytes()[1] == b':';
    let extensions: Vec<String> = if has_directory {
        vec![String::new()]
    } else {
        pathext_env
            .unwrap_or(".COM;.EXE;.BAT;.CMD")
            .split(';')
            .filter(|ext| !ext.is_empty())
            .map(str::to_string)
            .chain(std::iter::once(String::new()))
            .collect()
    };
    let directories: Vec<String> = if has_directory {
        vec![String::new()]
    } else {
        path_env.split(';').filter(|dir| !dir.is_empty()).map(str::to_string).collect()
    };
    for dir in &directories {
        for extension in &extensions {
            let candidate = if dir.is_empty() {
                format!("{command}{extension}")
            } else {
                format!("{dir}\\{command}{extension}")
            };
            if std::fs::metadata(&candidate).is_ok_and(|meta| meta.is_file()) {
                return Some(candidate);
            }
        }
    }
    None
}

fn quote_cmd_arg(value: &str) -> String {
    if !value.is_empty() && !value.chars().any(|c| " \"&|<>^()%!".contains(c)) {
        return value.to_string();
    }
    format!("\"{}\"", value.replace('"', "\"\""))
}

pub fn start(request: &ProcessRequest) -> std::io::Result<StartedProcess> {
    let resolved = resolve_spawn_command(&request.command, &request.args, request.env.as_ref());
    let mut command = tokio::process::Command::new(&resolved.command);
    if resolved.verbatim {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // cmd /s /c strips exactly one outer quote pair; the wrapped line
            // must reach cmd untouched, so it goes as a raw arg.
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
        if !std::path::Path::new(cwd).is_dir() {
            return Err(std::io::Error::new(std::io::ErrorKind::NotFound, format!("工作目录不存在或不可访问：{cwd}")));
        }
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
    let mut child: Child = command.spawn().map_err(|error| std::io::Error::new(error.kind(),
        format!("无法启动 {}（工作目录：{}）：{error}", request.command, request.cwd.as_deref().unwrap_or("默认"))))?;
    let pid = child.id();
    let stdin = child.stdin.take();
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");

    // One writer task owns stdin; callers enqueue ordered commands.
    let (stdin_sender, mut stdin_receiver) = mpsc::unbounded_channel::<StdinCommand>();
    tokio::spawn(async move {
        let mut stdin = stdin;
        while let Some(command) = stdin_receiver.recv().await {
            let Some(stdin) = stdin.as_mut() else { break };
            match command {
                StdinCommand::Write(bytes) => {
                    if stdin.write_all(&bytes).await.is_err() {
                        break;
                    }
                    let _ = stdin.flush().await;
                }
                StdinCommand::Close => {
                    let _ = stdin.shutdown().await;
                    break;
                }
            }
        }
    });

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
        stdin: stdin_sender,
        exit_code,
    };
    Ok(StartedProcess { handle, events: crate::event_stream::ProcessEvents::new(receiver) })
}
