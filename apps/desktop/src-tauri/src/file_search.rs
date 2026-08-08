//! Bounded fallback search for chat file references that did not resolve
//! directly against the project root. Mirrors apps/desktop/src/main/file-search.ts.

use std::fs;
use std::path::{Path, PathBuf};

/// Directories that never contain user code worth searching.
const SKIP_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    "dist",
    "out",
    "release",
    "coverage",
    "build",
    ".idea",
    ".vscode",
    ".next",
    ".nuxt",
    ".turbo",
    ".cache",
    ".parcel-cache",
    "target",
    "__pycache__",
    ".pytest_cache",
    ".svn",
    ".hg",
    "vendor",
    "tmp",
    "temp",
];

const MAX_DEPTH: u32 = 8;
const MAX_MATCHES: usize = 50;

/// Bare filenames match by basename (case-insensitive); partial relative paths
/// match by path suffix. Runs on demand, never builds an index.
pub fn search_file_references(query_path: &str, base_paths: &[String]) -> Vec<String> {
    let query = query_path.replace('\\', "/").to_lowercase();
    let query = query.strip_prefix("./").unwrap_or(&query).to_string();
    if query.is_empty() {
        return Vec::new();
    }
    let bare = !query.contains('/');
    let mut matches: Vec<String> = Vec::new();
    let mut seen_bases = std::collections::HashSet::new();
    for base in base_paths {
        if !seen_bases.insert(base.clone()) {
            continue;
        }
        walk(Path::new(base), 0, &query, bare, &mut matches);
        if matches.len() >= MAX_MATCHES {
            break;
        }
    }
    matches
}

fn walk(dir: &Path, depth: u32, query: &str, bare: bool, matches: &mut Vec<String>) {
    if depth > MAX_DEPTH || matches.len() >= MAX_MATCHES {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return; // Unreadable directory — skip silently.
    };
    for entry in entries.flatten() {
        if matches.len() >= MAX_MATCHES {
            return;
        }
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_symlink() {
            continue; // Avoid link loops.
        }
        let full: PathBuf = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if file_type.is_dir() {
            if !SKIP_DIRS.contains(&name.as_str()) {
                walk(&full, depth + 1, query, bare, matches);
            }
        } else if file_type.is_file() {
            if bare {
                if name.to_lowercase() == query {
                    matches.push(full.to_string_lossy().to_string());
                }
            } else {
                let candidate = full.to_string_lossy().replace('\\', "/").to_lowercase();
                if candidate.ends_with(query)
                    && (candidate.len() == query.len()
                        || candidate.as_bytes()[candidate.len() - query.len() - 1] == b'/')
                {
                    matches.push(full.to_string_lossy().to_string());
                }
            }
        }
    }
}
