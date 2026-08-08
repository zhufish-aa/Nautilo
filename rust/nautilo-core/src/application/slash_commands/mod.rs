//! Slash command service — port of application/slash-commands/slash-command-service.ts.

use std::sync::{Arc, Mutex};

use serde_json::{json, Map, Value};

use crate::application::agent_service::AgentService;
use crate::application::slash_commands::catalog::slash_command_catalog;
use crate::database::{Database, Repositories};
use crate::errors::{now_iso, CoreError, CoreResult, ErrorCode};
use crate::runtime::observability::AuditService;
use crate::runtime::orchestration::member_router::MemberRouter;
use crate::runtime::run_service::{RunContext, RunService};

pub mod catalog;

fn invalid_details(details: &[(&str, Value)]) -> CoreError {
    let mut map = Map::new();
    for (key, value) in details {
        map.insert(key.to_string(), value.clone());
    }
    CoreError::details(ErrorCode::IpcInvalidRequest, map)
}

fn provider_label(provider_id: &str) -> &str {
    match provider_id {
        "codex" => "Codex",
        "kimi-code" => "Kimi Code",
        "claude-code" => "Claude Code",
        other => other,
    }
}

fn effort_label(value: &str) -> String {
    match value.to_lowercase().as_str() {
        "low" => "Low",
        "medium" => "Medium",
        "high" => "High",
        "xhigh" => "Extra High",
        "max" => "Max",
        "ultra" => "Ultra",
        _ => value,
    }
    .to_string()
}

fn token_label(value: i64) -> String {
    if value >= 1_000_000 {
        format!("{:.1}M tokens", value as f64 / 1_000_000.0)
    } else if value >= 1_000 {
        format!("{:.1}K tokens", value as f64 / 1_000.0)
    } else {
        format!("{value} tokens")
    }
}

struct CommandContext {
    session: Value,
    agent: Value,
    catalog: Value,
    model: Option<Value>,
}

pub struct SlashCommandService {
    db: Arc<Mutex<Database>>,
    agents: Arc<AgentService>,
    audit: Arc<AuditService>,
    runs: Arc<RunService>,
}

impl SlashCommandService {
    pub fn new(db: Arc<Mutex<Database>>, agents: Arc<AgentService>, audit: Arc<AuditService>, runs: Arc<RunService>) -> Self {
        Self { db, agents, audit, runs }
    }

    pub fn list(&self, session_id: &str) -> CoreResult<Vec<Value>> {
        let (session, agent) = self.resolve_base(session_id)?;
        // Runtime reports override descriptor defaults with the same name.
        let runtime = self.latest_provider_commands(session_id, agent.get("providerId").and_then(Value::as_str).unwrap_or(""));
        let defaults = self.native_commands(agent.get("providerId").and_then(Value::as_str).unwrap_or(""));
        let runtime_names: std::collections::HashSet<String> = runtime
            .iter()
            .filter_map(|command| command.get("name").and_then(Value::as_str).map(|n| n.trim_start_matches('/').to_string()))
            .collect();
        let merged: Vec<Value> = runtime
            .into_iter()
            .chain(
                defaults
                    .into_iter()
                    .filter(|command| {
                        !runtime_names.contains(command.get("name").and_then(Value::as_str).unwrap_or("").trim_start_matches('/'))
                    }),
            )
            .collect();
        let _ = session;
        Ok(slash_command_catalog(agent.get("providerId").and_then(Value::as_str).unwrap_or(""), &merged))
    }

    pub async fn execute(&self, session_id: &str, command_id: &str, argument: Option<&str>) -> CoreResult<Value> {
        let context = self.resolve(session_id).await?;
        let command = self.assert_command(session_id, command_id)?;
        if command.get("execution").and_then(Value::as_str) == Some("provider") {
            return self.execute_provider_command(&context, &command, argument).await;
        }
        let action = command_id.split('.').last().unwrap_or("");
        let result = match action {
            "help" => self.help(session_id, context.agent.get("providerId").and_then(Value::as_str).unwrap_or(""))?,
            "model" => self.model_picker(&context),
            "reasoning" | "thinking" => self.reasoning_picker(&context, command_id),
            "fast" => self.speed_picker(&context),
            "status" => self.status(&context),
            "usage" => self.usage(&context),
            "rename" => self.rename(&context, argument)?,
            _ => return Err(invalid_details(&[("commandId", json!(command_id))])),
        };
        self.record(session_id, command_id, "opened", None);
        Ok(result)
    }

    pub async fn continue_command(&self, input: &Value) -> CoreResult<Value> {
        let session_id = input.get("sessionId").and_then(Value::as_str).unwrap_or("");
        let command_id = input.get("commandId").and_then(Value::as_str).unwrap_or("");
        let action_id = input.get("actionId").and_then(Value::as_str).unwrap_or("");
        let context = self.resolve(session_id).await?;
        self.assert_command(session_id, command_id)?;
        if action_id == "close" {
            return Ok(json!({ "commandId": command_id, "title": "已关闭", "sections": [], "actions": [], "completed": true }));
        }
        if action_id != "apply" {
            return Err(invalid_details(&[("actionId", json!(action_id))]));
        }
        let selected: Vec<&str> = input
            .get("selectedOptionIds")
            .and_then(Value::as_array)
            .map(|ids| ids.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();
        if selected.len() != 1 {
            return Err(invalid_details(&[("reason", json!("exactly_one_selection_required"))]));
        }
        let value = selected[0];
        let action = command_id.split('.').last().unwrap_or("");
        let patch: Map<String, Value> = match action {
            "model" => {
                let model = context
                    .catalog
                    .get("models")
                    .and_then(Value::as_array)
                    .and_then(|models| models.iter().find(|item| item.get("id").and_then(Value::as_str) == Some(value)).cloned());
                let Some(model) = model else {
                    return Err(invalid_details(&[("model", json!(value))]));
                };
                let mut patch = Map::new();
                patch.insert("model".to_string(), model.get("id").cloned().unwrap_or(Value::Null));
                patch.insert(
                    "reasoningEffort".to_string(),
                    model
                        .get("defaultReasoningEffort")
                        .and_then(Value::as_str)
                        .or_else(|| {
                            model.get("reasoningEfforts").and_then(Value::as_array).and_then(|e| e.first()).and_then(Value::as_str)
                        })
                        .map(|e| json!(e))
                        .unwrap_or_else(|| json!("")),
                );
                patch.insert(
                    "serviceTier".to_string(),
                    model.get("defaultServiceTier").and_then(Value::as_str).map(|t| json!(t)).unwrap_or_else(|| json!("")),
                );
                patch
            }
            "reasoning" | "thinking" => {
                let efforts: Vec<&str> = context
                    .model
                    .as_ref()
                    .and_then(|m| m.get("reasoningEfforts"))
                    .and_then(Value::as_array)
                    .map(|e| e.iter().filter_map(Value::as_str).collect())
                    .unwrap_or_default();
                if !efforts.contains(&value) {
                    return Err(invalid_details(&[("reasoningEffort", json!(value))]));
                }
                let mut patch = Map::new();
                patch.insert("reasoningEffort".to_string(), json!(value));
                patch
            }
            "fast" => self.speed_patch(&context, value)?,
            _ => return Err(invalid_details(&[("commandId", json!(command_id))])),
        };
        let session = self.save_patch(&context.session, patch)?;
        self.record(session_id, command_id, "applied", Some(json!({ "selected": value })));
        Ok(json!({
            "commandId": command_id,
            "title": "设置已更新",
            "sections": [{ "kind": "text", "text": "新设置将在下一条消息开始时传给当前 CLI。" }],
            "actions": [{ "id": "close", "label": "完成", "kind": "primary" }],
            "completed": true,
            "sessionPatch": {
                "title": session.get("title").cloned().unwrap_or(Value::Null),
                "model": session.get("model").cloned().unwrap_or(Value::Null),
                "reasoningEffort": session.get("reasoningEffort").cloned().unwrap_or(Value::Null),
                "serviceTier": session.get("serviceTier").cloned().unwrap_or(Value::Null)
            }
        }))
    }

    fn resolve_base(&self, session_id: &str) -> CoreResult<(Value, Value)> {
        let session = Repositories::new(&self.db.lock().unwrap().raw)
            .sessions()
            .get(session_id)?
            .ok_or_else(|| crate::errors::not_found("session", session_id))?;
        let agent = MemberRouter::new(self.db.clone()).resolve_session(&session)?;
        Ok((session, agent))
    }

    async fn resolve(&self, session_id: &str) -> CoreResult<CommandContext> {
        let (session, agent) = self.resolve_base(session_id)?;
        let catalog = self
            .agents
            .list_models(
                agent.get("providerId").and_then(Value::as_str).unwrap_or(""),
                agent.get("executable").and_then(Value::as_str),
                agent.get("id").and_then(Value::as_str),
                None,
                None,
                None,
            )
            .await?;
        let model_id = session
            .get("model")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| catalog.get("defaultModel").and_then(Value::as_str).map(str::to_string));
        let model = catalog
            .get("models")
            .and_then(Value::as_array)
            .and_then(|models| models.iter().find(|item| Some(item.get("id").and_then(Value::as_str).unwrap_or("")) == model_id.as_deref()).cloned());
        Ok(CommandContext { session, agent, catalog, model })
    }

    fn native_commands(&self, provider_id: &str) -> Vec<Value> {
        // ProviderDescriptor.nativeCommands is an optional descriptor field;
        // current built-ins declare none, but plugins may.
        let _ = provider_id;
        vec![]
    }

    fn assert_command(&self, session_id: &str, command_id: &str) -> CoreResult<Value> {
        let command = self.list(session_id)?.into_iter().find(|item| item.get("id").and_then(Value::as_str) == Some(command_id));
        command.ok_or_else(|| invalid_details(&[("commandId", json!(command_id))]))
    }

    async fn execute_provider_command(&self, context: &CommandContext, command: &Value, argument: Option<&str>) -> CoreResult<Value> {
        let session_status = context.session.get("status").and_then(Value::as_str).unwrap_or("");
        if command.get("availability").and_then(Value::as_str) == Some("idle")
            && ["running", "starting", "cancelling"].contains(&session_status)
        {
            return Err(invalid_details(&[
                ("reason", json!("provider_command_requires_idle")),
                ("commandId", command.get("id").cloned().unwrap_or(Value::Null)),
            ]));
        }
        // Native compaction runs through a dedicated provider transport and
        // needs an existing provider thread.
        let native_compact = command.get("providerCommand").and_then(Value::as_str) == Some("compact");
        if native_compact && context.session.get("providerSessionId").is_none() {
            return Err(invalid_details(&[
                ("reason", json!("compact_requires_provider_session")),
                ("commandId", command.get("id").cloned().unwrap_or(Value::Null)),
            ]));
        }
        let native_command = [
            command.get("name").and_then(Value::as_str).unwrap_or(""),
            argument.map(str::trim).unwrap_or(""),
        ]
        .iter()
        .filter(|part| !part.is_empty())
        .copied()
        .collect::<Vec<_>>()
        .join(" ");
        let provider_command = if native_compact { Some("compact".to_string()) } else { None };
        let run_id = self
            .runs
            .start(
                &context.session,
                &context.agent,
                &native_command,
                RunContext {
                    presentation: Some("provider_command".to_string()),
                    provider_command,
                    ..Default::default()
                },
            )
            .await?;
        let completion = self.runs.wait_completion(&run_id).await;
        let run_status = completion
            .as_ref()
            .and_then(|c| c.run.get("status"))
            .and_then(Value::as_str)
            .unwrap_or("failed");
        let failed = ["failed", "timed_out", "crashed"].contains(&run_status);
        self.record(
            context.session.get("id").and_then(Value::as_str).unwrap_or(""),
            command.get("id").and_then(Value::as_str).unwrap_or(""),
            if failed { "failed" } else { "completed" },
            Some(json!({ "runId": run_id })),
        );
        if failed {
            let failure_code = completion
                .as_ref()
                .and_then(|c| c.run.get("failureCode"))
                .and_then(Value::as_str)
                .unwrap_or("PROVIDER_COMMAND_FAILED");
            let mut details = Map::new();
            details.insert("commandId".to_string(), command.get("id").cloned().unwrap_or(Value::Null));
            details.insert("failureCode".to_string(), json!(failure_code));
            return Err(CoreError::details(ErrorCode::RunStartFailed, details));
        }
        let provider_id = context.agent.get("providerId").and_then(Value::as_str).unwrap_or("");
        let label = provider_label(provider_id);
        let output = completion
            .as_ref()
            .and_then(|c| c.final_message.as_deref())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        let text = output.unwrap_or_else(|| {
            if run_status == "cancelled" {
                format!("{label} 已结束该控制命令。")
            } else {
                format!("{label} 已执行该控制命令，没有返回额外文本。")
            }
        });
        Ok(json!({
            "commandId": command.get("id").cloned().unwrap_or(Value::Null),
            "title": command.get("title").cloned().unwrap_or(Value::Null),
            "description": format!("{} 已由 {} CLI 处理，未作为普通聊天消息发送。", command.get("name").and_then(Value::as_str).unwrap_or(""), label),
            "sections": [{ "kind": "text", "text": text }],
            "actions": [{ "id": "close", "label": "关闭", "kind": "primary" }],
            "completed": true
        }))
    }

    fn help(&self, session_id: &str, provider_id: &str) -> CoreResult<Value> {
        let items: Vec<Value> = self
            .list(session_id)?
            .iter()
            .map(|command| {
                json!({
                    "label": command.get("name").cloned().unwrap_or(Value::Null),
                    "description": command.get("description").cloned().unwrap_or(Value::Null)
                })
            })
            .collect();
        Ok(json!({
            "commandId": format!("{provider_id}.help"),
            "title": format!("{} 指令", provider_label(provider_id)),
            "description": "这里只展示 Nautilo 已接入并可执行的 Provider 指令。",
            "sections": [{ "kind": "list", "items": items }],
            "actions": [{ "id": "close", "label": "关闭", "kind": "primary" }],
            "completed": true
        }))
    }

    fn selection_result(&self, command_id: &str, title: &str, description: &str, options: Vec<Value>) -> Value {
        json!({
            "commandId": command_id,
            "title": title,
            "description": description,
            "sections": [],
            "selection": { "mode": "single", "options": options, "minimum": 1, "maximum": 1 },
            "actions": [
                { "id": "close", "label": "取消", "kind": "secondary" },
                { "id": "apply", "label": "应用", "kind": "primary", "requiresSelection": true }
            ],
            "completed": false
        })
    }

    fn model_picker(&self, context: &CommandContext) -> Value {
        let current = context
            .session
            .get("model")
            .and_then(Value::as_str)
            .or_else(|| context.catalog.get("defaultModel").and_then(Value::as_str));
        let options = context
            .catalog
            .get("models")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .iter()
            .map(|model| {
                json!({
                    "id": model.get("id").cloned().unwrap_or(Value::Null),
                    "label": model.get("displayName").cloned().unwrap_or(Value::Null),
                    "description": model.get("description").cloned().or_else(|| model.get("id").cloned()).unwrap_or(Value::Null),
                    "selected": Some(model.get("id").and_then(Value::as_str).unwrap_or("")) == current
                })
            })
            .collect();
        self.selection_result(
            &format!("{}.model", context.agent.get("providerId").and_then(Value::as_str).unwrap_or("")),
            "选择模型",
            "模型将在下一条消息开始时生效。",
            options,
        )
    }

    fn reasoning_picker(&self, context: &CommandContext, command_id: &str) -> Value {
        let efforts: Vec<String> = context
            .model
            .as_ref()
            .and_then(|m| m.get("reasoningEfforts"))
            .and_then(Value::as_array)
            .map(|efforts| efforts.iter().filter_map(Value::as_str).map(str::to_string).collect())
            .unwrap_or_default();
        if efforts.is_empty() {
            return json!({
                "commandId": command_id,
                "title": "当前模型没有可选推理等级",
                "sections": [{ "kind": "text", "text": "Provider 的模型目录没有返回可切换的推理/思考强度。" }],
                "actions": [{ "id": "close", "label": "关闭", "kind": "primary" }],
                "completed": true
            });
        }
        let current = context
            .session
            .get("reasoningEffort")
            .and_then(Value::as_str)
            .or_else(|| context.model.as_ref().and_then(|m| m.get("defaultReasoningEffort")).and_then(Value::as_str));
        let options = efforts
            .iter()
            .map(|effort| json!({ "id": effort, "label": effort_label(effort), "selected": Some(effort.as_str()) == current }))
            .collect();
        self.selection_result(
            command_id,
            if command_id.ends_with("thinking") { "选择思考强度" } else { "选择推理深度" },
            "该设置将在下一条消息开始时生效。",
            options,
        )
    }

    fn speed_picker(&self, context: &CommandContext) -> Value {
        let highspeed = context.catalog.get("models").and_then(Value::as_array).and_then(|models| {
            models
                .iter()
                .find(|item| {
                    let text = format!(
                        "{} {}",
                        item.get("id").and_then(Value::as_str).unwrap_or(""),
                        item.get("displayName").and_then(Value::as_str).unwrap_or("")
                    );
                    regex::Regex::new(r"(?i)high[-_ ]?speed").map(|re| re.is_match(&text)).unwrap_or(false)
                })
                .cloned()
        });
        let current_model_id = context.model.as_ref().and_then(|m| m.get("id")).and_then(Value::as_str);
        let highspeed_id = highspeed.as_ref().and_then(|m| m.get("id")).and_then(Value::as_str);
        let mut options = vec![json!({
            "id": "standard",
            "label": "标准",
            "selected": context.session.get("serviceTier").is_none() && current_model_id != highspeed_id
        })];
        for tier in context
            .model
            .as_ref()
            .and_then(|m| m.get("serviceTiers"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
        {
            options.push(json!({
                "id": format!("tier:{}", tier.get("id").and_then(Value::as_str).unwrap_or("")),
                "label": tier.get("name").cloned().unwrap_or(Value::Null),
                "description": tier.get("description").cloned().unwrap_or(Value::Null),
                "selected": context.session.get("serviceTier").and_then(Value::as_str) == tier.get("id").and_then(Value::as_str)
            }));
        }
        if let Some(highspeed) = &highspeed {
            if options.len() == 1 {
                options.push(json!({
                    "id": format!("model:{}", highspeed.get("id").and_then(Value::as_str).unwrap_or("")),
                    "label": highspeed.get("displayName").cloned().unwrap_or(Value::Null),
                    "description": highspeed.get("description").cloned().unwrap_or(Value::Null),
                    "selected": current_model_id == highspeed.get("id").and_then(Value::as_str)
                }));
            }
        }
        self.selection_result("codex.fast", "选择运行速度", "仅显示当前 Provider 模型目录真实提供的速度选项。", options)
    }

    fn status(&self, context: &CommandContext) -> Value {
        let provider_id = context.agent.get("providerId").and_then(Value::as_str).unwrap_or("");
        json!({
            "commandId": format!("{provider_id}.status"),
            "title": "当前会话状态",
            "sections": [{ "kind": "key_value", "items": [
                { "label": "Provider", "value": provider_id },
                { "label": "Agent 实例", "value": context.agent.get("displayName").cloned().unwrap_or(Value::Null) },
                { "label": "模型", "value": context.model.as_ref().and_then(|m| m.get("displayName")).cloned()
                    .or_else(|| context.session.get("model").cloned())
                    .unwrap_or_else(|| json!("Provider 默认")) },
                { "label": "推理深度", "value": context.session.get("reasoningEffort").cloned()
                    .filter(|v| !v.is_null())
                    .or_else(|| context.model.as_ref().and_then(|m| m.get("defaultReasoningEffort")).cloned())
                    .unwrap_or_else(|| json!("Provider 默认")) },
                { "label": "Provider 会话", "value": context.session.get("providerSessionId").cloned().unwrap_or_else(|| json!("尚未建立")) },
                { "label": "状态", "value": context.session.get("status").cloned().unwrap_or(Value::Null) }
            ] }],
            "actions": [{ "id": "close", "label": "关闭", "kind": "primary" }],
            "completed": true
        })
    }

    fn usage(&self, context: &CommandContext) -> Value {
        let usage = self.latest_usage(context.session.get("id").and_then(Value::as_str).unwrap_or(""));
        let used = usage
            .as_ref()
            .and_then(|event| event.get("payload"))
            .and_then(|p| p.get("contextUsed"))
            .and_then(Value::as_i64);
        let window = usage
            .as_ref()
            .and_then(|event| event.get("payload"))
            .and_then(|p| p.get("contextWindow"))
            .and_then(Value::as_i64)
            .or_else(|| context.model.as_ref().and_then(|m| m.get("contextWindow")).and_then(Value::as_i64));
        let percent = match (used, window) {
            (Some(used), Some(window)) if window > 0 => format!("{}%", (used * 100 / window)),
            _ => "等待 Provider 返回".to_string(),
        };
        let provider_id = context.agent.get("providerId").and_then(Value::as_str).unwrap_or("");
        json!({
            "commandId": format!("{provider_id}.usage"),
            "title": "上下文用量",
            "sections": [{ "kind": "key_value", "items": [
                { "label": "已使用", "value": used.map(token_label).unwrap_or_else(|| "尚未返回".to_string()) },
                { "label": "上下文上限", "value": window.map(token_label).unwrap_or_else(|| "未知".to_string()) },
                { "label": "占用比例", "value": percent }
            ] }],
            "actions": [{ "id": "close", "label": "关闭", "kind": "primary" }],
            "completed": true
        })
    }

    fn rename(&self, context: &CommandContext, argument: Option<&str>) -> CoreResult<Value> {
        let provider_id = context.agent.get("providerId").and_then(Value::as_str).unwrap_or("");
        let title = argument.map(str::trim).filter(|t| !t.is_empty());
        let Some(title) = title else {
            return Ok(json!({
                "commandId": format!("{provider_id}.rename"),
                "title": "重命名会话",
                "description": "请在指令后输入新标题，例如 /rename 登录功能调试。",
                "sections": [{ "kind": "key_value", "items": [{ "label": "当前标题", "value": context.session.get("title").cloned().unwrap_or(Value::Null) }] }],
                "actions": [{ "id": "close", "label": "关闭", "kind": "primary" }],
                "completed": true
            }));
        };
        let mut patch = Map::new();
        patch.insert("title".to_string(), json!(title.chars().take(200).collect::<String>()));
        let session = self.save_patch(&context.session, patch)?;
        self.record(
            session.get("id").and_then(Value::as_str).unwrap_or(""),
            &format!("{provider_id}.rename"),
            "applied",
            None,
        );
        Ok(json!({
            "commandId": format!("{provider_id}.rename"),
            "title": "会话已重命名",
            "sections": [{ "kind": "key_value", "items": [{ "label": "新标题", "value": session.get("title").cloned().unwrap_or(Value::Null) }] }],
            "actions": [{ "id": "close", "label": "完成", "kind": "primary" }],
            "completed": true,
            "sessionPatch": { "title": session.get("title").cloned().unwrap_or(Value::Null) }
        }))
    }

    fn speed_patch(&self, context: &CommandContext, value: &str) -> CoreResult<Map<String, Value>> {
        let mut patch = Map::new();
        if value == "standard" {
            patch.insert("serviceTier".to_string(), json!(""));
            return Ok(patch);
        }
        if let Some(id) = value.strip_prefix("tier:") {
            let valid = context
                .model
                .as_ref()
                .and_then(|m| m.get("serviceTiers"))
                .and_then(Value::as_array)
                .is_some_and(|tiers| tiers.iter().any(|item| item.get("id").and_then(Value::as_str) == Some(id)));
            if !valid {
                return Err(invalid_details(&[("serviceTier", json!(id))]));
            }
            patch.insert("serviceTier".to_string(), json!(id));
            return Ok(patch);
        }
        if let Some(id) = value.strip_prefix("model:") {
            let model = context.catalog.get("models").and_then(Value::as_array).and_then(|models| {
                models
                    .iter()
                    .find(|item| {
                        if item.get("id").and_then(Value::as_str) != Some(id) {
                            return false;
                        }
                        let text = format!(
                            "{} {}",
                            item.get("id").and_then(Value::as_str).unwrap_or(""),
                            item.get("displayName").and_then(Value::as_str).unwrap_or("")
                        );
                        regex::Regex::new(r"(?i)high[-_ ]?speed").map(|re| re.is_match(&text)).unwrap_or(false)
                    })
                    .cloned()
            });
            let Some(model) = model else {
                return Err(invalid_details(&[("model", json!(id))]));
            };
            patch.insert("model".to_string(), model.get("id").cloned().unwrap_or(Value::Null));
            patch.insert(
                "reasoningEffort".to_string(),
                model
                    .get("defaultReasoningEffort")
                    .and_then(Value::as_str)
                    .or_else(|| model.get("reasoningEfforts").and_then(Value::as_array).and_then(|e| e.first()).and_then(Value::as_str))
                    .map(|e| json!(e))
                    .unwrap_or_else(|| json!("")),
            );
            patch.insert("serviceTier".to_string(), json!(""));
            return Ok(patch);
        }
        Err(invalid_details(&[("speed", json!(value))]))
    }

    fn save_patch(&self, session: &Value, patch: Map<String, Value>) -> CoreResult<Value> {
        let mut updated = session.as_object().cloned().unwrap_or_default();
        for (key, value) in patch {
            if value.is_null() {
                continue;
            }
            updated.insert(key, value);
        }
        updated.insert("updatedAt".to_string(), json!(now_iso()));
        let updated = Value::Object(updated);
        Repositories::new(&self.db.lock().unwrap().raw).sessions().save(&updated)?;
        Ok(updated)
    }

    fn latest_usage(&self, session_id: &str) -> Option<Value> {
        Repositories::new(&self.db.lock().unwrap().raw)
            .events()
            .replay(Some(session_id), None, None, None)
            .ok()?
            .into_iter()
            .filter(|event| event.get("type").and_then(Value::as_str) == Some("usage.updated"))
            .last()
    }

    fn latest_provider_commands(&self, session_id: &str, provider_id: &str) -> Vec<Value> {
        Repositories::new(&self.db.lock().unwrap().raw)
            .events()
            .replay(Some(session_id), None, None, None)
            .unwrap_or_default()
            .into_iter()
            .filter(|event| {
                event.get("type").and_then(Value::as_str) == Some("provider.commands_updated")
                    && event.get("payload").and_then(|p| p.get("providerId")).and_then(Value::as_str) == Some(provider_id)
            })
            .last()
            .and_then(|event| event.get("payload").and_then(|p| p.get("commands")).and_then(Value::as_array).cloned())
            .unwrap_or_default()
    }

    fn record(&self, session_id: &str, command_id: &str, outcome: &str, details: Option<Value>) {
        let mut record = Map::new();
        record.insert("actorType".to_string(), json!("user"));
        record.insert("actorId".to_string(), json!("desktop-user"));
        record.insert("action".to_string(), json!(format!("slash_command.{outcome}")));
        record.insert("resourceType".to_string(), json!("session"));
        record.insert("resourceId".to_string(), json!(session_id));
        record.insert("outcome".to_string(), json!("success"));
        let mut detail_map = Map::new();
        detail_map.insert("commandId".to_string(), json!(command_id));
        if let Some(details) = details.and_then(|d| d.as_object().cloned()) {
            for (key, value) in details {
                detail_map.insert(key, value);
            }
        }
        record.insert("details".to_string(), Value::Object(detail_map));
        self.audit.record(record);
    }
}
