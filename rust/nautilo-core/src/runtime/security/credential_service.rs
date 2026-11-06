//! AES-256-GCM credential vault — port of runtime/security/credential-service.ts.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde_json::Value;

use crate::database::Database;
use crate::errors::{CoreError, CoreResult, ErrorCode};
use crate::database::Repositories;

/// AES-256-GCM local vault, byte-compatible with the TS implementation
/// (12-byte iv, 16-byte tag, base64 fields, key file at <dataDir>/credential.key).
pub struct CredentialService {
    db: Arc<Mutex<Database>>,
    key_path: PathBuf,
    key: Mutex<Option<[u8; 32]>>,
}

impl CredentialService {
    pub fn new(db: Arc<Mutex<Database>>, data_dir: &std::path::Path) -> Self {
        Self { db, key_path: data_dir.join("credential.key"), key: Mutex::new(None) }
    }

    pub fn set(&self, agent_instance_id: &str, credential: &Value) -> CoreResult<()> {
        if agent_instance_id.starts_with("connection:") { return Err(CoreError::reason(ErrorCode::IpcInvalidRequest, "Connection credentials are immutable; create a new revision")); }
        let api_key = credential.get("apiKey").and_then(Value::as_str).unwrap_or("");
        if api_key.trim().is_empty() {
            let mut details = serde_json::Map::new();
            details.insert("field".to_string(), Value::String("apiKey".to_string()));
            return Err(CoreError::details(ErrorCode::IpcInvalidRequest, details));
        }
        let encrypted = self.encrypt(credential)?;
        Repositories::new(&self.db.lock().unwrap().raw).credentials().save(agent_instance_id, &encrypted)?;
        Ok(())
    }

    /// Encrypt before acquiring a persistence transaction; never store plaintext in entity JSON.
    pub(crate) fn encrypt(&self, credential: &Value) -> CoreResult<Value> {
        if credential.get("apiKey").and_then(Value::as_str).is_none_or(|key| key.trim().is_empty()) {
            return Err(CoreError::reason(ErrorCode::IpcInvalidRequest, "API key cannot be empty"));
        }
        (|| -> CoreResult<Value> {
            let key = self.key_value()?;
            let cipher = Aes256Gcm::new((&key).into());
            let iv: [u8; 12] = rand_bytes();
            let ciphertext = cipher
                .encrypt(Nonce::from_slice(&iv), serde_json::to_vec(credential).map_err(|e| store_fail(e.to_string()))?.as_slice())
                .map_err(|e| store_fail(e.to_string()))?;
            Ok(serde_json::json!({
                "iv": BASE64.encode(iv),
                "tag": BASE64.encode(&ciphertext[ciphertext.len() - 16..]),
                "ciphertext": BASE64.encode(&ciphertext[..ciphertext.len() - 16])
            }))
        })()
    }

    pub fn remove(&self, agent_instance_id: &str) -> CoreResult<bool> {
        if agent_instance_id.starts_with("connection:") { return Err(CoreError::reason(ErrorCode::IpcInvalidRequest, "Connection credentials are immutable; create a new revision")); }
        Repositories::new(&self.db.lock().unwrap().raw).credentials().remove(agent_instance_id)
    }

    pub fn has(&self, agent_instance_id: &str) -> CoreResult<bool> {
        Repositories::new(&self.db.lock().unwrap().raw).credentials().has(agent_instance_id)
    }

    pub fn connection_directory(&self, id: &str, revision: u64) -> PathBuf {
        self.key_path.parent().unwrap().join("runtime-connections").join(id).join(revision.to_string())
    }

    pub fn read(&self, agent_instance_id: &str) -> CoreResult<Option<Value>> {
        let encrypted = Repositories::new(&self.db.lock().unwrap().raw).credentials().get(agent_instance_id)?;
        let Some(encrypted) = encrypted else { return Ok(None) };
        let decode = || -> CoreResult<Value> {
            let key = self.key_value()?;
            let cipher = Aes256Gcm::new((&key).into());
            let iv = BASE64.decode(encrypted.get("iv").and_then(Value::as_str).unwrap_or("")).map_err(|e| store_fail(e.to_string()))?;
            let tag = BASE64.decode(encrypted.get("tag").and_then(Value::as_str).unwrap_or("")).map_err(|e| store_fail(e.to_string()))?;
            let mut ciphertext = BASE64
                .decode(encrypted.get("ciphertext").and_then(Value::as_str).unwrap_or(""))
                .map_err(|e| store_fail(e.to_string()))?;
            ciphertext.extend_from_slice(&tag);
            let plaintext = cipher
                .decrypt(Nonce::from_slice(&iv), ciphertext.as_slice())
                .map_err(|e| store_fail(e.to_string()))?;
            serde_json::from_slice(&plaintext).map_err(|e| store_fail(e.to_string()))
        };
        decode().map(Some)
    }

    /// All stored API keys — feeds the redaction service.
    pub fn secret_values(&self) -> Vec<String> {
        let db = self.db.lock().unwrap();
        let ids: Vec<String> = match db.raw.prepare("SELECT agent_instance_id FROM credentials") {
            Ok(mut statement) => {
                let values = statement.query_map([], |row| row.get::<_, String>(0))
                    .map(|rows| rows.filter_map(Result::ok).collect()).unwrap_or_default();
                values
            },
            Err(_) => vec![],
        };
        drop(db);
        ids.into_iter()
            .filter_map(|id| self.read(&id).ok().flatten())
            .filter_map(|credential| credential.get("apiKey").and_then(Value::as_str).map(str::to_string))
            .filter(|key| !key.is_empty())
            .collect()
    }

    fn key_value(&self) -> CoreResult<[u8; 32]> {
        let mut cached = self.key.lock().unwrap();
        if let Some(key) = *cached {
            return Ok(key);
        }
        let key = load_or_create_key(&self.key_path)?;
        *cached = Some(key);
        Ok(key)
    }
}

fn store_fail(reason: String) -> CoreError {
    let mut details = serde_json::Map::new();
    details.insert("cause".to_string(), Value::String(reason));
    CoreError::details(ErrorCode::CredentialStoreFailed, details)
}

fn rand_bytes<const N: usize>() -> [u8; N] {
    let mut bytes = [0u8; N];
    // uuid v4 is backed by the OS CSPRNG; two of them give 32 bytes.
    let material = uuid::Uuid::new_v4();
    let material2 = uuid::Uuid::new_v4();
    let mut all = [0u8; 32];
    all[..16].copy_from_slice(material.as_bytes());
    all[16..].copy_from_slice(material2.as_bytes());
    bytes.copy_from_slice(&all[..N]);
    bytes
}

fn load_or_create_key(path: &std::path::Path) -> CoreResult<[u8; 32]> {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if !path.exists() {
        std::fs::write(path, rand_bytes::<32>()).map_err(|e| store_fail(e.to_string()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
        }
    }
    let key = std::fs::read(path).map_err(|e| store_fail(e.to_string()))?;
    let key: [u8; 32] = key
        .try_into()
        .map_err(|_| CoreError::reason(ErrorCode::CredentialStoreFailed, "invalid_key_length"))?;
    Ok(key)
}
