//! Read native credential/catalog databases without migrations or writes.
use super::document::Documents;
use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Value};
use std::path::Path;

pub fn omp_catalog(docs: &mut Documents, root: &Path) -> (Value, Value) {
    let mut auth = json!({});
    let mut providers = json!({});
    let path = root.join("agent.db");
    if path.is_file() {
        let read = (|| -> rusqlite::Result<()> {
            let db = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
            db.busy_timeout(std::time::Duration::from_millis(200))?;
            let mut query=db.prepare("SELECT provider,data FROM auth_credentials WHERE credential_type='api_key' AND disabled_cause IS NULL LIMIT 128")?;
            for row in query.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })? {
                let (id, data) = row?;
                if let Ok(value) = serde_json::from_str::<Value>(&data) {
                    if value["key"].is_string() {
                        auth[&id] = json!({"type":"api_key","key":value["key"]});
                    }
                }
            }
            Ok(())
        })();
        docs.reports.push(json!({"harness":"omp","path":path.to_string_lossy(),"status":if read.is_ok(){"read"}else{"error"},"error":if read.is_ok(){Value::Null}else{json!("CONFIG_UNREADABLE")}}));
    }
    let path = root.join("models.db");
    if path.is_file() {
        let _ = (|| -> rusqlite::Result<()> {
            let db = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
            db.busy_timeout(std::time::Duration::from_millis(200))?;
            let mut query =
                db.prepare("SELECT models FROM model_cache WHERE provider_id=?1 LIMIT 1")?;
            for id in auth.as_object().unwrap().keys() {
                let data = query.query_row([id], |row| row.get::<_, String>(0));
                if let Ok(data) = data {
                    if data.len() < 4 * 1024 * 1024 {
                        if let Ok(items) = serde_json::from_str::<Value>(&data) {
                            if let Some(first) = items.as_array().and_then(|m| m.first()) {
                                // Cached catalogs supply endpoint/transport, not hundreds of enabled models.
                                providers[id] = json!({"baseUrl":first["baseUrl"],"api":first["api"],"models":[]});
                            }
                        }
                    }
                }
            }
            Ok(())
        })();
    }
    (auth, json!({"providers":providers}))
}
