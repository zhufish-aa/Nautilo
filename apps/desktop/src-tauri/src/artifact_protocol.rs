//! Streams only Nautilo-owned images over the custom artifact scheme;
//! arbitrary file access stays blocked. Mirrors artifact-protocol.ts.
//!
//! On Windows the `agenthub-artifact://` scheme is served by WebView2 at
//! `http://agenthub-artifact.localhost/`, so the handler only sees the query.

use std::fs::{File, Metadata};
use std::io::Read;
use std::path::{Path, PathBuf};
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
    candidate != root && candidate.starts_with(root)
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

    let (bytes, info, actual) = match read_confined_artifact(&candidate, &allowed_roots) {
        Ok(result) => result,
        Err(status) => return respond(status, "Artifact unavailable or outside allowed roots"),
    };
    // Timeline thumbnails: a 2560px screenshot decodes to ~14 MB in the
    // webview even when rendered 300 px tall; a long session pastes dozens.
    // Serve a downscaled, disk-cached JPEG instead (full image still loads in
    // the lightbox via the plain URL).
    let wants_thumb = url::form_urlencoded::parse(query.as_bytes()).any(|(key, value)| key == "thumb" && value == "1");
    if wants_thumb {
        if let Some(response) = thumbnail_response(&actual, data_dir, &bytes, &info) {
            return response;
        }
    }
    Response::builder()
            .status(StatusCode::OK)
            .header("Content-Type", guess_mime(&candidate))
            .header("X-Content-Type-Options", "nosniff")
            .body(bytes)
            .unwrap()
}

fn same_file(left: &Metadata, right: &Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        left.dev() == right.dev() && left.ino() == right.ino()
    }
    #[cfg(not(unix))]
    {
        left.len() == right.len() && left.created().ok() == right.created().ok()
            && left.modified().ok() == right.modified().ok()
    }
}

/// Authorize a canonical file and read that same opened descriptor. Rechecks
/// detect ordinary path replacement; they are not an OS sandbox against a
/// hostile same-user writer swapping ancestor directories continuously.
fn read_confined_artifact(candidate: &Path, allowed_roots: &[PathBuf]) -> Result<(Vec<u8>, Metadata, PathBuf), StatusCode> {
    let roots: Vec<PathBuf> = allowed_roots.iter().filter_map(|root| std::fs::canonicalize(root).ok()).collect();
    let actual = std::fs::canonicalize(candidate).map_err(|_| StatusCode::NOT_FOUND)?;
    if !roots.iter().any(|root| is_within(root, &actual)) { return Err(StatusCode::FORBIDDEN); }
    let candidate_info = std::fs::metadata(&actual).map_err(|_| StatusCode::NOT_FOUND)?;
    if !candidate_info.is_file() { return Err(StatusCode::NOT_FOUND); }
    let file = File::open(&actual).map_err(|_| StatusCode::NOT_FOUND)?;
    let info = file.metadata().map_err(|_| StatusCode::NOT_FOUND)?;
    if !info.is_file() { return Err(StatusCode::NOT_FOUND); }
    let validate = || -> Result<(), StatusCode> {
        let current = std::fs::canonicalize(candidate).map_err(|_| StatusCode::FORBIDDEN)?;
        let linked = std::fs::metadata(&current).map_err(|_| StatusCode::FORBIDDEN)?;
        if current != actual || !same_file(&info, &linked) { return Err(StatusCode::FORBIDDEN); }
        Ok(())
    };
    validate()?;
    let mut bytes = Vec::new();
    // Never continue reading indefinitely when a producer grows the file.
    file.take(info.len().saturating_add(1)).read_to_end(&mut bytes).map_err(|_| StatusCode::NOT_FOUND)?;
    if bytes.len() as u64 > info.len() { return Err(StatusCode::CONFLICT); }
    validate()?;
    Ok((bytes, info, actual))
}

/// Longest-edge cap for timeline thumbnails (display is ~300 px tall, hi-dpi
/// headroom included).
const THUMB_MAX_EDGE: u32 = 640;

fn thumbnail_response(path: &Path, data_dir: &Path, bytes: &[u8], info: &Metadata) -> Option<Response<Vec<u8>>> {
    let extension = path.extension().map(|e| e.to_string_lossy().to_lowercase())?;
    // gif stays passthrough (animation); svg/avif are tiny or unsupported.
    if !matches!(extension.as_str(), "png" | "jpg" | "jpeg" | "webp" | "bmp") {
        return None;
    }
    if bytes.len() < 128 * 1024 {
        return None; // already small — a re-encode would not pay off
    }
    let mtime = info.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_millis();
    let attachments = data_dir.join("attachments");
    let thumb_dir = data_dir.join("attachments").join(".thumbs");
    let thumb_path = thumb_dir.join(format!("{:x}-{:x}.jpg", fnv1a(path.to_string_lossy().as_bytes()), mtime));
    if let Ok((cached, _, _)) = read_confined_artifact(&thumb_path, &[attachments.clone()]) {
        return Some(jpeg_response(cached));
    }
    let image = image::load_from_memory(bytes).ok()?;
    if image.width() <= THUMB_MAX_EDGE && image.height() <= THUMB_MAX_EDGE {
        return None;
    }
    let thumb = image.thumbnail(THUMB_MAX_EDGE, THUMB_MAX_EDGE);
    let mut buffer = std::io::Cursor::new(Vec::new());
    thumb.write_to(&mut buffer, image::ImageFormat::Jpeg).ok()?;
    let jpeg = buffer.into_inner();
    if std::fs::create_dir_all(&thumb_dir).is_ok() {
        let root = std::fs::canonicalize(&attachments).ok();
        let directory = std::fs::canonicalize(&thumb_dir).ok();
        if root.zip(directory).is_some_and(|(root, directory)| is_within(&root, &directory)) {
            // Never truncate a cache entry replaced by a symlink.
            if let Ok(mut file) = std::fs::OpenOptions::new().write(true).create_new(true).open(&thumb_path) {
                use std::io::Write;
                let _ = file.write_all(&jpeg);
            }
        }
    }
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

    fn thumbnail(path: &Path, data_dir: &Path) -> Option<Response<Vec<u8>>> {
        let bytes = std::fs::read(path).ok()?;
        let info = std::fs::metadata(path).ok()?;
        thumbnail_response(path, data_dir, &bytes, &info)
    }

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

        let first = thumbnail(&source, &dir).expect("thumbnail expected");
        assert_eq!(first.headers().get("Content-Type").unwrap(), "image/jpeg");
        let decoded = image::load_from_memory(first.body()).unwrap();
        assert!(decoded.width() <= THUMB_MAX_EDGE && decoded.height() <= THUMB_MAX_EDGE);

        // Second call serves the disk cache (same bytes).
        let second = thumbnail(&source, &dir).expect("cached thumbnail expected");
        assert_eq!(first.body(), second.body());

        // Small images pass through untouched (None → original bytes served).
        let small = dir.join("small.png");
        image::DynamicImage::new_rgb8(64, 64).save(&small).unwrap();
        assert!(thumbnail(&small, &dir).is_none());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn protocol_reads_registered_files_and_rejects_outside_files() {
        let dir = std::env::temp_dir().join(format!("nautilo-protocol-test-{}", uuid::Uuid::new_v4()));
        let root = dir.join("workspace");
        std::fs::create_dir_all(root.join("sub")).unwrap();
        std::fs::write(root.join("..image.png"), b"inside").unwrap();
        std::fs::write(dir.join("outside.png"), b"outside").unwrap();
        assert_eq!(read_confined_artifact(&root.join("..image.png"), &[root.clone()]).unwrap().0, b"inside");
        assert!(matches!(read_confined_artifact(&dir.join("outside.png"), &[root.clone()]), Err(status) if status == StatusCode::FORBIDDEN));
        assert!(matches!(read_confined_artifact(&root.join("sub/../../outside.png"), &[root.clone()]), Err(status) if status == StatusCode::FORBIDDEN));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn protocol_and_thumbnail_cache_reject_external_symlinks() {
        use std::os::unix::fs::symlink;
        let dir = std::env::temp_dir().join(format!("nautilo-protocol-links-{}", uuid::Uuid::new_v4()));
        let root = dir.join("workspace");
        let attachments = dir.join("attachments");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(attachments.join(".thumbs")).unwrap();
        std::fs::write(root.join("image.png"), b"inside").unwrap();
        std::fs::write(dir.join("outside.png"), b"outside").unwrap();
        symlink(dir.join("outside.png"), root.join("escape.png")).unwrap();
        symlink(root.join("image.png"), root.join("inside.png")).unwrap();
        assert!(matches!(read_confined_artifact(&root.join("escape.png"), &[root.clone()]), Err(status) if status == StatusCode::FORBIDDEN));
        assert_eq!(read_confined_artifact(&root.join("inside.png"), &[root.clone()]).unwrap().0, b"inside");
        symlink(&root, dir.join("alias")).unwrap();
        assert_eq!(read_confined_artifact(&dir.join("alias/image.png"), &[root]).unwrap().0, b"inside");
        let cache = attachments.join(".thumbs/cache.jpg");
        symlink(dir.join("outside.png"), &cache).unwrap();
        assert!(matches!(read_confined_artifact(&cache, &[attachments]), Err(status) if status == StatusCode::FORBIDDEN));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
