//! Diagnostics export — port of runtime/observability/diagnostics-service.ts.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde_json::{json, Map, Value};

use crate::database::{Database, Repositories};
use crate::errors::{now_iso, CoreResult};
use crate::runtime::observability::{AuditService, MetricsService};
use crate::runtime::security::RedactionService;

pub struct DiagnosticsService {
    db: Arc<Mutex<Database>>,
    audit: Arc<AuditService>,
    metrics: Arc<MetricsService>,
    redaction: RedactionService,
    output_directory: PathBuf,
}

impl DiagnosticsService {
    pub fn new(
        db: Arc<Mutex<Database>>,
        audit: Arc<AuditService>,
        metrics: Arc<MetricsService>,
        redaction: RedactionService,
        data_dir: &std::path::Path,
    ) -> Self {
        Self { db, audit, metrics, redaction, output_directory: data_dir.join("diagnostics") }
    }

    pub fn export(&self, project_id: Option<&str>, project_run_id: Option<&str>) -> CoreResult<Value> {
        std::fs::create_dir_all(&self.output_directory)
            .map_err(|e| crate::errors::CoreError::reason(crate::errors::ErrorCode::IpcInternalError, e.to_string()))?;
        let created_at = now_iso();
        let events = {
            let db = self.db.lock().unwrap();
            Repositories::new(&db.raw).events().replay(None, project_run_id, None, None)?
        };
        let audit = self.audit.list(Some(500), project_run_id)?;
        let metrics = self.metrics.snapshot(project_id)?;
        let (projects, agents, project_runs) = {
            let db = self.db.lock().unwrap();
            let repos = Repositories::new(&db.raw);
            let projects: Vec<Value> = repos
                .projects()
                .list_default()?
                .into_iter()
                .filter(|project| project_id.is_none() || project.get("id").and_then(Value::as_str) == project_id)
                .collect();
            let agents: Vec<Value> = repos
                .agents()
                .list_default()?
                .into_iter()
                .map(|agent| {
                    let mut redacted = agent.as_object().cloned().unwrap_or_default();
                    if let Some(options) = agent.get("providerOptions").and_then(Value::as_object) {
                        let mut clean = Map::new();
                        for (key, value) in options {
                            if regex::Regex::new(r"(?i)key|token|secret|password").map(|re| re.is_match(key)).unwrap_or(false) {
                                clean.insert(key.clone(), json!("[REDACTED]"));
                            } else {
                                clean.insert(key.clone(), value.clone());
                            }
                        }
                        redacted.insert("providerOptions".to_string(), Value::Object(clean));
                    }
                    Value::Object(redacted)
                })
                .collect();
            let project_runs: Vec<Value> = repos
                .project_runs()
                .list_all()?
                .into_iter()
                .filter(|run| project_run_id.is_none() || run.get("id").and_then(Value::as_str) == project_run_id)
                .collect();
            (projects, agents, project_runs)
        };
        let payload = self.redaction.value(&json!({
            "schemaVersion": 1,
            "createdAt": created_at,
            "platform": std::env::consts::OS,
            "node": format!("nautilo-core/{}", crate::VERSION),
            "metrics": metrics,
            "projects": projects,
            "agents": agents,
            "projectRuns": project_runs,
            "events": events,
            "audit": audit
        }));
        let path = self
            .output_directory
            .join(format!("agenthub-diagnostics-{}.json", created_at.replace([':', '.'], "-")));
        std::fs::write(&path, serde_json::to_string_pretty(&payload).unwrap_or_default())
            .map_err(|e| crate::errors::CoreError::reason(crate::errors::ErrorCode::IpcInternalError, e.to_string()))?;
        Ok(json!({
            "path": path.to_string_lossy(),
            "createdAt": created_at,
            "auditCount": audit.len(),
            "eventCount": events.len()
        }))
    }
}
