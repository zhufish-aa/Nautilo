//! Capability import service — port of application/capability-import/index.ts.

use std::path::Path;

use serde_json::{json, Map, Value};

use crate::application::capability_service::{slugify, CapabilityService, SKILL_FILE_NAMES};
use crate::errors::{invalid, CoreResult};
use crate::errors::now_iso;

pub mod discovery;
pub mod mcp_command;
pub mod mcp_json;
pub mod mcp_toml;
pub mod skill_markdown;
pub mod warnings_regex;

use discovery::discover_mcp_sources;
use mcp_command::parse_mcp_command_line;
use mcp_json::parse_mcp_config_json;
use mcp_toml::parse_mcp_config_toml;
use skill_markdown::parse_skill_markdown;

/// Guard rails so pointing the scanner at a huge tree cannot hang the daemon.
const MAX_SCAN_DEPTH: usize = 4;
const MAX_SCAN_FILES: usize = 300;
const MAX_SKILL_BYTES: u64 = 512 * 1024;
const SKIPPED_DIRS: [&str; 8] = ["node_modules", ".git", "dist", "out", "build", "target", ".next", "coverage"];
/// Hidden directories worth descending into anyway — this is where skills live.
const ALLOWED_HIDDEN_DIRS: [&str; 5] = [".claude", ".codex", ".agents", ".kimi-code", ".cursor"];

fn normalize_name(name: &str) -> String {
    name.trim().to_lowercase()
}

/// Appends ` (2)`, ` (3)`, … until `taken` stops rejecting the name.
fn unique_name(name: &str, taken: &dyn Fn(&str) -> bool) -> String {
    if !taken(name) {
        return name.to_string();
    }
    for suffix in 2..1000 {
        let candidate = format!("{name} ({suffix})");
        if !taken(&candidate) {
            return candidate;
        }
    }
    format!("{name} {}", chrono::Utc::now().timestamp_millis())
}

/// An unreadable directory (permissions) must not abort the whole scan.
fn read_entries(dir: &Path) -> Vec<std::fs::DirEntry> {
    std::fs::read_dir(dir).map(|entries| entries.flatten().collect()).unwrap_or_default()
}

/// Bounded probe for directories the depth limit refuses to descend into.
fn subtree_has_skill_file(dir: &Path, depth_left: usize) -> bool {
    for entry in read_entries(dir) {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_lowercase();
        if path.is_file() && SKILL_FILE_NAMES.contains(&name.as_str()) {
            return true;
        }
        if depth_left > 0 && path.is_dir() && !SKIPPED_DIRS.contains(&name.as_str()) && !name.starts_with('.') {
            if subtree_has_skill_file(&path, depth_left - 1) {
                return true;
            }
        }
    }
    false
}

/// The renderer has no home path, so it sends presets like `~/.claude/skills`.
fn expand_home(dir: &str) -> String {
    let home = dirs::home_dir().unwrap_or_else(|| std::path::PathBuf::from("."));
    if dir == "~" {
        return home.to_string_lossy().into_owned();
    }
    if let Some(rest) = dir.strip_prefix("~/").or_else(|| dir.strip_prefix("~\\")) {
        return home.join(rest).to_string_lossy().into_owned();
    }
    dir.to_string()
}

pub struct CapabilityImportService {
    capabilities: CapabilityService,
}

impl CapabilityImportService {
    pub fn new(capabilities: CapabilityService) -> Self {
        Self { capabilities }
    }

    /// Parses pasted text into preview candidates; never persists anything.
    pub fn parse(&self, input: &Value) -> CoreResult<Value> {
        let text = input.get("text").and_then(Value::as_str).unwrap_or("");
        let origin = input.get("fileName").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty());
        let result = |servers: Vec<Value>, skills: Vec<Value>, errors: Vec<String>| {
            json!({ "mcpServers": servers, "skills": skills, "errors": errors })
        };
        match input.get("source").and_then(Value::as_str) {
            Some("mcpJson") => {
                let (servers, errors) = parse_mcp_config_json(text, origin);
                Ok(result(servers, vec![], errors))
            }
            Some("mcpToml") => {
                let (servers, errors) = parse_mcp_config_toml(text, origin);
                Ok(result(servers, vec![], errors))
            }
            Some("mcpCommand") => {
                let (servers, errors) = parse_mcp_command_line(text);
                Ok(result(servers, vec![], errors))
            }
            Some("skillMarkdown") => {
                let fallback = origin
                    .and_then(|name| Path::new(name).file_stem().map(|s| s.to_string_lossy().into_owned()))
                    .unwrap_or_else(|| "skill".to_string());
                let (skills, errors) = parse_skill_markdown(text, &fallback, origin);
                Ok(result(vec![], skills, errors))
            }
            other => Err(invalid("source", &format!("Unknown import source: {}", other.unwrap_or("")))),
        }
    }

    /// Lists MCP servers already configured in other tools on this machine.
    pub fn discover_mcp(&self, input: &Value) -> Value {
        json!({ "sources": discover_mcp_sources(input.get("projectRoot").and_then(Value::as_str)) })
    }

    /// Walks a directory for skill Markdown files and parses what it finds.
    pub fn scan_skills(&self, input: &Value) -> CoreResult<Value> {
        let requested = input.get("dir").and_then(Value::as_str).unwrap_or("").trim().to_string();
        if requested.is_empty() {
            return Err(invalid("dir", "Scan directory is required."));
        }
        let dir = expand_home(&requested);
        let mut skills: Vec<Value> = vec![];
        let mut errors: Vec<String> = vec![];
        let mut scanned_files = 0usize;
        let mut truncated = false;

        let root = Path::new(&dir);
        if !root.exists() {
            errors.push(format!("目录不存在：{dir}"));
            return Ok(scan_result(skills, errors, scanned_files, truncated));
        }
        if !root.is_dir() {
            errors.push(format!("不是目录：{dir}"));
            return Ok(scan_result(skills, errors, scanned_files, truncated));
        }

        let mut markdown: Vec<(String, String)> = vec![];
        walk(root, 0, &mut markdown, &mut truncated);

        // Prefer conventional file names; only sweep every .md when there are
        // none, so a docs folder does not flood the preview.
        let conventional: Vec<&(String, String)> = markdown
            .iter()
            .filter(|(_, name)| SKILL_FILE_NAMES.contains(&name.to_lowercase().as_str()))
            .collect();
        let selected: Vec<&(String, String)> = if conventional.is_empty() { markdown.iter().collect() } else { conventional };

        for (path, name) in selected {
            let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
            if size > MAX_SKILL_BYTES {
                truncated = true;
                continue;
            }
            match std::fs::read_to_string(path) {
                Ok(text) => {
                    let is_conventional = SKILL_FILE_NAMES.contains(&name.to_lowercase().as_str());
                    let fallback = if is_conventional {
                        // `<skill-name>/SKILL.md` — the directory carries the name.
                        Path::new(path)
                            .parent()
                            .and_then(|p| p.file_name())
                            .map(|s| s.to_string_lossy().into_owned())
                            .filter(|s| !s.is_empty())
                            .unwrap_or_else(|| {
                                Path::new(name).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "skill".to_string())
                            })
                    } else {
                        Path::new(name).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "skill".to_string())
                    };
                    let (mut parsed, parse_errors) = parse_skill_markdown(&text, &fallback, Some(path));
                    if is_conventional {
                        // A conventional skill file owns its directory; sibling
                        // files are resources the sync mirrors along.
                        let resource_dir = Path::new(path).parent().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
                        for skill in parsed.iter_mut() {
                            skill.as_object_mut().unwrap().insert("resourceDir".to_string(), json!(resource_dir));
                        }
                    }
                    skills.append(&mut parsed);
                    errors.extend(parse_errors.into_iter().map(|error| format!("{name}: {error}")));
                    scanned_files += 1;
                }
                Err(error) => errors.push(format!("{name}: {error}")),
            }
        }
        Ok(scan_result(skills, errors, scanned_files, truncated))
    }

    /// Bulk-saves candidates, resolving name clashes against existing
    /// capabilities and within the batch itself.
    pub fn import_many(&self, input: &Value) -> CoreResult<Value> {
        let policy = input.get("onConflict").and_then(Value::as_str).unwrap_or("skip");
        let existing = self.capabilities.list()?;
        let mut by_name: Map<String, Value> = Map::new();
        let mut taken_names: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut slug_owner: Map<String, Value> = Map::new();
        for item in &existing {
            let key = format!(
                "{}:{}",
                item.get("kind").and_then(Value::as_str).unwrap_or(""),
                normalize_name(item.get("name").and_then(Value::as_str).unwrap_or(""))
            );
            by_name.insert(key, item.clone());
            taken_names.insert(normalize_name(item.get("name").and_then(Value::as_str).unwrap_or("")));
            if item.get("kind").and_then(Value::as_str) == Some("skill") {
                slug_owner.insert(
                    slugify(item.get("name").and_then(Value::as_str).unwrap_or("")),
                    item.get("id").cloned().unwrap_or(Value::Null),
                );
            }
        }

        let items = input.get("items").and_then(Value::as_array).cloned().unwrap_or_default();
        let mut results: Vec<Value> = vec![];
        for item in items {
            let mut candidate = item.clone();
            let name_key = format!(
                "{}:{}",
                item.get("kind").and_then(Value::as_str).unwrap_or(""),
                normalize_name(item.get("name").and_then(Value::as_str).unwrap_or(""))
            );
            let matched = by_name.get(&name_key).cloned();

            if let Some(existing) = &matched {
                if policy == "skip" {
                    results.push(json!({
                        "name": item.get("name").cloned().unwrap_or(Value::Null),
                        "status": "skipped",
                        "capabilityId": existing.get("id").cloned().unwrap_or(Value::Null)
                    }));
                    continue;
                }
                if policy == "overwrite" {
                    let mut merged = candidate.as_object().cloned().unwrap_or_default();
                    merged.insert("id".to_string(), existing.get("id").cloned().unwrap_or(Value::Null));
                    if let Some(created) = existing.get("createdAt").cloned() {
                        merged.insert("createdAt".to_string(), created);
                    }
                    // Keep the provider selection the user already made when
                    // the import does not carry one of its own.
                    let has_providers = merged
                        .get("providerIds")
                        .and_then(Value::as_array)
                        .is_some_and(|ids| !ids.is_empty());
                    if !has_providers {
                        if let Some(ids) = existing.get("providerIds").cloned() {
                            merged.insert("providerIds".to_string(), ids);
                        }
                    }
                    candidate = Value::Object(merged);
                } else {
                    let taken = |value: &str| taken_names.contains(&normalize_name(value));
                    let new_name = unique_name(item.get("name").and_then(Value::as_str).unwrap_or(""), &taken);
                    candidate.as_object_mut().unwrap().insert("name".to_string(), json!(new_name));
                }
            } else if taken_names.contains(&normalize_name(item.get("name").and_then(Value::as_str).unwrap_or(""))) {
                // Same name already consumed earlier in this batch.
                let taken = |value: &str| taken_names.contains(&normalize_name(value));
                let new_name = unique_name(item.get("name").and_then(Value::as_str).unwrap_or(""), &taken);
                candidate.as_object_mut().unwrap().insert("name".to_string(), json!(new_name));
            }

            if candidate.get("kind").and_then(Value::as_str) == Some("skill") {
                // Two distinct names can share a slug, and SkillFileSync writes
                // by slug — the rename has to clear the slug as well.
                let candidate_id = candidate.get("id").and_then(Value::as_str).map(str::to_string);
                let slug_taken = |value: &str| {
                    slug_owner
                        .get(&slugify(value))
                        .and_then(Value::as_str)
                        .is_some_and(|owner| Some(owner) != candidate_id.as_deref())
                };
                let current_name = candidate.get("name").and_then(Value::as_str).unwrap_or("").to_string();
                if slug_taken(&current_name) {
                    let taken = |value: &str| taken_names.contains(&normalize_name(value)) || slug_taken(value);
                    let new_name = unique_name(&current_name, &taken);
                    candidate.as_object_mut().unwrap().insert("name".to_string(), json!(new_name));
                }
                slug_owner.insert(
                    slugify(candidate.get("name").and_then(Value::as_str).unwrap_or("")),
                    candidate.get("id").cloned().unwrap_or(Value::Null),
                );
            }

            match self.capabilities.upsert(&candidate) {
                Ok(saved) => {
                    taken_names.insert(normalize_name(saved.get("name").and_then(Value::as_str).unwrap_or("")));
                    by_name.insert(
                        format!(
                            "{}:{}",
                            saved.get("kind").and_then(Value::as_str).unwrap_or(""),
                            normalize_name(saved.get("name").and_then(Value::as_str).unwrap_or(""))
                        ),
                        saved.clone(),
                    );
                    results.push(json!({
                        "name": saved.get("name").cloned().unwrap_or(Value::Null),
                        "status": if matched.is_some() && policy == "overwrite" { "updated" } else { "created" },
                        "capabilityId": saved.get("id").cloned().unwrap_or(Value::Null)
                    }));
                }
                Err(error) => results.push(json!({
                    "name": item.get("name").cloned().unwrap_or(Value::Null),
                    "status": "failed",
                    "error": error.to_string()
                })),
            }
        }
        Ok(json!({ "results": results }))
    }
}

fn scan_result(skills: Vec<Value>, errors: Vec<String>, scanned_files: usize, truncated: bool) -> Value {
    json!({
        "mcpServers": [],
        "skills": skills,
        "errors": errors,
        "scannedFiles": scanned_files,
        "truncated": truncated
    })
}

fn walk(current: &Path, depth: usize, markdown: &mut Vec<(String, String)>, truncated: &mut bool) {
    if markdown.len() >= MAX_SCAN_FILES {
        *truncated = true;
        return;
    }
    for entry in read_entries(current) {
        if markdown.len() >= MAX_SCAN_FILES {
            *truncated = true;
            return;
        }
        let full = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if full.is_dir() {
            if SKIPPED_DIRS.contains(&name.as_str()) {
                continue;
            }
            if name.starts_with('.') && !ALLOWED_HIDDEN_DIRS.contains(&name.as_str()) {
                continue;
            }
            if depth + 1 > MAX_SCAN_DEPTH {
                // Flag it only when a skill file is actually left behind.
                if subtree_has_skill_file(&full, 2) {
                    *truncated = true;
                }
                continue;
            }
            walk(&full, depth + 1, markdown, truncated);
            continue;
        }
        if !full.is_file() {
            continue;
        }
        if !(name.to_lowercase().ends_with(".md") || name.to_lowercase().ends_with(".markdown")) {
            continue;
        }
        markdown.push((full.to_string_lossy().into_owned(), name));
    }
}
