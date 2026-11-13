use super::*;
use crate::{database::remote::CommandReservation, ipc_gateway::GatewayRequest};
use sha2::{Digest, Sha256};
use std::time::Duration;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Request {
    pub v: u8,
    pub id: String,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

pub(super) fn failure(id: &str, code: &str, message: &str) -> Value {
    json!({"v":1,"id":id,"ok":false,"error":{"code":code,"message":message}})
}
fn success(id: &str, value: Value) -> Value {
    json!({"v":1,"id":id,"ok":true,"data":value})
}
fn field<'a>(params: &'a Value, name: &str) -> Result<&'a str> {
    params[name]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 128)
        .ok_or_else(|| anyhow::anyhow!("INVALID_REQUEST"))
}
fn mutation(method: &str) -> bool {
    matches!(
        method,
        "project.create"
            | "session.create"
            | "session.configure"
            | "session.send"
            | "session.followUp"
            | "run.cancel"
            | "interaction.respond"
            | "approval.resolve"
    )
}

impl RemoteService {
    pub(super) async fn request(&self, peer: &str, request: Request, generation: u64) -> Value {
        let id = request.id.clone();
        let outcome = self.handle(peer, request, generation).await;
        match outcome {
            Ok(value) => value,
            Err(error) => {
                let message = error.to_string();
                let code = if message.bytes().all(|c| c.is_ascii_uppercase() || c == b'_') {
                    message.as_str()
                } else {
                    "REMOTE_REQUEST_FAILED"
                };
                failure(
                    &id,
                    code,
                    if code == "REMOTE_REQUEST_FAILED" {
                        "Desktop could not complete the request"
                    } else {
                        &message
                    },
                )
            }
        }
    }
    pub(super) async fn dispatch(&self, method: &str, input: Value) -> Result<Value> {
        let router = self
            .router
            .lock()
            .unwrap()
            .upgrade()
            .ok_or_else(|| anyhow::anyhow!("DESKTOP_UNAVAILABLE"))?;
        let response = router
            .dispatch(&GatewayRequest {
                request_id: None,
                method: method.into(),
                input,
            })
            .await;
        if !response.ok {
            bail!(
                "{}",
                response
                    .error
                    .map(|e| e.code)
                    .unwrap_or_else(|| "DESKTOP_ERROR".into())
            );
        }
        Ok(response.data.unwrap_or(Value::Null))
    }
    fn authorize(&self, peer: &str, generation: u64) -> Result<Value> {
        let state = self.state.lock().unwrap();
        if state.generation != generation || state.endpoint.is_none() {
            bail!("REMOTE_DISABLED");
        }
        drop(state);
        let mut device = self
            .repo
            .device(peer)?
            .ok_or_else(|| anyhow::anyhow!("DEVICE_NOT_AUTHORIZED"))?;
        // Pairing is owner access, including projects created after pairing.
        device["access"] = json!("control");
        device["projectIds"] = json!(self.repo.project_ids()?);
        Ok(device)
    }
    async fn handle(&self, peer: &str, request: Request, generation: u64) -> Result<Value> {
        if request.v != 1 {
            bail!("PROTOCOL_VERSION_UNSUPPORTED");
        }
        {
            let state = self.state.lock().unwrap();
            if state.generation != generation || state.endpoint.is_none() {
                bail!("REMOTE_DISABLED");
            }
        }
        uuid::Uuid::parse_str(&request.id).map_err(|_| anyhow::anyhow!("INVALID_REQUEST_ID"))?;
        if request.method == "pair" {
            return Ok(success(&request.id, self.pair(peer, &request.params)?));
        }
        if request.method == "pair.status" {
            let device = self.repo.device(peer)?;
            let pending = self
                .state
                .lock()
                .unwrap()
                .pending
                .get(peer)
                .is_some_and(|p| p.expires_at > pairing::now_ms());
            return Ok(success(
                &request.id,
                json!({"state":if device.is_some(){"paired"}else if pending{"awaitingApproval"}else{"expired"}}),
            ));
        }
        let device = self.authorize(peer, generation)?;
        let method = request.method.as_str();
        let params = &request.params;
        if method == "hello" {
            return Ok(success(
                &request.id,
                json!({"protocol":1,"epoch":self.repo.epoch()?,"device":device,"name":self.settings()?.device_name,
                "system":std::env::consts::OS,"version":env!("CARGO_PKG_VERSION"),
                "capabilities":["projects.list","project.browse","project.create","session.options","session.catalog","sessions.list","session.history","session.create","session.details","session.models","session.configure","session.workspace","events.wait","session.send","session.followUp","run.list","run.cancel","interaction.list","interaction.respond","approval.list","approval.resolve"]}),
            ));
        }
        if method == "projects.list" {
            let all = self.dispatch("project.list", json!({})).await?;
            let projects = all
                .as_array()
                .into_iter()
                .flatten()
                .map(|p| json!({"id":p["id"],"name":p["name"],"rootPath":p["rootPath"]}))
                .collect::<Vec<_>>();
            return Ok(success(&request.id, json!({"projects":projects})));
        }
        if method == "sessions.list" {
            let project = field(params, "projectId")?;
            let all = self
                .dispatch("session.list", json!({"projectId":project}))
                .await?;
            let offset = params["offset"].as_u64().unwrap_or(0).min(1_000_000) as usize;
            let limit = params["limit"].as_u64().unwrap_or(100).clamp(1, 200) as usize;
            let total = all.as_array().map_or(0, Vec::len);
            let sessions=all.as_array().into_iter().flatten().skip(offset).take(limit).map(|s|json!({"id":s["id"],"title":s["title"],"status":s["status"],
                "projectId":s["projectId"],"agentInstanceId":s["agentInstanceId"],"createdAt":s["createdAt"],"lastMessageAt":s["lastMessageAt"]})).collect::<Vec<_>>();
            return Ok(success(
                &request.id,
                json!({"sessions":sessions,"total":total,"nextOffset":if offset+limit<total {Some(offset+limit)}else{None}}),
            ));
        }
        let session = if [
            "project.browse",
            "project.create",
            "session.options",
            "session.catalog",
        ]
        .contains(&method)
            || (method == "session.create" && params["sessionId"].as_str().is_none())
        {
            String::new()
        } else if method == "run.cancel" {
            self.repo.run_session(field(params, "runId")?)?
        } else {
            field(params, "sessionId")?.to_owned()
        };
        if !session.is_empty() {
            self.repo.session_project(&session)?;
        }
        let key = format!("{peer}:{}", request.id);
        let fingerprint = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&json!([method, params]))?)
        );
        if mutation(method) {
            match self.repo.previous(&key,&fingerprint)? {
                Some(CommandReservation::Completed(response))=>return Ok(response),
                Some(CommandReservation::Pending)=>return Ok(failure(&request.id,"COMMAND_OUTCOME_PENDING","The desktop accepted this command. Read session history before retrying with a new ID.")),
                _=>{},
            }
        }
        let input = match method {
            "project.browse" => {
                return Ok(success(&request.id, mobile::browse_directories(params)?))
            }
            "project.create" => mobile::project_input(params)?,
            "session.options" => return Ok(success(&request.id, self.repo.mobile_options()?)),
            "session.catalog" => {
                return Ok(success(&request.id, self.mobile_catalog(params).await?))
            }
            "session.details" => {
                return Ok(success(&request.id, self.repo.session_details(&session)?))
            }
            "session.models" => {
                return Ok(success(&request.id, self.mobile_models(&session).await?))
            }
            "session.workspace" => {
                return Ok(success(&request.id, self.repo.workspace_changes(&session)?))
            }
            "session.configure" => self.mobile_configuration(&session, params).await?,
            "session.create" => {
                let mut template = if session.is_empty() {
                    self.repo.mobile_session_input(params)?
                } else {
                    self.repo.session_template(&session)?
                };
                let title = params["title"].as_str().unwrap_or("New session");
                if title.len() > 256 {
                    bail!("INVALID_TITLE");
                }
                template["title"] = json!(title);
                template
            }
            "run.list" => json!({"sessionId":session}),
            "session.history" => {
                return Ok(success(
                    &request.id,
                    self.repo.history(
                        &session,
                        params.get("before"),
                        params["limit"].as_u64().unwrap_or(50).min(100) as usize,
                    )?,
                ))
            }
            "events.wait" => {
                if params["epoch"].as_str() != Some(self.repo.epoch()?.as_str()) {
                    bail!("CURSOR_RESET_REQUIRED");
                }
                let after = params["afterSequence"]
                    .as_i64()
                    .filter(|n| *n >= 0)
                    .ok_or_else(|| anyhow::anyhow!("INVALID_CURSOR"))?;
                let mut wake = self.events.subscribe_events();
                let limit = params["limit"].as_u64().unwrap_or(100).min(200) as usize;
                let mut page = self.repo.events(&session, after, limit)?;
                if page["events"].as_array().is_some_and(Vec::is_empty) {
                    let until = tokio::time::Instant::now() + Duration::from_secs(20);
                    loop {
                        match tokio::time::timeout_at(until, wake.recv()).await {
                            Ok(Ok(event)) if event["sessionId"] != session => continue,
                            _ => break,
                        }
                    }
                    self.authorize(peer, generation)?;
                    page = self.repo.events(&session, after, limit)?;
                }
                return Ok(success(&request.id, page));
            }
            "session.send" | "session.followUp" => {
                let text = params["text"]
                    .as_str()
                    .filter(|s| !s.trim().is_empty() && s.len() <= 100_000)
                    .ok_or_else(|| anyhow::anyhow!("INVALID_MESSAGE"))?;
                let digest = Sha256::digest(format!("nautilo-remote:{peer}:{}", request.id));
                let message_id =
                    uuid::Uuid::from_bytes(digest[..16].try_into().unwrap()).to_string();
                let mut input = json!({"sessionId":session,"text":text,"messageId":message_id});
                if method == "session.followUp" {
                    let mode = params["mode"].as_str().unwrap_or("queue");
                    if !["steer", "queue"].contains(&mode) {
                        bail!("INVALID_FOLLOW_UP_MODE");
                    }
                    input["mode"] = json!(mode);
                }
                input
            }
            "run.cancel" => json!({"runId":field(params,"runId")?}),
            "interaction.list" => json!({"sessionId":session,"status":"pending"}),
            "interaction.respond" => {
                let id = field(params, "interactionId")?;
                let pending = self
                    .dispatch(
                        "interaction.list",
                        json!({"sessionId":session,"status":"pending"}),
                    )
                    .await?;
                if !pending
                    .as_array()
                    .is_some_and(|a| a.iter().any(|v| v["id"] == id))
                {
                    bail!("INTERACTION_NOT_AVAILABLE");
                }
                if !["selected", "cancelled"].contains(&params["outcome"].as_str().unwrap_or("")) {
                    bail!("INVALID_OUTCOME");
                }
                json!({"interactionId":id,"outcome":params["outcome"],"optionId":params["optionId"],"answers":params["answers"]})
            }
            "approval.list" | "approval.resolve" => {
                let all = self
                    .dispatch("approval.list", json!({"status":"pending"}))
                    .await?;
                let approvals = all
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|a| {
                        a["sessionId"] == session
                            || a["runId"]
                                .as_str()
                                .and_then(|id| self.repo.run_session(id).ok())
                                .as_deref()
                                == Some(&session)
                    })
                    .cloned()
                    .collect::<Vec<_>>();
                if method == "approval.list" {
                    return Ok(success(&request.id, json!(approvals)));
                }
                let id = field(params, "approvalId")?;
                if !approvals.iter().any(|a| a["id"] == id) {
                    bail!("APPROVAL_NOT_AVAILABLE");
                }
                if !["approved", "rejected"].contains(&params["decision"].as_str().unwrap_or("")) {
                    bail!("INVALID_DECISION");
                }
                json!({"approvalId":id,"decision":params["decision"],"scope":"once"})
            }
            _ => bail!("METHOD_NOT_ALLOWED"),
        };
        if !mutation(method) {
            return Ok(success(&request.id, self.dispatch(method, input).await?));
        }
        self.authorize(peer, generation)?;
        match self.repo.reserve(&key,&fingerprint)? {
            CommandReservation::Completed(response)=>return Ok(response),
            CommandReservation::Pending=>return Ok(failure(&request.id,"COMMAND_OUTCOME_PENDING","The desktop accepted this command. Read session history before retrying with a new ID.")),
            CommandReservation::New=>{},
        }
        let message_id = input.get("messageId").cloned();
        let dispatch_method = if method == "session.configure" {
            "session.upsert"
        } else if method == "project.create" {
            "project.add"
        } else {
            method
        };
        // Directory creation is part of the journalled command, so a retransmit
        // cannot create a second folder or run the mutation twice.
        let mut input = input;
        let route = input.as_object_mut().and_then(|v|v.remove("_mobileAccountRoute"));
        let result = if method == "project.create" {
            match mobile::create_project_directory(input) {
                Ok(input) => self.dispatch(dispatch_method, input).await,
                Err(error) => Err(error),
            }
        } else {
            let result = self.dispatch(dispatch_method, input).await;
            if result.is_ok() {
                if let Some(id) = route {
                    // The phone explicitly selected this identity, like the desktop connection picker.
                    match self.dispatch("connection.gateway",json!({"connectionId":id,"enabled":true})).await {
                        Ok(_) => result,
                        Err(error) => Err(error),
                    }
                } else { result }
            } else { result }
        };
        let response = match result {
            Ok(mut value) => {
                if let Some(message_id) = message_id {
                    value["messageId"] = message_id;
                }
                success(&request.id, value)
            }
            Err(error) => {
                let message = error.to_string();
                let code = if message.bytes().all(|c| c.is_ascii_uppercase() || c == b'_') { &message } else { "DESKTOP_COMMAND_FAILED" };
                failure(&request.id, code, &message)
            },
        };
        self.repo.complete(&key, &response)?;
        self.repo.audit(
            peer,
            method,
            if response["ok"] == true {
                "success"
            } else {
                "failure"
            },
        )?;
        Ok(response)
    }
}
