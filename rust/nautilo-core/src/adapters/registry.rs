//! Adapter registry — port of adapters/registry.ts.
//! Built-ins register here; provider plugins join the same map when the
//! plugin system lands.

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use crate::adapters::model_catalog_cache::ModelCatalogCache;

use crate::adapters::claude::ClaudeCodeAdapter;
use crate::adapters::custom::CustomCliAdapter;
use crate::adapters::kimi::KimiCodeAdapter;
use crate::adapters::codex::CodexAdapter;
use crate::adapters::model_config::merge_instance_model_config;
use crate::adapters::{
    AdapterCapabilities, AdapterDetectionResult, AdapterResumeRequest, AdapterRun, AdapterStartRequest, AgentCliAdapter,
};
use crate::errors::{now_iso, CoreError, CoreResult, ErrorCode};

/// Cheaply clonable handle; the map lives behind an internal lock so no
/// guard is ever held across an .await.
#[derive(Clone, Default)]
pub struct AdapterRegistry {
    model_catalogs: ModelCatalogCache,
    model_generation: Arc<std::sync::atomic::AtomicU64>,
    adapters: Arc<std::sync::RwLock<HashMap<String, Arc<dyn AgentCliAdapter>>>>,
    /// Snapshot of the built-in set, so a plugin overriding a built-in can be
    /// rolled back on disable/uninstall.
    builtins: Arc<std::sync::RwLock<HashMap<String, Arc<dyn AgentCliAdapter>>>>,
}

impl AdapterRegistry {
    /// Existing built-ins keep their current integration. Additional harnesses
    /// register through the provider plugin service.
    pub fn with_builtins() -> Self {
        let registry = Self::default();
        registry.register(Arc::new(CodexAdapter));
        registry.register(Arc::new(ClaudeCodeAdapter::new()));
        registry.register(Arc::new(KimiCodeAdapter));
        registry.register(Arc::new(CustomCliAdapter));
        *registry.builtins.write().unwrap() = registry.adapters.read().unwrap().clone();
        registry
    }

    /// Puts a built-in adapter back after a plugin override ends. No-op for
    /// provider ids that were never built in.
    pub fn restore_builtin(&self, provider_id: &str) {
        let builtin = self.builtins.read().unwrap().get(provider_id).cloned();
        let mut adapters = self.adapters.write().unwrap();
        if let Some(builtin) = builtin { adapters.insert(provider_id.to_string(), builtin); }
        else { adapters.remove(provider_id); }
        self.model_generation.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        self.model_catalogs.clear();
    }

    pub fn register(&self, adapter: Arc<dyn AgentCliAdapter>) {
        let mut adapters = self.adapters.write().unwrap();
        adapters.insert(adapter.provider_id().to_string(), adapter);
        self.model_generation.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        self.model_catalogs.clear();
    }

    pub fn unregister(&self, provider_id: &str) -> bool {
        let mut adapters = self.adapters.write().unwrap();
        let removed = adapters.remove(provider_id).is_some();
        self.model_generation.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        self.model_catalogs.clear();
        removed
    }

    pub fn find(&self, provider_id: &str) -> Option<Arc<dyn AgentCliAdapter>> {
        self.adapters.read().unwrap().get(provider_id).cloned()
    }
    pub async fn dispose(&self) {
        let adapters:Vec<_>=self.adapters.read().unwrap().values().cloned().collect();
        for adapter in adapters {adapter.dispose().await;}
    }

    pub fn get(&self, provider_id: &str) -> CoreResult<Arc<dyn AgentCliAdapter>> {
        self.adapters.read().unwrap().get(provider_id).cloned().ok_or_else(|| {
            CoreError::reason(
                ErrorCode::IpcNotFound,
                format!("Provider \"{provider_id}\" 不可用：适配器未注册（插件缺失或未启用）"),
            )
        })
    }

    pub async fn detect(&self, instance: &Value) -> CoreResult<AdapterDetectionResult> {
        let provider_id = instance.get("providerId").and_then(Value::as_str).unwrap_or("");
        Ok(self.get(provider_id)?.detect(instance).await)
    }

    pub async fn list_models(&self, instance: &Value, context: Option<&Value>) -> CoreResult<Value> {
        self.list_models_with_refresh(instance, context, false).await
    }

    pub async fn list_models_with_refresh(&self, instance: &Value, context: Option<&Value>, force_refresh: bool) -> CoreResult<Value> {
        let provider_id = instance.get("providerId").and_then(Value::as_str).unwrap_or("").to_string();
        let (adapter, generation) = {
            let adapters = self.adapters.read().unwrap();
            let adapter = adapters.get(&provider_id).cloned().ok_or_else(|| CoreError::reason(ErrorCode::IpcNotFound, "Provider unavailable"))?;
            (adapter, self.model_generation.load(std::sync::atomic::Ordering::SeqCst))
        };
        let mut configuration = instance.clone();
        if let Some(fields) = configuration.as_object_mut() {
            fields.remove("status"); fields.remove("createdAt"); fields.remove("updatedAt");
        }
        let environment: std::collections::BTreeMap<String, String> = std::env::vars().collect();
        let key = format!("{:x}", Sha256::digest(json!({ "generation": generation, "instance": configuration, "context": context, "environment": environment }).to_string().as_bytes()));
        let instance = instance.clone();
        let context = context.cloned();
        self.model_catalogs.get(key, force_refresh, async move {
            let catalog = match adapter.list_models(&instance, context.as_ref()).await {
                Some(result) => result?,
                None => json_unavailable_catalog(&provider_id),
            };
            Ok(merge_instance_model_config(&catalog, instance.get("models")))
        }).await
    }

    /// Context-window metadata is optional. Discovery continues in its own
    /// cached task after this budget expires; no running model/settings change.
    pub async fn list_models_for_run(&self, instance: &Value) -> Option<Value> {
        tokio::time::timeout(std::time::Duration::from_millis(250), self.list_models(instance, None)).await.ok().and_then(Result::ok)
    }

    pub fn start(&self, request: AdapterStartRequest) -> CoreResult<AdapterRun> {
        let provider_id = request.instance.get("providerId").and_then(Value::as_str).unwrap_or("");
        self.get(provider_id)?.start(request)
    }

    pub fn resume(&self, request: AdapterResumeRequest) -> CoreResult<AdapterRun> {
        let provider_id = request.start.instance.get("providerId").and_then(Value::as_str).unwrap_or("");
        let adapter = self.get(provider_id)?;
        if !adapter.supports_resume() {
            return Err(CoreError::reason(
                ErrorCode::IpcInvalidRequest,
                format!("{provider_id} does not support native resume"),
            ));
        }
        adapter.resume(request)
    }

    pub fn list(&self) -> Vec<Arc<dyn AgentCliAdapter>> {
        self.adapters.read().unwrap().values().cloned().collect()
    }

    pub fn capabilities(&self, instance: &Value) -> CoreResult<AdapterCapabilities> {
        let provider_id = instance.get("providerId").and_then(Value::as_str).unwrap_or("");
        let adapter = self.get(provider_id)?;
        let base = adapter.capabilities();
        if provider_id != "custom" {
            return Ok(base);
        }
        let jsonl = instance
            .get("providerOptions")
            .and_then(|o| o.get("outputMode"))
            .and_then(Value::as_str)
            == Some("jsonl");
        Ok(AdapterCapabilities { structured_output: jsonl, pty: false, ..base })
    }
}

fn json_unavailable_catalog(provider_id: &str) -> Value {
    serde_json::json!({
        "providerId": provider_id,
        "models": [],
        "source": "unavailable",
        "fetchedAt": now_iso(),
        "warning": "该 Provider 暂不支持自动获取模型，可继续手动填写。"
    })
}
