//! A server owns its event reader; turns only borrow routes from that reader.
use super::{
    api_json, directory_url, handle_permission, handle_question, urlencoding,
    with_subagent_dispatch, PartStream,
};
use agenthub_plugin_sdk::{DaemonChannel, InteractionChannel};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, oneshot, watch};

struct SessionInteraction {
    daemon: Arc<dyn DaemonChannel>,
    binding: String,
}
impl InteractionChannel for SessionInteraction {
    fn ask(
        &self,
        _: &str,
        input: Value,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Value> + Send + '_>> {
        self.daemon.ask_session(&self.binding, input)
    }
}

pub(super) struct Route {
    pub run_id: String,
    pub local_id: String,
    pub cancelled: AtomicBool,
    ending: AtomicBool,
    compact: bool,
    output: Mutex<Option<mpsc::UnboundedSender<Value>>>,
    background: Option<mpsc::UnboundedSender<Value>>,
    pub interaction: Option<Arc<dyn InteractionChannel>>,
    parser: Mutex<PartStream>,
    pub done: watch::Sender<bool>,
    activity: Mutex<(Instant, usize)>,
    started: AtomicBool,
    terminal_owns_interactions: AtomicBool,
}
impl Route {
    pub async fn new(
        run_id: &str,
        request: &Value,
        output: mpsc::UnboundedSender<Value>,
        daemon: Option<Arc<dyn DaemonChannel>>,
        legacy: Option<Arc<dyn InteractionChannel>>,
    ) -> Arc<Self> {
        let binding = request["sessionBindingId"].as_str();
        let background = if let (Some(channel), Some(binding)) = (&daemon, binding) {
            Some(agenthub_plugin_sdk::session_sink(channel.clone(), binding.into()).await)
        } else {
            None
        };
        let interaction = match (daemon, binding) {
            (Some(daemon), Some(binding)) => Some(Arc::new(SessionInteraction {
                daemon,
                binding: binding.into(),
            }) as Arc<dyn InteractionChannel>),
            _ => legacy,
        };
        Arc::new(Self {
            run_id: run_id.into(),
            local_id: request["localSessionId"].as_str().unwrap_or(run_id).into(),
            cancelled: AtomicBool::new(false),
            ending: AtomicBool::new(false),
            compact: request["providerCommand"] == "compact",
            output: Mutex::new(Some(output)),
            background,
            interaction,
            parser: Mutex::new(PartStream::default()),
            done: watch::channel(false).0,
            activity: Mutex::new((Instant::now(), 0)),
            started: AtomicBool::new(false),
            terminal_owns_interactions: AtomicBool::new(false),
        })
    }
    pub fn foreground(&self) -> bool {
        self.output.lock().unwrap().is_some()
    }
    pub fn emit(&self, event: Value) {
        let output = self.output.lock().unwrap();
        if let Some(sender) = output.as_ref().or(self.background.as_ref()) {
            let _ = sender.send(event);
        }
    }
    pub fn finish(&self, code: i32, message: Option<&str>) {
        let mut output = self.output.lock().unwrap();
        let Some(sender) = output.take() else { return };
        let code = if self.cancelled.load(Ordering::Acquire) {
            130
        } else {
            code
        };
        if code == 0 {
            let _ = sender.send(json!({"kind":"status","phase":"turn_completed"}));
        } else if code != 130 {
            if let Some(message) = message {
                let _ = sender.send(json!({"kind":"error","message":message}));
            }
        }
        let _ = sender.send(json!({"kind":"exit","exitCode":code}));
        self.done.send_replace(true);
    }
    fn close(&self, message: &str) {
        let was_foreground = self.foreground();
        self.finish(1, Some(message));
        // Flush any visible background prefix, without failing a completed turn.
        if !was_foreground {
            if let Some(sender) = &self.background {
                let _ = sender.send(json!({"kind":"exit","exitCode":null}));
            }
        }
    }
    fn activity(&self, bytes: usize) {
        if self.foreground() {
            let mut activity = self.activity.lock().unwrap();
            activity.0 = Instant::now();
            activity.1 = activity.1.saturating_add(bytes);
        }
    }
    pub fn limit(&self, request: &Value, began: Instant) -> Option<&'static str> {
        let output = self.output.lock().unwrap();
        if output.as_ref().is_some_and(|sender| sender.is_closed()) {
            return Some("receiver_closed");
        }
        let (last, bytes) = *self.activity.lock().unwrap();
        if request["timeoutMs"]
            .as_u64()
            .filter(|ms| *ms > 0)
            .is_some_and(|ms| began.elapsed() >= Duration::from_millis(ms))
        {
            return Some("overall_timeout");
        }
        if request["idleTimeoutMs"]
            .as_u64()
            .filter(|ms| *ms > 0)
            .is_some_and(|ms| last.elapsed() >= Duration::from_millis(ms))
        {
            return Some("idle_timeout");
        }
        if bytes
            > request["maxOutputBytes"]
                .as_u64()
                .unwrap_or(20 * 1024 * 1024) as usize
        {
            return Some("max_output_bytes");
        }
        None
    }
}

struct Root {
    local_id: String,
    current: Arc<Route>,
    blocked: bool,
}
#[derive(Clone)]
struct Owner {
    route: Arc<Route>,
    role: String,
    dispatch: Option<String>,
    native_turn: Option<String>,
}
#[derive(Clone)]
struct Child {
    route: Arc<Route>,
    dispatch: String,
}
#[derive(Default)]
struct State {
    roots: HashMap<String, Root>,
    messages: HashMap<String, Owner>,
    parts: HashMap<String, Owner>,
    children: HashMap<String, Child>,
    deferred: HashMap<String, Vec<Value>>,
    resolving: HashSet<String>,
    rejected: HashSet<String>,
    pending_bytes: usize,
}
impl State {
    fn routes(&self) -> Vec<Arc<Route>> {
        let mut all: HashMap<String, Arc<Route>> = HashMap::new();
        for route in self
            .roots
            .values()
            .map(|r| &r.current)
            .chain(self.messages.values().map(|m| &m.route))
            .chain(self.children.values().map(|c| &c.route))
        {
            all.entry(route.run_id.clone())
                .or_insert_with(|| route.clone());
        }
        all.into_values().collect()
    }
    fn defer(&mut self, key: String, raw: Value) -> anyhow::Result<()> {
        let bytes = raw.to_string().len();
        // Never grow a shared server indefinitely on unidentified external traffic.
        anyhow::ensure!(
            self.pending_bytes.saturating_add(bytes) <= 32 * 1024 * 1024,
            "OpenCode unresolved events exceed 32 MiB"
        );
        self.pending_bytes += bytes;
        self.deferred.entry(key).or_default().push(raw);
        Ok(())
    }
    fn take_deferred(&mut self, key: &str) -> Vec<Value> {
        let values = self.deferred.remove(key).unwrap_or_default();
        for value in &values {
            self.pending_bytes = self.pending_bytes.saturating_sub(value.to_string().len());
        }
        values
    }
    fn owned_sessions(&self, run: Option<&str>, local: Option<&str>) -> Vec<String> {
        let matches = |route: &Route| {
            run.is_none_or(|id| route.run_id == id) && local.is_none_or(|id| route.local_id == id)
        };
        let mut sessions: HashSet<String> = self
            .roots
            .iter()
            .filter(|(_, r)| matches(&r.current))
            .map(|(id, _)| id.clone())
            .collect();
        sessions.extend(
            self.children
                .iter()
                .filter(|(_, c)| matches(&c.route))
                .map(|(id, _)| id.clone()),
        );
        sessions.into_iter().collect()
    }
}

struct Pending {
    run_id: String,
    local_id: String,
    task: tokio::task::AbortHandle,
}
pub(super) struct Runtime {
    pub base_url: String,
    pub cwd: String,
    pub alive: AtomicBool,
    state: Mutex<State>,
    pending: Mutex<HashMap<(String, String, String), Pending>>,
    resolved: Mutex<HashSet<(String, String, String)>>,
    reader: Mutex<Option<tokio::task::AbortHandle>>,
    resolutions: Mutex<Vec<tokio::task::AbortHandle>>,
    pub stopped: watch::Sender<bool>,
    pub interruption_confirmed: AtomicBool,
}
impl Runtime {
    pub async fn open(base_url: String, cwd: String) -> anyhow::Result<Arc<Self>> {
        let client = reqwest::Client::builder()
            .no_proxy()
            .connect_timeout(Duration::from_secs(10))
            .build()?;
        // Only the initial response headers have a deadline. A quiet resident
        // connection must not inherit a per-request timeout.
        let mut stream = tokio::time::timeout(
            Duration::from_secs(10),
            client
                .get(directory_url(&base_url, &cwd, "/event"))
                .header("accept", "text/event-stream")
                .send(),
        )
        .await??
        .error_for_status()?;
        let runtime = Arc::new(Self {
            base_url,
            cwd,
            alive: AtomicBool::new(true),
            state: Mutex::new(State::default()),
            pending: Mutex::new(HashMap::new()),
            resolved: Mutex::new(HashSet::new()),
            reader: Mutex::new(None),
            resolutions: Mutex::new(vec![]),
            stopped: watch::channel(false).0,
            interruption_confirmed: AtomicBool::new(true),
        });
        let pump = runtime.clone();
        let task = tokio::spawn(async move {
            let mut decoder = SseDecoder::default();
            let result: anyhow::Result<()> = async {
                while let Some(bytes) = stream.chunk().await? {
                    let frames = decoder.push(&bytes)?;
                    // Consume the whole read, including bytes after a turn's idle.
                    for frame in frames {
                        pump.accept(frame);
                    }
                }
                anyhow::bail!("OpenCode event stream disconnected")
            }
            .await;
            if let Err(error) = result {
                let sessions = pump.shutdown(&error.to_string());
                if !pump.abort_sessions(sessions).await {
                    pump.interruption_confirmed.store(false, Ordering::Release);
                }
            }
            pump.stopped.send_replace(true);
        });
        *runtime.reader.lock().unwrap() = Some(task.abort_handle());
        Ok(runtime)
    }
    pub fn begin(
        &self,
        session: &str,
        user_message: &str,
        route: Arc<Route>,
    ) -> anyhow::Result<()> {
        anyhow::ensure!(
            self.alive.load(Ordering::Acquire),
            "OpenCode event reader is unavailable"
        );
        let mut state = self.state.lock().unwrap();
        if let Some(root) = state.roots.get(session) {
            anyhow::ensure!(
                !root.current.foreground(),
                "OpenCode session already has an active turn"
            );
            anyhow::ensure!(!root.blocked, "OpenCode has not confirmed interruption of the preceding turn; release the session before resuming");
            anyhow::ensure!(
                root.local_id == route.local_id,
                "OpenCode session is bound to another local session"
            );
        }
        state.messages.insert(
            user_message.into(),
            Owner {
                route: route.clone(),
                role: "user".into(),
                dispatch: None,
                native_turn: Some(user_message.into()),
            },
        );
        state.roots.insert(
            session.into(),
            Root {
                local_id: route.local_id.clone(),
                current: route,
                blocked: false,
            },
        );
        Ok(())
    }
    pub fn has_sessions(&self) -> bool {
        !self.state.lock().unwrap().roots.is_empty()
    }
    pub fn has_local(&self, local: &str) -> bool {
        self.state
            .lock()
            .unwrap()
            .roots
            .values()
            .any(|r| r.local_id == local)
    }
    pub fn park(&self, session: &str, route: Arc<Route>) -> anyhow::Result<()> {
        let mut state = self.state.lock().unwrap();
        anyhow::ensure!(
            self.alive.load(Ordering::Acquire),
            "OpenCode event reader is unavailable"
        );
        if let Some(root) = state.roots.get(session) {
            anyhow::ensure!(
                root.local_id == route.local_id && !root.current.foreground(),
                "Native session has another foreground owner"
            );
        }
        let blocked = state.roots.get(session).is_some_and(|root| root.blocked);
        state.rejected.remove(session);
        state.roots.insert(
            session.into(),
            Root {
                local_id: route.local_id.clone(),
                current: route,
                blocked,
            },
        );
        Ok(())
    }
    pub fn pause_terminal_interactions(&self, local: &str) {
        {
            let state = self.state.lock().unwrap();
            for route in state
                .routes()
                .into_iter()
                .filter(|route| route.local_id == local)
            {
                route
                    .terminal_owns_interactions
                    .store(true, Ordering::Release);
            }
        }
        self.cancel_interactions(None, Some(local));
    }
    pub async fn resume_terminal_interactions(self: &Arc<Self>, local: &str) -> anyhow::Result<()> {
        {
            let state = self.state.lock().unwrap();
            for route in state
                .routes()
                .into_iter()
                .filter(|route| route.local_id == local)
            {
                route
                    .terminal_owns_interactions
                    .store(false, Ordering::Release);
            }
        }
        // Requests raised while the TUI owned interaction were deliberately
        // left unanswered. Re-read them when control returns, including children.
        for (path, kind) in [
            ("/question", "question.asked"),
            ("/permission", "permission.asked"),
        ] {
            let requests = api_json(&self.base_url, &self.cwd, path, "GET", None).await?;
            for request in requests
                .as_array()
                .ok_or_else(|| anyhow::anyhow!("Native pending interactions are unavailable"))?
            {
                let session = request["sessionID"].as_str().unwrap_or("");
                let route = {
                    let state = self.state.lock().unwrap();
                    state
                        .children
                        .get(session)
                        .map(|child| child.route.clone())
                        .or_else(|| state.roots.get(session).map(|root| root.current.clone()))
                        .filter(|route| route.local_id == local)
                };
                if let Some(route) = route {
                    self.interact(session, kind, request.clone(), route);
                }
            }
        }
        Ok(())
    }
    pub fn seed_history(&self, session: &str, route: &Arc<Route>, snapshot: &Value) {
        let mut state = self.state.lock().unwrap();
        for kind in ["messages", "activities"] {
            for entry in snapshot[kind].as_array().into_iter().flatten() {
                let message = entry["messageId"].as_str().unwrap_or("");
                let role = if kind == "messages" {
                    entry["role"].as_str().unwrap_or("assistant")
                } else {
                    "assistant"
                };
                let owner = Owner {
                    route: route.clone(),
                    role: role.into(),
                    dispatch: None,
                    native_turn: entry["nativeTurnId"].as_str().map(str::to_string),
                };
                state.messages.insert(message.into(), owner.clone());
                let ids = if kind == "messages" {
                    entry["partIds"].as_array().cloned().unwrap_or_default()
                } else {
                    vec![entry["id"].clone()]
                };
                for id in ids
                    .into_iter()
                    .filter_map(|id| id.as_str().map(str::to_string))
                {
                    state.parts.insert(id.clone(), owner.clone());
                    if role == "assistant" && kind == "messages" {
                        route.parser.lock().unwrap().types.insert(id, "text".into());
                    }
                }
                let part = &entry["event"]["raw"]["part"];
                if part["type"] == "tool" && part["tool"] == "task" {
                    if let (Some(child), Some(dispatch)) = (
                        part.pointer("/state/metadata/sessionId")
                            .or_else(|| part.pointer("/state/metadata/sessionID"))
                            .and_then(Value::as_str),
                        part["callID"].as_str(),
                    ) {
                        state.children.insert(
                            child.into(),
                            Child {
                                route: route.clone(),
                                dispatch: dispatch.into(),
                            },
                        );
                        state.rejected.remove(child);
                    }
                }
            }
        }
        state.rejected.remove(session);
    }
    pub fn cancel_interactions(&self, run: Option<&str>, local: Option<&str>) {
        self.pending.lock().unwrap().retain(|_, pending| {
            if run.is_none_or(|id| id == pending.run_id)
                && local.is_none_or(|id| id == pending.local_id)
            {
                pending.task.abort();
                false
            } else {
                true
            }
        });
    }
    fn cancel_session_interactions(&self, session: &str) {
        self.pending.lock().unwrap().retain(|key, pending| {
            if key.0 == session {
                self.resolved.lock().unwrap().insert(key.clone());
                pending.task.abort();
                false
            } else {
                true
            }
        });
    }
    pub async fn abort_sessions(&self, sessions: Vec<String>) -> bool {
        let mut success = true;
        let mut requests = tokio::task::JoinSet::new();
        // Each owned child also receives an abort: root alone need not stop
        // detached jobs. One concurrent deadline bounds cancellation latency.
        for session in sessions {
            let path = format!("/session/{}/abort", urlencoding(&session));
            let base = self.base_url.clone();
            let cwd = self.cwd.clone();
            requests.spawn(async move {
                tokio::time::timeout(
                    Duration::from_secs(3),
                    api_json(&base, &cwd, &path, "POST", None),
                )
                .await
            });
        }
        while let Some(result) = requests.join_next().await {
            if !matches!(result, Ok(Ok(Ok(Value::Bool(true))))) {
                success = false;
            }
        }
        success
    }
    pub async fn interrupt(&self, route: &Route, code: i32, message: Option<&str>) -> bool {
        let sessions = {
            let mut state = self.state.lock().unwrap();
            if !route.foreground() || route.ending.swap(true, Ordering::AcqRel) {
                return true;
            }
            for root in state
                .roots
                .values_mut()
                .filter(|r| r.current.run_id == route.run_id)
            {
                root.blocked = true;
            }
            state.owned_sessions(Some(&route.run_id), None)
        };
        self.cancel_interactions(Some(&route.run_id), None);
        let confirmed = self.abort_sessions(sessions).await;
        for root in self
            .state
            .lock()
            .unwrap()
            .roots
            .values_mut()
            .filter(|r| r.current.run_id == route.run_id)
        {
            root.blocked = !confirmed;
        }
        route.finish(code, message);
        confirmed
    }
    pub async fn release(&self, local: &str) -> bool {
        let (sessions, routes) = {
            let mut state = self.state.lock().unwrap();
            let sessions = state.owned_sessions(None, Some(local));
            let routes: Vec<_> = state
                .routes()
                .into_iter()
                .filter(|r| r.local_id == local)
                .collect();
            for route in &routes {
                route.cancelled.store(true, Ordering::Release);
                route.ending.store(true, Ordering::Release);
            }
            for root in state.roots.values_mut().filter(|r| r.local_id == local) {
                root.blocked = true;
            }
            (sessions, routes)
        };
        self.cancel_interactions(None, Some(local));
        for route in &routes {
            route.close("OpenCode session released");
        }
        if !self.abort_sessions(sessions.clone()).await {
            return false;
        }
        {
            let mut state = self.state.lock().unwrap();
            state.roots.retain(|_, root| root.local_id != local);
            state
                .messages
                .retain(|_, owner| owner.route.local_id != local);
            state.parts.retain(|_, owner| owner.route.local_id != local);
            state
                .children
                .retain(|_, child| child.route.local_id != local);
            for session in &sessions {
                state.take_deferred(&format!("session:{session}"));
            }
        }
        true
    }
    fn shutdown(&self, message: &str) -> Vec<String> {
        self.alive.store(false, Ordering::Release);
        self.cancel_interactions(None, None);
        self.resolved.lock().unwrap().clear();
        for task in self.resolutions.lock().unwrap().drain(..) {
            task.abort();
        }
        let mut state = self.state.lock().unwrap();
        let sessions = state.owned_sessions(None, None);
        for route in state.routes() {
            route.close(message);
        }
        *state = State::default();
        sessions
    }
    pub fn close(&self) {
        self.shutdown("OpenCode server released");
        if let Some(reader) = self.reader.lock().unwrap().take() {
            reader.abort();
        }
        self.stopped.send_replace(true);
    }
    pub fn accept(self: &Arc<Self>, raw: Value) {
        if let Err(error) = self.accept_frames(raw) {
            let sessions = self.shutdown(&error.to_string());
            let runtime = self.clone();
            tokio::spawn(async move {
                if !runtime.abort_sessions(sessions).await {
                    runtime
                        .interruption_confirmed
                        .store(false, Ordering::Release);
                }
                runtime.stopped.send_replace(true);
            });
        }
    }
    fn accept_frames(self: &Arc<Self>, raw: Value) -> anyhow::Result<()> {
        if !self.alive.load(Ordering::Acquire) {
            return Ok(());
        }
        let mut queue = VecDeque::from([raw]);
        while let Some(raw) = queue.pop_front() {
            let event = raw
                .get("payload")
                .filter(|p| p.get("type").is_some())
                .unwrap_or(&raw);
            let kind = event["type"].as_str().unwrap_or("");
            let p = &event["properties"];
            let session = p["sessionID"]
                .as_str()
                .or_else(|| p.pointer("/part/sessionID").and_then(Value::as_str))
                .or_else(|| p.pointer("/info/sessionID").and_then(Value::as_str))
                .unwrap_or("");
            if [
                "question.replied",
                "question.rejected",
                "permission.replied",
            ]
            .contains(&kind)
            {
                let category = if kind.starts_with("question") {
                    "question"
                } else {
                    "permission"
                };
                let id = p["requestID"]
                    .as_str()
                    .or_else(|| p["id"].as_str())
                    .unwrap_or("");
                let key = (session.into(), category.into(), id.into());
                self.resolved.lock().unwrap().insert(key.clone());
                if let Some(pending) = self.pending.lock().unwrap().remove(&key) {
                    pending.task.abort();
                }
                continue;
            }
            let mut state = self.state.lock().unwrap();
            if kind == "message.updated" {
                let info = &p["info"];
                let Some(id) = info["id"].as_str() else {
                    continue;
                };
                let owner = state
                    .messages
                    .get(id)
                    .cloned()
                    .or_else(|| {
                        state
                            .roots
                            .get(session)
                            .filter(|r| r.current.compact && r.current.foreground())
                            .map(|r| Owner {
                                route: r.current.clone(),
                                role: String::new(),
                                dispatch: None,
                                native_turn: None,
                            })
                    })
                    .or_else(|| {
                        info["parentID"]
                            .as_str()
                            .and_then(|parent| state.messages.get(parent))
                            .cloned()
                    })
                    .or_else(|| {
                        state.children.get(session).map(|c| Owner {
                            route: c.route.clone(),
                            role: String::new(),
                            dispatch: Some(c.dispatch.clone()),
                            native_turn: None,
                        })
                    })
                    .or_else(|| {
                        (info["role"] == "user")
                            .then(|| state.roots.get(session))
                            .flatten()
                            .filter(|root| !root.current.foreground())
                            .map(|root| Owner {
                                route: root.current.clone(),
                                role: "user".into(),
                                dispatch: None,
                                native_turn: Some(id.into()),
                            })
                    });
                if let Some(mut owner) = owner {
                    if state
                        .roots
                        .get(session)
                        .is_some_and(|root| root.current.run_id == owner.route.run_id)
                    {
                        owner.route.started.store(true, Ordering::Release);
                    }
                    owner.role = info["role"].as_str().unwrap_or("").into();
                    if owner.role == "user" {
                        owner.native_turn = Some(id.into());
                    }
                    state.messages.insert(id.into(), owner);
                    queue.extend(state.take_deferred(&format!("message:{id}")));
                } else if !session.is_empty()
                    && !state.roots.contains_key(session)
                    && !state.rejected.contains(session)
                {
                    state.defer(format!("session:{session}"), raw.clone())?;
                    let resolve = state.resolving.insert(session.into());
                    drop(state);
                    if resolve {
                        self.resolve_child(session.to_string());
                    }
                }
                continue;
            }
            if kind == "session.status" || kind == "session.idle" || kind == "session.error" {
                if kind == "session.error" {
                    self.cancel_session_interactions(session);
                }
                if let Some(root) = state.roots.get(session) {
                    let route = root.current.clone();
                    route.activity(raw.to_string().len());
                    let status = p
                        .pointer("/status/type")
                        .and_then(Value::as_str)
                        .or_else(|| p["status"].as_str())
                        .unwrap_or("");
                    if status == "busy" && route.compact {
                        route.started.store(true, Ordering::Release);
                    }
                    if kind == "session.error"
                        && route.foreground()
                        && !route.ending.load(Ordering::Acquire)
                    {
                        let message = p
                            .pointer("/error/data/message")
                            .and_then(Value::as_str)
                            .or_else(|| p.pointer("/error/message").and_then(Value::as_str))
                            .unwrap_or("OpenCode session failed");
                        route.finish(1, Some(message));
                    } else if (status == "idle" || kind == "session.idle")
                        && route.started.load(Ordering::Acquire)
                        && !route.ending.load(Ordering::Acquire)
                    {
                        route.finish(0, None);
                    }
                }
                continue;
            }
            if kind == "session.deleted" {
                let id = p
                    .pointer("/info/id")
                    .and_then(Value::as_str)
                    .unwrap_or(session);
                let local = state.roots.get(id).map(|r| r.local_id.clone());
                let mut routes = vec![];
                if let Some(local) = &local {
                    routes = state
                        .routes()
                        .into_iter()
                        .filter(|route| &route.local_id == local)
                        .collect();
                    state.roots.retain(|_, root| &root.local_id != local);
                    state
                        .messages
                        .retain(|_, owner| &owner.route.local_id != local);
                    state
                        .parts
                        .retain(|_, owner| &owner.route.local_id != local);
                    state
                        .children
                        .retain(|_, child| &child.route.local_id != local);
                } else {
                    state.children.remove(id);
                }
                state.take_deferred(&format!("session:{id}"));
                drop(state);
                if let Some(local) = local {
                    self.cancel_interactions(None, Some(&local));
                    for route in routes {
                        route.cancelled.store(true, Ordering::Release);
                        route.close("Native OpenCode session was deleted");
                    }
                } else {
                    self.cancel_session_interactions(id);
                }
                continue;
            }
            if kind != "message.part.updated"
                && kind != "message.part.delta"
                && kind != "question.asked"
                && kind != "permission.asked"
            {
                continue;
            }
            let part = &p["part"];
            let part_id = part["id"]
                .as_str()
                .or_else(|| p["partID"].as_str())
                .unwrap_or("");
            let message_id = part["messageID"]
                .as_str()
                .or_else(|| p["messageID"].as_str())
                .or_else(|| p.pointer("/tool/messageID").and_then(Value::as_str))
                .unwrap_or("");
            let owner = state
                .parts
                .get(part_id)
                .cloned()
                .or_else(|| state.messages.get(message_id).cloned())
                .or_else(|| {
                    state.children.get(session).map(|c| Owner {
                        route: c.route.clone(),
                        role: "assistant".into(),
                        dispatch: Some(c.dispatch.clone()),
                        native_turn: None,
                    })
                });
            let is_dialog = kind == "question.asked" || kind == "permission.asked";
            let owner = owner.or_else(|| {
                if is_dialog {
                    state.roots.get(session).map(|r| Owner {
                        route: r.current.clone(),
                        role: "assistant".into(),
                        dispatch: None,
                        native_turn: None,
                    })
                } else {
                    None
                }
            });
            let Some(owner) = owner else {
                if !session.is_empty()
                    && !state.roots.contains_key(session)
                    && !state.rejected.contains(session)
                {
                    state.defer(format!("session:{session}"), raw.clone())?;
                    let resolve = state.resolving.insert(session.into());
                    drop(state);
                    if resolve {
                        self.resolve_child(session.to_string());
                    }
                } else if !message_id.is_empty() {
                    state.defer(format!("message:{message_id}"), raw.clone())?;
                }
                continue;
            };
            if owner.route.cancelled.load(Ordering::Acquire)
                || owner.route.ending.load(Ordering::Acquire)
            {
                continue;
            }
            owner.route.activity(raw.to_string().len());
            if is_dialog {
                let route = owner.route.clone();
                drop(state);
                self.interact(session, kind, p.clone(), route);
                continue;
            }
            if owner.role == "user" {
                continue;
            }
            if !part_id.is_empty() {
                state.parts.insert(part_id.into(), owner.clone());
            }
            if kind == "message.part.updated" && part["type"] == "tool" && part["tool"] == "task" {
                if let Some(child) = part
                    .pointer("/state/metadata/sessionId")
                    .or_else(|| part.pointer("/state/metadata/sessionID"))
                    .and_then(Value::as_str)
                    .filter(|id| !id.is_empty())
                {
                    let dispatch = part["callID"]
                        .as_str()
                        .filter(|id| !id.is_empty())
                        .unwrap_or(part_id);
                    state.children.insert(
                        child.into(),
                        Child {
                            route: owner.route.clone(),
                            dispatch: dispatch.into(),
                        },
                    );
                    state.rejected.remove(child);
                    queue.extend(state.take_deferred(&format!("session:{child}")));
                }
            }
            // A part's native session takes precedence over a message's parent.
            if !state.roots.contains_key(session) && owner.dispatch.is_none() {
                state.defer(format!("session:{session}"), raw.clone())?;
                continue;
            }
            drop(state);
            let events = if kind == "message.part.delta" {
                owner.route.parser.lock().unwrap().delta(p, &raw)
            } else {
                owner
                    .route
                    .parser
                    .lock()
                    .unwrap()
                    .update(part, &raw, p["delta"].as_str())
            };
            let events = if let Some(dispatch) = &owner.dispatch {
                with_subagent_dispatch(events, dispatch)
            } else {
                events
            };
            for mut event in events {
                if event["kind"] != "session" {
                    if let Some(turn) = &owner.native_turn {
                        event["raw"]["nativeTurnId"] = json!(turn);
                        event["raw"]["providerSessionId"] = json!(session);
                    }
                    owner.route.emit(event);
                }
            }
        }
        Ok(())
    }
    fn interact(self: &Arc<Self>, session: &str, kind: &str, properties: Value, route: Arc<Route>) {
        let id = properties["id"]
            .as_str()
            .or_else(|| properties["requestID"].as_str())
            .unwrap_or("");
        if id.is_empty() {
            return;
        }
        let category = if kind == "question.asked" {
            "question"
        } else {
            "permission"
        };
        let key = (session.to_string(), category.to_string(), id.to_string());
        let mut pending = self.pending.lock().unwrap();
        if pending.contains_key(&key)
            || self.resolved.lock().unwrap().contains(&key)
            || route.cancelled.load(Ordering::Acquire)
            || route.terminal_owns_interactions.load(Ordering::Acquire)
        {
            return;
        }
        let runtime = self.clone();
        let task_key = key.clone();
        let task_route = route.clone();
        let (start, ready) = oneshot::channel();
        let task = tokio::spawn(async move {
            let _ = ready.await;
            let result = if category == "question" {
                handle_question(
                    &runtime.base_url,
                    &runtime.cwd,
                    &properties,
                    task_route.interaction.clone(),
                    &task_route.run_id,
                )
                .await
            } else {
                handle_permission(
                    &runtime.base_url,
                    &runtime.cwd,
                    &properties,
                    task_route.interaction.clone(),
                    &task_route.run_id,
                )
                .await
            };
            if let Err(error) = result {
                task_route.emit(json!({"kind":"raw","stream":"stderr","text":format!("OpenCode interaction failed: {error}")}));
            } else {
                runtime.resolved.lock().unwrap().insert(task_key.clone());
            }
            runtime.pending.lock().unwrap().remove(&task_key);
        });
        pending.insert(
            key,
            Pending {
                run_id: route.run_id.clone(),
                local_id: route.local_id.clone(),
                task: task.abort_handle(),
            },
        );
        let _ = start.send(());
    }
    fn resolve_child(self: &Arc<Self>, session: String) {
        let runtime = self.clone();
        let task = tokio::spawn(async move {
            let mut cursor = session.clone();
            let mut ancestors = vec![];
            let mut visited = HashSet::new();
            let mut related = false;
            for _ in 0..64 {
                if !visited.insert(cursor.clone()) || !runtime.alive.load(Ordering::Acquire) {
                    return;
                }
                let Ok(info) = api_json(
                    &runtime.base_url,
                    &runtime.cwd,
                    &format!("/session/{}", urlencoding(&cursor)),
                    "GET",
                    None,
                )
                .await
                else {
                    return;
                };
                let Some(parent) = info["parentID"].as_str().filter(|id| !id.is_empty()) else {
                    break;
                };
                ancestors.push(parent.to_string());
                let known = {
                    let state = runtime.state.lock().unwrap();
                    state.roots.contains_key(parent) || state.children.contains_key(parent)
                };
                if known {
                    related = true;
                    break;
                }
                cursor = parent.to_string();
            }
            if related {
                // Walk from the known ancestor down. Only actual task metadata
                // pairs parallel/nested children; no FIFO or current-turn guess.
                for parent in ancestors.iter().rev() {
                    if let Ok(messages) = api_json(
                        &runtime.base_url,
                        &runtime.cwd,
                        &format!("/session/{}/message", urlencoding(parent)),
                        "GET",
                        None,
                    )
                    .await
                    {
                        for entry in messages.as_array().into_iter().flatten() {
                            runtime.accept(json!({"type":"message.updated","properties":{"info":entry["info"]}}));
                            for part in entry["parts"]
                                .as_array()
                                .into_iter()
                                .flatten()
                                .filter(|part| part["tool"] == "task")
                            {
                                runtime.accept(json!({"type":"message.part.updated","properties":{"part":part}}));
                            }
                        }
                    }
                }
                return;
            }
            let mut state = runtime.state.lock().unwrap();
            if !state.children.contains_key(&session) {
                state.rejected.insert(session.clone());
                state.take_deferred(&format!("session:{session}"));
            }
        });
        let mut tasks = self.resolutions.lock().unwrap();
        tasks.retain(|task| !task.is_finished());
        tasks.push(task.abort_handle());
    }
}

/// Preserve byte boundaries until a complete SSE line is available. Handles
/// CRLF, multiline data and UTF-8 split across reads, including across turns.
#[derive(Default)]
struct SseDecoder {
    pending: Vec<u8>,
    data: Vec<String>,
    data_bytes: usize,
}
impl SseDecoder {
    fn push(&mut self, bytes: &[u8]) -> anyhow::Result<Vec<Value>> {
        self.pending.extend_from_slice(bytes);
        anyhow::ensure!(
            self.pending.len() <= 32 * 1024 * 1024,
            "OpenCode SSE frame exceeds 32 MiB"
        );
        let mut frames = vec![];
        let mut used = 0;
        for (index, byte) in self.pending.iter().enumerate() {
            if *byte != b'\n' {
                continue;
            }
            let line = std::str::from_utf8(&self.pending[used..index])?.trim_end_matches('\r');
            used = index + 1;
            if line.is_empty() {
                if !self.data.is_empty() {
                    frames.push(serde_json::from_str(&self.data.join("\n"))?);
                    self.data.clear();
                    self.data_bytes = 0;
                }
            } else if let Some(data) = line.strip_prefix("data:") {
                self.data_bytes = self.data_bytes.saturating_add(data.len());
                anyhow::ensure!(
                    self.data_bytes <= 32 * 1024 * 1024,
                    "OpenCode multiline SSE data exceeds 32 MiB"
                );
                self.data
                    .push(data.strip_prefix(' ').unwrap_or(data).to_string());
            }
        }
        self.pending.drain(..used);
        Ok(frames)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sse_preserves_utf8_crlf_multiline_and_partial_tail() {
        let mut decoder = SseDecoder::default();
        let bytes =
            ": heartbeat\r\ndata: {\"text\":\r\ndata: \"中文\"}\r\n\r\ndata: {\"next\":true}\n\n"
                .as_bytes();
        let mut frames = vec![];
        for byte in bytes {
            frames.extend(decoder.push(&[*byte]).unwrap());
        }
        assert_eq!(frames, vec![json!({"text":"中文"}), json!({"next":true})]);
    }
}
