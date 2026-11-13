//! Observed request lifecycle. No prompt, credential, tool input or result is stored here.
use crate::adapters::AdapterEvent;
use crate::database::{Database, Repositories};
use crate::errors::{now_iso, CoreResult};
use crate::runtime::security::RedactionService;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Instant;

struct LiveRequest {
    start: Instant,
    row: Value,
    seen: HashSet<String>,
}
pub struct RequestLogService {
    db: Arc<Mutex<Database>>,
    live: Mutex<HashMap<String, LiveRequest>>,
    redaction: RedactionService,
}
impl RequestLogService {
    pub fn new(db: Arc<Mutex<Database>>, redaction: RedactionService) -> Self {
        let _ = Repositories::new(&db.lock().unwrap().raw)
            .request_logs()
            .interrupt_open();
        Self {
            db,
            live: Mutex::new(HashMap::new()),
            redaction,
        }
    }
    pub fn begin(
        &self,
        session: &Value,
        agent: &Value,
        operation: &str,
        message: Option<&str>,
    ) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        let now = now_iso();
        let mut row = json!({"id":id,"sessionId":session["id"],"projectId":session["projectId"],"agentInstanceId":agent["id"],"providerId":agent["providerId"],"operation":operation,"createdAt":now,"updatedAt":now,"status":"queued","milestones":{"queued":0},"suppliedTools":[],"suppliedServers":[],"observedTools":[]});
        for key in ["connectionId", "connectionRevision", "model"] {
            if let Some(v) = session.get(key) {
                row[key] = v.clone();
            }
        }
        if let Some(message) = message {
            row["messageId"] = json!(message);
        }
        let _ = Repositories::new(&self.db.lock().unwrap().raw)
            .request_logs()
            .save(&row);
        self.live.lock().unwrap().insert(
            id.clone(),
            LiveRequest {
                start: Instant::now(),
                row,
                seen: HashSet::new(),
            },
        );
        id
    }
    fn update(&self, id: &str, edit: impl FnOnce(&mut LiveRequest) -> bool) {
        let mut live = self.live.lock().unwrap();
        let Some(request) = live.get_mut(id) else {
            return;
        };
        if edit(request) {
            request.row["updatedAt"] = json!(now_iso());
            let _ = Repositories::new(&self.db.lock().unwrap().raw)
                .request_logs()
                .save(&request.row);
        }
    }
    pub fn mark(&self, id: &str, stage: &str) {
        self.update(id, |r| mark(r, stage));
    }
    pub fn attach(&self, id: &str, run: &Value) {
        self.update(id, |r| {
            r.row["runId"] = run["id"].clone();
            true
        });
    }
    pub fn supplied(&self, id: &str, tools: Option<&Value>, servers: Option<&Vec<Value>>) {
        self.update(id, |r| {
            r.row["suppliedTools"] = json!(names(tools));
            r.row["suppliedServers"] = json!(servers
                .into_iter()
                .flatten()
                .filter_map(|s| s["name"].as_str())
                .collect::<Vec<_>>());
            mark(r, "prepared");
            true
        });
    }
    pub fn observe(&self, id: &str, event: &AdapterEvent) {
        self.update(id,|r|{
            let mut changed=false;
            match event {
                AdapterEvent::Status{phase,raw} if phase=="runtime_ready" => {changed|=mark(r,"runtimeReady"); if let Some(raw)=raw {let mut safe=json!({"reused":raw["reused"],"pid":raw["pid"],"attachMs":raw["attachMs"]});
                    let startup = &raw["startupTimings"];
                    if ["prepareMs", "bootstrapMs", "sessionOpenMs"].iter().all(|key| startup[*key].as_u64().is_some()) {
                        safe["startupTimings"] = json!({"prepareMs": startup["prepareMs"], "bootstrapMs": startup["bootstrapMs"], "sessionOpenMs": startup["sessionOpenMs"]});
                        let details = &startup["openDetails"];
                        if ["providerBindMs", "sessionCreateMs", "agentResolveMs", "preferencesMs"].iter().all(|key| details[*key].as_u64().is_some()) {
                            safe["startupTimings"]["openDetails"] = json!({"providerBindMs":details["providerBindMs"],"sessionCreateMs":details["sessionCreateMs"],"agentResolveMs":details["agentResolveMs"],"preferencesMs":details["preferencesMs"]});
                            for key in ["loaderWaitMs", "providerUpdateMs"] {
                                if let Some(value) = details[key].as_u64() {
                                    safe["startupTimings"]["openDetails"][key] = json!(value);
                                }
                            }
                            if let Some(plugins) = details["pendingPlugins"].as_array() {
                                safe["startupTimings"]["openDetails"]["pendingPlugins"] = json!(plugins.iter().filter_map(Value::as_str).collect::<Vec<_>>());
                            }
                        }
                    } if r.row["runtime"]!=safe{r.row["runtime"]=safe;changed=true;}}},
                AdapterEvent::Status{phase,raw:Some(raw)} if phase=="runtime_capabilities" => {
                    if raw["tools"].is_array(){r.row["nativeTools"]=json!(names(raw.get("tools")));changed=true;}
                    if let Some(servers)=raw.get("mcpServers").or_else(||raw.get("mcp_servers")).and_then(Value::as_array){r.row["nativeServers"]=json!(servers.iter().filter_map(|s|Some(json!({"name":s["name"].as_str()?,"status":s["status"]}))).collect::<Vec<_>>());changed=true;}
                },
                AdapterEvent::Message{text,subagent_dispatch_id,..} if !text.is_empty() && subagent_dispatch_id.is_none() => {changed|=mark(r,"firstText");changed|=mark(r,"firstEvent");},
                AdapterEvent::Thinking{text,subagent_dispatch_id,..} if !text.is_empty() && subagent_dispatch_id.is_none() => {changed|=mark(r,"firstThinking");changed|=mark(r,"firstEvent");},
                AdapterEvent::Tool{name,..} => {changed|=mark(r,"firstEvent");if r.seen.insert(format!("tool:{name}")){r.row["observedTools"].as_array_mut().unwrap().push(json!(name));changed=true;}},
                AdapterEvent::Error{message} => {r.row["failure"]=json!({"stage":failure_stage(&r.row),"message":self.redaction.text(message)});changed=true;},
                AdapterEvent::Exit{..} => {changed|=mark(r,"ended");},
                _=>{}
            }; changed
        });
    }
    pub fn finish(&self, id: &str, status: &str, code: Option<&str>, error: Option<&str>) {
        self.update(id,|r|{mark(r,"ended");r.row["status"]=json!(if matches!(status,"completed"|"cancelled"|"interrupted"){status}else{"failed"});if error.is_some()||code.is_some(){let message=error.or_else(||r.row["failure"]["message"].as_str()).unwrap_or("Request failed").to_string();r.row["failure"]=json!({"stage":failure_stage(&r.row),"code":code,"message":self.redaction.text(&message)});}true});
        self.live.lock().unwrap().remove(id);
    }
    pub fn cancel_queued(&self, session_id: &str, message_id: &str) {
        let ids = self
            .live
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, r)| {
                r.row["sessionId"] == session_id
                    && r.row["messageId"] == message_id
                    && r.row["status"] == "queued"
            })
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        for id in ids {
            self.finish(&id, "cancelled", None, None);
        }
    }
    pub fn list(&self, input: &Value) -> CoreResult<Value> {
        Repositories::new(&self.db.lock().unwrap().raw)
            .request_logs()
            .page(input)
    }
    pub fn inventory(&self, session_id: &str) -> CoreResult<Value> {
        let page = self.list(&json!({"sessionId":session_id,"limit":1}))?;
        let r = &page["items"][0];
        let mut tools = std::collections::BTreeMap::<String, &str>::new();
        for (field, proof) in [
            ("suppliedTools", "supplied"),
            ("observedTools", "observed"),
            ("nativeTools", "native"),
        ] {
            for name in names(r.get(field)) {
                tools.insert(name, proof);
            }
        }
        let mut servers = std::collections::BTreeMap::<String, Value>::new();
        for name in names(r.get("suppliedServers")) {
            servers.insert(name.clone(), json!({"name":name,"evidence":"supplied"}));
        }
        for s in r["nativeServers"].as_array().into_iter().flatten() {
            if let Some(name) = s["name"].as_str() {
                servers.insert(
                    name.into(),
                    json!({"name":name,"status":s["status"],"evidence":"native"}),
                );
            }
        }
        Ok(
            json!({"sessionId":session_id,"checkedAt":now_iso(),"requestId":r["id"],"nativeReported":r.get("nativeTools").is_some(),"tools":tools.into_iter().map(|(name,evidence)|json!({"name":name,"evidence":evidence})).collect::<Vec<_>>(),"servers":servers.into_values().collect::<Vec<_>>() }),
        )
    }
}
fn mark(r: &mut LiveRequest, stage: &str) -> bool {
    if !r.seen.insert(stage.into()) {
        return false;
    }
    r.row["milestones"][stage] = json!(r.start.elapsed().as_millis().min(u64::MAX as u128) as u64);
    match stage {
        "preparing" => r.row["status"] = json!("preparing"),
        "dispatched" => r.row["status"] = json!("running"),
        _ => {}
    }
    true
}
fn names(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|v| v.as_str().or_else(|| v["name"].as_str()))
        .map(|s| s.chars().take(200).collect())
        .collect()
}
fn failure_stage(row: &Value) -> &str {
    if row["milestones"]["dispatched"].is_null() {
        "preparation"
    } else if row["milestones"]["runtimeReady"].is_null() {
        "native_startup"
    } else if row["milestones"]["firstEvent"].is_null() {
        "model_wait"
    } else {
        "execution"
    }
}
