//! Per-session turn serializer — port of runtime/session-run-queue.ts.
//! Turns of one session run sequentially; different sessions run in parallel.
//! A keyed entry still waiting can be withdrawn via cancel_pending.

use std::collections::HashMap;
use std::sync::Mutex;

use tokio::sync::watch;

/// Completion signal of a turn: fires when the turn settles.
pub type Completion = watch::Receiver<bool>;

/// The launch result produced once a queued turn actually starts.
pub type LaunchResult = Result<(String, Completion), String>;

enum PendingTurn {
    Queued,
    Promoting(Completion),
}

#[derive(Default)]
pub struct SessionRunQueue {
    tails: Mutex<HashMap<String, watch::Receiver<bool>>>,
    pending_keys: Mutex<HashMap<String, HashMap<String, PendingTurn>>>,
}

struct PromotionGuard<'a> {
    queue: &'a SessionRunQueue,
    session_id: &'a str,
    key: &'a str,
    accepted: bool,
    _release: watch::Sender<bool>,
}

impl Drop for PromotionGuard<'_> {
    fn drop(&mut self) {
        let mut pending = self.queue.pending_keys.lock().unwrap();
        if let Some(keys) = pending.get_mut(self.session_id) {
            if self.accepted { keys.remove(self.key); }
            else { keys.insert(self.key.to_string(), PendingTurn::Queued); }
            if keys.is_empty() { pending.remove(self.session_id); }
        }
        // Dropping the sender releases a waiting launch even if this future
        // was cancelled. Failed guidance keeps the original queue position.
    }
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
                .insert(key.to_string(), PendingTurn::Queued);
        }
        // Reserve this turn's place before waiting. Otherwise every follow-up
        // queued behind an active turn observes the same tail and they all
        // launch together when that turn settles.
        let (tail_sender, tail) = watch::channel(false);
        let previous = self.tails.lock().unwrap().insert(session_id.to_string(), tail);
        if let Some(mut previous) = previous {
            let _ = previous.wait_for(|settled| *settled).await;
        }
        if let Some(key) = key {
            loop {
                match self.claim_pending(session_id, key) {
                    Ok(None) => break,
                    Ok(Some(mut held)) => { let _ = held.wait_for(|ready| *ready).await; }
                    Err(()) => {
                        let _ = tail_sender.send(true);
                        return; // withdrawn or delivered as guidance; never starts
                    }
                }
            }
        }
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
        matches!(self.claim_pending(session_id, key), Ok(None))
    }

    fn claim_pending(&self, session_id: &str, key: &str) -> Result<Option<Completion>, ()> {
        let mut pending = self.pending_keys.lock().unwrap();
        let Some(keys) = pending.get_mut(session_id) else {
            return Err(());
        };
        match keys.get(key) {
            Some(PendingTurn::Queued) => {},
            Some(PendingTurn::Promoting(held)) => return Ok(Some(held.clone())),
            None => return Err(()),
        }
        keys.remove(key);
        if keys.is_empty() {
            pending.remove(session_id);
        }
        Ok(None)
    }

    pub async fn promote_pending<F, Fut, E>(&self, session_id: &str, key: &str, steer: F) -> Result<bool, E>
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = Result<(), E>>,
    {
        let (release, held) = watch::channel(false);
        {
            let mut pending = self.pending_keys.lock().unwrap();
            let Some(keys) = pending.get_mut(session_id) else { return Ok(false); };
            if !matches!(keys.get(key), Some(PendingTurn::Queued)) { return Ok(false); }
            keys.insert(key.to_string(), PendingTurn::Promoting(held));
        }
        let mut guard = PromotionGuard { queue: self, session_id, key, accepted: false, _release: release };
        steer().await?;
        guard.accepted = true;
        Ok(true)
    }

    pub fn busy(&self, session_id: &str) -> bool {
        self.tails.lock().unwrap().get(session_id).is_some_and(|tail| !*tail.borrow())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::time::Duration;
    use tokio::sync::mpsc;
    use tokio::time::timeout;

    async fn next_launch(receiver: &mut mpsc::UnboundedReceiver<usize>) -> usize {
        timeout(Duration::from_secs(2), receiver.recv()).await.unwrap().unwrap()
    }

    #[tokio::test]
    async fn multiple_follow_ups_wait_for_each_predecessor_and_other_sessions_still_run() {
        let queue = Arc::new(SessionRunQueue::default());
        let (started, mut launches) = mpsc::unbounded_channel();
        let (finish_first, first_done) = watch::channel(false);
        let first_started = started.clone();
        queue.enqueue_launch("main", None, move || async move {
            first_started.send(1).unwrap();
            Ok(("first".into(), first_done))
        }).await;
        assert_eq!(next_launch(&mut launches).await, 1);

        let (finish_second, second_done) = watch::channel(false);
        let second_queue = queue.clone();
        let second_started = started.clone();
        let second = tokio::spawn(async move {
            second_queue.enqueue_launch("main", Some("second"), move || async move {
                second_started.send(2).unwrap();
                Ok(("second".into(), second_done))
            }).await;
        });
        // Polling each enqueue to its first await establishes its queue order.
        tokio::task::yield_now().await;
        let (finish_third, third_done) = watch::channel(false);
        let third_queue = queue.clone();
        let third_started = started.clone();
        let third = tokio::spawn(async move {
            third_queue.enqueue_launch("main", Some("third"), move || async move {
                third_started.send(3).unwrap();
                Ok(("third".into(), third_done))
            }).await;
        });
        tokio::task::yield_now().await;
        let (_finish_other, other_done) = watch::channel(true);
        queue.enqueue_launch("other", None, move || async move {
            started.send(4).unwrap();
            Ok(("other".into(), other_done))
        }).await;
        assert_eq!(next_launch(&mut launches).await, 4);
        assert!(launches.try_recv().is_err());

        finish_first.send(true).unwrap();
        assert_eq!(next_launch(&mut launches).await, 2);
        assert!(timeout(Duration::from_millis(25), launches.recv()).await.is_err());
        finish_second.send(true).unwrap();
        assert_eq!(next_launch(&mut launches).await, 3);
        finish_third.send(true).unwrap();
        second.await.unwrap();
        third.await.unwrap();
    }

    #[tokio::test]
    async fn promotion_holds_launch_and_retains_the_original_turn_on_failure() {
        for accepted in [true, false] {
            let queue = Arc::new(SessionRunQueue::default());
            let (finish_main, main_done) = watch::channel(false);
            queue.enqueue_launch("main", None, || async { Ok(("main".into(), main_done)) }).await;
            let (launched, mut launches) = mpsc::unbounded_channel();
            let child_queue = queue.clone();
            let queued = tokio::spawn(async move {
                child_queue.enqueue_launch("main", Some("follow-up"), || async {
                    launched.send(1).unwrap();
                    let (_, done) = watch::channel(true);
                    Ok(("follow-up".into(), done))
                }).await;
            });
            tokio::task::yield_now().await;
            let (steering, entered) = tokio::sync::oneshot::channel();
            let (ack, response) = tokio::sync::oneshot::channel();
            let promoting_queue = queue.clone();
            let promotion = tokio::spawn(async move {
                promoting_queue.promote_pending("main", "follow-up", || async {
                    steering.send(()).unwrap();
                    response.await.unwrap();
                    if accepted { Ok(()) } else { Err("native rejection") }
                }).await
            });
            entered.await.unwrap();
            assert!(!queue.cancel_pending("main", "follow-up"));
            finish_main.send(true).unwrap();
            assert!(timeout(Duration::from_millis(25), launches.recv()).await.is_err());
            ack.send(()).unwrap();
            let result = promotion.await.unwrap();
            if accepted { assert_eq!(result, Ok(true)); }
            else { assert_eq!(result, Err("native rejection")); }
            timeout(Duration::from_secs(2), queued).await.unwrap().unwrap();
            if accepted { assert!(launches.try_recv().is_err()); }
            else { assert_eq!(launches.try_recv().unwrap(), 1); }
        }
    }

    #[tokio::test]
    async fn cancelled_and_failed_turns_release_their_reserved_slots() {
        let queue = Arc::new(SessionRunQueue::default());
        let (finish_first, first_done) = watch::channel(false);
        queue.enqueue_launch("main", None, move || async move {
            Ok(("first".into(), first_done))
        }).await;
        let cancelled_queue = queue.clone();
        let cancelled = tokio::spawn(async move {
            cancelled_queue.enqueue_launch("main", Some("withdraw"), || async {
                panic!("withdrawn turn must not launch");
            }).await;
        });
        tokio::task::yield_now().await;
        let failed_queue = queue.clone();
        let failed = tokio::spawn(async move {
            failed_queue.enqueue_launch("main", None, || async { Err("launch failed".into()) }).await;
        });
        tokio::task::yield_now().await;
        assert!(queue.cancel_pending("main", "withdraw"));
        finish_first.send(true).unwrap();
        timeout(Duration::from_secs(2), cancelled).await.unwrap().unwrap();
        timeout(Duration::from_secs(2), failed).await.unwrap().unwrap();
        assert!(!queue.busy("main"));
        let (_finish, done) = watch::channel(true);
        timeout(Duration::from_secs(2), queue.enqueue_launch("main", None, || async {
            Ok(("after-failure".into(), done))
        })).await.unwrap();
    }
}
