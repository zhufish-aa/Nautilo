//! MCP JSON config parsing — port of capability-import/mcp-json.ts.

use serde_json::{json, Map, Value};

use crate::application::capability_import::warnings_regex::*;

fn is_server_like(value: &Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    ["command", "url", "serverUrl", "endpoint", "type", "transport", "args"].iter().any(|key| object.contains_key(*key))
}

fn read_string<'a>(source: &'a Map<String, Value>, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| source.get(*key).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string))
}

fn read_string_array(value: Option<&Value>, warnings: &mut Vec<String>, label: &str) -> Vec<String> {
    let Some(value) = value.filter(|v| !v.is_null()) else {
        return vec![];
    };
    let Some(items) = value.as_array() else {
        warnings.push(format!("{label} 不是数组，已忽略"));
        return vec![];
    };
    items
        .iter()
        .map(|item| item.as_str().map(str::to_string).unwrap_or_else(|| item.to_string()))
        .filter(|item| !item.is_empty())
        .collect()
}

/// Coerces stray numbers/booleans instead of dropping the whole entry.
fn read_record(value: Option<&Value>, warnings: &mut Vec<String>, label: &str) -> Map<String, Value> {
    let mut record = Map::new();
    let Some(value) = value.filter(|v| !v.is_null()) else {
        return record;
    };
    let Some(object) = value.as_object() else {
        warnings.push(format!("{label} 不是对象，已忽略"));
        return record;
    };
    for (key, raw) in object {
        match raw {
            Value::String(_) => {
                record.insert(key.clone(), raw.clone());
            }
            Value::Number(_) | Value::Bool(_) => {
                record.insert(key.clone(), json!(raw.to_string()));
                warnings.push(format!("{label}.{key} 不是字符串，已转换为字符串"));
            }
            _ => warnings.push(format!("{label}.{key} 类型不支持，已忽略")),
        }
    }
    record
}

fn resolve_transport(source: &Map<String, Value>, warnings: &mut Vec<String>) -> Option<&'static str> {
    if let Some(declared) = read_string(source, &["type", "transport"]).map(|d| d.to_lowercase()) {
        match declared.as_str() {
            "stdio" | "local" => return Some("stdio"),
            "http" | "streamable-http" | "streamablehttp" | "https" => return Some("http"),
            "sse" => {
                warnings.push("SSE 传输已按 HTTP 处理".to_string());
                return Some("http");
            }
            _ => warnings.push("未知的传输类型，已按字段推断".to_string()),
        }
    }
    if read_string(source, &["command"]).is_some() {
        return Some("stdio");
    }
    if read_string(source, &["url", "serverUrl", "endpoint"]).is_some() {
        return Some("http");
    }
    None
}

/// Moves ${VAR} placeholders out of literal env values into envPassthrough.
fn split_env(raw: Map<String, Value>, warnings: &mut Vec<String>) -> (Map<String, Value>, Vec<String>) {
    let mut env = Map::new();
    let mut env_passthrough: Vec<String> = vec![];
    for (key, value) in raw {
        let Some(value) = value.as_str().map(str::to_string) else { continue };
        if let Some(env_name) = placeholder_env_name(&value) {
            if env_name == key {
                env_passthrough.push(key.clone());
                continue;
            }
            // A cross-name reference degrades to same-name passthrough + warning.
            warnings.push(format!("env.{key} 原本引用 ${{{env_name}}}，已改为透传同名变量 {key}"));
            env_passthrough.push(key.clone());
            continue;
        }
        if value.contains("${") {
            warnings.push(format!("env.{key} 含无法解析的占位符，请手动确认"));
        } else if looks_like_secret(&key, &value) {
            warnings.push(format!("env.{key} 是明文密钥，建议改用环境变量透传"));
        }
        env.insert(key, json!(value));
    }
    (env, env_passthrough)
}

fn split_headers(
    raw: Map<String, Value>,
    warnings: &mut Vec<String>,
) -> (Map<String, Value>, Map<String, Value>, Option<String>) {
    let mut headers = Map::new();
    let mut env_headers = Map::new();
    let mut bearer_token_env_var = None;
    for (header, value) in raw {
        let Some(value) = value.as_str().map(str::to_string) else { continue };
        if header.eq_ignore_ascii_case("authorization") {
            if let Some(bearer) = bearer_placeholder_env_name(&value) {
                bearer_token_env_var = Some(bearer);
                continue;
            }
        }
        if let Some(env_name) = placeholder_env_name(&value) {
            env_headers.insert(header.clone(), json!(env_name));
            continue;
        }
        if value.contains("${") {
            warnings.push(format!("请求头 {header} 含无法解析的占位符，请手动确认"));
        } else if looks_like_secret(&header, &value) {
            warnings.push(format!("请求头 {header} 含明文密钥，建议改用环境变量"));
        }
        headers.insert(header, json!(value));
    }
    (headers, env_headers, bearer_token_env_var)
}

/// Turns one entry of an mcpServers map into a preview candidate.
pub fn to_mcp_candidate(name: &str, source: &Value, origin: Option<&str>) -> Option<Value> {
    let source = source.as_object()?;
    let mut warnings: Vec<String> = vec![];
    let transport = resolve_transport(source, &mut warnings)?;

    let mut mcp = Map::new();
    if transport == "stdio" {
        let command = read_string(source, &["command"])?;
        mcp.insert("transport".to_string(), json!("stdio"));
        mcp.insert("command".to_string(), json!(command));
        let args = read_string_array(source.get("args"), &mut warnings, "args");
        if !args.is_empty() {
            mcp.insert("args".to_string(), json!(args));
        }
        let (env, env_passthrough) = split_env(read_record(source.get("env"), &mut warnings, "env"), &mut warnings);
        if !env.is_empty() {
            mcp.insert("env".to_string(), Value::Object(env));
        }
        if !env_passthrough.is_empty() {
            let mut seen = std::collections::HashSet::new();
            let unique: Vec<String> = env_passthrough.into_iter().filter(|item| seen.insert(item.clone())).collect();
            mcp.insert("envPassthrough".to_string(), json!(unique));
        }
        if let Some(cwd) = read_string(source, &["cwd", "workingDirectory"]) {
            mcp.insert("cwd".to_string(), json!(cwd));
        }
    } else {
        let url = read_string(source, &["url", "serverUrl", "endpoint"])?;
        mcp.insert("transport".to_string(), json!("http"));
        mcp.insert("url".to_string(), json!(url));
        let (headers, env_headers, bearer_token_env_var) =
            split_headers(read_record(source.get("headers"), &mut warnings, "headers"), &mut warnings);
        if let Some(bearer) = bearer_token_env_var {
            mcp.insert("bearerTokenEnvVar".to_string(), json!(bearer));
        }
        if !headers.is_empty() {
            mcp.insert("headers".to_string(), Value::Object(headers));
        }
        if !env_headers.is_empty() {
            mcp.insert("envHeaders".to_string(), Value::Object(env_headers));
        }
    }

    let disabled = source.get("disabled").and_then(Value::as_bool) == Some(true)
        || source.get("enabled").and_then(Value::as_bool) == Some(false);
    if disabled {
        warnings.push("来源中该服务为停用状态，导入后保持停用".to_string());
    }

    let mut candidate = Map::new();
    candidate.insert("name".to_string(), json!(if name.trim().is_empty() { "mcp-server" } else { name.trim() }));
    candidate.insert(
        "description".to_string(),
        read_string(source, &["description"]).map(Value::String).unwrap_or_else(|| json!("")),
    );
    candidate.insert("tags".to_string(), json!(read_string_array(source.get("tags"), &mut vec![], "tags")));
    candidate.insert("mcp".to_string(), Value::Object(mcp));
    candidate.insert("enabled".to_string(), json!(!disabled));
    candidate.insert("warnings".to_string(), json!(warnings));
    if let Some(origin) = origin {
        candidate.insert("origin".to_string(), json!(origin));
    }
    Some(Value::Object(candidate))
}

/// Collects every container that holds a server map (mcpServers, VS Code's
/// servers, mcp.servers, per-project blocks in ~/.claude.json, bare maps).
fn find_server_maps(root: &Map<String, Value>) -> Vec<(Map<String, Value>, Option<String>)> {
    let mut found: Vec<(Map<String, Value>, Option<String>)> = vec![];
    for candidate in [root.get("mcpServers"), root.get("servers")] {
        if let Some(map) = candidate.and_then(Value::as_object) {
            found.push((map.clone(), None));
        }
    }
    if let Some(mcp) = root.get("mcp").and_then(Value::as_object) {
        for candidate in [mcp.get("servers"), mcp.get("mcpServers")] {
            if let Some(map) = candidate.and_then(Value::as_object) {
                found.push((map.clone(), None));
            }
        }
    }
    if let Some(projects) = root.get("projects").and_then(Value::as_object) {
        for (project_path, project) in projects {
            if let Some(map) = project.get("mcpServers").and_then(Value::as_object) {
                found.push((map.clone(), Some(project_path.clone())));
            }
        }
    }
    if !found.is_empty() {
        return found;
    }
    // A bare map counts only when every value looks like a server.
    if !root.is_empty() && root.values().all(is_server_like) {
        return vec![(root.clone(), None)];
    }
    vec![]
}

/// Parses any of the common MCP config shapes into preview candidates.
pub fn parse_mcp_config_json(text: &str, origin: Option<&str>) -> (Vec<Value>, Vec<String>) {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return (vec![], vec![]);
    }
    let root: Value = match serde_json::from_str(trimmed) {
        Ok(value) => value,
        Err(error) => return (vec![], vec![format!("JSON 解析失败：第 {} 行，第 {} 列", error.line(), error.column())]),
    };

    if let Value::Array(entries) = &root {
        let mut servers = vec![];
        let mut errors = vec![];
        for (index, entry) in entries.iter().enumerate() {
            let Some(object) = entry.as_object() else { continue };
            let name = read_string(object, &["name"]).unwrap_or_else(|| format!("server-{}", index + 1));
            match to_mcp_candidate(&name, entry, origin) {
                Some(candidate) => servers.push(candidate),
                None => errors.push(format!("第 {} 项缺少 command 或 url，已跳过", index + 1)),
            }
        }
        return (servers, errors);
    }

    let Some(object) = root.as_object() else {
        return (vec![], vec!["无法识别的 JSON 结构".to_string()]);
    };
    let maps = find_server_maps(object);
    if maps.is_empty() {
        if is_server_like(&root) {
            let name = read_string(object, &["name"]).unwrap_or_else(|| "mcp-server".to_string());
            if let Some(candidate) = to_mcp_candidate(&name, &root, origin) {
                return (vec![candidate], vec![]);
            }
        }
        return (vec![], vec!["未找到 mcpServers 配置".to_string()]);
    }

    let mut servers = vec![];
    let mut errors = vec![];
    let mut seen = std::collections::HashSet::new();
    for (map, scope) in maps {
        for (name, value) in &map {
            if !value.is_object() {
                continue;
            }
            let entry_origin = match &scope {
                Some(scope) => Some(format!("{} · {scope}", origin.unwrap_or("")).trim().to_string()),
                None => origin.map(str::to_string),
            };
            match to_mcp_candidate(name, value, entry_origin.as_deref()) {
                Some(candidate) => {
                    // The same server usually appears in both the global and
                    // project blocks; keep the first.
                    let key = candidate.get("name").and_then(Value::as_str).unwrap_or("").to_lowercase();
                    if seen.insert(key) {
                        servers.push(candidate);
                    }
                }
                None => errors.push(format!("\"{name}\" 缺少 command 或 url，已跳过")),
            }
        }
    }
    (servers, errors)
}

#[cfg(test)]
mod diagnostic_privacy_tests {
    use super::parse_mcp_config_json;

    #[test]
    fn diagnostics_do_not_echo_secret_values() {
        let secret = "secret-value-123456";
        let (_, errors) = parse_mcp_config_json(&format!("{{\"token\":\"{secret}\", bad}}"), None);
        assert!(!errors.is_empty());
        assert!(!errors.join(" ").contains(secret));
        let json = format!(r#"{{"mcpServers":{{"local":{{"command":"npx","env":{{"TOKEN":"{secret}-${{input:bad}}"}}}},"remote":{{"url":"https://example.com","headers":{{"Authorization":"{secret}-${{input:bad}}"}}}}}}}}"#);
        let (servers, _) = parse_mcp_config_json(&json, None);
        let warnings = servers.iter().map(|server| server["warnings"].to_string()).collect::<Vec<_>>().join(" ");
        assert!(warnings.contains("无法解析的占位符"));
        assert!(!warnings.contains(secret));
    }
}
