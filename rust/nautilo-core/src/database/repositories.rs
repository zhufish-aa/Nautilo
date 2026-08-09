//! Repository layer: faithful port of packages/core-daemon/src/database/*.ts
//! (json-repository.ts plus the per-entity repositories).
//! Entities stay opaque serde_json::Values — the DB stores JSON documents,
//! so the Rust port does not need full domain structs to persist them.

use rusqlite::{params, Connection};
use serde_json::{json, Value};

use crate::database::connection::db_fail;
use crate::errors::{CoreError, CoreResult, ErrorCode};

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn parse_row(data: String) -> Value {
    serde_json::from_str(&data).unwrap_or(Value::Null)
}

fn id_of(value: &Value) -> CoreResult<&str> {
    value
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| CoreError::reason(ErrorCode::IpcInvalidRequest, "entity is missing id"))
}

fn str_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

/// Port of JsonRepository<T> (save/get/list/remove over a JSON document table).
pub struct JsonRepository<'a> {
    db: &'a Connection,
    table: &'static str,
}

impl<'a> JsonRepository<'a> {
    pub fn new(db: &'a Connection, table: &'static str) -> Self {
        Self { db, table }
    }

    pub fn save(&self, value: &Value, updated_at: &str) -> CoreResult<()> {
        self.db
            .prepare(&format!(
                "INSERT INTO {t}(id, data, updated_at) VALUES(?1, ?2, ?3) \
                 ON CONFLICT(id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at",
                t = self.table
            ))
            .map_err(db_fail)?
            .execute(params![id_of(value)?, value.to_string(), updated_at])
            .map_err(db_fail)?;
        Ok(())
    }

    pub fn get(&self, id: &str) -> CoreResult<Option<Value>> {
        let row = self
            .db
            .prepare(&format!("SELECT data FROM {t} WHERE id = ?1", t = self.table))
            .map_err(db_fail)?
            .query_row(params![id], |row| row.get::<_, String>(0))
            .ok();
        Ok(row.map(parse_row))
    }

    pub fn list(&self, order: &str) -> CoreResult<Vec<Value>> {
        let mut stmt = self
            .db
            .prepare(&format!("SELECT data FROM {t} ORDER BY {order}", t = self.table))
            .map_err(db_fail)?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(db_fail)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_fail)?;
        Ok(rows.into_iter().map(parse_row).collect())
    }

    pub fn list_default(&self) -> CoreResult<Vec<Value>> {
        self.list("updated_at DESC")
    }

    pub fn remove(&self, id: &str) -> CoreResult<bool> {
        let changes = self
            .db
            .prepare(&format!("DELETE FROM {t} WHERE id = ?1", t = self.table))
            .map_err(db_fail)?
            .execute(params![id])
            .map_err(db_fail)?;
        Ok(changes > 0)
    }
}

/// Table-bound repositories equivalent to the TS one-liner subclasses.
pub struct Repositories<'a> {
    db: &'a Connection,
}

impl<'a> Repositories<'a> {
    pub fn new(db: &'a Connection) -> Self {
        Self { db }
    }

    pub fn projects(&self) -> JsonRepository<'a> {
        JsonRepository::new(self.db, "projects")
    }
    pub fn agents(&self) -> JsonRepository<'a> {
        JsonRepository::new(self.db, "agents")
    }
    pub fn teams(&self) -> JsonRepository<'a> {
        JsonRepository::new(self.db, "teams")
    }
    pub fn policies(&self) -> JsonRepository<'a> {
        JsonRepository::new(self.db, "permission_policies")
    }
    pub fn capabilities(&self) -> JsonRepository<'a> {
        JsonRepository::new(self.db, "capabilities")
    }
    pub fn sessions(&self) -> SessionRepository<'a> {
        SessionRepository { db: self.db }
    }
    pub fn runs(&self) -> RunRepository<'a> {
        RunRepository { db: self.db }
    }
    pub fn tasks(&self) -> TaskRepository<'a> {
        TaskRepository { db: self.db }
    }
    pub fn project_runs(&self) -> ProjectRunRepository<'a> {
        ProjectRunRepository { db: self.db }
    }
    pub fn events(&self) -> EventRepository<'a> {
        EventRepository { db: self.db }
    }
    pub fn artifacts(&self) -> ArtifactRepository<'a> {
        ArtifactRepository { db: self.db }
    }
    pub fn verifications(&self) -> VerificationRepository<'a> {
        VerificationRepository { db: self.db }
    }
    pub fn approvals(&self) -> ApprovalRepository<'a> {
        ApprovalRepository { db: self.db }
    }
    pub fn audit(&self) -> AuditRepository<'a> {
        AuditRepository { db: self.db }
    }
    pub fn credentials(&self) -> CredentialRepository<'a> {
        CredentialRepository { db: self.db }
    }
}

pub struct SessionRepository<'a> {
    db: &'a Connection,
}

impl<'a> SessionRepository<'a> {
    pub fn save(&self, session: &Value) -> CoreResult<()> {
        self.db
            .prepare(
                "INSERT INTO sessions(id, project_id, member_id, data, updated_at) VALUES(?1, ?2, ?3, ?4, ?5) \
                 ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id, member_id=excluded.member_id, \
                 data=excluded.data, updated_at=excluded.updated_at",
            )
            .map_err(db_fail)?
            .execute(params![
                id_of(session)?,
                str_field(session, "projectId").unwrap_or(""),
                str_field(session, "memberId").unwrap_or(""),
                session.to_string(),
                str_field(session, "updatedAt").unwrap_or("")
            ])
            .map_err(db_fail)?;
        Ok(())
    }

    pub fn get(&self, id: &str) -> CoreResult<Option<Value>> {
        let row = self
            .db
            .prepare("SELECT data FROM sessions WHERE id = ?1")
            .map_err(db_fail)?
            .query_row(params![id], |row| row.get::<_, String>(0))
            .ok();
        Ok(row.map(parse_row))
    }

    pub fn list(&self, project_id: &str, member_id: Option<&str>) -> CoreResult<Vec<Value>> {
        let rows: Vec<String> = match member_id {
            Some(member) => self
                .db
                .prepare("SELECT data FROM sessions WHERE project_id = ?1 AND member_id = ?2 ORDER BY updated_at DESC")
                .map_err(db_fail)?
                .query_map(params![project_id, member], |row| row.get(0))
                .map_err(db_fail)?
                .collect::<Result<_, _>>()
                .map_err(db_fail)?,
            None => self
                .db
                .prepare("SELECT data FROM sessions WHERE project_id = ?1 ORDER BY updated_at DESC")
                .map_err(db_fail)?
                .query_map(params![project_id], |row| row.get(0))
                .map_err(db_fail)?
                .collect::<Result<_, _>>()
                .map_err(db_fail)?,
        };
        Ok(rows.into_iter().map(parse_row).collect())
    }

    pub fn list_all(&self) -> CoreResult<Vec<Value>> {
        let rows = self
            .db
            .prepare("SELECT data FROM sessions ORDER BY updated_at DESC")
            .map_err(db_fail)?
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(db_fail)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_fail)?;
        Ok(rows.into_iter().map(parse_row).collect())
    }

    /// Permanently removes a conversation, its nested sub-sessions, and their
    /// session-scoped records. Returns the removed session ids.
    pub fn delete_tree(&self, id: &str) -> CoreResult<Vec<String>> {
        let sessions = self.list_all()?;
        if !sessions.iter().any(|session| str_field(session, "id") == Some(id)) {
            return Ok(vec![]);
        }
        let mut ids: Vec<String> = vec![id.to_string()];
        let mut added = true;
        while added {
            added = false;
            for session in &sessions {
                let parent = str_field(session, "parentSessionId");
                let session_id = str_field(session, "id");
                if let (Some(parent), Some(session_id)) = (parent, session_id) {
                    if ids.iter().any(|known| known == parent) && !ids.iter().any(|known| known == session_id) {
                        ids.push(session_id.to_string());
                        added = true;
                    }
                }
            }
        }
        self.db.execute_batch("BEGIN IMMEDIATE").map_err(db_fail)?;
        let result = (|| -> CoreResult<()> {
            for table in ["messages", "runs", "runtime_events", "artifacts"] {
                let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(", ");
                let sql = format!("DELETE FROM {table} WHERE session_id IN ({placeholders})");
                let mut stmt = self.db.prepare(&sql).map_err(db_fail)?;
                stmt.execute(rusqlite::params_from_iter(ids.iter())).map_err(db_fail)?;
            }
            let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(", ");
            let sql = format!("DELETE FROM sessions WHERE id IN ({placeholders})");
            self.db
                .prepare(&sql)
                .map_err(db_fail)?
                .execute(rusqlite::params_from_iter(ids.iter()))
                .map_err(db_fail)?;
            Ok(())
        })();
        match result {
            Ok(()) => {
                self.db.execute_batch("COMMIT").map_err(db_fail)?;
                Ok(ids)
            }
            Err(error) => {
                let _ = self.db.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    }

    pub fn save_message(&self, message: &Value) -> CoreResult<()> {
        self.db
            .prepare("INSERT OR REPLACE INTO messages(id, session_id, data, created_at) VALUES(?1, ?2, ?3, ?4)")
            .map_err(db_fail)?
            .execute(params![
                id_of(message)?,
                str_field(message, "sessionId").unwrap_or(""),
                message.to_string(),
                str_field(message, "createdAt").unwrap_or("")
            ])
            .map_err(db_fail)?;
        Ok(())
    }

    pub fn messages(&self, session_id: &str) -> CoreResult<Vec<Value>> {
        let rows = self
            .db
            .prepare("SELECT data FROM messages WHERE session_id = ?1 ORDER BY created_at")
            .map_err(db_fail)?
            .query_map(params![session_id], |row| row.get::<_, String>(0))
            .map_err(db_fail)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_fail)?;
        Ok(rows.into_iter().map(parse_row).collect())
    }

    pub fn delete_message(&self, session_id: &str, message_id: &str) -> CoreResult<()> {
        self.db
            .prepare("DELETE FROM messages WHERE session_id = ?1 AND id = ?2")
            .map_err(db_fail)?
            .execute(params![session_id, message_id])
            .map_err(db_fail)?;
        Ok(())
    }
}

pub struct RunRepository<'a> {
    db: &'a Connection,
}

impl<'a> RunRepository<'a> {
    pub fn save(&self, run: &Value) -> CoreResult<()> {
        let updated_at = str_field(run, "endedAt")
            .or_else(|| str_field(run, "startedAt"))
            .map(str::to_string)
            .unwrap_or_else(now_iso);
        self.db
            .prepare(
                "INSERT INTO runs(id, session_id, data, updated_at) VALUES(?1, ?2, ?3, ?4) \
                 ON CONFLICT(id) DO UPDATE SET session_id=excluded.session_id, data=excluded.data, updated_at=excluded.updated_at",
            )
            .map_err(db_fail)?
            .execute(params![id_of(run)?, str_field(run, "sessionId").unwrap_or(""), run.to_string(), updated_at])
            .map_err(db_fail)?;
        Ok(())
    }

    pub fn get(&self, id: &str) -> CoreResult<Option<Value>> {
        let row = self
            .db
            .prepare("SELECT data FROM runs WHERE id = ?1")
            .map_err(db_fail)?
            .query_row(params![id], |row| row.get::<_, String>(0))
            .ok();
        Ok(row.map(parse_row))
    }

    pub fn list(&self) -> CoreResult<Vec<Value>> {
        let rows = self
            .db
            .prepare("SELECT data FROM runs ORDER BY updated_at DESC")
            .map_err(db_fail)?
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(db_fail)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_fail)?;
        Ok(rows.into_iter().map(parse_row).collect())
    }
}

/// A `thinking_delta` is a cumulative streaming snapshot; once a final
/// `thinking_summary` for the same messageId exists, the intermediate deltas
/// add nothing but replay bytes (the renderer rebuilds the reasoning row from
/// the summary). Dropping them keeps long-session replays smaller and faster.
/// Deltas WITHOUT a matching summary are kept: a reasoning interrupted before
/// its summary still needs its last delta text.
fn drop_redundant_thinking_deltas(events: Vec<Value>) -> Vec<Value> {
    // Small sessions replay quickly anyway; skip the extra scan.
    if events.len() < 64 {
        return events;
    }
    let summarized: std::collections::HashSet<String> = events
        .iter()
        .filter(|event| event.get("type").and_then(Value::as_str) == Some("agent.thinking_summary"))
        .filter_map(|event| {
            event
                .get("payload")
                .and_then(|payload| payload.get("messageId"))
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .collect();
    if summarized.is_empty() {
        return events;
    }
    events
        .into_iter()
        .filter(|event| {
            if event.get("type").and_then(Value::as_str) != Some("agent.thinking_delta") {
                return true;
            }
            let message_id = event
                .get("payload")
                .and_then(|payload| payload.get("messageId"))
                .and_then(Value::as_str);
            !message_id.map(|id| summarized.contains(id)).unwrap_or(false)
        })
        .collect()
}

pub struct TaskRepository<'a> {
    db: &'a Connection,
}

impl<'a> TaskRepository<'a> {
    pub fn save(&self, task: &Value) -> CoreResult<()> {
        self.db
            .prepare(
                "INSERT INTO tasks(id, project_run_id, data, updated_at) VALUES(?1, ?2, ?3, ?4) \
                 ON CONFLICT(id) DO UPDATE SET project_run_id=excluded.project_run_id, data=excluded.data, updated_at=excluded.updated_at",
            )
            .map_err(db_fail)?
            .execute(params![
                id_of(task)?,
                str_field(task, "projectRunId").unwrap_or(""),
                task.to_string(),
                str_field(task, "updatedAt").unwrap_or("")
            ])
            .map_err(db_fail)?;
        Ok(())
    }

    pub fn get(&self, id: &str) -> CoreResult<Option<Value>> {
        let row = self
            .db
            .prepare("SELECT data FROM tasks WHERE id = ?1")
            .map_err(db_fail)?
            .query_row(params![id], |row| row.get::<_, String>(0))
            .ok();
        Ok(row.map(parse_row))
    }

    pub fn list(&self, project_run_id: &str) -> CoreResult<Vec<Value>> {
        let rows = self
            .db
            .prepare("SELECT data FROM tasks WHERE project_run_id = ?1 ORDER BY updated_at")
            .map_err(db_fail)?
            .query_map(params![project_run_id], |row| row.get::<_, String>(0))
            .map_err(db_fail)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_fail)?;
        Ok(rows.into_iter().map(parse_row).collect())
    }

    pub fn list_all(&self) -> CoreResult<Vec<Value>> {
        let rows = self
            .db
            .prepare("SELECT data FROM tasks ORDER BY updated_at")
            .map_err(db_fail)?
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(db_fail)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_fail)?;
        Ok(rows.into_iter().map(parse_row).collect())
    }
}

pub struct ProjectRunRepository<'a> {
    db: &'a Connection,
}

impl<'a> ProjectRunRepository<'a> {
    pub fn save(&self, project_run: &Value) -> CoreResult<()> {
        self.db
            .prepare(
                "INSERT INTO project_runs(id, project_id, data, updated_at) VALUES(?1, ?2, ?3, ?4) \
                 ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id, data=excluded.data, updated_at=excluded.updated_at",
            )
            .map_err(db_fail)?
            .execute(params![
                id_of(project_run)?,
                str_field(project_run, "projectId").unwrap_or(""),
                project_run.to_string(),
                str_field(project_run, "updatedAt").unwrap_or("")
            ])
            .map_err(db_fail)?;
        Ok(())
    }

    pub fn get(&self, id: &str) -> CoreResult<Option<Value>> {
        let row = self
            .db
            .prepare("SELECT data FROM project_runs WHERE id = ?1")
            .map_err(db_fail)?
            .query_row(params![id], |row| row.get::<_, String>(0))
            .ok();
        Ok(row.map(parse_row))
    }

    pub fn list(&self, project_id: &str) -> CoreResult<Vec<Value>> {
        let rows = self
            .db
            .prepare("SELECT data FROM project_runs WHERE project_id = ?1 ORDER BY updated_at DESC")
            .map_err(db_fail)?
            .query_map(params![project_id], |row| row.get::<_, String>(0))
            .map_err(db_fail)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_fail)?;
        Ok(rows.into_iter().map(parse_row).collect())
    }

    pub fn list_all(&self) -> CoreResult<Vec<Value>> {
        let rows = self
            .db
            .prepare("SELECT data FROM project_runs ORDER BY updated_at DESC")
            .map_err(db_fail)?
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(db_fail)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_fail)?;
        Ok(rows.into_iter().map(parse_row).collect())
    }
}

pub struct EventRepository<'a> {
    db: &'a Connection,
}

impl<'a> EventRepository<'a> {
    pub fn next_sequence(&self, session_id: Option<&str>, run_id: Option<&str>) -> CoreResult<i64> {
        if session_id.is_none() && run_id.is_none() {
            return Ok(1);
        }
        let value: Option<i64> = match session_id {
            Some(session) => self
                .db
                .prepare("SELECT MAX(sequence) AS value FROM runtime_events WHERE session_id = ?1")
                .map_err(db_fail)?
                .query_row(params![session], |row| row.get(0))
                .ok(),
            None => self
                .db
                .prepare("SELECT MAX(sequence) AS value FROM runtime_events WHERE run_id = ?1")
                .map_err(db_fail)?
                .query_row(params![run_id.unwrap_or("")], |row| row.get(0))
                .ok(),
        }
        .flatten();
        Ok(value.unwrap_or(0) + 1)
    }

    pub fn append(&self, event: &Value) -> CoreResult<()> {
        self.db
            .prepare(
                "INSERT OR REPLACE INTO runtime_events(event_id, sequence, session_id, project_run_id, run_id, data, timestamp) \
                 VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            )
            .map_err(db_fail)?
            .execute(params![
                str_field(event, "eventId").unwrap_or(""),
                event.get("sequence").and_then(Value::as_i64).unwrap_or(0),
                str_field(event, "sessionId"),
                str_field(event, "projectRunId"),
                str_field(event, "runId"),
                event.to_string(),
                str_field(event, "timestamp").unwrap_or("")
            ])
            .map_err(db_fail)?;
        Ok(())
    }

    /// Allocates the sequence and inserts atomically: BEGIN IMMEDIATE takes
    /// the write lock BEFORE MAX(sequence) is read, so a second daemon process
    /// sharing the data dir cannot allocate the same sequence (which the
    /// renderer's `sequence > afterSequence` polling would silently drop).
    /// Fills the allocated sequence into the event and returns it.
    ///
    /// Streaming deltas are coalesced inside the same transaction: delta text
    /// is INCREMENTAL (the renderer concatenates chunk texts on replay), so the
    /// surviving row per (session, run, type, messageId) accumulates every
    /// chunk — never just the newest. A terminal run event purges only
    /// agent.message_delta rows, whose content also lives in the final
    /// agent.message event; thinking deltas have no such final event and must
    /// stay. Journaling every delta verbatim grew the event table to millions
    /// of rows (97% deltas).
    pub fn append_allocating_sequence(&self, event: &mut Value, session_id: Option<&str>, run_id: Option<&str>) -> CoreResult<i64> {
        self.db.execute_batch("BEGIN IMMEDIATE").map_err(db_fail)?;
        let result = (|| {
            let event_type = event.get("type").and_then(Value::as_str).unwrap_or("").to_string();
            // Allocate BEFORE the coalescing delete: the superseded delta row
            // usually holds the current MAX(sequence), so deleting first would
            // reissue an already-consumed sequence and break the renderer's
            // `sequence > afterSequence` polling.
            let sequence = self.next_sequence(session_id, run_id)?;
            if event_type.ends_with("_delta") {
                let message_id = event.pointer("/payload/messageId").and_then(Value::as_str).unwrap_or("").to_string();
                // The merge key takes the run from the EVENT (the run_id
                // argument is only the sequence scope and is often unset);
                // the renderer keys streaming rows by runId too, so merging
                // across runs would put one run's text under another run.
                let event_run_id = event.get("runId").and_then(Value::as_str).map(str::to_string);
                let prior_text: Option<String> = self
                    .db
                    .prepare(
                        "SELECT json_extract(data, '$.payload.text') FROM runtime_events \
                         WHERE session_id = ?1 AND COALESCE(run_id, '') = COALESCE(?2, '') \
                         AND json_extract(data, '$.type') = ?3 \
                         AND json_extract(data, '$.payload.messageId') = ?4 \
                         ORDER BY sequence DESC, rowid DESC LIMIT 1",
                    )
                    .map_err(db_fail)?
                    .query_row(
                        params![session_id.unwrap_or(""), event_run_id, event_type, message_id],
                        |row| row.get::<_, Option<String>>(0),
                    )
                    .ok()
                    .flatten();
                if let Some(prior_text) = prior_text.filter(|text| !text.is_empty()) {
                    if let Some(payload) = event.get_mut("payload").and_then(Value::as_object_mut) {
                        let chunk = payload.get("text").and_then(Value::as_str).unwrap_or("");
                        payload.insert("text".to_string(), json!(format!("{prior_text}{chunk}")));
                    }
                }
                self.db
                    .prepare(
                        "DELETE FROM runtime_events WHERE session_id = ?1 \
                         AND COALESCE(run_id, '') = COALESCE(?2, '') \
                         AND json_extract(data, '$.type') = ?3 \
                         AND json_extract(data, '$.payload.messageId') = ?4",
                    )
                    .map_err(db_fail)?
                    .execute(params![session_id.unwrap_or(""), event_run_id, event_type, message_id])
                    .map_err(db_fail)?;
            } else if matches!(event_type.as_str(), "run.completed" | "run.failed") {
                self.db
                    .prepare("DELETE FROM runtime_events WHERE session_id = ?1 AND json_extract(data, '$.type') = 'agent.message_delta'")
                    .map_err(db_fail)?
                    .execute(params![session_id.unwrap_or("")])
                    .map_err(db_fail)?;
            }
            if let Some(map) = event.as_object_mut() {
                map.insert("sequence".to_string(), json!(sequence));
            }
            self.append(event)?;
            Ok(sequence)
        })();
        match result {
            Ok(sequence) => {
                self.db.execute_batch("COMMIT").map_err(db_fail)?;
                Ok(sequence)
            }
            Err(error) => {
                let _ = self.db.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    }

    pub fn delete_before(&self, timestamp: &str) -> CoreResult<usize> {
        let changes = self
            .db
            .prepare("DELETE FROM runtime_events WHERE timestamp < ?1")
            .map_err(db_fail)?
            .execute(params![timestamp])
            .map_err(db_fail)?;
        Ok(changes)
    }

    pub fn replay(
        &self,
        session_id: Option<&str>,
        project_run_id: Option<&str>,
        run_id: Option<&str>,
        after_sequence: Option<i64>,
    ) -> CoreResult<Vec<Value>> {
        let after = after_sequence.unwrap_or(0);
        let rows: Vec<String> = if let Some(session) = session_id {
            self.db
                .prepare("SELECT data FROM runtime_events WHERE session_id = ?1 AND sequence > ?2 ORDER BY sequence, rowid")
                .map_err(db_fail)?
                .query_map(params![session, after], |row| row.get(0))
                .map_err(db_fail)?
                .collect::<Result<_, _>>()
                .map_err(db_fail)?
        } else if let Some(project_run) = project_run_id {
            self.db
                .prepare("SELECT data FROM runtime_events WHERE project_run_id = ?1 AND sequence > ?2 ORDER BY sequence, rowid")
                .map_err(db_fail)?
                .query_map(params![project_run, after], |row| row.get(0))
                .map_err(db_fail)?
                .collect::<Result<_, _>>()
                .map_err(db_fail)?
        } else if let Some(run) = run_id {
            self.db
                .prepare("SELECT data FROM runtime_events WHERE run_id = ?1 AND sequence > ?2 ORDER BY sequence, rowid")
                .map_err(db_fail)?
                .query_map(params![run, after], |row| row.get(0))
                .map_err(db_fail)?
                .collect::<Result<_, _>>()
                .map_err(db_fail)?
        } else {
            self.db
                .prepare("SELECT data FROM runtime_events WHERE sequence > ?1 ORDER BY timestamp, sequence")
                .map_err(db_fail)?
                .query_map(params![after], |row| row.get(0))
                .map_err(db_fail)?
                .collect::<Result<_, _>>()
                .map_err(db_fail)?
        };
        let events: Vec<Value> = rows.into_iter().map(parse_row).collect();
        Ok(drop_redundant_thinking_deltas(events))
    }
}

pub struct ArtifactRepository<'a> {
    db: &'a Connection,
}

impl<'a> ArtifactRepository<'a> {
    pub fn save(&self, artifact: &Value, created_at: Option<&str>, size_bytes: i64) -> CoreResult<()> {
        let created = created_at.map(str::to_string).unwrap_or_else(now_iso);
        self.db
            .prepare(
                "INSERT OR REPLACE INTO artifacts(id, kind, project_run_id, task_id, session_id, data, created_at, size_bytes) \
                 VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            )
            .map_err(db_fail)?
            .execute(params![
                id_of(artifact)?,
                str_field(artifact, "kind").unwrap_or(""),
                str_field(artifact, "projectRunId"),
                str_field(artifact, "taskId"),
                str_field(artifact, "sessionId"),
                artifact.to_string(),
                created,
                size_bytes
            ])
            .map_err(db_fail)?;
        Ok(())
    }

    pub fn get(&self, id: &str) -> CoreResult<Option<Value>> {
        let row = self
            .db
            .prepare("SELECT data FROM artifacts WHERE id = ?1")
            .map_err(db_fail)?
            .query_row(params![id], |row| row.get::<_, String>(0))
            .ok();
        Ok(row.map(parse_row))
    }

    pub fn list(
        &self,
        project_run_id: Option<&str>,
        task_id: Option<&str>,
        session_id: Option<&str>,
    ) -> CoreResult<Vec<Value>> {
        let mut clauses: Vec<&str> = vec![];
        let mut values: Vec<String> = vec![];
        if let Some(value) = project_run_id {
            clauses.push("project_run_id = ?");
            values.push(value.to_string());
        }
        if let Some(value) = task_id {
            clauses.push("task_id = ?");
            values.push(value.to_string());
        }
        if let Some(value) = session_id {
            clauses.push("session_id = ?");
            values.push(value.to_string());
        }
        if clauses.is_empty() {
            return Ok(vec![]);
        }
        let sql = format!("SELECT data FROM artifacts WHERE {} ORDER BY created_at", clauses.join(" AND "));
        let rows = self
            .db
            .prepare(&sql)
            .map_err(db_fail)?
            .query_map(rusqlite::params_from_iter(values.iter()), |row| row.get::<_, String>(0))
            .map_err(db_fail)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_fail)?;
        Ok(rows.into_iter().map(parse_row).collect())
    }

    pub fn delete_before(&self, timestamp: &str) -> CoreResult<usize> {
        let changes = self
            .db
            .prepare("DELETE FROM artifacts WHERE created_at < ?1")
            .map_err(db_fail)?
            .execute(params![timestamp])
            .map_err(db_fail)?;
        Ok(changes)
    }
}

pub struct VerificationRepository<'a> {
    db: &'a Connection,
}

impl<'a> VerificationRepository<'a> {
    pub fn save(&self, result: &Value) -> CoreResult<()> {
        self.db
            .prepare(
                "INSERT OR REPLACE INTO verification_results(id, project_run_id, task_id, data, created_at) \
                 VALUES(?1, ?2, ?3, ?4, ?5)",
            )
            .map_err(db_fail)?
            .execute(params![
                id_of(result)?,
                str_field(result, "projectRunId").unwrap_or(""),
                str_field(result, "taskId"),
                result.to_string(),
                str_field(result, "createdAt").unwrap_or("")
            ])
            .map_err(db_fail)?;
        Ok(())
    }

    pub fn list(&self, project_run_id: &str, task_id: Option<&str>) -> CoreResult<Vec<Value>> {
        let rows: Vec<String> = match task_id {
            Some(task) => self
                .db
                .prepare("SELECT data FROM verification_results WHERE project_run_id = ?1 AND task_id = ?2 ORDER BY created_at")
                .map_err(db_fail)?
                .query_map(params![project_run_id, task], |row| row.get(0))
                .map_err(db_fail)?
                .collect::<Result<_, _>>()
                .map_err(db_fail)?,
            None => self
                .db
                .prepare("SELECT data FROM verification_results WHERE project_run_id = ?1 ORDER BY created_at")
                .map_err(db_fail)?
                .query_map(params![project_run_id], |row| row.get(0))
                .map_err(db_fail)?
                .collect::<Result<_, _>>()
                .map_err(db_fail)?,
        };
        Ok(rows.into_iter().map(parse_row).collect())
    }

    pub fn list_all(&self) -> CoreResult<Vec<Value>> {
        let rows = self
            .db
            .prepare("SELECT data FROM verification_results ORDER BY created_at")
            .map_err(db_fail)?
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(db_fail)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_fail)?;
        Ok(rows.into_iter().map(parse_row).collect())
    }
}

pub struct ApprovalRepository<'a> {
    db: &'a Connection,
}

impl<'a> ApprovalRepository<'a> {
    pub fn save(&self, record: &Value) -> CoreResult<()> {
        self.db
            .prepare("INSERT OR REPLACE INTO approvals(id, status, project_run_id, data, created_at) VALUES(?1, ?2, ?3, ?4, ?5)")
            .map_err(db_fail)?
            .execute(params![
                id_of(record)?,
                str_field(record, "status").unwrap_or(""),
                str_field(record, "projectRunId"),
                record.to_string(),
                str_field(record, "createdAt").unwrap_or("")
            ])
            .map_err(db_fail)?;
        Ok(())
    }

    pub fn get(&self, id: &str) -> CoreResult<Option<Value>> {
        let row = self
            .db
            .prepare("SELECT data FROM approvals WHERE id = ?1")
            .map_err(db_fail)?
            .query_row(params![id], |row| row.get::<_, String>(0))
            .ok();
        Ok(row.map(parse_row))
    }

    pub fn list(&self, status: Option<&str>, project_run_id: Option<&str>) -> CoreResult<Vec<Value>> {
        let mut clauses: Vec<&str> = vec![];
        let mut values: Vec<String> = vec![];
        if let Some(value) = status {
            clauses.push("status = ?");
            values.push(value.to_string());
        }
        if let Some(value) = project_run_id {
            clauses.push("project_run_id = ?");
            values.push(value.to_string());
        }
        let where_clause = if clauses.is_empty() { String::new() } else { format!(" WHERE {}", clauses.join(" AND ")) };
        let sql = format!("SELECT data FROM approvals{where_clause} ORDER BY created_at DESC");
        let rows = self
            .db
            .prepare(&sql)
            .map_err(db_fail)?
            .query_map(rusqlite::params_from_iter(values.iter()), |row| row.get::<_, String>(0))
            .map_err(db_fail)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_fail)?;
        Ok(rows.into_iter().map(parse_row).collect())
    }
}

pub struct AuditRepository<'a> {
    db: &'a Connection,
}

impl<'a> AuditRepository<'a> {
    pub fn append_many(&self, records: &[Value]) -> CoreResult<()> {
        if records.is_empty() {
            return Ok(());
        }
        self.db.execute_batch("BEGIN IMMEDIATE").map_err(db_fail)?;
        let result = (|| -> CoreResult<()> {
            let mut stmt = self
                .db
                .prepare("INSERT INTO audit_logs(id, action, resource_id, outcome, data, timestamp) VALUES(?1, ?2, ?3, ?4, ?5, ?6)")
                .map_err(db_fail)?;
            for record in records {
                stmt.execute(params![
                    str_field(record, "id").unwrap_or(""),
                    str_field(record, "action").unwrap_or(""),
                    str_field(record, "resourceId"),
                    str_field(record, "outcome").unwrap_or(""),
                    record.to_string(),
                    str_field(record, "timestamp").unwrap_or("")
                ])
                .map_err(db_fail)?;
            }
            Ok(())
        })();
        match result {
            Ok(()) => self.db.execute_batch("COMMIT").map_err(db_fail),
            Err(error) => {
                let _ = self.db.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    }

    pub fn append(&self, record: &Value) -> CoreResult<()> {
        self.append_many(std::slice::from_ref(record))
    }

    /// Deletes audit rows older than `timestamp` (ISO-8601) for retention.
    pub fn delete_before(&self, timestamp: &str) -> CoreResult<usize> {
        let deleted = self
            .db
            .prepare("DELETE FROM audit_logs WHERE timestamp < ?1")
            .map_err(db_fail)?
            .execute(params![timestamp])
            .map_err(db_fail)?;
        Ok(deleted)
    }

    pub fn list(&self, limit: Option<i64>, resource_id: Option<&str>) -> CoreResult<Vec<Value>> {
        let limit = limit.unwrap_or(200).clamp(1, 2_000);
        let rows: Vec<String> = match resource_id {
            Some(resource) => self
                .db
                .prepare("SELECT data FROM audit_logs WHERE resource_id = ?1 ORDER BY timestamp DESC LIMIT ?2")
                .map_err(db_fail)?
                .query_map(params![resource, limit], |row| row.get(0))
                .map_err(db_fail)?
                .collect::<Result<_, _>>()
                .map_err(db_fail)?,
            None => self
                .db
                .prepare("SELECT data FROM audit_logs ORDER BY timestamp DESC LIMIT ?1")
                .map_err(db_fail)?
                .query_map(params![limit], |row| row.get(0))
                .map_err(db_fail)?
                .collect::<Result<_, _>>()
                .map_err(db_fail)?,
        };
        Ok(rows.into_iter().map(parse_row).collect())
    }
}

pub struct CredentialRepository<'a> {
    db: &'a Connection,
}

impl<'a> CredentialRepository<'a> {
    pub fn save(&self, agent_instance_id: &str, encrypted: &Value) -> CoreResult<()> {
        self.db
            .prepare("INSERT OR REPLACE INTO credentials(agent_instance_id, data, updated_at) VALUES(?1, ?2, ?3)")
            .map_err(db_fail)?
            .execute(params![agent_instance_id, encrypted.to_string(), now_iso()])
            .map_err(db_fail)?;
        Ok(())
    }

    pub fn get(&self, agent_instance_id: &str) -> CoreResult<Option<Value>> {
        let row = self
            .db
            .prepare("SELECT data FROM credentials WHERE agent_instance_id = ?1")
            .map_err(db_fail)?
            .query_row(params![agent_instance_id], |row| row.get::<_, String>(0))
            .ok();
        Ok(row.map(parse_row))
    }

    pub fn has(&self, agent_instance_id: &str) -> CoreResult<bool> {
        let exists = self
            .db
            .prepare("SELECT 1 AS value FROM credentials WHERE agent_instance_id = ?1")
            .map_err(db_fail)?
            .query_row(params![agent_instance_id], |_| Ok(()))
            .is_ok();
        Ok(exists)
    }

    pub fn remove(&self, agent_instance_id: &str) -> CoreResult<bool> {
        let changes = self
            .db
            .prepare("DELETE FROM credentials WHERE agent_instance_id = ?1")
            .map_err(db_fail)?
            .execute(params![agent_instance_id])
            .map_err(db_fail)?;
        Ok(changes > 0)
    }
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::Database;

    fn open_test_db() -> Database {
        let file = std::env::temp_dir().join(format!("nautilo-repo-test-{}.sqlite", uuid::Uuid::new_v4()));
        Database::open(&file).expect("open test database")
    }

    fn delta_event(session: &str, message_id: &str, text: &str) -> Value {
        json!({
            "eventId": uuid::Uuid::new_v4().to_string(),
            "sessionId": session,
            "type": "agent.message_delta",
            "timestamp": "2026-08-08T00:00:00.000Z",
            "payload": { "messageId": message_id, "text": text }
        })
    }

    fn delta_rows(db: &Connection, session: &str) -> Vec<(String, String)> {
        let mut statement = db
            .prepare("SELECT json_extract(data, '$.payload.messageId'), json_extract(data, '$.payload.text') FROM runtime_events WHERE session_id = ?1 AND json_extract(data, '$.type') LIKE '%\\_delta' ESCAPE '\\' ORDER BY sequence")
            .unwrap();
        statement
            .query_map(params![session], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap()
    }

    fn typed_delta_event(session: &str, run: &str, event_type: &str, message_id: &str, text: &str) -> Value {
        json!({
            "eventId": uuid::Uuid::new_v4().to_string(),
            "sessionId": session,
            "runId": run,
            "type": event_type,
            "timestamp": "2026-08-08T00:00:00.000Z",
            "payload": { "messageId": message_id, "text": text }
        })
    }

    #[test]
    fn delta_events_coalesce_by_concatenation_and_keep_thinking_on_run_end() {
        let db = open_test_db();
        let events = Repositories::new(&db.raw).events();

        // Delta text is incremental — the renderer concatenates chunk texts on
        // replay — so coalescing must ACCUMULATE chunks, not keep the newest.
        let mut first = delta_event("s1", "m1", "he");
        let mut second = delta_event("s1", "m1", "ll");
        let mut third = delta_event("s1", "m1", "o");
        let mut other_message = delta_event("s1", "m2", "world");
        let mut other_session = delta_event("s2", "m1", "untouched");
        // Thinking deltas of the same run merge; another run never does.
        let mut thought_a = typed_delta_event("s1", "r1", "agent.thinking_delta", "t1", "think-");
        let mut thought_b = typed_delta_event("s1", "r1", "agent.thinking_delta", "t1", "ing");
        let mut other_run = typed_delta_event("s1", "r2", "agent.message_delta", "m1", "other-run");
        for (event, scope) in [
            (&mut first, "s1"),
            (&mut second, "s1"),
            (&mut third, "s1"),
            (&mut other_message, "s1"),
            (&mut other_session, "s2"),
            (&mut thought_a, "s1"),
            (&mut thought_b, "s1"),
            (&mut other_run, "s1"),
        ] {
            events.append_allocating_sequence(event, Some(scope), None).unwrap();
        }

        assert_eq!(
            delta_rows(&db.raw, "s1"),
            vec![
                ("m1".to_string(), "hello".to_string()),
                ("m2".to_string(), "world".to_string()),
                ("t1".to_string(), "think-ing".to_string()),
                ("m1".to_string(), "other-run".to_string())
            ]
        );
        assert_eq!(delta_rows(&db.raw, "s2").len(), 1);

        // Sequences are strictly increasing despite coalescing.
        let s1 = first.get("sequence").and_then(Value::as_i64).unwrap();
        let s2 = second.get("sequence").and_then(Value::as_i64).unwrap();
        let s3 = third.get("sequence").and_then(Value::as_i64).unwrap();
        assert!(s1 < s2 && s2 < s3, "sequences must increase: {s1} {s2} {s3}");

        // A terminal run event purges message deltas (their text also lives in
        // the final agent.message event) but never thinking deltas — those are
        // the only record of the run's reasoning.
        let mut done = json!({
            "eventId": uuid::Uuid::new_v4().to_string(),
            "sessionId": "s1",
            "type": "run.completed",
            "timestamp": "2026-08-08T00:00:01.000Z",
            "payload": {}
        });
        events.append_allocating_sequence(&mut done, Some("s1"), None).unwrap();
        assert_eq!(delta_rows(&db.raw, "s1"), vec![("t1".to_string(), "think-ing".to_string())]);
        assert_eq!(delta_rows(&db.raw, "s2").len(), 1);
    }
}
