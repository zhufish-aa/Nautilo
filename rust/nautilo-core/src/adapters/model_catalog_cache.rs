//! Short-lived successful catalog cache with shared in-flight discovery.
//! Keys are opaque hashes; credentials/environment values are never stored here.
use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use serde_json::Value;
use tokio::sync::watch;
use crate::errors::{AgentHubError, CoreError, CoreResult, ErrorCode};

type DiscoveryResult = Result<Value, AgentHubError>;
#[derive(Default)]
struct State {
    generation: u64,
    ready: HashMap<String, (Instant, Value)>,
    pending: HashMap<String, watch::Receiver<Option<DiscoveryResult>>>,
}
#[derive(Clone)]
pub struct ModelCatalogCache {
    state: Arc<Mutex<State>>,
    ttl: Duration,
    timeout: Duration,
}
impl Default for ModelCatalogCache {
    fn default() -> Self {
        Self { state: Arc::new(Mutex::new(State::default())), ttl: Duration::from_secs(30), timeout: Duration::from_secs(30) }
    }
}
impl ModelCatalogCache {
    pub fn clear(&self) {
        let mut state = self.state.lock().unwrap();
        state.generation += 1;
        state.ready.clear();
        state.pending.clear();
    }
    pub async fn get<F>(&self, key: String, force_refresh: bool, load: F) -> CoreResult<Value>
    where F: Future<Output = CoreResult<Value>> + Send + 'static {
        let mut receiver = {
            let mut state = self.state.lock().unwrap();
            if !force_refresh {
                if let Some((expires, value)) = state.ready.get(&key) {
                    if *expires > Instant::now() { return Ok(value.clone()); }
                }
            }
            state.ready.remove(&key);
            if let Some(receiver) = state.pending.get(&key) {
                receiver.clone()
            } else {
                let (sender, receiver) = watch::channel(None);
                state.pending.insert(key.clone(), receiver.clone());
                let generation = state.generation;
                let cache = self.clone();
                tokio::spawn(async move {
                    let result = match tokio::time::timeout(cache.timeout, load).await {
                        Ok(result) => result.map_err(|error| error.0),
                        Err(_) => Err(CoreError::reason(ErrorCode::IpcInternalError, "Model catalog discovery timed out").0),
                    };
                    {
                        let mut state = cache.state.lock().unwrap();
                        if state.generation == generation {
                            state.pending.remove(&key);
                            if let Ok(value) = &result {
                                let successful = value.get("source").and_then(Value::as_str) != Some("unavailable")
                                    && value.get("warning").and_then(Value::as_str).unwrap_or("").is_empty()
                                    && value.get("models").and_then(Value::as_array).is_some_and(|models| !models.is_empty());
                                if successful {
                                    state.ready.retain(|_, (expires, _)| *expires > Instant::now());
                                    if state.ready.len() >= 128 {
                                        if let Some(oldest) = state.ready.iter().min_by_key(|(_, (expires, _))| *expires).map(|(key, _)| key.clone()) {
                                            state.ready.remove(&oldest);
                                        }
                                    }
                                    state.ready.insert(key, (Instant::now() + cache.ttl, value.clone()));
                                }
                            }
                        }
                    }
                    let _ = sender.send(Some(result));
                });
                receiver
            }
        };
        loop {
            let result = receiver.borrow().clone();
            if let Some(result) = result { return result.map_err(CoreError); }
            receiver.changed().await.map_err(|_| CoreError::reason(ErrorCode::IpcInternalError, "Model discovery worker stopped"))?;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn catalog() -> Value { json!({ "source": "provider_cli", "models": [{ "id": "m" }] }) }

    #[tokio::test]
    async fn merges_requests_and_expires_successes() {
        let cache = ModelCatalogCache { ttl: Duration::from_millis(5), ..Default::default() };
        let calls = Arc::new(AtomicUsize::new(0));
        let first_calls = calls.clone();
        let first = cache.get("k".to_string(), false, async move {
            first_calls.fetch_add(1, Ordering::SeqCst);
            tokio::time::sleep(Duration::from_millis(10)).await;
            Ok(catalog())
        });
        let second_calls = calls.clone();
        let second = cache.get("k".to_string(), false, async move {
            second_calls.fetch_add(1, Ordering::SeqCst); Ok(catalog())
        });
        let (a, b) = tokio::join!(first, second);
        assert_eq!(a.unwrap(), b.unwrap());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        tokio::time::sleep(Duration::from_millis(10)).await;
        let next_calls = calls.clone();
        cache.get("k".to_string(), false, async move {
            next_calls.fetch_add(1, Ordering::SeqCst); Ok(catalog())
        }).await.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn failures_and_warnings_are_not_cached() {
        let cache = ModelCatalogCache::default();
        assert!(cache.get("k".to_string(), false, async {
            Err(CoreError::reason(ErrorCode::IpcInternalError, "test failure"))
        }).await.is_err());
        assert_eq!(cache.get("k".to_string(), false, async { Ok(catalog()) }).await.unwrap(), catalog());
        cache.clear();
        cache.get("k".to_string(), false, async { Ok(json!({ "source": "provider_cli", "models": [{ "id": "old" }], "warning": "fallback" })) }).await.unwrap();
        assert_eq!(cache.get("k".to_string(), false, async { Ok(catalog()) }).await.unwrap(), catalog());
    }
}
