//! Generic JSONL event normalization — port of adapters/normalize.ts.

use serde_json::Value;

use crate::adapters::AdapterEvent;

// ---------------------------------------------------------------- normalize

fn value_of<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    let object = value.as_object()?;
    keys.iter().find_map(|key| object.get(*key)).filter(|v| !v.is_null())
}

/// Port of adapters/normalize.ts — the generic JSONL event normalizer.
pub fn normalize_json(value: &Value) -> Vec<AdapterEvent> {
    if !value.is_object() {
        return vec![];
    }
    let event_type = value_of(value, &["type", "event", "kind"]).and_then(Value::as_str).unwrap_or("").to_string();
    let text = value_of(value, &["text", "message", "content", "delta"]);
    let tool = value_of(value, &["tool", "tool_name", "name"]);
    let path = value_of(value, &["path", "file", "file_path"]);
    if let Some(path) = path {
        return vec![AdapterEvent::File {
            path: path.as_str().map(str::to_string).unwrap_or_else(|| path.to_string()),
            change_type: value_of(value, &["change_type", "changeType"]).and_then(Value::as_str).map(str::to_string).or(Some("modified".to_string())),
            additions: None,
            deletions: None,
            diff: None,
            raw: Some(value.clone()),
        }];
    }
    if let Some(tool) = tool {
        if event_type.contains("tool") || event_type.contains("function") {
            return vec![AdapterEvent::Tool {
                call_id: None,
                name: tool.as_str().map(str::to_string).unwrap_or_else(|| tool.to_string()),
                phase: None,
                input: value_of(value, &["input", "arguments"]).cloned(),
                output: None,
                success: None,
                file_diff: None,
                subagent_dispatch_id: None,
                raw: Some(value.clone()),
            }];
        }
    }
    if let Some(text) = text {
        let text = text.as_str().map(str::to_string).unwrap_or_else(|| text.to_string());
        if event_type.contains("think") || event_type.contains("reason") {
            return vec![AdapterEvent::Thinking { text, phase: None, message_id: None, subagent_dispatch_id: None, raw: Some(value.clone()) }];
        }
        if event_type.contains("command") {
            return vec![AdapterEvent::Command {
                call_id: None,
                command: text,
                phase: None,
                exit_code: None,
                output: None,
                subagent_dispatch_id: None,
                raw: Some(value.clone()),
            }];
        }
        return vec![AdapterEvent::Message { text, phase: None, message_id: None, subagent_dispatch_id: None, raw: Some(value.clone()) }];
    }
    vec![]
}

