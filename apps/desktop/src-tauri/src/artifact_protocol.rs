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
    // Timeline thumbnails: a 2560px screenshot decodes to ~14 MB in the
    // webview even when rendered 300 px tall; a long session pastes dozens.
    // Serve a downscaled, disk-cached JPEG instead (full image still loads in
    // the lightbox via the plain URL).
    let wants_thumb = url::form_urlencoded::parse(query.as_bytes()).any(|(key, value)| key == "thumb" && value == "1");
    if wants_thumb {
        if let Some(response) = thumbnail_response(&candidate, data_dir) {
            return response;
        }
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

/// Longest-edge cap for timeline thumbnails (display is ~300 px tall, hi-dpi
/// headroom included).
const THUMB_MAX_EDGE: u32 = 640;

fn thumbnail_response(path: &Path, data_dir: &Path) -> Option<Response<Vec<u8>>> {
    let extension = path.extension().map(|e| e.to_string_lossy().to_lowercase())?;
    // gif stays passthrough (animation); svg/avif are tiny or unsupported.
    if !matches!(extension.as_str(), "png" | "jpg" | "jpeg" | "webp" | "bmp") {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    if bytes.len() < 128 * 1024 {
        return None; // already small — a re-encode would not pay off
    }
    let mtime = std::fs::metadata(path).and_then(|m| m.modified()).ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_millis();
    let thumb_dir = data_dir.join("attachments").join(".thumbs");
    let thumb_path = thumb_dir.join(format!("{:x}-{:x}.jpg", fnv1a(path.to_string_lossy().as_bytes()), mtime));
    if let Some(cached) = std::fs::read(&thumb_path).ok() {
        return Some(jpeg_response(cached));
    }
    let image = image::load_from_memory(&bytes).ok()?;
    if image.width() <= THUMB_MAX_EDGE && image.height() <= THUMB_MAX_EDGE {
        return None;
    }
    let thumb = image.thumbnail(THUMB_MAX_EDGE, THUMB_MAX_EDGE);
    let mut buffer = std::io::Cursor::new(Vec::new());
    thumb.write_to(&mut buffer, image::ImageFormat::Jpeg).ok()?;
    let jpeg = buffer.into_inner();
    let _ = std::fs::create_dir_all(&thumb_dir);
    let _ = std::fs::write(&thumb_path, &jpeg);
    Some(jpeg_response(jpeg))
}

fn jpeg_response(bytes: Vec<u8>) -> Response<Vec<u8>> {
    Response::builder()
        .status(StatusCode::OK)
        .header("Content-Type", "image/jpeg")
        .header("Cache-Control", "public, max-age=31536000, immutable")
        .body(bytes)
        .unwrap()
}

fn fnv1a(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thumbnail_downscales_large_images_and_caches() {
        let dir = std::env::temp_dir().join(format!("nautilo-thumb-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let source = dir.join("big.png");
        // Random pixels: a solid-color PNG compresses below the size floor
        // and would legitimately skip thumbnailing.
        let mut pixels = vec![0u8; 2560 * 1400 * 3];
        let mut seed: u64 = 42;
        for byte in pixels.iter_mut() {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            *byte = (seed >> 33) as u8;
        }
        let image = image::DynamicImage::ImageRgb8(image::ImageBuffer::from_raw(2560, 1400, pixels).unwrap());
        image.save(&source).unwrap();

        let first = thumbnail_response(&source, &dir).expect("thumbnail expected");
        assert_eq!(first.headers().get("Content-Type").unwrap(), "image/jpeg");
        let decoded = image::load_from_memory(first.body()).unwrap();
        assert!(decoded.width() <= THUMB_MAX_EDGE && decoded.height() <= THUMB_MAX_EDGE);

        // Second call serves the disk cache (same bytes).
        let second = thumbnail_response(&source, &dir).expect("cached thumbnail expected");
        assert_eq!(first.body(), second.body());

        // Small images pass through untouched (None → original bytes served).
        let small = dir.join("small.png");
        image::DynamicImage::new_rgb8(64, 64).save(&small).unwrap();
        assert!(thumbnail_response(&small, &dir).is_none());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
