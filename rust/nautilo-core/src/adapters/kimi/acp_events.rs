//! Kimi ACP update parser — port of adapters/kimi/acp-events.ts.

use std::collections::HashMap;

use serde_json::Value;

use crate::adapters::AdapterEvent;

const TOOL_INPUT_IDENTITY_KEYS: [&str; 7] = ["path", "file_path", "filePath", "target_path", "targetPath", "query", "pattern"];

fn text(value: &Value) -> Option<String> {
    value.as_str().map(str::to_string)
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
            if let Some(content) = map.get("content") {
                if let Some(nested) = printable(content) {
                    return Some(nested);
                }
            }
            serde_json::to_string_pretty(value).ok()
        }
        other => Some(other.to_string()),
    }
}

/// Identity keys first, then the rest — stable ordering for dedup comparisons.
fn tool_input(value: &Value) -> Value {
    let Some(source) = value.as_object() else {
        return value.clone();
    };
    let mut prioritized = serde_json::Map::new();
    for key in TOOL_INPUT_IDENTITY_KEYS {
        if let Some(entry) = source.get(key) {
            prioritized.insert(key.to_string(), entry.clone());
        }
    }
    for (key, entry) in source {
        if !prioritized.contains_key(key) {
            prioritized.insert(key.clone(), entry.clone());
        }
    }
    Value::Object(prioritized)
}

fn merge_tool_input(previous: Option<&Value>, current: &Value) -> Value {
    match (previous, current.as_object()) {
        (Some(Value::Object(prev)), Some(curr)) => {
            let mut merged = prev.clone();
            for (key, entry) in curr {
                merged.insert(key.clone(), entry.clone());
            }
            tool_input(&Value::Object(merged))
        }
        _ => current.clone(),
    }
}

fn tool_input_identity(value: &Value) -> Option<String> {
    let input = value.as_object()?;
    let identity: Vec<(String, String)> = TOOL_INPUT_IDENTITY_KEYS
        .iter()
        .filter_map(|key| {
            let entry = input.get(*key)?.as_str()?.trim();
            if entry.is_empty() {
                None
            } else {
                Some((key.to_string(), entry.to_string()))
            }
        })
        .collect();
    if identity.is_empty() {
        None
    } else {
        Some(serde_json::to_string(&identity).unwrap_or_default())
    }
}

fn first_string(input: &serde_json::Map<String, Value>, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| input.get(*key).and_then(Value::as_str).map(str::to_string))
}

fn agent_prompt(value: Option<&Value>) -> Option<String> {
    let object = value?.as_object()?;
    first_string(object, &["prompt", "instruction", "instructions", "message", "goal"])
}

fn file_diff(tool_name: &str, value: Option<&Value>) -> Option<Value> {
    let normalized: String = tool_name
        .trim()
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();
    let is_edit = normalized == "edit"
        || normalized.starts_with("edit_")
        || normalized.starts_with("editing_")
        || normalized.ends_with("_edit")
        || normalized.ends_with("_edit_file");
    let is_write = normalized == "write"
        || normalized.starts_with("write_")
        || normalized.starts_with("writing_")
        || normalized.ends_with("_write")
        || normalized.ends_with("_write_file");
    if !is_edit && !is_write {
        return None;
    }
    let input = value?.as_object()?;
    let path = first_string(input, &TOOL_INPUT_IDENTITY_KEYS.iter().map(|s| *s).collect::<Vec<_>>());
    let build = |operation: &str, before: &str, after: &str| {
        let mut diff = serde_json::Map::new();
        diff.insert("operation".to_string(), Value::String(operation.to_string()));
        if let Some(path) = &path {
            diff.insert("path".to_string(), Value::String(path.clone()));
        }
        diff.insert("before".to_string(), Value::String(before.to_string()));
        diff.insert("after".to_string(), Value::String(after.to_string()));
        Value::Object(diff)
    };
    if is_write {
        let content = first_string(input, &["content", "text", "data"])?;
        return Some(build("write", "", &content));
    }
    let before = first_string(input, &["old_string", "oldString", "old_text", "oldText", "before"])?;
    let after = first_string(input, &["new_string", "newString", "new_text", "newText", "after"])?;
    Some(build("edit", &before, &after))
}

#[derive(Default)]
pub struct KimiToolCallState {
    pub phase: String,
    pub input: Option<Value>,
    pub input_identity: Option<String>,
    pub output: Option<String>,
}

pub struct KimiAcpParseState {
    pub message_id: String,
    pub thinking_id: String,
    pub tool_names: HashMap<String, String>,
    pub tool_calls: HashMap<String, KimiToolCallState>,
}

impl Default for KimiAcpParseState {
    fn default() -> Self {
        Self {
            message_id: "kimi-message-1".to_string(),
            thinking_id: "kimi-thinking-1".to_string(),
            tool_names: HashMap::new(),
            tool_calls: HashMap::new(),
        }
    }
}

/// Parses one `session/update` params.update payload.
pub fn parse_kimi_acp_update(value: &Value, state: &mut KimiAcpParseState) -> Vec<AdapterEvent> {
    let update_type = value.get("sessionUpdate").and_then(Value::as_str).unwrap_or("");
    match update_type {
        "available_commands_update" => {
            let commands: Vec<Value> = value
                .get("availableCommands")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
                .iter()
                .filter_map(|command| {
                    let name = command.get("name").and_then(Value::as_str)?;
                    let mut mapped = serde_json::Map::new();
                    mapped.insert("name".to_string(), Value::String(name.to_string()));
                    mapped.insert(
                        "description".to_string(),
                        command
                            .get("description")
                            .and_then(Value::as_str)
                            .map(|d| Value::String(d.to_string()))
                            .unwrap_or_else(|| Value::String(name.to_string())),
                    );
                    if let Some(hint) = command.get("input").and_then(|i| i.get("hint")).and_then(Value::as_str) {
                        mapped.insert("inputHint".to_string(), Value::String(hint.to_string()));
                    }
                    Some(Value::Object(mapped))
                })
                .collect();
            if commands.is_empty() {
                vec![]
            } else {
                vec![AdapterEvent::Commands { commands: Value::Array(commands), raw: Some(value.clone()) }]
            }
        }
        "usage_update" => vec![AdapterEvent::Usage {
            usage_scope: Some("context".to_string()),
            usage_key: None,
            input_tokens_includes_cache: None,
            cache_creation_input_tokens: None,
            reported_cost: None,
            estimated_cost: None,
            currency: None,
            input_tokens: None,
            cached_input_tokens: None,
            output_tokens: None,
            reasoning_output_tokens: None,
            context_used: value.get("used").and_then(Value::as_i64),
            context_window: value.get("size").and_then(Value::as_i64),
            raw: Some(value.clone()),
        }],
        "agent_message_chunk" => {
            let content = value.get("content").cloned().unwrap_or(Value::Null);
            if content.get("type").and_then(Value::as_str) == Some("text") {
                if let Some(chunk) = content.get("text").and_then(Value::as_str) {
                    return vec![AdapterEvent::Message {
                        text: chunk.to_string(),
                        phase: Some("delta".to_string()),
                        message_id: Some(state.message_id.clone()),
                        subagent_dispatch_id: None,
                        raw: Some(value.clone()),
                    }];
                }
            }
            vec![]
        }
        "agent_thought_chunk" => {
            let content = value.get("content").cloned().unwrap_or(Value::Null);
            if content.get("type").and_then(Value::as_str) == Some("text") {
                if let Some(chunk) = content.get("text").and_then(Value::as_str).filter(|t| !t.is_empty()) {
                    return vec![AdapterEvent::Thinking {
                        text: chunk.to_string(),
                        phase: Some("delta".to_string()),
                        message_id: Some(state.thinking_id.clone()),
                        subagent_dispatch_id: None,
                        raw: Some(value.clone()),
                    }];
                }
            }
            vec![]
        }
        "tool_call" | "tool_call_update" => parse_tool_call(value, state),
        _ => vec![],
    }
}

fn parse_tool_call(update: &Value, state: &mut KimiAcpParseState) -> Vec<AdapterEvent> {
    let call_id = update.get("toolCallId").and_then(text);
    let supplied_name = update.get("title").and_then(text);
    if let (Some(call_id), Some(name)) = (&call_id, &supplied_name) {
        state.tool_names.entry(call_id.clone()).or_insert_with(|| name.clone());
    }
    let name = call_id
        .as_ref()
        .and_then(|id| state.tool_names.get(id).cloned())
        .or(supplied_name)
        .unwrap_or_else(|| "tool".to_string());
    let status = update.get("status").and_then(Value::as_str).unwrap_or("");
    let completed = status == "completed" || status == "failed";
    let input = update.get("rawInput").map(tool_input);
    let output = update.get("rawOutput").and_then(printable).or_else(|| update.get("content").and_then(printable));

    if let Some(call_id) = &call_id {
        let previous = state.tool_calls.remove(call_id);
        let merged_input = match (&input, previous.as_ref().and_then(|p| p.input.clone())) {
            (Some(current), previous) => Some(merge_tool_input(previous.as_ref(), current)),
            (None, previous) => previous,
        };
        let next = KimiToolCallState {
            phase: if completed { "completed".to_string() } else { "started".to_string() },
            input_identity: merged_input.as_ref().and_then(tool_input_identity),
            input: merged_input,
            output: output.or_else(|| previous.as_ref().and_then(|p| p.output.clone())),
        };
        let gained_input = previous.as_ref().and_then(|p| p.input.as_ref()).is_none() && next.input.is_some();
        let gained_agent_prompt = agent_prompt(previous.as_ref().and_then(|p| p.input.as_ref()))
            != agent_prompt(next.input.as_ref())
            && agent_prompt(next.input.as_ref()).is_some();
        let changed_output = previous.as_ref().and_then(|p|p.output.as_ref()) != next.output.as_ref();
        let duplicate = previous.as_ref().is_some_and(|p| p.phase == "completed")
            || (!completed
                && previous.as_ref().is_some_and(|p| p.phase == "started")
                && previous.as_ref().and_then(|p| p.input_identity.clone()) == next.input_identity
                && !gained_input
                && !gained_agent_prompt
                && !changed_output);
        let phase = if !completed && previous.is_some() { "updated".to_string() } else { next.phase.clone() };
        let event_input = next.input.clone();
        let event_output = next.output.clone();
        state.tool_calls.insert(call_id.clone(), next);
        if duplicate {
            return vec![];
        }
        return vec![AdapterEvent::Tool {
            call_id: Some(call_id.clone()),
            name: name.clone(),
            phase: Some(phase),
            input: event_input.clone(),
            output: event_output.map(Value::String),
            success: Some(status != "failed"),
            file_diff: file_diff(&name, event_input.as_ref()),
            subagent_dispatch_id: None,
            raw: Some(update.clone()),
        }];
    }
    vec![AdapterEvent::Tool {
        call_id,
        name: name.clone(),
        phase: Some(if completed { "completed" } else { "started" }.to_string()),
        input: input.clone(),
        output: output.map(Value::String),
        success: Some(status != "failed"),
        file_diff: file_diff(&name, input.as_ref()),
        subagent_dispatch_id: None,
        raw: Some(update.clone()),
    }]
}
