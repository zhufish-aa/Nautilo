//! A native process has one ordered reader, including between foreground turns.
use crate::process::ProcessEvent;
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
};
use tokio::sync::mpsc;

pub type ProcessObserver = Arc<dyn Fn(ProcessEvent) + Send + Sync>;
impl From<mpsc::UnboundedReceiver<ProcessEvent>> for ProcessEvents {
    fn from(receiver: mpsc::UnboundedReceiver<ProcessEvent>) -> Self {
        Self::new(receiver)
    }
}

#[derive(Clone)]
pub struct ProcessEvents {
    receiver: Arc<tokio::sync::Mutex<mpsc::UnboundedReceiver<ProcessEvent>>>,
    carry: Arc<Mutex<VecDeque<Fragment>>>,
    observer: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
}
struct Fragment {
    text: String,
    owner: ProcessObserver,
}
struct PartialLine {
    fragment: Fragment,
    carry: Arc<Mutex<VecDeque<Fragment>>>,
}
impl Drop for PartialLine {
    fn drop(&mut self) {
        if !self.fragment.text.is_empty() {
            self.carry.lock().unwrap().push_front(Fragment {
                text: std::mem::take(&mut self.fragment.text),
                owner: self.fragment.owner.clone(),
            });
        }
    }
}
impl ProcessEvents {
    pub fn new(receiver: mpsc::UnboundedReceiver<ProcessEvent>) -> Self {
        Self {
            receiver: Arc::new(tokio::sync::Mutex::new(receiver)),
            carry: Arc::new(Mutex::new(VecDeque::new())),
            observer: Arc::new(Mutex::new(None)),
        }
    }
    pub fn activate(&self) {
        if let Some(task) = self.observer.lock().unwrap().take() {
            task.abort();
        }
    }
    pub async fn pause(&self) {
        self.activate();
        drop(self.receiver.lock().await);
    }
    pub async fn recv(&mut self) -> Option<ProcessEvent> {
        self.activate();
        let mut receiver = self.receiver.lock().await;
        let fragment = self.carry.lock().unwrap().pop_front();
        if let Some(fragment) = fragment {
            let mut line = PartialLine {
                fragment,
                carry: self.carry.clone(),
            };
            loop {
                if let Some(end) = line.fragment.text.find('\n') {
                    (line.fragment.owner)(ProcessEvent::Stdout(
                        line.fragment.text.drain(..=end).collect(),
                    ));
                    if !line.fragment.text.is_empty() {
                        return Some(ProcessEvent::Stdout(std::mem::take(
                            &mut line.fragment.text,
                        )));
                    }
                    break;
                }
                match receiver.recv().await {
                    Some(ProcessEvent::Stdout(text)) => {
                        line.fragment.text.push_str(&text);
                        if line.fragment.text.len() > 64 * 1024 * 1024 {
                            return Some(ProcessEvent::Error("Native frame exceeds 64 MiB".into()));
                        }
                    }
                    Some(event @ ProcessEvent::Exit { .. }) => {
                        (line.fragment.owner)(ProcessEvent::Stdout(std::mem::take(
                            &mut line.fragment.text,
                        )));
                        return Some(event);
                    }
                    Some(event) => (line.fragment.owner)(event),
                    None => return None,
                }
            }
        }
        receiver.recv().await
    }
    pub fn observe_idle(&self, observer: ProcessObserver) {
        self.observe_idle_with_pending(observer, String::new());
    }
    /// Preserve every byte after the terminal frame in its OS read, and keep a
    /// split background frame with its original owner across the next turn.
    pub fn observe_idle_with_pending(&self, observer: ProcessObserver, pending: String) {
        self.activate();
        if !pending.is_empty() {
            self.carry.lock().unwrap().push_back(Fragment {
                text: pending,
                owner: observer.clone(),
            });
        }
        let receiver = self.receiver.clone();
        let carry = self.carry.clone();
        let task = tokio::spawn(async move {
            let mut receiver = receiver.lock().await;
            let fragment = carry
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or_else(|| Fragment {
                    text: String::new(),
                    owner: observer.clone(),
                });
            let mut line = PartialLine {
                fragment,
                carry: carry.clone(),
            };
            loop {
                while let Some(end) = line.fragment.text.find('\n') {
                    (line.fragment.owner)(ProcessEvent::Stdout(
                        line.fragment.text.drain(..=end).collect(),
                    ));
                    line.fragment.owner = observer.clone();
                }
                if line.fragment.text.is_empty() {
                    let next = carry.lock().unwrap().pop_front();
                    if let Some(next) = next {
                        line.fragment = next;
                        continue;
                    }
                }
                let Some(event) = receiver.recv().await else {
                    break;
                };
                match event {
                    ProcessEvent::Stdout(text) => {
                        line.fragment.text.push_str(&text);
                        if line.fragment.text.len() > 64 * 1024 * 1024 {
                            observer(ProcessEvent::Error(
                                "Native background frame exceeds 64 MiB".into(),
                            ));
                            break;
                        }
                    }
                    ProcessEvent::Exit { .. } => {
                        if !line.fragment.text.is_empty() {
                            (line.fragment.owner)(ProcessEvent::Stdout(std::mem::take(
                                &mut line.fragment.text,
                            )));
                        }
                        observer(event);
                        break;
                    }
                    other => observer(other),
                }
            }
        });
        *self.observer.lock().unwrap() = Some(task);
    }
}
impl Drop for ProcessEvents {
    fn drop(&mut self) {
        if Arc::strong_count(&self.observer) == 1 {
            self.activate();
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn idle_delivery_and_partial_frame_keep_their_original_owner() {
        let (tx, rx) = mpsc::unbounded_channel();
        let mut events = ProcessEvents::new(rx);
        let seen = Arc::new(Mutex::new(Vec::new()));
        let output = seen.clone();
        events.observe_idle_with_pending(
            Arc::new(move |event| {
                if let ProcessEvent::Stdout(text) = event {
                    output.lock().unwrap().push(text);
                }
            }),
            "first\npar".into(),
        );
        tokio::task::yield_now().await;
        assert_eq!(*seen.lock().unwrap(), vec!["first\n"]);
        events.activate();
        tx.send(ProcessEvent::Stdout("tial\nnew turn\n".into()))
            .unwrap();
        assert!(
            matches!(events.recv().await, Some(ProcessEvent::Stdout(text)) if text=="new turn\n")
        );
        assert_eq!(*seen.lock().unwrap(), vec!["first\n", "partial\n"]);
    }
    #[tokio::test]
    async fn cancelled_receive_does_not_lose_a_background_fragment() {
        let (tx, rx) = mpsc::unbounded_channel();
        let mut events = ProcessEvents::new(rx);
        let seen = Arc::new(Mutex::new(Vec::new()));
        let output = seen.clone();
        events.observe_idle_with_pending(
            Arc::new(move |event| {
                if let ProcessEvent::Stdout(text) = event {
                    output.lock().unwrap().push(text);
                }
            }),
            "par".into(),
        );
        tokio::task::yield_now().await;
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(5), events.recv())
                .await
                .is_err()
        );
        tx.send(ProcessEvent::Stdout("tial\nforeground\n".into()))
            .unwrap();
        assert!(
            matches!(events.recv().await, Some(ProcessEvent::Stdout(text)) if text=="foreground\n")
        );
        assert_eq!(*seen.lock().unwrap(), vec!["partial\n"]);
    }
}
