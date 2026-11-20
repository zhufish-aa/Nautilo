//! Native Console credentials. Resolve its OPENCODE_CONSOLE_TOKEN placeholder from
//! this selected account, as the native Account/config loader does. A Console
//! provider may instead supply a literal service credential.
use rusqlite::{params, Connection, OpenFlags};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::PathBuf,
    time::{Duration, Instant},
};

static PROFILE_LOCKS: std::sync::LazyLock<
    std::sync::Mutex<HashMap<PathBuf, std::sync::Arc<tokio::sync::Mutex<()>>>>,
> = std::sync::LazyLock::new(|| std::sync::Mutex::new(HashMap::new()));

pub(super) struct Credentials {
    pub root: PathBuf,
    cached: Option<(Instant, Value)>,
}
pub(super) struct Provider {
    pub key: String,
    pub headers: HashMap<String, String>,
    pub base: String,
    pub models: Value,
}

impl Credentials {
    pub fn new(root: PathBuf) -> Self {
        Self { root, cached: None }
    }

    pub async fn provider(&mut self, namespace: &str, force: bool) -> anyhow::Result<Provider> {
        if force {
            self.cached = None;
        }
        let database = self.root.join("opencode.db");
        let has_console_account = if database.exists() {
            let db = Connection::open_with_flags(&database, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
            let has_table = db.query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='account')",
                [],
                |row| row.get::<_, bool>(0),
            )?;
            has_table
                && db.query_row("SELECT EXISTS(SELECT 1 FROM account)", [], |row| {
                    row.get::<_, bool>(0)
                })?
        } else {
            false
        };
        if has_console_account {
            if self
                .cached
                .as_ref()
                .is_none_or(|(at, _)| at.elapsed() > Duration::from_secs(120))
            {
                let config = self.console_config().await?;
                self.cached = Some((Instant::now(), config));
            }
            let config = &self.cached.as_ref().unwrap().1;
            let providers = &config["config"]["provider"];
            let selected = providers
                .get(namespace)
                .or_else(|| {
                    // A Console workspace's Go allowance uses the same Console
                    // credential, on its explicit Go route; this is one account.
                    (namespace == "opencode-go")
                        .then(|| providers.get("opencode"))
                        .flatten()
                })
                .ok_or_else(|| {
                    anyhow::anyhow!("The selected OpenCode account did not publish this provider")
                })?;
            let key = selected["options"]["apiKey"]
                .as_str()
                .filter(|s| !s.is_empty())
                .ok_or_else(|| {
                    anyhow::anyhow!("OpenCode Console did not return an inference credential")
                })?
                .to_string();
            let headers = selected["options"]["headers"]
                .as_object()
                .into_iter()
                .flatten()
                .filter_map(|(name, value)| {
                    value
                        .as_str()
                        .map(|value| (name.clone(), value.to_string()))
                })
                .collect();
            let base = if namespace == "opencode-go" && providers.get(namespace).is_none() {
                "https://opencode.ai/inference/go/openai/v1".into()
            } else {
                selected["api"]
                    .as_str()
                    .unwrap_or("https://opencode.ai/inference/openai/v1")
                    .trim_end_matches('/')
                    .to_string()
            };
            return Ok(Provider {
                key,
                headers,
                base,
                models: selected["models"].clone(),
            });
        }
        // Magpie import_opencode.go / OpenCodeAnonymousKey: read only this
        // profile's credential. Native keyless Zen free calls use "public".
        let file = self.root.join("auth.json");
        let stored: Value = if file.exists() {
            serde_json::from_slice(&std::fs::read(file)?)?
        } else {
            json!({})
        };
        let entry = &stored[namespace];
        let key = entry["key"]
            .as_str()
            .filter(|_| entry["type"] == "api")
            .map(str::to_string);
        anyhow::ensure!(
            namespace == "opencode" || key.is_some(),
            "The selected OpenCode Go account has no native credential"
        );
        Ok(Provider {
            key: key.unwrap_or_else(|| "public".into()),
            headers: HashMap::new(),
            models: json!({}),
            base: if namespace == "opencode-go" {
                "https://opencode.ai/inference/go/openai/v1"
            } else {
                "https://opencode.ai/inference/openai/v1"
            }
            .into(),
        })
    }

    async fn console_config(&self) -> anyhow::Result<Value> {
        let root = std::fs::canonicalize(&self.root).unwrap_or_else(|_| self.root.clone());
        // Native OAuth refresh rotates a persisted credential. Once sent it
        // must finish even if the model HTTP caller disconnects. Serialize all
        // routes for this profile, and re-read after acquiring the lock.
        tokio::spawn(async move {
        let lock=PROFILE_LOCKS.lock().unwrap().entry(root.clone()).or_default().clone();
        let _guard=lock.lock_owned().await;
        let path = root.join("opencode.db");
        let read = || -> anyhow::Result<(String,String,String,String,String,i64)> {
            let db = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
            db.busy_timeout(Duration::from_secs(5))?;
            Ok(db.query_row("SELECT a.id,a.url,a.access_token,a.refresh_token,COALESCE(s.active_org_id,''),COALESCE(a.token_expiry,0) FROM account a JOIN account_state s ON a.id=s.active_account_id LIMIT 1", [], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?)))?)
        };
        let (id, server, mut token, refresh, organization, expiry) = read()?;
        let server = server.trim_end_matches('/');
        let url = reqwest::Url::parse(server)?;
        let loopback=url.host_str().is_some_and(|host|host.parse::<std::net::IpAddr>().is_ok_and(|ip|ip.is_loopback()));
        anyhow::ensure!((url.scheme() == "https" || url.scheme()=="http" && loopback) && url.username().is_empty() && url.password().is_none(), "Invalid native OpenCode Console address");
        let client = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).timeout(Duration::from_secs(15)).build()?;
        if expiry < chrono::Utc::now().timestamp_millis() + 300_000 {
            // OpenCode 1.19.5 Account service: POST JSON, this client id and
            // native table fields. Compare the refresh token before persisting.
            let response = client.post(format!("{server}/auth/device/token"))
                .json(&json!({"grant_type":"refresh_token","refresh_token":refresh,"client_id":"opencode-cli"})).send().await?;
            anyhow::ensure!(response.status().is_success(), "OpenCode sign in again: native token refresh returned HTTP {}", response.status().as_u16());
            let renewed: Value = response.json().await?;
            let access = renewed["access_token"].as_str().filter(|s| !s.is_empty()).ok_or_else(|| anyhow::anyhow!("OpenCode refresh returned no access token"))?;
            let next_refresh = renewed["refresh_token"].as_str().unwrap_or(&refresh);
            let now = chrono::Utc::now().timestamp_millis();
            let expires = now + renewed["expires_in"].as_i64().unwrap_or(3600) * 1000;
            let db = Connection::open(&path)?;
            db.busy_timeout(Duration::from_secs(5))?;
            db.execute("UPDATE account SET access_token=?1,refresh_token=?2,token_expiry=?3,time_updated=?4 WHERE id=?5 AND refresh_token=?6",params![access,next_refresh,expires,now,id,refresh])?;
            drop(db);
            token = read()?.2;
        }
        let mut request = client.get(format!("{server}/api/config")).bearer_auth(&token);
        if !organization.is_empty() { request = request.header("x-org-id",organization); }
        let response = request.send().await?;
        anyhow::ensure!(response.status().is_success(), "OpenCode Console configuration returned HTTP {} for the selected account", response.status().as_u16());
        let mut config:Value=response.json().await?;
        // Console returns "{env:OPENCODE_CONSOLE_TOKEN}", not an opaque Zen key.
        // OpenCode supplies this selected Console account's access token when
        // loading that config. Sending the placeholder literally yields 401.
        for (_,provider) in config["config"]["provider"].as_object_mut().into_iter().flatten() {
            if provider["options"]["apiKey"]=="{env:OPENCODE_CONSOLE_TOKEN}" {
                provider["options"]["apiKey"]=json!(token);
            }
        }
        Ok(config)
        }).await?
    }
}
