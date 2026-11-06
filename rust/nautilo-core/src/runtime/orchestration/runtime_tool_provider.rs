//! Main-agent runtime tool provider — port of
//! runtime/orchestration/runtime-tool-provider.ts. Supplies orchestration
//! tools only to a root team session, never to a child.

use std::sync::{Arc, Mutex};

use serde_json::{json, Map, Value};

use crate::adapters::BoxFuture;
use crate::application::orchestration_service::OrchestrationService;
use crate::database::{Database, Repositories};
use crate::runtime::orchestration::official_web_search::{
    execute_official_web_search, official_web_search_tool, supports_official_web_search,
};
use crate::runtime::orchestration::runtime_tool_names::{RUNTIME_TOOL_DELEGATE, RUNTIME_TOOL_PLAN, RUNTIME_TOOL_WEB_SEARCH};
use crate::runtime::runtime_tool_provider::{RuntimeToolBinding, RuntimeToolProvider};
use crate::runtime::security::CredentialService;

fn member_summary(session: &Value, db: &Arc<Mutex<Database>>) -> Vec<Value> {
    let team_id = session.get("teamId").and_then(Value::as_str);
    let team = team_id.and_then(|id| Repositories::new(&db.lock().unwrap().raw).teams().get(id).ok().flatten());
    let Some(team) = team else {
        return vec![];
    };
    let main_member_id = team.get("mainMemberId").and_then(Value::as_str);
    team.get("members")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter(|member| {
            member.get("enabled").and_then(Value::as_bool) == Some(true)
                && member.get("id").and_then(Value::as_str) != main_member_id
        })
        .map(|member| {
            let role_id = member.get("roleId").and_then(Value::as_str);
            let role_name = team.get("roles").and_then(Value::as_array).and_then(|roles| {
                roles
                    .iter()
                    .find(|role| role.get("id").and_then(Value::as_str) == role_id)
                    .and_then(|role| role.get("name").and_then(Value::as_str))
                    .map(str::to_string)
            });
            json!({
                "id": member.get("id").cloned().unwrap_or(Value::Null),
                "name": member.get("displayName").cloned().unwrap_or(Value::Null),
                "role": role_name.map(Value::String).unwrap_or(Value::Null)
            })
        })
        .collect()
}

fn delegation_specs(session: &Value, db: &Arc<Mutex<Database>>) -> Vec<Value> {
    let members = member_summary(session, db);
    let member_ids: Vec<String> = members.iter().filter_map(|m| m.get("id").and_then(Value::as_str).map(str::to_string)).collect();
    let members_text = members
        .iter()
        .map(|member| {
            let id = member.get("id").and_then(Value::as_str).unwrap_or("");
            let name = member.get("name").and_then(Value::as_str).unwrap_or("");
            let role = member.get("role").and_then(Value::as_str);
            match role {
                Some(role) => format!("{id} ({name}, {role})"),
                None => format!("{id} ({name})"),
            }
        })
        .collect::<Vec<_>>()
        .join(", ");
    let member_schema = if member_ids.is_empty() {
        json!({ "type": "string" })
    } else {
        json!({ "type": "string", "enum": member_ids })
    };
    vec![
        json!({
            "name": RUNTIME_TOOL_DELEGATE,
            "description": format!("Dispatch one self-contained task to a configured Nautilo member using that member's Harness, connection and model. Honor explicit user requests to delegate, including small tasks. Available members: {members_text}. The child cannot read the parent or sibling Agent sessions, pending results, or chat-only attachments/images. Include all required context in task text. Success returns a real taskId and sessionId; it does not mean the task has completed."),
            "inputSchema": {
                "type": "object",
                "additionalProperties": false,
                "required": ["memberId", "task"],
                "properties": {
                    "memberId": member_schema,
                    "task": { "type": "string", "minLength": 1, "description": "A concrete, self-contained task. Do not refer to unseen chat attachments or ask the child to obtain another Agent's context or result." },
                    "continueSessionId": { "type": "string", "description": "Optional compatible child session to continue; omit to start a fresh child session." }
                }
            }
        }),
        json!({
            "name": RUNTIME_TOOL_PLAN,
            "description": format!("Optionally dispatch a small dependency graph of self-contained tasks to configured child Agents and continue your current turn. Available members: {members_text}. Children cannot inspect sibling sessions; use dependsOn so Nautilo can supply completed dependency outcomes. Chat-only attachments/images are not forwarded."),
            "inputSchema": {
                "type": "object",
                "additionalProperties": false,
                "required": ["tasks"],
                "properties": {
                    "tasks": {
                        "type": "array",
                        "minItems": 1,
                        "maxItems": 50,
                        "items": {
                            "type": "object",
                            "additionalProperties": false,
                            "required": ["id", "memberId", "task"],
                            "properties": {
                                "id": { "type": "string", "minLength": 1, "description": "A plan-local task ID used by dependsOn." },
                                "memberId": member_schema,
                                "task": { "type": "string", "minLength": 1, "description": "A self-contained task with no references to unseen parent-chat attachments or sibling Agent state." },
                                "dependsOn": { "type": "array", "items": { "type": "string" }, "default": [] },
                                "continueSessionId": { "type": "string" }
                            }
                        }
                    }
                }
            }
        }),
    ]
}

pub struct MainAgentRuntimeToolProvider {
    db: Arc<Mutex<Database>>,
    orchestration: Arc<OrchestrationService>,
    credentials: Arc<CredentialService>,
}

impl MainAgentRuntimeToolProvider {
    pub fn new(db: Arc<Mutex<Database>>, orchestration: Arc<OrchestrationService>, credentials: Arc<CredentialService>) -> Self {
        Self { db, orchestration, credentials }
    }
}

impl RuntimeToolProvider for MainAgentRuntimeToolProvider {
    fn for_run(&self, session: &Value, context: &Value, agent: &Value) -> Option<RuntimeToolBinding> {
        let can_delegate = context.get("messageKind").and_then(Value::as_str) != Some("planner_decision")
            && session.get("parentSessionId").is_none()
            && session.get("teamId").is_some()
            && session.get("projectRunId").is_some()
            && Repositories::new(&self.db.lock().unwrap().raw)
                .project_runs()
                .get(session.get("projectRunId").and_then(Value::as_str).unwrap_or(""))
                .ok()
                .flatten()
                .and_then(|run| run.get("mainSessionId").and_then(Value::as_str).map(str::to_string))
                == session.get("id").and_then(Value::as_str).map(str::to_string)
            && Repositories::new(&self.db.lock().unwrap().raw)
                .teams()
                .get(session.get("teamId").and_then(Value::as_str).unwrap_or(""))
                .ok()
                .flatten()
                .and_then(|team| team.get("delegationPolicy").and_then(Value::as_str).map(str::to_string))
                .as_deref()
                != Some("direct_only")
            && !member_summary(session, &self.db).is_empty();
        let can_official_search = supports_official_web_search(agent, &self.db);
        if !can_delegate && !can_official_search {
            return None;
        }
        let mut tools = vec![];
        if can_official_search {
            tools.push(official_web_search_tool());
        }
        if can_delegate {
            tools.extend(delegation_specs(session, &self.db));
        }
        let orchestration = self.orchestration.clone();
        let credentials = self.credentials.clone();
        let db = self.db.clone();
        let session_id = session.get("id").and_then(Value::as_str).unwrap_or("").to_string();
        let agent = agent.clone();
        Some(RuntimeToolBinding {
            tools,
            execute: Arc::new(move |call: Value| {
                let orchestration = orchestration.clone();
                let credentials = credentials.clone();
                let db = db.clone();
                let session_id = session_id.clone();
                let agent = agent.clone();
                Box::pin(async move {
                    let name = call.get("name").and_then(Value::as_str).unwrap_or("");
                    if name == RUNTIME_TOOL_WEB_SEARCH {
                        Ok(execute_official_web_search(&call, &agent, &db, &credentials).await)
                    } else {
                        orchestration.invoke_runtime_tool(&session_id, name, call.get("arguments").cloned().unwrap_or(Value::Null)).await
                    }
                }) as BoxFuture<anyhow::Result<Value>>
            }),
        })
    }
}
