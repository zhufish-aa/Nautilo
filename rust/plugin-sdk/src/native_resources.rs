//! Read-only collectors. Each provider supplies its own effective paths and settings.
use crate::native_config;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::{HashMap, HashSet}, path::{Path, PathBuf}};

pub struct Resources {
    pub home: PathBuf,
    pub cwd: PathBuf,
    pub env: HashMap<String, String>,
    items: Vec<Value>,
    names: HashSet<(String, String)>,
    visited: HashSet<PathBuf>,
    skill_bytes: usize,
}

pub fn is_native(id: &str) -> bool { id.starts_with("native:") }

impl Resources {
    pub fn new(instance: &Value, cwd: &str) -> Self {
        let env = instance["env"].as_object().into_iter().flatten()
            .filter_map(|(key, val)| val.as_str().map(|v| (key.clone(), v.to_owned()))).collect();
        Self { home: native_config::home(&env), cwd: PathBuf::from(cwd), env,
            items: Vec::new(), names: HashSet::new(), visited: HashSet::new(), skill_bytes: 0 }
    }

    pub fn env_value(&self, key: &str) -> Option<String> {
        self.env.get(key).cloned().or_else(|| std::env::var(key).ok()).filter(|v| !v.is_empty())
    }

    pub fn path(&self, key: &str) -> Option<PathBuf> {
        self.env_value(key).map(|v| self.cwd.join(v))
    }

    pub fn finish(self) -> Vec<Value> { self.items }

    pub fn set_enabled(&mut self, name: &str, enabled: bool) {
        if !enabled { self.names.insert(("mcp".into(), name.to_lowercase())); }
    }

    fn item(&mut self, kind: &str, name: &str, source: &Path, payload: Value, description: &str) {
        if name.is_empty() || name.len() > 200 || !self.names.insert((kind.into(), name.to_lowercase())) { return; }
        let id = format!("{:x}", Sha256::digest(format!("{}\0{name}", source.display())));
        let stamp = std::fs::metadata(source).and_then(|m| m.modified()).ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok()).map(|time| time.as_nanos().to_string()).unwrap_or_default();
        let mut item = json!({"id":format!("native:{kind}:{id}"),"kind":kind,"name":name,"description":description,
            "enabled":true,"origin":{"kind":"native"},"tags":[],"updatedAt":stamp,"createdAt":""});
        item[kind] = payload;
        self.items.push(item);
    }

    pub fn skills(&mut self, root: &Path, disabled: &[PathBuf]) {
        self.skill_tree(root, disabled, 0);
    }

    fn skill_tree(&mut self, root: &Path, disabled: &[PathBuf], depth: usize) {
        if depth > 5 || self.visited.len() >= 600 || self.skill_bytes >= 2 * 1024 * 1024 { return; }
        if root.is_file() {
            if root.file_name().is_none_or(|name| !name.eq_ignore_ascii_case("SKILL.md")) { return; }
            let Some(file) = root.canonicalize().ok() else { return; };
            if disabled.iter().any(|p| &file == p || file.starts_with(p)) || !self.visited.insert(file.clone()) { return; }
            let Some(text) = read(&file, 128 * 1024) else { return; };
            if text.contains("<!-- agenthub:capability:") || text.contains("<!-- agenthub:runtime-skill:") { return; }
            let (metadata, body) = text.strip_prefix("---").and_then(|rest| rest.split_once("\n---")).unwrap_or(("", &text));
            let field = |key: &str| metadata.lines().find_map(|line| {
                let (k, v) = line.split_once(':')?;
                (k == key).then(|| v.trim().trim_matches(['\'', '"']))
            });
            if body.trim().is_empty() || field("enabled").is_some_and(|v| v.eq_ignore_ascii_case("false")) { return; }
            let name = field("name").or_else(||root.parent()?.file_name()?.to_str()).unwrap_or_default();
            self.skill_bytes += text.len();
            self.item("skill", name, &file, json!({"instructions":body.trim()}), field("description").unwrap_or_default());
            return;
        }
        let Ok(directory) = root.canonicalize() else { return; };
        if !self.visited.insert(directory.clone()) { return; }
        let Ok(children) = std::fs::read_dir(directory) else { return; };
        let mut children = children.take(300).flatten().map(|entry| entry.path()).collect::<Vec<_>>();
        children.sort();
        for child in children {
            if child.file_name().is_some_and(|name| name.to_string_lossy().starts_with('.')) { continue; }
            self.skill_tree(&child, disabled, depth + 1);
        }
    }

    pub fn mcp(&mut self, source: &Path, entries: &Value, disabled: &[&str]) {
        for (name, settings) in entries.as_object().into_iter().flatten().take(256) {
            if settings["enabled"] == false || settings["disabled"] == true || disabled.contains(&name.as_str()) {
                self.set_enabled(name, false);
                continue;
            }
            if !settings.is_object() { continue; }
            let mut config = settings.clone();
            if let Some(command) = settings["command"].as_array().filter(|args| !args.is_empty()) {
                config["command"] = command[0].clone();
                config["args"] = Value::Array(command[1..].to_vec());
            }
            config["transport"] = json!(if config["command"].is_string() { "stdio" } else if config["url"].is_string() { "http" } else { continue });
            if config["transport"] == "stdio" && !self.cwd.as_os_str().is_empty() {
                config["cwd"] = json!(config["cwd"].as_str().map(|cwd| self.cwd.join(cwd)).unwrap_or_else(||self.cwd.clone()));
            }
            for (from, to) in [("environment", "env"), ("http_headers", "headers"), ("env_vars", "envPassthrough"), ("env_http_headers", "envHeaders"), ("bearer_token_env_var", "bearerTokenEnvVar")] {
                if let Some(value) = settings.get(from) { config[to] = value.clone(); }
            }
            self.item("mcp", name, source, config, settings["description"].as_str().unwrap_or_default());
        }
    }
}

fn read(path: &Path, limit: u64) -> Option<String> {
    if !std::fs::metadata(path).ok().is_some_and(|meta| meta.is_file() && meta.len() <= limit) { return None; }
    std::fs::read_to_string(path).ok()
}

pub fn toml(path: &Path) -> Value {
    read(path, 2 * 1024 * 1024).and_then(|text| text.parse::<toml::Value>().ok())
        .and_then(|value| serde_json::to_value(value).ok()).unwrap_or(Value::Null)
}

pub fn json_file(path: &Path) -> Value {
    read(path, 2 * 1024 * 1024).map(|text| jsonc(&text)).unwrap_or(Value::Null)
}

pub fn yaml(path: &Path) -> Value {
    read(path, 2 * 1024 * 1024).and_then(|text| serde_yaml::from_str(&text).ok()).unwrap_or(Value::Null)
}

pub fn jsonc(text: &str) -> Value {
    let mut input = text.bytes().peekable();
    let mut output = Vec::with_capacity(text.len());
    let mut quoted = false;
    let mut comma = None;
    while let Some(byte) = input.next() {
        if quoted {
            output.push(byte);
            if byte == b'\\' { output.extend(input.next()); }
            else if byte == b'"' { quoted = false; }
            continue;
        }
        if byte == b'/' && input.peek() == Some(&b'/') {
            while input.next().is_some_and(|c|c != b'\n') {}
            continue;
        }
        if byte == b'/' && input.peek() == Some(&b'*') {
            input.next();
            while let Some(c) = input.next() { if c == b'*' && input.peek() == Some(&b'/') { input.next(); break; } }
            continue;
        }
        if let Some(index) = comma.filter(|_| matches!(byte,b'}'|b']')) { output.truncate(index); }
        if !byte.is_ascii_whitespace() { comma = (byte == b',').then_some(output.len()); }
        quoted = byte == b'"';
        output.push(byte);
    }
    serde_json::from_slice(&output).unwrap_or(Value::Null)
}

pub fn strings(value: &Value) -> Vec<&str> {
    value.as_array().into_iter().flatten().filter_map(Value::as_str).collect()
}
