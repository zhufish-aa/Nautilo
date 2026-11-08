//! Bounded, read-only primitives for provider-owned transcript files.
//! Decoding roles, turn state, identifiers and storage roots stays in plugins.
use serde_json::Value;
use std::{
    io::Read,
    path::{Path, PathBuf},
};

pub fn file_url(path: &Path) -> Option<String> {
    url::Url::from_file_path(path)
        .ok()
        .map(|url| url.to_string())
}
pub fn valid_session_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 256
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        && id != "."
        && id != ".."
}
pub async fn read_jsonl(path: &Path) -> anyhow::Result<Vec<(u64, Value)>> {
    let path = path.to_path_buf();
    tokio::task::spawn_blocking(move || {
        let file = std::fs::File::open(path)?;
        let length = file.metadata()?.len();
        anyhow::ensure!(
            length <= 256 * 1024 * 1024,
            "Native transcript exceeds the supported read size"
        );
        let mut bytes = Vec::new();
        file.take(length).read_to_end(&mut bytes)?;
        anyhow::ensure!(
            bytes.len() as u64 == length,
            "Native transcript changed while being read; retry"
        );
        let mut entries = vec![];
        let mut offset = 0u64;
        for line in bytes.split_inclusive(|b| *b == b'\n') {
            // An append in progress may end inside a JSON string or a UTF-8
            // code point. Only committed newline-terminated records are read.
            if !line.ends_with(b"\n") {
                break;
            }
            if !line.iter().all(u8::is_ascii_whitespace) {
                entries.push((offset, serde_json::from_slice(line)?));
            }
            offset += line.len() as u64;
        }
        Ok(entries)
    })
    .await?
}
pub async fn find_session(root: &Path, id: &str, depth: usize) -> anyhow::Result<PathBuf> {
    anyhow::ensure!(valid_session_id(id), "Invalid native session identity");
    let (root, id) = (root.to_path_buf(), id.to_string());
    tokio::task::spawn_blocking(move || {
        let mut todo = vec![(root, 0)];
        let mut matches = vec![];
        let target = format!("{id}.jsonl");
        let suffix = format!("_{id}.jsonl");
        while let Some((dir, level)) = todo.pop() {
            let entries = match std::fs::read_dir(&dir) {
                Ok(entries) => entries,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(e) => return Err(e.into()),
            };
            for entry in entries {
                let entry = entry?;
                let kind = entry.file_type()?;
                if kind.is_symlink() {
                    continue;
                }
                if kind.is_dir() && level < depth {
                    todo.push((entry.path(), level + 1));
                } else if kind.is_file() {
                    let name = entry.file_name();
                    let name = name.to_string_lossy();
                    if name == target || name.ends_with(&suffix) {
                        matches.push(entry.path());
                    }
                }
            }
        }
        anyhow::ensure!(
            matches.len() == 1,
            "Expected one transcript for native session {id}, found {}",
            matches.len()
        );
        Ok(matches.remove(0))
    })
    .await?
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn partial_tail_is_not_an_entry_and_offsets_survive_appends() {
        let root = std::env::temp_dir().join(format!("native-jsonl-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("session.jsonl");
        std::fs::write(&path, b"{\"id\":\"a\"}\n{\"text\":\"").unwrap();
        let first = read_jsonl(&path).await.unwrap();
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].0, 0);
        std::fs::write(&path, b"{\"id\":\"a\"}\n{\"text\":\"done\"}\n").unwrap();
        let next = read_jsonl(&path).await.unwrap();
        assert_eq!(next[1].0, 11);
        std::fs::remove_file(path).unwrap();
        std::fs::remove_dir(root).unwrap();
    }
}
