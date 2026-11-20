//! Process-lifetime counters, scoped to an exact MCP configuration identity.
//! No environment, paths, arguments or wire payloads enter request diagnostics.
use serde_json::{json, Value};
use std::sync::{atomic::{AtomicU64, Ordering}, Mutex};
use std::time::Instant;

#[derive(Default)]
pub(super) struct Metrics {
    connections: AtomicU64,
    handshakes: AtomicU64,
    hits: AtomicU64,
    handshake_ms: Mutex<Option<u64>>,
}
impl Metrics {
    pub fn connected(&self) { self.connections.fetch_add(1, Ordering::Relaxed); }
    pub fn hit(&self) { self.hits.fetch_add(1, Ordering::Relaxed); }
    pub fn starting(&self) { self.handshakes.fetch_add(1, Ordering::Relaxed); }
    pub fn initialized(&self, started: Instant) {
        *self.handshake_ms.lock().unwrap() = Some(started.elapsed().as_millis().min(u64::MAX as u128) as u64);
    }
    pub fn snapshot(&self, pid: Option<u32>, shared: bool) -> Value {
        json!({"pid":pid,"shared":shared,"connections":self.connections.load(Ordering::Relaxed),
            "initializations":self.handshakes.load(Ordering::Relaxed),"handshakeHits":self.hits.load(Ordering::Relaxed),
            "initializeMs":*self.handshake_ms.lock().unwrap()})
    }
}

pub struct Binding {
    pub(super) name: String,
    pub(super) prefix: String,
    pub(super) existing_pids: Vec<u32>,
}
