//! A resident app-server has one reader, independent of foreground RPC waits.
//! Native thread, turn and item identities keep late activity on its owner.
use super::*;
use std::collections::HashSet;

pub(super) struct Context {
    state: Arc<Mutex<AppServerState>>,
    request: AdapterStartRequest,
    foreground: Mutex<Option<mpsc::UnboundedSender<AdapterEvent>>>,
    completed: watch::Sender<Option<Result<(), String>>>,
    items: Mutex<HashSet<String>>,
    last_output: Mutex<std::time::Instant>,
    output_bytes: std::sync::atomic::AtomicUsize,
    waiting: std::sync::atomic::AtomicUsize,
    started: std::time::Instant,
    first_text: AtomicBool,
    limited: AtomicBool,
}
struct Waiting(Arc<Context>);
impl Drop for Waiting {
    fn drop(&mut self) {
        self.0.waiting.fetch_sub(1, Ordering::AcqRel);
        *self.0.last_output.lock().unwrap() = std::time::Instant::now();
    }
}

impl Context {
    pub fn park(&self) {
        self.foreground.lock().unwrap().take();
    }
    fn is_foreground(&self) -> bool {
        self.foreground.lock().unwrap().is_some()
    }
    fn emit(&self, event: AdapterEvent) {
        if let Some(sender) = self.foreground.lock().unwrap().as_ref() {
            let _ = sender.send(event);
        } else if let Some(events) = &self.request.session_events {
            if matches!(&event,AdapterEvent::Status{phase,..} if phase.starts_with("turn_")) {
                return;
            }
            events(event);
        }
    }
    fn scoped_request(&self, child: bool, id: &Value) -> AdapterStartRequest {
        let mut request = self.request.clone();
        if child || !self.is_foreground() {
            request.request_interaction = request.session_interaction.clone().or_else(|| {
                self.is_foreground()
                    .then(|| request.request_interaction.clone())
                    .flatten()
            });
            request.execute_runtime_tool = request.session_tool.clone().or_else(|| {
                self.is_foreground()
                    .then(|| request.execute_runtime_tool.clone())
                    .flatten()
            });
        }
        if let Some(handler) = request.request_interaction.take() {
            let native_id = id
                .as_str()
                .map(str::to_string)
                .unwrap_or_else(|| id.to_string());
            request.request_interaction = Some(Arc::new(move |mut input| {
                input["nativeRequestId"] = json!(native_id);
                handler(input)
            }));
        }
        request
    }
    pub async fn wait(&self) -> anyhow::Result<()> {
        let mut completed = self.completed.subscribe();
        loop {
            let complete = completed.wait_for(|result| result.is_some());
            tokio::pin!(complete);
            tokio::select! {
                result=&mut complete=>return result.map_err(|_|anyhow::anyhow!("Codex completion channel closed"))?.clone().unwrap().map_err(anyhow::Error::msg),
                _=tokio::time::sleep(std::time::Duration::from_millis(100)),if self.request.idle_timeout_ms.is_some() || self.request.max_output_bytes.is_some()=>{
                    if self.state.lock().unwrap().cancelled{continue;}
                    if self.request.max_output_bytes.is_some_and(|limit|self.output_bytes.load(Ordering::Acquire)>limit) {
                        self.limited.store(true,Ordering::Release);
                        self.emit(AdapterEvent::Timeout{reason:TimeoutKind::MaxOutput});anyhow::bail!("Codex turn exceeded output limit");
                    }
                    if self.waiting.load(Ordering::Acquire)==0 && self.request.idle_timeout_ms.is_some_and(|limit|self.last_output.lock().unwrap().elapsed().as_millis()>=limit as u128) {
                        self.limited.store(true,Ordering::Release);
                        self.emit(AdapterEvent::Timeout{reason:TimeoutKind::Idle});anyhow::bail!("Codex turn exceeded idle limit");
                    }
                }
            }
        }
    }
    pub fn limited(&self) -> bool {
        self.limited.load(Ordering::Acquire)
    }
    pub async fn terminal(&self) -> anyhow::Result<()> {
        let mut completed = self.completed.subscribe();
        let result = completed
            .wait_for(|result| result.is_some())
            .await
            .map_err(|_| anyhow::anyhow!("Codex completion channel closed"))?
            .clone()
            .unwrap();
        result.map_err(anyhow::Error::msg)
    }
    fn note(&self, params: &Value) {
        if !self.is_foreground() {
            return;
        }
        *self.last_output.lock().unwrap() = std::time::Instant::now();
        if self.request.max_output_bytes.is_some() {
            self.output_bytes
                .fetch_add(params.to_string().len(), Ordering::AcqRel);
        }
    }
    fn finish(&self, code: i32) {
        if self.completed.borrow().is_some() {
            return;
        }
        self.state.lock().unwrap().finished = true;
        self.emit(AdapterEvent::Exit {
            exit_code: Some(code),
            signal: None,
        });
        self.completed.send_replace(Some(Ok(())));
    }
}

#[derive(Default)]
pub(super) struct SessionEvents {
    contexts: Mutex<Vec<Arc<Context>>>,
    reader: tokio::sync::Mutex<Option<tokio::task::JoinHandle<()>>>,
    pending: Arc<Mutex<HashMap<String, tokio::task::AbortHandle>>>,
    metadata_pending: std::sync::atomic::AtomicUsize,
    metadata_changed: tokio::sync::Notify,
}

impl SessionEvents {
    pub fn begin(
        &self,
        request: AdapterStartRequest,
        state: Arc<Mutex<AppServerState>>,
        sender: mpsc::UnboundedSender<AdapterEvent>,
    ) -> Arc<Context> {
        let context = Arc::new(Context {
            state,
            request,
            foreground: Mutex::new(Some(sender)),
            completed: watch::channel(None).0,
            items: Mutex::new(HashSet::new()),
            last_output: Mutex::new(std::time::Instant::now()),
            output_bytes: Default::default(),
            waiting: Default::default(),
            started: std::time::Instant::now(),
            first_text: AtomicBool::new(false),
            limited: AtomicBool::new(false),
        });
        self.contexts.lock().unwrap().push(context.clone());
        context
    }
    fn child(&self, child_id: &str) -> Option<(Arc<Context>, String)> {
        self.contexts.lock().unwrap().iter().find_map(|context| {
            let call = context
                .state
                .lock()
                .unwrap()
                .child_threads
                .get(child_id)
                .cloned()?;
            Some((context.clone(), call))
        })
    }
    fn owner(&self, params: &Value) -> Option<Arc<Context>> {
        let thread = thread_id(params);
        if let Some((owner, _)) = thread.and_then(|id| self.child(id)) {
            return Some(owner);
        }
        let contexts = self.contexts.lock().unwrap();
        let turn = params["turnId"]
            .as_str()
            .or_else(|| params.pointer("/turn/id").and_then(Value::as_str));
        let item = params["itemId"]
            .as_str()
            .or_else(|| params.pointer("/item/id").and_then(Value::as_str));
        if let Some(owner) = contexts.iter().rev().find(|context| {
            let state = context.state.lock().unwrap();
            thread == state.thread_id.as_deref()
                && turn.is_some()
                && turn == state.turn_id.as_deref()
        }) {
            return Some(owner.clone());
        }
        let context = contexts.last()?;
        {
            let state = context.state.lock().unwrap();
            if context.is_foreground()
                && thread == state.thread_id.as_deref()
                && state.turn_id.is_none()
            {
                return Some(context.clone());
            }
        }
        if turn.is_some() {
            return None;
        }
        if let Some(owner) = item.and_then(|id| {
            contexts.iter().find(|context| {
                context.items.lock().unwrap().contains(id)
                    && thread.is_none_or(|thread| {
                        context.state.lock().unwrap().thread_id.as_deref() == Some(thread)
                    })
            })
        }) {
            return Some(owner.clone());
        }
        let state = context.state.lock().unwrap();
        if thread.is_none()
            || (thread == state.thread_id.as_deref() && turn.is_none())
            || (context.is_foreground()
                && thread == state.thread_id.as_deref()
                && state.turn_id.is_none())
            || (context.is_foreground() && state.thread_id.is_none())
            || (context.request.provider_command.as_deref() == Some("compact")
                && state.turn_id.is_none()
                && thread == state.thread_id.as_deref())
        {
            Some(context.clone())
        } else {
            None
        }
    }

    pub async fn listen(self: &Arc<Self>, rpc: &Arc<JsonRpcProcessClient>) -> anyhow::Result<()> {
        let mut reader = self.reader.lock().await;
        if reader.is_some() {
            return Ok(());
        }
        let (sender, mut events) = mpsc::unbounded_channel();
        let weak = Arc::downgrade(self);
        let weak_rpc = Arc::downgrade(rpc);
        *reader = Some(tokio::spawn(async move {
            while let Some(event) = events.recv().await {
                let (Some(owner), Some(rpc)) = (weak.upgrade(), weak_rpc.upgrade()) else {
                    break;
                };
                match event {
                    JsonRpcProcessEvent::Notification { method, params } => {
                        if let Some(context) = owner.owner(&params) {
                            owner.notification(&rpc, &context, &method, &params).await;
                        }
                        owner.metadata_pending.fetch_sub(1, Ordering::AcqRel);
                        owner.metadata_changed.notify_waiters();
                    }
                    JsonRpcProcessEvent::Request { id, method, params } => {
                        if let Some(context) = owner.owner(&params) {
                            owner.request(&rpc, context, id, method, params);
                        } else {
                            rpc.respond_error(
                                &id,
                                -32600,
                                "Request does not belong to this Codex session",
                            );
                        }
                    }
                    JsonRpcProcessEvent::Transport(event) => {
                        let exit = matches!(event, ProcessEvent::Exit { .. });
                        owner.transport(event);
                        if exit {
                            break;
                        }
                    }
                    JsonRpcProcessEvent::Response { .. } => {}
                }
            }
        }));
        let weak = Arc::downgrade(self);
        let weak_rpc = Arc::downgrade(rpc);
        rpc.observe_idle(Arc::new(move |event| {
            let (Some(owner), Some(rpc)) = (weak.upgrade(), weak_rpc.upgrade()) else {
                return;
            };
            match event {
                JsonRpcProcessEvent::Request { id, method, params } => {
                    // UI and host calls are independent of snapshot/config RPC
                    // waits. Ordered metadata still establishes child ownership.
                    if let Some(context) = owner.owner(&params) {
                        owner.request(&rpc, context, id, method, params);
                    } else {
                        tokio::spawn(async move {
                            let process = rpc.process_handle();
                            let locate = async {
                                loop {
                                    let changed = owner.metadata_changed.notified();
                                    tokio::pin!(changed);
                                    changed.as_mut().enable();
                                    if let Some(context) = owner.owner(&params) {
                                        owner.request(
                                            &rpc,
                                            context,
                                            id.clone(),
                                            method.clone(),
                                            params.clone(),
                                        );
                                        break;
                                    }
                                    if owner.metadata_pending.load(Ordering::Acquire) == 0 {
                                        rpc.respond_error(
                                            &id,
                                            -32600,
                                            "Request does not belong to this Codex session",
                                        );
                                        break;
                                    }
                                    changed.await;
                                }
                            };
                            tokio::select! {_=locate=>{},_=process.wait()=>{}}
                        });
                    }
                }
                JsonRpcProcessEvent::Notification { method, params }
                    if method == "serverRequest/resolved" =>
                {
                    if let Some(task) = owner
                        .pending
                        .lock()
                        .unwrap()
                        .remove(&params["requestId"].to_string())
                    {
                        task.abort();
                    }
                    super::session_pool::background_changed();
                }
                event => {
                    if matches!(event, JsonRpcProcessEvent::Notification { .. }) {
                        owner.metadata_pending.fetch_add(1, Ordering::AcqRel);
                    }
                    let _ = sender.send(event);
                }
            }
        }))
        .await
    }

    async fn notification(
        self: &Arc<Self>,
        rpc: &Arc<JsonRpcProcessClient>,
        context: &Arc<Context>,
        method: &str,
        params: &Value,
    ) {
        context.note(params);
        let child = thread_id(params).and_then(|id| self.child(id));
        if child.is_none()
            && context.is_foreground()
            && method == "item/agentMessage/delta"
            && params["delta"]
                .as_str()
                .is_some_and(|text| !text.is_empty())
            && !context.first_text.swap(true, Ordering::AcqRel)
        {
            crate::runtime::run_log::log(
                json!({"event":"codex_turn_timing","sessionId":context.request.local_session_id,"model":context.request.model,
                "effort":context.request.reasoning_effort,"phase":"first_text","elapsedMs":context.started.elapsed().as_millis()}),
            );
        }
        if let Some((owner, dispatch_id)) = &child {
            if method == "turn/completed" || method == "error" && params["willRetry"] != true {
                let child_id = thread_id(params).unwrap();
                let failed = method == "error"
                    || matches!(
                        params["turn"]["status"].as_str(),
                        Some("failed" | "interrupted")
                    );
                let mut state = owner.state.lock().unwrap();
                if let Some(dispatch) = state.native_dispatches.get_mut(dispatch_id) {
                    for event in update_native_child(
                        dispatch,
                        child_id,
                        if failed { "errored" } else { "completed" },
                        last_message(&params["turn"]),
                    ) {
                        owner.emit(event);
                    }
                }
                super::session_pool::background_changed();
                return;
            }
        }
        if let Some(id) = params["itemId"]
            .as_str()
            .or_else(|| params.pointer("/item/id").and_then(Value::as_str))
        {
            context.items.lock().unwrap().insert(id.into());
        }
        let compact = context.request.provider_command.as_deref() == Some("compact");
        if child.is_none() && !compact && context.state.lock().unwrap().turn_id.is_none() {
            context.state.lock().unwrap().turn_id = params["turnId"]
                .as_str()
                .or_else(|| params.pointer("/turn/id").and_then(Value::as_str))
                .map(str::to_string);
        }
        if child.is_none()
            && compact
            && context.state.lock().unwrap().turn_id.is_none()
            && (method == "turn/started" || params["item"]["type"] == "contextCompaction")
        {
            context.state.lock().unwrap().turn_id = params
                .pointer("/turn/id")
                .and_then(Value::as_str)
                .or_else(|| params["turnId"].as_str())
                .map(str::to_string);
        }
        if method == "turn/diff/updated" {
            let state = context.state.lock().unwrap();
            if child.is_some()
                || !is_current_codex_turn_diff(
                    params,
                    state.thread_id.as_deref().unwrap_or(""),
                    state.turn_id.as_deref(),
                )
            {
                return;
            }
        }
        let item = &params["item"];
        if matches!(method, "item/started" | "item/completed") {
            if let Some(id) = item["id"].as_str() {
                let mut state = context.state.lock().unwrap();
                if method == "item/completed" {
                    state.active_items.remove(id);
                } else if !matches!(
                    item["type"].as_str(),
                    Some("agentMessage" | "reasoning" | "contextCompaction")
                ) {
                    state.active_items.insert(id.into());
                }
            }
        }
        let mut joins = vec![];
        if matches!(method, "item/started" | "item/completed")
            && item["type"] == "collabAgentToolCall"
        {
            if let Some(dispatch_id) = item["id"].as_str() {
                let spawn = item["tool"] == "spawnAgent";
                if spawn {
                    context
                        .state
                        .lock()
                        .unwrap()
                        .native_dispatches
                        .insert(dispatch_id.into(), item.clone());
                }
                for receiver in item["receiverThreadIds"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                {
                    if spawn && self.child(receiver).is_none() {
                        context
                            .state
                            .lock()
                            .unwrap()
                            .child_threads
                            .insert(receiver.into(), dispatch_id.into());
                        self.metadata_changed.notify_waiters();
                        joins.push((receiver.to_string(), dispatch_id.to_string()));
                    } else if !spawn {
                        if let Some((owner, original_id)) = self.child(receiver) {
                            if let Some(status) = item["agentsStates"][receiver]["status"].as_str()
                            {
                                let mut state = owner.state.lock().unwrap();
                                if let Some(original) =
                                    state.native_dispatches.get_mut(&original_id)
                                {
                                    for event in update_native_child(
                                        original,
                                        receiver,
                                        status,
                                        item["agentsStates"][receiver]["message"].as_str(),
                                    ) {
                                        owner.emit(event);
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        let events = parse_codex_app_server_notification(method, params);
        for event in if let Some((_, dispatch)) = &child {
            with_subagent_dispatch(events, dispatch)
        } else {
            events
        } {
            context.emit(event);
        }
        for (child_id, dispatch_id) in joins {
            // The transport reader continues handling requests during resume.
            // This worker can await the snapshot without blocking approvals.
            if let Ok(joined) = rpc
                .request("thread/resume", json!({"threadId":child_id}))
                .await
            {
                for event in native_child_history(&joined["thread"], &dispatch_id) {
                    context.emit(event);
                }
                if let Some(turn) = joined["thread"]["turns"]
                    .as_array()
                    .and_then(|turns| turns.last())
                    .filter(|turn| {
                        matches!(
                            turn["status"].as_str(),
                            Some("completed" | "failed" | "interrupted")
                        )
                    })
                {
                    let mut state = context.state.lock().unwrap();
                    if let Some(dispatch) = state.native_dispatches.get_mut(&dispatch_id) {
                        for event in update_native_child(
                            dispatch,
                            &child_id,
                            if turn["status"] == "completed" {
                                "completed"
                            } else {
                                "errored"
                            },
                            last_message(turn),
                        ) {
                            context.emit(event);
                        }
                    }
                }
            }
        }
        if child.is_none() {
            if compact
                && (method == "thread/compacted"
                    || method == "item/completed" && item["type"] == "contextCompaction")
            {
                context.emit(AdapterEvent::Message {
                    text: "Codex 上下文已压缩".into(),
                    phase: None,
                    message_id: None,
                    subagent_dispatch_id: None,
                    raw: None,
                });
                context.finish(0);
            } else if compact && method == "error" && params["willRetry"] != true {
                context.finish(1);
            } else if method == "turn/completed" {
                let failed = params["turn"]["status"] == "failed"
                    || params.pointer("/turn/error").is_some_and(|e| !e.is_null());
                context.finish(if failed { 1 } else { 0 });
            }
        }
        super::session_pool::background_changed();
    }

    fn request(
        &self,
        rpc: &Arc<JsonRpcProcessClient>,
        context: Arc<Context>,
        id: Value,
        method: String,
        params: Value,
    ) {
        let child = thread_id(&params).and_then(|id| self.child(id)).is_some();
        if !child && context.state.lock().unwrap().cancelled {
            rpc.respond_error(&id, -32600, "Codex turn was cancelled");
            return;
        }
        let request = context.scoped_request(child, &id);
        let rpc = rpc.clone();
        let pending = self.pending.clone();
        let key = id.to_string();
        let task_key = key.clone();
        context.note(&params);
        context.waiting.fetch_add(1, Ordering::AcqRel);
        let waiting = Waiting(context.clone());
        let (start, ready) = oneshot::channel();
        let task = tokio::spawn(async move {
            let _waiting = waiting;
            if ready.await.is_err() {
                return;
            }
            let work = async {
                match method.as_str() {
                    "item/tool/call" => {
                        for event in handle_dynamic_tool_call(&rpc, &request, &id, &params).await {
                            context.emit(event);
                        }
                    }
                    "item/tool/requestUserInput" => {
                        handle_request_user_input(&rpc, &request, &id, &params).await
                    }
                    "mcpServer/elicitation/request" => {
                        match super::super::elicitation::handle(&rpc, &request, &params).await {
                            Ok(response) => rpc.respond(&id, response),
                            Err(error) => {
                                rpc.respond_error(&id, -32000, &error.to_string());
                                context.emit(control_error(&id, "插件授权", &error.to_string()));
                            }
                        }
                    }
                    "item/commandExecution/requestApproval" | "item/fileChange/requestApproval" => {
                        handle_codex_approval(&rpc, &request, &id, &params, &method).await
                    }
                    _ => {
                        rpc.respond_error(
                            &id,
                            -32601,
                            &format!("Nautilo does not support app-server request {method}"),
                        );
                        context.emit(control_error(
                            &id,
                            &method,
                            "该原生交互尚未映射，可通过原生 CLI 继续。",
                        ));
                    }
                }
            };
            let process = rpc.process_handle();
            tokio::select! {_=work=>{},_=process.wait()=>{}}
            pending.lock().unwrap().remove(&task_key);
            super::session_pool::background_changed();
        });
        if let Some(old) = self
            .pending
            .lock()
            .unwrap()
            .insert(key, task.abort_handle())
        {
            old.abort();
        }
        let _ = start.send(());
    }

    fn transport(&self, event: ProcessEvent) {
        let contexts = self.contexts.lock().unwrap().clone();
        if let Some(context) = contexts.last() {
            match event {
                ProcessEvent::Stdout(text) => context.emit(AdapterEvent::Raw {
                    stream: "stdout".into(),
                    text,
                }),
                ProcessEvent::Stderr(text) => context.emit(AdapterEvent::Raw {
                    stream: "stderr".into(),
                    text,
                }),
                ProcessEvent::Error(message) => context.emit(AdapterEvent::Error { message }),
                ProcessEvent::Timeout { reason } => context.emit(AdapterEvent::Timeout {
                    reason: match reason {
                        TimeoutReason::Timeout => TimeoutKind::Timeout,
                        TimeoutReason::Idle => TimeoutKind::Idle,
                        TimeoutReason::MaxOutput => TimeoutKind::MaxOutput,
                    },
                }),
                ProcessEvent::Exit { exit_code, signal } => {
                    for old in &contexts {
                        let incomplete = old.completed.borrow().is_none();
                        if incomplete {
                            let message=format!("Codex app-server exited before the native turn completed ({exit_code:?}, {signal:?})");
                            old.emit(AdapterEvent::Error {
                                message: message.clone(),
                            });
                            old.emit(AdapterEvent::Exit {
                                exit_code: Some(exit_code.filter(|code| *code != 0).unwrap_or(1)),
                                signal: signal.clone(),
                            });
                            old.completed.send_replace(Some(Err(message)));
                        }
                        // Every owning turn may still have unfinished child
                        // text. Close its session stream too, after its queued
                        // foreground frames have been handed over by the host.
                        if let Some(events) = &old.request.session_events {
                            events(AdapterEvent::Exit {
                                exit_code,
                                signal: signal.clone(),
                            });
                        }
                    }
                    for (_, request) in self.pending.lock().unwrap().drain() {
                        request.abort();
                    }
                    self.contexts.lock().unwrap().clear();
                }
            }
        }
    }

    fn quiet(&self) -> bool {
        if !self.pending.lock().unwrap().is_empty()
            || self.metadata_pending.load(Ordering::Acquire) > 0
        {
            return false;
        }
        self.contexts.lock().unwrap().iter().all(|context| {
            if context.waiting.load(Ordering::Acquire) > 0 || context.is_foreground() {
                return false;
            }
            let state = context.state.lock().unwrap();
            state.active_items.is_empty()
                && state.child_threads.iter().all(|(child, dispatch)| {
                    state
                        .native_dispatches
                        .get(dispatch)
                        .and_then(|dispatch| dispatch["agentsStates"][child]["status"].as_str())
                        .is_some_and(|status| {
                            matches!(
                                status,
                                "completed"
                                    | "errored"
                                    | "shutdown"
                                    | "notFound"
                                    | "failed"
                                    | "interrupted"
                            )
                        })
                })
        })
    }
    pub async fn retirement_ready(&self, rpc: &Arc<JsonRpcProcessClient>) -> bool {
        if !self.quiet() {
            return false;
        }
        let mut threads = HashSet::new();
        for context in self.contexts.lock().unwrap().iter() {
            let state = context.state.lock().unwrap();
            threads.extend(state.thread_id.clone());
            threads.extend(
                state
                    .child_threads
                    .iter()
                    .filter(|(child, dispatch)| {
                        !state
                            .native_dispatches
                            .get(*dispatch)
                            .and_then(|dispatch| {
                                dispatch["agentsStates"][*child]["status"].as_str()
                            })
                            .is_some_and(|status| matches!(status, "shutdown" | "notFound"))
                    })
                    .map(|(child, _)| child.clone()),
            );
        }
        for thread in threads {
            let response = tokio::time::timeout(
                std::time::Duration::from_secs(2),
                rpc.request(
                    "thread/backgroundTerminals/list",
                    json!({"threadId":thread,"limit":1}),
                ),
            )
            .await;
            if !matches!(response,Ok(Ok(ref result)) if result["data"].as_array().is_some_and(|data|data.is_empty()) && result["nextCursor"].is_null())
            {
                return false;
            }
        }
        self.quiet()
    }
}

fn last_message(turn: &Value) -> Option<&str> {
    turn["items"]
        .as_array()?
        .iter()
        .rev()
        .find(|item| item["type"] == "agentMessage")?["text"]
        .as_str()
}
fn thread_id(params: &Value) -> Option<&str> {
    params["threadId"]
        .as_str()
        .or_else(|| params.pointer("/thread/id").and_then(Value::as_str))
}
fn control_error(id: &Value, name: &str, message: &str) -> AdapterEvent {
    AdapterEvent::Tool {
        call_id: Some(format!("codex-control-{id}")),
        name: name.into(),
        phase: Some("completed".into()),
        input: None,
        output: Some(json!(message)),
        success: Some(false),
        file_diff: None,
        subagent_dispatch_id: None,
        raw: None,
    }
}
