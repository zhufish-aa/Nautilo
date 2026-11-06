//! Slash command catalogs — port of application/slash-commands/*-catalog.ts
//! and catalog.ts. Static definitions are byte-identical to the TS catalogs.

use serde_json::{json, Map, Value};

pub fn codex_slash_commands() -> Vec<Value> {
    serde_json::from_str(include_str!("codex_catalog.json")).unwrap_or_default()
}

pub fn kimi_slash_commands() -> Vec<Value> {
    serde_json::from_str(include_str!("kimi_catalog.json")).unwrap_or_default()
}

pub fn claude_slash_commands() -> Vec<Value> {
    serde_json::from_str(include_str!("claude_catalog.json")).unwrap_or_default()
}

fn valid_native_name(name: &str) -> bool {
    !name.is_empty() && name.chars().all(|c|c.is_alphanumeric() || "_-.:".contains(c))
}

fn kimi_title(name: &str) -> &str {
    match name {
        "compact" => "压缩上下文",
        "status" => "会话状态",
        "usage" => "上下文用量",
        "mcp" => "MCP 状态",
        "tasks" => "后台任务",
        "help" => "Kimi ACP 帮助",
        other => other,
    }
}

/// Verified against `kimi acp` /help on Kimi Code CLI 0.27.0.
pub fn kimi_provider_command(input: &Value) -> Option<Value> {
    let name = input.get("name").and_then(Value::as_str).unwrap_or("").trim_start_matches('/').to_string();
    if !valid_native_name(&name) {
        return None;
    }
    let mut command = Map::new();
    command.insert("id".to_string(), json!(format!("kimi-code.native.{name}")));
    command.insert("name".to_string(), json!(format!("/{name}")));
    command.insert("aliases".to_string(), json!([]));
    command.insert("title".to_string(), json!(kimi_title(&name)));
    command.insert("description".to_string(), input.get("description").cloned().unwrap_or(Value::Null));
    command.insert(
        "icon".to_string(),
        json!(if name == "compact" || name == "usage" { "usage" } else if name == "help" { "help" } else { "status" }),
    );
    command.insert("availability".to_string(), json!(if name == "compact" { "idle" } else { "always" }));
    command.insert("execution".to_string(), json!("provider"));
    if let Some(hint) = input.get("inputHint").and_then(Value::as_str) {
        command.insert("argumentHint".to_string(), json!(hint));
    }
    Some(Value::Object(command))
}


fn claude_title(name: &str) -> &str {
    match name {
        "compact" => "压缩上下文",
        "cost" => "用量与费用",
        "doctor" => "环境诊断",
        "export" => "导出会话",
        "init" => "初始化 CLAUDE.md",
        "mcp" => "MCP 状态",
        "review" => "代码审查",
        "security-review" => "安全审查",
        other => other,
    }
}

/// Slash commands that run non-interactively under `claude -p` (verified
/// against Claude Code CLI 2.1).
pub fn claude_provider_command(input: &Value) -> Option<Value> {
    let name = input.get("name").and_then(Value::as_str).unwrap_or("").trim_start_matches('/').to_string();
    if !valid_native_name(&name) {
        return None;
    }
    let description = input.get("description").and_then(Value::as_str).unwrap_or("");
    let mut command = Map::new();
    command.insert("id".to_string(), json!(format!("claude-code.native.{name}")));
    command.insert("name".to_string(), json!(format!("/{name}")));
    command.insert("aliases".to_string(), json!([]));
    command.insert("title".to_string(), json!(claude_title(&name)));
    command.insert(
        "description".to_string(),
        json!(if description == name { format!("由 Claude Code CLI 执行 /{name}") } else { description.to_string() }),
    );
    command.insert("icon".to_string(), json!(if name == "compact" || name == "cost" { "usage" } else { "status" }));
    // Commands use the session's native stream, after its active turn settles.
    command.insert("availability".to_string(), json!("idle"));
    command.insert("execution".to_string(), json!("provider"));
    if let Some(hint) = input.get("inputHint").and_then(Value::as_str) {
        command.insert("argumentHint".to_string(), json!(hint));
    }
    Some(Value::Object(command))
}

/// Fallback for providers without a built-in factory (plugin providers such
/// as OpenCode): a plugin reports only the commands it can execute
/// headlessly, so every reported command maps through.
fn generic_provider_command(provider_id: &str, input: &Value) -> Option<Value> {
    let name = input.get("name").and_then(Value::as_str).unwrap_or("").trim_start_matches('/').to_string();
    if !valid_native_name(&name) {
        return None;
    }
    let compact = input.get("providerCommand").and_then(Value::as_str) == Some("compact") || name == "compact";
    let mut command = Map::new();
    command.insert("id".to_string(), json!(format!("{provider_id}.native.{name}")));
    command.insert("name".to_string(), json!(format!("/{name}")));
    command.insert("aliases".to_string(), json!([]));
    command.insert("title".to_string(), json!(if name == "compact" { "压缩上下文" } else { name.as_str() }));
    command.insert("description".to_string(), input.get("description").cloned().unwrap_or(Value::Null));
    command.insert(
        "icon".to_string(),
        json!(if compact || name == "usage" { "usage" } else if name == "help" { "help" } else { "status" }),
    );
    command.insert("availability".to_string(), json!(if compact { "idle" } else { "always" }));
    command.insert("execution".to_string(), json!("provider"));
    if let Some(provider_command) = input.get("providerCommand").and_then(Value::as_str) {
        command.insert("providerCommand".to_string(), json!(provider_command));
    }
    if let Some(hint) = input.get("inputHint").and_then(Value::as_str) {
        command.insert("argumentHint".to_string(), json!(hint));
    }
    Some(Value::Object(command))
}

pub fn slash_command_catalog(provider_id: &str, provider_commands: &[Value]) -> Vec<Value> {
    let mut base = match provider_id {
        "codex" => codex_slash_commands(),
        "kimi-code" => kimi_slash_commands(),
        "claude-code" => claude_slash_commands(),
        _ => vec![],
    };
    if provider_commands.is_empty() {
        return base;
    }
    let mut by_name: Map<String, Value> = base
        .drain(..)
        .filter_map(|command| command.get("name").and_then(Value::as_str).map(|name| (name.to_string(), command.clone())))
        .collect::<serde_json::Map<String, Value>>()
        .into_iter()
        .collect();
    for command in provider_commands {
        let definition = match provider_id {
            "kimi-code" => kimi_provider_command(command),
            "claude-code" => claude_provider_command(command),
            other => generic_provider_command(other, command),
        };
        if let Some(definition) = definition {
            let name = definition.get("name").and_then(Value::as_str).unwrap_or("").to_string();
            by_name.entry(name).or_insert(definition);
        }
    }
    by_name.into_values().collect()
}
