//! Small usage-only hydration, independent of the last 200 timeline events.
use anyhow::Result;
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::collections::HashSet;

fn count(value: &Value, zero: bool) -> bool {
    value.as_f64().is_some_and(|n| n.is_finite() && n.fract() == 0.0
        && n >= (if zero { 0.0 } else { 1.0 }) && n <= 9_007_199_254_740_991.0)
}

pub(super) fn read(db: &Connection, session: &str, through: i64) -> Result<Value> {
    let mut query = db.prepare("SELECT data FROM runtime_events WHERE session_id=?1 AND sequence<=?2 AND json_extract(data,'$.type')='usage.updated' ORDER BY sequence DESC")?;
    let rows = query.query_map(params![session, through], |row| row.get::<_, String>(0))?;
    let mut keys = HashSet::new();
    let mut used = false;
    let mut window = false;
    let mut events = Vec::new();
    for row in rows {
        let event: Value = serde_json::from_str(&row?)?;
        let payload = &event["payload"];
        if payload["subagentDispatchId"].as_str().is_some_and(|s| !s.is_empty()) { continue; }
        let observes_used = !used && count(&payload["contextUsed"], true);
        let observes_window = !window && count(&payload["contextWindow"], false);
        used |= observes_used;
        window |= observes_window;
        let scope = payload["usageScope"].as_str().unwrap_or("");
        let native_key = payload["usageKey"].as_str().or_else(||
            if scope == "turn" { event["runId"].as_str() } else { None });
        let accounting = matches!(scope, "turn" | "session") && native_key.is_some_and(|key| !key.is_empty())
            && keys.insert(json!([payload["connectionId"],payload["connectionRevision"],payload["agentInstanceId"],scope,native_key]).to_string());
        if !observes_used && !observes_window && !accounting { continue; }
        // Only counters and scope identity cross the wire, never native credentials or logs.
        let mut compact = json!({});
        for field in ["contextUsed","contextWindow","usageScope","usageKey","inputTokens","outputTokens",
            "cachedInputTokens","cacheCreationInputTokens","inputTokensIncludesCache","connectionId","connectionRevision","agentInstanceId"] {
            if let Some(value) = payload.get(field) { compact[field] = value.clone(); }
        }
        events.push(json!({"type":"usage.updated","eventId":event["eventId"],"sequence":event["sequence"],"runId":event["runId"],"payload":compact}));
    }
    events.reverse();
    Ok(json!({"events":events}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn hydration_retains_independent_context_and_replaces_accounting_snapshots() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE runtime_events(session_id TEXT, sequence INTEGER, data TEXT)").unwrap();
        let insert = |seq, session: &str, payload: Value| {
            let event = json!({"eventId":format!("e{seq}"),"sequence":seq,"type":"usage.updated","runId":"r","payload":payload});
            db.execute("INSERT INTO runtime_events VALUES(?1,?2,?3)", params![session,seq,event.to_string()]).unwrap();
        };
        insert(1, "s", json!({"contextWindow":1000}));
        insert(2, "s", json!({"usageScope":"turn","inputTokens":10,"outputTokens":1,"inputTokensIncludesCache":true}));
        insert(300, "s", json!({"usageScope":"turn","inputTokens":15,"outputTokens":2,"inputTokensIncludesCache":true,"secret":"not for mobile"}));
        insert(301, "s", json!({"contextUsed":700}));
        insert(302, "s", json!({"contextUsed":50,"contextWindow":0}));
        insert(303, "s", json!({"contextUsed":999,"subagentDispatchId":"child"}));
        insert(304, "other", json!({"contextUsed":999}));
        insert(305, "s", json!({"contextUsed":900}));
        let result = read(&db,"s",304).unwrap();
        let events = result["events"].as_array().unwrap();
        assert_eq!(events.iter().map(|e|e["sequence"].as_i64().unwrap()).collect::<Vec<_>>(), vec![1,300,302]);
        assert!(!result.to_string().contains("secret"));
        assert_eq!(events[1]["payload"]["inputTokens"],15);
        assert!(count(&json!(0),true));
        assert!(!count(&json!(-1),true));
        assert!(!count(&json!(1.5),true));
        assert!(!count(&json!("100"),true));
    }
}
