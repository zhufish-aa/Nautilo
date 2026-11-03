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
use crate::runtime::security::environment_policy::{build_environment, isolate_login_profile, login_profile_directory};

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
        match self.discover_models(input).await {
            Ok(catalog) => Ok(catalog),
            Err(_) => Ok(json!({"providerId":format!("connection:{}",input["connectionId"].as_str().unwrap_or("")),"models":[],"source":"unavailable","fetchedAt":now_iso(),"warning":"Connection model discovery failed. Check endpoint, protocol, credentials and harness compatibility."})),
        }
    }
    async fn discover_models(&self, input: &Value) -> CoreResult<Value> {
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
            return Ok(merge_instance_model_config(&catalog, connection.get("models")));
        }
        let Some(agent_id) = input["agentInstanceId"].as_str() else {
            return Ok(json!({"providerId":connection["harness"],"models":[],"source":"unavailable","warning":"Select a matching installed harness to discover login-account models","fetchedAt":now_iso()}));
        };
        let agent = Repositories::new(&self.db.lock().unwrap().raw).agents().get(agent_id)?.ok_or_else(|| not_found("agent",agent_id))?;
        let agent = apply_connection(&agent,&connection)?;
        let env = isolate_login_profile(&agent, build_environment(None,HashMap::new()))?;
        self.adapters.list_models(&agent,Some(&json!({"env":env}))).await
    }
}
fn public_connection(db: &Connection, mut value: Value) -> CoreResult<Value> {
    let id = value["id"].as_str().unwrap_or(""); let revision = value["revision"].as_u64().unwrap_or(0);
    let has = Repositories::new(db).credentials().has(&credential_key(id,revision))?;
    value["hasCredential"] = json!(has); Ok(value)
}
fn head(db: &Connection, id: &str) -> CoreResult<Value> { Repositories::new(db).runtime_connections().get(id)?.ok_or_else(|| not_found("connection",id)) }
fn version(db: &Connection, id: &str, revision: u64) -> CoreResult<Value> { Repositories::new(db).runtime_connection_versions().get(&version_key(id,revision))?.ok_or_else(|| invalid("connectionRevision", "Pinned connection revision is missing")) }

fn validate_connection(value: &Value) -> CoreResult<Value> {
    let object = value.as_object().ok_or_else(|| invalid("connection", "Expected a connection"))?;
    let mut result = serde_json::Map::new();
    for key in ["id","name","kind","enabled","protocol","baseUrl","harness","loginProfileDirectory","models"] {
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
        }
        Some("login") => {
            let harness = result["harness"].as_str().unwrap_or("");
            login_profile_directory(&json!({"providerId":harness,"baseArgs":[],"providerOptions":{"loginProfileDirectory":result["loginProfileDirectory"]}}))?
                .ok_or_else(|| invalid("loginProfileDirectory","Select an explicit account directory"))?;
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

pub fn resolve_session_connection(db: &Connection, session: &Value, agent: &Value) -> CoreResult<(Value,Option<Value>)> {
    let Some(id) = session.get("connectionId").and_then(Value::as_str) else { return Ok((agent.clone(),None)); };
    let h = head(db,id)?;
    if h["enabled"] != true { return Err(invalid("connectionId","Connection is disabled")); }
    let revision = session["connectionRevision"].as_u64().ok_or_else(|| invalid("connectionRevision","Session has no pinned revision"))?;
    let connection = version(db,id,revision)?;
    let resolved = apply_connection(agent,&connection)?;
    Ok((resolved,Some(connection)))
}
pub fn apply_connection(agent: &Value, connection: &Value) -> CoreResult<Value> {
    let mut result = agent.clone();
    let harness = agent["providerId"].as_str().unwrap_or("");
    if !matches!(connection["kind"].as_str(),Some("api"|"login")) { return Err(invalid("kind","Invalid connection kind")); }
    let mut options = agent["providerOptions"].as_object().cloned().unwrap_or_default();
    for key in ["baseUrl","apiType","wireApi","loginProfileDirectory","loginProfileLabel","anthropicCompat"] { options.remove(key); }
    if connection["kind"] == "login" {
        if connection["harness"] != harness { return Err(invalid("connectionId","Login account belongs to a different harness")); }
        options.insert("loginProfileDirectory".into(),connection["loginProfileDirectory"].clone());
    } else {
        let protocol = connection["protocol"].as_str().unwrap_or("");
        if !matches!(protocol,"responses"|"chat"|"anthropic") { return Err(invalid("protocol","Unsupported API protocol")); }
        validated_model_endpoint(connection["baseUrl"].as_str().unwrap_or(""))?;
        if !(harness == "codex" || (harness == "claude-code" && protocol == "anthropic")) { return Err(invalid("connectionId","This harness/protocol combination is not supported")); }
        if agent.get("profile").and_then(Value::as_str).is_some_and(|s| !s.is_empty()) || agent.get("baseArgs").and_then(Value::as_array).is_some_and(|a| !a.is_empty()) {
            return Err(invalid("baseArgs","Bound API providers require default harness arguments and no CLI profile"));
        }
        options.insert("baseUrl".into(),connection["baseUrl"].clone());
        options.insert("apiType".into(),json!(if protocol == "anthropic" {"anthropic-messages"} else if protocol == "responses" {"openai-responses"} else {"openai-completions"}));
        if harness == "codex" { options.insert("wireApi".into(),json!(protocol)); }
    }
    options.insert("runtimeConnectionId".into(),connection["id"].clone());
    options.insert("runtimeConnectionRevision".into(),connection["revision"].clone());
    result["providerOptions"] = json!(options);
    result["models"] = connection.get("models").cloned().unwrap_or_else(|| if connection["kind"] == "login" { agent.get("models").cloned().unwrap_or_else(|| json!([])) } else { json!([]) });
    login_profile_directory(&result)?;
    Ok(result)
}

/// Call after all allowlist/passthrough merges: no inherited credential can override a binding.
pub fn connection_environment(agent: &Value, connection: &Value, credentials: &CredentialService, mut env: HashMap<String,String>) -> CoreResult<HashMap<String,String>> {
    env.retain(|key,_| {
        let key = key.to_ascii_uppercase();
        !["OPENAI_","CODEX_","ANTHROPIC_","CLAUDE_CODE_OAUTH","CLAUDE_CODE_API","CLAUDE_CODE_USE_","CLAUDE_CODE_SESSION_ACCESS"].iter().any(|p| key.starts_with(p)) && key != "CLAUDE_CONFIG_DIR" && !key.starts_with("AGENTHUB_API")
    });
    if connection["kind"] == "login" { return isolate_login_profile(agent,env); }
    let id = connection["id"].as_str().unwrap(); let revision = connection["revision"].as_u64().unwrap();
    let key = credentials.read(&credential_key(id,revision))?.and_then(|v| v["apiKey"].as_str().map(str::to_string)).filter(|s| !s.is_empty())
        .ok_or_else(|| invalid("connectionId","The pinned API provider has no credential; create a new revision and session"))?;
    if agent["providerId"] == "codex" { env.insert("OPENAI_API_KEY".into(),key); env.insert("OPENAI_BASE_URL".into(),connection["baseUrl"].as_str().unwrap().into()); }
    else { env.insert("ANTHROPIC_API_KEY".into(),key); env.insert("ANTHROPIC_BASE_URL".into(),connection["baseUrl"].as_str().unwrap().into()); }
    Ok(env)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (ConnectionService, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("nautilo-connections-{}",uuid::Uuid::new_v4()));
        let db = Arc::new(Mutex::new(Database::open(&dir.join("test.sqlite")).unwrap()));
        let credentials = Arc::new(CredentialService::new(db.clone(),&dir));
        (ConnectionService::new(db,credentials,AdapterRegistry::with_builtins()),dir)
    }
    fn provider(id: &str) -> Value { json!({"id":id,"name":"Provider","kind":"api","enabled":true,"protocol":"anthropic","baseUrl":"https://provider.example/v1","models":[{"id":"claude-test","reasoningEfforts":["none"],"pricing":{"input":2.0}}]}) }
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
    fn one_api_provider_supports_multiple_harnesses_without_mutating_them() {
        let mut connection = provider("p"); connection["revision"] = json!(1);
        for harness in ["codex","claude-code"] {
            let agent = json!({"id":"a","providerId":harness,"executable":"my-cli","baseArgs":[],"providerOptions":{"baseUrl":"https://old.example","loginProfileDirectory":"/old"}});
            let resolved = apply_connection(&agent,&connection).unwrap();
            assert_eq!(resolved["id"],"a"); assert_eq!(resolved["executable"],"my-cli");
            assert_eq!(resolved["providerOptions"]["baseUrl"],connection["baseUrl"]);
            assert_eq!(resolved["providerOptions"]["runtimeConnectionRevision"],1);
            assert_eq!(agent["providerOptions"]["baseUrl"],"https://old.example");
        }
        assert!(apply_connection(&json!({"providerId":"kimi","baseArgs":[]}),&connection).is_err());
    }
    #[test]
    fn pinned_credentials_override_all_inherited_auth_and_disabled_head_blocks_old_revision() {
        let (service,_) = fixture(); service.upsert(&json!({"connection":provider("p"),"apiKey":"own-key"})).unwrap();
        let session = json!({"connectionId":"p","connectionRevision":1});
        let (agent,connection) = resolve_session_connection(&service.db.lock().unwrap().raw,&session,&json!({"id":"a","providerId":"codex","baseArgs":[]})).unwrap();
        let env = connection_environment(&agent,&connection.unwrap(),&service.credentials,HashMap::from([("openai_api_key".into(),"other-key".into()),("ANTHROPIC_AUTH_TOKEN".into(),"wrong".into()),("CODEX_HOME".into(),"/other".into()),("PATH".into(),"bin".into())])).unwrap();
        assert_eq!(env.get("OPENAI_API_KEY").map(String::as_str),Some("own-key")); assert_eq!(env.len(),3);
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
