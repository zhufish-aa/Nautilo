//! The conversation display journal. Only the queue tail can accept text.
use std::collections::HashSet;

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::database::{connection::db_fail, history_projection::read_snapshot};
use crate::errors::{invalid, not_found, CoreError, CoreResult, ErrorCode};

const BLOCK_FIELDS: &str = "seq,block_id,run_id,kind,content,sealed,status,result";

fn parse(text: &str) -> CoreResult<Value> {
    serde_json::from_str(text)
        .map_err(|err| CoreError::reason(ErrorCode::IpcInternalError, err.to_string()))
}

fn block(row: &Row<'_>) -> rusqlite::Result<Value> {
    let decode = |index| -> rusqlite::Result<Option<Value>> {
        row.get::<_, Option<String>>(index)?
            .map(|text| {
                serde_json::from_str(&text).map_err(|err| {
                    rusqlite::Error::FromSqlConversionFailure(
                        index,
                        rusqlite::types::Type::Text,
                        Box::new(err),
                    )
                })
            })
            .transpose()
    };
    Ok(json!({
        "seq": row.get::<_,i64>(0)?, "blockId": row.get::<_,String>(1)?,
        "runId": row.get::<_,Option<String>>(2)?, "kind": row.get::<_,String>(3)?,
        "content": decode(4)?, "sealed": row.get::<_,bool>(5)?,
        "status": row.get::<_,Option<String>>(6)?, "result": decode(7)?
    }))
}

struct Writer<'a> {
    db: &'a Connection,
    session: &'a str,
    changes: Vec<Value>,
    turn: Option<Value>,
}

impl Writer<'_> {
    fn tail(&self) -> CoreResult<Option<Value>> {
        self.db.query_row(
            &format!("SELECT {BLOCK_FIELDS} FROM timeline_blocks WHERE session_id=? ORDER BY seq DESC LIMIT 1"),
            [self.session], block,
        ).optional().map_err(db_fail)
    }

    fn create(
        &mut self,
        kind: &str,
        run: Option<&str>,
        content: Value,
        sealed: bool,
        call: Option<&str>,
        status: Option<&str>,
    ) -> CoreResult<()> {
        let id = Uuid::new_v4().to_string();
        let seq = self
            .db
            .query_row(
                "SELECT COALESCE(MAX(seq),0)+1 FROM timeline_blocks WHERE session_id=?",
                [self.session],
                |row| row.get::<_, i64>(0),
            )
            .map_err(db_fail)?;
        self.db.execute(
            "INSERT INTO timeline_blocks(session_id,seq,block_id,run_id,kind,content,sealed,call_id,status) VALUES(?,?,?,?,?,?,?,?,?)",
            params![self.session,seq,id,run,kind,content.to_string(),sealed,call,status],
        ).map_err(db_fail)?;
        self.changes.push(json!({"type":"block_created","block":{
            "seq":seq,"blockId":id,"runId":run,"kind":kind,"content":content,"sealed":sealed,"status":status,"result":null
        }}));
        Ok(())
    }

    fn seal(&mut self) -> CoreResult<()> {
        let Some(id) = self
            .db
            .query_row(
                "SELECT block_id FROM timeline_blocks WHERE session_id=? AND sealed=0",
                [self.session],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(db_fail)?
        else {
            return Ok(());
        };
        self.db
            .execute(
                "UPDATE timeline_blocks SET sealed=1 WHERE block_id=?",
                [&id],
            )
            .map_err(db_fail)?;
        self.changes
            .push(json!({"type":"block_updated","blockId":id,"sealed":true}));
        Ok(())
    }

    fn append_text(&mut self, id: &str, text: &str) -> CoreResult<()> {
        let written = self.db.execute(
            "UPDATE timeline_blocks SET content=json_set(content,'$.text',json_extract(content,'$.text')||?1)
             WHERE session_id=?2 AND block_id=?3 AND sealed=0
             AND seq=(SELECT MAX(seq) FROM timeline_blocks WHERE session_id=?2)",
            params![text,self.session,id],
        ).map_err(db_fail)?;
        if written != 1 {
            return Err(invalid(
                "blockId",
                "Only the open timeline tail can receive text",
            ));
        }
        self.changes
            .push(json!({"type":"block_delta","blockId":id,"text":text}));
        Ok(())
    }

    fn update_result(
        &mut self,
        run: Option<&str>,
        kind: &str,
        call: &str,
        result: &Value,
        status: &str,
    ) -> CoreResult<bool> {
        let Some((id, content, previous, old_status)) = self
            .db
            .query_row(
                "SELECT block_id,content,result,status FROM timeline_blocks
             WHERE session_id=?1 AND kind=?2 AND call_id=?3 AND (?2!='tool_call' OR run_id IS ?4)
             ORDER BY seq DESC LIMIT 1",
                params![self.session, kind, call, run],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                },
            )
            .optional()
            .map_err(db_fail)?
        else {
            return Ok(false);
        };
        if kind == "tool_call" && status == "running" && old_status != "running" {
            return Ok(true);
        }
        let result = if kind == "tool_call" {
            merge_tool_result(
                parse(previous.as_deref().unwrap_or(&content))?,
                result.clone(),
            )
        } else {
            result.clone()
        };
        self.db
            .execute(
                "UPDATE timeline_blocks SET status=?,result=? WHERE block_id=?",
                params![status, result.to_string(), id],
            )
            .map_err(db_fail)?;
        self.changes
            .push(json!({"type":"block_updated","blockId":id,"status":status,"result":result}));
        Ok(true)
    }

    fn set_turn(&mut self, run: &str, status: &str, time: &str) -> CoreResult<()> {
        let (started, ended): (Option<String>, Option<String>) = self.db.query_row(
            "SELECT json_extract(data,'$.startedAt'),json_extract(data,'$.endedAt') FROM runs WHERE id=? AND session_id=?",
            params![run,self.session], |row| Ok((row.get(0)?,row.get(1)?)),
        ).optional().map_err(db_fail)?.unwrap_or_default();
        let started = started.or(self
            .db
            .query_row(
                "SELECT started_at FROM timeline_turns WHERE session_id=? AND run_id=?",
                params![self.session, run],
                |row| row.get(0),
            )
            .optional()
            .map_err(db_fail)?
            .flatten());
        let ended = ended.as_deref().unwrap_or(time);
        let duration = (status != "running")
            .then(|| {
                let start = chrono::DateTime::parse_from_rfc3339(started.as_deref()?).ok()?;
                let end = chrono::DateTime::parse_from_rfc3339(ended).ok()?;
                Some((end - start).num_milliseconds().max(0))
            })
            .flatten();
        let final_block: Option<String> = if status == "running" {
            None
        } else {
            self.db.query_row(
                "SELECT CASE WHEN kind='assistant_text' THEN block_id END FROM timeline_blocks
                 WHERE session_id=? AND run_id=? AND kind IN ('assistant_text','thinking','tool_call','user_append')
                 ORDER BY seq DESC LIMIT 1",
                params![self.session,run], |row| row.get::<_,Option<String>>(0),
            ).optional().map_err(db_fail)?.flatten()
        };
        let started = started.as_deref().or((status == "running").then_some(time));
        self.db.execute(
            "INSERT INTO timeline_turns(session_id,run_id,status,started_at,duration_ms,final_block_id) VALUES(?,?,?,?,?,?)
             ON CONFLICT(session_id,run_id) DO UPDATE SET status=excluded.status,duration_ms=excluded.duration_ms,final_block_id=excluded.final_block_id",
            params![self.session,run,status,started,duration,final_block],
        ).map_err(db_fail)?;
        self.turn = Some(
            json!({"runId":run,"status":status,"durationMs":duration,"finalBlockId":final_block}),
        );
        Ok(())
    }

    fn user(&mut self, run: Option<&str>, message_id: Option<&str>, kind: &str) -> CoreResult<()> {
        let Some(id) = message_id else { return Ok(()) };
        let Some(raw) = self
            .db
            .query_row(
                "SELECT data FROM messages WHERE session_id=? AND id=?",
                params![self.session, id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(db_fail)?
        else {
            return Ok(());
        };
        let mut message = parse(&raw)?;
        if let Some(ids) = message["attachmentIds"]
            .as_array()
            .filter(|ids| !ids.is_empty())
        {
            let mut query = self
                .db
                .prepare(
                    "SELECT a.data FROM json_each(?1) ids JOIN artifacts a ON a.id=ids.value
                WHERE a.session_id=?2 ORDER BY CAST(ids.key AS INTEGER)",
                )
                .map_err(db_fail)?;
            let mut attachments = vec![];
            for raw in query
                .query_map(params![json!(ids).to_string(), self.session], |row| {
                    row.get::<_, String>(0)
                })
                .map_err(db_fail)?
            {
                let attachment = parse(&raw.map_err(db_fail)?)?;
                attachments.push(json!({"id":attachment["id"],"name":attachment["name"],"kind":attachment["kind"],"path":attachment["path"],
                    "mimeType":attachment["metadata"]["mimeType"],"sizeBytes":attachment["metadata"]["sizeBytes"],
                    "uploadId":attachment["metadata"]["remoteUploadId"]}));
            }
            message["attachments"] = json!(attachments);
        }
        self.create(kind, run, message, true, None, None)
    }

    fn record(&mut self) -> CoreResult<()> {
        if self.changes.is_empty() && self.turn.is_none() {
            return Ok(());
        }
        self.db
            .execute(
                "INSERT INTO timeline_changes(session_id,revision,data)
            SELECT ?1,COALESCE(MAX(revision),0)+1,?2 FROM timeline_changes WHERE session_id=?1",
                params![
                    self.session,
                    json!({"operations":std::mem::take(&mut self.changes),"turn":self.turn.take()})
                        .to_string()
                ],
            )
            .map_err(db_fail)?;
        // Keep a bounded reconnect journal. A caller outside it reads the block snapshot.
        if self
            .db
            .query_row(
                "SELECT MAX(revision) % 128 FROM timeline_changes WHERE session_id=?",
                [self.session],
                |row| row.get::<_, i64>(0),
            )
            .map_err(db_fail)?
            == 0
        {
            self.db.execute(
                "DELETE FROM timeline_changes WHERE session_id=?1 AND revision < (SELECT revision FROM timeline_changes WHERE session_id=?1 ORDER BY revision DESC LIMIT 1 OFFSET 4095)",
                [self.session],
            ).map_err(db_fail)?;
        }
        Ok(())
    }
}

pub(crate) fn update_workflow_plan(db: &Connection, session: &str, plan: &Value) -> CoreResult<()> {
    let result = json!({"type":"workflow.plan","payload":{"plan":plan}});
    let status = plan["status"].as_str();
    let block_id = db.query_row(
        "UPDATE timeline_blocks SET status=?3,result=?4 WHERE block_id=(
            SELECT block_id FROM timeline_blocks WHERE session_id=?1
            AND json_extract(content,'$.type')='workflow.plan'
            AND json_extract(content,'$.payload.plan.id')=?2 ORDER BY seq LIMIT 1
        ) RETURNING block_id",
        params![session, plan["id"].as_str(), status, result.to_string()],
        |row| row.get::<_, String>(0),
    ).map_err(db_fail)?;
    Writer {
        db,
        session,
        changes: vec![json!({"type":"block_updated","blockId":block_id,"status":status,"result":result})],
        turn: None,
    }.record()
}

pub(crate) fn record_event(db: &Connection, event: &Value) -> CoreResult<()> {
    let Some(session) = event["sessionId"].as_str().filter(|id| !id.is_empty()) else {
        return Ok(());
    };
    let Some(event_type) = event["type"].as_str() else {
        return Ok(());
    };
    let payload = &event["payload"];
    if event_type == "workflow.plan" && matches!(payload["plan"]["status"].as_str(), Some("approved" | "rejected")) {
        return update_workflow_plan(db, session, &payload["plan"]);
    }
    let run = event["runId"].as_str();
    let active = db
        .query_row(
            "SELECT run_id FROM timeline_turns WHERE session_id=? AND status='running'",
            [session],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(db_fail)?;
    let same_turn = run.is_some() && run == active.as_deref();
    let recorded_turn = match run {
        Some(run) => db
            .query_row(
                "SELECT status FROM timeline_turns WHERE session_id=? AND run_id=?",
                params![session, run],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(db_fail)?,
        None => None,
    };
    let late = run.is_some() && !same_turn && (active.is_some() || recorded_turn.is_some())
        || event["background"] == true;
    let mut writer = Writer {
        db,
        session,
        changes: vec![],
        turn: None,
    };
    match event_type {
        "agent.message_delta" | "agent.thinking_delta" => {
            let kind = text_kind(event_type == "agent.thinking_delta", payload);
            let text = payload["text"].as_str().unwrap_or("");
            if !text.is_empty() {
                if let Some(tail) = writer.tail()?.filter(|tail| {
                    same_turn
                        && !late
                        && tail["sealed"] == false
                        && tail["kind"] == kind
                        && tail["runId"].as_str() == run
                }) {
                    writer.append_text(tail["blockId"].as_str().unwrap(), text)?;
                } else {
                    writer.seal()?;
                    writer.create(
                        if late { "late_result" } else { kind },
                        run,
                        json!({"text":text,"sourceKind":kind}),
                        late || !same_turn,
                        None,
                        None,
                    )?;
                }
            }
        }
        "agent.message" | "agent.thinking_summary" => {
            let kind = text_kind(event_type == "agent.thinking_summary", payload);
            let text = payload["text"].as_str().unwrap_or("");
            let emitted = match payload["timelineHadDelta"].as_bool() {
                Some(emitted) => emitted,
                None if !text.is_empty() => snapshot_matches_stream(db, event, text)?,
                None => false,
            };
            writer.seal()?;
            if !emitted && !text.is_empty() {
                writer.create(
                    if late { "late_result" } else { kind },
                    run,
                    json!({"text":text,"sourceKind":kind}),
                    true,
                    None,
                    None,
                )?;
            }
        }
        _ => {
            writer.seal()?;
            match event_type {
                "run.started" if event["background"] != true && recorded_turn.is_none() => {
                    if let (Some(old), Some(run)) = (active.as_deref(), run) {
                        if old != run {
                            writer.set_turn(
                                old,
                                "cancelled",
                                event["timestamp"].as_str().unwrap_or(""),
                            )?;
                            writer.record()?;
                        }
                    }
                    if let Some(run) = run {
                        writer.set_turn(
                            run,
                            "running",
                            event["timestamp"].as_str().unwrap_or(""),
                        )?;
                        writer.user(Some(run), payload["userMessageId"].as_str(), "user_prompt")?;
                    }
                }
                "run.completed" | "run.cancelled" | "run.failed"
                    if recorded_turn.as_deref() == Some("running") =>
                {
                    let status = event_type.strip_prefix("run.").unwrap();
                    if status == "failed" {
                        writer.create("notice", run, display_event(event), true, None, None)?;
                    }
                    writer.set_turn(
                        run.unwrap(),
                        status,
                        event["timestamp"].as_str().unwrap_or(""),
                    )?;
                }
                "session.follow_up_steered" => writer.user(
                    run.or(active.as_deref()),
                    payload["messageId"].as_str(),
                    "user_append",
                )?,
                "tool.started" | "tool.updated" | "tool.finished" | "command.started"
                | "command.updated" | "command.finished" => {
                    let status = if !event_type.ends_with(".finished") {
                        "running"
                    } else if payload["success"] == false
                        || payload["exitCode"].as_i64().is_some_and(|code| code != 0)
                    {
                        "failed"
                    } else {
                        "done"
                    };
                    let result = display_event(event);
                    let updated = if same_turn && !late {
                        match payload["callId"].as_str() {
                            Some(call) => {
                                writer.update_result(run, "tool_call", call, &result, status)?
                            }
                            None => false,
                        }
                    } else {
                        false
                    };
                    if !updated {
                        writer.create(
                            if late { "late_result" } else { "tool_call" },
                            run,
                            result,
                            true,
                            payload["callId"].as_str(),
                            Some(status),
                        )?;
                    }
                }
                "interaction.requested" | "approval.requested" => {
                    let id = payload
                        .pointer("/interaction/id")
                        .and_then(Value::as_str)
                        .or_else(|| payload["approvalId"].as_str());
                    let kind = if event_type == "interaction.requested" {
                        "interaction"
                    } else {
                        "approval"
                    };
                    writer.create(kind, run, display_event(event), true, id, Some("pending"))?;
                }
                "interaction.resolved" | "approval.resolved" => {
                    let id = payload
                        .pointer("/interaction/id")
                        .and_then(Value::as_str)
                        .or_else(|| payload["approvalId"].as_str());
                    let kind = if event_type == "interaction.resolved" {
                        "interaction"
                    } else {
                        "approval"
                    };
                    if let Some(id) = id {
                        let status = payload
                            .pointer("/interaction/status")
                            .and_then(Value::as_str)
                            .or_else(|| payload["decision"].as_str())
                            .unwrap_or("resolved");
                        writer.update_result(run, kind, id, &display_event(event), status)?;
                    }
                }
                "run.failed"
                | "file.changed"
                | "artifact.created"
                | "planner.decision"
                | "recovery.decision"
                | "task.updated"
                | "handoff.created"
                | "workflow.plan"
                | "verification.started"
                | "verification.finished"
                | "git.merge_started"
                | "git.merge_finished"
                | "git.conflict"
                | "session.checkpoint_reverted"
                | "provider.background_error" => {
                    if !(event_type == "artifact.created" && payload["kind"] == "diff") {
                        writer.create(
                            if late { "late_result" } else { "notice" },
                            run,
                            display_event(event),
                            true,
                            None,
                            None,
                        )?;
                    }
                }
                "provider.extension_ui" if shows_provider_notice(payload) => {
                    writer.create(
                        if late { "late_result" } else { "notice" },
                        run,
                        display_event(event),
                        true,
                        None,
                        None,
                    )?;
                }
                _ => {}
            }
        }
    }
    writer.record()
}

// Match a source receipt against its streamed text, never against a display block.
// A reused source ID with different text is a separate snapshot.
fn snapshot_matches_stream(db: &Connection, event: &Value, text: &str) -> CoreResult<bool> {
    let thinking = event["type"] == "agent.thinking_summary";
    let receipt_type = if thinking {
        "agent.thinking_summary"
    } else {
        "agent.message"
    };
    let delta_type = if thinking {
        "agent.thinking_delta"
    } else {
        "agent.message_delta"
    };
    let id = event["payload"]["providerMessageId"]
        .as_str()
        .or_else(|| event["payload"]["messageId"].as_str());
    let Some(sequence) = event["sequence"].as_i64() else {
        return Ok(false);
    };
    let mut query = db.prepare(
        "SELECT json_extract(data,'$.type'),json_extract(data,'$.payload.text')
         FROM runtime_events WHERE session_id=?1 AND run_id IS ?2 AND sequence<?3
         AND COALESCE(json_extract(data,'$.payload.providerMessageId'),json_extract(data,'$.payload.messageId')) IS ?4
         AND json_extract(data,'$.type') IN (?5,?6)
         AND json_extract(data,'$.payload.subagentDispatchId') IS ?7
         AND COALESCE(json_extract(data,'$.background'),0)=?8 ORDER BY sequence DESC"
    ).map_err(db_fail)?;
    let rows = query
        .query_map(
            params![
                event["sessionId"].as_str(),
                event["runId"].as_str(),
                sequence,
                id,
                receipt_type,
                delta_type,
                event["payload"]["subagentDispatchId"].as_str(),
                event["background"] == true
            ],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
        )
        .map_err(db_fail)?;
    let mut remaining = text;
    for row in rows {
        let (kind, chunk) = row.map_err(db_fail)?;
        if kind == receipt_type {
            break;
        }
        if let Some(chunk) = chunk {
            let Some(prefix) = remaining.strip_suffix(&chunk) else {
                return Ok(false);
            };
            remaining = prefix;
        }
    }
    Ok(remaining.is_empty())
}

fn shows_provider_notice(payload: &Value) -> bool {
    match payload["method"].as_str() {
        Some("notify") => payload["text"]
            .as_str()
            .is_some_and(|text| !text.trim().is_empty()),
        Some("open_url") => payload["raw"]["url"]
            .as_str()
            .is_some_and(|url| url.starts_with("https://") || url.starts_with("http://")),
        _ => false,
    }
}

fn text_kind(thinking: bool, payload: &Value) -> &'static str {
    if thinking {
        "thinking"
    } else if !payload["subagentDispatchId"].is_null()
        || payload["kind"].as_str().is_some_and(|kind| kind != "chat")
    {
        "assistant_note"
    } else {
        "assistant_text"
    }
}

fn merge_tool_result(mut previous: Value, mut next: Value) -> Value {
    if next["payload"]["codeExecution"]["partial"] == true {
        let mut calls = previous["payload"]["codeExecution"]["calls"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        if let Some(updates) = next["payload"]["codeExecution"]["calls"].as_array() {
            for update in updates {
                if let Some(call) = calls
                    .iter_mut()
                    .find(|call| call["callId"] == update["callId"])
                {
                    let status = call["status"].clone();
                    merge_payload(call, update);
                    if update["status"] == "running"
                        && matches!(status.as_str(), Some("failed" | "done"))
                    {
                        call["status"] = status;
                    }
                } else {
                    calls.push(update.clone());
                }
            }
        }
        next["payload"]["codeExecution"]["calls"] = json!(calls);
    }
    merge_payload(&mut previous["payload"], &next["payload"]);
    next["payload"] = previous["payload"].take();
    next
}

fn merge_payload(previous: &mut Value, next: &Value) {
    if let (Some(previous), Some(next)) = (previous.as_object_mut(), next.as_object()) {
        for (key, value) in next.iter().filter(|(_, value)| !value.is_null()) {
            previous.insert(key.clone(), value.clone());
        }
    }
}

fn display_event(event: &Value) -> Value {
    let mut payload = event["payload"].clone();
    if event["type"] != "provider.extension_ui" {
        if let Some(fields) = payload.as_object_mut() {
            fields.remove("raw");
        }
    }
    json!({"type":event["type"],"payload":payload,"projectId":event["projectId"],
        "projectRunId":event["projectRunId"],"taskId":event["taskId"],"timestamp":event["timestamp"]})
}

pub(crate) fn record_imported_message(
    db: &Connection,
    session: &str,
    message: &Value,
) -> CoreResult<()> {
    let id = message["id"].as_str();
    let recorded = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM timeline_blocks
        WHERE session_id=?1 AND json_extract(content,'$.id')=?2)",
            params![session, id],
            |row| row.get::<_, bool>(0),
        )
        .map_err(db_fail)?;
    if !recorded {
        let mut writer = Writer {
            db,
            session,
            changes: vec![],
            turn: None,
        };
        writer.seal()?;
        writer.user(message["runId"].as_str(), id, "legacy")?;
        writer.record()?;
    }
    Ok(())
}

pub(crate) fn migrate(db: &Connection) -> CoreResult<()> {
    db.execute_batch(include_str!("timeline.sql"))
        .map_err(db_fail)?;
    db.execute_batch("BEGIN IMMEDIATE").map_err(db_fail)?;
    let result = (|| {
        if db
            .query_row(
                "SELECT 1 FROM schema_meta WHERE key='timeline_v1'",
                [],
                |_| Ok(()),
            )
            .optional()
            .map_err(db_fail)?
            .is_some()
        {
            if db.execute(
                "INSERT OR IGNORE INTO schema_meta(key,value) VALUES('timeline_tool_rows_v1','1')",
                [],
            ).map_err(db_fail)? == 1 {
                db.execute_batch(include_str!("timeline_tool_rows.sql")).map_err(db_fail)?;
            }
            if db.execute(
                "INSERT OR IGNORE INTO schema_meta(key,value) VALUES('timeline_workflow_plan_rows_v1','1')", [],
            ).map_err(db_fail)? == 1 {
                db.execute_batch(include_str!("timeline_workflow_plan_rows.sql")).map_err(db_fail)?;
            }
            return Ok(());
        }
        let mut sessions = db
            .prepare("SELECT id FROM sessions ORDER BY rowid")
            .map_err(db_fail)?;
        let ids = sessions
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(db_fail)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_fail)?;
        for session in ids {
            let mut imported = HashSet::new();
            let mut journal = db
                .prepare(
                    "SELECT data FROM runtime_events WHERE session_id=? ORDER BY sequence,rowid",
                )
                .map_err(db_fail)?;
            for raw in journal
                .query_map([&session], |row| row.get::<_, String>(0))
                .map_err(db_fail)?
            {
                let event = parse(&raw.map_err(db_fail)?)?;
                if matches!(
                    event["type"].as_str(),
                    Some("agent.message" | "session.follow_up_steered" | "run.started")
                ) {
                    if let Some(id) = event["payload"]["userMessageId"]
                        .as_str()
                        .or_else(|| event["payload"]["messageId"].as_str())
                    {
                        imported.insert(id.to_string());
                    }
                }
                record_event(db, &event)?;
            }
            let mut messages = db
                .prepare("SELECT id,data FROM messages WHERE session_id=? ORDER BY rowid")
                .map_err(db_fail)?;
            let mut writer = Writer {
                db,
                session: &session,
                changes: vec![],
                turn: None,
            };
            for item in messages
                .query_map([&session], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(db_fail)?
            {
                let (id, raw) = item.map_err(db_fail)?;
                if imported.contains(&id) {
                    continue;
                }
                let message = parse(&raw)?;
                if message["kind"] != "chat" && message["sender"] != "user" {
                    continue;
                }
                writer.seal()?;
                writer.create(
                    "legacy",
                    message["runId"].as_str(),
                    message.clone(),
                    true,
                    None,
                    None,
                )?;
            }
            writer.record()?;
            // No client has observed the imported mutations. The next read starts at the final snapshot.
            db.execute(
                "DELETE FROM timeline_changes WHERE session_id=?",
                [&session],
            )
            .map_err(db_fail)?;
        }
        db.execute(
            "INSERT INTO schema_meta(key,value) VALUES('timeline_v1','1'),('timeline_tool_rows_v1','1'),('timeline_workflow_plan_rows_v1','1')",
            [],
        )
        .map_err(db_fail)?;
        Ok(())
    })();
    match result {
        Ok(()) => db.execute_batch("COMMIT").map_err(db_fail),
        Err(error) => {
            let _ = db.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

pub fn open(db: &Connection, session: &str) -> CoreResult<Value> {
    read_snapshot(db, || {
        if db
            .query_row("SELECT 1 FROM sessions WHERE id=?", [session], |_| Ok(()))
            .optional()
            .map_err(db_fail)?
            .is_none()
        {
            return Err(not_found("session", session));
        }
        let mut statement = db
            .prepare(&format!(
                "SELECT {BLOCK_FIELDS} FROM timeline_blocks WHERE session_id=? ORDER BY seq ASC"
            ))
            .map_err(db_fail)?;
        let blocks = statement
            .query_map([session], block)
            .map_err(db_fail)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_fail)?;
        let mut rounds = db.prepare("SELECT run_id,status,duration_ms,final_block_id FROM timeline_turns WHERE session_id=?").map_err(db_fail)?;
        let turns = rounds.query_map([session], |row| Ok(json!({
            "runId":row.get::<_,String>(0)?,"status":row.get::<_,String>(1)?,
            "durationMs":row.get::<_,Option<i64>>(2)?,"finalBlockId":row.get::<_,Option<String>>(3)?
        }))).map_err(db_fail)?.collect::<Result<Vec<_>,_>>().map_err(db_fail)?;
        let revision = db
            .query_row(
                "SELECT COALESCE(MAX(revision),0) FROM timeline_changes WHERE session_id=?",
                [session],
                |row| row.get::<_, i64>(0),
            )
            .map_err(db_fail)?;
        Ok(json!({"revision":revision,"blocks":blocks,"turns":turns}))
    })
}

pub fn changes(db: &Connection, session: &str, after: i64) -> CoreResult<Value> {
    read_snapshot(db, || {
        let (min, max): (Option<i64>, Option<i64>) = db
            .query_row(
                "SELECT MIN(revision),MAX(revision) FROM timeline_changes WHERE session_id=?",
                [session],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(db_fail)?;
        let reset =
            after < 0 || after > max.unwrap_or(0) || min.is_some_and(|floor| after < floor - 1);
        if reset {
            return Ok(json!({"reset":true,"revision":after,"changes":[]}));
        }
        let mut query = db.prepare("SELECT revision,data FROM timeline_changes WHERE session_id=? AND revision>? ORDER BY revision LIMIT 128").map_err(db_fail)?;
        let mut revision = after;
        let mut changes = vec![];
        for row in query
            .query_map(params![session, after], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(db_fail)?
        {
            let (next, raw) = row.map_err(db_fail)?;
            revision = next;
            changes.push(parse(&raw)?);
        }
        Ok(json!({"reset":false,"revision":revision,"changes":changes}))
    })
}

/// Remote attachment reads are by artifact ID. The phone never receives the host path.
pub fn for_remote(page: &mut Value) {
    fn clean(block: &mut Value) {
        if let Some(attachments) = block
            .get_mut("content")
            .and_then(|content| content.get_mut("attachments"))
            .and_then(Value::as_array_mut)
        {
            for item in attachments.iter_mut().filter_map(Value::as_object_mut) {
                item.remove("path");
            }
        }
        if let Some(content) = block.get_mut("content").and_then(Value::as_object_mut) {
            content.remove("nativeIdentity");
        }
    }
    if let Some(blocks) = page.get_mut("blocks").and_then(Value::as_array_mut) {
        blocks.iter_mut().for_each(clean);
    }
    if let Some(changes) = page.get_mut("changes").and_then(Value::as_array_mut) {
        for batch in changes {
            if let Some(ops) = batch["operations"].as_array_mut() {
                for op in ops.iter_mut().filter(|op| op["type"] == "block_created") {
                    clean(&mut op["block"]);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests;
