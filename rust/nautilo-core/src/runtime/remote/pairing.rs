use super::*;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use ring::{
    hmac,
    rand::{SecureRandom, SystemRandom},
};
use sha2::{Digest, Sha256};

pub(crate) fn now_ms() -> u64 {
    chrono::Utc::now().timestamp_millis().max(0) as u64
}
pub(super) struct Invitation {
    pub expires_at: u64,
    pub token: hmac::Key,
    pub proof: hmac::Tag,
    pub failures: u8,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Pending {
    pub id: String,
    pub name: String,
    pub code: String,
    pub expires_at: u64,
}

impl RemoteService {
    pub fn invite(&self) -> Result<Value> {
        let settings = self.settings()?;
        if !settings.enabled {
            bail!("REMOTE_DISABLED");
        }
        let mut state = self.state.lock().unwrap();
        let endpoint = state
            .endpoint
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("REMOTE_NOT_READY"))?;
        let mut bytes = [0u8; 32];
        SystemRandom::new()
            .fill(&mut bytes)
            .map_err(|_| anyhow::anyhow!("Random source unavailable"))?;
        let token = URL_SAFE_NO_PAD.encode(bytes);
        let expires_at = now_ms() + 300_000;
        let payload = json!({"v":1,"transport":"iroh","alpn":"nautilo/remote/1","name":settings.device_name,
            "endpoint":endpoint.addr(),"token":token,"expiresAt":expires_at});
        let uri = format!(
            "nautilo://pair#{}",
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload)?)
        );
        let qr = qrcode::QrCode::new(uri.as_bytes())?;
        let svg = qr
            .render::<qrcode::render::svg::Color>()
            .min_dimensions(256, 256)
            .build();
        let key = hmac::Key::new(hmac::HMAC_SHA256, &bytes);
        let proof = hmac::sign(&key, token.as_bytes());
        state.invitation = Some(Invitation {
            expires_at,
            token: key,
            proof,
            failures: 0,
        });
        state.pending.clear();
        Ok(json!({"uri":uri,"qrSvg":svg,"expiresAt":expires_at}))
    }
    pub fn cancel_invite(&self) -> Result<Value> {
        let mut state = self.state.lock().unwrap();
        state.invitation = None;
        state.pending.clear();
        Ok(json!({"ok":true}))
    }
    pub(super) fn pair(&self, peer: &str, params: &Value) -> Result<Value> {
        if self.repo.device(peer)?.is_some() {
            bail!("ALREADY_PAIRED");
        }
        let token = params["token"].as_str().unwrap_or("");
        let name = params["name"].as_str().unwrap_or("").trim();
        if name.is_empty() || name.len() > 120 || name.chars().any(char::is_control) {
            bail!("INVALID_DEVICE_NAME");
        }
        let mut state = self.state.lock().unwrap();
        if state.pending.contains_key(peer) {
            return Ok(json!({"state":"awaitingApproval"}));
        }
        let invite = state
            .invitation
            .as_mut()
            .ok_or_else(|| anyhow::anyhow!("INVITATION_EXPIRED"))?;
        if now_ms() >= invite.expires_at || invite.failures >= 20 {
            bail!("INVITATION_EXPIRED");
        }
        if hmac::verify(&invite.token, token.as_bytes(), invite.proof.as_ref()).is_err() {
            invite.failures += 1;
            bail!("INVALID_INVITATION");
        }
        let digest = Sha256::digest(format!("{peer}:{token}"));
        let code = format!(
            "{:06}",
            u32::from_be_bytes(digest[..4].try_into().unwrap()) % 1_000_000
        );
        state.pending.insert(
            peer.into(),
            Pending {
                id: peer.into(),
                name: name.into(),
                code: code.clone(),
                expires_at: now_ms() + 120_000,
            },
        );
        state.invitation = None;
        Ok(json!({"state":"awaitingApproval","code":code}))
    }
    pub fn approve(&self, input: Value) -> Result<Value> {
        let id = input["deviceId"].as_str().unwrap_or("");
        if self.repo.devices()?.len() >= 32 {
            bail!("DEVICE_LIMIT_REACHED");
        }
        let mut state = self.state.lock().unwrap();
        let pending = state
            .pending
            .get(id)
            .filter(|p| p.expires_at > now_ms())
            .ok_or_else(|| anyhow::anyhow!("PAIRING_EXPIRED"))?;
        self.repo.save_device(
            &json!({"id":id,"name":pending.name,"access":"control","projectIds":[],
            "pairedAt":crate::errors::now_iso(),"lastSeenAt":crate::errors::now_iso()}),
        )?;
        state.pending.remove(id);
        self.repo.audit(id, "pair", "approved")?;
        Ok(json!({"ok":true}))
    }
    pub fn reject(&self, input: Value) -> Result<Value> {
        let id = input["deviceId"].as_str().unwrap_or("");
        let mut state = self.state.lock().unwrap();
        state.pending.remove(id);
        if let Some(connection) = state.connections.remove(id) {
            connection.close(1u32.into(), b"pairing rejected");
        }
        Ok(json!({"ok":true}))
    }
    pub fn revoke(&self, input: Value) -> Result<Value> {
        let id = input["deviceId"].as_str().unwrap_or("");
        self.repo.remove_device(id)?;
        self.repo.audit(id, "revoke", "success")?;
        self.reject(input)
    }
    pub fn update_device(&self, input: Value) -> Result<Value> {
        let id = input["deviceId"].as_str().unwrap_or("");
        let mut device = self
            .repo
            .device(id)?
            .ok_or_else(|| anyhow::anyhow!("DEVICE_NOT_FOUND"))?;
        let name = input["name"].as_str().unwrap_or("").trim();
        if name.is_empty() || name.len() > 120 || name.chars().any(char::is_control) {
            bail!("INVALID_DEVICE_NAME");
        }
        device["name"] = json!(name);
        device["access"] = json!("control");
        device["projectIds"] = json!([]);
        self.repo.save_device(&device)?;
        self.repo.audit(id, "device", "updated")?;
        Ok(json!({"ok":true}))
    }
}
