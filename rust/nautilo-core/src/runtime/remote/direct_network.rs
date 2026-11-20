//! Direct-mode interface candidates and same-socket STUN discovery.
//! HTTP rendezvous keeps the user's proxy; QUIC payloads keep the direct-only gate.
use super::*;
use iroh::endpoint::{BindOpts, Builder};
use std::{
    collections::BTreeSet,
    net::{IpAddr, SocketAddr},
    time::{Duration, Instant},
};

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Binding {
    index: u32,
    name: String,
    address: IpAddr,
    prefix: u8,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Discovery {
    pub interfaces: Vec<Binding>,
    pub mappings: Vec<SocketAddr>,
    pub updated_at: Option<String>,
    pub error: Option<String>,
}

pub(super) fn bindings() -> Vec<Binding> {
    // Native interface APIs, not powershell/ipconfig processes. Keep only live
    // physical candidates; do not advertise fake-IP or VM-switch addresses.
    let mut interfaces = netdev::get_interfaces();
    interfaces.sort_by_key(|interface| (!interface.default, interface.index));
    let mut result = Vec::new();
    for interface in interfaces {
        if !interface.is_up()
            || !interface.is_oper_up()
            || interface.is_loopback()
            || interface.is_tun()
            || !physical_interface(&interface)
        {
            continue;
        }
        let name = interface
            .friendly_name
            .clone()
            .unwrap_or_else(|| interface.name.clone());
        for address in &interface.ipv4 {
            let ip = IpAddr::V4(address.addr());
            if usable(ip) {
                result.push(Binding {
                    index: interface.index,
                    name: name.clone(),
                    address: ip,
                    prefix: address.prefix_len(),
                });
            }
        }
        for address in &interface.ipv6 {
            let ip = IpAddr::V6(address.addr());
            if usable(ip) {
                result.push(Binding {
                    index: interface.index,
                    name: name.clone(),
                    address: ip,
                    prefix: address.prefix_len(),
                });
            }
        }
    }
    result.truncate(8);
    result
}

fn usable(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            !ip.is_unspecified()
                && !ip.is_loopback()
                && !ip.is_link_local()
                && !ip.is_multicast()
                && ip != std::net::Ipv4Addr::BROADCAST
                && !(ip.octets()[0] == 198 && matches!(ip.octets()[1], 18 | 19))
        }
        // Global IPv6 only: link-local needs a scope ID and is not a WAN candidate.
        IpAddr::V6(ip) => ip.segments()[0] & 0xe000 == 0x2000,
    }
}

#[cfg(windows)]
fn physical_interface(interface: &netdev::Interface) -> bool {
    use windows_sys::Win32::NetworkManagement::IpHelper::{GetIfEntry2, MIB_IF_ROW2};
    let mut row = MIB_IF_ROW2::default();
    row.InterfaceIndex = interface.index;
    // The OS hardware flag distinguishes actual Ethernet/WLAN from Hyper-V,
    // WSL and TUN adapters even when they report Ethernet types and real MACs.
    unsafe { GetIfEntry2(&mut row) == 0 && row.InterfaceAndOperStatusFlags._bitfield & 1 != 0 }
}

#[cfg(not(windows))]
fn physical_interface(interface: &netdev::Interface) -> bool { interface.is_physical() }

pub(super) fn bind(mut builder: Builder, interfaces: &[Binding]) -> Result<Builder> {
    let primary_v4 = interfaces.iter().position(|interface| interface.address.is_ipv4());
    let primary_v6 = interfaces.iter().position(|interface| interface.address.is_ipv6());
    // Iroh's builder rejects any further bind of a family after its explicit
    // default is set. Register subnet candidates first, then one default/family.
    let is_default = |index: usize| Some(index) == primary_v4 || Some(index) == primary_v6;
    let order = (0..interfaces.len()).filter(|index| !is_default(*index))
        .chain((0..interfaces.len()).filter(|index| is_default(*index)));
    for index in order {
        let interface = &interfaces[index];
        let opts = BindOpts::default()
            .set_prefix_len(interface.prefix)
            .set_is_default_route(is_default(index))
            .set_is_required(is_default(index));
        builder = builder.bind_addr_with_opts(SocketAddr::new(interface.address, 0), opts)?;
    }
    Ok(builder)
}

fn client(settings: &Settings) -> Result<reqwest::Client> {
    let mut builder = reqwest::Client::builder()
        .no_proxy()
        .connect_timeout(Duration::from_secs(2))
        .timeout(Duration::from_secs(3));
    if let Some((url, _)) = proxy::configured(settings) {
        builder = builder.proxy(reqwest::Proxy::all(url.as_str())?);
    }
    Ok(builder.build()?)
}

async fn stun_server(
    endpoint: &Endpoint,
    client: &reqwest::Client,
    host: &str,
    port: u16,
) -> Option<SocketAddr> {
    let system = endpoint
        .dns_resolver()
        .ok()?
        .lookup_ipv4(host, Duration::from_secs(1))
        .await;
    if let Ok(mut ips) = system {
        if let Some(ip) =
            ips.find(|ip| usable(*ip) && !matches!(ip, IpAddr::V4(ip) if ip.is_private()))
        {
            return Some(SocketAddr::new(ip, port));
        }
    }
    // TUN fake-IP DNS is not a routable STUN destination on a physical socket.
    // Resolve only these fixed public discovery hosts over authenticated HTTPS.
    for origin in [
        "https://dns.google/resolve",
        "https://cloudflare-dns.com/dns-query",
    ] {
        let response = client
            .get(origin)
            .query(&[("name", host), ("type", "A")])
            .header("Accept", "application/dns-json")
            .send()
            .await
            .ok();
        let Some(response) = response.filter(|response| response.status().is_success()) else {
            continue;
        };
        let Ok(value) = response.json::<Value>().await else {
            continue;
        };
        for answer in value["Answer"].as_array().into_iter().flatten() {
            if answer["type"] != 1 {
                continue;
            }
            let Some(ip) = answer["data"]
                .as_str()
                .and_then(|ip| ip.parse::<IpAddr>().ok())
            else {
                continue;
            };
            if usable(ip) && !matches!(ip, IpAddr::V4(ip) if ip.is_private()) {
                return Some(SocketAddr::new(ip, port));
            }
        }
    }
    None
}

impl RemoteService {
    pub(super) async fn refresh_direct_interfaces(self: &Arc<Self>) -> Result<()> {
        if !self
            .settings()
            .is_ok_and(|settings| settings.enabled && settings.relay_mode == "direct")
        {
            return Ok(());
        }
        let (generation, before) = {
            let state = self.state.lock().unwrap();
            if state.stopped || state.starting || state.endpoint.is_none() {
                return Ok(());
            }
            (state.generation, state.direct_discovery.interfaces.clone())
        };
        let current = tokio::task::spawn_blocking(bindings).await?;
        if current != before && self.state.lock().unwrap().generation == generation {
            self.reconfigure().await?;
        }
        Ok(())
    }

    pub(super) fn start_direct_discovery(
        self: &Arc<Self>,
        endpoint: Endpoint,
        generation: u64,
        settings: Settings,
    ) {
        if !matches!(settings.relay_mode.as_str(), "direct" | "automatic") {
            return;
        }
        let weak = Arc::downgrade(self);
        tokio::spawn(async move {
            let Ok(client) = client(&settings) else {
                return;
            };
            let mut servers = Vec::new();
            let mut resolve_at = Instant::now();
            let mut previous = BTreeSet::new();
            let mut last_success = None;
            loop {
                let Some(service) = weak.upgrade() else { break };
                if endpoint.is_closed() || service.state.lock().unwrap().generation != generation {
                    break;
                }
                if servers.is_empty() || Instant::now() >= resolve_at {
                    let (cloudflare, google) = tokio::join!(
                        stun_server(&endpoint, &client, "stun.cloudflare.com", 3478),
                        stun_server(&endpoint, &client, "stun.l.google.com", 19302)
                    );
                    servers = [cloudflare, google].into_iter().flatten().collect();
                    resolve_at = Instant::now() + Duration::from_secs(300);
                }
                let mut probes = tokio::task::JoinSet::new();
                for server in &servers {
                    let endpoint = endpoint.clone();
                    let server = *server;
                    probes.spawn(async move {
                        endpoint.probe_stun(server, Duration::from_secs(2)).await
                    });
                }
                let mut current = BTreeSet::new();
                while let Some(outcome) = probes.join_next().await {
                    let Ok(mappings) = outcome else { continue };
                    for (_, address) in mappings {
                        if usable(address.ip()) {
                            current.insert(address);
                        }
                    }
                }
                if !current.is_empty() {
                    last_success = Some(Instant::now());
                }
                // One lost packet must not flap a live candidate. Expire stale
                // mappings after a bounded grace period, including NAT changes.
                if !current.is_empty()
                    || last_success.is_some_and(|at| at.elapsed() >= Duration::from_secs(45))
                {
                    for address in current.difference(&previous) {
                        endpoint.add_external_addr(*address).await;
                    }
                    for address in previous.difference(&current) {
                        endpoint.remove_external_addr(address).await;
                    }
                    previous = current;
                }
                {
                    let mut state = service.state.lock().unwrap();
                    if state.generation != generation {
                        break;
                    }
                    state.direct_discovery.mappings = previous.iter().copied().collect();
                    state.direct_discovery.updated_at = Some(crate::errors::now_iso());
                    state.direct_discovery.error = previous
                        .is_empty()
                        .then(|| "STUN_DISCOVERY_UNAVAILABLE".into());
                }
                drop(service);
                tokio::time::sleep(Duration::from_secs(15)).await;
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn multiple_interface_candidates_register_before_each_family_default() {
        let interfaces = ["192.168.1.20", "10.0.0.20", "2606:4700::1234", "192.168.2.20"]
            .into_iter().map(|address| Binding { index:1, name:"fixture".into(), address:address.parse().unwrap(), prefix:24 }).collect::<Vec<_>>();
        assert!(bind(Endpoint::builder(iroh::endpoint::presets::Minimal), &interfaces).is_ok());
    }
    #[test]
    fn direct_candidates_exclude_fake_ip_and_non_routable_addresses() {
        for ip in [
            "198.18.0.1",
            "198.19.255.254",
            "127.0.0.1",
            "0.0.0.0",
            "169.254.1.2",
            "224.0.0.1",
            "fe80::1",
            "::1",
        ] {
            assert!(!usable(ip.parse().unwrap()), "{ip}");
        }
        for ip in ["192.168.1.20", "10.0.0.5", "163.125.1.1", "2606:4700::1111"] {
            assert!(usable(ip.parse().unwrap()), "{ip}");
        }
    }
}
