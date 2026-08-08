//! Changed-path policy — port of runtime/git/path-policy.ts.

use std::path::{Path, PathBuf};

/// Returns the changed paths that violate the policy (empty = all allowed).
pub fn validate(workspace_path: &str, changed_paths: &[String], allowed_patterns: &[String]) -> Vec<String> {
    let root = std::fs::canonicalize(workspace_path).unwrap_or_else(|_| Path::new(workspace_path).to_path_buf());
    changed_paths
        .iter()
        .filter(|relative_path| {
            let normalized = relative_path.replace('\\', "/");
            let normalized = normalized.strip_prefix("./").unwrap_or(&normalized).to_string();
            if normalized.is_empty()
                || normalized == ".git"
                || normalized.starts_with(".git/")
                || normalized.split('/').any(|part| part == "..")
            {
                return true;
            }
            let absolute = root.join(&normalized);
            if absolute != root && !absolute.starts_with(&root) {
                return true;
            }
            let existing = nearest_existing_path(&absolute, &root);
            let actual = std::fs::canonicalize(&existing).unwrap_or(existing);
            if actual != root && !actual.starts_with(&root) {
                return true;
            }
            !allowed_patterns.is_empty() && !allowed_patterns.iter().any(|pattern| glob(pattern, &normalized))
        })
        .cloned()
        .collect()
}

fn nearest_existing_path(path: &Path, root: &Path) -> PathBuf {
    let mut current = path.to_path_buf();
    while !current.exists() && current != root {
        if !current.pop() {
            break;
        }
    }
    current
}

fn glob(pattern: &str, value: &str) -> bool {
    let normalized = pattern.replace('\\', "/");
    let normalized = normalized.strip_prefix("./").unwrap_or(&normalized);
    let mut source = String::new();
    let mut chars = normalized.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '*' => {
                if chars.peek() == Some(&'*') {
                    chars.next();
                    source.push_str(".*");
                } else {
                    source.push_str("[^/]*");
                }
            }
            '?' => source.push_str("[^/]"),
            '.' | '+' | '^' | '$' | '{' | '}' | '(' | ')' | '|' | '[' | ']' | '\\' => {
                source.push('\\');
                source.push(ch);
            }
            other => source.push(other),
        }
    }
    regex::Regex::new(&format!("^{source}$")).map(|re| re.is_match(value)).unwrap_or(false)
}
