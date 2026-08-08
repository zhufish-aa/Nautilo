//! Artifact persistence — port of runtime/artifact-service.ts.

use std::sync::{Arc, Mutex};

use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::database::{Database, Repositories};
use crate::errors::{now_iso, CoreResult};

pub struct ArtifactService {
    db: Arc<Mutex<Database>>,
}

impl ArtifactService {
    pub fn new(db: Arc<Mutex<Database>>) -> Self {
        Self { db }
    }

    /// Stores an inline-content artifact (diffs, generated payloads).
    pub fn save(&self, input: &Value, content: &str) -> CoreResult<Value> {
        let mut artifact = input.as_object().cloned().unwrap_or_default();
        artifact.insert("id".to_string(), json!(Uuid::new_v4().to_string()));
        artifact.insert("contentHash".to_string(), json!(format!("{:x}", Sha256::digest(content.as_bytes()))));
        artifact.insert("content".to_string(), json!(content));
        let artifact = Value::Object(artifact);
        let size = content.len() as i64;
        let now = now_iso();
        Repositories::new(&self.db.lock().unwrap().raw).artifacts().save(&artifact, Some(&now), size)?;
        Ok(artifact)
    }

    /// Stores a file-reference artifact, hashing the file's content.
    pub fn save_file_reference(&self, input: &Value, path: &str) -> CoreResult<Value> {
        let content_hash = hash_file(path)?;
        let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0) as i64;
        let mut artifact = input.as_object().cloned().unwrap_or_default();
        artifact.insert("id".to_string(), json!(Uuid::new_v4().to_string()));
        artifact.insert("contentHash".to_string(), json!(content_hash));
        artifact.insert("path".to_string(), json!(path));
        let artifact = Value::Object(artifact);
        let now = now_iso();
        Repositories::new(&self.db.lock().unwrap().raw).artifacts().save(&artifact, Some(&now), size)?;
        Ok(artifact)
    }
}

fn hash_file(path: &str) -> CoreResult<String> {
    let bytes = std::fs::read(path).unwrap_or_default();
    Ok(format!("{:x}", Sha256::digest(&bytes)))
}

/// Builds the artifact JSON shared by save paths (callers fill kind/name/ids).
pub fn artifact_input(
    kind: &str,
    name: &str,
    project_run_id: Option<&str>,
    task_id: Option<&str>,
    session_id: Option<&str>,
    metadata: Option<Value>,
) -> Value {
    let mut artifact = Map::new();
    artifact.insert("kind".to_string(), json!(kind));
    artifact.insert("name".to_string(), json!(name));
    if let Some(id) = project_run_id {
        artifact.insert("projectRunId".to_string(), json!(id));
    }
    if let Some(id) = task_id {
        artifact.insert("taskId".to_string(), json!(id));
    }
    if let Some(id) = session_id {
        artifact.insert("sessionId".to_string(), json!(id));
    }
    if let Some(metadata) = metadata {
        artifact.insert("metadata".to_string(), metadata);
    }
    Value::Object(artifact)
}
