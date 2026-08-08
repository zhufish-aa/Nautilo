//! Shell-command MCP import — port of capability-import/mcp-command.ts.

use serde_json::{json, Map, Value};

/// Splits a shell-ish command line into tokens, honouring single/double
/// quotes so paths with spaces survive. Backslashes are left alone because
/// Windows paths are the common case here.
fn tokenize(line: &str) -> Vec<String> {
    let mut tokens = vec![];
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut started = false;
    for ch in line.chars() {
        if let Some(q) = quote {
            if ch == q {
                quote = None;
            } else {
                current.push(ch);
            }
            continue;
        }
        if ch == '"' || ch == '\'' {
            quote = Some(ch);
            started = true;
            continue;
        }
        if ch.is_whitespace() {
            if started {
                tokens.push(std::mem::take(&mut current));
            }
            started = false;
            continue;
        }
        current.push(ch);
        started = true;
    }
    if started {
        tokens.push(current);
    }
    tokens
}

/// Derives a readable server name from the package or binary being launched.
fn infer_name(command: &str, args: &[String]) -> String {
    // `npx -y @scope/server-github` reads better as "server-github" than "npx".
    let package_arg = args.iter().find(|arg| !arg.starts_with('-'));
    let is_launcher = regex::Regex::new(r"(?i)^(npx|bunx|pnpm|yarn|uvx|uv|pipx|deno|node|python|python3)(\.\w+)?$")
        .map(|re| re.is_match(command))
        .unwrap_or(false);
    let basis = if is_launcher { package_arg.map(String::as_str).unwrap_or(command) } else { command };
    let without_version = regex::Regex::new(r"@[^@/]+$").map(|re| re.replace(basis, "").to_string()).unwrap_or_else(|_| basis.to_string());
    let last = without_version.split(['/', '\\']).next_back().unwrap_or(&without_version);
    let cleaned = regex::Regex::new(r"(?i)\.(exe|cmd|js|mjs|py)$")
        .map(|re| re.replace(last, "").to_string())
        .unwrap_or_else(|_| last.to_string());
    let cleaned = cleaned.trim_start_matches('@');
    if cleaned.is_empty() {
        command.to_string()
    } else {
        cleaned.to_string()
    }
}

/// Parses a copy-pasted launch command such as
/// `npx -y @modelcontextprotocol/server-filesystem D:/work`.
pub fn parse_mcp_command_line(input: &str) -> (Vec<Value>, Vec<String>) {
    let mut line = input.trim().to_string();
    line = regex::Regex::new(r"^[$>#]\s+").map(|re| re.replace(&line, "").to_string()).unwrap_or(line);
    if line.is_empty() {
        return (vec![], vec![]);
    }
    if line.contains('\n') {
        line = line.split('\n').map(str::trim).filter(|part| !part.is_empty()).collect::<Vec<_>>().join(" ");
    }

    let mut warnings: Vec<String> = vec![];
    let mut tokens = tokenize(&line);
    let env_assignment = regex::Regex::new(r"^([A-Za-z_][A-Za-z0-9_]*)=(.*)$").unwrap();
    let mut env = Map::new();
    // `env KEY=value cmd` — drop the wrapper before reading the assignments.
    if !tokens.is_empty() && tokens[0].eq_ignore_ascii_case("env") {
        tokens.remove(0);
    }
    // Leading KEY=value pairs are environment, not the command itself.
    while let Some(first) = tokens.first() {
        let Some(captures) = env_assignment.captures(first) else { break };
        env.insert(captures[1].to_string(), json!(captures[2].to_string()));
        tokens.remove(0);
    }

    if tokens.is_empty() {
        return (vec![], vec!["未解析出可执行命令".to_string()]);
    }
    let command = tokens.remove(0);
    if !env.is_empty() {
        warnings.push("已识别命令前的环境变量赋值".to_string());
    }

    let mut mcp = Map::new();
    mcp.insert("transport".to_string(), json!("stdio"));
    mcp.insert("command".to_string(), json!(command));
    if !tokens.is_empty() {
        mcp.insert("args".to_string(), json!(tokens));
    }
    if !env.is_empty() {
        mcp.insert("env".to_string(), Value::Object(env));
    }
    let name = infer_name(mcp.get("command").and_then(Value::as_str).unwrap_or(""), mcp.get("args").and_then(Value::as_array).map(|a| {
        a.iter().filter_map(Value::as_str).map(str::to_string).collect::<Vec<_>>()
    }).as_deref().unwrap_or(&[]));
    let candidate = json!({
        "name": name,
        "description": "",
        "tags": [],
        "mcp": Value::Object(mcp),
        "enabled": true,
        "warnings": warnings
    });
    (vec![candidate], vec![])
}
