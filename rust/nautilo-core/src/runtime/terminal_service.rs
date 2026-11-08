//! Real PTYs, independent of run logs and renderer mounts.
use crate::errors::{invalid, not_found, CoreResult};
use base64::Engine;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet, VecDeque},
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
        json!({"data":base64::engine::general_purpose::STANDARD.encode(&bytes),"cursor":cursor+bytes.len() as u64,"reset":reset,"exited":self.exit.is_some() && self.eof && cursor+bytes.len() as u64==self.end,"exitCode":self.exit})
    }
}

struct Terminal {
    id: String,
    key: String,
    owner: Option<String>,
    scope: Option<String>,
    tab_id: Option<String>,
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
    fn stop(&self) {
        // ConPTY may still be waiting for its initial cursor-position reply
        // when the drawer disconnected during startup. Complete that handshake
        // before closing HPCON, otherwise ClosePseudoConsole can wait forever.
        #[cfg(windows)]
        if let Some(writer)=self.writer.lock().unwrap().as_mut() {let _=writer.write_all(b"\x1b[1;1R").and_then(|_|writer.flush());}
        let _ = self.killer.lock().unwrap().kill();
        self.writer.lock().unwrap().take();
        if let Some(master) = self.master.lock().unwrap().take() {
            std::thread::spawn(move || drop(master));
        }
    }
    fn close(&self) {
        self.stop();
        self.resources.lock().unwrap().clear();
    }
    fn metadata(&self) -> Value {
        let output=self.output.lock().unwrap();
        json!({"id":self.id,"cwd":self.cwd,"pid":self.pid,"kind":if self.owner.is_some(){"harness"}else{"shell"},"tabId":self.tab_id,"exited":output.exit.is_some()&&output.eof,"exitCode":output.exit})
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
    closed_scopes: Mutex<HashSet<String>>,
}
pub struct TerminalPlan {
    pub command: String,
    pub args: Vec<String>,
    pub env: Option<HashMap<String, String>>,
    pub cwd: String,
    pub resources: Vec<Box<dyn Send>>,
    pub provider_session_id: Option<String>,
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
    pub fn scope(session:Option<&str>,project:&str)->String {
        match session {Some(session)=>json!(["session",session]).to_string(),None=>json!(["project",project]).to_string()}
    }
    pub fn list(&self,scope:&str)->Value {
        let entries=self.sessions.lock().unwrap();let mut latest=HashMap::<String,&Arc<Terminal>>::new();
        for entry in entries.values().filter(|entry|entry.scope.as_deref()==Some(scope)){
            if latest.get(&entry.key).is_none_or(|prior|prior.created<entry.created){latest.insert(entry.key.clone(),entry);}
        }
        let mut entries=latest.into_values().collect::<Vec<_>>();entries.sort_by_key(|entry|entry.created);
        json!({"items":entries.into_iter().map(|entry|entry.metadata()).collect::<Vec<_>>()})
    }
    pub fn open_shell(&self,scope:String,tab_id:String,restore_only:bool,plan:TerminalPlan,cols:u16,rows:u16)->CoreResult<Value> {
        if tab_id.is_empty() || tab_id.len()>128 || !tab_id.chars().all(|c|c.is_ascii_alphanumeric()||matches!(c,'-'|'_'|'.')){
            return Err(invalid("tabId","Invalid terminal tab identity"));
        }
        let key=json!(["shell",scope,tab_id]).to_string();
        self.open_scoped(key,None,Some(scope),Some(tab_id),restore_only,plan,cols,rows)
    }
    pub fn owner(&self,id:&str)->Option<String> {self.sessions.lock().unwrap().get(id).and_then(|entry|entry.owner.clone())}
    pub fn metadata(&self,id:&str)->Option<Value> {self.sessions.lock().unwrap().get(id).map(|entry|entry.metadata())}
    pub fn exited(&self,id:&str)->Option<bool> {self.sessions.lock().unwrap().get(id).map(|entry|{let output=entry.output.lock().unwrap();output.exit.is_some() && output.eof})}
    pub fn release_resources(&self,id:&str) {if let Some(entry)=self.sessions.lock().unwrap().get(id){entry.resources.lock().unwrap().clear();}}
    pub async fn stop_and_wait(&self,id:&str)->CoreResult<()> {
        let terminal=self.get(id)?;
        terminal.stop();
        tokio::time::timeout(std::time::Duration::from_secs(5),async {
            loop {let exited={let output=terminal.output.lock().unwrap();output.exit.is_some() && output.eof};if exited{break;}tokio::time::sleep(std::time::Duration::from_millis(20)).await;}
        }).await.map_err(|_|invalid("terminal","原生进程仍在退出，请稍后重试。"))?;
        Ok(())
    }
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
        let scope=owner.as_deref().map(|owner|Self::scope(Some(owner),""));
        let tab_id=owner.as_ref().map(|_|"native".into());
        self.open_scoped(key,owner,scope,tab_id,false,plan,cols,rows)
    }
    fn open_scoped(&self,key:String,owner:Option<String>,scope:Option<String>,tab_id:Option<String>,restore_only:bool,plan:TerminalPlan,cols:u16,rows:u16)->CoreResult<Value>{
        let _opening = self.opening.lock().unwrap();
        if scope.as_ref().is_some_and(|scope|self.closed_scopes.lock().unwrap().contains(scope)) {
            return Err(not_found("terminalScope",scope.as_deref().unwrap_or("")));
        }
        if let Some(existing) = self.existing(&key) {
            return Ok(existing);
        }
        if restore_only {
            return self.sessions.lock().unwrap().values().filter(|entry|entry.key==key)
                .max_by_key(|entry|entry.created).map(|entry|entry.metadata()).ok_or_else(||not_found("terminalTab",tab_id.as_deref().unwrap_or("")));
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
            scope,
            tab_id,
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
                .filter(|entry| {let output=entry.output.lock().unwrap();output.exit.is_some() && output.eof && entry.resources.lock().unwrap().is_empty()})
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
        let terminals={
            let mut sessions=self.sessions.lock().unwrap();
            let Some(key)=sessions.get(id).map(|entry|entry.key.clone()) else{return Ok(json!({"ok":true}));};
            let ids=sessions.values().filter(|entry|entry.key==key).map(|entry|entry.id.clone()).collect::<Vec<_>>();
            ids.into_iter().filter_map(|id|sessions.remove(&id)).collect::<Vec<_>>()
        };
        for terminal in terminals{terminal.close();}
        Ok(json!({"ok":true}))
    }
    pub fn close_shell(&self,scope:&str,tab_id:&str)->CoreResult<Value>{
        let _opening=self.opening.lock().unwrap();
        let key=json!(["shell",scope,tab_id]).to_string();
        let id=self.sessions.lock().unwrap().values().find(|entry|entry.key==key).map(|entry|entry.id.clone());
        match id{Some(id)=>self.close(&id),None=>Ok(json!({"ok":true}))}
    }
    pub fn close_scope(&self,scope:&str) {
        let _opening=self.opening.lock().unwrap();
        self.closed_scopes.lock().unwrap().insert(scope.into());
        let terminals={let mut sessions=self.sessions.lock().unwrap();let ids=sessions.values().filter(|entry|entry.scope.as_deref()==Some(scope)).map(|entry|entry.id.clone()).collect::<Vec<_>>();ids.into_iter().filter_map(|id|sessions.remove(&id)).collect::<Vec<_>>()};
        for terminal in terminals{terminal.close();}
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
    fn shell_plan() -> TerminalPlan {
        TerminalPlan { command: if cfg!(windows){"cmd.exe"}else{"sh"}.into(), args: if cfg!(windows){vec!["/Q".into()]}else{vec![]}, env:None,
            cwd:std::env::temp_dir().to_string_lossy().into(), resources:vec![], provider_session_id:None }
    }
    #[tokio::test]
    async fn shell_tabs_restore_output_without_starting_or_stopping_siblings() {
        let service=TerminalService::default();let scope=TerminalService::scope(Some("session:one"),"project");
        let open=|tab:&str,restore|service.open_shell(scope.clone(),tab.into(),restore,shell_plan(),80,24);
        assert!(open("missing",true).is_err());
        assert!(open("bad:tab",false).is_err());
        let first=open("default",false).unwrap();let second=open("other",false).unwrap();
        let other_scope=TerminalService::scope(Some("other-session"),"project");
        let unrelated=service.open_shell(other_scope.clone(),"default".into(),false,shell_plan(),80,24).unwrap();
        let first_id=first["id"].as_str().unwrap();let second_id=second["id"].as_str().unwrap();
        assert_ne!(first_id,second_id);assert_ne!(first["pid"],second["pid"]);
        assert_eq!(open("default",true).unwrap()["id"],first["id"]);
        service.write(first_id,"\x1b[1;1R").unwrap();service.write(second_id,"\x1b[1;1R").unwrap();
        service.write(first_id,"echo nautilo-tab-one\r\n").unwrap();
        let until=std::time::Instant::now()+std::time::Duration::from_secs(5);
        loop {
            let frame=service.read(first_id,0).unwrap();let bytes=base64::engine::general_purpose::STANDARD.decode(frame["data"].as_str().unwrap()).unwrap();
            if String::from_utf8_lossy(&bytes).contains("nautilo-tab-one"){break;}
            assert!(std::time::Instant::now()<until,"shell output was not retained");tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        service.stop_and_wait(first_id).await.unwrap();
        assert_eq!(service.list(&scope)["items"].as_array().unwrap().len(),2);
        assert_eq!(open("default",true).unwrap()["id"],first["id"]);
        assert_eq!(open("default",true).unwrap()["exited"],true);
        assert!(!service.read(first_id,0).unwrap()["data"].as_str().unwrap().is_empty());
        assert_eq!(service.exited(second_id),Some(false));
        let restarted=open("default",false).unwrap();assert_ne!(restarted["id"],first["id"]);
        assert_eq!(service.list(&scope)["items"].as_array().unwrap().len(),2);
        service.close_shell(&scope,"default").unwrap();
        assert!(service.metadata(first_id).is_none());assert!(service.metadata(restarted["id"].as_str().unwrap()).is_none());
        assert!(open("default",true).is_err());assert_eq!(service.exited(second_id),Some(false));
        assert_eq!(service.list(&scope)["items"].as_array().unwrap().len(),1);
        assert_eq!(service.list(&TerminalService::scope(None,"session:one"))["items"],json!([]));
        service.close_scope(&scope);assert!(service.metadata(second_id).is_none());assert!(open("default",false).is_err());
        assert_eq!(service.list(&other_scope)["items"].as_array().unwrap().len(),1);assert!(service.metadata(unrelated["id"].as_str().unwrap()).is_some());
        service.close_all();
    }
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
                    provider_session_id: None,
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
