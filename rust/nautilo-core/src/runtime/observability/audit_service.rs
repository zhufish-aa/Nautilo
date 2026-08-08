//! Buffered audit trail — port of runtime/observability/audit-service.ts.

use std::sync::{Arc, Mutex};

use serde_json::{json, Map, Value};

use crate::database::{lock, Database, Repositories};
use crate::errors::{invalid, not_found, now_iso, CoreError, CoreResult, ErrorCode};
use crate::runtime::security::RedactionService;
use uuid::Uuid;


const AUDIT_FLUSH_THRESHOLD: usize = 50;

/// Buffers audit records briefly so high-frequency IPC does not hit SQLite
/// per request; a background task flushes every 500ms like the TS timer.
pub struct AuditService {
    db: Arc<Mutex<Database>>,
    redaction: RedactionService,
    pending: Mutex<Vec<Value>>,
}

impl AuditService {
    pub fn new(db: Arc<Mutex<Database>>, redaction: RedactionService) -> Arc<Self> {
        let service = Arc::new(Self { db, redaction, pending: Mutex::new(vec![]) });
        let flusher = service.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                let _ = flusher.flush();
            }
        });
        service
    }

    pub fn record(&self, mut input: Map<String, Value>) -> Value {
        input.insert("id".to_string(), json!(Uuid::new_v4().to_string()));
        input.insert("timestamp".to_string(), json!(now_iso()));
        let record = self.redaction.value(&Value::Object(input));
        let mut pending = self.pending.lock().unwrap();
        pending.push(record.clone());
        if pending.len() >= AUDIT_FLUSH_THRESHOLD {
            drop(pending);
            let _ = self.flush();
        }
        record
    }

    pub fn ipc(&self, method: &str, input: &Value, outcome: &str, details: Option<&Value>) {
        let mut record = Map::new();
        record.insert("actorType".to_string(), json!("user"));
        record.insert("actorId".to_string(), json!("desktop-user"));
        record.insert("action".to_string(), json!(format!("ipc.{method}")));
        record.insert("resourceType".to_string(), json!("ipc"));
        record.insert("outcome".to_string(), json!(outcome));
        record.insert(
            "details".to_string(),
            self.redaction.value(&json!({ "input": input, "result": details.cloned().unwrap_or(Value::Null) })),
        );
        self.record(record);
    }

    pub fn list(&self, limit: Option<i64>, resource_id: Option<&str>) -> CoreResult<Vec<Value>> {
        let _ = self.flush();
        Repositories::new(&lock(&self.db).raw).audit().list(limit, resource_id)
    }

    pub fn flush(&self) -> CoreResult<()> {
        let batch: Vec<Value> = std::mem::take(&mut *self.pending.lock().unwrap());
        if batch.is_empty() {
            return Ok(());
        }
        Repositories::new(&lock(&self.db).raw).audit().append_many(&batch)
    }
}
