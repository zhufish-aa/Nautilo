//! Workspace snapshot — port of runtime/run-workspace-snapshot.ts.
//! Captures a bounded text baseline so non-Git workspaces still get diffs.

use std::collections::{HashMap, HashSet};
use std::path::Path;

const MAX_FILES: usize = 10_000;
const MAX_FILE_BYTES: u64 = 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 64 * 1024 * 1024;

fn skipped_directories() -> HashSet<&'static str> {
    [
        ".git", ".svn", ".hg", "node_modules", "vendor", "dist", "build", "out", ".next", ".nuxt", "coverage", "target", "bin",
        "obj", ".cache", ".turbo", ".pnpm-store",
    ]
    .into_iter()
    .collect()
}

fn text_extensions() -> HashSet<&'static str> {
    [
        "", ".txt", ".md", ".mdx", ".json", ".jsonc", ".yaml", ".yml", ".toml", ".xml", ".html", ".htm", ".css", ".scss",
        ".sass", ".less", ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".vue", ".svelte", ".py", ".go",
        ".rs", ".java", ".kt", ".kts", ".c", ".h", ".cpp", ".hpp", ".cs", ".php", ".rb", ".sh", ".bash", ".zsh", ".fish",
        ".ps1", ".sql", ".graphql", ".gql", ".env", ".ini", ".cfg", ".conf", ".properties", ".gradle", ".swift", ".dart",
        ".lua", ".r",
    ]
    .into_iter()
    .collect()
}

pub struct WorkspaceSnapshot {
    pub root: String,
    pub files: HashMap<String, String>,
    pub truncated: bool,
}

pub fn capture_workspace_snapshot(root_path: &str) -> std::io::Result<WorkspaceSnapshot> {
    let root = std::fs::canonicalize(root_path).unwrap_or_else(|_| Path::new(root_path).to_path_buf());
    let mut files = HashMap::new();
    let mut total_bytes = 0u64;
    let mut truncated = false;
    visit(&root, &root, &mut files, &mut total_bytes, &mut truncated);
    Ok(WorkspaceSnapshot { root: root.to_string_lossy().into_owned(), files, truncated })
}

fn visit(
    root: &Path,
    directory: &Path,
    files: &mut HashMap<String, String>,
    total_bytes: &mut u64,
    truncated: &mut bool,
) {
    if *truncated {
        return;
    }
    let Ok(entries) = std::fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        if *truncated {
            break;
        }
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else { continue };
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            let name = entry.file_name();
            if !skipped_directories().contains(name.to_string_lossy().as_ref()) {
                visit(root, &path, files, total_bytes, truncated);
            }
            continue;
        }
        if !file_type.is_file() {
            continue;
        }
        let extension = path
            .extension()
            .map(|ext| format!(".{}", ext.to_string_lossy().to_lowercase()))
            .unwrap_or_default();
        if !text_extensions().contains(extension.as_str()) {
            continue;
        }
        let Ok(info) = entry.metadata() else { continue };
        if info.len() > MAX_FILE_BYTES {
            continue;
        }
        if files.len() >= MAX_FILES || *total_bytes + info.len() > MAX_TOTAL_BYTES {
            *truncated = true;
            break;
        }
        let Ok(content) = std::fs::read_to_string(&path) else { continue };
        if content.contains('\0') {
            continue;
        }
        let relative = path
            .strip_prefix(root)
            .map(|r| r.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|_| path.to_string_lossy().replace('\\', "/"));
        *total_bytes += content.len() as u64;
        files.insert(relative, content);
    }
}
