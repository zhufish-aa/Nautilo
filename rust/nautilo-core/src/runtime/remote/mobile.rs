use super::*;
use crate::runtime::account_gateway::supports_account_provider;

pub(super) fn approval_resolution(params: &Value) -> Result<Value> {
    let approval_id = params["approvalId"].as_str().filter(|id| !id.is_empty() && id.len() <= 128)
        .ok_or_else(|| anyhow::anyhow!("INVALID_REQUEST"))?;
    let scope = match params.get("scope") {
        None => "once",
        Some(value) => value.as_str().ok_or_else(|| anyhow::anyhow!("INVALID_APPROVAL_SCOPE"))?,
    };
    anyhow::ensure!(["once", "run", "task", "project", "global"].contains(&scope), "INVALID_APPROVAL_SCOPE");
    Ok(json!({"approvalId":approval_id,"decision":params["decision"],"scope":scope}))
}

impl RemoteService {
    pub(super) async fn mobile_compact_command(&self, session: &str) -> Result<Option<Value>> {
        let commands = self.dispatch("slashCommand.list", json!({"sessionId":session})).await?;
        Ok(commands.as_array().into_iter().flatten().find(|c|
            c["execution"] == "provider" && (c["name"] == "/compact" || c["providerCommand"] == "compact")).cloned())
    }
    pub(super) fn mobile_account_route(&self, input: &mut Value) -> Result<()> {
        let options = self.repo.mobile_options()?;
        let agent = options["agents"].as_array().and_then(|a| a.iter().find(|a| a["id"] == input["agentInstanceId"]))
            .ok_or_else(|| anyhow::anyhow!("HARNESS_NOT_AVAILABLE"))?;
        if let Some(connection) = options["connections"].as_array().and_then(|c| c.iter().find(|c| c["id"] == input["connectionId"])) {
            if connection["kind"] == "login" && connection["harness"] != agent["providerId"] {
                anyhow::ensure!(
                    agent["providerId"] != "antigravity"
                        && connection["harness"].as_str().is_some_and(supports_account_provider),
                    "CONNECTION_NOT_AVAILABLE"
                );
                input["_mobileAccountRoute"] = connection["id"].clone();
            }
        }
        Ok(())
    }
    pub(super) async fn mobile_options(&self) -> Result<Value> {
        let mut options = self.repo.mobile_options()?;
        let providers = self.dispatch("provider.catalog", json!({})).await?;
        options["providers"] = json!(providers.as_array().into_iter().flatten().map(|p| json!({"providerId":p["providerId"],"permissionModes":p["permissionModes"],"modeDiscovery":p["modeDiscovery"]})).collect::<Vec<_>>());
        Ok(options)
    }
    pub(super) async fn mobile_modes(&self, params: &Value) -> Result<Value> {
        let context = self.repo.mobile_mode_context(params["agentInstanceId"].as_str().ok_or_else(|| anyhow::anyhow!("INVALID_HARNESS"))?, params["projectId"].as_str())?;
        let providers = self.dispatch("provider.catalog", json!({})).await?;
        let provider = providers.as_array().and_then(|p|p.iter().find(|p|p["providerId"] == context["providerId"])).ok_or_else(||anyhow::anyhow!("HARNESS_NOT_AVAILABLE"))?;
        let discovery = !provider["modeDiscovery"].is_null() && provider["modeDiscovery"] != false;
        let mut modes = if discovery {
            match self.dispatch("provider.modes", json!({"agentInstanceId":context["agentInstanceId"],"cwd":context["cwd"]})).await {
                Ok(value) => value,
                Err(_) => json!({"modes":[],"modeError":"Could not load native modes; refresh to retry"})
            }
        } else { json!({"modes":[]}) };
        modes["permissionModes"] = provider["permissionModes"].as_array().map(|v|json!(v)).unwrap_or(json!([]));
        modes["permissionMode"] = context["permissionMode"].clone();
        modes["modeDiscovery"] = json!(discovery);
        Ok(modes)
    }
    pub(super) async fn mobile_validate_modes(&self, input: &mut Value, params: &Value, session: Option<&str>) -> Result<()> {
        if params.get("permissionMode").is_none() && params.get("agentMode").is_none() { return Ok(()) }
        let catalog = self.mobile_modes(&json!({"agentInstanceId":input["agentInstanceId"],"projectId":input["projectId"]})).await?;
        if let Some(value) = params.get("permissionMode") {
            let value = value.as_str().ok_or_else(||anyhow::anyhow!("INVALID_PERMISSION_MODE"))?;
            anyhow::ensure!(catalog["permissionModes"].as_array().is_some_and(|m|m.iter().any(|m|m["value"] == value)), "INVALID_PERMISSION_MODE");
            input["permissionMode"] = json!(value);
        }
        if let Some(value) = params.get("agentMode") {
            let value = value.as_str().ok_or_else(||anyhow::anyhow!("INVALID_HARNESS_MODE"))?;
            anyhow::ensure!(catalog["modes"].as_array().is_some_and(|m|m.iter().any(|m|m["id"] == value && m["broken"].as_str().unwrap_or("").is_empty())), "INVALID_HARNESS_MODE");
            let previous = input["agentMode"].as_str().or(catalog["defaultMode"].as_str());
            if previous != Some(value) { if let Some(session) = session { anyhow::ensure!(!self.repo.session_mode_locked(session)?, "HARNESS_MODE_LOCKED"); } }
            input["agentMode"] = json!(value);
        }
        Ok(())
    }
    pub(super) async fn mobile_catalog(&self, params: &Value) -> Result<Value> {
        let options = self.repo.mobile_options()?;
        let agent = options["agents"]
            .as_array()
            .and_then(|v| v.iter().find(|v| v["id"] == params["agentInstanceId"]))
            .ok_or_else(|| anyhow::anyhow!("HARNESS_NOT_AVAILABLE"))?;
        let catalog = if let Some(id) = params["connectionId"].as_str().filter(|s| !s.is_empty()) {
            let connection = options["connections"]
                .as_array()
                .and_then(|v| v.iter().find(|v| v["id"] == id))
                .ok_or_else(|| anyhow::anyhow!("CONNECTION_NOT_AVAILABLE"))?;
            self.dispatch(
                "connection.models",
                connection_catalog_input(connection, agent, params.get("revision")),
            )
            .await?
        } else {
            self.dispatch(
                "provider.models",
                json!({"providerId":agent["providerId"],"agentInstanceId":agent["id"]}),
            )
            .await?
        };
        Ok(sanitized_models(catalog))
    }
    pub(super) async fn mobile_models(&self, session: &str) -> Result<Value> {
        let detail = self.repo.session_details(session)?;
        let config = &detail["session"];
        let agent = &detail["agent"];
        self.mobile_catalog(&json!({"agentInstanceId":agent["id"],"connectionId":config["connectionId"],"revision":config["connectionRevision"]})).await
    }
    pub(super) async fn mobile_configuration(
        &self,
        session: &str,
        params: &Value,
    ) -> Result<Value> {
        let mut input = self.repo.session_template(session)?;
        self.repo.mobile_select_team(&mut input, params)?;
        let changed = select_configuration_connection(&mut input, params)?;
        if !changed && params.get("model").is_none() && params.get("reasoningEffort").is_none() {
            self.mobile_validate_modes(&mut input, params, Some(session)).await?;
            input["id"] = json!(session);
            return Ok(input);
        }
        let catalog = if changed {
            let detail = self.repo.session_details(session)?;
            self.mobile_catalog(&json!({"agentInstanceId":detail["agent"]["id"],"connectionId":input["connectionId"]})).await?
        } else { self.mobile_models(session).await? };
        let model_id = params["model"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("INVALID_MODEL"))?;
        let model = catalog["models"]
            .as_array()
            .and_then(|models| models.iter().find(|m| m["id"] == model_id))
            .ok_or_else(|| anyhow::anyhow!("MODEL_NOT_AVAILABLE"))?;
        let effort = params["reasoningEffort"].as_str().unwrap_or("");
        if !effort.is_empty()
            && !model["reasoningEfforts"]
                .as_array()
                .is_some_and(|values| values.iter().any(|v| v == effort))
        {
            bail!("INVALID_REASONING_EFFORT");
        }
        input["id"] = json!(session);
        input["model"] = json!(model_id);
        input["reasoningEffort"] = json!(effort);
        self.mobile_validate_modes(&mut input, params, Some(session)).await?;
        if changed { self.mobile_account_route(&mut input)?; }
        Ok(input)
    }
}

/// Keep a pinned revision for model changes; a new connection binds its own latest revision.
pub(super) fn select_configuration_connection(input: &mut Value, params: &Value) -> Result<bool> {
    let Some(requested) = params.get("connectionId") else { return Ok(false) };
    anyhow::ensure!(requested.is_null() || requested.as_str().is_some_and(|s|s.len() <= 128), "INVALID_CONNECTION");
    let id = requested.as_str().filter(|s|!s.is_empty());
    let current = input["connectionId"].as_str().filter(|s|!s.is_empty());
    if id == current { return Ok(false) }
    anyhow::ensure!(params["confirmConnectionChange"] == true, "CONNECTION_CHANGE_REQUIRES_CONFIRMATION");
    input["connectionId"] = id.map(|s|json!(s)).unwrap_or(Value::Null);
    input.as_object_mut().unwrap().remove("connectionRevision");
    input["confirmConnectionChange"] = json!(true);
    Ok(true)
}

pub(super) fn connection_catalog_input(connection: &Value, agent: &Value, revision: Option<&Value>) -> Value {
    let mut input = json!({"connectionId":connection["id"]});
    if let Some(revision) = revision.filter(|v| v.is_u64()) { input["revision"] = revision.clone(); }
    // Cross-Harness account routing still discovers models using the account's
    // native CLI and selected login profile, not the destination Harness's CLI.
    if connection["kind"] == "api" || connection["harness"] == agent["providerId"] {
        input["agentInstanceId"] = agent["id"].clone();
    }
    input
}

fn sanitized_models(catalog: Value) -> Value {
    let models = catalog["models"].as_array().into_iter().flatten().filter(|v| v["enabled"] != false).map(|v|
        json!({"id":v["id"],"displayName":v["displayName"],"reasoningEfforts":v["reasoningEfforts"],"defaultReasoningEffort":v["defaultReasoningEffort"],"contextWindow":v["contextWindow"]})).collect::<Vec<_>>();
    json!({"models":models,"source":catalog["source"],"defaultModel":catalog["defaultModel"]})
}

pub(super) fn browse_directories(params: &Value) -> Result<Value> {
    let raw = params["path"].as_str().unwrap_or("");
    if raw.is_empty() {
        let roots: Vec<String> = if cfg!(windows) {
            ('A'..='Z')
                .map(|c| format!("{c}:\\"))
                .filter(|s| std::path::Path::new(s).is_dir())
                .collect()
        } else {
            vec!["/".into()]
        };
        return Ok(
            json!({"path":"","parent":null,"directories":roots.into_iter().map(|p|json!({"name":p,"path":p})).collect::<Vec<_>>()}),
        );
    }
    if raw.len() > 4096 || !std::path::Path::new(raw).is_absolute() {
        bail!("INVALID_DIRECTORY");
    }
    let path = crate::paths::canonicalize_plain(std::path::Path::new(raw))
        .map_err(|_| anyhow::anyhow!("DIRECTORY_NOT_AVAILABLE"))?;
    let mut directories = std::fs::read_dir(&path)?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir())
        .map(|e| json!({"name":e.file_name().to_string_lossy(),"path":e.path().to_string_lossy()}))
        .collect::<Vec<_>>();
    directories.sort_by_key(|v| v["name"].as_str().unwrap_or("").to_lowercase());
    let offset = params["offset"].as_u64().unwrap_or(0).min(100_000) as usize;
    let more = directories.len() > offset + 200;
    Ok(
        json!({"path":path.to_string_lossy(),"parent":path.parent().map(|p|p.to_string_lossy()),"directories":directories.into_iter().skip(offset).take(200).collect::<Vec<_>>(),"nextOffset":if more{Some(offset+200)}else{None}}),
    )
}

pub(super) fn project_input(params: &Value) -> Result<Value> {
    let raw = params["rootPath"]
        .as_str()
        .filter(|s| s.len() <= 4096 && std::path::Path::new(s).is_absolute())
        .ok_or_else(|| anyhow::anyhow!("INVALID_DIRECTORY"))?;
    let path = crate::paths::canonicalize_plain(std::path::Path::new(raw))
        .map_err(|_| anyhow::anyhow!("DIRECTORY_NOT_AVAILABLE"))?;
    if !path.is_dir() {
        bail!("INVALID_DIRECTORY");
    }
    let folder = params["folderName"].as_str().unwrap_or("").trim();
    if !folder.is_empty()
        && (folder.len() > 200
            || folder == "."
            || folder == ".."
            || folder.ends_with(['.', ' '])
            || folder.chars().any(|c| c.is_control() || "<>:\"/\\|?*".contains(c)))
    {
        bail!("INVALID_FOLDER_NAME");
    }
    let name = params["name"]
        .as_str()
        .filter(|s| !s.trim().is_empty() && s.len() <= 200)
        .map(str::trim)
        .map(str::to_owned)
        .unwrap_or_else(|| {
            if !folder.is_empty() { return folder.to_owned(); }
            path.file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned()
        });
    Ok(json!({"name":name,"rootPath":path.to_string_lossy(),"folderName":folder}))
}

pub(super) fn create_project_directory(mut input: Value) -> Result<Value> {
    let folder = input["folderName"].as_str().unwrap_or("");
    if !folder.is_empty() {
        let path = std::path::Path::new(input["rootPath"].as_str().unwrap_or("")).join(folder);
        std::fs::create_dir(&path).map_err(|e| anyhow::anyhow!(
            if e.kind() == std::io::ErrorKind::AlreadyExists { "DIRECTORY_ALREADY_EXISTS" } else { "DIRECTORY_CREATE_FAILED" }
        ))?;
        input["rootPath"] = json!(path.to_string_lossy());
    }
    input.as_object_mut().unwrap().remove("folderName");
    Ok(input)
}
