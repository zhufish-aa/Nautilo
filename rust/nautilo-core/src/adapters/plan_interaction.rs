//! Plan-approval extraction — port of adapters/plan-interaction.ts.

use serde_json::{json, Map, Value};

const PLAN_TOOL_NAMES: [&str; 4] = ["exitplanmode", "exit_plan_mode", "plan_exit", "exit-plan-mode"];
const TEXT_KEYS: [&str; 7] = ["plan", "markdown", "text", "content", "output", "message", "description"];
const PATH_KEYS: [&str; 5] = ["planPath", "plan_path", "filePath", "file_path", "path"];

pub fn is_plan_exit_tool(name: &str) -> bool {
    PLAN_TOOL_NAMES.contains(&name.trim().to_lowercase().as_str())
}

fn collect_text(value: &Value, depth: usize) -> Vec<String> {
    if depth > 8 {
        return vec![];
    }
    match value {
        Value::String(text) if !text.trim().is_empty() => vec![text.clone()],
        Value::Array(items) => items.iter().flat_map(|item| collect_text(item, depth + 1)).collect(),
        Value::Object(map) => TEXT_KEYS
            .iter()
            .filter_map(|key| map.get(*key))
            .flat_map(|item| collect_text(item, depth + 1))
            .collect(),
        _ => vec![],
    }
}

fn find_path(value: &Value, depth: usize) -> Option<String> {
    if depth > 8 {
        return None;
    }
    match value {
        Value::Array(items) => items.iter().find_map(|item| find_path(item, depth + 1)),
        Value::Object(map) => {
            for key in PATH_KEYS {
                if let Some(path) = map.get(key).and_then(Value::as_str) {
                    let trimmed = path.trim();
                    if trimmed.to_lowercase().ends_with(".md") || trimmed.to_lowercase().ends_with(".mdown") {
                        return Some(trimmed.to_string());
                    }
                }
            }
            TEXT_KEYS.iter().filter_map(|key| map.get(*key)).find_map(|item| find_path(item, depth + 1))
        }
        _ => None,
    }
}

fn clean_candidate(text: &str) -> (String, Option<String>) {
    let mut content = text.replace("\r\n", "\n").replace('\r', "\n").trim().to_string();
    let mut source_path = None;
    if let Ok(re) = regex::Regex::new(r"(?i)^Plan saved to:\s*(.+?)\s*\n+") {
        if let Some(captures) = re.captures(&content) {
            source_path = captures.get(1).map(|m| m.as_str().trim().to_string());
            let end = captures.get(0).map(|m| m.end()).unwrap_or(0);
            content = content[end..].to_string();
        }
    }
    for pattern in [
        r"(?i)\n+\s*Requesting approval to (?:present(?:ing)?|show) the plan[\s\S]*$",
        r"(?i)\n+\s*Requesting approval to .*exit(?:ing)? plan mode[\s\S]*$",
    ] {
        if let Ok(re) = regex::Regex::new(pattern) {
            content = re.replace(&content, "").to_string();
        }
    }
    (content.trim().to_string(), source_path)
}

/// Extracts a readable plan from provider-native nested content. Providers
/// may send a plain `plan` string, content blocks, or a status wrapper
/// containing "Plan saved to: …" plus the full Markdown document.
pub fn extract_interaction_plan(value: &Value) -> Value {
    let mut candidates: Vec<(String, Option<String>)> = collect_text(value, 0)
        .iter()
        .map(|text| clean_candidate(text))
        .filter(|(content, _)| !content.is_empty() && !is_plan_exit_tool(content))
        .collect();
    let score = |content: &str| -> usize {
        let has_heading = regex::Regex::new(r"(^|\n)#{1,3}\s").map(|re| re.is_match(content)).unwrap_or(false);
        content.len() + if has_heading { 10_000 } else { 0 }
    };
    candidates.sort_by(|left, right| score(&right.0).cmp(&score(&left.0)));
    let best = candidates.into_iter().next();
    let mut plan = Map::new();
    plan.insert("content".to_string(), json!(best.as_ref().map(|b| b.0.clone()).unwrap_or_default()));
    if let Some(path) = best.and_then(|b| b.1).or_else(|| find_path(value, 0)) {
        plan.insert("sourcePath".to_string(), json!(path));
    }
    Value::Object(plan)
}
