//! Work-mode artifact preview — port of application/artifact-read.ts.
//! The path must resolve inside the owning project's workspace root.

use std::fs::{File, Metadata};
use std::io::Read;
use std::path::{Component, Path, PathBuf};
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
    let raw = input.get("path").and_then(Value::as_str).unwrap_or("");
    let (buffer, info, candidate) = read_confined_file(Path::new(root_path), raw)?;
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
        "size": buffer.len(),
        "modifiedAt": modified
    }))
}

fn escaped() -> crate::errors::CoreError {
    invalid("path", "Path escapes the project workspace or changed while opening.")
}

fn too_large() -> crate::errors::CoreError {
    invalid("path", &format!("File exceeds the {}MB preview limit.", MAX_BYTES / 1024 / 1024))
}

fn inside(root: &Path, candidate: &Path) -> bool {
    candidate != root && candidate.starts_with(root)
}

fn normalize_lexical(path: &Path) -> CoreResult<PathBuf> {
    let mut result = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !result.pop() { return Err(escaped()); }
            }
            other => result.push(other.as_os_str()),
        }
    }
    Ok(result)
}

fn same_file(left: &Metadata, right: &Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        left.dev() == right.dev() && left.ino() == right.ino()
    }
    #[cfg(not(unix))]
    {
        // Portable metadata does not expose Windows file IDs. These checks
        // catch ordinary replacement races, not malicious same-user writers.
        left.len() == right.len() && left.created().ok() == right.created().ok()
            && left.modified().ok() == right.modified().ok()
    }
}

fn read_confined_file(root_path: &Path, raw: &str) -> CoreResult<(Vec<u8>, Metadata, PathBuf)> {
    let root = crate::paths::canonicalize_plain(root_path).map_err(|_| not_found("artifact", raw))?;
    let input = if Path::new(raw).is_absolute() { PathBuf::from(raw) } else { root.join(raw) };
    let candidate = normalize_lexical(&crate::paths::strip_verbatim_prefix(input))?;
    let actual = crate::paths::canonicalize_plain(&candidate).map_err(|_| {
        if inside(&root, &candidate) || inside(root_path, &candidate) { not_found("artifact", raw) } else { escaped() }
    })?;
    if !inside(&root, &actual) { return Err(escaped()); }
    // Refuse special files before open (opening a FIFO can otherwise block).
    let candidate_info = std::fs::metadata(&actual).map_err(|_| not_found("artifact", raw))?;
    if !candidate_info.is_file() { return Err(not_found("artifact", raw)); }
    let file = File::open(&actual).map_err(|_| not_found("artifact", raw))?;
    let info = file.metadata().map_err(|_| not_found("artifact", raw))?;
    if !info.is_file() { return Err(not_found("artifact", raw)); }
    let validate_opened_path = || -> CoreResult<()> {
        let current = crate::paths::canonicalize_plain(&candidate).map_err(|_| escaped())?;
        if current != actual || !inside(&root, &current) { return Err(escaped()); }
        let linked = std::fs::metadata(&current).map_err(|_| escaped())?;
        if !same_file(&info, &linked) { return Err(escaped()); }
        Ok(())
    };
    validate_opened_path()?;
    if info.len() > MAX_BYTES { return Err(too_large()); }
    // The same handle supplies both metadata and bytes. Cap reads even when
    // an agent grows the file concurrently, instead of reading it all first.
    let mut buffer = Vec::new();
    file.take(MAX_BYTES + 1).read_to_end(&mut buffer)
        .map_err(|e| crate::errors::CoreError::reason(crate::errors::ErrorCode::IpcInternalError, e.to_string()))?;
    if buffer.len() as u64 > MAX_BYTES { return Err(too_large()); }
    validate_opened_path()?;
    Ok((buffer, info, candidate))
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("nautilo-artifact-boundary-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(path.join("workspace/sub")).unwrap();
            Self(path)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); }
    }

    #[test]
    fn reads_legal_files_but_rejects_nested_parent_traversal() {
        let fixture = Fixture::new();
        let root = fixture.0.join("workspace");
        std::fs::write(fixture.0.join("outside.txt"), b"outside").unwrap();
        for name in ["report.txt", "..report.txt"] {
            std::fs::write(root.join(name), b"inside").unwrap();
            for path in [name.to_string(), format!("sub/../{name}"), root.join(name).to_string_lossy().into_owned()] {
                assert_eq!(read_confined_file(&root, &path).unwrap().0, b"inside");
            }
        }
        for path in ["../outside.txt", "sub/../../outside.txt", "."] {
            assert!(read_confined_file(&root, path).is_err(), "accepted {path}");
        }
        assert!(read_confined_file(&root, &fixture.0.join("outside.txt").to_string_lossy()).is_err());
    }

    #[test]
    fn rejects_oversized_files_before_reading() {
        let fixture = Fixture::new();
        let root = fixture.0.join("workspace");
        File::create(root.join("large.txt")).unwrap().set_len(MAX_BYTES + 1).unwrap();
        assert!(read_confined_file(&root, "large.txt").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_must_resolve_inside_root_and_file_identity_detects_replacement() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        let root = fixture.0.join("workspace");
        let path = root.join("report.txt");
        std::fs::write(&path, b"inside").unwrap();
        std::fs::write(fixture.0.join("outside.txt"), b"outside").unwrap();
        symlink(fixture.0.join("outside.txt"), root.join("escape.txt")).unwrap();
        symlink(&path, root.join("linked.txt")).unwrap();
        assert!(read_confined_file(&root, "escape.txt").is_err());
        assert_eq!(read_confined_file(&root, "linked.txt").unwrap().0, b"inside");
        let alias = fixture.0.join("workspace-alias");
        symlink(&root, &alias).unwrap();
        for input in ["report.txt".to_string(), alias.join("report.txt").to_string_lossy().into_owned(), path.to_string_lossy().into_owned()] {
            assert_eq!(read_confined_file(&alias, &input).unwrap().0, b"inside");
        }
        let opened = File::open(&path).unwrap();
        std::fs::rename(&path, root.join("old.txt")).unwrap();
        std::fs::write(&path, b"inside").unwrap();
        assert!(!same_file(&opened.metadata().unwrap(), &std::fs::metadata(&path).unwrap()));
    }
}
