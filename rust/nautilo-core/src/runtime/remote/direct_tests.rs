use super::*;
use iroh::{endpoint::{presets, QuicTransportConfig}, RelayMode};
use std::{sync::atomic::{AtomicBool, Ordering}, time::Duration};
use tokio::time::timeout;

const TEST_ALPN: &[u8] = b"nautilo/direct-policy-test";

#[tokio::test]
async fn live_qad_mapping_survives_recheck_without_a_new_handshake() {
    // Keep the first QUIC address-discovery connection alive but drop later
    // handshakes. A periodic report must reuse its known, still-valid mapping.
    let (map, _, relay) = iroh::test_utils::run_relay_server().await.unwrap();
    let mut config = map.relays::<Vec<_>>()[0].as_ref().clone();
    let real = format!("127.0.0.1:{}", config.quic.as_ref().unwrap().port).parse::<std::net::SocketAddr>().unwrap();
    let front = tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let back = tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap();
    config.quic.as_mut().unwrap().port = front.local_addr().unwrap().port();
    let drop_initial = Arc::new(AtomicBool::new(false));
    let drop_in_proxy = drop_initial.clone();
    let dropped = Arc::new(std::sync::atomic::AtomicU64::new(0));
    let dropped_in_proxy = dropped.clone();
    let proxy = tokio::spawn(async move {
        let mut client = None;
        let mut inbound = [0u8; 65_536];
        let mut outbound = [0u8; 65_536];
        loop {
            tokio::select! {
                packet = front.recv_from(&mut inbound) => {
                    let (length, from) = packet.unwrap();
                    client = Some(from);
                    if length > 0 && inbound[0] & 0xf0 == 0xc0 && drop_in_proxy.load(Ordering::Acquire) {
                        dropped_in_proxy.fetch_add(1, Ordering::Relaxed);
                    } else { back.send_to(&inbound[..length], real).await.unwrap(); }
                },
                packet = back.recv_from(&mut outbound) => {
                    let (length, _) = packet.unwrap();
                    if let Some(client) = client { front.send_to(&outbound[..length], client).await.unwrap(); }
                }
            }
        }
    });
    let endpoint = endpoint(config.into(), true, true).await;
    let mut reports = endpoint.net_report();
    timeout(Duration::from_secs(10), async {
        loop {
            if reports.get().is_some_and(|report| report.udp_v4) { break; }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }).await.unwrap();
    let first = reports.get().unwrap().global_v4.unwrap();
    drop_initial.store(true, Ordering::Release);
    // The production recheck interval is 20–26 seconds; allow its probe timeout.
    tokio::time::sleep(Duration::from_secs(32)).await;
    let latest = reports.get().unwrap();
    endpoint.close().await;
    proxy.abort();
    drop(relay);
    assert!(latest.udp_v4, "A live QAD connection lost its cached mapping; dropped new Initials: {}", dropped.load(Ordering::Relaxed));
    assert_eq!(latest.global_v4, Some(first));
}

async fn endpoint(map: iroh::RelayMap, direct: bool, ips: bool) -> Endpoint {
    let mut builder = Endpoint::builder(presets::Minimal)
        .alpns(vec![TEST_ALPN.to_vec()])
        .relay_mode(RelayMode::Custom(map))
        .ca_tls_config(iroh::tls::CaTlsConfig::insecure_skip_verify())
        .portmapper_config(iroh::endpoint::PortmapperConfig::Disabled)
        .transport_config(QuicTransportConfig::builder()
            .direct_streams_only(Arc::new(AtomicBool::new(direct)))
            .max_idle_timeout(Some(Duration::from_secs(10).try_into().unwrap()))
            .build());
    if !ips { builder = builder.clear_ip_transports(); }
    let endpoint = builder.bind().await.unwrap();
    timeout(Duration::from_secs(10), endpoint.online()).await.unwrap();
    endpoint
}

async fn pair(server: &Endpoint, client: &Endpoint, address: iroh::EndpointAddr) -> (Connection, Connection) {
    let (accepted, connected) = timeout(Duration::from_secs(10), async {
        tokio::join!(async { server.accept().await.unwrap().await.unwrap() }, async { client.connect(address, TEST_ALPN).await.unwrap() })
    }).await.unwrap();
    (accepted, connected)
}

async fn wait_path(conn: &Connection, expected: &str) {
    timeout(Duration::from_secs(10), async {
        while super::transport::connection_type(conn) != expected { tokio::time::sleep(Duration::from_millis(30)).await; }
    }).await.unwrap();
}

#[tokio::test]
async fn relay_only_control_works_but_business_stream_never_leaves_sender() {
    let (map, _, relay) = iroh::test_utils::run_relay_server().await.unwrap();
    // The receiver intentionally has no restriction: a mistakenly transmitted
    // STREAM would be accepted, so this cannot pass merely by receiver rejection.
    let server = endpoint(map.clone(), false, false).await;
    let client = endpoint(map, true, false).await;
    let (received, sent) = pair(&server, &client, server.addr()).await;
    wait_path(&sent, "relay").await;
    let (mut send, _receiver) = sent.open_bi().await.unwrap();
    send.write_all(b"private chat must not cross relay").await.unwrap();
    send.finish().unwrap();
    sent.send_datagram(b"transport-policy-control".to_vec().into()).unwrap();
    assert_eq!(&*timeout(Duration::from_secs(3), received.read_datagram()).await.unwrap().unwrap(), b"transport-policy-control");
    assert!(timeout(Duration::from_millis(600), received.accept_bi()).await.is_err());
    assert_eq!(sent.stats().frame_tx.stream, 0, "No STREAM payload may leave on the relay path");
    assert_eq!(received.stats().frame_rx.stream, 0);
    assert!(sent.close_reason().is_none());
    assert!(received.close_reason().is_none());
    client.close().await; server.close().await; drop(relay);
}

#[tokio::test]
async fn automatic_mode_retains_explicitly_allowed_relay_business_transport() {
    let (map, _, relay) = iroh::test_utils::run_relay_server().await.unwrap();
    let server = endpoint(map.clone(), false, false).await;
    let client = endpoint(map, false, false).await;
    let (received, sent) = pair(&server, &client, server.addr()).await;
    wait_path(&sent, "relay").await;
    let (mut send, _receiver) = sent.open_bi().await.unwrap();
    send.write_all(b"relay explicitly permitted in automatic mode").await.unwrap();
    send.finish().unwrap();
    let (_, mut read) = timeout(Duration::from_secs(3), received.accept_bi()).await.unwrap().unwrap();
    assert_eq!(read.read_to_end(100).await.unwrap(), b"relay explicitly permitted in automatic mode");
    assert!(sent.stats().frame_tx.stream > 0);
    client.close().await; server.close().await; drop(relay);
}

#[tokio::test]
async fn strict_receiver_rejects_legacy_relay_stream_instead_of_executing_it() {
    let (map, _, relay) = iroh::test_utils::run_relay_server().await.unwrap();
    let server = endpoint(map.clone(), true, false).await;
    let client = endpoint(map, false, false).await;
    let (received, sent) = pair(&server, &client, server.addr()).await;
    let (mut send, _receiver) = sent.open_bi().await.unwrap();
    send.write_all(b"legacy relay request").await.unwrap();
    send.finish().unwrap();
    let closed = timeout(Duration::from_secs(3), received.closed()).await.unwrap();
    assert!(closed.to_string().contains("STREAM payload forbidden"), "{closed}");
    assert!(received.accept_bi().await.is_err());
    client.close().await; server.close().await; drop(relay);
}

#[tokio::test]
async fn relay_rendezvous_without_peer_ip_upgrades_to_direct_then_exchanges_business() {
    let (map, url, relay) = iroh::test_utils::run_relay_server().await.unwrap();
    let server = endpoint(map.clone(), true, true).await;
    let client = endpoint(map, true, true).await;
    // Supply only an identity and rendezvous node, never the peer's LAN address.
    // NAT candidate exchange must survive while business STREAMs are prohibited.
    let address = iroh::EndpointAddr::new(server.id()).with_relay_url(url);
    let (received, sent) = pair(&server, &client, address).await;
    wait_path(&sent, "direct").await;
    wait_path(&received, "direct").await;
    assert!(received.stats().frame_tx.add_address > 0 && sent.stats().frame_rx.add_address > 0,
        "Direct upgrade must retain QUIC NAT candidate exchange");
    assert!(sent.remote_nat_candidates().is_some_and(|candidates| !candidates.is_empty()),
        "Client diagnostics must include server ADD_ADDRESS candidates");
    assert!(received.remote_nat_candidates().is_some_and(|candidates| !candidates.is_empty()),
        "Server diagnostics must include client REACH_OUT candidates");
    let (mut send, _receiver) = sent.open_bi().await.unwrap();
    send.write_all(b"business over direct IP").await.unwrap(); send.finish().unwrap();
    let (_, mut read) = timeout(Duration::from_secs(3), received.accept_bi()).await.unwrap().unwrap();
    assert_eq!(read.read_to_end(100).await.unwrap(), b"business over direct IP");
    client.close().await; server.close().await; drop(relay);
}

#[tokio::test]
async fn blocked_path_retains_queued_stream_bytes_and_recovers_on_allowed_path() {
    let permitted = Arc::new(AtomicBool::new(true));
    let filter = permitted.clone();
    let server = Endpoint::builder(presets::Minimal).alpns(vec![TEST_ALPN.to_vec()]).bind().await.unwrap();
    let client = Endpoint::builder(presets::Minimal).transport_config(QuicTransportConfig::builder()
        .stream_data_path_filter(Arc::new(move |_| filter.load(Ordering::Acquire))).build()).bind().await.unwrap();
    let (received, sent) = pair(&server, &client, server.addr()).await;
    permitted.store(false, Ordering::Release);
    let (mut send, _receiver) = sent.open_bi().await.unwrap();
    send.write_all(b"retained until direct path returns").await.unwrap(); send.finish().unwrap();
    sent.send_datagram(b"control remains live".to_vec().into()).unwrap();
    timeout(Duration::from_secs(3), received.read_datagram()).await.unwrap().unwrap();
    assert!(timeout(Duration::from_millis(500), received.accept_bi()).await.is_err());
    assert_eq!(sent.stats().frame_tx.stream, 0);
    permitted.store(true, Ordering::Release);
    sent.send_datagram(b"path is allowed again".to_vec().into()).unwrap();
    let (_, mut read) = timeout(Duration::from_secs(3), received.accept_bi()).await.unwrap().unwrap();
    assert_eq!(read.read_to_end(100).await.unwrap(), b"retained until direct path returns");
    client.close().await; server.close().await;
}
