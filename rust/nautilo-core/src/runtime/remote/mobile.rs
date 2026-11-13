use super::*;

impl RemoteService {
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
        let changed = select_configuration_connection(&mut input, params)?;
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
        if changed {
            let options = self.repo.mobile_options()?;
            let detail = self.repo.session_details(session)?;
            if let Some(connection) = options["connections"].as_array().and_then(|v|v.iter().find(|c|c["id"] == input["connectionId"])) {
                if connection["kind"] == "login" && connection["harness"] != detail["agent"]["providerId"] {
                    anyhow::ensure!(matches!(connection["harness"].as_str(),Some("codex"|"claude-code")), "CONNECTION_NOT_AVAILABLE");
                    input["_mobileAccountRoute"] = connection["id"].clone();
                }
            }
        }
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
        json!({"id":v["id"],"displayName":v["displayName"],"reasoningEfforts":v["reasoningEfforts"],"defaultReasoningEffort":v["defaultReasoningEffort"]})).collect::<Vec<_>>();
    json!({"models":models,"source":catalog["source"]})
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
