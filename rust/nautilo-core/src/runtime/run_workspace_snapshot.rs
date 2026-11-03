//! Workspace snapshot — port of runtime/run-workspace-snapshot.ts.
//! Captures a bounded text baseline so non-Git workspaces still get diffs.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::LazyLock;

const MAX_FILES: usize = 10_000;
const MAX_FILE_BYTES: u64 = 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 64 * 1024 * 1024;

static SKIPPED_DIRECTORIES: LazyLock<HashSet<&'static str>> = LazyLock::new(|| {
    [
        ".git", ".svn", ".hg", "node_modules", "vendor", "dist", "build", "out", ".next", ".nuxt", "coverage", "target", "bin",
        "obj", ".cache", ".turbo", ".pnpm-store",
    ]
    .into_iter()
    .collect()
});

static TEXT_EXTENSIONS: LazyLock<HashSet<&'static str>> = LazyLock::new(|| {
    [
        "", ".txt", ".md", ".mdx", ".json", ".jsonc", ".yaml", ".yml", ".toml", ".xml", ".html", ".htm", ".css", ".scss",
        ".sass", ".less", ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".vue", ".svelte", ".py", ".go",
        ".rs", ".java", ".kt", ".kts", ".c", ".h", ".cpp", ".hpp", ".cs", ".php", ".rb", ".sh", ".bash", ".zsh", ".fish",
        ".ps1", ".sql", ".graphql", ".gql", ".env", ".ini", ".cfg", ".conf", ".properties", ".gradle", ".swift", ".dart",
        ".lua", ".r",
    ]
    .into_iter()
    .collect()
});

pub struct WorkspaceSnapshot {
    pub root: String,
    pub files: HashMap<String, String>,
    pub truncated: bool,
    pub traversal_complete: bool,
    /// Exact paths, or directory prefixes ending in '/'.
    pub unavailable_paths: HashSet<String>,
}

pub fn capture_workspace_snapshot(root_path: &str) -> std::io::Result<WorkspaceSnapshot> {
    let root = std::fs::canonicalize(root_path).unwrap_or_else(|_| Path::new(root_path).to_path_buf());
    let mut snapshot = WorkspaceSnapshot {
        root: root.to_string_lossy().into_owned(), files: HashMap::new(), truncated: false,
        traversal_complete: true, unavailable_paths: HashSet::new(),
    };
    let mut total_bytes = 0u64;
    visit(&root, &root, &mut snapshot, &mut total_bytes);
    snapshot.traversal_complete &= !snapshot.truncated;
    Ok(snapshot)
}

fn visit(root: &Path, directory: &Path, snapshot: &mut WorkspaceSnapshot, total_bytes: &mut u64) {
    if snapshot.truncated { return; }
    let Ok(entries) = std::fs::read_dir(directory) else {
        snapshot.traversal_complete = false;
        return;
    };
    for entry in entries {
        if snapshot.truncated { break; }
        let Ok(entry) = entry else { snapshot.traversal_complete = false; continue };
        let path = entry.path();
        let relative = path.strip_prefix(root).unwrap_or(&path).to_string_lossy().replace('\\', "/");
        let Ok(file_type) = entry.file_type() else {
            snapshot.unavailable_paths.insert(relative); continue;
        };
        if file_type.is_symlink() {
            snapshot.unavailable_paths.insert(format!("{relative}/"));
            snapshot.unavailable_paths.insert(relative); continue;
        }
        if file_type.is_dir() {
            if SKIPPED_DIRECTORIES.contains(entry.file_name().to_string_lossy().as_ref()) {
                snapshot.unavailable_paths.insert(format!("{relative}/"));
            } else { visit(root, &path, snapshot, total_bytes); }
            continue;
        }
        let extension = path.extension().map(|ext| format!(".{}", ext.to_string_lossy().to_lowercase())).unwrap_or_default();
        if !file_type.is_file() || !TEXT_EXTENSIONS.contains(extension.as_str()) {
            snapshot.unavailable_paths.insert(relative); continue;
        }
        let Ok(info) = entry.metadata() else { snapshot.unavailable_paths.insert(relative); continue };
        if info.len() > MAX_FILE_BYTES { snapshot.unavailable_paths.insert(relative); continue; }
        if snapshot.files.len() >= MAX_FILES || *total_bytes + info.len() > MAX_TOTAL_BYTES {
            snapshot.truncated = true; break;
        }
        let Ok(content) = std::fs::read_to_string(&path) else { snapshot.unavailable_paths.insert(relative); continue };
        if content.contains('\0') { snapshot.unavailable_paths.insert(relative); continue; }
        *total_bytes += content.len() as u64;
        snapshot.files.insert(relative, content);
    }
}
