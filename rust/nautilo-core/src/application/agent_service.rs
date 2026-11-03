//! Agent instances + provider discovery — port of application/agent-service.ts.

use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use crate::adapters::model_config::{discover_openai_compatible_models, merge_instance_model_config};
use crate::adapters::registry::AdapterRegistry;
use crate::database::{lock, Database, Repositories};
use crate::errors::{invalid, now_iso, CoreResult};
use crate::runtime::security::environment_policy::{build_environment, provider_environment_passthrough, isolate_login_profile, login_profile_directory};
use crate::runtime::security::CredentialService;

#[derive(Clone)]
pub struct AgentService {
    db: Arc<Mutex<Database>>,
    adapters: AdapterRegistry,
    credentials: Arc<CredentialService>,
}

impl AgentService {
    pub fn new(db: Arc<Mutex<Database>>, adapters: AdapterRegistry, credentials: Arc<CredentialService>) -> Self {
        Self { db, adapters, credentials }
    }

    fn default_executable(&self, provider_id: &str) -> Option<String> {
        let descriptor = self.adapters.find(provider_id)?.descriptor();
        descriptor.get("defaultExecutable").and_then(Value::as_str).map(str::to_string)
    }

    pub fn list(&self) -> CoreResult<Vec<Value>> {
        Repositories::new(&lock(&self.db).raw).agents().list_default()
    }

    pub fn upsert(&self, instance: &Value) -> CoreResult<Value> {
        if instance.get("executable").and_then(Value::as_str).unwrap_or("").trim().is_empty() {
            return Err(invalid("executable", ""));
        }
        let directory = login_profile_directory(instance)?;
        {
            let db = lock(&self.db);
            let repositories = Repositories::new(&db.raw);
            let id = instance.get("id").and_then(Value::as_str).unwrap_or("");
            if let Some(current) = repositories.agents().get(id)? {
                if (directory != login_profile_directory(&current)? || instance.get("providerId") != current.get("providerId"))
                    && (repositories.sessions().list_all()?.iter().any(|session| session.get("agentInstanceId").and_then(Value::as_str) == Some(id))
                        || repositories.runs().list()?.iter().any(|run| run.get("agentInstanceId").and_then(Value::as_str) == Some(id))) {
                    return Err(invalid("loginProfileDirectory", "Create a new instance to switch accounts; existing sessions retain their account"));
                }
            }
        }
        let updated_at = instance.get("updatedAt").and_then(Value::as_str).unwrap_or("").to_string();
        Repositories::new(&lock(&self.db).raw).agents().save(instance, &updated_at)?;
        Ok(instance.clone())
    }

    fn probe_instance(&self, provider_id: &str, configured: Option<Value>, command: &str) -> Value {
        let now = now_iso();
        let mut probe = configured.unwrap_or_else(|| {
            json!({
                "id": format!("probe:{provider_id}"),
                "providerId": provider_id,
                "displayName": provider_id,
                "executable": command,
                "baseArgs": [],
                "capabilities": [],
                "enabled": true,
                "status": "offline",
                "createdAt": now,
                "updatedAt": now
            })
        });
        probe.as_object_mut().unwrap().insert("executable".to_string(), json!(command));
        probe
    }

    pub async fn detect(&self, provider_id: &str, executable: Option<&str>) -> CoreResult<Value> {
        let configured = self
            .list()?
            .into_iter()
            .find(|instance| {
                instance.get("providerId").and_then(Value::as_str) == Some(provider_id)
                    && instance.get("executable").and_then(Value::as_str).is_some_and(|e| !e.trim().is_empty())
            });
        let command = executable
            .map(str::trim)
            .filter(|e| !e.is_empty())
            .map(str::to_string)
            .or_else(|| configured.as_ref().and_then(|c| c.get("executable")).and_then(Value::as_str).map(str::to_string))
            .or_else(|| self.default_executable(provider_id));
        let Some(command) = command else {
            return Ok(json!({
                "providerId": provider_id,
                "installed": false,
                "compatible": false,
                "executable": "",
                "error": "该 Provider 尚未完成真实 CLI 探测；请先配置可执行文件"
            }));
        };
        let probe = self.probe_instance(provider_id, configured, &command);
        let detection = self.adapters.detect(&probe).await?;
        let mut result = serde_json::Map::new();
        result.insert("providerId".to_string(), json!(provider_id));
        result.insert("installed".to_string(), json!(detection.installed));
        if let Some(compatible) = detection.compatible {
            result.insert("compatible".to_string(), json!(compatible));
        }
        result.insert("executable".to_string(), json!(detection.executable));
        if let Some(version) = detection.version {
            result.insert("version".to_string(), json!(version));
        }
        if let Some(help) = detection.help {
            result.insert("help".to_string(), json!(help));
        }
        if let Some(error) = detection.error {
            result.insert("error".to_string(), json!(error));
        }
        Ok(Value::Object(result))
    }

    pub async fn list_models(
        &self,
        provider_id: &str,
        executable: Option<&str>,
        agent_instance_id: Option<&str>,
        base_url: Option<&str>,
        api_key: Option<&str>,
        api_type: Option<&str>,
    ) -> CoreResult<Value> {
        let instances = self.list()?;
        let configured = match agent_instance_id {
            Some(id) => instances
                .iter()
                .find(|instance| {
                    instance.get("id").and_then(Value::as_str) == Some(id)
                        && instance.get("providerId").and_then(Value::as_str) == Some(provider_id)
                })
                .cloned(),
            None => instances
                .iter()
                .find(|instance| {
                    instance.get("providerId").and_then(Value::as_str) == Some(provider_id)
                        && instance.get("executable").and_then(Value::as_str).is_some_and(|e| !e.trim().is_empty())
                })
                .cloned(),
        };
        let command = executable
            .map(str::trim)
            .filter(|e| !e.is_empty())
            .map(str::to_string)
            .or_else(|| configured.as_ref().and_then(|c| c.get("executable")).and_then(Value::as_str).map(str::to_string))
            .or_else(|| self.default_executable(provider_id));
        let unavailable = |warning: String| {
            json!({
                "providerId": provider_id,
                "models": [],
                "source": "unavailable",
                "fetchedAt": now_iso(),
                "warning": warning
            })
        };
        let Some(command) = command else {
            return Ok(unavailable("请先检测 CLI 或填写可执行文件路径，然后再获取模型。".to_string()));
        };
        let probe = self.probe_instance(provider_id, configured, &command);
        let base_url = base_url.map(str::trim).filter(|v| !v.is_empty());
        let api_key = api_key.map(str::trim).filter(|v| !v.is_empty());
        let api_type = api_type.map(str::trim).filter(|v| !v.is_empty());
        let descriptor = self.adapters.find(provider_id).map(|a| a.descriptor());
        let mut instance = probe.as_object().cloned().unwrap_or_default();
        let mut options = instance
            .get("providerOptions")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        if let Some(base_url) = base_url {
            options.insert("baseUrl".to_string(), json!(base_url));
        }
        if let Some(api_type) = api_type {
            options.insert("apiType".to_string(), json!(api_type));
        }
        instance.insert("providerOptions".to_string(), Value::Object(options));
        let instance = Value::Object(instance);

        let instance_id = instance.get("id").and_then(Value::as_str).unwrap_or("");
        let mut credential_environment = self.credentials_environment(instance_id, provider_id);
        if let Some(api_key) = api_key {
            let keys: Vec<&str> = descriptor
                .as_ref()
                .and_then(|d| d.get("credentialEnv"))
                .and_then(Value::as_array)
                .map(|keys| keys.iter().filter_map(Value::as_str).collect())
                .unwrap_or_default();
            for key in keys {
                credential_environment.insert(key.to_string(), api_key.to_string());
            }
        }
        let mut additions = provider_environment_passthrough(&instance, descriptor.as_ref());
        additions.extend(credential_environment.clone());
        let context = json!({ "env": isolate_login_profile(&instance, build_environment(None, additions))? });

        // Instance-editor quick fetch must honor the unsaved endpoint currently
        // visible in the form. Once the user supplies a base URL, never
        // silently replace an API failure with the local CLI catalog.
        if let Some(base_url) = base_url {
            let effective_api_key = api_key.map(str::to_string).or_else(|| {
                descriptor
                    .as_ref()
                    .and_then(|d| d.get("credentialEnv"))
                    .and_then(Value::as_array)
                    .and_then(|keys| {
                        keys.iter()
                            .filter_map(Value::as_str)
                            .find_map(|key| credential_environment.get(key).map(|v| v.trim().to_string()).filter(|v| !v.is_empty()))
                    })
            });
            return match discover_openai_compatible_models(base_url, effective_api_key.as_deref(), 10_000, api_type).await {
                Ok(generic) => {
                    let mut catalog = generic.as_object().cloned().unwrap_or_default();
                    catalog.insert("providerId".to_string(), json!(provider_id));
                    Ok(merge_instance_model_config(&Value::Object(catalog), instance.get("models")))
                }
                Err(error) => Ok(unavailable(error.to_string())),
            };
        }
        match self.adapters.list_models_with_refresh(&instance, Some(&context), true).await {
            Ok(catalog) => Ok(catalog),
            // The TS registry merges the instance's manually configured models
            // into every catalog, including discovery failures — otherwise
            // providers without model discovery (trae) offer no choices at all.
            Err(error) => Ok(merge_instance_model_config(&unavailable(error.to_string()), instance.get("models"))),
        }
    }

    fn credentials_environment(&self, agent_instance_id: &str, provider_id: &str) -> std::collections::HashMap<String, String> {
        let credential = match self.credentials.read(agent_instance_id) {
            Ok(Some(credential)) => credential,
            _ => return std::collections::HashMap::new(),
        };
        let api_key = credential.get("apiKey").and_then(Value::as_str).unwrap_or("");
        if api_key.is_empty() {
            return std::collections::HashMap::new();
        }
        let mut environment = std::collections::HashMap::new();
        if let Some(env_name) = credential.get("envName").and_then(Value::as_str).filter(|s| !s.is_empty()) {
            environment.insert(env_name.to_string(), api_key.to_string());
            return environment;
        }
        let env_names: Vec<String> = self.adapters
            .find(provider_id)
            .and_then(|adapter| adapter.descriptor().get("credentialEnv").and_then(Value::as_array).cloned())
            .map(|names| names.iter().filter_map(Value::as_str).map(str::to_string).collect())
            .unwrap_or_else(|| match provider_id {
                "kimi" => vec!["KIMI_API_KEY".to_string()],
                "claude" => vec!["ANTHROPIC_API_KEY".to_string()],
                _ => vec![],
            });
        if env_names.is_empty() {
            environment.insert("AGENTHUB_API_KEY".to_string(), api_key.to_string());
        } else {
            for name in env_names {
                environment.insert(name, api_key.to_string());
            }
        }
        environment
    }
}
