//! Plugin service — port of runtime/plugins/plugin-service.ts.
//! Loads native provider plugins from <dataDir>/plugins/<id>/ and registers
//! their adapters. One broken plugin never blocks the daemon.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use crate::adapters::registry::AdapterRegistry;
use crate::adapters::AgentCliAdapter;
use crate::errors::{CoreError, CoreResult, ErrorCode};
use crate::runtime::plugins::plugin_adapter::{launch_plugin, PluginClient};

/// Default marketplace registry; overridable per-call or via env.
const DEFAULT_REGISTRY_URL: &str = "https://cdn.jsdelivr.net/gh/zhufish-aa/nautilo-provider-registry@main/registry.json";
const DISABLED_MARKER: &str = ".disabled";
const MANIFEST_FILE: &str = "agenthub-plugin.json";
const PROVIDER_API_VERSION: i64 = 1;

fn plugin_fail(code: ErrorCode, dir: &str, reason: impl Into<String>) -> CoreError {
    let mut details = Map::new();
    details.insert("dir".to_string(), json!(dir));
    details.insert("reason".to_string(), json!(reason.into()));
    CoreError::details(code, details)
}

pub struct PluginService {
    plugins_dir: PathBuf,
    registry: AdapterRegistry,
    records: Mutex<Map<String, Value>>,
    /// Ids currently registered by this service (plugins may be reloaded).
    loaded: Mutex<std::collections::HashSet<String>>,
    /// Adapters a loaded plugin replaced (restored on disable/uninstall).
    overridden: Mutex<Map<String, Value>>,
    clients: Mutex<Map<String, Value>>,
}

impl PluginService {
    pub fn new(data_dir: &Path, registry: AdapterRegistry) -> Self {
        Self {
            plugins_dir: data_dir.join("plugins"),
            registry,
            records: Mutex::new(Map::new()),
            loaded: Mutex::new(std::collections::HashSet::new()),
            overridden: Mutex::new(Map::new()),
            clients: Mutex::new(Map::new()),
        }
    }

    /// Startup scan: load every enabled plugin. Runs before the gateway
    /// serves IPC so provider.catalog and runs see every loadable plugin.
    pub async fn load_all(&self) {
        let _ = std::fs::create_dir_all(&self.plugins_dir);
        let entries = std::fs::read_dir(&self.plugins_dir).map(|e| e.flatten().collect::<Vec<_>>()).unwrap_or_default();
        for entry in entries {
            if !entry.path().is_dir() {
                continue;
            }
            let id = entry.file_name().to_string_lossy().into_owned();
            let dir = entry.path();
            let manifest = self.read_manifest(&dir).ok();
            let Some(manifest) = manifest else { continue };
            if dir.join(DISABLED_MARKER).exists() {
                self.records.lock().unwrap().insert(id.clone(), record(&id, false, "disabled", None, &dir, Some(&manifest)));
                continue;
            }
            self.load_one(&id).await;
        }
    }

    pub fn list(&self) -> Vec<Value> {
        let mut records: Vec<Value> = self.records.lock().unwrap().values().cloned().collect();
        records.sort_by(|a, b| {
            a.get("id").and_then(Value::as_str).unwrap_or("").cmp(b.get("id").and_then(Value::as_str).unwrap_or(""))
        });
        records
    }

    /// Installs from a local plugin directory (copies into the plugins root).
    pub async fn install_local(&self, source_dir: &str) -> CoreResult<Value> {
        let source = Path::new(source_dir);
        let manifest = self.read_manifest(source)?;
        validate_manifest(&manifest, source_dir)?;
        let id = manifest.get("id").and_then(Value::as_str).unwrap_or("").to_string();
        let target = self.plugins_dir.join(&id);
        let _ = std::fs::create_dir_all(&self.plugins_dir);
        let _ = std::fs::remove_dir_all(&target);
        copy_dir_skip_symlinks(source, &target)
            .map_err(|e| plugin_fail(ErrorCode::PluginInvalid, source_dir, e.to_string()))?;
        self.load_one(&id).await
    }

    /// Fetches the marketplace registry entries.
    pub async fn fetch_registry(&self, registry_url: Option<&str>) -> CoreResult<Value> {
        let url = registry_url
            .map(str::to_string)
            .or_else(|| std::env::var("AGENTHUB_PLUGIN_REGISTRY").ok())
            .unwrap_or_else(|| DEFAULT_REGISTRY_URL.to_string());
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(15))
            .build()
            .map_err(|e| registry_unavailable(&url, e.to_string()))?;
        let response = client.get(&url).send().await.map_err(|e| registry_unavailable(&url, e.to_string()))?;
        if !response.status().is_success() {
            return Err(registry_unavailable(&url, format!("HTTP {}", response.status().as_u16())));
        }
        let data: Value = response
            .json()
            .await
            .map_err(|e| registry_unavailable(&url, format!("registry JSON 解析失败：{e}")))?;
        let plugins: Vec<Value> = data
            .get("plugins")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter(|entry| entry.get("id").is_some() && entry.get("tarball").is_some())
            .collect();
        Ok(Value::Array(plugins))
    }

    /// Installs a plugin from the marketplace registry.
    pub async fn install_from_registry(&self, plugin_id: &str, registry_url: Option<&str>) -> CoreResult<Value> {
        let entries = self.fetch_registry(registry_url).await?;
        let entry = entries
            .as_array()
            .and_then(|entries| entries.iter().find(|item| item.get("id").and_then(Value::as_str) == Some(plugin_id)))
            .cloned();
        let Some(entry) = entry else {
            let mut details = Map::new();
            details.insert("resource".to_string(), json!("registryPlugin"));
            details.insert("id".to_string(), json!(plugin_id));
            return Err(CoreError::details(ErrorCode::IpcNotFound, details));
        };
        self.install_tarball(
            entry.get("tarball").and_then(Value::as_str).unwrap_or(""),
            entry.get("sha256").and_then(Value::as_str),
        )
        .await
    }

    /// Downloads a .tgz plugin package, verifies its checksum and installs it.
    pub async fn install_tarball(&self, tarball_url: &str, sha256: Option<&str>) -> CoreResult<Value> {
        let scratch = std::env::temp_dir().join(format!("agenthub-plugin-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&scratch).map_err(|e| plugin_fail(ErrorCode::PluginDownloadFailed, tarball_url, e.to_string()))?;
        let result = self.install_tarball_inner(&scratch, tarball_url, sha256).await;
        let _ = std::fs::remove_dir_all(&scratch);
        result
    }

    async fn install_tarball_inner(&self, scratch: &Path, tarball_url: &str, sha256: Option<&str>) -> CoreResult<Value> {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(120))
            .build()
            .map_err(|e| plugin_fail(ErrorCode::PluginDownloadFailed, tarball_url, e.to_string()))?;
        let response = client
            .get(tarball_url)
            .send()
            .await
            .map_err(|e| plugin_fail(ErrorCode::PluginDownloadFailed, tarball_url, e.to_string()))?;
        if !response.status().is_success() {
            return Err(plugin_fail(
                ErrorCode::PluginDownloadFailed,
                tarball_url,
                format!("HTTP {}", response.status().as_u16()),
            ));
        }
        let bytes = response
            .bytes()
            .await
            .map_err(|e| plugin_fail(ErrorCode::PluginDownloadFailed, tarball_url, e.to_string()))?;
        if let Some(expected) = sha256 {
            let digest = format!("{:x}", Sha256::digest(&bytes));
            if digest != expected.to_lowercase() {
                let mut details = Map::new();
                details.insert("expected".to_string(), json!(expected.to_lowercase()));
                details.insert("actual".to_string(), json!(digest));
                return Err(CoreError::details(ErrorCode::PluginChecksumMismatch, details));
            }
        }
        let archive = scratch.join("plugin.tgz");
        std::fs::write(&archive, &bytes).map_err(|e| plugin_fail(ErrorCode::PluginDownloadFailed, tarball_url, e.to_string()))?;
        let extract_dir = scratch.join("extract");
        std::fs::create_dir_all(&extract_dir).map_err(|e| plugin_fail(ErrorCode::PluginDownloadFailed, tarball_url, e.to_string()))?;
        // bsdtar ships with Windows 10+ and every supported unix. Relative
        // paths inside the scratch dir: GNU tar treats a "C:"-prefixed path as
        // a remote host spec.
        let status = {
            let mut cmd = std::process::Command::new("tar");
            cmd.args(["-xzf", "plugin.tgz", "-C", "extract"]).current_dir(scratch);
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                // CREATE_NO_WINDOW — don't flash a console while extracting.
                cmd.creation_flags(0x0800_0000);
            }
            cmd.output()
        }
        .map_err(|e| plugin_fail(ErrorCode::PluginInvalid, tarball_url, e.to_string()))?;
        if !status.status.success() {
            return Err(plugin_fail(
                ErrorCode::PluginInvalid,
                tarball_url,
                String::from_utf8_lossy(&status.stderr).trim().to_string(),
            ));
        }
        let root = find_plugin_root(&extract_dir)?;
        self.install_local(&root.to_string_lossy()).await
    }

    pub async fn uninstall(&self, plugin_id: &str) -> CoreResult<Value> {
        self.unload(plugin_id).await;
        self.records.lock().unwrap().remove(plugin_id);
        let _ = std::fs::remove_dir_all(self.plugins_dir.join(plugin_id));
        Ok(json!({ "removed": true }))
    }

    pub async fn set_enabled(&self, plugin_id: &str, enabled: bool) -> CoreResult<Value> {
        let dir = self.plugins_dir.join(plugin_id);
        let manifest = self.read_manifest(&dir).ok();
        let Some(manifest) = manifest else {
            let mut details = Map::new();
            details.insert("resource".to_string(), json!("plugin"));
            details.insert("id".to_string(), json!(plugin_id));
            return Err(CoreError::details(ErrorCode::IpcNotFound, details));
        };
        if enabled {
            let _ = std::fs::remove_file(dir.join(DISABLED_MARKER));
            return self.load_one(plugin_id).await;
        }
        let _ = std::fs::write(dir.join(DISABLED_MARKER), crate::errors::now_iso());
        self.unload(plugin_id).await;
        let record = record(plugin_id, false, "disabled", None, &dir, Some(&manifest));
        self.records.lock().unwrap().insert(plugin_id.to_string(), record.clone());
        Ok(record)
    }

    pub async fn stop(&self) {
        let ids: Vec<String> = self.loaded.lock().unwrap().iter().cloned().collect();
        for id in ids {
            self.unload(&id).await;
        }
    }

    async fn unload(&self, plugin_id: &str) {
        if !self.loaded.lock().unwrap().remove(plugin_id) {
            return;
        }
        // The plugin process exits on dispose; the client adapter is removed
        // from the registry either way.
        self.clients.lock().unwrap().remove(plugin_id);
        let previous = self.overridden.lock().unwrap().remove(plugin_id);
        if let Some(_previous) = previous {
            // Built-in adapters cannot be reconstructed from JSON; the
            // registry keeps the default set so re-registering restores them.
            self.registry.restore_builtin(plugin_id);
        } else {
            self.registry.unregister(plugin_id);
        }
    }

    async fn load_one(&self, plugin_id: &str) -> CoreResult<Value> {
        let dir = self.plugins_dir.join(plugin_id);
        let manifest = self.read_manifest(&dir)?;
        if let Err(error) = validate_manifest(&manifest, &dir.to_string_lossy()) {
            let record = record(plugin_id, true, "error", Some(error.to_string()), &dir, None);
            self.records.lock().unwrap().insert(plugin_id.to_string(), record.clone());
            return Ok(record);
        }
        self.unload(plugin_id).await;
        let main = manifest.get("main").and_then(Value::as_str).unwrap_or("");
        let executable = resolve_executable(&dir, main);
        match launch_plugin(plugin_id, &executable, &dir).await {
            Ok(client) => {
                let adapter_id = client.provider_id().to_string();
                if adapter_id != plugin_id {
                    let record = record(
                        plugin_id,
                        true,
                        "error",
                        Some(format!("适配器 providerId（{adapter_id}）与插件 id（{plugin_id}）不一致")),
                        &dir,
                        Some(&manifest),
                    );
                    self.records.lock().unwrap().insert(plugin_id.to_string(), record.clone());
                    return Ok(record);
                }
                // Snapshot whatever the plugin replaces so unload restores it.
                if self.registry.find(plugin_id).is_some() {
                    self.overridden.lock().unwrap().insert(plugin_id.to_string(), json!(true));
                }
                self.registry.register(Arc::new(client));
                self.loaded.lock().unwrap().insert(plugin_id.to_string());
                let record = record(plugin_id, true, "loaded", None, &dir, Some(&manifest));
                self.records.lock().unwrap().insert(plugin_id.to_string(), record.clone());
                Ok(record)
            }
            Err(error) => {
                let record = record(plugin_id, true, "error", Some(error.to_string()), &dir, Some(&manifest));
                self.records.lock().unwrap().insert(plugin_id.to_string(), record.clone());
                Ok(record)
            }
        }
    }

    fn read_manifest(&self, dir: &Path) -> CoreResult<Value> {
        let file = dir.join(MANIFEST_FILE);
        let raw = std::fs::read_to_string(&file)
            .map_err(|_| plugin_fail(ErrorCode::PluginManifestMissing, &dir.to_string_lossy(), format!("未找到 {MANIFEST_FILE}：{}", file.display())))?;
        serde_json::from_str(&raw)
            .map_err(|e| plugin_fail(ErrorCode::PluginInvalid, &dir.to_string_lossy(), format!("清单 JSON 解析失败：{e}")))
    }
}

fn registry_unavailable(url: &str, reason: String) -> CoreError {
    let mut details = Map::new();
    details.insert("url".to_string(), json!(url));
    details.insert("reason".to_string(), json!(reason));
    CoreError::details(ErrorCode::PluginRegistryUnavailable, details)
}

fn record(id: &str, enabled: bool, status: &str, error: Option<String>, dir: &Path, manifest: Option<&Value>) -> Value {
    let mut record = Map::new();
    record.insert("id".to_string(), json!(id));
    record.insert("enabled".to_string(), json!(enabled));
    record.insert("status".to_string(), json!(status));
    if let Some(error) = error {
        record.insert("error".to_string(), json!(error));
    }
    record.insert("dir".to_string(), json!(dir.to_string_lossy()));
    if let Some(manifest) = manifest {
        record.insert("manifest".to_string(), manifest.clone());
    }
    Value::Object(record)
}

fn validate_manifest(manifest: &Value, dir: &str) -> CoreResult<()> {
    let fail = |reason: &str| Err(plugin_fail(ErrorCode::PluginInvalid, dir, reason));
    if !manifest.is_object() {
        return fail("插件清单不是有效的 JSON 对象");
    }
    let id = manifest.get("id").and_then(Value::as_str).unwrap_or("");
    if id.is_empty() || !regex::Regex::new(r"^[a-z0-9][a-z0-9-]*$").map(|re| re.is_match(id)).unwrap_or(false) {
        return fail("插件 id 缺失或含非法字符");
    }
    if manifest.get("apiVersion").and_then(Value::as_i64) != Some(PROVIDER_API_VERSION) {
        return fail(&format!(
            "插件 API 版本不兼容（插件 {}，宿主 {PROVIDER_API_VERSION}）",
            manifest.get("apiVersion").and_then(Value::as_i64).unwrap_or(-1)
        ));
    }
    if manifest.get("main").and_then(Value::as_str).is_none() {
        return fail("插件清单缺少 main 入口");
    }
    let descriptor = manifest.get("descriptor").cloned().unwrap_or(Value::Null);
    if descriptor.get("providerId").and_then(Value::as_str) != Some(id) {
        return fail("descriptor.providerId 必须与插件 id 一致");
    }
    if descriptor.get("name").and_then(Value::as_str).is_none() || descriptor.get("vendor").and_then(Value::as_str).is_none() {
        return fail("descriptor 缺少 name/vendor");
    }
    if !descriptor.get("capabilities").is_some_and(Value::is_array) {
        return fail("descriptor.capabilities 必须是数组");
    }
    Ok(())
}

/// Native plugins: main points at the plugin binary (platform extension added
/// when missing).
fn resolve_executable(dir: &Path, main: &str) -> PathBuf {
    let candidate = dir.join(main);
    if candidate.exists() {
        return candidate;
    }
    #[cfg(windows)]
    {
        let with_exe = dir.join(format!("{main}.exe"));
        if with_exe.exists() {
            return with_exe;
        }
    }
    candidate
}

fn copy_dir_skip_symlinks(source: &Path, target: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(target)?;
    for entry in std::fs::read_dir(source)? {
        let entry = entry?;
        // Skip symlinks: Windows refuses to recreate them without privilege,
        // and plugin runtime code must be self-contained anyway.
        if entry.file_type()?.is_symlink() {
            continue;
        }
        let destination = target.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_skip_symlinks(&entry.path(), &destination)?;
        } else {
            std::fs::copy(entry.path(), destination)?;
        }
    }
    Ok(())
}

/// Tarballs may wrap the plugin in a top-level folder (npm pack's package/).
fn find_plugin_root(dir: &Path) -> CoreResult<PathBuf> {
    if dir.join(MANIFEST_FILE).exists() {
        return Ok(dir.to_path_buf());
    }
    let entries = std::fs::read_dir(dir).map_err(|e| plugin_fail(ErrorCode::PluginManifestMissing, &dir.to_string_lossy(), e.to_string()))?;
    for entry in entries.flatten() {
        if entry.path().is_dir() && entry.path().join(MANIFEST_FILE).exists() {
            return Ok(entry.path());
        }
    }
    Err(plugin_fail(ErrorCode::PluginManifestMissing, &dir.to_string_lossy(), "插件包中缺少 agenthub-plugin.json"))
}
