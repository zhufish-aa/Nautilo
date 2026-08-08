//! Runs a provider CLI's self-update command (`claude update`, `codex
//! update`, ...) and streams its output back to the requesting window.
//! Mirrors apps/desktop/src/main/provider-updates.ts.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::Read;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderUpdateStartPayload {
    pub update_id: String,
    pub executable: String,
    pub args: Vec<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct UpdateOutputEvent {
    update_id: String,
    chunk: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct UpdateExitEvent {
    update_id: String,
    exit_code: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

/// Drop output past this cap so a chatty updater cannot grow renderer state unbounded.
const MAX_OUTPUT_BYTES: usize = 256 * 1024;

pub struct ProviderUpdateRegistry {
    active: Mutex<HashMap<String, Child>>,
}

impl ProviderUpdateRegistry {
    pub fn new() -> Self {
        Self {
            active: Mutex::new(HashMap::new()),
        }
    }
}

fn spawn_update(executable: &str, args: &[String]) -> std::io::Result<Child> {
    let mut command = if cfg!(windows) {
        // Pass one command string to cmd.exe — spawning cmd with an argv array
        // instead would re-quote and backslash-escape the embedded quotes,
        // breaking the command.
        let line = std::iter::once(format!("\"{executable}\""))
            .chain(args.iter().map(|arg| format!("\"{}\"", arg.replace('"', ""))))
            .collect::<Vec<_>>()
            .join(" ");
        let mut command = Command::new("cmd");
        command.arg("/C").arg(line);
        command
    } else {
        let mut command = Command::new(executable);
        command.args(args);
        command
    };
    command.stdout(Stdio::piped()).stderr(Stdio::piped()).stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command.spawn()
}

#[tauri::command]
pub fn provider_update_start(app: AppHandle, payload: ProviderUpdateStartPayload) -> Value {
    let update_id = payload.update_id.trim().to_string();
    let executable = payload.executable.trim().to_string();
    let args: Vec<String> = payload
        .args
        .iter()
        .map(|a| a.trim().to_string())
        .filter(|a| !a.is_empty())
        .collect();
    if update_id.is_empty() || executable.is_empty() || args.is_empty() {
        return json!({ "ok": false, "reason": "invalid-payload" });
    }
    let registry = app.state::<ProviderUpdateRegistry>();
    let mut child = match spawn_update(&executable, &args) {
        Ok(child) => child,
        Err(error) => return json!({ "ok": false, "reason": error.to_string() }),
    };
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    {
        let mut active = match registry.active.lock() {
            Ok(active) => active,
            Err(_) => return json!({ "ok": false, "reason": "registry-unavailable" }),
        };
        if active.contains_key(&update_id) {
            return json!({ "ok": false, "reason": "busy" });
        }
        active.insert(update_id.clone(), child);
    }

    // Fan both stdio streams into one channel; a single decoder thread keeps
    // the incremental codepage state so multibyte characters split across
    // chunks still decode correctly.
    let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
    let streams: [Option<Box<dyn Read + Send>>; 2] = [
        stdout.map(|s| Box::new(s) as Box<dyn Read + Send>),
        stderr.map(|s| Box::new(s) as Box<dyn Read + Send>),
    ];
    for stream in streams.into_iter().flatten() {
        let tx = tx.clone();
        std::thread::spawn(move || {
            let mut reader = std::io::BufReader::new(stream);
            let mut chunk = [0u8; 8192];
            loop {
                match reader.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if tx.send(chunk[..n].to_vec()).is_err() {
                            break;
                        }
                    }
                }
            }
        });
    }
    drop(tx);
    {
        let app = app.clone();
        let update_id = update_id.clone();
        std::thread::spawn(move || {
            let mut buffered = 0usize;
            // cmd and legacy CLI shims print in the OEM/GBK codepage on Windows.
            let mut decoder = if cfg!(windows) {
                encoding_rs::GBK.new_decoder_without_bom_handling()
            } else {
                encoding_rs::UTF_8.new_decoder_without_bom_handling()
            };
            while let Ok(chunk) = rx.recv() {
                buffered += chunk.len();
                if buffered > MAX_OUTPUT_BYTES {
                    continue;
                }
                let mut text = String::with_capacity(chunk.len() * 2);
                let (result, _) = decoder.decode_to_string_without_replacement(&chunk, &mut text, false);
                let chunk_text = match result {
                    encoding_rs::DecoderResult::Malformed(_, _) => String::from_utf8_lossy(&chunk).to_string(),
                    _ => text,
                };
                let _ = app.emit(
                    "provider:update-output",
                    UpdateOutputEvent {
                        update_id: update_id.clone(),
                        chunk: chunk_text,
                    },
                );
            }
        });
    }

    // Exit watcher: polls the registry so cancel (which removes the child)
    // also terminates the loop and reports the exit.
    std::thread::spawn(move || {
        let exit_code = loop {
            {
                let registry = app.state::<ProviderUpdateRegistry>();
                let mut active = match registry.active.lock() {
                    Ok(active) => active,
                    Err(_) => break -1,
                };
                match active.get_mut(&update_id) {
                    Some(child) => match child.try_wait() {
                        Ok(Some(status)) => {
                            active.remove(&update_id);
                            break status.code().unwrap_or(-1);
                        }
                        Ok(None) => {}
                        Err(_) => {
                            active.remove(&update_id);
                            break -1;
                        }
                    },
                    // Removed by cancel — the child was killed there.
                    None => break -1,
                }
            }
            std::thread::sleep(Duration::from_millis(100));
        };
        let _ = app.emit(
            "provider:update-exit",
            UpdateExitEvent {
                update_id,
                exit_code,
                error: None,
            },
        );
    });

    json!({ "ok": true })
}

#[tauri::command]
pub fn provider_update_cancel(app: AppHandle, update_id: String) {
    let child = {
        let registry = app.state::<ProviderUpdateRegistry>();
        registry.active.lock().ok().and_then(|mut active| active.remove(&update_id))
    };
    if let Some(mut child) = child {
        let _ = child.kill();
        let _ = child.wait();
    }
}
