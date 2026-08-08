//! Work-mode artifact preview — port of application/artifact-read.ts.
//! The path must resolve inside the owning project's workspace root.

use std::path::Path;
use std::sync::{Arc, Mutex};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde_json::{json, Value};

use crate::database::{Database, Repositories};
use crate::errors::{invalid, not_found, CoreResult};

const MAX_BYTES: u64 = 20 * 1024 * 1024;

fn mime_by_ext(extension: &str) -> &'static str {
    match extension {
        ".doc" => "application/msword",
        ".docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ".xls" => "application/vnd.ms-excel",
        ".xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ".ppt" => "application/vnd.ms-powerpoint",
        ".pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        ".md" | ".markdown" => "text/markdown",
        ".py" | ".txt" => "text/plain",
        ".csv" => "text/csv",
        ".tsv" => "text/tab-separated-values",
        ".json" => "application/json",
        ".html" | ".htm" => "text/html",
        ".png" => "image/png",
        ".jpg" | ".jpeg" => "image/jpeg",
        ".gif" => "image/gif",
        ".webp" => "image/webp",
        ".svg" => "image/svg+xml",
        ".pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
}

pub fn read_workspace_artifact(db: &Arc<Mutex<Database>>, input: &Value) -> CoreResult<Value> {
    let project_id = input.get("projectId").and_then(Value::as_str).unwrap_or("");
    let project = Repositories::new(&db.lock().unwrap().raw)
        .projects()
        .get(project_id)?
        .ok_or_else(|| not_found("project", project_id))?;
    let root_path = project.get("rootPath").and_then(Value::as_str).unwrap_or("");
    let root = std::fs::canonicalize(root_path).unwrap_or_else(|_| Path::new(root_path).to_path_buf());
    let raw = input.get("path").and_then(Value::as_str).unwrap_or("");
    let candidate = if Path::new(raw).is_absolute() { Path::new(raw).to_path_buf() } else { root.join(raw) };
    // Lexical containment check, matching Node's relative() semantics.
    let relative = pathdiff(&root, &candidate);
    if relative.is_empty() || relative.starts_with("..") || Path::new(&relative).is_absolute() {
        return Err(invalid("path", "Path escapes the project workspace."));
    }
    let info = std::fs::metadata(&candidate).ok();
    let Some(info) = info.filter(|info| info.is_file()) else {
        return Err(not_found("artifact", raw));
    };
    if info.len() > MAX_BYTES {
        return Err(invalid("path", &format!("File exceeds the {}MB preview limit.", MAX_BYTES / 1024 / 1024)));
    }
    let buffer = std::fs::read(&candidate).map_err(|e| crate::errors::CoreError::reason(crate::errors::ErrorCode::IpcInternalError, e.to_string()))?;
    let modified = info
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| {
            chrono::DateTime::from_timestamp_millis(duration.as_millis() as i64)
                .map(|t| t.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
                .unwrap_or_default()
        })
        .unwrap_or_default();
    let extension = candidate
        .extension()
        .map(|ext| format!(".{}", ext.to_string_lossy().to_lowercase()))
        .unwrap_or_default();
    Ok(json!({
        "base64": BASE64.encode(&buffer),
        "mimeType": mime_by_ext(&extension),
        "size": info.len(),
        "modifiedAt": modified
    }))
}

/// Lexical relative path (Node path.relative semantics for this use case).
fn pathdiff(root: &Path, candidate: &Path) -> String {
    let normalize = |path: &Path| path.to_string_lossy().replace('\\', "/").trim_end_matches('/').to_string();
    let root_normalized = normalize(root);
    let candidate_normalized = normalize(candidate);
    if candidate_normalized == root_normalized {
        return String::new();
    }
    let prefix = format!("{root_normalized}/");
    if let Some(rest) = candidate_normalized.strip_prefix(&prefix) {
        return rest.to_string();
    }
    // Case-insensitive Windows drives: compare case-insensitively as well.
    let prefix_lower = prefix.to_lowercase();
    let candidate_lower = candidate_normalized.to_lowercase();
    if let Some(index) = candidate_lower.find(&prefix_lower) {
        if index == 0 {
            return candidate_normalized[prefix.len()..].to_string();
        }
    }
    "..".to_string()
}
