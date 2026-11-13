//! Bounded resource files and atomic replacement; no sync policy or database IO.
use crate::errors::{invalid, CoreResult};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use std::path::Path;

pub(super) fn read_optional(path: &Path) -> CoreResult<Option<String>> {
    match std::fs::metadata(path) {
        Ok(m) => {
            if m.len() > 4 * 1024 * 1024 {
                return Err(invalid("path", "Native config exceeds 4 MiB"));
            }
            std::fs::read_to_string(path)
                .map(Some)
                .map_err(|e| invalid("path", &e.to_string()))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(invalid("path", &e.to_string())),
    }
}
pub(super) fn read_encoded(path: &Path, binary: bool) -> CoreResult<Option<String>> {
    if !binary {
        return read_optional(path);
    }
    match std::fs::metadata(path) {
        Ok(m) => {
            if m.len() > 4 * 1024 * 1024 {
                return Err(invalid("path", "Resource exceeds 4 MiB"));
            }
            Ok(Some(BASE64.encode(
                std::fs::read(path).map_err(|e| invalid("path", &e.to_string()))?,
            )))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(invalid("path", &e.to_string())),
    }
}
pub(super) fn atomic_write(path: &Path, text: Option<&str>, binary: bool) -> CoreResult<()> {
    if let Some(text) = text {
        let parent = path
            .parent()
            .ok_or_else(|| invalid("path", "Invalid resource directory"))?;
        std::fs::create_dir_all(parent).map_err(|e| invalid("path", &e.to_string()))?;
        let temp = parent.join(format!(".nautilo-sync-{}.tmp", uuid::Uuid::new_v4()));
        let bytes = if binary {
            BASE64
                .decode(text)
                .map_err(|e| invalid("backup", &e.to_string()))?
        } else {
            text.as_bytes().to_vec()
        };
        std::fs::write(&temp, bytes).map_err(|e| invalid("path", &e.to_string()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&temp, std::fs::Permissions::from_mode(0o600))
                .map_err(|e| invalid("path", &e.to_string()))?;
        }
        if let Err(e) = std::fs::rename(&temp, path) {
            let _ = std::fs::remove_file(&temp);
            return Err(invalid("path", &e.to_string()));
        }
    } else if path.exists() {
        std::fs::remove_file(path).map_err(|e| invalid("path", &e.to_string()))?;
    }
    Ok(())
}
pub(super) fn bundle(root: &Path) -> CoreResult<Vec<(String, String)>> {
    fn walk(
        root: &Path,
        dir: &Path,
        depth: usize,
        files: &mut Vec<(String, String)>,
        bytes: &mut u64,
    ) -> CoreResult<()> {
        if depth > 12 {
            return Err(invalid("resources", "Skill nesting limit exceeded"));
        }
        for e in std::fs::read_dir(dir).map_err(|e| invalid("resources", &e.to_string()))? {
            let e = e.map_err(|e| invalid("resources", &e.to_string()))?;
            let name = e.file_name().to_string_lossy().into_owned();
            if [".git", "node_modules", ".DS_Store"].contains(&name.as_str())
                || name.starts_with(".nautilo-")
            {
                continue;
            }
            let ty = e
                .file_type()
                .map_err(|e| invalid("resources", &e.to_string()))?;
            if ty.is_symlink() {
                return Err(invalid(
                    "resources",
                    "Skill resources contain a symbolic link; choose an explicit local copy",
                ));
            }
            let path = e.path();
            if ty.is_dir() {
                walk(root, &path, depth + 1, files, bytes)?;
            } else if ty.is_file() {
                let relative = path
                    .strip_prefix(root)
                    .map_err(|_| invalid("resources", "Resource escapes its source directory"))?
                    .to_string_lossy()
                    .into_owned();
                if relative.eq_ignore_ascii_case("SKILL.md") {
                    continue;
                }
                let size = e
                    .metadata()
                    .map_err(|e| invalid("resources", &e.to_string()))?
                    .len();
                if size > 4 * 1024 * 1024 || *bytes + size > 8 * 1024 * 1024 || files.len() >= 200 {
                    return Err(invalid(
                        "resources",
                        "Skill bundle exceeds its file or size limit",
                    ));
                }
                *bytes += size;
                files.push((
                    relative,
                    BASE64.encode(
                        std::fs::read(&path).map_err(|e| invalid("resources", &e.to_string()))?,
                    ),
                ));
            }
        }
        Ok(())
    }
    let mut files = vec![];
    walk(root, root, 0, &mut files, &mut 0)?;
    Ok(files)
}
