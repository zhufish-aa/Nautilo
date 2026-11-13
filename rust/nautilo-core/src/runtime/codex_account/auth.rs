//! Selected native file-store auth and cancellation-safe token rotation.
use super::{client, CodexAccount};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, LazyLock, Mutex},
    time::Duration,
};

static LOCKS: LazyLock<Mutex<HashMap<PathBuf, Arc<tokio::sync::Mutex<()>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

impl CodexAccount {
    pub async fn check_login(&self) -> anyhow::Result<()> {
        self.token(None).await.map(|_| ())
    }
    pub fn file_store(home: &Path, version: &str) -> Option<Self> {
        let config = std::fs::read_to_string(home.join("config.toml"))
            .unwrap_or_default()
            .parse::<toml_edit::DocumentMut>()
            .ok();
        let mode = config
            .as_ref()
            .and_then(|c| c.get("cli_auth_credentials_store"))
            .and_then(toml_edit::Item::as_str)
            .unwrap_or("file");
        let encrypted = config
            .as_ref()
            .and_then(|c| c.get("features"))
            .and_then(|c| c.get("secret_auth_storage"))
            .and_then(toml_edit::Item::as_bool)
            .unwrap_or(cfg!(windows));
        if mode == "ephemeral" || mode == "keyring" || (mode == "auto" && encrypted) {
            return None;
        }
        let value = read_auth(home).ok()?;
        if value["auth_mode"] == "apikey"
            || value["tokens"]["access_token"]
                .as_str()
                .is_none_or(str::is_empty)
        {
            return None;
        }
        Some(Self {
            home: home.into(),
            version: version.into(),
            endpoint: "https://chatgpt.com/backend-api/codex/responses".into(),
            refresh_endpoint: "https://auth.openai.com/oauth/token".into(),
        })
    }
    pub(super) async fn token(&self, stale: Option<&str>) -> anyhow::Result<(String, String)> {
        let gate = LOCKS
            .lock()
            .unwrap()
            .entry(self.home.clone())
            .or_default()
            .clone();
        let guard = gate.lock_owned().await;
        let mut raw = read_auth(&self.home)?;
        let token = raw["tokens"]["access_token"]
            .as_str()
            .unwrap_or("")
            .to_string();
        anyhow::ensure!(
            !token.is_empty(),
            "The selected Codex account is signed out"
        );
        let account = account_id(&raw)?;
        if stale.is_some_and(|old| old != token)
            || stale.is_none()
                && expiry(&token).is_none_or(|exp| exp > chrono::Utc::now().timestamp() + 300)
        {
            return Ok((token, account));
        }
        let refresh = raw["tokens"]["refresh_token"]
            .as_str()
            .filter(|v| !v.is_empty())
            .ok_or_else(|| anyhow::anyhow!("The selected Codex account needs to sign in again"))?
            .to_string();
        let client = client()?;
        let endpoint = self.refresh_endpoint.clone();
        let version = self.version.clone();
        let refresh_input = refresh.clone();
        let home = self.home.clone();
        // Once sent, refresh rotation must be saved even if the outer caller cancels.
        tokio::spawn(async move {
            let _guard = guard;
            let res = client.post(endpoint)
                .timeout(Duration::from_secs(30))
                .header("originator", "codex_cli_rs")
                .header("User-Agent", format!("codex_cli_rs/{version}"))
                .json(&json!({"client_id":"app_EMoamEEZ73f0CkXaXp7hrann","grant_type":"refresh_token","refresh_token":refresh_input}))
                .send().await?;
            let status = res.status();
            let reply = bounded_json(res).await?;
            if status == 401 || status == 403 || crate::runtime::account_auth::is_authentication_error(&reply.to_string()) {
                anyhow::bail!("Codex token refresh was refused; sign in to this account again");
            }
            anyhow::ensure!(status.is_success(), "Codex token refresh returned HTTP {}", status.as_u16());
            let access = reply["access_token"].as_str().filter(|s| !s.is_empty())
                .ok_or_else(|| anyhow::anyhow!("Codex refresh returned no access token"))?.to_owned();
            for key in ["access_token", "refresh_token", "id_token"] {
                if let Some(value) = reply.get(key).filter(|v| v.as_str().is_some_and(|s| !s.is_empty())) {
                    raw["tokens"][key] = value.clone();
                }
            }
            raw["last_refresh"] = json!(crate::errors::now_iso());
            // A native login/logout during the network request owns the file now.
            if read_auth(&home).ok().is_some_and(|v| v["tokens"]["refresh_token"] == refresh) {
                atomic_auth(&home, &raw)?;
            }
            Ok::<_, anyhow::Error>((access, account))
        }).await?
    }
}

fn read_auth(home: &Path) -> anyhow::Result<Value> {
    let path = home.join("auth.json");
    let metadata = match std::fs::metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            anyhow::bail!("The selected Codex account is signed out")
        }
        Err(error) => return Err(error.into()),
    };
    anyhow::ensure!(
        metadata.len() <= 1024 * 1024,
        "Native account file is too large"
    );
    Ok(serde_json::from_slice(&std::fs::read(path)?)?)
}
fn account_id(raw: &Value) -> anyhow::Result<String> {
    if let Some(id) = raw["tokens"]["account_id"]
        .as_str()
        .filter(|s| !s.is_empty())
    {
        return Ok(id.into());
    }
    let claims = claims(raw["tokens"]["id_token"].as_str().unwrap_or(""));
    Ok(claims["https://api.openai.com/auth"]["chatgpt_account_id"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("The selected account has no ChatGPT account ID"))?
        .to_string())
}
fn claims(token: &str) -> Value {
    token
        .split('.')
        .nth(1)
        .and_then(|s| URL_SAFE_NO_PAD.decode(s).ok())
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or(Value::Null)
}
fn expiry(token: &str) -> Option<i64> {
    claims(token)["exp"].as_i64()
}
fn atomic_auth(home: &Path, value: &Value) -> anyhow::Result<()> {
    let path = home.join(format!(".auth-refresh-{}.tmp", uuid::Uuid::new_v4()));
    std::fs::write(&path, serde_json::to_vec_pretty(value)?)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
    }
    if let Err(e) = std::fs::rename(&path, home.join("auth.json")) {
        let _ = std::fs::remove_file(&path);
        return Err(e.into());
    }
    Ok(())
}
async fn bounded_json(mut response: reqwest::Response) -> anyhow::Result<Value> {
    let mut data = vec![];
    while let Some(b) = response.chunk().await? {
        anyhow::ensure!(
            data.len() + b.len() <= 1024 * 1024,
            "Refresh response exceeds the size limit"
        );
        data.extend_from_slice(&b)
    }
    Ok(serde_json::from_slice(&data)?)
}
