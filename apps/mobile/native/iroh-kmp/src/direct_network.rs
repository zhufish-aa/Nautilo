//! App-private Android UDP routing and same-socket discovery. The UniFFI ABI
//! stays unchanged; HTTP rendezvous retains the normal Android network route.
use std::{collections::BTreeSet, net::SocketAddr, sync::{LazyLock, Mutex, atomic::{AtomicBool, Ordering}}, time::{Duration, Instant}};
use iroh::Endpoint;
use jni::{JNIEnv, objects::{JObject, JObjectArray, JString}, sys::{jboolean, jlong}};

#[derive(Clone, Default, PartialEq, Eq)]
struct Selection { handle: u64, route: u64, servers: Vec<SocketAddr> }
static SELECTED: LazyLock<Mutex<Selection>> = LazyLock::new(|| Mutex::new(Selection::default()));
static UPDATED: LazyLock<tokio::sync::Notify> = LazyLock::new(tokio::sync::Notify::new);
static USING_DEFAULT: AtomicBool = AtomicBool::new(true);

#[no_mangle]
pub extern "system" fn Java_app_nautilo_mobile_transport_DirectNetworkRoute_configureNative(
    mut env: JNIEnv, _object: JObject, handle: jlong, route: jlong, servers: JObjectArray,
) -> jboolean {
    let result = (|| -> Result<Selection, jni::errors::Error> {
        let count = env.get_array_length(&servers)?.min(8);
        let mut values = Vec::new();
        for index in 0..count {
            let entry = JString::from(env.get_object_array_element(&servers, index)?);
            let text: String = env.get_string(&entry)?.into();
            if let Ok(address) = text.parse::<SocketAddr>() {
                if usable(address) { values.push(address); }
            }
        }
        values.sort(); values.dedup();
        Ok(Selection { handle: handle as u64, route: route as u64, servers: values })
    })();
    let Ok(selection) = result else { return 0 };
    let mut selected = SELECTED.lock().unwrap();
    if *selected != selection { *selected = selection; UPDATED.notify_one(); }
    1
}

#[no_mangle]
pub extern "system" fn Java_app_nautilo_mobile_transport_DirectNetworkRoute_usingDefaultNative(
    _env: JNIEnv, _object: JObject,
) -> jboolean { u8::from(USING_DEFAULT.load(Ordering::Acquire)) }

fn usable(address: SocketAddr) -> bool {
    let ip = address.ip();
    address.port() != 0 && !ip.is_unspecified() && !ip.is_loopback() && !ip.is_multicast() &&
        !matches!(ip, std::net::IpAddr::V4(ip) if ip.is_link_local() || (ip.octets()[0] == 198 && matches!(ip.octets()[1], 18 | 19)))
}

fn apply_network(endpoint: &Endpoint) -> std::io::Result<(Selection, u64)> {
    // Serialize marking all UDP sockets with configuration updates. A network
    // callback must not leave half the sockets on an older selected route.
    let selection = SELECTED.lock().unwrap();
    let handle = match endpoint.bind_android_network(selection.handle) {
        Ok(()) => {
            USING_DEFAULT.store(selection.handle == 0, Ordering::Release);
            selection.handle
        }
        Err(error) if selection.handle != 0 => {
            // Android can revoke bypass between the Java preflight and this
            // call. Clear every socket mark, including a partial dual-stack
            // bind, instead of closing an otherwise usable endpoint.
            endpoint.bind_android_network(0)?;
            USING_DEFAULT.store(true, Ordering::Release);
            eprintln!("Nautilo: physical UDP network unavailable ({error}); using Android's default route");
            0
        }
        Err(error) => return Err(error),
    };
    Ok((selection.clone(), handle))
}

pub(crate) fn bind_network(endpoint: &Endpoint) -> std::io::Result<()> {
    apply_network(endpoint)?;
    Ok(())
}

pub(crate) fn start(endpoint: Endpoint) {
    tokio::spawn(async move {
        let mut previous = BTreeSet::new();
        let mut previous_route = (0, 0);
        let mut last_success = None;
        loop {
            if endpoint.is_closed() { break; }
            let (selection, effective_handle) = match apply_network(&endpoint) {
                Ok(applied) => applied,
                Err(_) => {
                    tokio::select! { _ = UPDATED.notified() => (), _ = tokio::time::sleep(Duration::from_secs(1)) => () }
                    continue;
                }
            };
            let effective_route = (effective_handle, selection.route);
            if previous_route != effective_route {
                for address in &previous { endpoint.remove_external_addr(address).await; }
                previous.clear(); last_success = None; previous_route = effective_route;
            }
            let mut probes = tokio::task::JoinSet::new();
            for server in &selection.servers {
                let endpoint = endpoint.clone(); let server = *server;
                probes.spawn(async move { endpoint.probe_stun(server, Duration::from_secs(2)).await });
            }
            let mut current = BTreeSet::new();
            while let Some(result) = probes.join_next().await {
                if let Ok(mappings) = result {
                    current.extend(mappings.into_iter().map(|(_, address)| address).filter(|addr| usable(*addr)));
                }
            }
            if *SELECTED.lock().unwrap() != selection { continue; }
            if !current.is_empty() { last_success = Some(Instant::now()); }
            if !current.is_empty() || last_success.is_some_and(|at| at.elapsed() >= Duration::from_secs(45)) {
                for address in current.difference(&previous) { endpoint.add_external_addr(*address).await; }
                for address in previous.difference(&current) { endpoint.remove_external_addr(address).await; }
                previous = current;
            }
            tokio::select! { _ = UPDATED.notified() => (), _ = tokio::time::sleep(Duration::from_secs(15)) => () }
        }
    });
}
