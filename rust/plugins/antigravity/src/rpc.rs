//! A response is complete only after every preceding notification has been projected.
use agenthub_plugin_sdk::jsonrpc::JsonRpcClient;
use serde_json::Value;
use std::{
    collections::HashSet,
    ops::Deref,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};
use tokio::sync::Notify;

pub struct Client {
    inner: JsonRpcClient,
    projected: Mutex<HashSet<i64>>,
    changed: Notify,
    closed: AtomicBool,
}
impl Deref for Client {
    type Target = JsonRpcClient;
    fn deref(&self) -> &Self::Target {
        &self.inner
    }
}
impl Client {
    pub fn new(inner: JsonRpcClient) -> Self {
        Self {
            inner,
            projected: Default::default(),
            changed: Notify::new(),
            closed: AtomicBool::new(false),
        }
    }
    pub fn projected(&self, id: &Value) {
        if let Some(id) = id.as_i64() {
            self.projected.lock().unwrap().insert(id);
            self.changed.notify_waiters();
        }
    }
    pub fn closed(&self) {
        self.closed.store(true, Ordering::Release);
        self.changed.notify_waiters();
    }
    pub async fn request(&self, method: &str, params: Value) -> anyhow::Result<Value> {
        let (id, reply) = self.inner.request_with_id(method, params);
        let result = reply
            .await
            .map_err(|_| anyhow::anyhow!("Antigravity ACP transport closed"))?;
        loop {
            let changed = self.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if self.projected.lock().unwrap().remove(&id) {
                break;
            }
            anyhow::ensure!(
                !self.closed.load(Ordering::Acquire),
                "Antigravity ACP transport closed before its events were delivered"
            );
            changed.await;
        }
        result.map_err(anyhow::Error::msg)
    }
}
