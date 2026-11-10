//! Plugin service — port of runtime/plugins/plugin-service.ts.
//! Loads native provider plugins from <dataDir>/plugins/<id>/ and registers
//! their adapters. One broken plugin never blocks the daemon.

use std::path::{Path, PathBuf};
use std::io::Write;
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
    clients: Mutex<std::collections::HashMap<String, Arc<PluginClient>>>,
    bundled_managers: Mutex<std::collections::HashMap<String, Arc<PluginClient>>>,
}

impl PluginService {
    pub fn new(data_dir: &Path, registry: AdapterRegistry) -> Self {
        Self {
            plugins_dir: data_dir.join("plugins"),
            registry,
            records: Mutex::new(Map::new()),
            loaded: Mutex::new(std::collections::HashSet::new()),
            overridden: Mutex::new(Map::new()),
            clients: Mutex::new(Default::default()),
            bundled_managers: Mutex::new(Default::default()),
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
        self.load_bundled_managers().await;
    }

    // A companion contributes settings without replacing the harness's chat adapter.
    async fn load_bundled_managers(&self) {
        let Ok(exe) = std::env::current_exe() else { return };
        let Some(parent) = exe.parent() else { return };
        let bundle = if parent.file_name().is_some_and(|name| name == "core-daemon") {
            parent.parent().unwrap_or(parent)
        } else { parent };
        let root = bundle.join("plugins");
        let Ok(entries) = std::fs::read_dir(&root) else { return };
        for entry in entries.flatten() {
            let dir = entry.path();
            let Ok(manifest) = self.read_manifest(&dir) else { continue };
            let Some(target) = manifest.pointer("/descriptor/pluginManagerFor").and_then(Value::as_str) else { continue };
            let id = format!("{target}-plugins");
            if manifest["id"] != id || entry.file_name().to_str() != Some(id.as_str())
                || validate_manifest(&manifest, &dir.to_string_lossy()).is_err()
                || validate_plugin_target(&root, &dir).is_err() { continue; }
            let executable = resolve_executable(&dir, manifest["main"].as_str().unwrap_or(""));
            if let Ok(client) = launch_plugin(&id, &executable, &dir).await {
                if client.provider_id() == id && client.descriptor()["pluginManagerFor"] == target {
                    self.bundled_managers.lock().unwrap().insert(target.to_owned(), Arc::new(client));
                } else { client.dispose().await; }
            }
        }
    }

    pub fn manager_for(&self, target: &str) -> Option<Arc<PluginClient>> {
        let id = format!("{target}-plugins");
        let clients = self.clients.lock().unwrap();
        if let Some(client) = clients.get(target).filter(|c| c.descriptor()["harnessPlugins"] == true) {
            return Some(client.clone());
        }
        if let Some(client) = clients.get(&id).filter(|c| c.descriptor()["pluginManagerFor"] == target) {
            return Some(client.clone());
        }
        if self.records.lock().unwrap().contains_key(&id) { return None; }
        self.bundled_managers.lock().unwrap().get(target).cloned()
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
        // Stop a running instance of the same plugin first: overwriting its
        // exe while the process is alive fails with os error 32 on Windows.
        if self.loaded.lock().unwrap().contains(&id) {
            self.unload(&id).await;
        }
        remove_dir_all_retry(&target).map_err(|e| {
            plugin_fail(ErrorCode::PluginRemoveFailed, &target.to_string_lossy(), format!("清理旧插件目录失败：{e}"))
        })?;
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
        let platform = format!("{}-{}", match std::env::consts::OS { "windows" => "win32", "macos" => "darwin", other => other }, match std::env::consts::ARCH { "x86_64" => "x64", "aarch64" => "arm64", other => other });
        let plugins: Vec<Value> = data
            .get("plugins")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|entry| registry_entry_for_platform(entry, &platform))
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
        validate_plugin_id(plugin_id)?;
        let dir = self.plugins_dir.join(plugin_id);
        validate_plugin_target(&self.plugins_dir, &dir)?;
        self.unload(plugin_id).await;
        // Unload awaits process shutdown: recheck before touching disk.
        validate_plugin_target(&self.plugins_dir, &dir)?;
        // Do not swallow removal failures: the record is gone but the files
        // remain (and resurrect on restart), which makes uninstall look like
        // it "did nothing".
        remove_dir_all_retry(&dir).map_err(|e| {
            plugin_fail(ErrorCode::PluginRemoveFailed, &dir.to_string_lossy(), format!("删除插件目录失败：{e}"))
        })?;
        self.records.lock().unwrap().remove(plugin_id);
        Ok(json!({ "removed": true }))
    }

    pub async fn set_enabled(&self, plugin_id: &str, enabled: bool) -> CoreResult<Value> {
        validate_plugin_id(plugin_id)?;
        let dir = self.plugins_dir.join(plugin_id);
        validate_plugin_target(&self.plugins_dir, &dir)?;
        let manifest = self.read_manifest(&dir).ok();
        let Some(manifest) = manifest else {
            let mut details = Map::new();
            details.insert("resource".to_string(), json!("plugin"));
            details.insert("id".to_string(), json!(plugin_id));
            return Err(CoreError::details(ErrorCode::IpcNotFound, details));
        };
        validate_manifest(&manifest, &dir.to_string_lossy())?;
        if manifest.get("id").and_then(Value::as_str) != Some(plugin_id) {
            return Err(plugin_fail(ErrorCode::PluginInvalid, &dir.to_string_lossy(), "Plugin id does not match its directory"));
        }
        validate_plugin_target(&self.plugins_dir, &dir)?;
        if enabled {
            match std::fs::remove_file(dir.join(DISABLED_MARKER)) {
                Ok(()) => {},
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
                Err(error) => return Err(plugin_fail(ErrorCode::PluginInvalid, &dir.to_string_lossy(), error.to_string())),
            }
            return self.load_one(plugin_id).await;
        }
        // Marker existence is sufficient. create_new never truncates an
        // existing file or follows a .disabled link outside this directory.
        match std::fs::OpenOptions::new().write(true).create_new(true).open(dir.join(DISABLED_MARKER)) {
            Ok(mut file) => file.write_all(crate::errors::now_iso().as_bytes())
                .map_err(|error| plugin_fail(ErrorCode::PluginInvalid, &dir.to_string_lossy(), error.to_string()))?,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {},
            Err(error) => return Err(plugin_fail(ErrorCode::PluginInvalid, &dir.to_string_lossy(), error.to_string())),
        }
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
        let bundled = std::mem::take(&mut *self.bundled_managers.lock().unwrap());
        for (_, manager) in bundled { manager.dispose().await; }
    }

    async fn unload(&self, plugin_id: &str) {
        if !self.loaded.lock().unwrap().remove(plugin_id) {
            return;
        }
        // The plugin process exits on dispose; the client adapter is removed
        // from the registry either way.
        let client = self.clients.lock().unwrap().remove(plugin_id);
        if let Some(manager) = client.filter(|c| c.descriptor()["pluginManagerFor"].is_string()) {
            manager.dispose().await;
            return;
        }
        // Terminate the plugin process BEFORE anyone touches its files — a
        // live process keeps the exe locked on Windows, so uninstall and
        // reinstall would fail with os error 32.
        if let Some(adapter) = self.registry.find(plugin_id) {
            adapter.dispose().await;
        }
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
        validate_plugin_id(plugin_id)?;
        let dir = self.plugins_dir.join(plugin_id);
        validate_plugin_target(&self.plugins_dir, &dir)?;
        let manifest = self.read_manifest(&dir)?;
        if let Err(error) = validate_manifest(&manifest, &dir.to_string_lossy()) {
            let record = record(plugin_id, true, "error", Some(error.to_string()), &dir, None);
            self.records.lock().unwrap().insert(plugin_id.to_string(), record.clone());
            return Ok(record);
        }
        if manifest.get("id").and_then(Value::as_str) != Some(plugin_id) {
            return Err(plugin_fail(ErrorCode::PluginInvalid, &dir.to_string_lossy(), "Plugin id does not match its directory"));
        }
        self.unload(plugin_id).await;
        validate_plugin_target(&self.plugins_dir, &dir)?;
        let mut runtime_dir=dir.clone();let mut runtime_manifest=manifest.clone();
        if cfg!(debug_assertions) {
            if let Some(root)=std::env::var_os("AGENTHUB_DEV_PLUGIN_DIR").map(PathBuf::from) {
                let candidate=root.join(plugin_id);
                if candidate.is_dir() {
                    validate_plugin_target(&root,&candidate)?;
                    let overlay=self.read_manifest(&candidate)?;validate_manifest(&overlay,&candidate.to_string_lossy())?;
                    if overlay["id"]!=plugin_id {return Err(plugin_fail(ErrorCode::PluginInvalid,&candidate.to_string_lossy(),"Development plugin id does not match its directory"));}
                    runtime_dir=candidate;runtime_manifest=overlay;
                }
            }
        }
        let main = runtime_manifest.get("main").and_then(Value::as_str).unwrap_or("");
        let executable = resolve_executable(&runtime_dir, main);
        match launch_plugin(plugin_id, &executable, &runtime_dir).await {
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
                let client = Arc::new(client);
                if let Some(target) = client.descriptor()["pluginManagerFor"].as_str() {
                    if plugin_id != format!("{target}-plugins") {
                        client.dispose().await;
                        return Err(plugin_fail(ErrorCode::PluginInvalid, &dir.to_string_lossy(), "Invalid companion plugin ID"));
                    }
                } else {
                    if self.registry.find(plugin_id).is_some() {
                        self.overridden.lock().unwrap().insert(plugin_id.to_string(), json!(true));
                    }
                    self.registry.register(client.clone());
                }
                self.clients.lock().unwrap().insert(plugin_id.to_string(), client);
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

/// Deletes a directory, retrying briefly. Windows releases file handles a
/// moment after the owning process exits, so a remove right after unload can
/// still hit a transient lock (os error 32). Read-only files also fail with
/// access denied (os error 5), so the attribute is cleared first.
fn remove_dir_all_retry(dir: &Path) -> std::io::Result<()> {
    clear_readonly_recursive(dir);
    let mut last_error: Option<std::io::Error> = None;
    for _ in 0..5 {
        match std::fs::remove_dir_all(dir) {
            Ok(()) => return Ok(()),
            Err(error) => {
                if !dir.exists() {
                    return Ok(()); // already gone (partially removed)
                }
                last_error = Some(error);
                std::thread::sleep(std::time::Duration::from_millis(300));
            }
        }
    }
    Err(last_error.unwrap_or_else(|| std::io::Error::new(std::io::ErrorKind::Other, "remove_dir_all failed")))
}

fn validate_plugin_id(plugin_id: &str) -> CoreResult<()> {
    if plugin_id.is_empty() || !plugin_id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        || !plugin_id.as_bytes()[0].is_ascii_alphanumeric()
    {
        return Err(plugin_fail(ErrorCode::PluginInvalid, plugin_id, "Invalid plugin id"));
    }
    Ok(())
}

fn validate_plugin_target(root: &Path, target: &Path) -> CoreResult<()> {
    let fail = || plugin_fail(ErrorCode::PluginInvalid, &target.to_string_lossy(), "Plugin directory escapes plugins root or is a symlink");
    let metadata = match std::fs::symlink_metadata(target) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err(fail()),
    };
    if is_link_metadata(&metadata) || !metadata.is_dir() { return Err(fail()); }
    let root = std::fs::canonicalize(root).map_err(|_| fail())?;
    let actual = std::fs::canonicalize(target).map_err(|_| fail())?;
    if actual.parent() != Some(root.as_path()) { return Err(fail()); }
    Ok(())
}

fn is_link_metadata(metadata: &std::fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() { return true; }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        // Includes directory junctions and other reparse points.
        if metadata.file_attributes() & 0x400 != 0 { return true; }
    }
    false
}

/// Clears the read-only attribute on every file below `dir`. Windows refuses
/// to delete read-only files (os error 5), and plugin dirs copied from source
/// trees or archives can carry the attribute.
fn clear_readonly_recursive(dir: &Path) {
    // Unix can unlink read-only files without chmod. Avoid broadening their
    // permission bits there, and never traverse links/junctions on Windows.
    if !cfg!(windows) { return; }
    let Ok(metadata) = std::fs::symlink_metadata(dir) else { return; };
    if is_link_metadata(&metadata) || !metadata.is_dir() { return; }
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(metadata) = std::fs::symlink_metadata(&path) else { continue; };
            if is_link_metadata(&metadata) { continue; }
            if metadata.is_dir() {
                clear_readonly_recursive(&path);
            } else {
                if metadata.permissions().readonly() {
                    let mut permissions = metadata.permissions();
                    permissions.set_readonly(false);
                    let _ = std::fs::set_permissions(&path, permissions);
                }
            }
        }
    }
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

fn registry_entry_for_platform(mut entry: Value, platform: &str) -> Option<Value> {
    entry.get("id")?.as_str()?;
    if entry.get("platforms").is_some() {
        let package = entry.get("platforms")?.get(platform)?.clone();
        package.get("tarball")?.as_str()?;
        package.get("sha256")?.as_str()?;
        entry["tarball"] = package["tarball"].clone();
        entry["sha256"] = package["sha256"].clone();
    }
    entry.get("tarball")?.as_str()?;
    Some(entry)
}

#[cfg(test)]
mod boundary_tests {
    use super::*;

    #[test]
    fn plugin_registry_selects_native_platform_without_windows_fallback() {
        let entry = json!({"id":"pi", "tarball":"windows.tgz", "sha256":"windows", "platforms":{
            "win32-x64":{"tarball":"windows.tgz","sha256":"windows"},
            "darwin-arm64":{"tarball":"mac-arm.tgz","sha256":"mac"},
            "linux-x64":{"tarball":"linux.tgz","sha256":"linux"}
        }});
        let mac = registry_entry_for_platform(entry.clone(), "darwin-arm64").unwrap();
        assert_eq!(mac["tarball"], "mac-arm.tgz");
        assert_eq!(mac["sha256"], "mac");
        assert!(registry_entry_for_platform(entry, "linux-arm64").is_none());
        assert!(registry_entry_for_platform(json!({"id":"legacy","tarball":"legacy.tgz"}), "linux-x64").is_some());
    }

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("nautilo-plugin-boundary-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(path.join("data/plugins")).unwrap();
            std::fs::create_dir_all(path.join("outside")).unwrap();
            std::fs::write(path.join("outside/keep.txt"), b"keep").unwrap();
            Self(path)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); }
    }

    #[tokio::test]
    async fn uninstall_rejects_unsafe_ids_and_preserves_siblings() {
        let fixture = Fixture::new();
        let service = PluginService::new(&fixture.0.join("data"), AdapterRegistry::default());
        for id in ["", ".", "..", "../../outside", "..\\..\\outside", "/tmp/outside", "C:\\outside", "valid/../outside"] {
            assert!(service.uninstall(id).await.is_err(), "accepted {id}");
            assert!(fixture.0.join("outside/keep.txt").exists());
        }
        let target = fixture.0.join("data/plugins/valid-provider-2");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join("plugin.txt"), b"fixture").unwrap();
        assert!(service.uninstall("valid-provider-2").await.is_ok());
        assert!(!target.exists());
        assert!(service.uninstall("valid-provider-2").await.is_ok());
        assert!(fixture.0.join("outside/keep.txt").exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn uninstall_does_not_follow_root_or_nested_symlinks() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        let service = PluginService::new(&fixture.0.join("data"), AdapterRegistry::default());
        let outside = fixture.0.join("outside");
        symlink(&outside, fixture.0.join("data/plugins/linked")).unwrap();
        assert!(service.uninstall("linked").await.is_err());
        let target = fixture.0.join("data/plugins/valid");
        std::fs::create_dir_all(&target).unwrap();
        symlink(&outside, target.join("nested")).unwrap();
        assert!(service.uninstall("valid").await.is_ok());
        assert!(outside.join("keep.txt").exists());
    }

    #[tokio::test]
    async fn set_enabled_rejects_invalid_ids_and_preserves_legal_disable() {
        let fixture = Fixture::new();
        let service = PluginService::new(&fixture.0.join("data"), AdapterRegistry::default());
        for enabled in [true, false] {
            for id in ["", ".", "..", "../../outside", "..\\..\\outside", "/tmp/outside", "C:\\outside"] {
                assert!(service.set_enabled(id, enabled).await.is_err(), "accepted {id}");
            }
        }
        let target = fixture.0.join("data/plugins/valid");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join(MANIFEST_FILE), json!({
            "id": "valid", "apiVersion": 1, "main": "missing",
            "descriptor": { "providerId": "valid", "name": "Fixture", "vendor": "Tests", "capabilities": [] }
        }).to_string()).unwrap();
        assert!(service.set_enabled("valid", false).await.is_ok());
        assert!(target.join(DISABLED_MARKER).exists());
        assert!(service.set_enabled("valid", false).await.is_ok());
        assert!(fixture.0.join("outside/keep.txt").exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn set_enabled_never_follows_plugin_or_marker_links() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        let service = PluginService::new(&fixture.0.join("data"), AdapterRegistry::default());
        symlink(fixture.0.join("outside"), fixture.0.join("data/plugins/linked")).unwrap();
        for enabled in [true, false] { assert!(service.set_enabled("linked", enabled).await.is_err()); }
        let target = fixture.0.join("data/plugins/valid");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join(MANIFEST_FILE), json!({
            "id": "valid", "apiVersion": 1, "main": "missing",
            "descriptor": { "providerId": "valid", "name": "Fixture", "vendor": "Tests", "capabilities": [] }
        }).to_string()).unwrap();
        symlink(fixture.0.join("outside/keep.txt"), target.join(DISABLED_MARKER)).unwrap();
        assert!(service.set_enabled("valid", false).await.is_ok());
        assert_eq!(std::fs::read(fixture.0.join("outside/keep.txt")).unwrap(), b"keep");
        // Missing executable is recorded as a load error after removing only
        // the marker symlink; the external target remains untouched.
        assert!(service.set_enabled("valid", true).await.is_ok());
        assert_eq!(std::fs::read(fixture.0.join("outside/keep.txt")).unwrap(), b"keep");
        assert!(std::fs::symlink_metadata(target.join(DISABLED_MARKER)).is_err());
    }
}
