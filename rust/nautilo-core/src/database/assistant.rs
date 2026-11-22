//! Bounded reads for the workbench assistant. The session journal stays on disk.
use crate::database::connection::db_fail;
use crate::errors::{invalid, not_found, CoreResult};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

const RECORDS: &str = "SELECT rowid AS seq, data FROM assistant_records WHERE kind=? AND rowid>? AND (?=0 OR rowid<?) AND (?='' OR instr(lower(data),lower(?))>0)";

pub fn records(db: &Connection, input: &Value) -> CoreResult<Value> {
    if let Some(id) = input["id"].as_str() {
        let record: Option<(i64, String)> = db.query_row("SELECT rowid,data FROM assistant_records WHERE id=?1 AND kind=?2",
            params![id, input["kind"].as_str()], |row| Ok((row.get(0)?, row.get(1)?)))
            .optional().map_err(db_fail)?;
        return Ok(json!(record.into_iter().map(|(seq, data)| json!({"seq":seq,"value":serde_json::from_str::<Value>(&data).unwrap_or(Value::Null)})).collect::<Vec<_>>()));
    }
    let order = if input["oldest"] == true {
        "ASC"
    } else {
        "DESC"
    };
    let sql = format!("{RECORDS} ORDER BY rowid {order} LIMIT ?");
    let before = input["before"].as_i64().unwrap_or(0);
    let term = input["query"].as_str().unwrap_or("");
    let mut stmt = db.prepare(&sql).map_err(db_fail)?;
    let rows = stmt.query_map(params![input["kind"].as_str(),input["after"].as_i64().unwrap_or(0),before,before,term,term,input["limit"].as_i64().unwrap_or(24).clamp(1,40)], |row| {
        let text: String = row.get(1)?;
        Ok(json!({"seq":row.get::<_,i64>(0)?,"value":serde_json::from_str::<Value>(&text).unwrap_or(Value::Null)}))
    }).map_err(db_fail)?.collect::<Result<Vec<_>,_>>().map_err(db_fail)?;
    Ok(Value::Array(rows))
}

pub fn save(db: &Connection, input: &Value) -> CoreResult<Value> {
    let kind = input["kind"].as_str().unwrap_or("");
    let id = input["id"].as_str().unwrap_or("");
    let data = input["value"].to_string();
    if !matches!(kind, "turn" | "settings" | "memory" | "automation")
        || id.is_empty()
        || id.len() > 100
        || (kind != "turn" && id != kind)
        || !input["value"].is_object()
        || data.len() > 256_000
    {
        return Err(invalid("assistant", "Invalid assistant record"));
    }
    let seq: i64 = db.query_row("INSERT INTO assistant_records(id,kind,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data WHERE assistant_records.kind=excluded.kind RETURNING rowid",params![id,kind,data],|row|row.get(0)).map_err(db_fail)?;
    Ok(json!({"seq":seq}))
}

pub fn dispatches(db: &Connection, input: &Value) -> CoreResult<Value> {
    let items = input["items"].as_array().filter(|items| items.len() <= 100)
        .ok_or_else(|| invalid("items", "Supply up to 100 assistant dispatches"))?;
    let mut output = Vec::with_capacity(items.len());
    let mut run = db.prepare_cached(
        "SELECT coalesce((SELECT id FROM runs WHERE id=?1 AND session_id=?2), (SELECT run_id FROM runtime_events WHERE session_id=?2 AND json_extract(data,'$.type')='run.started' AND json_extract(data,'$.payload.userMessageId')=?3 ORDER BY sequence DESC LIMIT 1))"
    ).map_err(db_fail)?;
    let mut result = db.prepare_cached(
        "SELECT substr(json_extract(data,'$.text'),1,6000) FROM messages WHERE session_id=?1 AND json_extract(data,'$.sender')='agent' AND ((?2<>'' AND json_extract(data,'$.runId')=?2) OR (?3<>'' AND json_extract(data,'$.projectRunId')=?3)) ORDER BY created_at DESC,rowid DESC LIMIT 1"
    ).map_err(db_fail)?;
    for item in items {
        let session_id = item["sessionId"].as_str().ok_or_else(|| invalid("sessionId", "Missing session"))?;
        let message_id = item["messageId"].as_str().ok_or_else(|| invalid("messageId", "Missing message"))?;
        let project_run = item["projectRunId"].as_str().unwrap_or("");
        let run_id: Option<String> = run.query_row(params![item["runId"].as_str(), session_id, message_id], |row| row.get(0)).map_err(db_fail)?;
        let run_id = run_id.as_deref().unwrap_or("");
        let status: Option<String> = db.query_row(
            "SELECT coalesce((SELECT json_extract(data,'$.status') FROM project_runs WHERE id=?1),(SELECT json_extract(data,'$.status') FROM runs WHERE id=?2))",
            params![project_run, run_id], |row| row.get(0)).map_err(db_fail)?;
        let summary = if status.as_deref() == Some("completed") {
            result.query_row(params![session_id,run_id,project_run], |row| row.get::<_, Option<String>>(0))
                .optional().map_err(db_fail)?.flatten()
        } else {
            None
        };
        let mut dispatch = json!({"messageId":message_id});
        if let Some(status) = status { dispatch["status"] = json!(status); }
        if let Some(summary) = summary { dispatch["result"] = json!(summary); }
        output.push(dispatch);
    }
    Ok(json!(output))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dispatch_projection_links_queued_message_to_its_completed_run() {
        let db = Connection::open_in_memory().unwrap();
        crate::database::migrations::migrate(&db).unwrap();
        db.execute("INSERT INTO runs VALUES('run','worker','{\"status\":\"running\"}','2026-11-22')", []).unwrap();
        db.execute("INSERT INTO runtime_events VALUES('started',1,'worker',NULL,'run',?1,'2026-11-22')",
            [json!({"type":"run.started","payload":{"userMessageId":"submitted"}}).to_string()]).unwrap();
        let keys = json!({"items":[{"sessionId":"worker","messageId":"submitted"},
            {"sessionId":"other","messageId":"submitted","runId":"run"}]});
        let running = dispatches(&db, &keys).unwrap();
        assert_eq!(running[0]["status"], "running");
        assert!(running[1]["status"].is_null());
        db.execute("UPDATE runs SET data=?1 WHERE id='run'", [json!({"status":"completed"}).to_string()]).unwrap();
        db.execute("INSERT INTO messages VALUES('reply','worker',?1,'2026-11-22')",
            [json!({"runId":"run","sender":"agent","text":"Verified"}).to_string()]).unwrap();
        let done = dispatches(&db, &keys).unwrap();
        assert_eq!(done[0]["status"], "completed");
        assert!(done[0]["result"].as_str().unwrap().contains("Verified"));
    }
}

const SESSIONS: &str = r#"WITH filter AS (SELECT ? AS project, ? AS session, lower(?) AS term, ? AS previews),
catalog AS (
  SELECT s.*, p.data AS project_data,
    (SELECT r.data FROM runs r WHERE r.session_id=s.id AND coalesce(json_extract(r.data,'$.presentation'),'') <> 'provider_command' ORDER BY r.updated_at DESC, r.rowid DESC LIMIT 1) AS last_run,
    (SELECT max(m.created_at) FROM messages m WHERE m.session_id=s.id) AS activity
  FROM sessions s LEFT JOIN projects p ON p.id=s.project_id, filter f
  WHERE (f.project='' OR s.project_id=f.project) AND (f.session='' OR s.id=f.session)
    AND (f.term='' OR instr(lower(json_extract(s.data,'$.title')),f.term)>0 OR instr(lower(coalesce(json_extract(p.data,'$.name'),'')),f.term)>0
      OR EXISTS (SELECT 1 FROM messages m WHERE m.session_id=s.id AND json_extract(m.data,'$.kind')='chat' AND instr(lower(json_extract(m.data,'$.text')),f.term)>0))
)
SELECT json_object('id',s.id,'title',substr(json_extract(s.data,'$.title'),1,160),
 'projectId',s.project_id,'project',json_extract(s.project_data,'$.name'),
 'harness',coalesce(json_extract(a.data,'$.displayName'),s.member_id),'status',json_extract(s.data,'$.status'),
 'runStatus',json_extract(s.last_run,'$.status'),'updatedAt',max(s.updated_at,coalesce(s.activity,'')),
 'preview',CASE WHEN f.previews THEN (SELECT substr(json_extract(m.data,'$.text'),1,140) FROM messages m
    WHERE m.session_id=s.id AND json_extract(m.data,'$.kind')='chat' ORDER BY m.created_at DESC,m.rowid DESC LIMIT 1) END) AS item
FROM catalog s LEFT JOIN agents a ON a.id=coalesce(json_extract(s.data,'$.agentInstanceId'),s.member_id), filter f
ORDER BY max(s.updated_at,coalesce(s.activity,'')) DESC,s.id LIMIT 13 OFFSET ?"#;
const EXCERPTS: &str = r#"WITH filter AS (SELECT ? AS session, lower(?) AS term, ? AS anchor, ? AS message, ? AS start),
matches AS (
 SELECT m.rowid AS ordinal,m.id,m.created_at,json_extract(m.data,'$.sender') AS sender,
   json_extract(m.data,'$.text') AS body,f.message,
   CASE WHEN f.message<>'' THEN f.start WHEN f.term<>'' THEN max(0,instr(lower(json_extract(m.data,'$.text')),f.term)-81) ELSE 0 END AS start
 FROM messages m,filter f WHERE m.session_id=f.session AND json_extract(m.data,'$.kind')='chat'
 AND (f.message='' OR m.id=f.message)
 AND (f.term='' OR instr(lower(json_extract(m.data,'$.text')),f.term)>0)
 AND (f.anchor=0 OR (m.created_at,m.rowid)<(SELECT created_at,rowid FROM messages WHERE session_id=f.session AND rowid=f.anchor))
 ORDER BY m.created_at DESC,m.rowid DESC LIMIT 7
)
SELECT ordinal,json_object('id',id,'at',created_at,'sender',sender,'offset',start,
 'text',substr(body,start+1,CASE WHEN message='' THEN 480 ELSE 1200 END),
 'nextOffset',CASE WHEN length(body)>start+(CASE WHEN message='' THEN 480 ELSE 1200 END) THEN start+(CASE WHEN message='' THEN 480 ELSE 1200 END) END) AS item
FROM matches ORDER BY created_at DESC,ordinal DESC"#;

pub fn sessions(db: &Connection, input: &Value) -> CoreResult<Value> {
    let query = input["query"].as_str().unwrap_or("");
    if query.chars().count() > 200 {
        return Err(invalid("query", "Search accepts up to 200 characters"));
    }
    let skip = input["skip"].as_i64().unwrap_or(0).max(0);
    let mut stmt = db.prepare(SESSIONS).map_err(db_fail)?;
    let items = stmt
        .query_map(
            params![
                input["projectId"].as_str().unwrap_or(""),
                input["sessionId"].as_str().unwrap_or(""),
                query,
                input["previews"] == true,
                skip
            ],
            |row| row.get::<_, String>(0),
        )
        .map_err(db_fail)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_fail)?;
    let next = (items.len() > 12).then(|| skip + 12);
    let page: Vec<Value> = items
        .iter()
        .take(12)
        .map(|s| serde_json::from_str(s).unwrap_or(Value::Null))
        .collect();
    Ok(json!({"items":page,"next":next}))
}

pub fn excerpts(db: &Connection, input: &Value) -> CoreResult<Value> {
    let id = input["sessionId"].as_str().unwrap_or("");
    if !db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sessions WHERE id=?)",
            [id],
            |r| r.get::<_, bool>(0),
        )
        .map_err(db_fail)?
    {
        return Err(not_found("session", id));
    }
    let query = input["query"].as_str().unwrap_or("");
    if query.chars().count() > 200 {
        return Err(invalid("query", "Search accepts up to 200 characters"));
    }
    let mut stmt = db.prepare(EXCERPTS).map_err(db_fail)?;
    let rows = stmt
        .query_map(
            params![
                id,
                query,
                input["before"].as_i64().unwrap_or(0),
                input["messageId"].as_str().unwrap_or(""),
                input["offset"].as_i64().unwrap_or(0).max(0)
            ],
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)),
        )
        .map_err(db_fail)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_fail)?;
    let next = (rows.len() > 6).then(|| rows[5].0);
    let items: Vec<Value> = rows
        .iter()
        .take(6)
        .map(|(_, s)| serde_json::from_str(s).unwrap_or(Value::Null))
        .collect();
    Ok(json!({"items":items,"next":next}))
}
