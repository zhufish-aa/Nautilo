//! Native terminal ownership ends only after its persisted transcript has
//! been reconciled. IDs, never text equality, determine message identity.
use super::*;
use crate::database::native_history::{ImportBatch, NativeHistoryRepository};
use crate::errors::invalid;
use sha2::{Digest, Sha256};
use std::collections::HashMap;

fn hash(value: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(value.as_ref()))
}
fn legacy_identity(session: &Value, request: &AdapterStartRequest) -> String {
    let mut env = request
        .env
        .as_ref()
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
    env.sort();
    hash(json!({"agentId":request.instance["id"],"providerId":request.instance["providerId"],"executable":request.instance["executable"],"baseArgs":request.instance["baseArgs"],"providerOptions":request.instance["providerOptions"],"models":request.instance["models"],"skills":request.skills,"mcpServers":request.mcp_servers,"runtimeTools":request.runtime_tools,"env":env,"cwd":request.cwd,"connectionId":session["connectionId"],"connectionRevision":session["connectionRevision"]}).to_string())
}
fn path_key(request: &AdapterStartRequest) -> Option<String> {
    request
        .env
        .as_ref()?
        .keys()
        .find(|key| key.eq_ignore_ascii_case("PATH"))
        .cloned()
}
fn path_separator() -> char {
    if cfg!(windows) {
        ';'
    } else {
        ':'
    }
}
fn identity(session: &Value, request: &AdapterStartRequest) -> String {
    let mut request = request.clone();
    // Desktop endpoint and authorization rotate at launch. They do not change
    // which native conversation the terminal owns.
    if let Some(servers) = &mut request.mcp_servers {
        servers.retain(|s| s["desktopBrowser"] != true);
    }
    if let Some(key) = path_key(&request) {
        let env = request.env.as_mut().unwrap();
        let mut seen = std::collections::HashSet::new();
        let path = env[&key]
            .split(path_separator())
            .filter(|part| seen.insert(*part))
            .collect::<Vec<_>>()
            .join(&path_separator().to_string());
        env.insert(key, path);
    }
    legacy_identity(session, &request)
}
fn legacy_identity_matches(expected: &str, session: &Value, request: &AdapterStartRequest) -> bool {
    if legacy_identity(session, request) == expected || identity(session, request) == expected {
        return true;
    }
    let Some(key) = path_key(request) else {
        return false;
    };
    let parts = request.env.as_ref().unwrap()[&key]
        .split(path_separator())
        .collect::<Vec<_>>();
    if parts.len() > 256 {
        return false;
    }
    // Startup scripts can prepend an already-present PATH block. Removing
    // only later copies cannot change command resolution. Every other byte
    // of the old identity, including account/config/cwd, must still match.
    for start in 1..parts.len() {
        for end in start + 1..=(start + 64).min(parts.len()) {
            if !parts[..start].contains(&parts[end - 1]) {
                break;
            }
            let path = parts[..start]
                .iter()
                .chain(parts[end..].iter())
                .copied()
                .collect::<Vec<_>>()
                .join(&path_separator().to_string());
            let mut candidate = request.clone();
            candidate.env.as_mut().unwrap().insert(key.clone(), path);
            if legacy_identity(session, &candidate) == expected {
                return true;
            }
        }
    }
    false
}
fn public_state(record: &Value) -> Value {
    json!({"status":record["phase"],"messageCount":record["messageCount"].as_u64().unwrap_or(0),"error":record["error"],"nativeBusy":record["nativeBusy"]==true})
}
fn pending(record: &Value) -> bool {
    !matches!(record["phase"].as_str(), Some("synced" | "unsupported"))
}
fn timestamp(entry: &Value, fallback: &str) -> String {
    entry["timestampMs"]
        .as_i64()
        .and_then(chrono::DateTime::from_timestamp_millis)
        .map(|time| time.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .unwrap_or_else(|| fallback.into())
}
pub(super) fn native_run_id(session: &str, provider_session: &str, turn: &str) -> String {
    format!(
        "native-run-{}",
        hash(json!([session, provider_session, turn]).to_string())
    )
}
pub(super) fn native_message_id(session: &str, provider_session: &str, message: &str) -> String {
    format!(
        "native-message-{}",
        hash(json!([session, provider_session, message]).to_string())
    )
}

impl RunService {
    fn terminal_event_request(
        self: &Arc<Self>,
        session: &Value,
        request: &AdapterStartRequest,
        handoff_id: &str,
    ) -> AdapterStartRequest {
        let run = json!({"id":format!("native-handoff-{handoff_id}"),"sessionId":session["id"],"providerSessionId":session["providerSessionId"],"agentInstanceId":request.instance["id"],"connectionId":session["connectionId"],"connectionRevision":session["connectionRevision"],"origin":"native-terminal"});
        let context = RunContext {
            working_directory: Some(request.cwd.clone()),
            member_id: session["memberId"].as_str().map(str::to_string),
            project_run_id: session["projectRunId"].as_str().map(str::to_string),
            task_id: session["taskId"].as_str().map(str::to_string),
            ..Default::default()
        };
        let callbacks = self.session_callbacks(session, &request.instance, &run, &context);
        let mut request = request.clone();
        request.session_events = Some(callbacks.events);
        request.session_interaction = Some(callbacks.interaction);
        request.session_tool = Some(callbacks.tool);
        drop(callbacks.handoff);
        request
    }
    pub fn native_terminal_status(&self, session_id: &str) -> CoreResult<Value> {
        let terminals = self.terminals.read().unwrap().clone();
        let mut status = terminals
            .as_ref()
            .map(|service| service.status(session_id))
            .unwrap_or_else(|| json!({"nativeActive":false}));
        if let Some(record) =
            NativeHistoryRepository::new(&self.db.lock().unwrap().raw).get(session_id)?
        {
            status["historySync"] = public_state(&record);
            if pending(&record) {
                status["nativeActive"] = json!(true);
                status["terminalId"] = record["terminalId"].clone();
            }
        }
        Ok(status)
    }
    pub async fn ensure_native_history(self: &Arc<Self>, session_id: &str) -> CoreResult<()> {
        let terminals = self.terminals.read().unwrap().clone();
        let _ownership = if let Some(terminals) = &terminals {
            Some(terminals.lock_session(session_id).await)
        } else {
            None
        };
        if terminals
            .as_ref()
            .is_some_and(|service| service.owns(session_id))
        {
            return Err(invalid(
                "sessionId",
                "会话正在原生终端中运行，请先结束终端，再继续聊天。",
            ));
        }
        let state = self
            .reconcile_native_history_locked(session_id, true)
            .await?;
        if !matches!(
            state["status"].as_str(),
            Some("none" | "synced" | "unsupported")
        ) {
            return Err(invalid(
                "nativeHistory",
                state["error"]
                    .as_str()
                    .unwrap_or("正在同步原生会话，请稍后继续聊天。"),
            ));
        }
        Ok(())
    }
    pub async fn reconcile_native_history(
        self: &Arc<Self>,
        session_id: &str,
        retry: bool,
    ) -> CoreResult<Value> {
        let terminals = self.terminals.read().unwrap().clone();
        let _ownership = if let Some(terminals) = &terminals {
            Some(terminals.lock_session(session_id).await)
        } else {
            None
        };
        self.reconcile_native_history_locked(session_id, retry)
            .await
    }
    pub async fn open_native_terminal_locked(
        self: &Arc<Self>,
        session_id: &str,
        cols: u16,
        rows: u16,
    ) -> CoreResult<Value> {
        let terminals = self
            .terminals
            .read()
            .unwrap()
            .clone()
            .ok_or_else(|| invalid("terminal", "Terminal service is unavailable"))?;
        let key = format!("harness:{session_id}");
        if let Some(existing) = terminals.existing(&key) {
            return Ok(existing);
        }
        if let Some(record) =
            NativeHistoryRepository::new(&self.db.lock().unwrap().raw).get(session_id)?
        {
            if pending(&record) {
                if let Some(metadata) = record["terminalId"]
                    .as_str()
                    .and_then(|id| terminals.metadata(id))
                {
                    return Ok(metadata);
                }
            }
        }
        if self.session_busy(session_id) {
            return Err(invalid(
                "sessionId",
                "请先等待或停止当前一轮，再交接到原生终端。",
            ));
        }
        let prior = self
            .reconcile_native_history_locked(session_id, true)
            .await?;
        if !matches!(
            prior["status"].as_str(),
            Some("none" | "synced" | "unsupported")
        ) {
            return Err(invalid(
                "nativeHistory",
                prior["error"]
                    .as_str()
                    .unwrap_or("上次原生会话的历史尚未完成同步。"),
            ));
        }
        let (mut session, request) = self.native_request(session_id)?;
        let adapter = self
            .adapters
            .get(request.instance["providerId"].as_str().unwrap_or(""))?;
        let resume = session["providerSessionId"].as_str().map(str::to_string);
        if resume.is_none()
            && !Repositories::new(&self.db.lock().unwrap().raw)
                .sessions()
                .messages(session_id)?
                .is_empty()
        {
            return Err(invalid(
                "providerSessionId",
                "当前连接尚无可恢复的原生会话，请先通过聊天建立原生会话后再打开终端。",
            ));
        }
        let before = if let Some(native) = &resume {
            adapter.read_session_history(&request, native).await?
        } else {
            None
        };
        let handoff_id = Uuid::new_v4().to_string();
        let event_request = self.terminal_event_request(&session, &request, &handoff_id);
        let plan = adapter
            .prepare_native_terminal(event_request, resume.clone())
            .await?;
        let native = plan.provider_session_id.clone().or(resume.clone());
        if resume.is_some() && native != resume {
            return Err(invalid(
                "providerSessionId",
                "Native terminal attempted to replace the selected native session",
            ));
        }
        if let Some(native) = &native {
            session["providerSessionId"] = json!(native);
            session["nativeWorkingDirectory"] = json!(request.cwd);
            Repositories::new(&self.db.lock().unwrap().raw)
                .sessions()
                .save(&session)?;
        }
        let baseline = match (before, native.as_deref()) {
            (Some(snapshot), _) => Some(snapshot),
            (None, Some(native)) => adapter.read_session_history(&request, native).await?,
            _ => None,
        };
        let context_complete = session["providerContextSyncedAt"].is_string()
            || Repositories::new(&self.db.lock().unwrap().raw)
                .sessions()
                .messages(session_id)?
                .is_empty();
        let mut record = json!({"id":handoff_id,"sessionId":session_id,"agentInstanceId":request.instance["id"],"providerId":request.instance["providerId"],"providerSessionId":native,
            "identity":identity(&session,&request),"phase":"opening","supported":baseline.is_some(),"baseline":baseline.as_ref().map(agenthub_plugin_sdk::history::fingerprints).unwrap_or_default(),
            "baselineVersion":2,"identityVersion":2,"startedAt":now_iso(),"contextComplete":context_complete,"ownerPid":std::process::id(),"messageCount":0});
        NativeHistoryRepository::new(&self.db.lock().unwrap().raw).save(&record)?;
        match terminals.open(key, Some(session_id.into()), plan, cols, rows) {
            Ok(metadata) => {
                record["phase"] = json!("running");
                record["terminalId"] = metadata["id"].clone();
                record["terminalPid"] = metadata["pid"].clone();
                NativeHistoryRepository::new(&self.db.lock().unwrap().raw).save(&record)?;
                self.watch_native_history(session_id, record["id"].as_str().unwrap_or(""));
                Ok(metadata)
            }
            Err(error) => {
                record["phase"] = json!("failed");
                record["error"] = json!(error.to_string());
                NativeHistoryRepository::new(&self.db.lock().unwrap().raw).save(&record)?;
                Err(error)
            }
        }
    }
    fn watch_native_history(self: &Arc<Self>, session_id: &str, handoff: &str) {
        let weak = Arc::downgrade(self);
        let session_id = session_id.to_string();
        let handoff = handoff.to_string();
        tokio::spawn(async move {
            loop {
                {
                    let Some(service) = weak.upgrade() else {
                        break;
                    };
                    let current = NativeHistoryRepository::new(&service.db.lock().unwrap().raw)
                        .get(&session_id)
                        .ok()
                        .flatten();
                    if !current.is_some_and(|record| {
                        record["id"] == handoff && pending(&record) && record["phase"] != "failed"
                    }) {
                        break;
                    }
                    let _ = service.reconcile_native_history(&session_id, false).await;
                }
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            }
        });
    }
    pub(super) async fn reconcile_native_history_locked(
        self: &Arc<Self>,
        session_id: &str,
        retry: bool,
    ) -> CoreResult<Value> {
        let Some(mut record) =
            NativeHistoryRepository::new(&self.db.lock().unwrap().raw).get(session_id)?
        else {
            return Ok(json!({"status":"none"}));
        };
        let (identity_session, request) = self.native_request(session_id)?;
        let history_supported = self
            .adapters
            .get(request.instance["providerId"].as_str().unwrap_or(""))?
            .native_history_supported(&request.instance);
        if !pending(&record) && !(record["phase"] == "unsupported" && history_supported) {
            return Ok(public_state(&record));
        }
        if record["identityVersion"] != 2
            && legacy_identity_matches(
                record["identity"].as_str().unwrap_or(""),
                &identity_session,
                &request,
            )
        {
            record["identity"] = json!(identity(&identity_session, &request));
            record["identityVersion"] = json!(2);
            if record["phase"] == "failed" {
                record["phase"] = json!("syncing");
                record.as_object_mut().unwrap().remove("error");
            }
            NativeHistoryRepository::new(&self.db.lock().unwrap().raw).save(&record)?;
        }
        let terminals = self.terminals.read().unwrap().clone();
        let mut live = terminals
            .as_ref()
            .is_some_and(|service| service.owns(session_id));
        if let Some(id) = record["terminalId"].as_str() {
            match terminals.as_ref().and_then(|service| service.exited(id)) {
                Some(false) => live = true,
                None if record["terminalPid"]
                    .as_u64()
                    .is_some_and(|pid| process_alive(pid as u32) != Some(false)) =>
                {
                    // Another daemon may own this TUI. Reading its persisted
                    // history never takes over its transport or writer lock.
                    live = true;
                }
                _ => {}
            }
        }
        if record["supported"] != true && history_supported {
            // Upgrade handoffs made before this plugin gained readback. Keep
            // the original boundary so existing local history is not cloned.
            record["supported"] = json!(true);
            record["ignoreBeforeMs"] = record["startedAt"]
                .as_str()
                .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                .map(|time| json!(time.timestamp_millis()))
                .unwrap_or(Value::Null);
        }
        if record["supported"] != true {
            if live {
                return Ok(public_state(&record));
            }
            record["phase"] = json!("unsupported");
            NativeHistoryRepository::new(&self.db.lock().unwrap().raw).save(&record)?;
            if let Some(id) = record["terminalId"].as_str() {
                if let Some(terminals) = &terminals {
                    terminals.release_resources(id);
                }
            }
            return Ok(public_state(&record));
        }
        let now = chrono::Utc::now().timestamp_millis();
        if !retry
            && (record["phase"] == "failed"
                || record["lastAttemptMs"]
                    .as_i64()
                    .is_some_and(|last| now - last < 1000))
        {
            return Ok(public_state(&record));
        }
        record["phase"] = json!(if live { "running" } else { "syncing" });
        record["lastAttemptMs"] = json!(now);
        record.as_object_mut().unwrap().remove("error");
        NativeHistoryRepository::new(&self.db.lock().unwrap().raw).save(&record)?;
        let result = self
            .read_and_commit_native_history(session_id, &record, live)
            .await;
        match result {
            Ok(state) => Ok(state),
            Err(error) => {
                if error
                    .0
                    .details
                    .as_ref()
                    .and_then(|d| d.get("field"))
                    .and_then(Value::as_str)
                    == Some("nativeHistoryRetry")
                {
                    // A live native event won the race. Its newer prefix stays
                    // authoritative; the watcher rereads without an error UI.
                    return Ok(public_state(&record));
                }
                record["phase"] = json!(if live { "running" } else { "failed" });
                record["error"] = json!(self.redaction.text(&error.to_string()));
                NativeHistoryRepository::new(&self.db.lock().unwrap().raw).save(&record)?;
                Ok(public_state(&record))
            }
        }
    }
    async fn read_and_commit_native_history(
        self: &Arc<Self>,
        session_id: &str,
        record: &Value,
        live: bool,
    ) -> CoreResult<Value> {
        let (mut session, mut request) = self.native_request(session_id)?;
        request.native_terminal_live = Some(live);
        if identity(&session, &request) != record["identity"].as_str().unwrap_or("")
            || session["providerSessionId"] != record["providerSessionId"]
        {
            return Err(invalid(
                "nativeHistory",
                "原生会话的账号、连接或目录已改变，请恢复原连接后重试同步。",
            ));
        }
        let native = record["providerSessionId"]
            .as_str()
            .ok_or_else(|| invalid("nativeHistory", "Native session identity is unavailable"))?;
        let adapter = self
            .adapters
            .get(request.instance["providerId"].as_str().unwrap_or(""))?;
        let snapshot = adapter
            .read_session_history(&request, native)
            .await?
            .ok_or_else(|| invalid("nativeHistory", "当前 CLI 没有提供可核实的原生历史。"))?;
        agenthub_plugin_sdk::history::validate(&snapshot, native)
            .map_err(|error| invalid("nativeHistory", &error.to_string()))?;
        let event_request =
            self.terminal_event_request(&session, &request, record["id"].as_str().unwrap_or(""));
        if !live {
            adapter
                .resume_terminal_events(&event_request, native, &snapshot)
                .await?;
        }
        let fingerprints = agenthub_plugin_sdk::history::fingerprints(&snapshot);
        let (bindings, messages, run_rows) = {
            let db = self.db.lock().unwrap();
            let repos = Repositories::new(&db.raw);
            let native_repo = NativeHistoryRepository::new(&db.raw);
            let mut bindings = HashMap::new();
            for kind in ["messages", "activities"] {
                for entry in snapshot[kind].as_array().into_iter().flatten() {
                    let id = entry["id"].as_str().unwrap_or("");
                    if let Some(binding) = native_repo.binding(session_id, native, kind, id)? {
                        bindings.insert(format!("{kind}:{id}"), binding);
                    } else if kind == "activities"
                        && adapter.native_message_ids_supported(&request.instance)
                    {
                        if let Some(run) = native_repo.activity_run(
                            session_id,
                            entry["event"]["callId"].as_str().unwrap_or(id),
                        )? {
                            if repos.runs().get(&run)?.is_some_and(|run| {
                                run["connectionId"] == session["connectionId"]
                                    && run["connectionRevision"] == session["connectionRevision"]
                            }) {
                                bindings.insert(
                                    format!("{kind}:{id}"),
                                    json!({"localId":run,"fingerprint":""}),
                                );
                            }
                        }
                    }
                }
            }
            (
                bindings,
                repos.sessions().messages(session_id)?,
                repos.runs().list_for_session(session_id)?,
            )
        };
        let mut batch = plan_import(
            &session,
            record,
            &snapshot,
            &fingerprints,
            &bindings,
            &messages,
            &run_rows,
            &self.redaction,
        )?;
        let root = {
            self.db
                .lock()
                .unwrap()
                .path()
                .parent()
                .unwrap_or(std::path::Path::new("."))
                .join("native-attachments")
        };
        for message in &mut batch.messages {
            let id = message["nativeIdentity"]["id"].as_str().unwrap_or("");
            if let Some(source) = snapshot["messages"]
                .as_array()
                .unwrap()
                .iter()
                .find(|entry| entry["id"] == id)
            {
                let (artifacts, unavailable) = prepare_files(&root, &session, record, source)?;
                message["attachmentIds"] = json!(artifacts
                    .iter()
                    .map(|a| a["id"].clone())
                    .collect::<Vec<_>>());
                if !unavailable.is_empty() {
                    message["nativeFiles"] = json!(unavailable);
                }
                batch.artifacts.extend(artifacts);
            }
        }
        let (current, current_request) = self.native_request(session_id)?;
        if identity(&current, &current_request) != record["identity"].as_str().unwrap_or("")
            || current["providerSessionId"] != record["providerSessionId"]
        {
            return Err(invalid(
                "nativeHistory",
                "原生连接在读取历史时发生变化，请恢复原连接后重试。",
            ));
        }
        batch.expected_session = Some(current.clone());
        session = current;
        let settled = snapshot["settled"] == true;
        if !live && settled && record["contextComplete"] == true {
            session["providerContextSyncedAt"] = json!(now_iso());
        }
        let mut imported = record["importedMessageIds"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect::<std::collections::BTreeSet<_>>();
        imported.extend(
            batch
                .messages
                .iter()
                .filter_map(|m| m["id"].as_str())
                .map(str::to_string),
        );
        let mut next = record.clone();
        next["phase"] = json!(if live {
            "running"
        } else if settled {
            "synced"
        } else {
            "syncing"
        });
        next["baseline"] = json!(fingerprints);
        next["baselineVersion"] = json!(2);
        next["syncedAt"] = json!(now_iso());
        next["nativeBusy"] = json!(!settled);
        next["messageCount"] = json!(imported.len());
        next["importedMessageIds"] = json!(imported);
        let committed = {
            let db = self.db.lock().unwrap();
            NativeHistoryRepository::new(&db.raw).commit(
                &session,
                record["id"].as_str().unwrap_or(""),
                &next,
                batch,
            )?
        };
        self.events.publish_committed(&committed);
        if let Some(id) = record["terminalId"].as_str().filter(|_| !live && settled) {
            if let Some(terminals) = self.terminals.read().unwrap().as_ref() {
                terminals.release_resources(id);
            }
        }
        Ok(public_state(&next))
    }
}

fn plan_import(
    session: &Value,
    record: &Value,
    snapshot: &Value,
    fingerprints: &HashMap<String, String>,
    bindings: &HashMap<String, Value>,
    existing: &[Value],
    runs: &[Value],
    redaction: &RedactionService,
) -> CoreResult<ImportBatch> {
    let mut batch = ImportBatch::default();
    let sid = session["id"].as_str().unwrap_or("");
    let native = record["providerSessionId"].as_str().unwrap_or("");
    let fallback = record["startedAt"].as_str().unwrap_or("");
    let existing = existing
        .iter()
        .filter_map(|m| Some((m["id"].as_str()?.to_string(), m)))
        .collect::<HashMap<_, _>>();
    let mut native_runs: HashMap<String, (String, bool)> = HashMap::new();
    let mut native_statuses: HashMap<String, String> = HashMap::new();
    for kind in ["messages", "activities"] {
        for entry in snapshot[kind].as_array().into_iter().flatten() {
            let native_id = entry["id"].as_str().unwrap_or("");
            let key = format!("{kind}:{native_id}");
            let fingerprint = &fingerprints[&key];
            let binding = bindings.get(&key);
            if binding.is_none()
                && entry["timestampMs"]
                    .as_i64()
                    .zip(record["ignoreBeforeMs"].as_i64())
                    .is_some_and(|(entry, boundary)| entry < boundary)
            {
                continue;
            }
            let turn = entry["nativeTurnId"]
                .as_str()
                .unwrap_or_else(|| entry["messageId"].as_str().unwrap_or(native_id));
            let run_id = if kind == "activities" {
                binding
                    .and_then(|b| b["localId"].as_str())
                    .map(str::to_string)
                    .unwrap_or_else(|| native_run_id(sid, native, turn))
            } else {
                native_run_id(sid, native, turn)
            };
            // Older handoffs hashed entries before turnStatus existed. A new
            // lifecycle field is not evidence that an unbound old message was
            // edited. Compare that exact older snapshot shape once.
            let legacy_unchanged = record["baselineVersion"] != 2
                && record["baseline"][&key].as_str().is_some_and(|old| {
                    let mut legacy = entry.clone();
                    legacy.as_object_mut().unwrap().remove("turnStatus");
                    old == hash(legacy.to_string())
                });
            let changed = !legacy_unchanged
                && record["baseline"][&key].as_str() != Some(fingerprint)
                && binding.and_then(|b| b["fingerprint"].as_str()) != Some(fingerprint);
            if changed
                || runs
                    .iter()
                    .any(|run| run["id"] == run_id && run["origin"] == "native-terminal")
            {
                if let Some(status) = entry["turnStatus"].as_str() {
                    native_statuses.insert(run_id.clone(), status.into());
                    native_runs
                        .entry(run_id.clone())
                        .or_insert((timestamp(entry, fallback), entry["completed"] == true));
                }
            }
            if !changed {
                continue;
            }
            if kind == "messages" {
                let old = binding
                    .and_then(|b| b["localId"].as_str())
                    .and_then(|id| existing.get(id).copied());
                if record["baseline"].get(&key).is_some() && old.is_none() {
                    return Err(invalid("nativeHistory","原生旧消息发生了编辑，但此前未保存它的本地 ID；为避免生成重复消息，已保留待对账状态。"));
                }
                let mut message=old.cloned().unwrap_or_else(||json!({"id":native_message_id(sid,native,native_id),"sessionId":sid,"sender":if entry["role"]=="user"{"user"}else{"agent"},"kind":"chat","createdAt":timestamp(entry,fallback)}));
                message["text"] = json!(redaction.text(entry["text"].as_str().unwrap_or("")));
                message["nativeIdentity"] = json!({"providerId":record["providerId"],"providerSessionId":native,"id":native_id,"messageId":entry["messageId"],"source":"native-terminal","completed":entry["completed"]});
                if let Some(status) = entry["turnStatus"].as_str() {
                    message["nativeIdentity"]["turnStatus"] = json!(status);
                }
                if entry["role"] == "assistant" && message.get("runId").is_none() {
                    message["runId"] = json!(run_id);
                }
                if old.is_some() {
                    message["editedAt"] = json!(now_iso());
                }
                batch.bindings.push(json!({"kind":kind,"nativeId":native_id,"localId":message["id"],"fingerprint":fingerprint}));
                if entry["role"] == "assistant" && message["runId"] == run_id {
                    native_runs
                        .entry(run_id.clone())
                        .and_modify(|(_, complete)| *complete &= entry["completed"] == true)
                        .or_insert((timestamp(entry, fallback), entry["completed"] == true));
                }
                batch.messages.push(message);
                batch.expected_messages.push((
                    batch.messages.last().unwrap()["id"]
                        .as_str()
                        .unwrap()
                        .into(),
                    old.cloned(),
                ));
            } else {
                let event = &entry["event"];
                let event_type = match event["kind"].as_str().unwrap_or("") {
                    "thinking" => "agent.thinking_summary",
                    "tool" => {
                        if event["phase"] == "completed" {
                            "tool.finished"
                        } else {
                            "tool.started"
                        }
                    }
                    "command" => {
                        if event["phase"] == "completed" {
                            "command.finished"
                        } else {
                            "command.started"
                        }
                    }
                    "usage" => "usage.updated",
                    _ => continue,
                };
                let mut payload = match event["kind"].as_str().unwrap_or("") {
                    "tool" => {
                        json!({"callId":event["callId"],"toolName":event["name"],"inputSummary":event.get("input").and_then(|input|redacted_summary(input,redaction,tool_input_limit(event["name"].as_str().unwrap_or("")))),"outputSummary":event.get("output").and_then(|output|redacted_summary(output,redaction,2000)),"success":event["success"]})
                    }
                    "command" => {
                        json!({"callId":event["callId"],"command":event["command"],"cwd":session["nativeWorkingDirectory"],"exitCode":event["exitCode"],"outputSummary":event["output"]})
                    }
                    _ => {
                        let mut payload = event.clone();
                        payload.as_object_mut().unwrap().remove("raw");
                        payload
                    }
                };
                if event["kind"] == "thinking" {
                    payload["messageId"] = json!(native_id);
                }
                if let Some(meta) =
                    subagent_meta(event["name"].as_str().unwrap_or(""), event.get("input"))
                {
                    payload["subagent"] = meta;
                }
                batch.activities.push(json!({"type":event_type,"runId":run_id,"timestamp":timestamp(entry,fallback),"payload":redaction.value(&payload)}));
                batch.bindings.push(json!({"kind":kind,"nativeId":native_id,"localId":run_id,"fingerprint":fingerprint}));
                native_runs
                    .entry(run_id)
                    .and_modify(|(_, complete)| *complete &= entry["completed"] == true)
                    .or_insert((timestamp(entry, fallback), entry["completed"] == true));
            }
        }
    }
    for (id, (started, complete)) in native_runs {
        let prior = runs.iter().find(|run| run["id"] == id);
        if prior.is_some_and(|run| run["origin"] != "native-terminal") {
            continue;
        }
        let live = record["phase"] == "running" || snapshot["settled"] != true;
        let status = native_statuses
            .get(&id)
            .map(String::as_str)
            .unwrap_or(if complete {
                "completed"
            } else if live {
                "running"
            } else {
                "failed"
            });
        if prior.is_some_and(|run| run["status"] == status) {
            continue;
        }
        let mut run=prior.cloned().unwrap_or_else(||json!({"id":id,"sessionId":sid,"agentInstanceId":record.get("agentInstanceId").unwrap_or(&session["agentInstanceId"]),"connectionId":session["connectionId"],"connectionRevision":session["connectionRevision"],"mode":"foreground","startedAt":started,"origin":"native-terminal","providerSessionId":native}));
        run["status"] = json!(status);
        if status != "failed" {
            run.as_object_mut().unwrap().remove("failureCode");
        }
        if status == "running" {
            run.as_object_mut().unwrap().remove("endedAt");
        }
        if status != "running" {
            run["endedAt"] = json!(now_iso());
        }
        if status == "failed" {
            run["failureCode"] = json!("NATIVE_HISTORY_INCOMPLETE");
        }
        batch.expected_runs.push((id.clone(), prior.cloned()));
        batch.runs.push(run);
        batch.activities.push(json!({"type":match status{"completed"=>"run.completed","cancelled"=>"run.cancelled","running"=>"run.started",_=>"run.failed"},"runId":id,"payload":match status{"completed"=>json!({"summary":""}),"running"=>json!({"origin":"native-terminal"}),"cancelled"=>json!({"reason":"native-terminal"}),_=>json!({"code":"NATIVE_HISTORY_INCOMPLETE","message":"原生会话未报告此轮完成，已保留现有输出。","retryable":false})}}));
    }
    Ok(batch)
}

fn prepare_files(
    root: &std::path::Path,
    session: &Value,
    record: &Value,
    entry: &Value,
) -> CoreResult<(Vec<Value>, Vec<Value>)> {
    use base64::Engine;
    let mut artifacts = vec![];
    let mut unavailable = vec![];
    for file in entry["files"].as_array().into_iter().flatten() {
        let url = file["url"].as_str().unwrap_or("");
        let name = file["filename"].as_str().unwrap_or("Native attachment");
        let id = format!(
            "native-file-{}",
            hash(json!([session["id"], record["providerSessionId"], file["id"]]).to_string())
        );
        let path = if url.starts_with("file:") {
            reqwest::Url::parse(url)
                .ok()
                .and_then(|url| url.to_file_path().ok())
        } else if let Some((header, data)) = url
            .strip_prefix("data:")
            .and_then(|data| data.split_once(','))
        {
            if !header.ends_with(";base64") || data.len() > 140 * 1024 * 1024 {
                return Err(invalid(
                    "nativeHistory",
                    "原生附件数据格式不受支持或超过大小限制。",
                ));
            }
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(data)
                .map_err(|_| invalid("nativeHistory", "原生附件数据无法解码。"))?;
            if bytes.len() > 100 * 1024 * 1024 {
                return Err(invalid(
                    "nativeHistory",
                    "原生附件超过 100 MiB，请在原生会话中查看。",
                ));
            }
            std::fs::create_dir_all(root).map_err(crate::database::connection::io_fail)?;
            let path = root.join(format!("{id}-{}", hash(&bytes)));
            std::fs::write(&path, bytes).map_err(crate::database::connection::io_fail)?;
            Some(path)
        } else {
            None
        };
        let Some(path) = path.filter(|path| path.is_file()) else {
            unavailable.push(json!({"id":file["id"],"name":name,"unavailable":true}));
            continue;
        };
        let size = std::fs::metadata(&path)
            .map_err(crate::database::connection::io_fail)?
            .len();
        if size > 100 * 1024 * 1024 {
            return Err(invalid(
                "nativeHistory",
                "原生附件超过 100 MiB，请在原生会话中查看。",
            ));
        }
        let bytes = std::fs::read(&path).map_err(crate::database::connection::io_fail)?;
        artifacts.push(json!({"id":id,"kind":if file["mime"].as_str().is_some_and(|mime|mime.starts_with("image/")){"image"}else{"file"},"name":name,"path":path,"sessionId":session["id"],"contentHash":hash(bytes),"metadata":{"source":"native-terminal","nativeFileId":file["id"],"mimeType":file["mime"],"sizeBytes":size}}));
    }
    Ok((artifacts, unavailable))
}

fn redacted_summary(value: &Value, redaction: &RedactionService, limit: usize) -> Option<String> {
    if value.is_null() {
        None
    } else {
        let text = value
            .as_str()
            .map(str::to_string)
            .unwrap_or_else(|| value.to_string());
        Some(redaction.text(&text.chars().take(limit).collect::<String>()))
    }
}

#[cfg(windows)]
fn process_alive(pid: u32) -> Option<bool> {
    use std::ffi::c_void;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut c_void;
        fn WaitForSingleObject(handle: *mut c_void, millis: u32) -> u32;
        fn CloseHandle(handle: *mut c_void) -> i32;
        fn GetLastError() -> u32;
    }
    unsafe {
        let handle = OpenProcess(0x00100000, 0, pid);
        if handle.is_null() {
            return if GetLastError() == 87 {
                Some(false)
            } else {
                None
            };
        }
        let state = WaitForSingleObject(handle, 0);
        CloseHandle(handle);
        match state {
            0 => Some(false),
            258 => Some(true),
            _ => None,
        }
    }
}
#[cfg(unix)]
fn process_alive(pid: u32) -> Option<bool> {
    if pid == 0 || pid > i32::MAX as u32 {
        return None;
    }
    unsafe extern "C" {
        fn kill(pid: i32, signal: i32) -> i32;
    }
    if unsafe { kill(pid as i32, 0) } == 0 {
        Some(true)
    } else if std::io::Error::last_os_error().raw_os_error() == Some(3) {
        Some(false)
    } else {
        None
    }
}
#[cfg(not(any(windows, unix)))]
fn process_alive(_pid: u32) -> Option<bool> {
    None
}

#[cfg(test)]
#[path = "native_history_tests.rs"]
mod tests;
