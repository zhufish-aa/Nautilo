//! Repository layer: faithful port of packages/core-daemon/src/database/*.ts
//! (json-repository.ts plus the per-entity repositories).
//! Entities stay opaque serde_json::Values — the DB stores JSON documents,
//! so the Rust port does not need full domain structs to persist them.

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

use crate::database::connection::db_fail;
use crate::database::history_projection::{read_projection, read_snapshot};
use crate::errors::{CoreError, CoreResult, ErrorCode};

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn parse_row(data: String) -> Value {
    serde_json::from_str(&data).unwrap_or(Value::Null)
}

fn session_row(row:&rusqlite::Row<'_>)->rusqlite::Result<Value> {
    let mut value=parse_row(row.get(0)?);
    let activity:Option<String>=row.get(1)?;
    if let Some(activity)=activity {value["lastMessageAt"]=json!(activity);}
    else if let Some(fields)=value.as_object_mut(){fields.remove("lastMessageAt");}
    Ok(value)
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
    pub fn runtime_connections(&self) -> JsonRepository<'a> { JsonRepository::new(self.db, "runtime_connections") }
    pub fn runtime_connection_versions(&self) -> JsonRepository<'a> { JsonRepository::new(self.db, "runtime_connection_versions") }
    pub fn teams(&self) -> JsonRepository<'a> {
        JsonRepository::new(self.db, "teams")
    }
    pub fn policies(&self) -> JsonRepository<'a> {
        JsonRepository::new(self.db, "permission_policies")
    }
    pub fn capabilities(&self) -> JsonRepository<'a> {
        JsonRepository::new(self.db, "capabilities")
    }
    pub fn request_logs(&self) -> RequestLogRepository<'a> { RequestLogRepository { db: self.db } }
    pub fn resource_transactions(&self) -> JsonRepository<'a> { JsonRepository::new(self.db,"resource_transactions") }
    pub fn configuration_presets(&self) -> JsonRepository<'a> { JsonRepository::new(self.db,"configuration_presets") }
    pub fn integration_settings(&self) -> JsonRepository<'a> { JsonRepository::new(self.db,"integration_settings") }
    pub fn account_gateway_sessions(&self) -> JsonRepository<'a> { JsonRepository::new(self.db,"account_gateway_sessions") }
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

pub struct RequestLogRepository<'a> { db: &'a Connection }
impl RequestLogRepository<'_> {
    pub fn save(&self, value: &Value) -> CoreResult<()> {
        JsonRepository::new(self.db, "request_logs").save(value, value["updatedAt"].as_str().unwrap_or(""))
    }
    pub fn get(&self, id: &str) -> CoreResult<Option<Value>> { JsonRepository::new(self.db, "request_logs").get(id) }
    pub fn page(&self, input: &Value) -> CoreResult<Value> {
        let limit = input["limit"].as_u64().unwrap_or(40).clamp(1, 200) as usize;
        let cursor = input["before"].as_str().unwrap_or("");
        let (time, id) = cursor.split_once('|').unwrap_or(("", ""));
        let mut stmt = self.db.prepare("SELECT data FROM request_logs WHERE (?1='' OR json_extract(data,'$.sessionId')=?1) AND (?2='' OR json_extract(data,'$.providerId')=?2) AND (?3='' OR json_extract(data,'$.status')=?3) AND (?4='' OR json_extract(data,'$.createdAt') < ?4 OR (json_extract(data,'$.createdAt')=?4 AND id < ?5)) ORDER BY json_extract(data,'$.createdAt') DESC, id DESC LIMIT ?6").map_err(db_fail)?;
        let mut items = stmt.query_map(params![input["sessionId"].as_str().unwrap_or(""), input["providerId"].as_str().unwrap_or(""), input["status"].as_str().unwrap_or(""), time, id, (limit + 1) as i64], |row| row.get::<_, String>(0)).map_err(db_fail)?.collect::<Result<Vec<_>,_>>().map_err(db_fail)?.into_iter().map(parse_row).collect::<Vec<_>>();
        let more = items.len() > limit;
        items.truncate(limit);
        let next = if more { items.last().map(|row| format!("{}|{}",row["createdAt"].as_str().unwrap_or(""),row["id"].as_str().unwrap_or(""))) } else { None };
        Ok(json!({"items":items,"nextCursor":next}))
    }
    pub fn interrupt_open(&self) -> CoreResult<()> {
        self.db.execute("UPDATE request_logs SET data=json_set(data,'$.status','interrupted','$.updatedAt',?1,'$.failure',json_object('stage','daemon','code','DAEMON_RESTARTED','message','The daemon exited before this request finished.')) , updated_at=?1 WHERE json_extract(data,'$.status') IN ('queued','preparing','running')", [now_iso()]).map_err(db_fail)?;
        Ok(())
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
            .prepare("SELECT data, (SELECT MAX(created_at) FROM messages WHERE session_id=sessions.id) FROM sessions WHERE id = ?1")
            .map_err(db_fail)?
            .query_row(params![id], session_row)
            .ok();
        Ok(row)
    }

    pub fn list(&self, project_id: &str, member_id: Option<&str>) -> CoreResult<Vec<Value>> {
        let rows: Vec<Value> = match member_id {
            Some(member) => self
                .db
                .prepare("SELECT data, (SELECT MAX(created_at) FROM messages WHERE session_id=sessions.id) FROM sessions WHERE project_id = ?1 AND member_id = ?2 ORDER BY updated_at DESC")
                .map_err(db_fail)?
                .query_map(params![project_id, member], session_row)
                .map_err(db_fail)?
                .collect::<Result<_, _>>()
                .map_err(db_fail)?,
            None => self
                .db
                .prepare("SELECT data, (SELECT MAX(created_at) FROM messages WHERE session_id=sessions.id) FROM sessions WHERE project_id = ?1 ORDER BY updated_at DESC")
                .map_err(db_fail)?
                .query_map(params![project_id], session_row)
                .map_err(db_fail)?
                .collect::<Result<_, _>>()
                .map_err(db_fail)?,
        };
        Ok(rows)
    }

    pub fn list_all(&self) -> CoreResult<Vec<Value>> {
        let rows = self
            .db
            .prepare("SELECT data, (SELECT MAX(created_at) FROM messages WHERE session_id=sessions.id) FROM sessions ORDER BY updated_at DESC")
            .map_err(db_fail)?
            .query_map([], session_row)
            .map_err(db_fail)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_fail)?;
        Ok(rows)
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

    pub fn history(&self, session_id: &str, cursor: Option<&Value>) -> CoreResult<Value> {
        read_snapshot(self.db, || {
            let session = self.get(session_id)?.ok_or_else(|| CoreError::reason(ErrorCode::IpcNotFound, "session not found"))?;
            let mut projection = read_projection(self.db, "messages", &format!("messages:session:{session_id}"), cursor)?;
            projection["session"] = session;
            Ok(projection)
        })
    }

    pub fn history_batch(&self, input: &Value) -> CoreResult<Value> {
        let items = input.get("items").and_then(Value::as_array).filter(|items| {
            !items.is_empty() && items.len() <= 64 && items.iter().all(|item| {
                item.get("sessionId").and_then(Value::as_str).is_some_and(|id| !id.is_empty())
            })
        }).ok_or_else(|| CoreError::reason(ErrorCode::IpcInvalidRequest, "session.historyBatch requires 1 to 64 session cursors"))?;
        read_snapshot(self.db, || {
            let histories = items.iter().map(|item| self.history(
                item.get("sessionId").and_then(Value::as_str).unwrap_or(""), item.get("cursor"),
            )).collect::<CoreResult<Vec<_>>>()?;
            Ok(json!({ "items": histories }))
        })
    }

    pub fn save_message(&self, message: &Value) -> CoreResult<()> {
        self.db
            .prepare("INSERT INTO messages(id, session_id, data, created_at) VALUES(?1, ?2, ?3, ?4) ON CONFLICT(id) DO UPDATE SET session_id=excluded.session_id, data=excluded.data, created_at=excluded.created_at")
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

    pub fn message(&self, session_id: &str, id: &str) -> CoreResult<Option<Value>> {
        self.db.query_row("SELECT data FROM messages WHERE session_id=?1 AND id=?2",params![session_id,id],|row|row.get::<_,String>(0)).optional().map_err(db_fail).map(|row|row.map(parse_row))
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
    pub fn latest_for_session(&self, session_id: &str) -> CoreResult<Option<Value>> {
        self.db.query_row("SELECT data FROM runs WHERE session_id=?1 ORDER BY rowid DESC LIMIT 1",[session_id],|row|row.get::<_,String>(0)).optional().map_err(db_fail).map(|row|row.map(parse_row))
    }
    pub fn list_for_session(&self, session_id: &str) -> CoreResult<Vec<Value>> {
        self.db.prepare("SELECT data FROM runs WHERE session_id=?1 ORDER BY updated_at").map_err(db_fail)?.query_map(params![session_id],|row|row.get::<_,String>(0)).map_err(db_fail)?.collect::<Result<Vec<_>,_>>().map_err(db_fail).map(|rows|rows.into_iter().map(parse_row).collect())
    }

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
    pub fn latest_type(&self,session_id:&str,event_type:&str)->CoreResult<Option<Value>> {
        use rusqlite::OptionalExtension;
        self.db.query_row("SELECT data FROM runtime_events WHERE session_id=?1 AND json_extract(data,'$.type')=?2 ORDER BY sequence DESC LIMIT 1",params![session_id,event_type],|row|row.get::<_,String>(0))
            .optional().map(|row|row.map(parse_row)).map_err(db_fail)
    }
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

    /// Append a structural event inside the caller's IMMEDIATE transaction.
    /// Unlike append(), this never replaces an earlier journal entry.
    pub(crate) fn append_in_transaction(&self, event: &mut Value) -> CoreResult<i64> {
        if self.db.is_autocommit() || !event.is_object()
            || event["type"].as_str().is_none_or(|kind| kind.ends_with("_delta"))
        {
            return Err(crate::errors::invalid("event", "A structural event requires an active write transaction"));
        }
        let sequence = self.next_sequence(str_field(event, "sessionId"), str_field(event, "runId"))?;
        event["sequence"] = json!(sequence);
        self.db.execute(
            "INSERT INTO runtime_events(event_id, sequence, session_id, project_run_id, run_id, data, timestamp) VALUES(?1,?2,?3,?4,?5,?6,?7)",
            params![str_field(event,"eventId").unwrap_or(""), sequence, str_field(event,"sessionId"), str_field(event,"projectRunId"), str_field(event,"runId"), event.to_string(), str_field(event,"timestamp").unwrap_or("")],
        ).map_err(db_fail)?;
        super::timeline::record_event(self.db, event)?;
        Ok(sequence)
    }

    /// Persist the source event and its display changes under the same write lock.
    pub fn append_allocating_sequence(&self, event: &mut Value, session_id: Option<&str>, run_id: Option<&str>) -> CoreResult<i64> {
        self.db.execute_batch("BEGIN IMMEDIATE").map_err(db_fail)?;
        let result = (|| {
            let sequence = self.next_sequence(session_id, run_id)?;
            event["sequence"] = json!(sequence);
            self.append(event)?;
            super::timeline::record_event(self.db, event)?;
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
        Ok(events)
    }
}

pub struct ArtifactRepository<'a> {
    db: &'a Connection,
}

impl<'a> ArtifactRepository<'a> {
    pub fn changes(&self, input: &Value) -> CoreResult<Value> {
        let session_id = str_field(input, "sessionId").filter(|id| !id.is_empty());
        let project_run_id = str_field(input, "projectRunId").filter(|id| !id.is_empty());
        let scope = match (session_id, project_run_id) {
            (Some(id), None) => format!("artifacts:session:{id}"),
            (None, Some(id)) => format!("artifacts:projectRun:{id}"),
            _ => return Err(CoreError::reason(ErrorCode::IpcInvalidRequest, "artifact.changes requires exactly one sessionId or projectRunId")),
        };
        read_snapshot(self.db, || read_projection(self.db, "artifacts", &scope, input.get("cursor")))
    }

    pub fn save(&self, artifact: &Value, created_at: Option<&str>, size_bytes: i64) -> CoreResult<()> {
        let created = created_at.map(str::to_string).unwrap_or_else(now_iso);
        self.db
            .prepare(
                "INSERT INTO artifacts(id, kind, project_run_id, task_id, session_id, data, created_at, size_bytes) \
                 VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, project_run_id=excluded.project_run_id, task_id=excluded.task_id, session_id=excluded.session_id, data=excluded.data, created_at=excluded.created_at, size_bytes=excluded.size_bytes",
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
    pub fn unsettled_workflow(&self, workflow: &str, instance: Option<&str>) -> CoreResult<Vec<Value>> {
        let mut statement = self.db.prepare(
            "SELECT data FROM verification_results WHERE json_extract(data,'$.workflow.runId')=?1
             AND (?2 IS NULL OR json_extract(data,'$.workflow.instanceId')=?2)
             AND json_extract(data,'$.status') IN ('starting','running')"
        ).map_err(db_fail)?;
        let rows = statement.query_map(params![workflow, instance], |row| row.get::<_, String>(0)).map_err(db_fail)?;
        rows.map(|row| row.map(parse_row).map_err(db_fail)).collect()
    }

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

}
