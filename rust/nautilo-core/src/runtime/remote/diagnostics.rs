//! Read-only local diagnostics; never exposed as a phone RPC or policy datagram.
use super::*;

pub(super) fn connection_snapshot(connection: &Connection) -> Value {
    let stats = connection.stats();
    json!({
        "peer":connection.remote_id().to_string(),"at":crate::errors::now_iso(),
        "path":transport::connection_type(connection),
        "remoteNatCandidates":connection.remote_nat_candidates(),
        "closeReason":connection.close_reason().map(|reason| reason.to_string().chars().take(240).collect::<String>()),
        "frames":{
            "streamTx":stats.frame_tx.stream,"streamRx":stats.frame_rx.stream,
            "addAddressTx":stats.frame_tx.add_address,"addAddressRx":stats.frame_rx.add_address,
            "reachOutTx":stats.frame_tx.reach_out,"reachOutRx":stats.frame_rx.reach_out,
            "pathChallengeTx":stats.frame_tx.path_challenge,"pathChallengeRx":stats.frame_rx.path_challenge,
            "pathResponseTx":stats.frame_tx.path_response,"pathResponseRx":stats.frame_rx.path_response
        },
        "paths":connection.paths().iter().map(|path|json!({"relay":path.is_relay(),"selected":path.is_selected(),
            "address":path.remote_addr().to_string(),"latencyMs":path.rtt().as_millis() as u64})).collect::<Vec<_>>()
    })
}

impl RemoteService {
    pub async fn diagnostics(&self) -> Result<Value> {
        let (endpoint, connections, recent, proxy_source) = {
            let state = self.state.lock().unwrap();
            (state.endpoint.clone(),state.connections.values().map(connection_snapshot).collect::<Vec<_>>(),state.recent_connections.clone(),state.http_proxy_source)
        };
        let mut peers = Vec::new();
        if let Some(endpoint) = endpoint.as_ref() {
            for device in self.repo.devices()?.into_iter().take(32) {
                let Some(id) = device["id"].as_str().and_then(|value| value.parse::<iroh::EndpointId>().ok()) else { continue };
                if let Ok(Some(info)) = tokio::time::timeout(std::time::Duration::from_secs(2), endpoint.remote_info(id)).await {
                    peers.push(json!({"id":id.to_string(),"addresses":info.addrs().map(|addr|json!({
                        "address":addr.addr(),"usage":format!("{:?}",addr.usage())})).collect::<Vec<_>>()}));
                }
            }
        }
        Ok(json!({"at":crate::errors::now_iso(),"relayMode":self.settings()?.relay_mode,
            "httpProxySource":proxy_source,
            "endpoint":endpoint.as_ref().map(Endpoint::addr),"boundSockets":endpoint.as_ref().map(Endpoint::bound_sockets),
            "network":endpoint.as_ref().and_then(control::network_diagnostics),
            "connections":connections,"recentConnections":recent,"peers":peers}))
    }
}
