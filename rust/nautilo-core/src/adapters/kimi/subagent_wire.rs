//! Sub-agent wire watcher — port of adapters/kimi/subagent-wire.ts.
//! Tails Kimi's provider-owned child-agent wires while ACP waits on `Agent`.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::adapters::AdapterEvent;

const MAX_PROMPT_BYTES: u64 = 512 * 1024;
const MAX_POLL_BYTES: u64 = 1024 * 1024;

fn text(value: &Value) -> Option<String> {
    value.as_str().filter(|s| !s.is_empty()).map(str::to_string)
}

fn printable(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::String(s) if !s.trim().is_empty() => Some(s.clone()),
        Value::String(_) => None,
        Value::Array(items) => {
            let parts: Vec<String> = items.iter().filter_map(printable).collect();
            if parts.is_empty() {
                None
            } else {
                Some(parts.join("\n"))
            }
        }
        Value::Object(map) => {
            if let Some(text) = map.get("text").and_then(Value::as_str).filter(|t| !t.trim().is_empty()) {
                return Some(text.to_string());
            }
            if let Some(output) = map.get("output") {
                if let Some(nested) = printable(output) {
                    return Some(nested);
                }
            }
            serde_json::to_string_pretty(value).ok()
        }
        other => Some(other.to_string()),
    }
}

pub struct KimiSubagentWireParseState {
    agent_id: String,
    message_index: u32,
    tool_calls: HashMap<String, (String, Option<Value>)>,
    finished: bool,
}

fn create_parse_state(agent_id: &str) -> KimiSubagentWireParseState {
    KimiSubagentWireParseState { agent_id: agent_id.to_string(), message_index: 0, tool_calls: HashMap::new(), finished: false }
}

/// Converts one provider-owned sub-agent wire record into nested activity.
pub fn parse_kimi_subagent_wire_line(
    line: &str,
    state: &mut KimiSubagentWireParseState,
    subagent_dispatch_id: &str,
) -> Vec<AdapterEvent> {
    let wrapper: Value = match serde_json::from_str(line) {
        Ok(value) => value,
        Err(_) => return vec![],
    };
    if wrapper.get("type").and_then(Value::as_str) != Some("context.append_loop_event") {
        return vec![];
    }
    let event = wrapper.get("event").cloned().unwrap_or(Value::Null);
    match event.get("type").and_then(Value::as_str) {
        Some("content.part") => {
            let part = event.get("part").cloned().unwrap_or(Value::Null);
            // Kimi's private `think` records are intentionally not projected.
            if part.get("type").and_then(Value::as_str) != Some("text") {
                return vec![];
            }
            let Some(value) = part.get("text").and_then(text) else {
                return vec![];
            };
            state.message_index += 1;
            vec![AdapterEvent::Message {
                text: value,
                phase: Some("completed".to_string()),
                message_id: Some(format!("kimi-{}-message-{}", state.agent_id, state.message_index)),
                subagent_dispatch_id: Some(subagent_dispatch_id.to_string()),
                raw: Some(wrapper),
            }]
        }
        Some("tool.call") => {
            let call_id = event.get("toolCallId").and_then(text);
            let name = event.get("name").and_then(text).unwrap_or_else(|| "tool".to_string());
            let input = event.get("args").cloned();
            if let Some(call_id) = &call_id {
                state.tool_calls.insert(call_id.clone(), (name.clone(), input.clone()));
            }
            vec![AdapterEvent::Tool {
                call_id,
                name,
                phase: Some("started".to_string()),
                input,
                output: None,
                success: None,
                file_diff: None,
                subagent_dispatch_id: Some(subagent_dispatch_id.to_string()),
                raw: Some(wrapper),
            }]
        }
        Some("tool.result") => {
            let call_id = event.get("toolCallId").and_then(text);
            let previous = call_id.as_ref().and_then(|id| state.tool_calls.get(id));
            let result = event.get("result").cloned().unwrap_or(Value::Null);
            vec![AdapterEvent::Tool {
                call_id: call_id.clone(),
                name: previous.map(|(name, _)| name.clone()).unwrap_or_else(|| "tool".to_string()),
                phase: Some("completed".to_string()),
                input: previous.and_then(|(_, input)| input.clone()),
                output: result
                    .get("output")
                    .and_then(printable)
                    .or_else(|| printable(&result))
                    .map(Value::String),
                success: Some(result.get("isError").and_then(Value::as_bool) != Some(true)),
                file_diff: None,
                subagent_dispatch_id: Some(subagent_dispatch_id.to_string()),
                raw: Some(wrapper),
            }]
        }
        Some("step.end") => {
            if event.get("finishReason").and_then(Value::as_str) == Some("end_turn") {
                state.finished = true;
            }
            vec![]
        }
        _ => vec![],
    }
}

struct ChildWire {
    agent_id: String,
    path: String,
    size: u64,
    modified_ms: i64,
}

#[derive(Default)]
struct DispatchState {
    prompt: Option<String>,
    resume_agent_id: Option<String>,
    agent_id: Option<String>,
    wire_path: Option<String>,
    offset: u64,
    carry: String,
    parser: Option<KimiSubagentWireParseState>,
}

pub struct KimiSubagentWireWatcher {
    provider_session_id: String,
    kimi_home: String,
    session_dir: Option<String>,
    initialized: bool,
    initial_sizes: HashMap<String, u64>,
    claimed_agents: HashSet<String>,
    prompt_cache: HashMap<String, String>,
    dispatches: HashMap<String, DispatchState>,
}

impl KimiSubagentWireWatcher {
    pub fn new(provider_session_id: &str, kimi_home: Option<&str>) -> Self {
        let kimi_home = kimi_home
            .map(str::to_string)
            .or_else(|| std::env::var("KIMI_CODE_HOME").ok().filter(|v| !v.trim().is_empty()))
            .unwrap_or_else(|| dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")).join(".kimi-code").to_string_lossy().into_owned());
        Self {
            provider_session_id: provider_session_id.to_string(),
            kimi_home,
            session_dir: None,
            initialized: false,
            initial_sizes: HashMap::new(),
            claimed_agents: HashSet::new(),
            prompt_cache: HashMap::new(),
            dispatches: HashMap::new(),
        }
    }

    pub async fn initialize(&mut self) {
        if self.initialized && self.session_dir.is_some() {
            return;
        }
        let initial_snapshot = !self.initialized;
        self.session_dir = find_session_dir(&Path::new(&self.kimi_home).join("sessions"), &self.provider_session_id).await;
        if let Some(dir) = self.session_dir.as_ref().filter(|_|initial_snapshot) {
            for child in list_child_wires(Path::new(dir)).await {
                self.initial_sizes.insert(child.agent_id, child.size);
            }
        }
        // A directory that appears after the initial handshake contains new
        // work. Retry discovery without treating those new bytes as history.
        self.initialized = true;
    }

    pub fn track(&mut self, call_id: &str, input: Option<&Value>) {
        let prompt = input
            .and_then(|v| first_text(v, &["prompt", "instruction", "instructions", "message", "goal"]));
        let resume_agent_id = input.and_then(|v| first_text(v, &["resume", "agent_id", "agentId"]));
        let entry = self.dispatches.entry(call_id.to_string()).or_default();
        if entry.prompt.is_none() {
            entry.prompt = prompt;
        }
        if entry.resume_agent_id.is_none() {
            entry.resume_agent_id = resume_agent_id;
        }
    }

    pub fn has_active(&self) -> bool {
        self.dispatches.values().any(|dispatch| dispatch.parser.as_ref().is_none_or(|parser|!parser.finished))
    }

    pub fn release(&mut self, call_id: &str) {
        self.dispatches.remove(call_id);
    }

    pub async fn poll(&mut self) -> Vec<AdapterEvent> {
        if self.dispatches.is_empty() {
            return vec![];
        }
        self.initialize().await;
        let Some(session_dir) = self.session_dir.clone() else {
            return vec![];
        };
        let children = list_child_wires(Path::new(&session_dir)).await;
        self.assign_children(children).await;
        let mut events = vec![];
        for (call_id, dispatch) in self.dispatches.iter_mut() {
            let (Some(wire_path), Some(_)) = (&dispatch.wire_path, &dispatch.parser) else {
                continue;
            };
            let Some(chunk) = read_wire_chunk(wire_path, dispatch.offset).await else {
                continue;
            };
            if chunk.reset {
                dispatch.offset = 0;
                dispatch.carry = String::new();
                dispatch.parser = Some(create_parse_state(dispatch.agent_id.as_deref().unwrap_or("subagent")));
            }
            dispatch.offset += chunk.bytes.len() as u64;
            let combined = format!("{}{}", dispatch.carry, String::from_utf8_lossy(&chunk.bytes));
            let mut lines: Vec<&str> = combined.split('\n').collect();
            dispatch.carry = lines.pop().unwrap_or("").to_string();
            let Some(parser) = dispatch.parser.as_mut() else { continue };
            for line in lines {
                let line = line.trim_end_matches('\r');
                if !line.trim().is_empty() {
                    events.extend(parse_kimi_subagent_wire_line(line, parser, call_id));
                }
            }
        }
        events
    }

    async fn assign_children(&mut self, children: Vec<ChildWire>) {
        let available: Vec<&ChildWire> = children.iter().filter(|child| !self.claimed_agents.contains(&child.agent_id)).collect();
        if available.is_empty() {
            return;
        }
        // Resumed agents pair by id first.
        let mut assignments: Vec<(String, String)> = vec![]; // (call_id, agent_id)
        for (call_id, dispatch) in self.dispatches.iter() {
            if dispatch.agent_id.is_some() {
                continue;
            }
            if let Some(resume_id) = &dispatch.resume_agent_id {
                if available.iter().any(|child| child.agent_id == *resume_id) {
                    assignments.push((call_id.clone(), resume_id.clone()));
                }
            }
        }
        // Then by prompt match. Collect candidates first so the cache writes
        // below do not fight the iterator's borrow.
        let prompt_candidates: Vec<(String, String)> = self
            .dispatches
            .iter()
            .filter(|(_, d)| d.agent_id.is_none() && d.resume_agent_id.is_none())
            .filter_map(|(call_id, d)| d.prompt.clone().map(|prompt| (call_id.clone(), prompt)))
            .collect();
        for (call_id, prompt) in prompt_candidates {
            for child in &available {
                if self.claimed_agents.contains(&child.agent_id) || assignments.iter().any(|(_, id)| id == &child.agent_id) {
                    continue;
                }
                if let Some(child_prompt) = self.child_prompt(child).await {
                    if child_prompt.contains(prompt.as_str()) {
                        assignments.push((call_id.clone(), child.agent_id.clone()));
                        break;
                    }
                }
            }
        }
        // Pair the rest only when counts agree, preserving creation/call order.
        let unresolved: Vec<String> = self
            .dispatches
            .iter()
            .filter(|(call_id, d)| d.agent_id.is_none() && !assignments.iter().any(|(id, _)| id == *call_id))
            .map(|(call_id, _)| call_id.clone())
            .collect();
        if !unresolved.is_empty() {
            let mut new_children: Vec<&ChildWire> = available
                .iter()
                .filter(|child| {
                    !self.claimed_agents.contains(&child.agent_id)
                        && !self.initial_sizes.contains_key(&child.agent_id)
                        && !assignments.iter().any(|(_, id)| id == &child.agent_id)
                })
                .copied()
                .collect();
            new_children.sort_by(|left, right| left.modified_ms.cmp(&right.modified_ms).then_with(|| left.agent_id.cmp(&right.agent_id)));
            if unresolved.len() == new_children.len() {
                for (call_id, child) in unresolved.into_iter().zip(new_children.iter()) {
                    assignments.push((call_id, child.agent_id.clone()));
                }
            }
        }
        for (call_id, agent_id) in assignments {
            if let (Some(dispatch), Some(child)) = (self.dispatches.get_mut(&call_id), children.iter().find(|c| c.agent_id == agent_id)) {
                dispatch.agent_id = Some(child.agent_id.clone());
                dispatch.wire_path = Some(child.path.clone());
                dispatch.offset = self.initial_sizes.get(&child.agent_id).copied().unwrap_or(0);
                dispatch.parser = Some(create_parse_state(&child.agent_id));
                self.claimed_agents.insert(child.agent_id.clone());
            }
        }
    }

    async fn child_prompt(&mut self, child: &ChildWire) -> Option<String> {
        if let Some(cached) = self.prompt_cache.get(&child.agent_id) {
            return Some(cached.clone());
        }
        let bytes = read_start(&child.path, child.size.min(MAX_PROMPT_BYTES)).await?;
        for line in String::from_utf8_lossy(&bytes).lines() {
            if line.trim().is_empty() {
                continue;
            }
            let Ok(wrapper) = serde_json::from_str::<Value>(line) else { continue };
            if wrapper.get("type").and_then(Value::as_str) != Some("turn.prompt") {
                continue;
            }
            let prompt = wrapper
                .get("input")
                .and_then(Value::as_array)
                .map(|items| items.iter().filter_map(|item| item.get("text").and_then(text)).collect::<Vec<_>>().join("\n"))
                .unwrap_or_default();
            if !prompt.is_empty() {
                self.prompt_cache.insert(child.agent_id.clone(), prompt.clone());
            }
            return if prompt.is_empty() { None } else { Some(prompt) };
        }
        None
    }
}

fn first_text(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| value.get(*key).and_then(text))
}

async fn find_session_dir(sessions_root: &Path, provider_session_id: &str) -> Option<String> {
    let mut entries = tokio::fs::read_dir(sessions_root).await.ok()?;
    while let Ok(Some(workspace)) = entries.next_entry().await {
        let candidate = workspace.path().join(provider_session_id);
        if candidate.is_dir() {
            return Some(candidate.to_string_lossy().into_owned());
        }
    }
    None
}

async fn list_child_wires(session_dir: &Path) -> Vec<ChildWire> {
    let agents_dir = session_dir.join("agents");
    let mut entries = match tokio::fs::read_dir(agents_dir).await {
        Ok(entries) => entries,
        Err(_) => return vec![],
    };
    let mut children = vec![];
    while let Ok(Some(entry)) = entries.next_entry().await {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !entry.path().is_dir() || name == "main" {
            continue;
        }
        let path = entry.path().join("wire.jsonl");
        if let Ok(info) = tokio::fs::metadata(&path).await {
            if info.is_file() {
                children.push(ChildWire {
                    agent_id: name,
                    path: path.to_string_lossy().into_owned(),
                    size: info.len(),
                    modified_ms: info.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as i64).unwrap_or(0),
                });
            }
        }
    }
    children
}

async fn read_start(path: &str, length: u64) -> Option<Vec<u8>> {
    use tokio::io::AsyncReadExt;
    if length == 0 {
        return Some(vec![]);
    }
    let mut file = tokio::fs::File::open(path).await.ok()?;
    let mut buffer = vec![0u8; length as usize];
    let read = file.read(&mut buffer).await.ok()?;
    buffer.truncate(read);
    Some(buffer)
}

struct WireChunk {
    bytes: Vec<u8>,
    reset: bool,
}

async fn read_wire_chunk(path: &str, offset: u64) -> Option<WireChunk> {
    use tokio::io::{AsyncReadExt, AsyncSeekExt};
    let info = tokio::fs::metadata(path).await.ok()?;
    let reset = info.len() < offset;
    let start = if reset { 0 } else { offset };
    let length = MAX_POLL_BYTES.min(info.len().saturating_sub(start));
    if length == 0 {
        return None;
    }
    let mut file = tokio::fs::File::open(path).await.ok()?;
    file.seek(std::io::SeekFrom::Start(start)).await.ok()?;
    let mut buffer = vec![0u8; length as usize];
    let read = file.read(&mut buffer).await.ok()?;
    buffer.truncate(read);
    Some(WireChunk { bytes: buffer, reset })
}
