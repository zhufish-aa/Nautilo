//! Path helpers shared across the daemon.

use std::path::{Path, PathBuf};

/// Canonicalizes like `std::fs::canonicalize` but strips the Windows
/// extended-length prefix (`\\?\`), matching Node's `fs.realpath` behavior.
/// User-facing paths (artifact records, CLI prompts, protocol checks) must
/// stay in the plain form — Node stored plain paths, and anything comparing
/// against them breaks on the verbatim prefix.
pub fn canonicalize_plain(path: &Path) -> std::io::Result<PathBuf> {
    std::fs::canonicalize(path).map(strip_verbatim_prefix)
}

pub fn strip_verbatim_prefix(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        return PathBuf::from(rest);
    }
    path
}
