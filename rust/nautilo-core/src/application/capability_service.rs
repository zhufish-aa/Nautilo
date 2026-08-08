//! Capability service + provider-native skill file sync —
//! port of application/capability-service.ts.

use std::path::{Path, PathBuf};

use std::sync::{Arc, Mutex};

use serde_json::{json, Map, Value};

use crate::database::{lock, Database, Repositories};
use crate::errors::{invalid, not_found, now_iso, CoreError, CoreResult, ErrorCode};


pub const SKILL_FILE_MARKER: &str = "agenthub:capability:";
pub const SKILL_FILE_NAMES: [&str; 4] = ["skill.md", "skills.md", "skill.markdown", "skills.markdown"];

pub fn slugify(name: &str) -> String {
    let mut slug = String::new();
    let mut last_dash = false;
    for ch in name.trim().to_lowercase().chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch);
            last_dash = false;
        } else if !last_dash && !slug.is_empty() {
            slug.push('-');
            last_dash = true;
        }
    }
    while slug.ends_with('-') {
        slug.pop();
    }
    if slug.is_empty() { "skill".to_string() } else { slug }
}

struct SkillTarget {
    provider_id: &'static str,
    file_path: PathBuf,
    skill_dir: Option<PathBuf>,
    frontmatter: bool,
}

fn skill_targets() -> Vec<SkillTarget> {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    let kimi_home = std::env::var("KIMI_CODE_HOME")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".kimi-code"));
    vec![
        SkillTarget {
            provider_id: "claude-code",
            file_path: home.join(".claude").join("skills").join("{slug}").join("SKILL.md"),
            skill_dir: Some(home.join(".claude").join("skills").join("{slug}")),
            frontmatter: true,
        },
        SkillTarget {
            provider_id: "kimi-code",
            file_path: kimi_home.join("skills").join("{slug}").join("SKILL.md"),
            skill_dir: Some(kimi_home.join("skills").join("{slug}")),
            frontmatter: true,
        },
        SkillTarget {
            provider_id: "codex",
            file_path: home.join(".codex").join("prompts").join("{slug}.md"),
            skill_dir: None,
            frontmatter: false,
        },
        SkillTarget {
            provider_id: "codex",
            file_path: home.join(".codex").join("skills").join("{slug}").join("SKILL.md"),
            skill_dir: Some(home.join(".codex").join("skills").join("{slug}")),
            frontmatter: true,
        },
    ]
}

fn materialize(path: &Path, slug: &str) -> PathBuf {
    PathBuf::from(path.to_string_lossy().replace("{slug}", slug))
}

fn render_skill(capability: &Value, slug: &str, frontmatter: bool) -> String {
    let instructions = capability
        .get("skill")
        .and_then(|s| s.get("instructions"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let id = capability.get("id").and_then(Value::as_str).unwrap_or("");
    if frontmatter {
        let description = capability
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or("")
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        let description = if description.is_empty() { slug.to_string() } else { description };
        format!("---\nname: {slug}\ndescription: {description}\n---\n\n{instructions}\n\n<!-- {SKILL_FILE_MARKER}{id} -->\n")
    } else {
        format!("{instructions}\n\n<!-- {SKILL_FILE_MARKER}{id} -->\n")
    }
}

/// Reconciles the on-disk skill files for one capability across all providers.
fn sync_skill_files(capability: &Value) {
    let name = capability.get("name").and_then(Value::as_str).unwrap_or("");
    let slug = slugify(name);
    let kind = capability.get("kind").and_then(Value::as_str).unwrap_or("");
    let enabled = capability.get("enabled").and_then(Value::as_bool).unwrap_or(false);
    let has_instructions = capability
        .get("skill")
        .and_then(|s| s.get("instructions"))
        .and_then(Value::as_str)
        .is_some_and(|i| !i.trim().is_empty());
    let provider_ids: Vec<&str> = capability
        .get("providerIds")
        .and_then(Value::as_array)
        .map(|ids| ids.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    for target in skill_targets() {
        let should_install = kind == "skill" && enabled && has_instructions && provider_ids.contains(&target.provider_id);
        if should_install {
            install_skill(&target, capability, &slug);
        } else {
            remove_skill(&target, capability, &slug);
        }
    }
}

fn remove_all_skill_files(capability: &Value) {
    let slug = slugify(capability.get("name").and_then(Value::as_str).unwrap_or(""));
    for target in skill_targets() {
        remove_skill(&target, capability, &slug);
    }
}

fn install_skill(target: &SkillTarget, capability: &Value, slug: &str) {
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let file_path = materialize(&target.file_path, slug);
        if file_path.exists() {
            if let Ok(existing) = std::fs::read_to_string(&file_path) {
                // Never overwrite user-owned skills.
                if !existing.contains(SKILL_FILE_MARKER) {
                    return;
                }
            }
        }
        if let Some(parent) = file_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(&file_path, render_skill(capability, slug, target.frontmatter));
        if let Some(skill_dir) = &target.skill_dir {
            copy_skill_resources(capability, &materialize(skill_dir, slug));
        }
    }));
    if result.is_err() {
        eprintln!("[nautilo-core] failed to sync skill file for {}", target.provider_id);
    }
}

fn copy_skill_resources(capability: &Value, target_dir: &Path) {
    let Some(source_dir) = capability
        .get("skill")
        .and_then(|s| s.get("resourceDir"))
        .and_then(Value::as_str)
        .map(PathBuf::from)
    else {
        return;
    };
    if source_dir == target_dir || !source_dir.is_dir() {
        return;
    }
    let Ok(entries) = std::fs::read_dir(&source_dir) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_lowercase();
        if entry.path().is_file() && SKILL_FILE_NAMES.contains(&name.as_str()) {
            continue;
        }
        let _ = copy_recursive(&entry.path(), &target_dir.join(entry.file_name()));
    }
}

fn copy_recursive(source: &Path, target: &Path) -> std::io::Result<()> {
    if source.is_dir() {
        std::fs::create_dir_all(target)?;
        for entry in std::fs::read_dir(source)? {
            let entry = entry?;
            copy_recursive(&entry.path(), &target.join(entry.file_name()))?;
        }
    } else {
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::copy(source, target)?;
    }
    Ok(())
}

fn remove_skill(target: &SkillTarget, capability: &Value, slug: &str) {
    let file_path = materialize(&target.file_path, slug);
    if !file_path.exists() {
        return;
    }
    let id = capability.get("id").and_then(Value::as_str).unwrap_or("");
    if let Ok(existing) = std::fs::read_to_string(&file_path) {
        // Only remove files Nautilo wrote for this exact capability.
        if existing.contains(&format!("{SKILL_FILE_MARKER}{id}")) {
            let _ = std::fs::remove_file(&file_path);
        }
    }
}

#[derive(Clone)]
pub struct CapabilityService {
    db: Arc<Mutex<Database>>,
}

impl CapabilityService {
    pub fn new(db: Arc<Mutex<Database>>) -> Self {
        Self { db }
    }

    pub fn list(&self) -> CoreResult<Vec<Value>> {
        Repositories::new(&lock(&self.db).raw).capabilities().list_default()
    }

    pub fn upsert(&self, input: &Value) -> CoreResult<Value> {
        validate_capability(input)?;
        let now = now_iso();
        let existing = Repositories::new(&lock(&self.db).raw).capabilities().get(input.get("id").and_then(Value::as_str).unwrap_or(""))?;
        let mut capability = input.clone();
        let object = capability.as_object_mut().unwrap();
        object.insert("name".to_string(), json!(input.get("name").and_then(Value::as_str).unwrap_or("").trim()));
        object.insert("description".to_string(), json!(input.get("description").and_then(Value::as_str).unwrap_or("").trim()));
        let tags: Vec<Value> = input
            .get("tags")
            .and_then(Value::as_array)
            .map(|tags| tags.iter().filter_map(Value::as_str).map(str::trim).filter(|t| !t.is_empty()).map(|t| json!(t)).collect())
            .unwrap_or_default();
        object.insert("tags".to_string(), Value::Array(tags));
        let mut seen = std::collections::HashSet::new();
        let provider_ids: Vec<Value> = input
            .get("providerIds")
            .and_then(Value::as_array)
            .map(|ids| ids.iter().filter(|id| id.as_str().is_some_and(|s| seen.insert(s.to_string()))).cloned().collect())
            .unwrap_or_default();
        object.insert("providerIds".to_string(), Value::Array(provider_ids));
        let created_at = existing
            .as_ref()
            .and_then(|e| e.get("createdAt"))
            .and_then(Value::as_str)
            .or_else(|| input.get("createdAt").and_then(Value::as_str))
            .unwrap_or(&now)
            .to_string();
        object.insert("createdAt".to_string(), json!(created_at));
        object.insert("updatedAt".to_string(), json!(now));
        Repositories::new(&lock(&self.db).raw).capabilities().save(&capability, &now)?;
        sync_skill_files(&capability);
        Ok(capability)
    }

    pub fn remove(&self, capability_id: &str) -> CoreResult<Value> {
        let existing = Repositories::new(&lock(&self.db).raw).capabilities().get(capability_id)?;
        if let Some(existing) = existing {
            remove_all_skill_files(&existing);
        }
        Repositories::new(&lock(&self.db).raw).capabilities().remove(capability_id)?;
        Ok(json!({ "removed": true }))
    }
}

fn validate_capability(capability: &Value) -> CoreResult<()> {
    if capability.get("name").and_then(Value::as_str).unwrap_or("").trim().is_empty() {
        return Err(invalid("name", "Capability name cannot be empty."));
    }
    match capability.get("kind").and_then(Value::as_str) {
        Some("mcp") => {
            let mcp = capability.get("mcp");
            let Some(mcp) = mcp else {
                return Err(invalid("mcp", "MCP capability requires a server config."));
            };
            match mcp.get("transport").and_then(Value::as_str) {
                Some("stdio") if mcp.get("command").and_then(Value::as_str).unwrap_or("").trim().is_empty() => {
                    return Err(invalid("mcp.command", "STDIO MCP server requires a launch command."));
                }
                Some("http") if mcp.get("url").and_then(Value::as_str).unwrap_or("").trim().is_empty() => {
                    return Err(invalid("mcp.url", "HTTP MCP server requires a URL."));
                }
                _ => {}
            }
        }
        Some("skill") => {
            let has_instructions = capability
                .get("skill")
                .and_then(|s| s.get("instructions"))
                .and_then(Value::as_str)
                .is_some_and(|i| !i.trim().is_empty());
            if !has_instructions {
                return Err(invalid("skill.instructions", "Skill instructions cannot be empty."));
            }
        }
        _ => {}
    }
    Ok(())
}
