//! Sub-agent dispatch detection — port of runtime/subagent-detection.ts.
//! A single point in the run pipeline recognizes provider-native sub-agent
//! dispatches (Claude's Task, Kimi's Agent, opencode's task, Codex's
//! spawn_agent) so adapters stay untouched.

use serde_json::{json, Map, Value};

const SUBAGENT_TOOL_NAMES: [&str; 4] = ["task", "agent", "spawnagent", "subagent"];
const TASK_TRUNCATE: usize = 200;

fn text_field(input: &serde_json::Map<String, Value>, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        input.get(*key).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)
    })
}

pub fn subagent_meta(tool_name: &str, input: Option<&Value>) -> Option<Value> {
    let normalized: String = tool_name.trim().to_lowercase().chars().filter(|c| c.is_ascii_alphanumeric()).collect();
    if !SUBAGENT_TOOL_NAMES.contains(&normalized.as_str()) {
        return None;
    }
    let record = input?.as_object()?;
    // A dispatch always carries some task text or an agent type; a bare name
    // hit without either is more likely a same-named unrelated tool.
    let agent_type = text_field(record, &["subagent_type", "subagentType", "agent_type", "agentType", "agent"]);
    let description = text_field(record, &["description", "task", "title"]);
    let prompt = text_field(record, &["prompt", "instruction", "instructions", "message", "goal"]);
    if agent_type.is_none() && description.is_none() && prompt.is_none() {
        return None;
    }
    let task = description.or_else(|| {
        prompt.map(|prompt| {
            if prompt.chars().count() > TASK_TRUNCATE {
                format!("{}…", prompt.chars().take(TASK_TRUNCATE).collect::<String>())
            } else {
                prompt
            }
        })
    });
    // Kimi's Agent tool uses run_in_background, opencode's task uses background.
    let background = record.get("run_in_background").and_then(Value::as_bool) == Some(true)
        || record.get("runInBackground").and_then(Value::as_bool) == Some(true)
        || record.get("background").and_then(Value::as_bool) == Some(true);
    let mut meta = Map::new();
    if let Some(agent_type) = agent_type {
        meta.insert("agentType".to_string(), json!(agent_type));
    }
    if let Some(task) = task {
        meta.insert("task".to_string(), json!(task));
    }
    if background {
        meta.insert("background".to_string(), json!(true));
    }
    Some(Value::Object(meta))
}
