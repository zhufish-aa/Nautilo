use super::{events, Native};
use agenthub_plugin_sdk::DaemonChannel;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::mpsc;

#[derive(Clone)]
pub struct RunRoute {
    pub run_id: String,
    target: Arc<Mutex<RouteTarget>>,
    activity: Arc<Mutex<TurnActivity>>,
}

struct RouteTarget {
    foreground: Option<mpsc::UnboundedSender<Value>>,
    background: Option<mpsc::UnboundedSender<Value>>,
    foreground_channel: Option<Arc<dyn DaemonChannel>>,
    session_channel: Option<Arc<dyn DaemonChannel>>,
}

struct TurnActivity {
    last_output: Instant,
    output_bytes: usize,
}

impl RunRoute {
    pub fn new(
        run_id: String,
        output: mpsc::UnboundedSender<Value>,
        foreground_channel: Option<Arc<dyn DaemonChannel>>,
        background: Option<mpsc::UnboundedSender<Value>>,
        session_channel: Option<Arc<dyn DaemonChannel>>,
    ) -> Self {
        Self {
            run_id,
            target: Arc::new(Mutex::new(RouteTarget {
                foreground: Some(output),
                background,
                foreground_channel,
                session_channel,
            })),
            activity: Arc::new(Mutex::new(TurnActivity {
                last_output: Instant::now(),
                output_bytes: 0,
            })),
        }
    }

    pub fn park(&self) {
        let mut target = self.target.lock().unwrap();
        target.foreground = None;
        target.foreground_channel = None;
    }

    pub fn is_foreground(&self) -> bool {
        self.target.lock().unwrap().foreground.is_some()
    }

    pub fn emit(&self, event: Value) {
        let target = self.target.lock().unwrap();
        if let Some(output) = target.foreground.as_ref().or(target.background.as_ref()) {
            let _ = output.send(event);
        }
    }

    pub fn channel(&self, child: bool) -> Option<Arc<dyn DaemonChannel>> {
        let target = self.target.lock().unwrap();
        // A child's question can outlive its parent's turn even when it was
        // asked before the parent settled. Bind it to the session immediately.
        if child || target.foreground.is_none() {
            target.session_channel.clone()
        } else {
            target.foreground_channel.clone()
        }
    }

    pub fn activity(&self, bytes: usize) {
        if self.is_foreground() {
            let mut activity = self.activity.lock().unwrap();
            activity.last_output = Instant::now();
            activity.output_bytes = activity.output_bytes.saturating_add(bytes);
        }
    }
}

/// The native reader remains the sole owner of parsing and routing across
/// turns. Child sessions and streamed attempts retain the route that created
/// them, rather than inheriting whichever foreground turn happens to be open.
#[derive(Default)]
pub struct SessionRoutes {
    current: Option<RunRoute>,
    parser: events::Events,
    children: HashMap<String, RunRoute>,
    attempts: HashMap<String, RunRoute>,
}

impl SessionRoutes {
    pub fn begin(&mut self, route: RunRoute, root: &str) {
        self.parser.begin_turn(root);
        self.current = Some(route);
    }

    pub fn park(&self) {
        if let Some(route) = &self.current {
            route.park();
        }
    }

    pub fn owner(&self, frame: &Value, root: &str) -> Option<RunRoute> {
        let session = frame["sessionId"].as_str().unwrap_or(root);
        if session != root {
            return self.children.get(session).cloned();
        }
        frame
            .pointer("/frame/attemptId")
            .and_then(Value::as_str)
            .and_then(|id| self.attempts.get(id))
            .cloned()
            .or_else(|| self.current.clone())
    }

    pub fn accept(&mut self, frame: &Value, root: &str, bytes: usize) {
        let owner = if frame["kind"] == "child" {
            let Some(child) = frame["childSessionId"].as_str() else {
                return;
            };
            let parent = frame["parentSessionId"].as_str().unwrap_or("");
            let owner = self.children.get(child).cloned().or_else(|| {
                if parent == root {
                    self.current.clone()
                } else {
                    self.children.get(parent).cloned()
                }
            });
            if let Some(owner) = &owner {
                self.children.insert(child.into(), owner.clone());
            }
            owner
        } else {
            self.owner(frame, root)
        };
        let Some(owner) = owner else { return };
        owner.activity(bytes);
        if let Some(attempt) = frame.pointer("/frame/attemptId").and_then(Value::as_str) {
            self.attempts
                .entry(attempt.into())
                .or_insert_with(|| owner.clone());
        }
        for event in self.parser.parse(frame, root) {
            owner.emit(event);
        }
    }

    pub fn emit(&self, event: Value) {
        if let Some(route) = &self.current {
            route.emit(event);
        }
    }

    pub fn close(&mut self, exit: Value) {
        if let Some(route) = &self.current {
            // Foreground completion owns its own exit frame. An idle native
            // exit must not reopen or fail the already completed parent run.
            if !route.is_foreground() {
                route.emit(exit);
            }
        }
        self.current = None;
        self.children.clear();
        self.attempts.clear();
    }
}

pub struct IdleRuntime {
    pub native: Native,
    pub identity: Value,
    pub provider: Option<String>,
    pub model: Option<String>,
}

#[derive(Default)]
pub struct RuntimePool {
    entries: HashMap<String, IdleRuntime>,
    closed: bool,
}

impl RuntimePool {
    pub fn take(&mut self, session: &str) -> Option<IdleRuntime> {
        self.entries.remove(session)
    }

    pub fn release(&mut self, session: &str) -> Option<Native> {
        self.take(session).map(|entry| entry.native)
    }

    pub fn drain(&mut self) -> Vec<Native> {
        self.closed = true;
        self.entries
            .drain()
            .map(|(_, entry)| entry.native)
            .collect()
    }
}

/// Reuse only the same native session and unchanged connection/resources.
/// Credentials stay in memory; this identity must never be logged.
pub fn identity(request: &Value) -> Value {
    json!({
        "instance": request["instance"], "cwd": request["cwd"], "env": request["env"],
        "skills": request["skills"], "mcpServers": request["mcpServers"],
        "runtimeTools": request["runtimeTools"], "agentMode": request["agentMode"],
        "model": request["model"]
    })
}

pub fn retain(pool: &Arc<Mutex<RuntimePool>>, session: String, entry: IdleRuntime) {
    let mut retired = vec![];
    {
        let mut pool = pool.lock().unwrap();
        if pool.closed {
            retired.push(entry.native);
        } else {
            if let Some(previous) = pool.entries.insert(session.clone(), entry) {
                retired.push(previous.native);
            }
        }
    }
    for native in retired {
        tokio::spawn(async move {
            native.close().await;
        });
    }
    // A quiet main agent is not proof that its children or promoted jobs are
    // finished. Retire only on explicit release, configuration change or unload.
}

impl Native {
    pub fn next_turn(self, route: RunRoute) -> Self {
        let root = self.session.lock().unwrap().clone();
        self.routes.lock().unwrap().begin(route, &root);
        Self {
            // Old steering/cancellation references must never open admission
            // into a later turn. Only the process and transport are shared.
            opened: tokio::sync::watch::channel(false).0,
            ending: Arc::new(AtomicBool::new(false)),
            cancelled: Arc::new(AtomicBool::new(false)),
            guidance: Arc::new(AtomicU64::new(0)),
            admission: Arc::new(tokio::sync::Mutex::new(())),
            ..self
        }
    }

    pub fn activity(&self, bytes: usize) {
        if let Some(route) = &self.routes.lock().unwrap().current {
            route.activity(bytes);
        }
    }

    pub fn emit(&self, event: Value) {
        self.routes.lock().unwrap().emit(event);
    }

    pub fn turn_error(&self, request: &Value, started: Instant) -> Option<anyhow::Error> {
        let timeout = Duration::from_millis(request["timeoutMs"].as_u64().unwrap_or(30 * 60_000));
        let idle = Duration::from_millis(request["idleTimeoutMs"].as_u64().unwrap_or(30 * 60_000));
        let max_output = request["maxOutputBytes"]
            .as_u64()
            .unwrap_or(64 * 1024 * 1024) as usize;
        if !self.alive.load(Ordering::Acquire) {
            return Some(anyhow::anyhow!(
                "DeepSeek runtime exited before the turn completed"
            ));
        }
        if started.elapsed() >= timeout {
            return Some(anyhow::anyhow!("DeepSeek turn timed out"));
        }
        if let Some(route) = &self.routes.lock().unwrap().current {
            let activity = route.activity.lock().unwrap();
            if activity.last_output.elapsed() >= idle {
                return Some(anyhow::anyhow!("DeepSeek turn was idle for too long"));
            }
            if activity.output_bytes > max_output {
                return Some(anyhow::anyhow!("DeepSeek turn exceeded the output limit"));
            }
        }
        None
    }

    pub async fn watch_turn(&self, request: &Value, started: Instant) -> anyhow::Error {
        loop {
            if let Some(error) = self.turn_error(request, started) {
                return error;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reuse_preserves_session_configuration_but_not_turn_inputs() {
        let request = json!({"instance":{"providerOptions":{"runtimeConnectionRevision":1}},"cwd":"workspace", "model":"test",
            "env":{"NAUTILO_CONNECTION_API_KEY":"fake"},"mcpServers":[{"command":"fixture"}],"runtimeTools":[],"skills":[],"prompt":"first"});
        let mut next = request.clone();
        next["prompt"] = json!("second");
        next["reasoningEffort"] = json!("high");
        next["permissionMode"] = json!("read-only");
        assert_eq!(identity(&request), identity(&next));
        for (key, value) in [
            ("env", json!({"NAUTILO_CONNECTION_API_KEY":"changed"})),
            ("model", json!("other")),
            ("cwd", json!("other")),
            ("mcpServers", json!([])),
            ("skills", json!([{"id":"new"}])),
        ] {
            let mut changed = request.clone();
            changed[key] = value;
            assert_ne!(identity(&request), identity(&changed), "{key}");
        }
    }
}
