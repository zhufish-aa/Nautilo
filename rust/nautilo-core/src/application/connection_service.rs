//! Harness-independent, revision-pinned API providers and login accounts.
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use crate::adapters::registry::AdapterRegistry;
use crate::adapters::model_config::{discover_openai_compatible_models, merge_instance_model_config, validated_model_endpoint};
use crate::database::{Database, Repositories};
use crate::database::connection::db_fail;
use crate::errors::{invalid, not_found, now_iso, CoreResult};
use crate::runtime::security::CredentialService;
use crate::runtime::security::environment_policy::{build_environment, isolate_login_profile, login_profile_directory, provider_environment_passthrough};

pub fn version_key(id: &str, revision: u64) -> String { format!("{id}:{revision}") }
pub fn credential_key(id: &str, revision: u64) -> String { format!("connection:{id}:{revision}") }

#[derive(Clone)]
pub struct ConnectionService { db: Arc<Mutex<Database>>, credentials: Arc<CredentialService>, adapters: AdapterRegistry }
impl ConnectionService {
    pub fn new(db: Arc<Mutex<Database>>, credentials: Arc<CredentialService>, adapters: AdapterRegistry) -> Self { Self { db, credentials, adapters } }
    pub fn list(&self) -> CoreResult<Vec<Value>> {
        let db = self.db.lock().unwrap();
        Repositories::new(&db.raw).runtime_connections().list_default()?.into_iter().map(|v| public_connection(&db.raw, v)).collect()
    }
    pub fn get(&self, id: &str, revision: Option<u64>) -> CoreResult<Value> {
        let db = self.db.lock().unwrap();
        let head = head(&db.raw, id)?;
        let mut value = match revision { Some(revision) => version(&db.raw, id, revision)?, None => head.clone() };
        value["enabled"] = head["enabled"].clone();
        public_connection(&db.raw, value)
    }
    pub fn upsert(&self, input: &Value) -> CoreResult<Value> {
        let mut connection = validate_connection(&input["connection"])?;
        if input.get("apiKey").is_some_and(|v| !v.is_string()) { return Err(invalid("apiKey","API key must be text")); }
        if input.get("clearApiKey").is_some_and(|v| !v.is_boolean()) { return Err(invalid("clearApiKey","Expected a boolean")); }
        if input.get("expectedRevision").is_some_and(|v| !v.as_u64().is_some_and(|n| n > 0 && n <= 9_007_199_254_740_991)) { return Err(invalid("expectedRevision","Invalid expected revision")); }
        let id = connection["id"].as_str().unwrap().to_string();
        let api_key = input.get("apiKey").and_then(Value::as_str);
        let clear = input["clearApiKey"] == true;
        if api_key.is_some() && clear { return Err(invalid("apiKey", "Choose replacement or clearing, not both")); }
        if connection["kind"] == "login" && (api_key.is_some() || clear) { return Err(invalid("apiKey", "Login accounts use CLI-owned authentication, not API keys")); }
        let encrypted = api_key.map(|key| self.credentials.encrypt(&json!({"apiKey":key}))).transpose()?;
        let db = self.db.lock().unwrap();
        let repos = Repositories::new(&db.raw);
        if connection["kind"]=="login" && connection["harness"]=="antigravity" && repos.runtime_connections().list_default()?.iter().any(|v|v["kind"]=="login"&&v["harness"]=="antigravity"&&v["id"]!=id) {
            return Err(invalid("harness","Antigravity shares one official Google account through the OS keyring; use the existing Antigravity connection"));
        }
        let current = repos.runtime_connections().get(&id)?;
        let revision = current.as_ref().and_then(|v| v["revision"].as_u64()).unwrap_or(0);
        let expected = input.get("expectedRevision").and_then(Value::as_u64);
        if (current.is_some() && expected != Some(revision)) || (current.is_none() && expected.is_some()) {
            return Err(invalid("expectedRevision", "Connection changed; reload before saving"));
        }
        if current.as_ref().is_some_and(|v| v["kind"] != connection["kind"]) { return Err(invalid("kind","Create a separate connection to change authentication kind")); }
        let next = revision.checked_add(1).filter(|n| *n <= 9_007_199_254_740_991).ok_or_else(|| invalid("revision", "Revision limit reached"))?;
        let now = now_iso();
        connection["revision"] = json!(next);
        connection["createdAt"] = current.as_ref().and_then(|v| v.get("createdAt")).cloned().unwrap_or_else(|| json!(now));
        connection["updatedAt"] = json!(now);
        let encrypted = if connection["kind"] == "api" && !clear {
            match encrypted { Some(value) => Some(value), None if revision > 0 => repos.credentials().get(&credential_key(&id, revision))?, None => None }
        } else { None };
        db.raw.execute_batch("BEGIN IMMEDIATE").map_err(db_fail)?;
        let outcome: CoreResult<()> = (|| {
            // INSERT, never upsert: old versions and their credentials cannot change.
            db.raw.execute("INSERT INTO runtime_connection_versions(id,data,updated_at) VALUES(?1,?2,?3)", params![version_key(&id,next),connection.to_string(),now]).map_err(db_fail)?;
            repos.runtime_connections().save(&connection, &now)?;
            if let Some(encrypted) = &encrypted { repos.credentials().save(&credential_key(&id,next), encrypted)?; }
            Ok(())
        })();
        if let Err(error) = outcome { let _ = db.raw.execute_batch("ROLLBACK"); return Err(error); }
        if let Err(error) = db.raw.execute_batch("COMMIT") { let _ = db.raw.execute_batch("ROLLBACK"); return Err(db_fail(error)); }
        public_connection(&db.raw, connection)
    }
    pub fn remove(&self, id: &str) -> CoreResult<Value> {
        let db = self.db.lock().unwrap(); let repos = Repositories::new(&db.raw);
        head(&db.raw,id)?;
        if repos.sessions().list_all()?.iter().any(|s| s["connectionId"] == id) || repos.runs().list()?.iter().any(|s| s["connectionId"] == id) {
            return Err(invalid("connectionId", "Connection is referenced by a session or run; disable it instead"));
        }
        db.raw.execute_batch("BEGIN IMMEDIATE").map_err(db_fail)?;
        let outcome: CoreResult<()> = (|| {
            for value in repos.runtime_connection_versions().list_default()? {
                if value["id"] == id {
                    let revision = value["revision"].as_u64().ok_or_else(|| invalid("revision", "Invalid stored revision"))?;
                    repos.credentials().remove(&credential_key(id,revision))?;
                    repos.runtime_connection_versions().remove(&version_key(id,revision))?;
                }
            }
            repos.runtime_connections().remove(id)?; Ok(())
        })();
        if let Err(error) = outcome { let _ = db.raw.execute_batch("ROLLBACK"); return Err(error); }
        if let Err(error) = db.raw.execute_batch("COMMIT") { let _ = db.raw.execute_batch("ROLLBACK"); return Err(db_fail(error)); }
        Ok(json!({"removed":true}))
    }
    pub async fn models(&self, input: &Value) -> CoreResult<Value> {
        match self.discover_models(input, true).await {
            Ok(catalog) => Ok(catalog),
            Err(_) => Ok(json!({"providerId":format!("connection:{}",input["connectionId"].as_str().unwrap_or("")),"models":[],"source":"unavailable","fetchedAt":now_iso(),"warning":"Connection model discovery failed. Check endpoint, protocol, credentials and harness compatibility."})),
        }
    }
    pub async fn diagnose(&self, input: &Value) -> CoreResult<Value> {
        use std::time::Instant;
        use crate::runtime::service_probe::{report, step, finish};
        let connection = self.get(input["connectionId"].as_str().unwrap_or(""), input["revision"].as_u64())?;
        let started = Instant::now();
        let version = connection["revision"].as_u64().unwrap_or(0).to_string();
        let mut result = report(connection["id"].as_str().unwrap_or(""), &version, if connection["kind"] == "login" { "account_catalog" } else { "api_catalog" });
        if connection["enabled"] != true {
            step(&mut result,"configuration","warning",started,Some("DISABLED"),Some("Enable this connection before checking it."));
            return Ok(finish(result,started));
        }
        step(&mut result,"configuration","passed",started,None,None);
        if connection["kind"] == "api" && connection["hasCredential"] != true {
            step(&mut result,"credential","warning",Instant::now(),Some("CREDENTIAL_MISSING"),Some("No API key is stored for this connection. The endpoint will be checked without borrowing another account."));
        } else if connection["kind"] == "api" {
            step(&mut result,"credential","passed",Instant::now(),None,None);
        }
        let catalog_start = Instant::now();
        match tokio::time::timeout(std::time::Duration::from_secs(30), self.discover_models(input, false)).await {
            Ok(Ok(catalog)) if catalog["source"] != "unavailable" && catalog["warning"].as_str().is_none() => {
                let count = catalog["models"].as_array().map_or(0,Vec::len);
                result["modelCount"] = json!(count);
                step(&mut result,"catalog",if count > 0 { "passed" } else { "warning" },catalog_start,if count == 0 { Some("EMPTY_CATALOG") } else { None },None);
            }
            Ok(Ok(_)) => step(&mut result,"catalog","warning",catalog_start,Some("CATALOG_UNAVAILABLE"),Some("The selected account did not return a model catalog. Check its native login state.")),
            Ok(Err(error)) => {
                let message = error.to_string();
                let code = if message.contains("401") || message.contains("403") { "AUTH_REQUIRED" } else if message.contains("404") { "CATALOG_NOT_SUPPORTED" } else if message.to_lowercase().contains("timed out") || message.to_lowercase().contains("timeout") { "TIMEOUT" } else { "CATALOG_UNAVAILABLE" };
                // A relay can support inference without implementing GET /models.
                step(&mut result,"catalog",if code == "CATALOG_NOT_SUPPORTED" { "warning" } else { "failed" },catalog_start,Some(code),Some(&message));
            }
            Err(_) => step(&mut result,"catalog","failed",catalog_start,Some("TIMEOUT"),Some("Model discovery did not finish within 30 seconds.")),
        }
        Ok(finish(result,started))
    }
    async fn discover_models(&self, input: &Value, merge_configured: bool) -> CoreResult<Value> {
        let id = input["connectionId"].as_str().unwrap_or("");
        let connection = self.get(id, input["revision"].as_u64())?;
        if connection["enabled"] != true { return Err(invalid("connectionId", "Connection is disabled")); }
        let revision = connection["revision"].as_u64().unwrap();
        if connection["kind"] == "api" {
            let credential = self.credentials.read(&credential_key(id,revision))?;
            let key = credential.as_ref().and_then(|v| v["apiKey"].as_str());
            let api_type = if connection["protocol"] == "anthropic" { "anthropic-messages" } else { "openai-compatible" };
            let mut catalog = discover_openai_compatible_models(connection["baseUrl"].as_str().unwrap(), key, 10_000, Some(api_type)).await?;
            catalog["providerId"] = json!(format!("connection:{id}"));
            return Ok(if merge_configured { merge_instance_model_config(&catalog, connection.get("models")) } else { catalog });
        }
        let harness = connection["harness"].as_str().ok_or_else(|| invalid("harness", "Missing login harness"))?;
        let configured = {
            let db = self.db.lock().unwrap();
            let agents = Repositories::new(&db.raw).agents();
            if let Some(id) = input["agentInstanceId"].as_str() {
                let agent = agents.get(id)?.ok_or_else(|| not_found("harness", id))?;
                if agent["providerId"] != harness { return Err(invalid("harness", "Account and harness must match")); }
                Some(agent)
            } else {
                let mut matching = agents.list_default()?.into_iter().filter(|agent| agent["providerId"] == harness && agent["enabled"] != false).collect::<Vec<_>>();
                matching.sort_by_key(|agent| agent.pointer("/providerOptions/configurationKind").and_then(Value::as_str) != Some("harness"));
                matching.into_iter().find(|agent| agent["executable"].as_str().is_some_and(|command| !command.trim().is_empty()))
            }
        };
        let descriptor = self.adapters.get(harness)?.descriptor();
        let executable = configured.as_ref().and_then(|agent| agent["executable"].as_str())
            .or_else(|| descriptor["defaultExecutable"].as_str())
            .ok_or_else(|| invalid("executable", "Install the account's harness to discover models"))?;
        let probe = json!({"id":format!("connection-models:{id}"),"providerId":harness,"displayName":harness,
            "executable":executable,"baseArgs":[],"enabled":true,"capabilities":[]});
        let agent = apply_connection(&probe, &connection)?;
        let env = connection_environment_with_descriptor(&agent, &connection, &self.credentials,
            build_environment(None, provider_environment_passthrough(&agent, Some(&descriptor))), Some(&descriptor))?;
        self.adapters.list_models_with_refresh(&agent, Some(&json!({"env":env})), true).await
    }
}
fn public_connection(db: &Connection, mut value: Value) -> CoreResult<Value> {
    let id = value["id"].as_str().unwrap_or(""); let revision = value["revision"].as_u64().unwrap_or(0);
    let has = Repositories::new(db).credentials().has(&credential_key(id,revision))?;
    value["hasCredential"] = json!(has);
    let settings=Repositories::new(db).integration_settings().get("integration-settings")?.unwrap_or(Value::Null);
    value["accountGateway"] = json!(value["kind"]=="login"&&settings["gateway"]["enabled"]==true&&settings["gateway"]["connectionIds"].as_array().is_some_and(|ids|ids.contains(&value["id"])));
    Ok(value)
}
fn head(db: &Connection, id: &str) -> CoreResult<Value> { Repositories::new(db).runtime_connections().get(id)?.ok_or_else(|| not_found("connection",id)) }
fn version(db: &Connection, id: &str, revision: u64) -> CoreResult<Value> { Repositories::new(db).runtime_connection_versions().get(&version_key(id,revision))?.ok_or_else(|| invalid("connectionRevision", "Pinned connection revision is missing")) }

fn validate_connection(value: &Value) -> CoreResult<Value> {
    let object = value.as_object().ok_or_else(|| invalid("connection", "Expected a connection"))?;
    let mut result = serde_json::Map::new();
    for key in ["id","name","kind","enabled","protocol","baseUrl","harness","loginProfileDirectory","nativeLogin","models"] {
        if let Some(v) = object.get(key).filter(|v| !v.is_null()) { result.insert(key.into(),v.clone()); }
    }
    let mut result = Value::Object(result);
    for key in ["id","name"] {
        let text = result[key].as_str().map(str::trim).filter(|s| !s.is_empty() && s.len() <= 256).ok_or_else(|| invalid(key,"Required text is missing or too long"))?.to_string();
        result[key] = json!(text);
    }
    let id = result["id"].as_str().unwrap();
    if id.len() > 100 || !id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-') { return Err(invalid("connectionId","Invalid connection ID")); }
    if result["name"].as_str().unwrap().len() > 200 { return Err(invalid("name","Connection name is too long")); }
    if !result["enabled"].is_boolean() { return Err(invalid("enabled","Expected a boolean")); }
    // Reject secrets rather than accidentally persisting them in document fields.
    fn secret_fields(value: &Value) -> bool {
        match value { Value::Object(o) => o.iter().any(|(k,v)| matches!(k.to_ascii_lowercase().as_str(),"apikey"|"api_key"|"password"|"token"|"authorization"|"credential"|"credentials") || secret_fields(v)), Value::Array(a) => a.iter().any(secret_fields), _ => false }
    }
    if secret_fields(value) { return Err(invalid("connection","Secrets must be supplied through the API key field outside connection metadata")); }
    if let Some(models) = result.get("models") {
        let models = models.as_array().ok_or_else(|| invalid("models","Expected model list"))?;
        if models.len() > 500 { return Err(invalid("models","Use at most 500 model entries")); }
        let mut seen = std::collections::HashSet::new(); let mut normalized = vec![];
        for model in models {
            let id = model["id"].as_str().map(str::trim).filter(|s| !s.is_empty()).ok_or_else(|| invalid("models","Invalid model ID"))?;
            if !seen.insert(id.to_string()) { return Err(invalid("models","Model IDs must be unique")); }
            let efforts = model.get("reasoningEfforts").cloned().unwrap_or_else(|| json!([]));
            if !efforts.as_array().is_some_and(|a| a.iter().all(Value::is_string)) { return Err(invalid("models","Invalid reasoning values")); }
            let mut item = json!({"id":id,"reasoningEfforts":efforts});
            if let Some(modalities) = model.get("inputModalities").filter(|v| !v.is_null()) {
                if !modalities.as_array().is_some_and(|a| !a.is_empty() && a.iter().all(|v| v == "text" || v == "image")) { return Err(invalid("models","Invalid input modalities")); }
                item["inputModalities"] = modalities.clone();
            }
            for field in ["displayName","defaultReasoningEffort"] { if let Some(v) = model.get(field).filter(|v| v.is_string()) { item[field] = v.clone(); } }
            if let Some(v) = model.get("enabled").filter(|v| v.is_boolean()) { item["enabled"] = v.clone(); }
            if let Some(v) = model.get("contextWindow").filter(|v| v.as_u64().is_some_and(|v| v > 0 && v <= 9_007_199_254_740_991)) { item["contextWindow"] = v.clone(); }
            let mut pricing = serde_json::Map::new();
            for field in ["input","output","cacheRead","cacheWrite"] {
                if let Some(v) = model.get("pricing").and_then(|p| p.get(field)) {
                    if !v.as_f64().is_some_and(|v| v.is_finite() && v >= 0.0) { return Err(invalid("pricing","Prices must be finite nonnegative numbers")); }
                    pricing.insert(field.into(),v.clone());
                }
            }
            if !pricing.is_empty() { item["pricing"] = json!(pricing); }
            normalized.push(item);
        }
        result["models"] = json!(normalized);
    }
    match result["kind"].as_str() {
        Some("api") => {
            if !matches!(result["protocol"].as_str(),Some("responses"|"chat"|"anthropic")) { return Err(invalid("protocol","Unsupported API protocol")); }
            result["baseUrl"] = json!(validated_model_endpoint(result["baseUrl"].as_str().unwrap_or(""))?);
            result.as_object_mut().unwrap().remove("harness"); result.as_object_mut().unwrap().remove("loginProfileDirectory");
            result.as_object_mut().unwrap().remove("nativeLogin");
        }
        Some("login") => {
            let harness = result["harness"].as_str().unwrap_or("");
            if harness=="antigravity" {
                if result["nativeLogin"]!=true{return Err(invalid("nativeLogin","Antigravity uses its official unified Google account"));}
            }else{
                if result["nativeLogin"]==true{return Err(invalid("nativeLogin","This harness requires an isolated account directory"));}
                login_profile_directory(&json!({"providerId":harness,"baseArgs":[],"providerOptions":{"loginProfileDirectory":result["loginProfileDirectory"]}}))?
                    .ok_or_else(|| invalid("loginProfileDirectory","Select an explicit account directory"))?;
            }
            result.as_object_mut().unwrap().remove("baseUrl"); result.as_object_mut().unwrap().remove("protocol");
        }
        _ => return Err(invalid("kind","Expected api or login")),
    }
    Ok(result)
}

/// Capture a selected revision. Existing sessions may switch only between requests;
/// caller enforces that no queued/active run exists and the harness stays fixed.
pub fn bind_session(db: &Connection, session: &mut Value, current: Option<&Value>) -> CoreResult<()> {
    let supplied_id = session.get("connectionId").cloned();
    if supplied_id.as_ref().is_some_and(|v| !v.is_null() && !v.is_string()) { return Err(invalid("connectionId","Invalid connection ID")); }
    if session.get("connectionRevision").is_some_and(|v| !v.is_null() && !v.as_u64().is_some_and(|n| n > 0 && n <= 9_007_199_254_740_991)) { return Err(invalid("connectionRevision","Invalid connection revision")); }
    if let Some(current) = current {
        if supplied_id.is_none() {
            if let Some(value) = current.get("connectionId") { session["connectionId"] = value.clone(); }
        }
        let same_id = session.get("connectionId").filter(|v| !v.is_null()) == current.get("connectionId").filter(|v| !v.is_null());
        if session.get("connectionRevision").is_none() && same_id {
            if let Some(value) = current.get("connectionRevision") { session["connectionRevision"] = value.clone(); }
        }
    }
    let Some(id) = session.get("connectionId").and_then(Value::as_str).map(str::to_string) else {
        if supplied_id == Some(Value::Null) { session.as_object_mut().unwrap().remove("connectionId"); session.as_object_mut().unwrap().remove("connectionRevision"); }
        else if session.get("connectionRevision").is_some_and(|v| !v.is_null()) { return Err(invalid("connectionRevision","A connection ID is required")); }
        return Ok(());
    };
    let h = head(db,&id)?;
    if h["enabled"] != true { return Err(invalid("connectionId","Connection is disabled")); }
    let revision = session.get("connectionRevision").and_then(Value::as_u64).or_else(|| h["revision"].as_u64())
        .ok_or_else(|| invalid("connectionRevision","Connection has no valid revision"))?;
    let connection = version(db,&id,revision)?;
    if session.get("model").is_none_or(Value::is_null) {
        if let Some(model) = connection["models"].as_array().and_then(|models| models.iter().find(|m| m["enabled"] != false)).and_then(|m| m["id"].as_str()) { session["model"] = json!(model); }
    }
    session["connectionRevision"] = json!(revision);
    if current.is_none() && session.get("providerSessionId").is_some_and(|v| !v.is_null()) {
        return Err(invalid("providerSessionId","A new connection-bound session cannot import a provider thread"));
    }
    Ok(())
}

pub fn resolve_session_connection(db: &Connection, session: &Value, agent: &Value) -> CoreResult<(Value,Option<Value>)> {
    let Some(id) = session.get("connectionId").and_then(Value::as_str) else {
        if agent.pointer("/providerOptions/configurationKind").and_then(Value::as_str) == Some("harness") {
            return Err(invalid("connectionId", "Select a provider or login account for this harness"));
        }
        return Ok((agent.clone(),None));
    };
    let h = head(db,id)?;
    if h["enabled"] != true { return Err(invalid("connectionId","Connection is disabled")); }
    let revision = session["connectionRevision"].as_u64().ok_or_else(|| invalid("connectionRevision","Session has no pinned revision"))?;
    let mut connection = version(db,id,revision)?;
    if connection["kind"]=="login"&&connection["harness"]!=agent["providerId"] {
        let settings=Repositories::new(db).integration_settings().get("integration-settings")?.unwrap_or(Value::Null);
        if settings["gateway"]["enabled"]!=true||!settings["gateway"]["connectionIds"].as_array().is_some_and(|ids|ids.contains(&connection["id"])) {return Err(invalid("connectionId","Enable this account's explicit model gateway before using it in another harness"));}
        connection["viaAccountGateway"]=json!(true);
    }
    let resolved = apply_connection(agent,&connection)?;
    Ok((resolved,Some(connection)))
}
pub fn apply_connection(agent: &Value, connection: &Value) -> CoreResult<Value> {
    let mut result = agent.clone();
    let harness = agent["providerId"].as_str().unwrap_or("");
    if harness=="antigravity" && (connection["kind"]!="login" || connection["harness"]!="antigravity" || connection["nativeLogin"]!=true) {
        return Err(invalid("connectionId","Select an official Antigravity Google login account"));
    }
    if !matches!(connection["kind"].as_str(),Some("api"|"login")) { return Err(invalid("kind","Invalid connection kind")); }
    let mut options = agent["providerOptions"].as_object().cloned().unwrap_or_default();
    for key in ["baseUrl","apiType","wireApi","loginProfileDirectory","loginProfileLabel","anthropicCompat","nativeLogin"] { options.remove(key); }
    if connection["kind"] == "login" {
        if connection["harness"] != harness {
            if connection["viaAccountGateway"]!=true {return Err(invalid("connectionId","Login account belongs to a different harness"));}
            if agent.get("profile").and_then(Value::as_str).is_some_and(|s|!s.is_empty())||agent["baseArgs"].as_array().is_some_and(|a|!a.is_empty()){return Err(invalid("baseArgs","Account routes require standard harness arguments"));}
            options.insert("accountGateway".into(),json!(true));options.insert("apiType".into(),json!("openai-completions"));if harness=="codex"{options.insert("wireApi".into(),json!("chat"));}
        }else if harness=="antigravity"&&connection["nativeLogin"]==true{
            options.insert("nativeLogin".into(),json!(true));
        }else{options.insert("loginProfileDirectory".into(),connection["loginProfileDirectory"].clone());}
    } else {
        let protocol = connection["protocol"].as_str().unwrap_or("");
        if !matches!(protocol,"responses"|"chat"|"anthropic") { return Err(invalid("protocol","Unsupported API protocol")); }
        validated_model_endpoint(connection["baseUrl"].as_str().unwrap_or(""))?;
        if agent.get("profile").and_then(Value::as_str).is_some_and(|s| !s.is_empty()) || agent.get("baseArgs").and_then(Value::as_array).is_some_and(|a| !a.is_empty()) {
            return Err(invalid("baseArgs","Bound API providers require default harness arguments and no CLI profile"));
        }
        options.insert("baseUrl".into(),connection["baseUrl"].clone());
        options.insert("apiType".into(),json!(if protocol == "anthropic" {"anthropic-messages"} else if protocol == "responses" {"openai-responses"} else {"openai-completions"}));
        if harness == "codex" { options.insert("wireApi".into(),json!(protocol)); }
    }
    options.insert("runtimeConnectionId".into(),connection["id"].clone());
    options.insert("runtimeConnectionRevision".into(),connection["revision"].clone());
    options.insert("runtimeConnectionName".into(),connection["name"].clone());
    result["providerOptions"] = json!(options);
    result["models"] = connection.get("models").cloned().unwrap_or_else(|| if connection["kind"] == "login" { agent.get("models").cloned().unwrap_or_else(|| json!([])) } else { json!([]) });
    login_profile_directory(&result)?;
    Ok(result)
}

/// Call after all allowlist/passthrough merges: no inherited credential can override a binding.
pub fn connection_environment(agent: &Value, connection: &Value, credentials: &CredentialService, env: HashMap<String,String>) -> CoreResult<HashMap<String,String>> {
    connection_environment_with_descriptor(agent, connection, credentials, env, None)
}
pub fn connection_environment_with_descriptor(agent: &Value, connection: &Value, credentials: &CredentialService, mut env: HashMap<String,String>, descriptor: Option<&Value>) -> CoreResult<HashMap<String,String>> {
    env.retain(|key,_| {
        let key = key.to_ascii_uppercase();
        if ["CODEX_HOME", "CLAUDE_CONFIG_DIR", "KIMI_CODE_HOME", "OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG_CONTENT", "TRAE_CONFIG_FILE"].contains(&key.as_str()) { return true; }
        !["OPENAI_","CODEX_","ANTHROPIC_","KIMI_","DEEPSEEK_","GEMINI_","GOOGLE_","OPENROUTER_","OPENCODE_","AGENTHUB_PI_","AGENTHUB_OMP_","OMP_AUTH_","COMMAND_CODE_","CMD_","TRAECLI_","TRAE_CLI_","CLAUDE_CODE_OAUTH","CLAUDE_CODE_API","CLAUDE_CODE_USE_","CLAUDE_CODE_SESSION_ACCESS"].iter().any(|p| key.starts_with(p)) && key != "CLAUDE_CONFIG_DIR" && !key.starts_with("AGENTHUB_API")
    });
    if connection["kind"] == "login" {return if connection["viaAccountGateway"]==true{Ok(env)}else{isolate_login_profile(agent,env)};}
    let id = connection["id"].as_str().unwrap(); let revision = connection["revision"].as_u64().unwrap();
    let key = credentials.read(&credential_key(id,revision))?.and_then(|v| v["apiKey"].as_str().map(str::to_string)).filter(|s| !s.is_empty())
        .ok_or_else(|| invalid("connectionId","The pinned API provider has no credential; create a new revision and session"))?;
    env.insert("NAUTILO_CONNECTION_API_KEY".into(), key.clone());
    env.insert("AGENTHUB_API_KEY".into(), key.clone());
    env.insert("NAUTILO_CONNECTION_DIRECTORY".into(), credentials.connection_directory(id, revision).to_string_lossy().into_owned());
    let base = connection["baseUrl"].as_str().unwrap_or("");
    if connection["protocol"] == "anthropic" {
        env.insert("ANTHROPIC_API_KEY".into(), key.clone()); env.insert("ANTHROPIC_BASE_URL".into(), base.into());
    } else {
        env.insert("OPENAI_API_KEY".into(), key.clone()); env.insert("OPENAI_BASE_URL".into(), base.into());
    }
    for name in descriptor.and_then(|d| d["credentialEnv"].as_array()).into_iter().flatten().filter_map(Value::as_str) { env.insert(name.to_string(), key.clone()); }
    if let Some(name) = descriptor.and_then(|d| d["baseUrlEnv"].as_str()) { env.insert(name.into(), base.into()); }
    Ok(env)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::{AdapterCapabilities, AdapterDetectionResult, AdapterRun, AdapterStartRequest, AgentCliAdapter};

    struct ModelProbe(Arc<Mutex<Vec<(Value, Value)>>>);
    #[async_trait::async_trait]
    impl AgentCliAdapter for ModelProbe {
        fn provider_id(&self) -> &str { "codex" }
        fn descriptor(&self) -> Value { json!({"providerId":"codex","defaultExecutable":"default-codex"}) }
        fn capabilities(&self) -> AdapterCapabilities {
            AdapterCapabilities { structured_output: true, text_output: true, interactive_stdin: false, native_resume: false, pty: false }
        }
        async fn detect(&self, _: &Value) -> AdapterDetectionResult { AdapterDetectionResult::default() }
        async fn list_models(&self, instance: &Value, context: Option<&Value>) -> Option<CoreResult<Value>> {
            self.0.lock().unwrap().push((instance.clone(), context.cloned().unwrap_or(Value::Null)));
            Some(Ok(json!({"providerId":"codex","models":[{"id":"account-model","displayName":"Account model"}],"source":"provider_cli","fetchedAt":now_iso()})))
        }
        fn start(&self, _: AdapterStartRequest) -> CoreResult<AdapterRun> { panic!("model discovery must not start a run") }
    }
    fn fixture() -> (ConnectionService, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("nautilo-connections-{}",uuid::Uuid::new_v4()));
        let db = Arc::new(Mutex::new(Database::open(&dir.join("test.sqlite")).unwrap()));
        let credentials = Arc::new(CredentialService::new(db.clone(),&dir));
        (ConnectionService::new(db,credentials,AdapterRegistry::with_builtins()),dir)
    }
    fn provider(id: &str) -> Value { json!({"id":id,"name":"Provider","kind":"api","enabled":true,"protocol":"anthropic","baseUrl":"https://provider.example/v1","models":[{"id":"claude-test","reasoningEfforts":["none"],"pricing":{"input":2.0}}]}) }
    #[test]
    fn antigravity_binds_the_official_unified_account_without_redirecting_native_storage() {
        let (service, dir) = fixture();
        let account = json!({"id":"google","name":"Google","kind":"login","enabled":true,"harness":"antigravity","nativeLogin":true,
            "loginProfileDirectory":dir.join("login-recovery").to_string_lossy(),"models":[]});
        let saved = service.upsert(&json!({"connection":account})).unwrap();
        let agent = json!({"providerId":"antigravity","executable":"agy","baseArgs":[],"providerOptions":{"configurationKind":"harness"}});
        let bound = apply_connection(&agent,&saved).unwrap();
        assert_eq!(bound["providerOptions"]["nativeLogin"],true);
        assert!(bound["providerOptions"].get("loginProfileDirectory").is_none());
        assert!(login_profile_directory(&bound).unwrap().is_none());
        let mut duplicate = account.clone(); duplicate["id"] = json!("same-google-again");
        assert!(service.upsert(&json!({"connection":duplicate})).is_err());
        assert!(apply_connection(&agent,&provider("third-party-api")).is_err());
        assert!(apply_connection(&json!({"providerId":"pi"}),&saved).is_err());
        let mut unsupported = account; unsupported["nativeLogin"] = json!(false);
        assert!(validate_connection(&unsupported).is_err());
    }
    #[test]
    fn image_input_capability_is_preserved_and_validated() {
        let mut connection = provider("vision");
        for modalities in [json!(["text","image"]),json!(["text"])] {
            connection["models"][0]["inputModalities"] = modalities.clone();
            assert_eq!(validate_connection(&connection).unwrap()["models"][0]["inputModalities"],modalities);
        }
        connection["models"][0]["inputModalities"] = json!(["invalid"]);
        assert!(validate_connection(&connection).is_err());
    }
    #[tokio::test]
    async fn login_models_use_clean_probe_and_account_profile_without_agent_selection() {
        let (service, dir) = fixture();
        let probes = Arc::new(Mutex::new(Vec::new()));
        service.adapters.register(Arc::new(ModelProbe(probes.clone())));
        let legacy = json!({"id":"legacy","providerId":"codex","enabled":true,"executable":"local-codex","profile":"old-profile","baseArgs":["--config","old"],"models":[{"id":"legacy-model"}],"providerOptions":{"baseUrl":"https://old.example"}});
        Repositories::new(&service.db.lock().unwrap().raw).agents().save(&legacy, "now").unwrap();
        for id in ["account-one", "account-two"] {
            let profile = dir.join(id).to_string_lossy().into_owned();
            service.upsert(&json!({"connection":{"id":id,"name":id,"kind":"login","enabled":true,"harness":"codex","loginProfileDirectory":profile}})).unwrap();
            let catalog = service.models(&json!({"connectionId":id})).await.unwrap();
            assert_eq!(catalog["models"][0]["id"], "account-model");
            let captured = probes.lock().unwrap();
            let (instance, context) = captured.last().unwrap();
            assert_eq!(instance["baseArgs"], json!([]));
            assert!(instance["profile"].is_null());
            assert!(instance["providerOptions"]["baseUrl"].is_null());
            assert_eq!(context["env"]["CODEX_HOME"], profile);
            assert!(context["env"]["OPENAI_API_KEY"].is_null());
        }
        Repositories::new(&service.db.lock().unwrap().raw).agents().remove("legacy").unwrap();
        service.models(&json!({"connectionId":"account-one"})).await.unwrap();
        assert_eq!(probes.lock().unwrap().last().unwrap().0["executable"], "default-codex");
    }

    #[test]
    fn team_delegation_and_recovery_preserve_member_connection_and_harness() {
        let (service, _) = fixture();
        for id in ["parent-provider", "worker-provider"] {
            service.upsert(&json!({"connection":provider(id),"apiKey":id})).unwrap();
        }
        let harness = json!({"id":"harness","providerId":"claude-code","enabled":true,"baseArgs":[],"providerOptions":{"configurationKind":"harness"}});
        Repositories::new(&service.db.lock().unwrap().raw).agents().save(&harness,"now").unwrap();
        let teams = crate::application::team_service::TeamService::new(service.db.clone());
        let team = teams.upsert(&json!({"id":"team","members":[{"id":"worker","agentInstanceId":"harness","connectionId":"worker-provider","model":"worker-model","enabled":true}],"updatedAt":"now"})).unwrap();
        let member = &team["members"][0];
        assert_eq!(member["connectionRevision"], 1);
        service.upsert(&json!({"connection":provider("worker-provider"),"expectedRevision":1,"apiKey":"new-worker-key"})).unwrap();
        let parent = json!({"id":"parent","projectId":"project","connectionId":"parent-provider","connectionRevision":1});
        let run = json!({"id":"run","projectId":"project","teamId":"team","mainMemberId":"worker","mainAgentInstanceId":"harness","goal":"task"});
        let router = crate::runtime::orchestration::session_router::SessionRouter::new(service.db.clone());
        let child = router.delegated(&run,&team,member,&parent,"task","Child",None).unwrap();
        assert_eq!(child["agentInstanceId"], "harness");
        assert_eq!(child["connectionId"], "worker-provider");
        assert_eq!(child["connectionRevision"], 1);
        assert_eq!(child["model"], "worker-model");
        let (resolved, connection) = resolve_session_connection(&service.db.lock().unwrap().raw,&child,&harness).unwrap();
        let env = connection_environment(&resolved,&connection.unwrap(),&service.credentials,HashMap::new()).unwrap();
        assert_eq!(env.get("ANTHROPIC_API_KEY").map(String::as_str), Some("worker-provider"));
        let mut changed = member.clone(); changed["connectionRevision"] = json!(2);
        assert!(router.delegated(&run,&team,&changed,&parent,"task","Changed",None).is_err());
        assert!(router.delegated(&run,&team,&changed,&parent,"task-2","Changed",child["id"].as_str()).is_err());
        let recovered = router.replacement_main(&run,&team,"worker",&parent).unwrap();
        assert_eq!(recovered["connectionId"], "worker-provider");
        assert_eq!(recovered["connectionRevision"], 1);
        let main = router.main(&run,&team,None).unwrap();
        assert_eq!(main["connectionId"], "worker-provider");
        assert_eq!(main["model"], "worker-model");
        assert!(resolve_session_connection(&service.db.lock().unwrap().raw,&json!({}),&harness).is_err());
    }
    #[test]
    fn revisions_preserve_encrypted_credentials_and_no_plaintext_metadata() {
        let (service,_) = fixture();
        let first = service.upsert(&json!({"connection":provider("p"),"apiKey":"secret-one"})).unwrap();
        assert_eq!(first["revision"],1); assert_eq!(first["hasCredential"],true); assert!(!first.to_string().contains("secret-one"));
        let mut edited = provider("p"); edited["baseUrl"] = json!("https://other.example/v1");
        service.upsert(&json!({"connection":edited,"expectedRevision":1})).unwrap();
        let old = service.get("p",Some(1)).unwrap(); assert_eq!(old["baseUrl"],"https://provider.example/v1");
        assert_eq!(service.credentials.read(&credential_key("p",2)).unwrap().unwrap()["apiKey"],"secret-one");
        service.upsert(&json!({"connection":provider("p"),"expectedRevision":2,"clearApiKey":true})).unwrap();
        assert_eq!(service.get("p",Some(1)).unwrap()["hasCredential"],true);
        assert_eq!(service.get("p",Some(3)).unwrap()["hasCredential"],false);
        assert!(service.credentials.set(&credential_key("p",1),&json!({"apiKey":"overwrite"})).is_err());
        assert!(service.credentials.remove(&credential_key("p",1)).is_err());
        assert!(service.credentials.secret_values().contains(&"secret-one".to_string()));
        assert!(service.upsert(&json!({"connection":provider("p"),"expectedRevision":1})).is_err());
    }
    #[test]
    fn first_source_binding_on_empty_draft_is_not_a_history_transfer() {
        let (service, _) = fixture();
        service.upsert(&json!({"connection":provider("p"),"apiKey":"key"})).unwrap();
        let sessions = crate::application::SessionService::new(service.db.clone());
        let draft = json!({"id":"draft","projectId":"project","agentInstanceId":"a","memberId":"a","status":"idle","createdAt":"now","updatedAt":"now"});
        sessions.upsert(&draft).unwrap();
        let bound = sessions.upsert(&json!({"id":"draft","connectionId":"p","connectionRevision":1})).unwrap();
        assert_eq!(bound["connectionId"],"p");
        assert_eq!(bound["connectionContextRebuildRequired"],false);
        // The full renderer metadata is resent just before sending the message.
        let resent = sessions.upsert(&bound).unwrap();
        assert_eq!(resent["connectionRevision"],1);
        let mut historical = draft; historical["id"] = json!("historical"); historical["providerSessionId"] = json!("native-thread");
        sessions.upsert(&historical).unwrap();
        assert!(sessions.upsert(&json!({"id":"historical","connectionId":"p","connectionRevision":1})).is_err());
    }
    #[test]
    fn one_api_provider_supports_multiple_harnesses_without_mutating_them() {
        let mut connection = provider("p"); connection["revision"] = json!(1);
        for harness in ["codex","claude-code","pi","omp","opencode","kimi-code","commandcode","trae","new-provider-plugin"] {
            let agent = json!({"id":"a","providerId":harness,"executable":"my-cli","baseArgs":[],"providerOptions":{"baseUrl":"https://old.example","loginProfileDirectory":"/old"}});
            let resolved = apply_connection(&agent,&connection).unwrap();
            assert_eq!(resolved["id"],"a"); assert_eq!(resolved["executable"],"my-cli");
            assert_eq!(resolved["providerOptions"]["baseUrl"],connection["baseUrl"]);
            assert_eq!(resolved["providerOptions"]["runtimeConnectionRevision"],1);
            assert_eq!(agent["providerOptions"]["baseUrl"],"https://old.example");
        }
        assert!(apply_connection(&json!({"providerId":"pi","baseArgs":["--custom-endpoint"]}),&connection).is_err());
    }
    #[test]
    fn pinned_credentials_override_all_inherited_auth_and_disabled_head_blocks_old_revision() {
        let (service,_) = fixture(); service.upsert(&json!({"connection":provider("p"),"apiKey":"own-key"})).unwrap();
        let session = json!({"connectionId":"p","connectionRevision":1});
        let (agent,connection) = resolve_session_connection(&service.db.lock().unwrap().raw,&session,&json!({"id":"a","providerId":"codex","baseArgs":[]})).unwrap();
        let env = connection_environment_with_descriptor(&agent,&connection.unwrap(),&service.credentials,HashMap::from([("openai_api_key".into(),"other-key".into()),("ANTHROPIC_AUTH_TOKEN".into(),"wrong".into()),("CODEX_HOME".into(),"/other".into()),("PATH".into(),"bin".into())]),Some(&json!({"credentialEnv":["OPENAI_API_KEY","CODEX_API_KEY"]}))).unwrap();
        assert_eq!(env.get("OPENAI_API_KEY").map(String::as_str),Some("own-key"));
        assert_eq!(env.get("NAUTILO_CONNECTION_API_KEY").map(String::as_str),Some("own-key"));
        assert!(!env.contains_key("openai_api_key")); assert!(!env.contains_key("ANTHROPIC_AUTH_TOKEN")); assert!(!env.contains_key("CODEX_HOME"));
        let mut disabled = provider("p"); disabled["enabled"] = json!(false);
        service.upsert(&json!({"connection":disabled,"expectedRevision":1})).unwrap();
        assert!(resolve_session_connection(&service.db.lock().unwrap().raw,&session,&agent).is_err());
    }
    #[test]
    fn session_switch_requires_idle_confirmation_and_rebuilds_native_context() {
        let (service,_) = fixture();
        for id in ["p","q"] { service.upsert(&json!({"connection":provider(id),"apiKey":"key"})).unwrap(); }
        let sessions = crate::application::SessionService::new(service.db.clone());
        let saved = sessions.upsert(&json!({"id":"s","projectId":"project","agentInstanceId":"a","connectionId":"p","memberId":"a","status":"idle","createdAt":"now","updatedAt":"now"})).unwrap();
        assert_eq!(saved["connectionRevision"],1);
        let mut runtime = saved.clone(); runtime["providerSessionId"] = json!("old-thread"); runtime["providerContextWindow"] = json!(100);
        Repositories::new(&service.db.lock().unwrap().raw).sessions().save(&runtime).unwrap();
        assert!(sessions.upsert(&json!({"id":"s","connectionId":"q"})).is_err());
        let switched = sessions.upsert(&json!({"id":"s","connectionId":"q","confirmConnectionChange":true})).unwrap();
        assert_eq!(switched["connectionId"],"q"); assert_eq!(switched["connectionContextRebuildRequired"],true);
        assert!(switched.get("providerSessionId").is_none()); assert!(switched.get("providerContextWindow").is_none());
        assert!(switched.get("confirmConnectionChange").is_none());
        Repositories::new(&service.db.lock().unwrap().raw).runs().save(&json!({"id":"r","sessionId":"s","status":"running","updatedAt":"now","connectionId":"p","connectionRevision":1})).unwrap();
        assert!(sessions.upsert(&json!({"id":"s","connectionId":"p","confirmConnectionChange":true})).is_err());
        assert!(sessions.upsert(&json!({"id":"s","agentInstanceId":"other"})).is_err());
        assert!(service.remove("p").is_err()); assert!(service.remove("q").is_err());
    }
}
