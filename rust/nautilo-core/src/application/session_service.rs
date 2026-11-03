//! Session service — port of application/session-service.ts (persistence level;
//! the run-dependent methods land with the run pipeline).
//! The run-dependent methods (send / followUp) land with the run pipeline.

use std::sync::{Arc, Mutex};

use serde_json::{json, Map, Value};
use uuid::Uuid;

use std::sync::RwLock;

use crate::database::Database;
use crate::errors::CoreResult;
use crate::errors::{invalid, not_found, now_iso};
use crate::database::Repositories;
use crate::runtime::event_service::EventService;
use crate::runtime::message_attachment_service::{append_attachment_context, MessageAttachmentService};
use crate::runtime::orchestration::member_router::MemberRouter;
use crate::runtime::run_service::{RunContext, RunService};
use crate::application::session_context::{build_bound_turn_context, TurnContextInput};
use crate::runtime::RUNTIME_TOOL_SCHEMA_VERSION;

pub(crate) fn effective_agent_id(db: &rusqlite::Connection, session: &Value) -> CoreResult<String> {
    if let Some(id) = session["agentInstanceId"].as_str().filter(|s| !s.is_empty()) { return Ok(id.into()); }
    let member_id = session["memberId"].as_str().unwrap_or("");
    if let Some(team_id) = session["teamId"].as_str() {
        if let Some(team) = Repositories::new(db).teams().get(team_id)? {
            if let Some(id) = team["members"].as_array().and_then(|members| members.iter().find(|m| m["id"] == member_id)).and_then(|m| m["agentInstanceId"].as_str()) { return Ok(id.into()); }
        }
    }
    Ok(member_id.into())
}

const TERMINAL_RUN_STATUSES: [&str; 5] = ["completed", "failed", "timed_out", "crashed", "cancelled"];
const TERMINAL_PROJECT_RUN_STATUSES: [&str; 3] = ["completed", "failed", "cancelled"];

pub struct SessionService {
    db: Arc<Mutex<Database>>,
    runs: RwLock<Option<Arc<RunService>>>,
    events: RwLock<Option<Arc<EventService>>>,
    /// Follow-ups waiting for the active turn to settle, keyed by session id.
    pending_follow_ups: Arc<Mutex<std::collections::HashMap<String, Vec<Value>>>>,
    /// Sessions whose journal was already scanned for orphaned queued
    /// follow-ups in this process — the scan is idempotent, so run it once.
    healed_follow_up_sessions: Mutex<std::collections::HashSet<String>>,
}

impl SessionService {
    pub fn new(db: Arc<Mutex<Database>>) -> Self {
        Self {
            db,
            runs: RwLock::new(None),
            events: RwLock::new(None),
            pending_follow_ups: Arc::new(Mutex::new(std::collections::HashMap::new())),
            healed_follow_up_sessions: Mutex::new(std::collections::HashSet::new()),
        }
    }

    /// Wires the run pipeline after construction (RunService needs the db
    /// first; sessions need runs — matching the TS construction order).
    pub fn set_run_pipeline(&self, runs: Arc<RunService>, events: Arc<EventService>) {
        *self.runs.write().unwrap() = Some(runs);
        *self.events.write().unwrap() = Some(events);
    }

    fn runs(&self) -> CoreResult<Arc<RunService>> {
        self.runs.read().unwrap().clone().ok_or_else(|| {
            crate::errors::CoreError::reason(crate::errors::ErrorCode::IpcInternalError, "run pipeline is not wired")
        })
    }

    pub fn list(&self, project_id: &str, member_id: Option<&str>) -> CoreResult<Vec<Value>> {
        Repositories::new(&self.db.lock().unwrap().raw).sessions().list(project_id, member_id)
    }

    pub fn get(&self, id: &str) -> CoreResult<Value> {
        let guard = self.db.lock().unwrap();
        let repos = Repositories::new(&guard.raw);
        let sessions = repos.sessions();
        let session = sessions.get(id)?.ok_or_else(|| not_found("session", id))?;
        let messages = sessions.messages(id)?;
        Ok(json!({ "session": session, "messages": messages }))
    }

    pub fn create(&self, input: &Value) -> CoreResult<Value> {
        let now = now_iso();
        let mut session = json!({
            "id": Uuid::new_v4().to_string(),
            "projectId": input.get("projectId").cloned().unwrap_or(Value::Null),
            "memberId": input.get("memberId").cloned().unwrap_or(Value::Null),
            "title": input.get("title").cloned().unwrap_or_else(|| json!("New session")),
            "status": "idle",
            "unreadCount": 0,
            "createdAt": now,
            "updatedAt": now,
        });
        for field in ["agentInstanceId","connectionId","connectionRevision","model","reasoningEffort","serviceTier","permissionMode","parentSessionId"] {
            if let Some(value) = input.get(field) { session[field] = value.clone(); }
        }
        let db = self.db.lock().unwrap();
        crate::application::connection_service::bind_session(&db.raw, &mut session, None)?;
        Repositories::new(&db.raw).sessions().save(&session)?;
        Ok(session)
    }

    pub fn delete(&self, session_id: &str) -> CoreResult<Value> {
        let db = self.db.lock().unwrap();
        let repos = Repositories::new(&db.raw);
        let sessions = repos.sessions();
        if sessions.get(session_id)?.is_none() {
            return Err(not_found("session", session_id));
        }
        let all = sessions.list_all()?;
        let session_ids = descendant_session_ids(&all, session_id);
        let active_run = repos.runs().list()?.into_iter().any(|run| {
            let session_matches = run.get("sessionId").and_then(Value::as_str).is_some_and(|id| session_ids.iter().any(|k| k == id));
            let status = run.get("status").and_then(Value::as_str).unwrap_or("");
            session_matches && !TERMINAL_RUN_STATUSES.contains(&status)
        });
        let active_project_run = all
            .iter()
            .filter(|item| item.get("id").and_then(Value::as_str).is_some_and(|id| session_ids.iter().any(|k| k == id)))
            .filter_map(|item| item.get("projectRunId").and_then(Value::as_str).map(str::to_string))
            .filter_map(|id| repos.project_runs().get(&id).ok().flatten())
            .any(|run| {
                let status = run.get("status").and_then(Value::as_str).unwrap_or("");
                !TERMINAL_PROJECT_RUN_STATUSES.contains(&status)
            });
        if active_run || active_project_run {
            return Err(invalid("sessionId", "Stop the active run before deleting this session."));
        }
        let removed = sessions.delete_tree(session_id)?;
        Ok(json!({ "removed": true, "sessionIds": removed }))
    }

    /// Applies renderer-owned session metadata without erasing provider runtime
    /// state (see the TS docstring on upsert).
    pub fn upsert(&self, input: &Value) -> CoreResult<Value> {
        let id = input.get("id").and_then(Value::as_str).unwrap_or("");
        let db = self.db.lock().unwrap();
        let repos = Repositories::new(&db.raw);
        let current = repos.sessions().get(id)?;
        let Some(current) = current else {
            let mut normalized = input.clone();
            crate::application::connection_service::bind_session(&db.raw, &mut normalized, None)?;
            normalized.as_object_mut().unwrap().remove("confirmConnectionChange");
            normalize_session_permission(&mut normalized);
            repos.sessions().save(&normalized)?;
            return Ok(normalized);
        };
        let mut binding_input = input.clone();
        crate::application::connection_service::bind_session(&db.raw, &mut binding_input, Some(&current))?;
        let mut candidate = current.clone();
        if let Some(fields) = binding_input.as_object() { for (key,value) in fields { candidate[key] = value.clone(); } }
        if input.get("connectionId") == Some(&Value::Null) {
            candidate.as_object_mut().unwrap().remove("connectionId"); candidate.as_object_mut().unwrap().remove("connectionRevision");
        }
        candidate.as_object_mut().unwrap().remove("confirmConnectionChange");
        let connection_changed = current.get("connectionId") != candidate.get("connectionId") || current.get("connectionRevision") != candidate.get("connectionRevision");
        let runs = repos.runs().list()?;
        let session_runs: Vec<&Value> = runs.iter().filter(|run| run["sessionId"] == id).collect();
        let started = !repos.sessions().messages(id)?.is_empty() || current.get("providerSessionId").and_then(Value::as_str).is_some_and(|s| !s.is_empty()) || !session_runs.is_empty();
        if started && (current.get("projectId") != candidate.get("projectId") || effective_agent_id(&db.raw,&current)? != effective_agent_id(&db.raw,&candidate)?) {
            return Err(invalid("agentInstanceId","A started session keeps its project and Agent; create another session to change them"));
        }
        let active = session_runs.iter().any(|run| !TERMINAL_RUN_STATUSES.contains(&run["status"].as_str().unwrap_or("")))
            || self.runs.read().unwrap().as_ref().is_some_and(|runs| runs.session_busy(id))
            || self.pending_follow_ups.lock().unwrap().get(id).is_some_and(|items| !items.is_empty());
        let settings_changed = connection_changed || ["model","reasoningEffort","serviceTier"].iter().any(|key| current.get(*key) != candidate.get(*key));
        if active && settings_changed { return Err(invalid("sessionId","Wait for active and queued requests before changing provider, account or model settings")); }
        if connection_changed && input["confirmConnectionChange"] != true {
            return Err(invalid("confirmConnectionChange","Confirm provider/account switch: text history is rebuilt; native reasoning, cache and old image context are not transferred"));
        }
        if !connection_changed && current.get("connectionId").is_some() {
            for field in ["providerSessionId","providerContextSyncedAt","providerContextWindow","runtimeToolVersion"] {
                if input.get(field).is_some() && input.get(field) != current.get(field) { return Err(invalid(field,"Provider context is runtime-owned")); }
            }
        }
        let input = &candidate;
        let same_provider_binding = !connection_changed && current.get("projectId") == input.get("projectId")
            && effective_agent_id(&db.raw,&current)? == effective_agent_id(&db.raw,input)?;
        // { ...current, ...input }: input keys win, including explicit nulls.
        let mut merged = current.as_object().cloned().unwrap_or_default();
        if let Some(overlay) = input.as_object() {
            for (key, value) in overlay {
                merged.insert(key.clone(), value.clone());
            }
        }
        let keep = |key: &str| -> Option<Value> {
            let input_value = input.get(key).filter(|v| !v.is_null());
            input_value.cloned().or_else(|| current.get(key).cloned())
        };
        merged.insert("createdAt".to_string(), current.get("createdAt").cloned().unwrap_or(Value::Null));
        for key in ["projectRunId", "parentSessionId", "taskId"] {
            match keep(key) {
                Some(value) => {
                    merged.insert(key.to_string(), value);
                }
                None => {
                    merged.remove(key);
                }
            }
        }
        if same_provider_binding {
            match keep("providerSessionId") {
                Some(value) => {
                    merged.insert("providerSessionId".to_string(), value);
                }
                None => {
                    merged.remove("providerSessionId");
                }
            }
            if let Some(value) = current.get("providerContextSyncedAt").cloned() {
                merged.insert("providerContextSyncedAt".to_string(), value);
            } else {
                merged.remove("providerContextSyncedAt");
            }
            match keep("runtimeToolVersion") {
                Some(value) => {
                    merged.insert("runtimeToolVersion".to_string(), value);
                }
                None => {
                    merged.remove("runtimeToolVersion");
                }
            }
        } else {
            if let Some(value) = input.get("providerSessionId").cloned() {
                merged.insert("providerSessionId".to_string(), value);
            } else {
                merged.remove("providerSessionId");
            }
            merged.remove("providerContextSyncedAt");
            if let Some(value) = input.get("runtimeToolVersion").cloned() {
                merged.insert("runtimeToolVersion".to_string(), value);
            } else {
                merged.remove("runtimeToolVersion");
            }
        }
        let mut updated = Value::Object(merged);
        updated.as_object_mut().unwrap().remove("confirmConnectionChange");
        if connection_changed {
            if input.get("connectionId").is_none() { updated.as_object_mut().unwrap().remove("connectionId"); updated.as_object_mut().unwrap().remove("connectionRevision"); }
            for field in ["providerSessionId","providerContextSyncedAt","providerContextWindow","runtimeToolVersion"] { updated.as_object_mut().unwrap().remove(field); }
            updated["connectionContextRebuildRequired"] = json!(true);
        } else if let Some(value) = current.get("connectionContextRebuildRequired") { updated["connectionContextRebuildRequired"] = value.clone(); }
        normalize_session_permission(&mut updated);
        repos.sessions().save(&updated)?;
        Ok(updated)
    }

    pub fn follow_up_list(&self, session_id: &str) -> CoreResult<Value> {
        let items = self
            .pending_follow_ups
            .lock()
            .unwrap()
            .get(session_id)
            .cloned()
            .unwrap_or_default();
        Ok(json!({ "items": items }))
    }

    pub fn track_pending_follow_up(&self, session_id: &str, entry: Value) {
        self.pending_follow_ups.lock().unwrap().entry(session_id.to_string()).or_default().push(entry);
    }

    pub fn untrack_pending_follow_up(&self, session_id: &str, message_id: &str) {
        let mut pending = self.pending_follow_ups.lock().unwrap();
        if let Some(items) = pending.get_mut(session_id) {
            items.retain(|item| item.get("messageId").and_then(Value::as_str) != Some(message_id));
            if items.is_empty() {
                pending.remove(session_id);
            }
        }
    }

    pub fn pending_follow_up(&self, session_id: &str, message_id: &str) -> Option<Value> {
        self.pending_follow_ups
            .lock()
            .unwrap()
            .get(session_id)?
            .iter()
            .find(|item| item.get("messageId").and_then(Value::as_str) == Some(message_id))
            .cloned()
    }


    /// session.send — validates, persists the user message, and launches a run.
    pub async fn send(&self, input: &Value) -> CoreResult<Value> {
        let session_id = input.get("sessionId").and_then(Value::as_str).unwrap_or("");
        let text = input.get("text").and_then(Value::as_str).unwrap_or("");
        // Heal replayed zombie queue entries before this run's events make the
        // renderer re-read the journal (see heal_follow_ups).
        self.heal_follow_ups(session_id);
        let session = {
            let db = self.db.lock().unwrap();
            Repositories::new(&db.raw).sessions().get(session_id)?.ok_or_else(|| not_found("session", session_id))?
        };
        let existing_messages = {
            let db = self.db.lock().unwrap();
            Repositories::new(&db.raw).sessions().messages(session_id)?
        };
        let edit_message_id = input.get("editMessageId").and_then(Value::as_str);
        let edited_message = edit_message_id.and_then(|id| {
            existing_messages.iter().find(|message| message.get("id").and_then(Value::as_str) == Some(id)).cloned()
        });
        if let Some(id) = edit_message_id {
            let valid = edited_message
                .as_ref()
                .is_some_and(|message| message.get("sender").and_then(Value::as_str) == Some("user"));
            if !valid {
                let mut details = serde_json::Map::new();
                details.insert("field".to_string(), json!("editMessageId"));
                details.insert("id".to_string(), json!(id));
                return Err(crate::errors::CoreError::details(crate::errors::ErrorCode::IpcInvalidRequest, details));
            }
        }
        let attachment_inputs: Vec<Value> = input.get("attachments").and_then(Value::as_array).cloned().unwrap_or_default();
        let attachments = MessageAttachmentService::new(self.db.clone()).save(&session, &attachment_inputs)?;
        let (artifacts, project_root) = {
            let db = self.db.lock().unwrap();
            let repos = Repositories::new(&db.raw);
            let session_artifacts = repos.artifacts().list(None, None, Some(session_id))?;
            let project_run_artifacts = match session.get("projectRunId").and_then(Value::as_str) {
                Some(id) => repos.artifacts().list(Some(id), None, None)?,
                None => vec![],
            };
            let root = repos
                .projects()
                .get(session.get("projectId").and_then(Value::as_str).unwrap_or(""))
                .ok()
                .flatten()
                .and_then(|project| project.get("rootPath").and_then(Value::as_str).map(str::to_string));
            (merge_artifacts(session_artifacts, project_run_artifacts), root)
        };
        let agent = MemberRouter::new(self.db.clone()).resolve_session(&session)?;
        let needs_runtime_tool_migration = agent.get("providerId").and_then(Value::as_str) == Some("codex")
            && session.get("teamId").is_some()
            && session.get("projectRunId").is_some()
            && session.get("parentSessionId").is_none()
            && session.get("runtimeToolVersion").and_then(Value::as_i64) != Some(RUNTIME_TOOL_SCHEMA_VERSION);
        let corrected;
        let current_text = append_attachment_context(
            if edit_message_id.is_some() {
                corrected = format!("The user edited an earlier message. Treat the following as the corrected instruction:\n\n{text}");
                &corrected
            } else {
                text
            },
            &attachments,
        );
        let turn_context = build_bound_turn_context(&session, TurnContextInput {
            current_text: &current_text,
            messages: &existing_messages,
            artifacts: &artifacts,
            current_attachments: &attachments,
            recover_provider_context: session.get("providerSessionId").is_none()
                || session.get("providerContextSyncedAt").is_none()
                || needs_runtime_tool_migration,
            workspace_root: project_root.as_deref(),
        })?;
        let attachment_ids: Vec<Value> = attachments.iter().filter_map(|a| a.get("id").cloned()).collect();
        let message = match edited_message {
            Some(edited) => {
                let mut updated = edited.as_object().cloned().unwrap_or_default();
                updated.insert("text".to_string(), json!(text));
                updated.insert("attachmentIds".to_string(), Value::Array(attachment_ids));
                updated.insert("editedAt".to_string(), json!(now_iso()));
                Value::Object(updated)
            }
            None => {
                let mut message = serde_json::Map::new();
                message.insert("id".to_string(), json!(uuid::Uuid::new_v4().to_string()));
                message.insert("sessionId".to_string(), json!(session_id));
                message.insert("sender".to_string(), json!("user"));
                message.insert("kind".to_string(), json!("chat"));
                if let Some(id) = session.get("projectRunId").cloned().filter(|v| !v.is_null()) {
                    message.insert("projectRunId".to_string(), id);
                }
                if let Some(id) = session.get("taskId").cloned().filter(|v| !v.is_null()) {
                    message.insert("taskId".to_string(), id);
                }
                if let Some(member) = session.get("memberId").cloned().filter(|v| !v.is_null()) {
                    message.insert("toMemberId".to_string(), member);
                }
                message.insert("text".to_string(), json!(text));
                message.insert("attachmentIds".to_string(), Value::Array(attachment_ids));
                message.insert("createdAt".to_string(), json!(now_iso()));
                Value::Object(message)
            }
        };
        {
            let db = self.db.lock().unwrap();
            Repositories::new(&db.raw).sessions().save_message(&message)?;
        }
        let run_id = self
            .runs()?
            .start(
                &session,
                &agent,
                &turn_context.prompt,
                RunContext {
                    project_run_id: session.get("projectRunId").and_then(Value::as_str).map(str::to_string),
                    task_id: session.get("taskId").and_then(Value::as_str).map(str::to_string),
                    member_id: session.get("memberId").and_then(Value::as_str).map(str::to_string),
                    local_image_paths: if turn_context.local_image_paths.is_empty() {
                        None
                    } else {
                        Some(turn_context.local_image_paths)
                    },
                    synchronize_provider_context: turn_context.recovered,
                    ..Default::default()
                },
            )
            .await?;
        Ok(json!({ "accepted": true, "runId": run_id }))
    }

    /// session.followUp — steer mid-turn when the provider supports it,
    /// otherwise queue as the next turn.
    pub async fn follow_up(&self, input: &Value) -> CoreResult<Value> {
        let session_id = input.get("sessionId").and_then(Value::as_str).unwrap_or("");
        let text = input.get("text").and_then(Value::as_str).unwrap_or("").trim().to_string();
        if text.is_empty() {
            return Err(invalid("text", "Guidance cannot be empty."));
        }
        let mode = input.get("mode").and_then(Value::as_str).unwrap_or("queue");
        self.heal_follow_ups(session_id);
        let session = {
            let db = self.db.lock().unwrap();
            Repositories::new(&db.raw).sessions().get(session_id)?.ok_or_else(|| not_found("session", session_id))?
        };
        let runs = self.runs()?;
        // Only providers with an in-flight steer channel can inject mid-turn;
        // every other CLI takes the queue path.
        if mode == "steer" && runs.can_steer(session_id) {
            runs.steer_session(session_id, &text).await?;
            let message = follow_up_message(&session, &text);
            let db = self.db.lock().unwrap();
            Repositories::new(&db.raw).sessions().save_message(&message)?;
            return Ok(json!({ "accepted": true, "mode": "steer" }));
        }

        let (existing_messages, artifacts, project_root) = {
            let db = self.db.lock().unwrap();
            let repos = Repositories::new(&db.raw);
            let session_artifacts = repos.artifacts().list(None, None, Some(session_id))?;
            let project_run_artifacts = match session.get("projectRunId").and_then(Value::as_str) {
                Some(id) => repos.artifacts().list(Some(id), None, None)?,
                None => vec![],
            };
            let root = repos
                .projects()
                .get(session.get("projectId").and_then(Value::as_str).unwrap_or(""))
                .ok()
                .flatten()
                .and_then(|project| project.get("rootPath").and_then(Value::as_str).map(str::to_string));
            (
                repos.sessions().messages(session_id)?,
                merge_artifacts(session_artifacts, project_run_artifacts),
                root,
            )
        };
        let agent = MemberRouter::new(self.db.clone()).resolve_session(&session)?;
        let turn_context = build_bound_turn_context(&session, TurnContextInput {
            current_text: &text,
            messages: &existing_messages,
            artifacts: &artifacts,
            current_attachments: &[],
            recover_provider_context: session.get("providerSessionId").is_none()
                || session.get("providerContextSyncedAt").is_none(),
            workspace_root: project_root.as_deref(),
        })?;
        let message = follow_up_message(&session, &text);
        {
            let db = self.db.lock().unwrap();
            Repositories::new(&db.raw).sessions().save_message(&message)?;
        }
        let message_id = message.get("id").and_then(Value::as_str).unwrap_or("").to_string();
        let queued_at = message.get("createdAt").and_then(Value::as_str).unwrap_or("").to_string();
        self.track_pending_follow_up(session_id, json!({ "messageId": message_id, "text": text, "queuedAt": queued_at }));
        if let Some(events) = self.events.read().unwrap().clone() {
            let _ = events.append_for_session(
                &session,
                &json!({
                    "projectRunId": session.get("projectRunId").cloned().unwrap_or(Value::Null),
                    "taskId": session.get("taskId").cloned().unwrap_or(Value::Null)
                }),
                "session.follow_up_queued",
                json!({ "messageId": message_id, "text": text }),
            );
        }
        // Do not await here: Queue acknowledges immediately while the active
        // turn continues uninterrupted. The queueKey lets a withdrawn
        // follow-up skip its launch entirely.
        let sessions_service = SessionFollowUpTracker {
            db: self.db.clone(),
            pending: self.pending_follow_ups.clone(),
        };
        let queued_session = session.clone();
        let queued_agent = agent.clone();
        let queued_prompt = turn_context.prompt.clone();
        let queued_recovered = turn_context.recovered;
        let queued_project_run_id = session.get("projectRunId").and_then(Value::as_str).map(str::to_string);
        let queued_task_id = session.get("taskId").and_then(Value::as_str).map(str::to_string);
        let queued_member_id = session.get("memberId").and_then(Value::as_str).map(str::to_string);
        let queued_message_id = message_id.clone();
        let session_id_owned = session_id.to_string();
        tokio::spawn(async move {
            let result = runs
                .start(
                    &queued_session,
                    &queued_agent,
                    &queued_prompt,
                    RunContext {
                        project_run_id: queued_project_run_id,
                        task_id: queued_task_id,
                        member_id: queued_member_id,
                        synchronize_provider_context: queued_recovered,
                        queue_key: Some(queued_message_id.clone()),
                        ..Default::default()
                    },
                )
                .await;
            if let Err(error) = &result {
                if !error.to_string().contains("withdrawn") {
                    eprintln!("[nautilo-core] failed to start queued session follow-up: {error}");
                }
            }
            sessions_service.untrack(&session_id_owned, &queued_message_id);
        });
        Ok(json!({ "accepted": true, "mode": "queue" }))
    }

    /// Journals session.follow_up_cancelled for every queued follow-up in this
    /// session's journal that was never cancelled and is not pending in THIS
    /// process. The pending queue is in-memory, so a daemon restart orphans
    /// the journaled entries and every full replay would show them as queued
    /// forever. Messages are NOT deleted here — an orphaned entry may belong
    /// to a turn that actually ran before the restart. Best-effort, once per
    /// session per process.
    pub fn heal_follow_ups(&self, session_id: &str) {
        if session_id.is_empty() || !self.healed_follow_up_sessions.lock().unwrap().insert(session_id.to_string()) {
            return;
        }
        let journal: Vec<Value> = {
            let db = self.db.lock().unwrap();
            let mut statement = match db.raw.prepare(
                "SELECT data FROM runtime_events WHERE session_id = ?1 \
                 AND json_extract(data, '$.type') IN ('session.follow_up_queued', 'session.follow_up_cancelled') \
                 ORDER BY sequence, rowid",
            ) {
                Ok(statement) => statement,
                Err(_) => return,
            };
            let rows = match statement.query_map([session_id], |row| row.get::<_, String>(0)) {
                Ok(rows) => rows,
                Err(_) => return,
            };
            let collected: Vec<Value> = rows
                .filter_map(|row| row.ok())
                .filter_map(|data| serde_json::from_str(&data).ok())
                .collect();
            collected
        };
        // Fold in journal order; entries still pending in this process are
        // genuinely queued and must survive.
        let live: std::collections::HashSet<String> = self
            .pending_follow_ups
            .lock()
            .unwrap()
            .get(session_id)
            .cloned()
            .unwrap_or_default()
            .iter()
            .filter_map(|entry| entry.get("messageId").and_then(Value::as_str).map(str::to_string))
            .collect();
        let mut open: Vec<String> = Vec::new();
        for event in &journal {
            let message_id = event.get("payload").and_then(|payload| payload.get("messageId")).and_then(Value::as_str).unwrap_or("").to_string();
            if message_id.is_empty() || live.contains(&message_id) {
                continue;
            }
            open.retain(|id| id != &message_id);
            if event.get("type").and_then(Value::as_str) == Some("session.follow_up_queued") {
                open.push(message_id);
            }
        }
        if open.is_empty() {
            return;
        }
        let session = {
            let db = self.db.lock().unwrap();
            Repositories::new(&db.raw).sessions().get(session_id).ok().flatten()
        };
        let Some(session) = session else { return };
        let Some(events) = self.events.read().unwrap().clone() else { return };
        for message_id in open {
            let _ = events.append_for_session(
                &session,
                &json!({
                    "projectRunId": session.get("projectRunId").cloned().unwrap_or(Value::Null),
                    "taskId": session.get("taskId").cloned().unwrap_or(Value::Null)
                }),
                "session.follow_up_cancelled",
                json!({ "messageId": message_id }),
            );
        }
    }

    /// session.followUp.cancel — withdraws a queued follow-up.
    pub fn follow_up_cancel(&self, input: &Value) -> CoreResult<Value> {
        let session_id = input.get("sessionId").and_then(Value::as_str).unwrap_or("");
        let message_id = input.get("messageId").and_then(Value::as_str).unwrap_or("");
        let session = {
            let db = self.db.lock().unwrap();
            Repositories::new(&db.raw).sessions().get(session_id)?.ok_or_else(|| not_found("session", session_id))?
        };
        if self.pending_follow_up(session_id, message_id).is_none() {
            // Not pending in this process: either the turn already started
            // (reject, same as before) or the entry is a replayed zombie from
            // before a daemon restart — that one can never start, so journal
            // the cancellation and let the user withdraw it.
            let has_active_run = {
                let db = self.db.lock().unwrap();
                Repositories::new(&db.raw).runs().list()?.into_iter().any(|run| {
                    run.get("sessionId").and_then(Value::as_str) == Some(session_id)
                        && !TERMINAL_RUN_STATUSES.contains(&run.get("status").and_then(Value::as_str).unwrap_or(""))
                })
            };
            if has_active_run {
                return Err(invalid("messageId", "Follow-up is no longer queued; it may have already started."));
            }
            if let Some(events) = self.events.read().unwrap().clone() {
                let _ = events.append_for_session(
                    &session,
                    &json!({
                        "projectRunId": session.get("projectRunId").cloned().unwrap_or(Value::Null),
                        "taskId": session.get("taskId").cloned().unwrap_or(Value::Null)
                    }),
                    "session.follow_up_cancelled",
                    json!({ "messageId": message_id }),
                );
            }
            let db = self.db.lock().unwrap();
            let _ = Repositories::new(&db.raw).sessions().delete_message(session_id, message_id);
            return Ok(json!({ "cancelled": true }));
        }
        self.runs()?.cancel_queued(session_id, message_id);
        self.untrack_pending_follow_up(session_id, message_id);
        {
            let db = self.db.lock().unwrap();
            Repositories::new(&db.raw).sessions().delete_message(session_id, message_id)?;
        }
        if let Some(events) = self.events.read().unwrap().clone() {
            let _ = events.append_for_session(
                &session,
                &json!({
                    "projectRunId": session.get("projectRunId").cloned().unwrap_or(Value::Null),
                    "taskId": session.get("taskId").cloned().unwrap_or(Value::Null)
                }),
                "session.follow_up_cancelled",
                json!({ "messageId": message_id }),
            );
        }
        Ok(json!({ "cancelled": true }))
    }
}

fn merge_artifacts(session_artifacts: Vec<Value>, project_run_artifacts: Vec<Value>) -> Vec<Value> {
    let mut by_id = std::collections::HashMap::new();
    for artifact in session_artifacts.into_iter().chain(project_run_artifacts) {
        if let Some(id) = artifact.get("id").and_then(Value::as_str) {
            by_id.insert(id.to_string(), artifact);
        }
    }
    by_id.into_values().collect()
}

/// Untracks a queued follow-up from the spawned queue callback, where &self
/// is unavailable.
struct SessionFollowUpTracker {
    db: Arc<Mutex<Database>>,
    pending: Arc<Mutex<std::collections::HashMap<String, Vec<Value>>>>,
}

impl SessionFollowUpTracker {
    fn untrack(&self, session_id: &str, message_id: &str) {
        let _ = &self.db;
        let mut pending = self.pending.lock().unwrap();
        if let Some(items) = pending.get_mut(session_id) {
            items.retain(|item| item.get("messageId").and_then(Value::as_str) != Some(message_id));
            if items.is_empty() {
                pending.remove(session_id);
            }
        }
    }
}

fn descendant_session_ids(sessions: &[Value], root_id: &str) -> Vec<String> {
    let mut ids: Vec<String> = vec![root_id.to_string()];
    let mut added = true;
    while added {
        added = false;
        for session in sessions {
            let parent = session.get("parentSessionId").and_then(Value::as_str);
            let id = session.get("id").and_then(Value::as_str);
            if let (Some(parent), Some(id)) = (parent, id) {
                if ids.iter().any(|known| known == parent) && !ids.iter().any(|known| known == id) {
                    ids.push(id.to_string());
                    added = true;
                }
            }
        }
    }
    ids
}

/// Builds the user message JSON shared by send/followUp (message shape only;
/// run kickoff stays in the run pipeline port).
pub fn follow_up_message(session: &Value, text: &str) -> Value {
    let mut message = Map::new();
    message.insert("id".to_string(), json!(Uuid::new_v4().to_string()));
    message.insert("sessionId".to_string(), session.get("id").cloned().unwrap_or(Value::Null));
    message.insert("sender".to_string(), json!("user"));
    message.insert("kind".to_string(), json!("chat"));
    for key in ["projectRunId", "taskId"] {
        if let Some(value) = session.get(key).cloned().filter(|v| !v.is_null()) {
            message.insert(key.to_string(), value);
        }
    }
    if let Some(member) = session.get("memberId").cloned().filter(|v| !v.is_null()) {
        message.insert("toMemberId".to_string(), member);
    }
    message.insert("text".to_string(), json!(text));
    message.insert("createdAt".to_string(), json!(now_iso()));
    Value::Object(message)
}

/// null resets a session override; absent fields remain absent/preserve merged state.
fn normalize_session_permission(session: &mut Value) {
    let Some(object) = session.as_object_mut() else { return; };
    let Some(value) = object.get("permissionMode") else { return; };
    match value.as_str().map(str::trim).filter(|mode| !mode.is_empty()) {
        Some(mode) => { let mode = mode.to_string(); object.insert("permissionMode".into(), Value::String(mode)); }
        None => { object.remove("permissionMode"); }
    }
}

#[cfg(test)]
mod permission_reset_tests {
    use super::*;
    #[test]
    fn null_reset_clears_old_override_after_json_merge() {
        let mut stored = json!({ "permissionMode": "full-access", "providerSessionId": "thread" });
        let request: Value = serde_json::from_str(r#"{"permissionMode":null}"#).unwrap();
        stored.as_object_mut().unwrap().extend(request.as_object().unwrap().clone());
        normalize_session_permission(&mut stored);
        assert!(stored.get("permissionMode").is_none());
        assert_eq!(stored["providerSessionId"], "thread");
    }
    #[test]
    fn omitted_preserves_and_explicit_modes_are_normalized() {
        let mut stored = json!({ "permissionMode": "full-access" });
        normalize_session_permission(&mut stored);
        assert_eq!(stored["permissionMode"], "full-access");
        stored["permissionMode"] = json!(" plan ");
        normalize_session_permission(&mut stored);
        assert_eq!(stored["permissionMode"], "plan");
        stored["permissionMode"] = Value::Null;
        normalize_session_permission(&mut stored);
        assert!(stored.get("permissionMode").is_none());
    }
}
