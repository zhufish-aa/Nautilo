//! Crash recovery — port of runtime/recovery-service.ts.

use std::sync::{Arc, Mutex};

use serde_json::{json, Map, Value};

use crate::database::{Database, Repositories};
use crate::errors::{now_iso, CoreResult};
use crate::runtime::event_service::EventService;
use crate::runtime::observability::AuditService;

const INTERRUPTED_RUN: [&str; 6] = ["created", "starting", "running", "waiting_input", "waiting_approval", "cancelling"];
const INTERRUPTED_PROJECT: [&str; 5] = ["planning", "plan_review", "executing", "verifying", "merging"];

pub struct RecoveryService {
    db: Arc<Mutex<Database>>,
    audit: Arc<AuditService>,
    events: Arc<EventService>,
}

impl RecoveryService {
    pub fn new(db: Arc<Mutex<Database>>, audit: Arc<AuditService>, events: Arc<EventService>) -> Self {
        Self { db, audit, events }
    }

    /// Marks everything the dead daemon left in flight as interrupted.
    pub fn recover_interrupted(&self) -> CoreResult<Value> {
        let now = now_iso();
        let mut agent_runs = 0;
        let mut project_runs = 0;
        let mut sessions = 0;
        let mut tasks = 0;
        let mut needs_terminal_event: Vec<Value> = vec![];
        {
            let db = self.db.lock().unwrap();
            let repos = Repositories::new(&db.raw);
            for run in repos.runs().list()? {
                let status = run.get("status").and_then(Value::as_str).unwrap_or("");
                let interrupted = INTERRUPTED_RUN.contains(&status);
                if interrupted {
                    let mut updated = run.as_object().cloned().unwrap_or_default();
                    updated.insert("status".to_string(), json!("crashed"));
                    updated.insert("endedAt".to_string(), json!(now_iso()));
                    updated.insert("failureCode".to_string(), json!("DAEMON_RESTARTED"));
                    repos.runs().save(&Value::Object(updated))?;
                    agent_runs += 1;
                }
                // A run that died with the daemon never emitted its terminal
                // event; append it so timelines don't replay dangling steps.
                // The DB guard must not be held while appending (the event
                // journal locks the same handle), so collect and defer.
                if interrupted || status == "crashed" {
                    needs_terminal_event.push(run);
                }
            }
            for session in repos.sessions().list_all()? {
                let status = session.get("status").and_then(Value::as_str).unwrap_or("");
                if ["running", "waiting_input", "waiting_approval"].contains(&status) {
                    let mut updated = session.as_object().cloned().unwrap_or_default();
                    updated.insert("status".to_string(), json!("waiting_input"));
                    updated.insert("updatedAt".to_string(), json!(now_iso()));
                    repos.sessions().save(&Value::Object(updated))?;
                    sessions += 1;
                }
            }
            for run in repos.project_runs().list_all()? {
                let status = run.get("status").and_then(Value::as_str).unwrap_or("");
                if INTERRUPTED_PROJECT.contains(&status) {
                    let mut updated = run.as_object().cloned().unwrap_or_default();
                    updated.insert("status".to_string(), json!("paused"));
                    updated.insert("recoveryReason".to_string(), json!("daemon_restarted"));
                    updated.insert("updatedAt".to_string(), json!(now_iso()));
                    repos.project_runs().save(&Value::Object(updated))?;
                    project_runs += 1;
                }
            }
            for task in repos.tasks().list_all()? {
                let status = task.get("status").and_then(Value::as_str).unwrap_or("");
                if ["queued", "running", "verifying"].contains(&status) {
                    let mut updated = task.as_object().cloned().unwrap_or_default();
                    updated.insert("status".to_string(), json!("waiting_user"));
                    updated.insert("updatedAt".to_string(), json!(now_iso()));
                    repos.tasks().save(&Value::Object(updated))?;
                    tasks += 1;
                }
            }
        }
        for run in &needs_terminal_event {
            drop_guardless_ensure_terminal_event(&self.db, &self.events, run);
        }
        if agent_runs + project_runs + sessions + tasks > 0 {
            let mut record = Map::new();
            record.insert("actorType".to_string(), json!("system"));
            record.insert("actorId".to_string(), json!("core-daemon"));
            record.insert("action".to_string(), json!("recovery.mark_interrupted"));
            record.insert("resourceType".to_string(), json!("runtime"));
            record.insert("outcome".to_string(), json!("success"));
            record.insert("details".to_string(), json!({
                "agentRuns": agent_runs,
                "projectRuns": project_runs,
                "sessions": sessions,
                "tasks": tasks
            }));
            self.audit.record(record);
        }
        Ok(json!({
            "agentRuns": agent_runs,
            "projectRuns": project_runs,
            "sessions": sessions,
            "tasks": tasks
        }))
    }

    /// recovery.list — paused/failed project runs with their resume metadata.
    pub fn list(&self) -> CoreResult<Vec<Value>> {
        let db = self.db.lock().unwrap();
        let repos = Repositories::new(&db.raw);
        let mut result = vec![];
        for project_run in repos.project_runs().list_all()? {
            let status = project_run.get("status").and_then(Value::as_str).unwrap_or("");
            if !["paused", "failed"].contains(&status) {
                continue;
            }
            let team = project_run
                .get("teamId")
                .and_then(Value::as_str)
                .and_then(|id| repos.teams().get(id).ok().flatten());
            let Some(team) = team else { continue };
            let session = project_run
                .get("mainSessionId")
                .and_then(Value::as_str)
                .and_then(|id| repos.sessions().get(id).ok().flatten());
            let enabled_member_ids: Vec<Value> = team
                .get("members")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
                .iter()
                .filter(|member| {
                    member.get("enabled").and_then(Value::as_bool) == Some(true)
                        && member
                            .get("agentInstanceId")
                            .and_then(Value::as_str)
                            .and_then(|id| repos.agents().get(id).ok().flatten())
                            .is_some_and(|agent| agent.get("enabled").and_then(Value::as_bool) == Some(true))
                })
                .filter_map(|member| member.get("id").cloned())
                .collect();
            result.push(json!({
                "projectRun": project_run,
                "currentMainMemberId": project_run.get("mainMemberId").cloned().unwrap_or(Value::Null),
                "enabledMemberIds": enabled_member_ids,
                "canResumeProviderSession": session.and_then(|s| s.get("providerSessionId").cloned()).is_some_and(|v| !v.is_null())
            }));
        }
        Ok(result)
    }
}

/// Appends the terminal event a dead run never emitted. Runs driven with
/// provider_command presentation have no lifecycle events, so the run.started
/// guard keeps them untouched.
fn drop_guardless_ensure_terminal_event(db: &Arc<Mutex<Database>>, events: &Arc<EventService>, run: &Value) {
    let (session, started, terminal) = {
        let guard = db.lock().unwrap();
        let repos = Repositories::new(&guard.raw);
        let session = run
            .get("sessionId")
            .and_then(Value::as_str)
            .and_then(|id| repos.sessions().get(id).ok().flatten());
        let Some(session) = session else { return };
        let log = repos.events().replay(Some(session.get("id").and_then(Value::as_str).unwrap_or("")), None, None, None).unwrap_or_default();
        let run_id = run.get("id").and_then(Value::as_str).unwrap_or("");
        let started = log.iter().any(|event| {
            event.get("type").and_then(Value::as_str) == Some("run.started")
                && event.get("runId").and_then(Value::as_str) == Some(run_id)
        });
        let terminal = log.iter().any(|event| {
            matches!(event.get("type").and_then(Value::as_str), Some("run.completed" | "run.failed"))
                && event.get("runId").and_then(Value::as_str) == Some(run_id)
        });
        (session, started, terminal)
    };
    if !started || terminal {
        return;
    }
    let _ = events.append(run, &session, "run.failed", json!({
        "code": "DAEMON_RESTARTED",
        "message": "Nautilo exited while this run was still in progress; the run was interrupted.",
        "retryable": true
    }));
}
