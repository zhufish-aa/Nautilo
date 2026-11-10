//! Preserve native tool configuration when a CLI needs a separate model profile.
//! Authentication and conversation stores are deliberately not copied.
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use anyhow::{Context, Result};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

static SYNC_LOCK: Mutex<()> = Mutex::new(());

pub fn home(env: &HashMap<String, String>) -> PathBuf {
    let keys = if cfg!(windows) { ["USERPROFILE", "HOME"] } else { ["HOME", "USERPROFILE"] };
    keys.iter().find_map(|key| env.get(*key).filter(|v| !v.is_empty()).cloned())
        .or_else(|| keys.iter().find_map(|key| std::env::var(key).ok().filter(|v| !v.is_empty())))
        .map(PathBuf::from).unwrap_or_else(std::env::temp_dir)
}

pub fn merge(target: &mut Value, overlay: Value) {
    match (target, overlay) {
        (Value::Object(target), Value::Object(overlay)) => {
            for (key, value) in overlay { merge(target.entry(key).or_insert(Value::Null), value); }
        }
        (target, overlay) => *target = overlay,
    }
}

pub fn read_json(path: &Path) -> Result<Value> {
    match std::fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text).with_context(|| format!("Invalid native JSON: {}", path.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
        Err(error) => Err(error).with_context(|| format!("Unable to read native configuration: {}", path.display())),
    }
}

/// Mirror only named configuration/resource entries. Track our own files so
/// removing a native skill also removes its inherited copy, without deleting
/// a file subsequently changed by the CLI. Never modify the source profile.
pub fn inherit_resources(source: &Path, destination: &Path, names: &[&str]) -> Result<()> {
    if source == destination { return Ok(()); }
    let _lock = SYNC_LOCK.lock().map_err(|_| anyhow::anyhow!("Native resource sync lock failed"))?;
    let manifest = destination.join(".nautilo-inherited-resources.json");
    let previous: BTreeMap<String, String> = match std::fs::read(&manifest) {
        Ok(bytes) => serde_json::from_slice(&bytes)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => BTreeMap::new(),
        Err(error) => return Err(error.into()),
    };
    let mut files = BTreeMap::new();
    for name in names {
        let path = source.join(name);
        if path.try_exists()? { collect_files(&path, Path::new(name), &mut HashSet::new(), &mut files)?; }
    }
    sync_files(destination, &manifest, previous, files)
}

fn sync_files(destination: &Path, manifest: &Path, previous: BTreeMap<String, String>, files: BTreeMap<String, Vec<u8>>) -> Result<()> {
    std::fs::create_dir_all(destination)?;
    let mut current = BTreeMap::new();
    for (relative, bytes) in files {
        let hash = format!("{:x}", Sha256::digest(&bytes));
        let target = destination.join(&relative);
        if std::fs::read(&target).ok().as_deref() != Some(bytes.as_slice()) {
            if let Some(parent) = target.parent() { std::fs::create_dir_all(parent)?; }
            std::fs::write(&target, bytes)?;
        }
        current.insert(relative, hash);
    }
    for (relative, hash) in previous {
        let path = Path::new(&relative);
        // The manifest is persisted data, never trust it as an arbitrary path.
        if path.components().any(|c| !matches!(c, std::path::Component::Normal(_))) { continue; }
        if !current.contains_key(&relative) {
            let target = destination.join(path);
            if std::fs::read(&target).ok().is_some_and(|bytes| format!("{:x}", Sha256::digest(bytes)) == hash) {
                std::fs::remove_file(target)?;
            }
        }
    }
    std::fs::write(manifest, serde_json::to_vec(&current)?)?;
    Ok(())
}

pub fn mcp_servers(servers: Option<&Value>) -> Value {
    let mut result = serde_json::Map::new();
    for server in servers.and_then(Value::as_array).into_iter().flatten() {
        let Some(name) = server["name"].as_str() else { continue };
        let mut entry = server.as_object().cloned().unwrap_or_default();
        entry.remove("name");
        if let Some(transport) = entry.remove("transport") { entry.insert("type".into(), transport); }
        result.insert(name.to_string(), Value::Object(entry));
    }
    Value::Object(result)
}

pub fn merge_mcp_file(path: &Path, servers: Option<&Value>) -> Result<()> {
    let additions = mcp_servers(servers);
    if additions.as_object().is_none_or(|v|v.is_empty()) { return Ok(()); }
    let mut config = read_json(path)?;
    anyhow::ensure!(config.is_object(), "Native MCP configuration must be an object: {}", path.display());
    if config.get("mcpServers").is_none() { config["mcpServers"] = json!({}); }
    let native = config["mcpServers"].as_object_mut().ok_or_else(||anyhow::anyhow!("Native mcpServers must be an object"))?;
    for (name, overlay) in additions.as_object().unwrap() {
        let entry = native.entry(name.clone()).or_insert_with(||json!({}));
        // Keep native timeouts, OAuth, exposure, and other options, replacing
        // only transport fields explicitly owned by the selected connection.
        if let Some(object) = entry.as_object_mut() {
            for key in ["command", "args", "env", "cwd", "url", "headers", "type", "transport"] { object.remove(key); }
        }
        merge(entry, overlay.clone());
    }
    std::fs::write(path, serde_json::to_vec_pretty(&config)?)?;
    Ok(())
}

/// A supplemental native extension package; it adds resources without
/// replacing the CLI's normal discovery roots. Files are owned by this package.
pub fn runtime_package(request: &Value, provider: &str) -> Result<PathBuf> {
    let id = request["localSessionId"].as_str().unwrap_or("default");
    anyhow::ensure!(!id.is_empty() && id.chars().all(|c|c.is_ascii_alphanumeric() || c=='-' || c=='_'), "Invalid runtime resource identity");
    let root = std::env::temp_dir().join("nautilo-native-resources").join(provider).join(id);
    let mut files = BTreeMap::new();
    files.insert("package.json".into(), br#"{"type":"module","main":"index.mjs"}"#.to_vec());
    files.insert("index.mjs".into(), b"export default function() {}\n".to_vec());
    files.insert(".mcp.json".into(), serde_json::to_vec_pretty(&json!({"mcpServers":mcp_servers(request.get("mcpServers"))}))?);
    for skill in request["skills"].as_array().into_iter().flatten() {
        let id = skill["id"].as_str().or_else(||skill["name"].as_str()).unwrap_or("skill");
        let slug: String = id.to_lowercase().chars().map(|c|if c.is_ascii_alphanumeric() || c=='-' {c} else {'-'}).collect();
        let slug = format!("nautilo-{}", slug.trim_matches('-'));
        let relative = PathBuf::from("skills").join(&slug);
        if let Some(source) = skill["resourceDir"].as_str().map(PathBuf::from).filter(|p|p.is_dir()) {
            collect_files(&source, &relative, &mut HashSet::new(), &mut files)?;
        }
        let text = format!("---\nname: {slug}\ndescription: {}\n---\n\n{}\n", json!(skill["description"].as_str().unwrap_or("")), skill["instructions"].as_str().unwrap_or(""));
        files.insert(relative.join("SKILL.md").to_string_lossy().into_owned(), text.into_bytes());
    }
    let _lock = SYNC_LOCK.lock().map_err(|_|anyhow::anyhow!("Native resource sync lock failed"))?;
    let manifest = root.join(".nautilo-inherited-resources.json");
    let previous = if manifest.exists() {serde_json::from_slice(&std::fs::read(&manifest)?)?} else {BTreeMap::new()};
    sync_files(&root, &manifest, previous, files)?;
    Ok(root)
}

fn collect_files(path: &Path, relative: &Path, ancestors: &mut HashSet<PathBuf>, files: &mut BTreeMap<String, Vec<u8>>) -> Result<()> {
    let canonical = match path.canonicalize() {
        Ok(canonical) => canonical,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound && is_resource_link(path) => {
            eprintln!("Skipping broken native resource link: {}", path.display());
            return Ok(());
        }
        Err(error) => return Err(error).with_context(|| format!("Unable to resolve native resource: {}", path.display())),
    };
    anyhow::ensure!(ancestors.insert(canonical.clone()), "Native resource contains a directory cycle: {}", path.display());
    if path.is_dir() {
        for entry in std::fs::read_dir(path)? {
            let entry = entry?;
            collect_files(&entry.path(), &relative.join(entry.file_name()), ancestors, files)?;
        }
    } else {
        files.insert(relative.to_string_lossy().into_owned(), std::fs::read(path)?);
    }
    ancestors.remove(&canonical);
    Ok(())
}

fn is_resource_link(path: &Path) -> bool {
    let Ok(metadata) = std::fs::symlink_metadata(path) else { return false };
    #[cfg(windows)] {
        use std::os::windows::fs::MetadataExt;
        // Junctions are reparse points but are not reported as symbolic links.
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))] { metadata.file_type().is_symlink() }
}

pub fn kimi_config(native: &Path, selected: &str) -> Result<String> {
    let selected: toml::Table = toml::from_str(selected)?;
    let text = match std::fs::read_to_string(native.join("config.toml")) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(toml::to_string_pretty(&selected)?),
        Err(error) => return Err(error.into()),
    };
    let mut inherited: toml::Table = toml::from_str(&text)
        .with_context(|| format!("Invalid Kimi configuration: {}", native.join("config.toml").display()))?;
    // Bind inference to the selected API; retain hooks, MCP, tools, rules,
    // search services, approvals, and other native preferences.
    for key in ["providers", "models", "default_model"] { inherited.remove(key); }
    inherited.extend(selected);
    Ok(toml::to_string_pretty(&inherited)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(windows)]
    #[test]
    fn dangling_native_skill_junction_does_not_block_valid_skills() {
        use std::os::windows::process::CommandExt;
        let root = std::env::temp_dir().join(format!("nautilo-broken-junction-test-{}",std::process::id()));
        let source = root.join("native");
        let target = root.join("inherited");
        std::fs::create_dir_all(source.join("skills/valid")).unwrap();
        std::fs::write(source.join("skills/valid/SKILL.md"), "# Keep this skill").unwrap();
        std::fs::create_dir_all(root.join("missing")).unwrap();
        let result = std::process::Command::new("cmd.exe").args(["/d","/c","mklink","/J"])
            .arg(source.join("skills").join("broken")).arg(root.join("missing"))
            .creation_flags(0x08000000).output().unwrap();
        assert!(result.status.success(), "junction fixture failed: {} {}", String::from_utf8_lossy(&result.stdout), String::from_utf8_lossy(&result.stderr));
        std::fs::remove_dir(root.join("missing")).unwrap();
        inherit_resources(&source, &target, &["skills"]).unwrap();
        assert_eq!(std::fs::read_to_string(target.join("skills/valid/SKILL.md")).unwrap(), "# Keep this skill");
        assert!(!target.join("skills/broken").exists());
        assert!(std::fs::symlink_metadata(source.join("skills/broken")).is_ok());
        assert!(root.is_absolute() && root.starts_with(std::env::temp_dir()));
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn native_mcp_options_and_skill_assets_survive_inheritance_and_removal() {
        let root = std::env::temp_dir().join(format!("nautilo-resource-test-{}",std::process::id()));
        let source = root.join("native"); let target = root.join("runtime");
        std::fs::create_dir_all(source.join("skills/test/scripts")).unwrap();
        std::fs::write(source.join("skills/test/SKILL.md"), "# Native skill").unwrap();
        std::fs::write(source.join("skills/test/scripts/run.py"), "print(1)").unwrap();
        let native = json!({"custom":"keep","mcpServers":{"native":{"command":"native"},"same":{"command":"old","timeout":123,"oauth":{"clientId":"keep"}}}});
        std::fs::write(source.join("mcp.json"),native.to_string()).unwrap();
        inherit_resources(&source,&target,&["mcp.json","skills"]).unwrap();
        merge_mcp_file(&target.join("mcp.json"),Some(&json!([{ "name":"same","transport":"http","url":"https://example.test/mcp" },{"name":"added","command":"added","transport":"stdio"}]))).unwrap();
        let config=read_json(&target.join("mcp.json")).unwrap();
        assert_eq!(config["custom"],"keep"); assert_eq!(config["mcpServers"]["native"]["command"],"native");
        assert_eq!(config["mcpServers"]["same"]["timeout"],123); assert_eq!(config["mcpServers"]["same"]["oauth"]["clientId"],"keep");
        assert!(config["mcpServers"]["same"].get("command").is_none());
        assert_eq!(read_json(&source.join("mcp.json")).unwrap(),native);
        assert_eq!(std::fs::read_to_string(target.join("skills/test/scripts/run.py")).unwrap(),"print(1)");
        std::fs::remove_file(source.join("skills/test/scripts/run.py")).unwrap();
        inherit_resources(&source,&target,&["mcp.json","skills"]).unwrap();
        assert!(!target.join("skills/test/scripts/run.py").exists());
        assert_eq!(read_json(&target.join("mcp.json")).unwrap(),native);
        std::fs::write(source.join("config.toml"),"[hooks]\nenabled = true\n[providers.old]\napi_key = 'old-secret'\n").unwrap();
        let merged=kimi_config(&source,"default_model='selected'\n[providers.nautilo]\napi_key_env='NAUTILO_CONNECTION_API_KEY'\n").unwrap();
        assert!(merged.contains("[hooks]")); assert!(!merged.contains("old-secret"));
        std::fs::remove_dir_all(root).unwrap();
    }
}
