//! Manual, read-only QAD probe: cargo run -p nautilo-core --example direct_network_probe -- <bind-ip> <relay-host> <resolved-ip>
//! Uses the actual Iroh UDP socket; never publishes a mapping from a different socket.
use iroh::{
    dns::{BoxIter, DnsError, DnsResolver, Resolver, TxtRecordData},
    endpoint::presets,
    Endpoint, RelayMode, Watcher,
};
use std::{
    future::Future,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    pin::Pin,
    time::Duration,
};
type Reply<T> = Pin<Box<dyn Future<Output = Result<BoxIter<T>, DnsError>> + Send>>;

#[derive(Debug, Clone)]
struct ProbeDns {
    host: String,
    address: Ipv4Addr,
    system: DnsResolver,
}
impl Resolver for ProbeDns {
    fn lookup_ipv4(&self, host: String) -> Reply<Ipv4Addr> {
        let this = self.clone();
        Box::pin(async move {
            if host.trim_end_matches('.') == this.host.trim_end_matches('.') {
                return Ok(Box::new(std::iter::once(this.address)) as BoxIter<_>);
            }
            let addresses = this
                .system
                .lookup_ipv4(host, Duration::from_secs(3))
                .await?
                .filter_map(|ip| {
                    if let IpAddr::V4(ip) = ip {
                        Some(ip)
                    } else {
                        None
                    }
                })
                .collect::<Vec<_>>();
            Ok(Box::new(addresses.into_iter()) as BoxIter<_>)
        })
    }
    fn lookup_ipv6(&self, host: String) -> Reply<Ipv6Addr> {
        let system = self.system.clone();
        Box::pin(async move {
            let addresses = system
                .lookup_ipv6(host, Duration::from_secs(3))
                .await?
                .filter_map(|ip| {
                    if let IpAddr::V6(ip) = ip {
                        Some(ip)
                    } else {
                        None
                    }
                })
                .collect::<Vec<_>>();
            Ok(Box::new(addresses.into_iter()) as BoxIter<_>)
        })
    }
    fn lookup_txt(&self, host: String) -> Reply<TxtRecordData> {
        let system = self.system.clone();
        Box::pin(async move {
            let records = system
                .lookup_txt(host, Duration::from_secs(3))
                .await?
                .collect::<Vec<_>>();
            Ok(Box::new(records.into_iter()) as BoxIter<_>)
        })
    }
    fn clear_cache(&self) {
        self.system.clear_cache();
    }
    fn reset(&self) -> Box<dyn Resolver> {
        Box::new(Self {
            system: DnsResolver::new(),
            ..self.clone()
        })
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    anyhow::ensure!(
        args.len() >= 3,
        "expected <bind-ip> <relay-host> <resolved-ip> [stun-ip:port]"
    );
    let ip: IpAddr = args[0].parse()?;
    let relay: iroh::RelayUrl = format!("https://{}/", args[1]).parse()?;
    let dns = DnsResolver::custom(ProbeDns {
        host: args[1].clone(),
        address: args[2].parse()?,
        system: DnsResolver::new(),
    });
    let endpoint = Endpoint::builder(presets::N0)
        .alpns(vec![b"nautilo/network-probe/1".to_vec()])
        .bind_addr(SocketAddr::new(ip, 0))?
        .dns_resolver(dns)
        .relay_mode(RelayMode::Custom(std::iter::once(relay).collect()))
        .bind()
        .await?;
    let mut report = endpoint.net_report();
    let start = std::time::Instant::now();
    if let Some(server) = args.get(3) {
        let mapped = endpoint
            .probe_stun(server.parse()?, Duration::from_secs(2))
            .await;
        for (_, address) in &mapped {
            endpoint.add_external_addr(*address).await;
        }
        println!(
            "{}",
            serde_json::json!({"stun":mapped,"elapsedMs":start.elapsed().as_millis(),"advertised":endpoint.addr()})
        );
    }
    loop {
        if let Some(value) = report.get() {
            println!(
                "{}",
                serde_json::json!({"bind":ip,"elapsedMs":start.elapsed().as_millis(),"report":value,"bound":endpoint.bound_sockets(),"advertised":endpoint.addr()})
            );
            if value.udp_v4 || value.udp_v6 {
                break;
            }
        }
        if start.elapsed() > Duration::from_secs(12) {
            break;
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    endpoint.close().await;
    Ok(())
}
