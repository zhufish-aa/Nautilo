//! Schema migrations — port of database/migrations.ts.
//! The schema is byte-identical so existing agenthub.sqlite files open unchanged.

use rusqlite::Connection;
use serde_json::{Map, Value};

use crate::errors::CoreResult;
use crate::database::connection::db_fail;

/// Port of migrateDatabase in database/migrations.ts.
pub fn migrate(db: &Connection) -> CoreResult<()> {
    db.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS teams (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS project_runs (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS idx_project_runs_project ON project_runs(project_id, updated_at DESC);
        CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, member_id TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id, updated_at DESC);
        CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);
        CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, project_run_id TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS idx_tasks_run ON tasks(project_run_id, updated_at);
        CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS idx_runs_session ON runs(session_id, updated_at DESC);
        CREATE TABLE IF NOT EXISTS runtime_events (event_id TEXT PRIMARY KEY, sequence INTEGER NOT NULL, session_id TEXT, project_run_id TEXT, run_id TEXT, data TEXT NOT NULL, timestamp TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS idx_events_session_sequence ON runtime_events(session_id, sequence);
        CREATE INDEX IF NOT EXISTS idx_events_run_sequence ON runtime_events(run_id, sequence);
        CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY, kind TEXT NOT NULL, project_run_id TEXT, task_id TEXT, session_id TEXT, data TEXT NOT NULL, created_at TEXT NOT NULL, size_bytes INTEGER NOT NULL DEFAULT 0);
        CREATE INDEX IF NOT EXISTS idx_artifacts_created ON artifacts(created_at);
        CREATE INDEX IF NOT EXISTS idx_artifacts_project_run ON artifacts(project_run_id, created_at);
        CREATE TABLE IF NOT EXISTS verification_results (id TEXT PRIMARY KEY, project_run_id TEXT NOT NULL, task_id TEXT, data TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS idx_verification_project_run ON verification_results(project_run_id, created_at);
        CREATE TABLE IF NOT EXISTS permission_policies (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY, status TEXT NOT NULL, project_run_id TEXT, data TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status, created_at DESC);
        CREATE TABLE IF NOT EXISTS audit_logs (id TEXT PRIMARY KEY, action TEXT NOT NULL, resource_id TEXT, outcome TEXT NOT NULL, data TEXT NOT NULL, timestamp TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_logs(timestamp DESC);
        CREATE TABLE IF NOT EXISTS credentials (agent_instance_id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS capabilities (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS checkpoints (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, run_id TEXT, created_at TEXT NOT NULL, truncated INTEGER NOT NULL DEFAULT 0);
        CREATE INDEX IF NOT EXISTS idx_checkpoints_session ON checkpoints(session_id, created_at);
        CREATE TABLE IF NOT EXISTS run_touched_files (run_id TEXT NOT NULL, path TEXT NOT NULL, PRIMARY KEY(run_id, path));
        INSERT INTO schema_meta(key, value) VALUES('schema', '4') ON CONFLICT(key) DO NOTHING;
        ",
    )
    .map_err(db_fail)?;
    ensure_column(db, "artifacts", "project_run_id", "TEXT")?;
    ensure_column(db, "artifacts", "task_id", "TEXT")?;
    ensure_column(db, "artifacts", "session_id", "TEXT")?;
    db.execute_batch(include_str!("history_projection.sql")).map_err(db_fail)?;
    let version = current_schema_version(db)?;
    if version < 5 {
        migrate_execution_defaults_to_team_members(db)?;
    }
    if version < 5 {
        set_schema_version(db, 5)?;
    }
    // Schema 6 adds the capabilities table (user-managed skills and MCP servers).
    if version < 6 {
        set_schema_version(db, 6)?;
    }
    // Schema 7 adds per-turn checkpoints (workspace snapshots) and run touched files.
    if version < 7 {
        set_schema_version(db, 7)?;
    }
    if version < 8 {
        set_schema_version(db, 8)?;
    }
    Ok(())
}

fn ensure_column(db: &Connection, table: &str, column: &str, column_type: &str) -> CoreResult<()> {
    let mut stmt = db.prepare(&format!("PRAGMA table_info({table})")).map_err(db_fail)?;
    let names: Vec<String> = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(db_fail)?
        .collect::<Result<_, _>>()
        .map_err(db_fail)?;
    if !names.iter().any(|name| name == column) {
        db.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {column} {column_type}"))
            .map_err(db_fail)?;
    }
    Ok(())
}

fn current_schema_version(db: &Connection) -> CoreResult<i64> {
    let value: Option<String> = db
        .query_row("SELECT value FROM schema_meta WHERE key = 'schema'", [], |row| row.get(0))
        .ok();
    Ok(value.and_then(|v| v.parse::<i64>().ok()).unwrap_or(0))
}

fn set_schema_version(db: &Connection, version: i64) -> CoreResult<()> {
    db.execute(
        "INSERT INTO schema_meta(key, value) VALUES('schema', ?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        [version.to_string()],
    )
    .map_err(db_fail)?;
    Ok(())
}

#[derive(Default)]
struct ExecutionDefaults {
    model: Option<String>,
    reasoning_effort: Option<String>,
    service_tier: Option<String>,
}

/// Schema 5 separates a reusable CLI connection from execution policy:
/// AgentInstance owns connectivity, TeamMember owns delegated-run defaults, and
/// Session stores the immutable choices used by a concrete conversation.
fn migrate_execution_defaults_to_team_members(db: &Connection) -> CoreResult<()> {
    use std::collections::HashMap;
    let mut agent_defaults: HashMap<String, ExecutionDefaults> = HashMap::new();
    let mut member_defaults: HashMap<String, ExecutionDefaults> = HashMap::new();

    db.execute_batch("BEGIN IMMEDIATE").map_err(db_fail)?;
    let result = (|| -> CoreResult<()> {
        for (id, data) in json_rows(db, "agents")? {
            let Some(mut agent) = parse_record(&data) else { continue };
            let defaults = execution_defaults(&agent);
            if defaults.model.is_some() || defaults.reasoning_effort.is_some() || defaults.service_tier.is_some() {
                agent_defaults.insert(id.clone(), defaults);
            }
            let changed = agent.remove("model").is_some()
                | agent.remove("reasoningEffort").is_some()
                | agent.remove("serviceTier").is_some();
            if changed {
                update_json(db, "agents", &id, &agent)?;
            }
        }

        for (id, data) in json_rows(db, "teams")? {
            let Some(mut team) = parse_record(&data) else { continue };
            let Some(members) = team.get_mut("members").and_then(Value::as_array_mut) else { continue };
            let mut changed = false;
            for value in members.iter_mut() {
                let Some(member) = value.as_object_mut() else { continue };
                let empty = ExecutionDefaults::default();
                let inherited = member
                    .get("agentInstanceId")
                    .and_then(string_value)
                    .and_then(|key| agent_defaults.get(&key))
                    .unwrap_or(&empty);
                changed |= copy_missing_defaults(member, inherited);
                if let Some(member_id) = member.get("id").and_then(string_value) {
                    member_defaults.insert(format!("{id}:{member_id}"), execution_defaults(member));
                }
            }
            if changed {
                update_json(db, "teams", &id, &team)?;
            }
        }

        for (id, data) in json_rows(db, "sessions")? {
            let Some(mut session) = parse_record(&data) else { continue };
            let team_id = session.get("teamId").and_then(string_value);
            let member_id = session.get("memberId").and_then(string_value);
            let instance_id = session
                .get("agentInstanceId")
                .and_then(string_value)
                .or_else(|| member_id.clone());
            let inherited = match (&team_id, &member_id) {
                (Some(team), Some(member)) => member_defaults
                    .get(&format!("{team}:{member}"))
                    .or_else(|| instance_id.as_ref().and_then(|key| agent_defaults.get(key))),
                _ => instance_id.as_ref().and_then(|key| agent_defaults.get(key)),
            };
            if let Some(inherited) = inherited {
                if copy_missing_defaults(&mut session, inherited) {
                    update_json(db, "sessions", &id, &session)?;
                }
            }
        }
        Ok(())
    })();
    match result {
        Ok(()) => {
            db.execute_batch("COMMIT").map_err(db_fail)?;
            Ok(())
        }
        Err(error) => {
            let _ = db.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

fn json_rows(db: &Connection, table: &str) -> CoreResult<Vec<(String, String)>> {
    let mut stmt = db.prepare(&format!("SELECT id, data FROM {table}")).map_err(db_fail)?;
    let rows = stmt
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
        .map_err(db_fail)?
        .collect::<Result<_, _>>()
        .map_err(db_fail)?;
    Ok(rows)
}

fn update_json(db: &Connection, table: &str, id: &str, value: &Map<String, Value>) -> CoreResult<()> {
    db.execute(
        &format!("UPDATE {table} SET data = ?1 WHERE id = ?2"),
        rusqlite::params![Value::Object(value.clone()).to_string(), id],
    )
    .map_err(db_fail)?;
    Ok(())
}

fn parse_record(value: &str) -> Option<Map<String, Value>> {
    serde_json::from_str::<Value>(value).ok()?.as_object().cloned()
}

fn string_value(value: &Value) -> Option<String> {
    value.as_str().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)
}

fn execution_defaults(value: &Map<String, Value>) -> ExecutionDefaults {
    ExecutionDefaults {
        model: value.get("model").and_then(string_value),
        reasoning_effort: value.get("reasoningEffort").and_then(string_value),
        service_tier: value.get("serviceTier").and_then(string_value),
    }
}

fn copy_missing_defaults(target: &mut Map<String, Value>, source: &ExecutionDefaults) -> bool {
    let mut changed = false;
    let pairs = [
        ("model", &source.model),
        ("reasoningEffort", &source.reasoning_effort),
        ("serviceTier", &source.service_tier),
    ];
    for (key, value) in pairs {
        if !target.contains_key(key) {
            if let Some(value) = value {
                target.insert(key.to_string(), Value::String(value.clone()));
                changed = true;
            }
        }
    }
    changed
}
