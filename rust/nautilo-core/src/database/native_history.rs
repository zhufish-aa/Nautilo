//! Durable handoff checkpoints and native identity bindings. No credentials
//! or transcripts are stored in checkpoints; only identity and fingerprints.
use crate::database::{connection::db_fail, Repositories};
use crate::errors::{invalid, now_iso, CoreResult};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

pub struct NativeHistoryRepository<'a> {
    db: &'a Connection,
}
#[derive(Default)]
pub struct ImportBatch {
    pub messages: Vec<Value>,
    pub runs: Vec<Value>,
    pub activities: Vec<Value>,
    pub artifacts: Vec<Value>,
    pub bindings: Vec<Value>,
    pub expected_messages: Vec<(String, Option<Value>)>,
    pub expected_runs: Vec<(String, Option<Value>)>,
    pub expected_session: Option<Value>,
}
impl<'a> NativeHistoryRepository<'a> {
    pub fn new(db: &'a Connection) -> Self {
        Self { db }
    }
    pub fn get(&self, session: &str) -> CoreResult<Option<Value>> {
        self.db
            .query_row(
                "SELECT data FROM native_handoffs WHERE session_id=?1",
                params![session],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(db_fail)
            .map(|row| row.and_then(|text| serde_json::from_str(&text).ok()))
    }
    pub fn save(&self, record: &Value) -> CoreResult<()> {
        self.db.execute("INSERT INTO native_handoffs(session_id,data,updated_at) VALUES(?1,?2,?3) ON CONFLICT(session_id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at",params![record["sessionId"].as_str().unwrap_or(""),record.to_string(),now_iso()]).map_err(db_fail)?;
        Ok(())
    }
    pub fn binding(
        &self,
        session: &str,
        provider_session: &str,
        kind: &str,
        native: &str,
    ) -> CoreResult<Option<Value>> {
        let row=self.db.query_row("SELECT local_id,fingerprint FROM native_history_bindings WHERE session_id=?1 AND provider_session_id=?2 AND entry_kind=?3 AND native_id=?4",params![session,provider_session,kind,native],|row|Ok(json!({"localId":row.get::<_,Option<String>>(0)?,"fingerprint":row.get::<_,String>(1)?}))).optional().map_err(db_fail)?;
        if row.is_some() || kind != "messages" {
            return Ok(row);
        }
        // Legacy streaming messages already have an exact native-ID journal
        // link even when their domain row predates native history bindings.
        self.db.query_row("SELECT json_extract(data,'$.payload.messageId') FROM runtime_events WHERE session_id=?1 AND json_extract(data,'$.type')='agent.message' AND json_extract(data,'$.payload.providerMessageId')=?2 AND json_extract(data,'$.payload.subagentDispatchId') IS NULL ORDER BY sequence DESC LIMIT 1",params![session,native],|row|row.get::<_,String>(0)).optional().map_err(db_fail).map(|row|row.map(|id|json!({"localId":id,"fingerprint":""})))
    }
    pub fn bind(
        &self,
        session: &str,
        provider_session: &str,
        kind: &str,
        native: &str,
        local: Option<&str>,
        fingerprint: &str,
    ) -> CoreResult<()> {
        self.db.execute("INSERT INTO native_history_bindings(session_id,provider_session_id,entry_kind,native_id,local_id,fingerprint) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(session_id,provider_session_id,entry_kind,native_id) DO UPDATE SET local_id=excluded.local_id,fingerprint=excluded.fingerprint",params![session,provider_session,kind,native,local,fingerprint]).map_err(db_fail)?;
        Ok(())
    }
    pub fn activity_run(&self, session: &str, call: &str) -> CoreResult<Option<String>> {
        self.db.query_row("SELECT run_id FROM runtime_events WHERE session_id=?1 AND (json_extract(data,'$.payload.callId')=?2 OR json_extract(data,'$.payload.messageId')=?2) AND json_extract(data,'$.payload.subagentDispatchId') IS NULL AND run_id IS NOT NULL ORDER BY sequence DESC LIMIT 1",params![session,call],|row|row.get(0)).optional().map_err(db_fail)
    }
    pub fn commit(
        &self,
        session: &Value,
        expected_id: &str,
        next: &Value,
        mut batch: ImportBatch,
    ) -> CoreResult<Vec<Value>> {
        let session_id = session["id"].as_str().unwrap_or("");
        self.db.execute_batch("BEGIN IMMEDIATE").map_err(db_fail)?;
        let result = (|| {
            let current = self
                .get(session_id)?
                .ok_or_else(|| invalid("nativeHandoff", "Native handoff checkpoint is missing"))?;
            if current["id"].as_str() != Some(expected_id) {
                return Err(invalid(
                    "nativeHandoff",
                    "Native handoff changed while history was being read",
                ));
            }
            let repos = Repositories::new(self.db);
            if let Some(expected) = &batch.expected_session {
                if repos.sessions().get(session_id)?.as_ref() != Some(expected) {
                    return Err(invalid(
                        "nativeHistoryRetry",
                        "Session changed during history import",
                    ));
                }
            }
            for (id, expected) in &batch.expected_messages {
                if repos.sessions().message(session_id, id)? != *expected {
                    return Err(invalid(
                        "nativeHistoryRetry",
                        "A native message advanced during history import",
                    ));
                }
            }
            for (id, expected) in &batch.expected_runs {
                if repos.runs().get(id)? != *expected {
                    return Err(invalid(
                        "nativeHistoryRetry",
                        "A native turn advanced during history import",
                    ));
                }
            }
            for artifact in &batch.artifacts {
                repos.artifacts().save(
                    artifact,
                    Some(&now_iso()),
                    artifact["metadata"]["sizeBytes"].as_i64().unwrap_or(0),
                )?;
            }
            for run in &batch.runs {
                repos.runs().save(run)?;
            }
            for message in &batch.messages {
                repos.sessions().save_message(message)?;
            }
            repos.sessions().save(session)?;
            for binding in &batch.bindings {
                self.bind(
                    session_id,
                    next["providerSessionId"].as_str().unwrap_or(""),
                    binding["kind"].as_str().unwrap_or(""),
                    binding["nativeId"].as_str().unwrap_or(""),
                    binding["localId"].as_str(),
                    binding["fingerprint"].as_str().unwrap_or(""),
                )?;
            }
            let count = batch.messages.len();
            if count > 0 || !batch.activities.is_empty() {
                batch.activities.push(json!({"type":"session.native_history_synced","payload":{"providerSessionId":next["providerSessionId"],"messageIds":batch.messages.iter().map(|m|m["id"].clone()).collect::<Vec<_>>(),"messageCount":count}}));
            }
            let mut sequence = repos.events().next_sequence(Some(session_id), None)?;
            for event in &mut batch.activities {
                event["schemaVersion"] = json!(1);
                event["eventId"] = json!(uuid::Uuid::new_v4().to_string());
                event["sessionId"] = json!(session_id);
                event["projectId"] = session["projectId"].clone();
                event["timestamp"] = event
                    .get("timestamp")
                    .cloned()
                    .unwrap_or_else(|| json!(now_iso()));
                event["sequence"] = json!(sequence);
                sequence += 1;
                repos.events().append(event)?;
            }
            self.save(next)?;
            Ok(batch.activities)
        })();
        match result {
            Ok(events) => {
                self.db.execute_batch("COMMIT").map_err(db_fail)?;
                Ok(events)
            }
            Err(error) => {
                let _ = self.db.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    }
}
