//! Provider-specific MCP entry serialization and redacted public previews.
use serde_json::{json, Value};

pub(super) fn native_mcp(server: &Value, provider: &str) -> Value {
    let remote = server["transport"] == "http";
    let mut out = serde_json::Map::new();
    if provider == "opencode" {
        out.insert("enabled".into(), json!(true));
        out.insert(
            "type".into(),
            json!(if remote { "remote" } else { "local" }),
        );
        if remote {
            out.insert("url".into(), server["url"].clone());
            if server["headers"].is_object() {
                out.insert("headers".into(), server["headers"].clone());
            }
        } else {
            let mut cmd = vec![server["command"].clone()];
            cmd.extend(server["args"].as_array().cloned().unwrap_or_default());
            out.insert("command".into(), json!(cmd));
            if server["env"].is_object() {
                out.insert("environment".into(), server["env"].clone());
            }
        }
    } else {
        if provider != "codex" {
            out.insert("type".into(), json!(if remote { "http" } else { "stdio" }));
        }
        for key in if remote {
            vec!["url", "headers"]
        } else {
            vec!["command", "args", "env", "cwd"]
        } {
            if let Some(value) = server.get(key).filter(|v| !v.is_null()) {
                out.insert(
                    if provider == "codex" && key == "headers" {
                        "http_headers".into()
                    } else {
                        key.into()
                    },
                    value.clone(),
                );
            }
        }
    }
    json!(out)
}
pub(super) fn safe_preview(value: &Value) -> Value {
    let mut v = value.clone();
    if let Some(o) = v.as_object_mut() {
        for (k, v) in o {
            if matches!(
                k.as_str(),
                "env" | "environment" | "headers" | "http_headers"
            ) {
                if let Some(map) = v.as_object_mut() {
                    for value in map.values_mut() {
                        *value = json!("[REDACTED]");
                    }
                }
            }
        }
    }
    v
}
