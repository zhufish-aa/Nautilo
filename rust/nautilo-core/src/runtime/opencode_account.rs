//! OpenCode model HTTP client, ported from yetone/magpie at
//! 4a1ac84421145de4c4078898c6441487ac45bd5e: provider/opencode_client.go,
//! provider/opencode_endpoints.go and gateway/zenfree.go. MIT: see
//! docs/third-party/MAGPIE-LICENSE.txt. No OpenCode Agent runs for inference.
mod auth;
pub(crate) mod stream;
mod wire;
pub(crate) use wire::Tools as CallerToolNames;

use serde_json::{json, Value};
use std::{collections::HashMap, path::PathBuf};
use tokio::{
    io::AsyncReadExt,
    net::TcpStream,
    sync::{watch, Mutex},
};

pub struct OpenCodeAccount {
    credentials: Mutex<auth::Credentials>,
    sessions: std::sync::Mutex<HashMap<String, wire::Session>>,
}
impl OpenCodeAccount {
    fn auth_root(connection: &Value, env: &HashMap<String, String>) -> PathBuf {
        if let Some(profile) = connection["loginProfileDirectory"]
            .as_str()
            .filter(|s| !s.is_empty())
        {
            PathBuf::from(profile).join("data/opencode")
        } else if let Some(data) = env.get("XDG_DATA_HOME").filter(|s| !s.is_empty()) {
            PathBuf::from(data).join("opencode")
        } else {
            dirs::home_dir()
                .unwrap_or_default()
                .join(".local/share/opencode")
        }
    }

    pub fn new(connection: &Value, env: &HashMap<String, String>) -> Self {
        wire::version();
        Self {
            credentials: Mutex::new(auth::Credentials::new(Self::auth_root(connection, env))),
            sessions: std::sync::Mutex::new(HashMap::new()),
        }
    }

    pub async fn quota_key(connection: &Value, env: &HashMap<String, String>) -> anyhow::Result<String> {
        let mut credentials = auth::Credentials::new(Self::auth_root(connection, env));
        Ok(credentials.provider("opencode-go", false).await?.key)
    }

    pub async fn relay(
        &self,
        socket: &mut TcpStream,
        body: &Value,
        identity: &str,
        cwd: &str,
        mut cancelled: watch::Receiver<bool>,
        headers_started: &mut bool,
    ) -> anyhow::Result<()> {
        let model = body["model"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("Select an OpenCode model"))?;
        let (namespace, model) = model
            .split_once('/')
            .filter(|(namespace, _)| matches!(*namespace, "opencode" | "opencode-go"))
            .ok_or_else(|| {
                anyhow::anyhow!("The selected OpenCode model must name opencode/ or opencode-go/")
            })?;
        let mut disconnected = [0u8; 1];
        let mut provider = tokio::select! {
            result = async { self.credentials.lock().await.provider(namespace,false).await } => result?,
            _ = cancelled.changed() => anyhow::bail!("OpenCode request cancelled"),
            _ = socket.read(&mut disconnected) => return Ok(()),
        };
        let free = namespace == "opencode"
            && (model.ends_with("-free")
                || matches!(model, "big-pickle" | "grok-code")
                || provider.models[model]["cost"]["input"] == 0
                    && provider.models[model]["cost"]["output"] == 0);
        let session = {
            let mut sessions = self.sessions.lock().unwrap();
            sessions
                .entry(identity.into())
                .or_insert_with(wire::Session::new)
                .clone()
        };
        let mut request = body.clone();
        request["model"] = json!(model);
        let tools = if free {
            wire::prepare_free(&mut request, cwd)?
        } else {
            wire::Tools::default()
        };
        #[cfg(test)]
        if let Some(home) = std::env::var_os("NAUTILO_RELAY_SMOKE_HOME") {
            // Opt-in smoke diagnostics contain caller input, never credentials.
            let home = std::path::PathBuf::from(home);
            std::fs::write(
                home.join("opencode-request.json"),
                serde_json::to_vec(&json!({"caller":body,"upstream":request,"cwd":cwd}))?,
            )?;
        }
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(std::time::Duration::from_secs(15))
            .timeout(std::time::Duration::from_secs(300))
            .build()?;
        let mut refreshed = false;
        let response = loop {
            let base = provider.base.trim_end_matches('/');
            // The native Console supplies the endpoint; Magpie moves legacy
            // free paths to OpenCode 2's split OpenAI endpoint.
            let base = if free {
                base.replace("/zen/v1", "/inference/openai/v1")
                    .replace("/inference/v1", "/inference/openai/v1")
            } else {
                base.into()
            };
            let mut upstream = client
                .post(format!("{base}/chat/completions"))
                .bearer_auth(&provider.key)
                .json(&request);
            for (name, value) in &provider.headers {
                upstream = upstream.header(name, value);
            }
            for (name, value) in wire::headers(&session, cwd).await {
                upstream = upstream.header(name, value);
            }
            let response = tokio::select! {
                result = upstream.send() => result?,
                _ = cancelled.changed() => anyhow::bail!("OpenCode request cancelled"),
                _ = socket.read(&mut disconnected) => return Ok(()),
            };
            if response.status() != reqwest::StatusCode::UNAUTHORIZED || refreshed {
                break response;
            }
            // A Console inference credential can rotate independently from its
            // OAuth token. Reload this selected account once before reporting
            // an authentication failure. Never retry a completed generation.
            refreshed = true;
            provider = tokio::select! {
                result=async{self.credentials.lock().await.provider(namespace,true).await}=>result?,
                _=cancelled.changed()=>anyhow::bail!("OpenCode request cancelled"),
                _=socket.read(&mut disconnected)=>return Ok(()),
            };
        };
        if !response.status().is_success() {
            let status = response.status().as_u16();
            let retry_after = response.headers().get(reqwest::header::RETRY_AFTER).and_then(|value| value.to_str().ok()).map(str::to_owned);
            let error: Value = response.json().await.unwrap_or(Value::Null);
            let message = error["error"]["message"]
                .as_str()
                .or(error["message"].as_str())
                .unwrap_or("The upstream rejected this model request");
            let safe = message
                .replace(&provider.key, "[redacted]")
                .chars()
                .take(1000)
                .collect::<String>();
            return Err(crate::runtime::account_auth::ModelRequestError {
                status,
                retry_after,
                message: format!("OpenCode model request returned HTTP {status}: {safe}"),
            }
            .into());
        }
        stream::relay(
            socket,
            response,
            body,
            tools,
            &mut cancelled,
            headers_started,
        )
        .await
    }
}
