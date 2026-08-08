//! Attachment staging for picked/dropped/clipboard files.
//! Mirrors apps/desktop/src/main/attachment-file-service.ts.

use serde::Serialize;
use std::fs;
use std::path::{Component, Path, PathBuf};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopAttachment {
    pub path: String,
    pub name: String,
    pub kind: &'static str, // "image" | "file"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    pub size_bytes: u64,
}

const MAX_CLIPBOARD_BYTES: usize = 32 * 1024 * 1024;

fn is_absolute(path: &str) -> bool {
    let p = Path::new(path);
    p.is_absolute() || path.starts_with("\\\\")
}

fn is_within(root: &Path, candidate: &Path) -> bool {
    let relative = candidate.strip_prefix(root);
    match relative {
        Ok(rel) => !rel
            .components()
            .any(|c| matches!(c, Component::ParentDir)),
        Err(_) => false,
    }
}

pub fn describe_attachment_paths(paths: &[String]) -> Result<Vec<DesktopAttachment>, String> {
    paths
        .iter()
        .map(|path| {
            let file = fs::metadata(path).map_err(|e| format!("Attachment is not a file: {path} ({e})"))?;
            if !file.is_file() {
                return Err(format!("Attachment is not a file: {path}"));
            }
            let name = Path::new(path)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            let mime_type = infer_mime_type(&name);
            let kind = if mime_type.as_deref().map(|m| m.starts_with("image/")).unwrap_or(false) {
                "image"
            } else {
                "file"
            };
            Ok(DesktopAttachment {
                path: path.clone(),
                name,
                kind,
                mime_type,
                size_bytes: file.len(),
            })
        })
        .collect()
}

/// Copies previewable images into app-owned storage; large non-images stay
/// path references.
pub fn prepare_attachment_paths(data_dir: &Path, paths: &[String]) -> Result<Vec<DesktopAttachment>, String> {
    let described = describe_attachment_paths(paths)?;
    let directory = data_dir.join("attachments").join("selected");
    fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let attachments_root = data_dir.join("attachments");
    described
        .into_iter()
        .map(|mut attachment| {
            let source = PathBuf::from(&attachment.path);
            if attachment.kind != "image" || is_within(&attachments_root, &source) {
                return Ok(attachment);
            }
            let extension = Path::new(&attachment.name)
                .extension()
                .map(|e| format!(".{}", e.to_string_lossy()))
                .unwrap_or_default();
            let extension: String = extension.chars().take(16).collect();
            let path = directory.join(format!("{}{}", uuid::Uuid::new_v4(), extension));
            fs::copy(&source, &path).map_err(|e| e.to_string())?;
            attachment.path = path.to_string_lossy().to_string();
            Ok(attachment)
        })
        .collect()
}

/// Stores clipboard-only blobs once so Core can pass a stable path to CLIs.
pub fn import_clipboard_attachment(
    data_dir: &Path,
    name: &str,
    mime_type: Option<&str>,
    data: &[u8],
) -> Result<DesktopAttachment, String> {
    if data.is_empty() || data.len() > MAX_CLIPBOARD_BYTES {
        return Err(format!(
            "Clipboard attachment must be between 1 byte and {MAX_CLIPBOARD_BYTES} bytes"
        ));
    }
    let original_extension: String = Path::new(name)
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default()
        .chars()
        .take(16)
        .collect();
    let extension = if original_extension.is_empty() {
        extension_for_mime(mime_type)
    } else {
        original_extension
    };
    let directory = data_dir.join("attachments").join("clipboard");
    fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let path = directory.join(format!("{}{}", uuid::Uuid::new_v4(), extension));
    fs::write(&path, data).map_err(|e| e.to_string())?;
    let resolved_mime = mime_type.map(|m| m.to_string()).or_else(|| infer_mime_type(name));
    let kind = if resolved_mime.as_deref().map(|m| m.starts_with("image/")).unwrap_or(false) {
        "image"
    } else {
        "file"
    };
    Ok(DesktopAttachment {
        path: path.to_string_lossy().to_string(),
        name: if name.is_empty() {
            format!("clipboard{extension}")
        } else {
            name.to_string()
        },
        kind,
        mime_type: resolved_mime,
        size_bytes: data.len() as u64,
    })
}

fn infer_mime_type(name: &str) -> Option<String> {
    let extension = Path::new(name).extension()?.to_string_lossy().to_lowercase();
    let known = match extension.as_str() {
        ".png" => "image/png",
        ".jpg" | ".jpeg" => "image/jpeg",
        ".gif" => "image/gif",
        ".webp" => "image/webp",
        ".bmp" => "image/bmp",
        ".svg" => "image/svg+xml",
        ".avif" => "image/avif",
        ".pdf" => "application/pdf",
        ".json" => "application/json",
        ".txt" => "text/plain",
        ".md" => "text/markdown",
        ".csv" => "text/csv",
        ".html" => "text/html",
        ".ts" | ".tsx" => "text/typescript",
        ".js" | ".jsx" => "text/javascript",
        _ => return None,
    };
    Some(known.to_string())
}

fn extension_for_mime(mime_type: Option<&str>) -> String {
    let extension = match mime_type {
        Some("image/png") => ".png",
        Some("image/jpeg") => ".jpg",
        Some("image/gif") => ".gif",
        Some("image/webp") => ".webp",
        Some("image/bmp") => ".bmp",
        Some("image/svg+xml") => ".svg",
        Some("application/pdf") => ".pdf",
        Some("text/plain") => ".txt",
        _ => "",
    };
    extension.to_string()
}

/// Windows paths only need the is-absolute check for write/delete guards.
pub fn require_absolute(path: &str) -> Result<(), String> {
    if is_absolute(path) {
        Ok(())
    } else {
        Err("not-absolute".to_string())
    }
}
