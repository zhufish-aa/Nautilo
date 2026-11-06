//! Real PTYs, independent of run logs and renderer mounts.
use crate::errors::{invalid, not_found, CoreResult};
use base64::Engine;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    io::{Read, Write},
    sync::{Arc, Mutex},
};

const MAX_BYTES: usize = 8 * 1024 * 1024;
const MAX_LINES: usize = 5000;
const POLL_BYTES: usize = 256 * 1024;
#[derive(Default)]
struct Output {
    chunks: VecDeque<Vec<u8>>,
    start: u64,
    end: u64,
    lines: usize,
    exit: Option<u32>,
    eof: bool,
}
impl Output {
    fn append(&mut self, bytes: &[u8]) {
        self.end += bytes.len() as u64;
        self.lines += bytes.iter().filter(|b| **b == b'\n').count();
        self.chunks.push_back(bytes.to_vec());
        while self.end - self.start > MAX_BYTES as u64 || self.lines > MAX_LINES {
            if let Some(old) = self.chunks.pop_front() {
                self.start += old.len() as u64;
                self.lines = self
                    .lines
                    .saturating_sub(old.iter().filter(|b| **b == b'\n').count());
            } else {
                break;
            }
        }
    }
    fn read(&self, after: u64) -> Value {
        let reset = after < self.start || after > self.end;
        let cursor = if reset { self.start } else { after };
        let mut position = self.start;
        let mut bytes = Vec::new();
        for chunk in &self.chunks {
            let end = position + chunk.len() as u64;
            if end > cursor && bytes.len() < POLL_BYTES {
                let skip = cursor.saturating_sub(position) as usize;
                bytes.extend_from_slice(
                    &chunk[skip..chunk.len().min(skip + POLL_BYTES - bytes.len())],
                );
            }
            position = end;
            if bytes.len() >= POLL_BYTES {
                break;
            }
        }
        json!({"data":base64::engine::general_purpose::STANDARD.encode(&bytes),"cursor":cursor+bytes.len() as u64,"reset":reset,"exited":self.exit.is_some() && self.eof,"exitCode":self.exit})
    }
}

struct Terminal {
    id: String,
    key: String,
    owner: Option<String>,
    cwd: String,
    pid: Option<u32>,
    created: std::time::Instant,
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    writer: Mutex<Option<Box<dyn Write + Send>>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    output: Arc<Mutex<Output>>,
    resources: Mutex<Vec<Box<dyn Send>>>,
}
impl Terminal {
    fn close(&self) {
        let _ = self.killer.lock().unwrap().kill();
        self.writer.lock().unwrap().take();
        if let Some(master) = self.master.lock().unwrap().take() {
            std::thread::spawn(move || drop(master));
        }
        self.resources.lock().unwrap().clear();
    }
    fn metadata(&self) -> Value {
        json!({"id":self.id,"cwd":self.cwd,"pid":self.pid,"kind":if self.owner.is_some(){"harness"}else{"shell"}})
    }
}
impl Drop for Terminal {
    fn drop(&mut self) {
        self.close();
    }
}

#[derive(Default)]
pub struct TerminalService {
    sessions: Mutex<HashMap<String, Arc<Terminal>>>,
    gates: Mutex<HashMap<String, std::sync::Weak<tokio::sync::Mutex<()>>>>,
    opening: Mutex<()>,
}
pub struct TerminalPlan {
    pub command: String,
    pub args: Vec<String>,
    pub env: Option<HashMap<String, String>>,
    pub cwd: String,
    pub resources: Vec<Box<dyn Send>>,
}
fn size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        rows: rows.clamp(2, 500),
        cols: cols.clamp(10, 1000),
        pixel_width: 0,
        pixel_height: 0,
    }
}
impl TerminalService {
    pub async fn lock_session(&self, id: &str) -> tokio::sync::OwnedMutexGuard<()> {
        let gate = {
            let mut gates = self.gates.lock().unwrap();
            gates.retain(|_, gate| gate.strong_count() > 0);
            if let Some(gate) = gates.get(id).and_then(|gate| gate.upgrade()) {
                gate
            } else {
                let gate = Arc::new(tokio::sync::Mutex::new(()));
                gates.insert(id.into(), Arc::downgrade(&gate));
                gate
            }
        };
        gate.lock_owned().await
    }
    pub fn owns(&self, session: &str) -> bool {
        self.sessions.lock().unwrap().values().any(|entry| {
            entry.owner.as_deref() == Some(session) && entry.output.lock().unwrap().exit.is_none()
        })
    }
    pub fn status(&self, session: &str) -> Value {
        let sessions = self.sessions.lock().unwrap();
        let terminal = sessions.values().find(|entry| {
            entry.owner.as_deref() == Some(session) && entry.output.lock().unwrap().exit.is_none()
        });
        json!({"nativeActive":terminal.is_some(),"terminalId":terminal.map(|entry|entry.id.as_str())})
    }
    pub fn existing(&self, key: &str) -> Option<Value> {
        self.sessions
            .lock()
            .unwrap()
            .values()
            .find(|entry| entry.key == key && entry.output.lock().unwrap().exit.is_none())
            .map(|entry| entry.metadata())
    }
    pub fn open(
        &self,
        key: String,
        owner: Option<String>,
        plan: TerminalPlan,
        cols: u16,
        rows: u16,
    ) -> CoreResult<Value> {
        let _opening = self.opening.lock().unwrap();
        if let Some(existing) = self.existing(&key) {
            return Ok(existing);
        }
        if self
            .sessions
            .lock()
            .unwrap()
            .values()
            .filter(|entry| entry.output.lock().unwrap().exit.is_none())
            .count()
            >= 32
        {
            return Err(invalid(
                "terminal",
                "已有 32 个终端正在运行，请先结束一个终端。",
            ));
        }
        if !std::path::Path::new(&plan.cwd).is_dir() {
            return Err(invalid("cwd", "工作目录不存在"));
        }
        let pair = native_pty_system()
            .openpty(size(cols, rows))
            .map_err(|error| invalid("terminal", &error.to_string()))?;
        let resolved =
            crate::win_command::resolve_spawn_command(&plan.command, &plan.args, plan.env.as_ref());
        let mut command = CommandBuilder::new(&resolved.command);
        command.args(&resolved.args);
        command.cwd(&plan.cwd);
        if let Some(env) = &plan.env {
            command.env_clear();
            for (key, value) in env {
                command.env(key, value);
            }
        }
        command.env("TERM", "xterm-256color");
        let mut child = pair
            .slave
            .spawn_command(command)
            .map_err(|error| invalid("terminal", &error.to_string()))?;
        drop(pair.slave);
        let reader = pair.master.try_clone_reader();
        let writer = pair.master.take_writer();
        let (mut reader, writer) = match (reader, writer) {
            (Ok(reader), Ok(writer)) => (reader, writer),
            (reader, writer) => {
                let _ = child.kill();
                return Err(invalid(
                    "terminal",
                    &format!(
                        "PTY streams unavailable: {:?} {:?}",
                        reader.err(),
                        writer.err()
                    ),
                ));
            }
        };
        let output = Arc::new(Mutex::new(Output::default()));
        let entry = Arc::new(Terminal {
            id: uuid::Uuid::new_v4().to_string(),
            key,
            owner,
            cwd: plan.cwd,
            pid: child.process_id(),
            created: std::time::Instant::now(),
            master: Mutex::new(Some(pair.master)),
            writer: Mutex::new(Some(writer)),
            killer: Mutex::new(child.clone_killer()),
            output: output.clone(),
            resources: Mutex::new(plan.resources),
        });
        let read_output = output.clone();
        std::thread::spawn(move || {
            let mut buffer = [0; 8192];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(count) => read_output.lock().unwrap().append(&buffer[..count]),
                }
            }
            read_output.lock().unwrap().eof = true;
        });
        std::thread::spawn(move || {
            let code = child.wait().map(|status| status.exit_code()).unwrap_or(1);
            output.lock().unwrap().exit = Some(code);
        });
        let metadata = entry.metadata();
        let mut sessions = self.sessions.lock().unwrap();
        while sessions.len() >= 64 {
            let oldest = sessions
                .values()
                .filter(|entry| entry.output.lock().unwrap().exit.is_some())
                .min_by_key(|entry| entry.created)
                .map(|entry| entry.id.clone());
            if let Some(id) = oldest {
                sessions.remove(&id);
            } else {
                break;
            }
        }
        sessions.insert(entry.id.clone(), entry);
        Ok(metadata)
    }
    fn get(&self, id: &str) -> CoreResult<Arc<Terminal>> {
        self.sessions
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or_else(|| not_found("terminal", id))
    }
    pub fn read(&self, id: &str, cursor: u64) -> CoreResult<Value> {
        Ok(self.get(id)?.output.lock().unwrap().read(cursor))
    }
    pub fn write(&self, id: &str, data: &str) -> CoreResult<Value> {
        if data.len() > 1024 * 1024 {
            return Err(invalid("data", "Terminal input exceeds 1 MiB"));
        }
        let terminal = self.get(id)?;
        let mut writer = terminal.writer.lock().unwrap();
        let writer = writer
            .as_mut()
            .ok_or_else(|| invalid("terminalId", "Terminal closed"))?;
        writer
            .write_all(data.as_bytes())
            .and_then(|_| writer.flush())
            .map_err(|error| invalid("terminalId", &error.to_string()))?;
        Ok(json!({"ok":true}))
    }
    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> CoreResult<Value> {
        let terminal = self.get(id)?;
        let master = terminal.master.lock().unwrap();
        master
            .as_ref()
            .ok_or_else(|| invalid("terminalId", "Terminal closed"))?
            .resize(size(cols, rows))
            .map_err(|error| invalid("terminalId", &error.to_string()))?;
        Ok(json!({"ok":true}))
    }
    pub fn close(&self, id: &str) -> CoreResult<Value> {
        if let Some(terminal) = self.sessions.lock().unwrap().remove(id) {
            terminal.close();
        }
        Ok(json!({"ok":true}))
    }
    pub fn close_all(&self) {
        for (_, terminal) in self.sessions.lock().unwrap().drain() {
            terminal.close();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cursor_and_retention_preserve_binary_boundaries() {
        let mut output = Output::default();
        output.append("一".as_bytes());
        output.append(b"\x1b[31mred\n");
        let first = output.read(0);
        assert_eq!(first["cursor"], 12);
        assert_eq!(output.read(12)["data"], "");
        for _ in 0..5002 {
            output.append(b"line\n");
        }
        assert!(output.read(0)["reset"].as_bool().unwrap());
        assert!(output.lines <= MAX_LINES);
    }
    #[test]
    fn pty_input_resize_and_reconnect() {
        let service = TerminalService::default();
        let (command, args) = if cfg!(windows) {
            ("cmd.exe", vec!["/Q".into()])
        } else {
            ("sh", vec![])
        };
        let metadata = service
            .open(
                "fixture".into(),
                None,
                TerminalPlan {
                    command: command.into(),
                    args,
                    env: None,
                    cwd: std::env::temp_dir().to_string_lossy().into(),
                    resources: vec![],
                },
                80,
                24,
            )
            .unwrap();
        let id = metadata["id"].as_str().unwrap();
        service.resize(id, 110, 30).unwrap();
        service.write(id, "\x1b[1;1R").unwrap();
        service.write(id, "echo nautilo-pty-ready\r\n").unwrap();
        let end = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let mut found = false;
        let mut last = Value::Null;
        while std::time::Instant::now() < end {
            let data = service.read(id, 0).unwrap();
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(data["data"].as_str().unwrap())
                .unwrap();
            if String::from_utf8_lossy(&bytes).contains("nautilo-pty-ready") {
                found = true;
                break;
            }
            last = data;
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        if !found {
            eprintln!("PTY output: {last}");
        }
        assert!(found);
        assert_eq!(service.existing("fixture").unwrap()["id"], metadata["id"]);
        service.close(id).unwrap();
        assert!(service.existing("fixture").is_none());
    }
}
