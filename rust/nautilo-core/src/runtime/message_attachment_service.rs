//! Message attachments — port of runtime/message-attachment-service.ts.

use std::path::Path;
use std::sync::{Arc, Mutex};

use serde_json::{json, Map, Value};

use crate::database::{Database, Repositories};
use crate::errors::{CoreError, CoreResult, ErrorCode};
use crate::runtime::artifact_service::ArtifactService;

const MAX_ATTACHMENTS_PER_MESSAGE: usize = 10;
const MAX_ATTACHMENT_BYTES: u64 = 100 * 1024 * 1024;

fn invalid(field: &str, details: &[(&str, Value)]) -> CoreError {
    let mut map = Map::new();
    map.insert("field".to_string(), json!(field));
    for (key, value) in details {
        map.insert(key.to_string(), value.clone());
    }
    CoreError::details(ErrorCode::IpcInvalidRequest, map)
}

/// Validates user-selected files and persists immutable artifact references.
pub struct MessageAttachmentService {
    artifacts: ArtifactService,
}

impl MessageAttachmentService {
    pub fn new(db: Arc<Mutex<Database>>) -> Self {
        Self { artifacts: ArtifactService::new(db) }
    }

    pub fn save(&self, session: &Value, inputs: &[Value]) -> CoreResult<Vec<Value>> {
        if inputs.len() > MAX_ATTACHMENTS_PER_MESSAGE {
            return Err(invalid("attachments", &[("max", json!(MAX_ATTACHMENTS_PER_MESSAGE))]));
        }
        let mut saved = vec![];
        for input in inputs {
            let path_value = input.get("path").and_then(Value::as_str).unwrap_or("");
            if !Path::new(path_value).is_absolute() {
                return Err(invalid("attachments.path", &[("path", json!(path_value))]));
            }
            let Ok(path) = std::fs::canonicalize(path_value) else {
                return Err(invalid("attachments.path", &[("path", json!(path_value))]));
            };
            let path = path.to_string_lossy().into_owned();
            let file = std::fs::metadata(&path).map_err(|_| invalid("attachments.path", &[("path", json!(path.clone()))]))?;
            if !file.is_file() || file.len() > MAX_ATTACHMENT_BYTES {
                return Err(invalid(
                    "attachments",
                    &[("path", json!(path)), ("sizeBytes", json!(file.len())), ("maxBytes", json!(MAX_ATTACHMENT_BYTES))],
                ));
            }
            let mut metadata = Map::new();
            metadata.insert("source".to_string(), json!("user_attachment"));
            metadata.insert("sizeBytes".to_string(), json!(file.len()));
            if let Some(mime) = input.get("mimeType").and_then(Value::as_str) {
                metadata.insert("mimeType".to_string(), json!(mime));
            }
            let mut artifact_input = Map::new();
            artifact_input.insert("kind".to_string(), input.get("kind").cloned().unwrap_or_else(|| json!("file")));
            artifact_input.insert("name".to_string(), input.get("name").cloned().unwrap_or(Value::Null));
            artifact_input.insert("sessionId".to_string(), session.get("id").cloned().unwrap_or(Value::Null));
            if let Some(id) = session.get("projectRunId").cloned().filter(|v| !v.is_null()) {
                artifact_input.insert("projectRunId".to_string(), id);
            }
            if let Some(id) = session.get("taskId").cloned().filter(|v| !v.is_null()) {
                artifact_input.insert("taskId".to_string(), id);
            }
            artifact_input.insert("metadata".to_string(), Value::Object(metadata));
            saved.push(self.artifacts.save_file_reference(&Value::Object(artifact_input), &path)?);
        }
        Ok(saved)
    }
}

/// Appends the <agenthub_user_attachments> inventory to the prompt text.
pub fn append_attachment_context(text: &str, artifacts: &[Value]) -> String {
    if artifacts.is_empty() {
        return text.to_string();
    }
    let inventory = artifacts
        .iter()
        .map(|artifact| {
            let kind = artifact.get("kind").and_then(Value::as_str).unwrap_or("file");
            let name = artifact.get("name").and_then(Value::as_str).unwrap_or("");
            let path = artifact.get("path").and_then(Value::as_str).map(|p| format!(" ({p})")).unwrap_or_default();
            format!("- {kind}: {name}{path}")
        })
        .collect::<Vec<_>>()
        .join("\n");
    [
        text,
        "<agenthub_user_attachments>",
        "The user attached these local files to this message. Inspect them when relevant:",
        &inventory,
        "</agenthub_user_attachments>",
    ]
    .join("\n\n")
}
