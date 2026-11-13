use super::*;
use iroh::{
    endpoint::{presets, QuicTransportConfig},
    RelayMode, RelayUrl,
};
use std::time::Duration;
use tokio::{sync::Semaphore, time::timeout};

const REQUEST_LIMIT: usize = 256 * 1024;
const RESPONSE_LIMIT: usize = 8 * 1024 * 1024;

pub(super) fn connection_type(connection: &Connection) -> &'static str {
    for path in connection.paths().iter() {
        if path.is_selected() {
            return if path.is_relay() { "relay" } else { "direct" };
        }
    }
    "connecting"
}
pub(super) fn latency(connection: &Connection) -> Option<u64> {
    connection
        .paths()
        .iter()
        .find(|p| p.is_selected())
        .map(|p| p.rtt().as_millis() as u64)
}

impl RemoteService {
    pub(super) async fn reconfigure(self: &Arc<Self>) -> Result<()> {
        let _guard = self.lifecycle.lock().await;
        let result = self.reconfigure_locked().await;
        if result.is_err() {
            self.state.lock().unwrap().starting = false;
        }
        result
    }
    pub(super) async fn reconfigure_locked(self: &Arc<Self>) -> Result<()> {
        if self.state.lock().unwrap().stopped {
            return Ok(());
        }
        self.close_endpoint().await;
        let settings = self.settings()?;
        {
            let mut state = self.state.lock().unwrap();
            state.error = None;
            state.starting = settings.enabled;
        }
        if !settings.enabled {
            return Ok(());
        }
        let transport = QuicTransportConfig::builder()
            .keep_alive_interval(Duration::from_secs(15))
            .max_idle_timeout(Some(Duration::from_secs(60).try_into()?))
            .max_concurrent_bidi_streams(8u32.into())
            .max_concurrent_uni_streams(0u32.into())
            .build();
        let mut builder = Endpoint::builder(presets::N0)
            .secret_key(self.identity()?)
            .alpns(vec![ALPN.to_vec()])
            .transport_config(transport);
        if settings.relay_mode == "local" {
            builder = builder
                .clear_address_lookup()
                .relay_mode(RelayMode::Disabled)
                .portmapper_config(iroh::endpoint::PortmapperConfig::Disabled);
        }
        if settings.relay_mode == "custom" {
            let urls = settings
                .relay_urls
                .iter()
                .map(|s| s.parse::<RelayUrl>())
                .collect::<Result<Vec<_>, _>>()?;
            builder = builder.relay_mode(RelayMode::Custom(urls.into_iter().collect()));
        }
        let result = timeout(Duration::from_secs(20), builder.bind()).await;
        self.state.lock().unwrap().starting = false;
        let endpoint = result??;
        let generation = {
            let mut state = self.state.lock().unwrap();
            state.endpoint = Some(endpoint.clone());
            state.generation
        };
        let service = self.clone();
        tokio::spawn(async move {
            service.accept_connections(endpoint, generation).await;
        });
        Ok(())
    }
    async fn accept_connections(self: Arc<Self>, endpoint: Endpoint, generation: u64) {
        let slots = Arc::new(Semaphore::new(32));
        while let Some(incoming) = endpoint.accept().await {
            let Ok(permit) = slots.clone().try_acquire_owned() else {
                incoming.refuse();
                continue;
            };
            let service = self.clone();
            tokio::spawn(async move {
                let _permit = permit;
                let Ok(Ok(connection)) = timeout(Duration::from_secs(10), incoming).await else {
                    return;
                };
                let peer = connection.remote_id().to_string();
                let trusted = service.repo.device(&peer).ok().flatten().is_some();
                let allowed = {
                    let state = service.state.lock().unwrap();
                    state.generation == generation
                        && (trusted
                            || state
                                .invitation
                                .as_ref()
                                .is_some_and(|i| i.expires_at > pairing::now_ms())
                            || state.pending.contains_key(&peer))
                };
                if !allowed {
                    connection.close(1u32.into(), b"device not authorized");
                    return;
                }
                {
                    let mut state = service.state.lock().unwrap();
                    if let Some(previous) =
                        state.connections.insert(peer.clone(), connection.clone())
                    {
                        previous.close(0u32.into(), b"connection replaced");
                    }
                }
                if let Ok(Some(mut device)) = service.repo.device(&peer) {
                    device["lastSeenAt"] = json!(crate::errors::now_iso());
                    let _ = service.repo.save_device(&device);
                }
                service
                    .serve_connection(&connection, &peer, generation)
                    .await;
                let mut state = service.state.lock().unwrap();
                if state
                    .connections
                    .get(&peer)
                    .is_some_and(|c| c.stable_id() == connection.stable_id())
                {
                    state.connections.remove(&peer);
                }
            });
        }
    }
    async fn serve_connection(
        self: &Arc<Self>,
        connection: &Connection,
        peer: &str,
        generation: u64,
    ) {
        let slots = Arc::new(Semaphore::new(8));
        let connected_at = std::time::Instant::now();
        let mut requests = std::collections::VecDeque::new();
        loop {
            // Unpaired peers have a bounded lifetime, even if they never send data.
            if connected_at.elapsed() > Duration::from_secs(180)
                && self.repo.device(peer).ok().flatten().is_none()
            {
                connection.close(1u32.into(), b"pairing expired");
                break;
            }
            let stream = match timeout(Duration::from_secs(30), connection.accept_bi()).await {
                Ok(Ok(stream)) => stream,
                Ok(Err(_)) => break,
                Err(_) => continue,
            };
            let now = std::time::Instant::now();
            while requests
                .front()
                .is_some_and(|at| now.duration_since(*at) > Duration::from_secs(10))
            {
                requests.pop_front();
            }
            if requests.len() >= 100 {
                connection.close(3u32.into(), b"request rate exceeded");
                break;
            }
            requests.push_back(now);
            let Ok(permit) = slots.clone().try_acquire_owned() else {
                connection.close(2u32.into(), b"too many requests");
                break;
            };
            let service = self.clone();
            let peer = peer.to_owned();
            // A phone disconnect must not abort an already accepted desktop mutation.
            tokio::spawn(async move {
                let _permit = permit;
                let (mut send, mut recv) = stream;
                let Ok(Ok(bytes)) =
                    timeout(Duration::from_secs(10), recv.read_to_end(REQUEST_LIMIT)).await
                else {
                    return;
                };
                let result = match serde_json::from_slice::<access::Request>(&bytes) {
                    Ok(request) => service.request(&peer, request, generation).await,
                    Err(_) => access::failure(
                        "",
                        "INVALID_REQUEST",
                        "Expected a version 1 remote request",
                    ),
                };
                let mut bytes = serde_json::to_vec(&result).unwrap_or_default();
                if bytes.len() > RESPONSE_LIMIT {
                    bytes = serde_json::to_vec(&access::failure(
                        result["id"].as_str().unwrap_or(""),
                        "RESPONSE_TOO_LARGE",
                        "Use a smaller history or event page",
                    ))
                    .unwrap_or_default();
                }
                let _ = timeout(Duration::from_secs(15), send.write_all(&bytes)).await;
                let _ = send.finish();
            });
        }
    }
}
