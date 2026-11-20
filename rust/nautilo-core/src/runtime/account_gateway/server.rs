//! One private loopback API for every account binding in this daemon.
use super::{http::{error, read_http}, Route};
use crate::errors::{invalid, CoreResult};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, Weak},
};
use tokio::{net::{TcpListener, TcpStream}, task::JoinHandle};

type Bindings = Arc<Mutex<HashMap<String, Weak<Route>>>>;

pub(super) struct GatewayServer {
    pub url: String,
    bindings: Bindings,
    accept: JoinHandle<()>,
}

impl GatewayServer {
    pub(super) async fn open() -> CoreResult<Self> {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .map_err(|e| invalid("gateway", &e.to_string()))?;
        let address = listener.local_addr().map_err(|e| invalid("gateway", &e.to_string()))?;
        let bindings = Bindings::default();
        let active_bindings = bindings.clone();
        let accept = tokio::spawn(async move {
            while let Ok((socket, _)) = listener.accept().await {
                let bindings = active_bindings.clone();
                tokio::spawn(async move {
                    let _ = serve(socket, &bindings).await;
                });
            }
        });
        Ok(Self { url: format!("http://{address}/v1"), bindings, accept })
    }

    pub(super) fn register(&self, route: &Arc<Route>) {
        self.bindings.lock().unwrap().insert(route.key.clone(), Arc::downgrade(route));
    }
}

impl Drop for GatewayServer {
    fn drop(&mut self) {
        self.accept.abort();
    }
}

async fn serve(mut socket: TcpStream, bindings: &Bindings) -> anyhow::Result<()> {
    let Ok((path, authorization, body)) = read_http(&mut socket).await else {
        return error(&mut socket, 400, "INVALID_GATEWAY_REQUEST", "Malformed or oversized HTTP request").await;
    };
    // Pin the route at admission. A later account selection only supplies a
    // different key; any admitted and background calls keep their own binding.
    let route = authorization.strip_prefix("Bearer ").and_then(|key| {
        bindings.lock().unwrap().get(key).and_then(Weak::upgrade)
    });
    match route {
        Some(route) => route.serve(socket, &path, body).await,
        None => error(&mut socket, 401, "GATEWAY_AUTH_REQUIRED", "Invalid local gateway credential").await,
    }
}
