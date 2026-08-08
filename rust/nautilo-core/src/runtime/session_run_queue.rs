//! Per-session turn serializer — port of runtime/session-run-queue.ts.
//! Turns of one session run sequentially; different sessions run in parallel.
//! A keyed entry still waiting can be withdrawn via cancel_pending.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use tokio::sync::watch;

/// Completion signal of a turn: fires when the turn settles.
pub type Completion = watch::Receiver<bool>;

/// The launch result produced once a queued turn actually starts.
pub type LaunchResult = Result<(String, Completion), String>;

#[derive(Default)]
pub struct SessionRunQueue {
    tails: Mutex<HashMap<String, watch::Receiver<bool>>>,
    pending_keys: Mutex<HashMap<String, HashSet<String>>>,
}

impl SessionRunQueue {
    /// Enqueues a turn for the session. `start` runs after the previous turn
    /// settled; its completion receiver becomes the tail the next turn waits
    /// on. A withdrawn keyed entry never runs `start`.
    pub async fn enqueue_launch<F, Fut>(&self, session_id: &str, key: Option<&str>, start: F)
    where
        F: FnOnce() -> Fut + Send,
        Fut: std::future::Future<Output = LaunchResult> + Send,
    {
        if let Some(key) = key {
            self.pending_keys
                .lock()
                .unwrap()
                .entry(session_id.to_string())
                .or_default()
                .insert(key.to_string());
        }
        let previous = self.tails.lock().unwrap().get(session_id).cloned();
        if let Some(mut previous) = previous {
            let _ = previous.wait_for(|settled| *settled).await;
        }
        if let Some(key) = key {
            if !self.cancel_pending(session_id, key) {
                return; // withdrawn while queued; never starts
            }
        }
        let (tail_sender, tail) = watch::channel(false);
        self.tails.lock().unwrap().insert(session_id.to_string(), tail.clone());
        match start().await {
            Ok((_run_id, mut completion)) => {
                tokio::spawn(async move {
                    let _ = completion.wait_for(|settled| *settled).await;
                    let _ = tail_sender.send(true);
                });
            }
            Err(_) => {
                // A failed launch still settles the tail so queued follow-ups proceed.
                let _ = tail_sender.send(true);
            }
        }
    }

    /// Withdraws a keyed entry that has not started yet. Returns false when
    /// the key is unknown or its turn already began.
    pub fn cancel_pending(&self, session_id: &str, key: &str) -> bool {
        let mut pending = self.pending_keys.lock().unwrap();
        let Some(keys) = pending.get_mut(session_id) else {
            return false;
        };
        if !keys.remove(key) {
            return false;
        }
        if keys.is_empty() {
            pending.remove(session_id);
        }
        true
    }

    pub fn busy(&self, session_id: &str) -> bool {
        self.tails.lock().unwrap().contains_key(session_id)
    }
}
