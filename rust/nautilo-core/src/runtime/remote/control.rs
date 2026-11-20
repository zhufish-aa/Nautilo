//! A fixed, bounded control plane. No workspace data or RPCs are accepted here.
use super::*;
pub(super) const POLICY_PREFIX: &[u8] = b"nautilo/transport/v1:";

pub(super) fn network_diagnostics(endpoint: &Endpoint, discovery: &direct_network::Discovery) -> Option<Value> {
    let report = endpoint.net_report().get();
    if report.is_none() && discovery.updated_at.is_none() { return None; }
    Some(json!({
        "udpV4":report.as_ref().is_some_and(|r|r.udp_v4) || discovery.mappings.iter().any(|address|address.is_ipv4()),
        "udpV6":report.as_ref().is_some_and(|r|r.udp_v6) || discovery.mappings.iter().any(|address|address.is_ipv6()),
        "mappingVariesV4":report.as_ref().and_then(|r|r.mapping_varies_by_dest_ipv4),
        "mappingVariesV6":report.as_ref().and_then(|r|r.mapping_varies_by_dest_ipv6)
    }))
}

impl RemoteService {
    pub(super) fn transport_policy_reply(&self, packet: &[u8]) -> Result<Option<Vec<u8>>> {
        let Some(nonce) = packet.strip_prefix(POLICY_PREFIX).filter(|n| n.len() == 32 && n.iter().all(u8::is_ascii_hexdigit)) else { return Ok(None) };
        let settings = self.settings()?;
        let state = self.state.lock().unwrap();
        let Some(endpoint) = state.endpoint.as_ref() else { return Ok(None) };
        let mut address = serde_json::to_value(endpoint.addr())?;
        if let Some(addrs) = address["addrs"].as_array_mut() {
            addrs.sort_by_key(|value| if value.get("Relay").is_some() { 0 } else { 1 });
            addrs.truncate(8);
        }
        let mut response = json!({
            "type":"nautilo.transport","v":1,"nonce":std::str::from_utf8(nonce)?,
            "relayMode":settings.relay_mode,"directOnly":settings.relay_mode == "direct",
            "endpoint":address,"network":network_diagnostics(endpoint, &state.direct_discovery)
        });
        // Long custom URLs or many adapters must not break policy negotiation.
        // Full addressing is refreshed over the RPC channel after it is ready.
        loop {
            let bytes = serde_json::to_vec(&response)?;
            if bytes.len() <= 1100 { return Ok(Some(bytes)); }
            if response["endpoint"]["addrs"].as_array_mut().and_then(Vec::pop).is_none() { bail!("TRANSPORT_METADATA_TOO_LARGE"); }
        }
    }
}
