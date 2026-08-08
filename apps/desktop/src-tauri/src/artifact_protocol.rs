//! Streams only Nautilo-owned images over the custom artifact scheme;
//! arbitrary file access stays blocked. Mirrors artifact-protocol.ts.
//!
//! On Windows the `agenthub-artifact://` scheme is served by WebView2 at
//! `http://agenthub-artifact.localhost/`, so the handler only sees the query.

use std::path::{Component, Path, PathBuf};
use std::sync::RwLock;
use tauri::http::{Request, Response, StatusCode};

/// Project roots the daemon has registered; refreshed in the background so
/// artifact URLs can stream generated files from workspace directories.
pub struct WorkspaceRoots {
    roots: RwLock<Vec<PathBuf>>,
}

impl WorkspaceRoots {
    pub fn new() -> Self {
        Self {
            roots: RwLock::new(Vec::new()),
        }
    }

    pub fn replace(&self, roots: Vec<PathBuf>) {
        if let Ok(mut guard) = self.roots.write() {
            *guard = roots;
        }
    }

    fn snapshot(&self) -> Vec<PathBuf> {
        self.roots.read().map(|r| r.clone()).unwrap_or_default()
    }
}

fn is_within(root: &Path, candidate: &Path) -> bool {
    match candidate.strip_prefix(root) {
        Ok(rel) => !rel.components().any(|c| matches!(c, Component::ParentDir)),
        Err(_) => false,
    }
}

fn guess_mime(path: &Path) -> &'static str {
    match path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .as_deref()
    {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("bmp") => "image/bmp",
        Some("svg") => "image/svg+xml",
        Some("avif") => "image/avif",
        Some("mp4") => "video/mp4",
        Some("webm") => "video/webm",
        Some("mp3") => "audio/mpeg",
        Some("wav") => "audio/wav",
        Some("pdf") => "application/pdf",
        _ => "application/octet-stream",
    }
}

fn respond(status: StatusCode, body: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header("Content-Type", "text/plain; charset=utf-8")
        .body(body.as_bytes().to_vec())
        .unwrap()
}

pub fn handle(request: Request<Vec<u8>>, data_dir: &Path, workspace_roots: &WorkspaceRoots) -> Response<Vec<u8>> {
    let query = request.uri().query().unwrap_or("");
    let requested = url::form_urlencoded::parse(query.as_bytes())
        .find(|(key, _)| key == "path")
        .map(|(_, value)| value.to_string());
    let Some(requested) = requested else {
        return respond(StatusCode::BAD_REQUEST, "Missing artifact path");
    };
    // Older artifact records may carry canonicalized `\\?\`-prefixed paths;
    // normalize so containment checks compare like with like.
    let requested = requested
        .strip_prefix(r"\\?\UNC\")
        .map(|rest| format!(r"\\{rest}"))
        .or_else(|| requested.strip_prefix(r"\\?\").map(str::to_string))
        .unwrap_or(requested);
    let candidate = PathBuf::from(&requested);

    let mut allowed_roots = Vec::new();
    if let Some(home) = dirs::home_dir() {
        allowed_roots.push(home.join(".codex").join("generated_images"));
    }
    allowed_roots.push(data_dir.join("attachments"));
    allowed_roots.extend(workspace_roots.snapshot());

    if !allowed_roots.iter().any(|root| is_within(root, &candidate)) {
        return respond(StatusCode::FORBIDDEN, "Forbidden");
    }
    match std::fs::read(&candidate) {
        Ok(bytes) => Response::builder()
            .status(StatusCode::OK)
            .header("Content-Type", guess_mime(&candidate))
            .body(bytes)
            .unwrap(),
        Err(_) => respond(StatusCode::NOT_FOUND, "Artifact not found"),
    }
}
