use serde_json::{json, Value};
use std::collections::HashSet;

use crate::database::Repositories;
use crate::errors::{invalid, not_found, CoreResult};
use crate::runtime::run_service::capability_to_mcp_server;
use super::{connection_service::resolve_session_connection, session_service::effective_agent_id};
use agenthub_plugin_sdk::native_resources::is_native;

pub(crate) fn enabled_for(capability: &Value, provider: &str) -> bool {
    capability["enabled"] == true && capability["providerIds"].as_array()
        .is_some_and(|ids| ids.iter().any(|id| id == provider))
}

pub(crate) fn scope(db: &rusqlite::Connection, scope: &Value) -> CoreResult<(Value, Value)> {
    let repos = Repositories::new(db);
    let (session, agent_id) = if let Some(id) = scope["sessionId"].as_str() {
        let session = repos.sessions().get(id)?.ok_or_else(|| not_found("session", id))?;
        let agent_id = effective_agent_id(db, &session)?;
        (session, agent_id)
    } else {
        let agent_id = scope["agentInstanceId"].as_str().ok_or_else(|| invalid("agentInstanceId", "Select a Harness."))?;
        (scope.clone(), agent_id.to_owned())
    };
    let agent = repos.agents().get(&agent_id)?.ok_or_else(|| not_found("agent", &agent_id))?;
    let (agent, _) = resolve_session_connection(db, &session, &agent)?;
    Ok((session, agent))
}

pub(crate) fn catalog(db: &rusqlite::Connection, agent: &Value, native: Vec<Value>) -> CoreResult<Vec<Value>> {
    let repos = Repositories::new(db);
    let mut items = repos.capabilities().list_default()?.into_iter().filter(|capability| {
        enabled_for(capability, agent["providerId"].as_str().unwrap_or("")) && match capability["kind"].as_str() {
            Some("mcp") => capability_to_mcp_server(capability).is_some(),
            Some("skill") => capability.pointer("/skill/instructions").and_then(Value::as_str).is_some_and(|text| !text.trim().is_empty()),
            _ => false,
        }
    }).collect::<Vec<_>>();
    let mut names = items.iter().map(capability_name).collect::<HashSet<_>>();
    items.extend(native.into_iter()
        .filter(|item| names.insert(capability_name(item))));
    Ok(items)
}

fn capability_name(item: &Value) -> (String, String) {
    let name = item["name"].as_str().unwrap_or("");
    let name = if item["kind"] == "mcp" && !is_native(item["id"].as_str().unwrap_or("")) {
        capability_to_mcp_server(item).and_then(|server| server["name"].as_str().map(str::to_owned)).unwrap_or_else(||name.to_owned())
    } else { name.to_owned() };
    (item["kind"].as_str().unwrap_or("").to_owned(), name.to_lowercase())
}

pub(crate) fn project_root(db: &rusqlite::Connection, session: &Value) -> CoreResult<Option<String>> {
    let Some(project) = session["projectId"].as_str() else { return Ok(None) };
    Ok(Repositories::new(db).projects().get(project)?.and_then(|row| row["rootPath"].as_str().map(str::to_owned)))
}

pub(super) fn public_catalog(mut items: Vec<Value>) -> Vec<Value> {
    for item in &mut items {
        if let Some(fields) = item.as_object_mut() { fields.remove("mcp"); fields.remove("skill"); }
    }
    items
}

pub(crate) fn needs_native(input: &Value) -> bool {
    input.as_array().into_iter().flatten().any(|row| row["id"].as_str().is_some_and(is_native))
}

#[derive(Default)]
pub(crate) struct ComposerReferences {
    pub message: Vec<Value>,
    skills: Vec<Value>,
    tools: Vec<Value>,
}

impl ComposerReferences {
    pub fn append_to_prompt(&self, prompt: &mut String) {
        if self.message.is_empty() { return; }
        prompt.push_str("\n\n[NAUTILO_COMPOSER_REFERENCES]\nThe user explicitly attached these capabilities for this turn. Apply the selected skill instructions when relevant. Prefer the attached MCP service or exact tool when useful for this request, subject to the existing permissions. A reference alone is not an instruction to invoke a tool.\n");
        prompt.push_str(&json!({"skills": self.skills, "mcp": self.tools}).to_string());
    }

    pub fn write_message(self, message: &mut Value) {
        if self.message.is_empty() {
            if let Some(fields) = message.as_object_mut() { fields.remove("references"); }
        } else {
            message["references"] = json!(self.message);
        }
    }
}

pub(crate) fn resolve(db: &rusqlite::Connection, input: &Value, agent: &Value, native_items: &[Value]) -> CoreResult<ComposerReferences> {
    let mut resolved = ComposerReferences::default();
    if input.is_null() { return Ok(resolved); }
    let rows = input.as_array().filter(|rows| rows.len() <= 24)
        .ok_or_else(|| invalid("references", "Attach at most 24 Skill or MCP references per message."))?;
    let provider = agent["providerId"].as_str().unwrap_or("");
    let capabilities = Repositories::new(db).capabilities();
    let mut seen = HashSet::new();
    let mut instructions_bytes = 0;
    for row in rows {
        let id = row["id"].as_str().filter(|id| !id.is_empty() && id.len() <= 512)
            .ok_or_else(|| invalid("references", "A reference is missing its capability ID."))?;
        let kind = row["kind"].as_str().filter(|kind| matches!(*kind, "skill" | "mcp"))
            .ok_or_else(|| invalid("references", "Unknown capability reference kind."))?;
        let tool = if row["tool"].is_null() { None } else {
            Some(row["tool"].as_str().filter(|tool| kind == "mcp" && !tool.trim().is_empty() && tool.len() <= 256 && !tool.chars().any(char::is_control))
                .ok_or_else(|| invalid("references", "Invalid MCP tool name."))?)
        };
        if !seen.insert((kind, id, tool)) { continue; }
        let native = is_native(id);
        let capability = if native {
            native_items.iter().find(|item| item["id"] == id).cloned()
        } else { capabilities.get(id)? }.filter(|capability| capability["kind"] == kind && enabled_for(capability, provider))
            .ok_or_else(|| invalid("references", &format!("The attached {kind} is no longer available: {id}")))?;
        let name = capability["name"].as_str().unwrap_or(id);
        let mut reference = json!({"id": id, "kind": kind, "name": name});
        if kind == "skill" {
            let instructions = capability.pointer("/skill/instructions").and_then(Value::as_str)
                .filter(|text| !text.trim().is_empty())
                .ok_or_else(|| invalid("references", &format!("Skill {name} has no instructions.")))?;
            instructions_bytes += instructions.len();
            if instructions_bytes > 128 * 1024 {
                return Err(invalid("references", "The attached Skill instructions exceed 128 KB. Remove some references and retry."));
            }
            resolved.skills.push(json!({"name": name, "instructions": instructions}));
        } else {
            let server = if native { name.to_owned() } else {
                let config = capability_to_mcp_server(&capability).ok_or_else(|| invalid("references", "Invalid MCP configuration."))?;
                config["name"].as_str().unwrap_or(name).to_owned()
            };
            if let Some(tool) = tool { reference["tool"] = json!(tool); }
            resolved.tools.push(json!({"server": server, "tool": tool}));
        }
        resolved.message.push(reference);
    }
    Ok(resolved)
}
