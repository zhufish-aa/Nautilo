//! Bounded, resumable phone uploads. Phones send opaque IDs, never desktop paths.
use anyhow::{ensure, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{fs, io::{Read, Seek, SeekFrom, Write}, path::PathBuf, sync::Mutex};

const MAX_FILE_BYTES: u64 = 20 * 1024 * 1024;
const MAX_CHUNK_BYTES: usize = 128 * 1024;

#[derive(Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Metadata { name: String, mime_type: String, size_bytes: u64 }

pub(super) struct RemoteAttachments { root: PathBuf, lock: Mutex<()> }
impl RemoteAttachments {
    pub fn new(root: PathBuf) -> Self { Self { root, lock: Mutex::new(()) } }
    fn directory(&self, peer: &str, id: &str) -> Result<PathBuf> {
        let parsed = uuid::Uuid::parse_str(id).map_err(|_| anyhow::anyhow!("INVALID_ATTACHMENT"))?;
        ensure!(parsed.to_string() == id, "INVALID_ATTACHMENT");
        Ok(self.root.join(format!("{:x}", Sha256::digest(peer.as_bytes()))).join(id))
    }
    pub fn upload(&self, peer: &str, input: &Value) -> Result<Value> {
        let _guard = self.lock.lock().unwrap();
        let id = input["uploadId"].as_str().ok_or_else(|| anyhow::anyhow!("INVALID_ATTACHMENT"))?;
        let directory = self.directory(peer, id)?;
        let name = input["name"].as_str().filter(|s| !s.is_empty() && s.len() <= 512).ok_or_else(|| anyhow::anyhow!("INVALID_ATTACHMENT"))?;
        let mime = input["mimeType"].as_str().filter(|s| s.len() <= 128 && !s.chars().any(char::is_control)).ok_or_else(|| anyhow::anyhow!("INVALID_ATTACHMENT"))?;
        let size = input["sizeBytes"].as_u64().filter(|s| *s <= MAX_FILE_BYTES).ok_or_else(|| anyhow::anyhow!("ATTACHMENT_TOO_LARGE"))?;
        let offset = input["offset"].as_u64().ok_or_else(|| anyhow::anyhow!("INVALID_ATTACHMENT_OFFSET"))?;
        let encoded = input["data"].as_str().filter(|s| s.len() <= MAX_CHUNK_BYTES.div_ceil(3) * 4).ok_or_else(|| anyhow::anyhow!("ATTACHMENT_CHUNK_TOO_LARGE"))?;
        let bytes = STANDARD.decode(encoded).map_err(|_| anyhow::anyhow!("INVALID_ATTACHMENT_DATA"))?;
        ensure!(bytes.len() <= MAX_CHUNK_BYTES && offset <= size && bytes.len() as u64 <= size - offset, "INVALID_ATTACHMENT_OFFSET");
        let meta = Metadata { name: name.into(), mime_type: mime.into(), size_bytes: size };
        let meta_path = directory.join("metadata.json");
        if meta_path.exists() {
            let saved: Metadata = serde_json::from_slice(&fs::read(&meta_path)?)?;
            ensure!(saved == meta, "ATTACHMENT_CONFLICT");
        } else {
            // Reserve declared sizes, including incomplete uploads, to bound disk use.
            let parent = directory.parent().unwrap();
            let mut reserved = 0u64;
            let mut count = 0;
            if parent.exists() { for entry in fs::read_dir(parent)? {
                let entry = entry?;
                if let Ok(bytes) = fs::read(entry.path().join("metadata.json")) {
                    if let Ok(saved) = serde_json::from_slice::<Metadata>(&bytes) { reserved += saved.size_bytes; count += 1; }
                }
            } }
            ensure!(reserved + size <= 1024 * 1024 * 1024 && count < 2000, "ATTACHMENT_STORAGE_FULL");
            fs::create_dir_all(&directory)?;
            fs::write(&meta_path, serde_json::to_vec(&meta)?)?;
        }
        let path = directory.join(safe_filename(name));
        let mut file = fs::OpenOptions::new().read(true).write(true).create(true).truncate(false).open(path)?;
        let mut received = file.metadata()?.len();
        ensure!(received <= size, "ATTACHMENT_CONFLICT");
        if !bytes.is_empty() {
            if offset < received {
                ensure!(offset + bytes.len() as u64 <= received, "ATTACHMENT_CONFLICT");
                file.seek(SeekFrom::Start(offset))?;
                let mut previous = vec![0; bytes.len()];
                file.read_exact(&mut previous)?;
                ensure!(previous == bytes, "ATTACHMENT_CONFLICT");
            } else {
                ensure!(offset == received, "INVALID_ATTACHMENT_OFFSET");
                file.seek(SeekFrom::Start(received))?;
                file.write_all(&bytes)?;
                file.sync_data()?;
                received += bytes.len() as u64;
            }
        }
        Ok(json!({"uploadId":id,"receivedBytes":received,"complete":received == size}))
    }
    pub fn resolve(&self, peer: &str, ids: Option<&Value>) -> Result<Vec<Value>> {
        let Some(ids) = ids else { return Ok(vec![]) };
        let ids = ids.as_array().filter(|ids| ids.len() <= 10).ok_or_else(|| anyhow::anyhow!("INVALID_ATTACHMENTS"))?;
        let _guard = self.lock.lock().unwrap();
        let mut inputs = vec![];
        let mut seen = std::collections::HashSet::new();
        for id in ids {
            let id = id.as_str().ok_or_else(|| anyhow::anyhow!("INVALID_ATTACHMENT"))?;
            ensure!(seen.insert(id), "INVALID_ATTACHMENTS");
            let directory = self.directory(peer, id)?;
            let meta: Metadata = fs::read(directory.join("metadata.json")).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).ok_or_else(|| anyhow::anyhow!("ATTACHMENT_NOT_AVAILABLE"))?;
            let path = directory.join(safe_filename(&meta.name));
            ensure!(path.metadata().is_ok_and(|m| m.is_file() && m.len() == meta.size_bytes), "ATTACHMENT_INCOMPLETE");
            inputs.push(json!({"path":path,"name":meta.name,"mimeType":meta.mime_type,"remoteUploadId":id,"kind":if meta.mime_type.starts_with("image/") {"image"} else {"file"}}));
        }
        Ok(inputs)
    }
}

fn safe_filename(name: &str) -> String {
    // The prefix also avoids Windows device names, including CON and NUL.
    let clean: String = name.chars().filter(|c| !c.is_control() && !"<>:\"/\\|?*".contains(*c)).take(120).collect();
    format!("file-{}", clean.trim_matches(['.', ' ']))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn chunks_resume_are_immutable_and_bound_to_the_device() {
        let root = std::env::temp_dir().join(format!("nautilo-upload-{}", uuid::Uuid::new_v4()));
        let store = RemoteAttachments::new(root.clone());
        let id = uuid::Uuid::new_v4().to_string();
        let mut input = json!({"uploadId":id,"name":"../CON.png","mimeType":"image/png","sizeBytes":6,"offset":0,"data":STANDARD.encode(b"abc")});
        assert_eq!(store.upload("phone-a", &input).unwrap()["receivedBytes"], 3);
        assert_eq!(store.upload("phone-a", &input).unwrap()["receivedBytes"], 3);
        assert!(store.resolve("phone-a", Some(&json!([id]))).is_err());
        input["offset"] = json!(3); input["data"] = json!(STANDARD.encode(b"def"));
        assert_eq!(store.upload("phone-a", &input).unwrap()["complete"], true);
        let attachments = store.resolve("phone-a", Some(&json!([id]))).unwrap();
        assert_eq!(fs::read(attachments[0]["path"].as_str().unwrap()).unwrap(), b"abcdef");
        assert!(store.resolve("phone-b", Some(&json!([id]))).is_err());
        input["offset"] = json!(0); input["data"] = json!(STANDARD.encode(b"xyz"));
        assert!(store.upload("phone-a", &input).is_err());
        input["sizeBytes"] = json!(MAX_FILE_BYTES + 1);
        assert!(store.upload("phone-a", &input).is_err());
        assert!(store.resolve("phone-a", Some(&json!(["../../escape"]))).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
