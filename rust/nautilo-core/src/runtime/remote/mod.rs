mod access;
mod pairing;
mod mobile;
mod attachments;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod team_tests;
mod transport;
mod control;
mod diagnostics;
mod direct_network;
mod proxy;
mod relays;
#[cfg(test)]
mod direct_tests;

use crate::{
    database::{remote::RemoteRepository, Database},
    ipc_gateway::Router,
    runtime::{security::CredentialService, EventService},
};
use anyhow::{bail, Result};
use iroh::{endpoint::Connection, Endpoint, SecretKey, Watcher};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, Weak},
};
use tokio::sync::Mutex as AsyncMutex;

pub const ALPN: &[u8] = b"nautilo/remote/1";
pub const ALPN_V2: &[u8] = b"nautilo/remote/2";

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Settings {
    pub enabled: bool,
    pub device_name: String,
    pub relay_mode: String,
    pub relay_urls: Vec<String>,
    pub keep_awake: bool,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            enabled: false,
            device_name: std::env::var("COMPUTERNAME").unwrap_or_else(|_| "Nautilo".into()),
            relay_mode: "automatic".into(),
            relay_urls: vec![],
            keep_awake: true,
        }
    }
}

pub struct RemoteService {
    pub(crate) repo: RemoteRepository,
    credentials: Arc<CredentialService>,
    events: Arc<EventService>,
    router: Mutex<Weak<Router>>,
    lifecycle: AsyncMutex<()>,
    state: Mutex<State>,
    attachments: attachments::RemoteAttachments,
    relay_probes: relays::RelayProbes,
}
struct State {
    endpoint: Option<Endpoint>,
    error: Option<String>,
    starting: bool,
    stopped: bool,
    generation: u64,
    invitation: Option<pairing::Invitation>,
    pending: HashMap<String, pairing::Pending>,
    connections: HashMap<String, Connection>,
    recent_connections: std::collections::VecDeque<Value>,
    http_proxy_source: Option<&'static str>,
    direct_discovery: direct_network::Discovery,
}
impl RemoteService {
    pub fn new(
        db: Arc<Mutex<Database>>,
        credentials: Arc<CredentialService>,
        events: Arc<EventService>,
    ) -> Arc<Self> {
        let attachment_root = db.lock().unwrap().path().parent().expect("database directory").join("remote-attachments");
        Arc::new(Self {
            repo: RemoteRepository::new(db),
            credentials,
            events,
            router: Mutex::new(Weak::new()),
            attachments: attachments::RemoteAttachments::new(attachment_root),
            relay_probes: relays::RelayProbes::default(),
            lifecycle: AsyncMutex::new(()),
            state: Mutex::new(State {
                endpoint: None,
                error: None,
                starting: false,
                stopped: false,
                generation: 0,
                invitation: None,
                pending: HashMap::new(),
                connections: HashMap::new(),
                recent_connections: std::collections::VecDeque::new(),
                http_proxy_source: None,
                direct_discovery: direct_network::Discovery::default(),
            }),
        })
    }
    pub async fn start(self: &Arc<Self>, router: &Arc<Router>) {
        *self.router.lock().unwrap() = Arc::downgrade(router);
        if let Err(error) = self.reconfigure().await {
            self.state.lock().unwrap().error = Some(error.to_string());
        }
        let network_service = Arc::downgrade(self);
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                let Some(service) = network_service.upgrade() else { break };
                if let Err(error) = service.refresh_direct_interfaces().await {
                    service.state.lock().unwrap().error = Some(error.to_string());
                }
            }
        });
        let weak = Arc::downgrade(self);
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(30)).await;
                let Some(service) = weak.upgrade() else { break };
                let retry = service.settings().is_ok_and(|s| s.enabled) && {
                    let state = service.state.lock().unwrap();
                    state.endpoint.is_none() && !state.starting && !state.stopped
                };
                if retry {
                    if let Err(error) = service.reconfigure().await {
                        service.state.lock().unwrap().error = Some(error.to_string());
                    }
                }
            }
        });
    }
    pub fn settings(&self) -> Result<Settings> {
        let Some(mut value) = self.repo.settings()? else {
            return Ok(Settings::default());
        };
        value.as_object_mut().unwrap().remove("id");
        // The old UI called this "direct only". Preserve that user intent by
        // upgrading it to NAT-capable direct, rather than retaining LAN limits.
        if value["relayMode"] == "local" { value["relayMode"] = json!("direct"); }
        Ok(serde_json::from_value(value)?)
    }
    pub async fn configure(self: &Arc<Self>, input: Value) -> Result<Value> {
        let mut settings: Settings = serde_json::from_value(input)?;
        if settings.relay_mode == "local" { settings.relay_mode = "direct".into(); }
        if settings.device_name.trim().is_empty() || settings.device_name.len() > 120 {
            bail!("INVALID_DEVICE_NAME");
        }
        if !["automatic", "custom", "direct", "lan"].contains(&settings.relay_mode.as_str()) {
            bail!("INVALID_RELAY_MODE");
        }
        settings.relay_urls = settings.relay_urls.iter().map(|url| url.trim().to_string())
            .filter(|url| !url.is_empty()).fold(Vec::new(), |mut urls, url| {
                if !urls.contains(&url) { urls.push(url); }
                urls
            });
        // Public relay mode needs no user-supplied server. Dormant custom
        // fields must not prevent switching back to automatic or offline LAN.
        let uses_relay_urls = matches!(settings.relay_mode.as_str(), "custom" | "direct");
        if uses_relay_urls && settings.relay_urls.len() > 4 { bail!("INVALID_RELAY_URL"); }
        for url in settings.relay_urls.iter().filter(|_| uses_relay_urls) {
            let parsed: reqwest::Url = url.parse()?;
            if parsed.scheme() != "https"
                || parsed.host_str().is_none()
                || !parsed.username().is_empty()
                || parsed.password().is_some()
                || parsed.query().is_some()
                || parsed.fragment().is_some()
            {
                bail!("Relay URLs must use HTTPS without credentials");
            }
        }
        let _guard = self.lifecycle.lock().await;
        let previous = self.settings()?;
        let restart = previous.enabled != settings.enabled
            || previous.relay_mode != settings.relay_mode
            || previous.relay_urls != settings.relay_urls
            || (settings.enabled && self.state.lock().unwrap().endpoint.is_none());
        self.repo.save_settings(&serde_json::to_value(&settings)?)?;
        if restart {
            if let Err(error) = self.reconfigure_locked().await {
                let mut state = self.state.lock().unwrap();
                state.starting = false;
                state.error = Some(error.to_string());
            }
        } else if settings.enabled && settings.relay_mode != "lan" {
            let endpoint = self.state.lock().unwrap().endpoint.clone();
            if let Some(endpoint) = endpoint.filter(|e| !e.home_relay_status().get().iter().any(|r| r.is_connected())) {
                // An explicit retry must actually wake the transport, even
                // when the saved settings have not changed. Keep peer streams.
                endpoint.network_change().await;
            }
        }
        self.status()
    }
    fn identity(&self) -> Result<SecretKey> {
        if let Some(secret) = self.credentials.read("nautilo:remote-identity")? {
            return Ok(secret["secret"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("Invalid remote identity"))?
                .parse()?);
        }
        use ring::rand::SecureRandom;
        let mut bytes = [0u8; 32];
        ring::rand::SystemRandom::new()
            .fill(&mut bytes)
            .map_err(|_| anyhow::anyhow!("Identity generation failed"))?;
        let key = SecretKey::from_bytes(&bytes);
        let encoded = key
            .to_bytes()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        self.credentials
            .set_secret("nautilo:remote-identity", &json!({"secret":encoded}))?;
        Ok(key)
    }
    pub fn status(&self) -> Result<Value> {
        let settings = self.settings()?;
        let mut devices = self.repo.devices()?;
        let mut state = self.state.lock().unwrap();
        state
            .pending
            .retain(|_, p| p.expires_at > pairing::now_ms());
        let endpoint = state.endpoint.as_ref();
        for device in &mut devices {
            let connection = device["id"]
                .as_str()
                .and_then(|id| state.connections.get(id))
                .filter(|c| c.close_reason().is_none());
            device["connected"] = json!(connection.is_some());
            if let Some(connection) = connection {
                device["latencyMs"] = json!(transport::latency(connection));
                device["connectionType"] = json!(transport::connection_type(connection));
                device["connectionState"] = json!(if settings.relay_mode == "direct" && transport::connection_type(connection) != "direct" { "punching" } else { "ready" });
                device["paths"] = json!(connection.paths().iter().map(|p| json!({
                    "type":if p.is_relay(){"relay"}else{"direct"},"selected":p.is_selected(),
                    "latencyMs":p.rtt().as_millis() as u64
                })).collect::<Vec<_>>());
            }
        }
        let phase = if !settings.enabled {
            "disabled"
        } else if state.starting {
            "starting"
        } else if state.error.is_some() {
            "error"
        } else if endpoint.is_some() {
            "listening"
        } else {
            "starting"
        };
        Ok(
            json!({"supported":true,"settings":settings,"state":phase,"error":state.error,
            "endpointId":endpoint.map(Endpoint::id),"internetReady":endpoint.is_some_and(|e|e.home_relay_status().get().iter().any(|s|s.is_connected())),
            "network":endpoint.and_then(|endpoint| control::network_diagnostics(endpoint, &state.direct_discovery)),
            "relays":endpoint.map(|e| e.home_relay_status().get().iter().map(|s|json!({"url":s.url().to_string(),"connected":s.is_connected(),"error":s.last_error().map(ToString::to_string)})).collect::<Vec<_>>()).unwrap_or_default(),
            "devices":devices,"pending":state.pending.values().collect::<Vec<_>>()}),
        )
    }
    pub async fn close(&self) {
        let _lock = self.lifecycle.lock().await;
        self.state.lock().unwrap().stopped = true;
        self.close_endpoint().await;
    }
    async fn close_endpoint(&self) {
        let endpoint = {
            let mut state = self.state.lock().unwrap();
            state.generation += 1;
            state.invitation = None;
            state.pending.clear();
            state.http_proxy_source = None;
            state.direct_discovery = direct_network::Discovery::default();
            for (_, c) in state.connections.drain() {
                c.close(0u32.into(), b"remote disabled");
            }
            state.endpoint.take()
        };
        if let Some(endpoint) = endpoint {
            endpoint.close().await;
        }
    }
}
