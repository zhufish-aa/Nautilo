//! Repair missing file receipts from a provider's real history, without
//! importing chat messages, changing accounts, or starting a model turn.
use super::*;
use crate::database::native_history::NativeHistoryRepository;

impl RunService {
    pub async fn sync_native_file_changes(self: &Arc<Self>, session_id: &str) -> CoreResult<()> {
        let (session, request) = self.native_request(session_id)?;
        if request.instance["providerId"] != "opencode" { return Ok(()); }
        let Some(native) = session["providerSessionId"].as_str() else { return Ok(()) };
        let needs_repair = {
            let db = self.db.lock().unwrap();
            db.raw.query_row("SELECT EXISTS(SELECT 1 FROM runtime_events t WHERE t.session_id=?1
                AND json_extract(t.data,'$.type')='tool.finished'
                AND json_extract(t.data,'$.payload.toolName') IN ('write','edit','apply_patch','multiedit')
                AND json_extract(t.data,'$.payload.success')=1
                AND json_extract(t.data,'$.payload.callId') NOT IN
                    (SELECT json_extract(f.data,'$.payload.callId') FROM runtime_events f WHERE f.session_id=?1
                    AND json_extract(f.data,'$.type')='file.changed'
                    AND json_extract(f.data,'$.payload.callId') IS NOT NULL))",
                [session_id], |row|row.get::<_,bool>(0)).map_err(crate::database::connection::db_fail)?
        };
        if !needs_repair { return Ok(()); }
        let adapter = self.adapters.get("opencode")?;
        let Some(snapshot) = adapter.read_session_history(&request, native).await? else { return Ok(()) };
        let entries = snapshot["activities"].as_array().into_iter().flatten()
            .filter(|entry|entry["event"]["kind"]=="file")
            .map(|entry| {
                let event = &entry["event"];
                json!({"nativeId":entry["id"],"timestamp":entry["timestampMs"].as_i64()
                    .and_then(chrono::DateTime::from_timestamp_millis)
                    .map(|time|time.to_rfc3339_opts(chrono::SecondsFormat::Millis,true)),
                    "payload":self.redaction.value(&json!({"path":event["path"],"changeType":event["changeType"],
                        "diff":event["diff"],"additions":event["additions"],"deletions":event["deletions"],
                        "callId":event["callId"],"fileSnapshot":event.get("snapshot").and_then(crate::adapters::file_snapshot)}))})
            }).collect::<Vec<_>>();
        let events = {
            let db = self.db.lock().unwrap();
            // History was fetched asynchronously. Do not attach it if the
            // user changed the connection or native identity in the meantime.
            let current = Repositories::new(&db.raw).sessions().get(session_id)?;
            if current.as_ref().is_none_or(|current|current["providerSessionId"]!=session["providerSessionId"]
                || current["connectionId"]!=session["connectionId"] || current["connectionRevision"]!=session["connectionRevision"]) {
                return Ok(());
            }
            NativeHistoryRepository::new(&db.raw).commit_file_activities(&session, &entries)?
        };
        self.events.publish_committed(&events);
        Ok(())
    }
}
