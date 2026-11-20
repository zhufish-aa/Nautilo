# Direct connection discovery

In `direct` mode the desktop enumerates live physical network interfaces using
native OS APIs and binds QUIC candidates to those source addresses. This avoids
mistaking a TUN/fake-IP route for the user's broadband UDP route. It does not
change system routes, firewall rules, the HTTP proxy, account data, or the saved
transport mode. Interface changes rebuild the remote endpoint with the same
identity so the phone can reconnect.

Iroh QAD remains enabled. RFC 5389 STUN Binding probes additionally run against
Cloudflare and Google from the **same UDP sockets that carry QUIC**. A separate
socket's public port is never advertised. Responses must match a fresh
transaction ID and the requested server address. If system DNS supplies a
fake-IP destination, only the fixed public discovery hostnames are resolved
through HTTPS DNS using the existing HTTP proxy policy.

Discovery runs in the background without delaying endpoint binding. Mappings
refresh every 15 seconds. Failed refreshes have a 45-second grace period before
stale candidates are withdrawn. `remote.diagnostics` reports bound physical
interfaces, observed mappings, update time and discovery failure state. The
policy datagram sends only bounded reachability flags, not local interface
details. A public mapping proves a discovery response, **not** a successful peer
path. Device cards still use the selected QUIC path for direct/relay and RTT.
Direct-only business STREAM filtering is unchanged.

Android ranks physical Wi-Fi, Ethernet and cellular Networks, then checks whether
the app's UID can actually bind a temporary UDP socket to each candidate. This
check sends no packets. Only Iroh's UDP sockets bind to an allowed Network with
android_setsocknetwork; the process default and HTTP rendezvous route stay
unchanged. The binding survives socket recovery. If no physical binding is
allowed, APK 0.1.15 uses handle 0 (the app's system route), including a VPN when
Android requires it. A binding permission revoked after preflight also clears
all socket marks and retains the endpoint rather than aborting connection.

STUN hostnames resolve on the selected route's Network, and mappings refresh on
the same QUIC sockets. Default-network and physical-network changes reselect the
route, rebind sockets and discard old mappings. The connection card identifies
a VPN-restricted system route, and failures explain how to exclude Nautilo
(`app.nautilo.mobile`) or allow VPN bypass. Domain DIRECT rules cannot grant
Android's per-socket bypass permission. System-route fallback does not establish
that the VPN forwards UDP, preserves NAT mappings or provides low latency.
The selected desktop mode and direct-only business STREAM filtering are unchanged.

## Manual diagnostic

```powershell
cargo run -p nautilo-core --example direct_network_probe -- <local-ip> <relay-host> <current-relay-ip> <stun-ip:port>
```

This uses a disposable identity without modifying saved settings. Use current
DNS answers; production code pins no public server IP. A same-socket regression
checks source-port reuse and rejection of wrong transaction/source responses.
Physical two-network connection success and RTT still require the real phone
and PC; a local regression or STUN response alone does not establish that result.
