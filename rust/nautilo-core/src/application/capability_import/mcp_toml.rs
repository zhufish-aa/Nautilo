//! Minimal TOML reader for ~/.codex/config.toml MCP tables —
//! port of capability-import/mcp-toml.ts. Covers `[mcp_servers.<name>]`
//! tables with string, string-array and inline-table values only, mirroring
//! the write side in adapters/codex mcp-config.

use serde_json::{json, Map, Value};

use crate::application::capability_import::mcp_json::to_mcp_candidate;

fn unquote(raw: &str) -> String {
    let value = raw.trim();
    if value.starts_with('"') && value.ends_with('"') && value.len() >= 2 {
        if let Ok(parsed) = serde_json::from_str::<String>(value) {
            return parsed;
        }
        return value[1..value.len() - 1].to_string();
    }
    if value.starts_with('\'') && value.ends_with('\'') && value.len() >= 2 {
        return value[1..value.len() - 1].to_string();
    }
    value.to_string()
}

/// Splits `a, b, c` respecting quoted segments.
fn split_top(body: &str) -> Vec<String> {
    let mut parts = vec![];
    let mut current = String::new();
    let mut quote: Option<char> = None;
    for ch in body.chars() {
        match quote {
            Some(q) => {
                current.push(ch);
                if ch == q {
                    quote = None;
                }
            }
            None => {
                if ch == '"' || ch == '\'' {
                    quote = Some(ch);
                    current.push(ch);
                } else if ch == ',' {
                    parts.push(current.trim().to_string());
                    current = String::new();
                } else {
                    current.push(ch);
                }
            }
        }
    }
    if !current.trim().is_empty() {
        parts.push(current.trim().to_string());
    }
    parts.into_iter().filter(|part| !part.is_empty()).collect()
}

fn parse_value(raw: &str) -> Option<Value> {
    let value = raw.trim();
    if value.is_empty() {
        return None;
    }
    if value.starts_with('[') && value.ends_with(']') {
        let items: Vec<Value> = split_top(&value[1..value.len() - 1]).iter().map(|item| json!(unquote(item))).collect();
        return Some(Value::Array(items));
    }
    if value.starts_with('{') && value.ends_with('}') {
        let mut record = Map::new();
        for entry in split_top(&value[1..value.len() - 1]) {
            if let Some((key, val)) = entry.split_once('=') {
                record.insert(unquote(key), json!(unquote(val)));
            }
        }
        return Some(Value::Object(record));
    }
    Some(json!(unquote(value)))
}

/// Reads `[mcp_servers.*]` tables out of a Codex config.toml.
pub fn parse_mcp_config_toml(text: &str, origin: Option<&str>) -> (Vec<Value>, Vec<String>) {
    let table_header = regex::Regex::new(r"^\[\s*mcp_servers\s*\.\s*(.+?)\s*\]$").unwrap();
    let key_value = regex::Regex::new(r#"^([A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*")\s*=\s*(.+)$"#).unwrap();
    let mut servers = vec![];
    let mut errors = vec![];
    let mut name: Option<String> = None;
    let mut current = Map::new();

    let flush = |name: &mut Option<String>, current: &mut Map<String, Value>, servers: &mut Vec<Value>, errors: &mut Vec<String>| {
        let Some(taken) = name.take() else { return };
        match to_mcp_candidate(&taken, &Value::Object(std::mem::take(current)), origin) {
            Some(candidate) => servers.push(candidate),
            None => errors.push(format!("\"{taken}\" 缺少 command 或 url，已跳过")),
        }
    };

    for raw_line in text.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some(captures) = table_header.captures(line) {
            flush(&mut name, &mut current, &mut servers, &mut errors);
            name = Some(unquote(&captures[1]));
            continue;
        }
        if line.starts_with('[') {
            flush(&mut name, &mut current, &mut servers, &mut errors);
            continue;
        }
        if name.is_none() {
            continue;
        }
        let Some(captures) = key_value.captures(line) else { continue };
        if let Some(value) = parse_value(&captures[2]) {
            current.insert(unquote(&captures[1]), value);
        }
    }
    flush(&mut name, &mut current, &mut servers, &mut errors);
    (servers, errors)
}
