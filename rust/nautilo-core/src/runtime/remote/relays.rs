//! On-demand relay discovery and HTTPS latency probes. Probing never restarts
//! the endpoint or changes the saved transport policy.
use super::*;
use std::time::{Duration, Instant};

#[derive(Default)]
pub(super) struct RelayProbes {
    cache: Mutex<HashMap<String, Probe>>,
    refresh: AsyncMutex<()>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Probe {
    #[serde(skip_serializing_if = "Option::is_none")]
    latency_ms: Option<u64>,
    measured_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    via_proxy: bool,
}

pub(super) fn canonical_url(value: &str) -> Result<String> {
    let mut url = reqwest::Url::parse(value.trim())?;
    if url.scheme() != "https" || url.host_str().is_none()
        || !url.username().is_empty() || url.password().is_some()
        || url.query().is_some() || url.fragment().is_some() || value.len() > 2048 {
        bail!("INVALID_RELAY_URL");
    }
    if let Some(host) = url.host_str().map(|host| host.trim_end_matches('.').to_owned()) {
        url.set_host(Some(&host))?;
    }
    Ok(url.to_string())
}

fn public_nodes() -> Vec<Value> {
    use iroh::defaults::prod::{AP_RELAY_HOSTNAME, EU_RELAY_HOSTNAME, NA_EAST_RELAY_HOSTNAME, NA_WEST_RELAY_HOSTNAME};
    [
        ("asia-pacific", AP_RELAY_HOSTNAME),
        ("europe", EU_RELAY_HOSTNAME),
        ("north-america-west", NA_WEST_RELAY_HOSTNAME),
        ("north-america-east", NA_EAST_RELAY_HOSTNAME),
    ].into_iter().map(|(region, host)| json!({
        "id":region, "url":canonical_url(&format!("https://{host}")).expect("SDK relay URL"),
        "region":region, "source":"public"
    })).collect()
}

async fn probe(url: &str, settings: &Settings) -> Probe {
    // Use the exact proxy policy used for the selected relay; a system proxy
    // must not make a private relay look reachable via an unrelated route.
    let mut probe_settings = settings.clone();
    probe_settings.relay_mode = "custom".into();
    probe_settings.relay_urls = vec![url.into()];
    let proxy = proxy::configured(&probe_settings);
    let via_proxy = proxy.is_some();
    let mut builder = reqwest::Client::builder().no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(2)).timeout(Duration::from_secs(3));
    if let Some((url, _)) = proxy {
        if let Ok(proxy) = reqwest::Proxy::all(url.as_str()) { builder = builder.proxy(proxy); }
    }
    let outcome: Result<u64> = async {
        let client = builder.build()?;
        let mut ping = reqwest::Url::parse(url)?;
        ping.set_path("/ping");
        // Establish DNS/TLS once, then measure one warm HTTP round trip. This
        // is a relay probe, never presented as the application's QUIC RTT.
        for measuring in [false, true] {
            let start = Instant::now();
            let response = client.get(ping.clone()).send().await.map_err(|e| e.without_url())?;
            if !response.status().is_success() { bail!("HTTP {}", response.status().as_u16()); }
            if measuring { return Ok(start.elapsed().as_millis().max(1) as u64); }
            // /ping has an empty body; consume a bounded chunk for connection reuse.
            let mut response = response;
            let _ = response.chunk().await.map_err(|e| e.without_url())?;
        }
        unreachable!()
    }.await;
    let (latency_ms, error) = match outcome {
        Ok(ms) => (Some(ms), None),
        Err(error) => (None, Some(error.to_string().chars().take(180).collect())),
    };
    Probe { latency_ms, measured_at:crate::errors::now_iso(), error, via_proxy }
}

impl RemoteService {
    pub async fn relays(&self, input: Value) -> Result<Value> {
        #[derive(Deserialize)]
        #[serde(rename_all="camelCase", deny_unknown_fields)]
        struct Input {
            #[serde(default)] refresh: bool,
            #[serde(default)] urls: Vec<String>,
        }
        let input: Input = serde_json::from_value(input)?;
        if input.urls.len() > 4 { bail!("INVALID_RELAY_URL"); }
        let settings = self.settings()?;
        let mut nodes = public_nodes();
        for url in input.urls.iter().chain(settings.relay_urls.iter()) {
            let Ok(url) = canonical_url(url) else { continue };
            if !nodes.iter().any(|node| node["url"] == url) {
                if nodes.len() >= 8 { break; }
                nodes.push(json!({"id":url,"url":url,"region":"custom","source":"custom"}));
            }
        }
        // Serialize refreshes, reuse successful AND failed measurements until
        // explicitly refreshed. Reopening a dropdown must not reprobe everything.
        let _refresh = if input.refresh { Some(self.relay_probes.refresh.lock().await) } else { None };
        let mut probes = tokio::task::JoinSet::new();
        for node in &nodes {
            let url = node["url"].as_str().unwrap().to_owned();
            if input.refresh {
                let settings = settings.clone();
                probes.spawn(async move { let value=probe(&url, &settings).await; (url, value) });
            }
        }
        while let Some(result) = probes.join_next().await {
            if let Ok((url, value)) = result { self.relay_probes.cache.lock().unwrap().insert(url, value); }
        }
        let cache = self.relay_probes.cache.lock().unwrap();
        for node in &mut nodes {
            if let Some(result) = cache.get(node["url"].as_str().unwrap()) {
                node.as_object_mut().unwrap().extend(serde_json::to_value(result)?.as_object().unwrap().clone());
            }
        }
        Ok(json!({"nodes":nodes,"measurement":"https"}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn relay_catalog_uses_sdk_nodes_and_normalizes_saved_addresses() {
        let nodes = public_nodes();
        assert_eq!(nodes.len(), 4);
        assert_eq!(nodes[0]["url"], "https://aps1-1.relay.n0.iroh.link/");
        assert_eq!(canonical_url(" https://aps1-1.relay.n0.iroh.link./ ").unwrap(), nodes[0]["url"]);
        assert_eq!(canonical_url("https://[2001:db8::1]:443").unwrap(), "https://[2001:db8::1]/");
        for url in ["http://example.com", "https://secret@example.com", "https://example.com/?token=secret", "https://example.com/#token"] {
            assert!(canonical_url(url).is_err(), "{url}");
        }
    }
}
