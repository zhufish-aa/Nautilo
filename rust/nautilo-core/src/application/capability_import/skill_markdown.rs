//! Skill Markdown parsing — port of capability-import/skill-markdown.ts.

use serde_json::{json, Map, Value};

use crate::application::capability_service::SKILL_FILE_MARKER;

/// Core Daemon provider ids a skill's frontmatter may target.
const KNOWN_PROVIDERS: [&str; 5] = ["codex", "kimi-code", "claude-code", "opencode", "custom"];

const KNOWN_KEYS: [&str; 10] = [
    "name", "title", "description", "summary", "tags", "keywords", "source", "enabled", "providers", "provider",
];

fn marker_regex() -> &'static regex::Regex {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| {
        regex::Regex::new(&format!(r"(?m)^\s*<!--\s*{SKILL_FILE_MARKER}([^\s>]+)\s*-->\s*$")).unwrap()
    })
}

struct Frontmatter {
    fields: Map<String, Value>,
    unknown: Vec<String>,
}

fn strip_quotes(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.len() >= 2 {
        let first = trimmed.chars().next().unwrap();
        let last = trimmed.chars().last().unwrap();
        if (first == '"' && last == '"') || (first == '\'' && last == '\'') {
            return trimmed[1..trimmed.len() - 1].trim().to_string();
        }
    }
    trimmed.to_string()
}

/// Reads the small YAML subset skill files actually use.
fn parse_frontmatter(block: &str) -> Frontmatter {
    let mut fields = Map::new();
    let mut unknown = vec![];
    let key_value = regex::Regex::new(r"^([A-Za-z0-9_-]+)\s*:\s*(.*)$").unwrap();
    let list_item = regex::Regex::new(r"^\s*-\s+").unwrap();
    let lines: Vec<&str> = block.lines().collect();
    let mut index = 0;
    while index < lines.len() {
        let Some(captures) = key_value.captures(lines[index]) else {
            index += 1;
            continue;
        };
        let spelled = captures[1].to_string();
        let key = spelled.to_lowercase();
        let raw = captures[2].trim().to_string();

        if raw.is_empty() {
            // A block list: consume the following `- item` lines.
            let mut items = vec![];
            while index + 1 < lines.len() && list_item.is_match(lines[index + 1]) {
                index += 1;
                let item = strip_quotes(list_item.replace(lines[index], "").trim());
                if !item.is_empty() {
                    items.push(item);
                }
            }
            if !items.is_empty() {
                fields.insert(key.clone(), json!(items));
                if !KNOWN_KEYS.contains(&key.as_str()) {
                    unknown.push(spelled);
                }
                index += 1;
                continue;
            }
        }

        if raw.starts_with('[') && raw.ends_with(']') {
            let items: Vec<String> = raw[1..raw.len() - 1]
                .split(',')
                .map(|item| strip_quotes(item.trim()))
                .filter(|item| !item.is_empty())
                .collect();
            fields.insert(key.clone(), json!(items));
        } else {
            let value = strip_quotes(&raw);
            if !value.is_empty() {
                fields.insert(key.clone(), json!(value));
            }
        }
        if !KNOWN_KEYS.contains(&key.as_str()) {
            unknown.push(spelled);
        }
        index += 1;
    }
    Frontmatter { fields, unknown }
}

fn as_list(value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::Array(items)) => items.iter().filter_map(Value::as_str).map(str::to_string).filter(|s| !s.is_empty()).collect(),
        Some(Value::String(text)) => text.split(',').map(str::trim).filter(|s| !s.is_empty()).map(str::to_string).collect(),
        _ => vec![],
    }
}

fn as_text(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::Array(items)) => {
            let parts: Vec<&str> = items.iter().filter_map(Value::as_str).collect();
            if parts.is_empty() {
                None
            } else {
                Some(parts.join(", "))
            }
        }
        Some(Value::String(text)) if !text.is_empty() => Some(text.clone()),
        _ => None,
    }
}

/// First non-heading, non-empty paragraph — the usual "what is this" line.
fn first_paragraph(body: &str) -> String {
    for block in regex::Regex::new(r"\r?\n\s*\r?\n").unwrap().split(body) {
        let text = block.trim();
        if text.is_empty() || text.starts_with('#') || text.starts_with("<!--") {
            continue;
        }
        let collapsed: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
        return collapsed.chars().take(240).collect();
    }
    String::new()
}

fn first_heading(body: &str) -> Option<String> {
    regex::Regex::new(r"(?m)^#\s+(.+)$")
        .ok()?
        .captures(body)?
        .get(1)
        .map(|m| m.as_str().trim().to_string())
}

fn build_candidate(frontmatter: Option<Frontmatter>, body: &str, fallback_name: &str, origin: Option<&str>) -> Option<Value> {
    let mut warnings: Vec<String> = vec![];
    let mut instructions = body.trim().to_string();

    // Strip our own provenance marker so re-imported files stay clean.
    let mut existing_id = None;
    if let Some(captures) = marker_regex().captures(&instructions.clone()) {
        existing_id = captures.get(1).map(|m| m.as_str().to_string());
        instructions = marker_regex().replace(&instructions, "").trim().to_string();
    }
    if instructions.is_empty() {
        return None;
    }

    let fields = frontmatter.as_ref().map(|f| &f.fields);
    if let Some(frontmatter) = &frontmatter {
        if !frontmatter.unknown.is_empty() {
            warnings.push(format!("未识别的 frontmatter 字段：{}", frontmatter.unknown.join("、")));
        }
    }
    let field = |keys: &[&str]| -> Option<&Value> {
        keys.iter().find_map(|key| fields.and_then(|f| f.get(*key)))
    };

    let provider_ids: Vec<String> = as_list(field(&["providers", "provider"]))
        .into_iter()
        .filter(|id| {
            if KNOWN_PROVIDERS.contains(&id.as_str()) {
                true
            } else {
                warnings.push(format!("未知的 provider \"{id}\"，已忽略"));
                false
            }
        })
        .collect();

    let name = as_text(field(&["name", "title"]))
        .or_else(|| first_heading(&instructions))
        .unwrap_or_else(|| fallback_name.to_string());
    let description = as_text(field(&["description", "summary"])).unwrap_or_else(|| first_paragraph(&instructions));
    if description.is_empty() {
        warnings.push("未找到描述，建议补充".to_string());
    }

    let mut candidate = Map::new();
    candidate.insert("name".to_string(), json!(name.trim()));
    candidate.insert("description".to_string(), json!(description.trim()));
    candidate.insert("tags".to_string(), json!(as_list(field(&["tags", "keywords"]))));
    candidate.insert("instructions".to_string(), json!(instructions));
    if let Some(source) = as_text(field(&["source"])) {
        candidate.insert("source".to_string(), json!(source));
    }
    let enabled = as_text(field(&["enabled"])).map(|v| v.to_lowercase() != "false").unwrap_or(true);
    candidate.insert("enabled".to_string(), json!(enabled));
    candidate.insert("providerIds".to_string(), json!(provider_ids));
    candidate.insert("warnings".to_string(), json!(warnings));
    if let Some(origin) = origin {
        candidate.insert("origin".to_string(), json!(origin));
    }
    if let Some(existing_id) = existing_id {
        candidate.insert("existingId".to_string(), json!(existing_id));
    }
    Some(Value::Object(candidate))
}

struct FenceBlock {
    start: usize,
    body_start: usize,
    block: String,
}

/// Locates every line-start `---` fence pair in the document.
fn find_frontmatter_blocks(text: &str) -> Vec<FenceBlock> {
    let fence = regex::Regex::new(r"(?m)^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)").unwrap();
    fence
        .captures_iter(text)
        .map(|captures| {
            let whole = captures.get(0).unwrap();
            FenceBlock {
                start: whole.start(),
                body_start: whole.end(),
                block: captures.get(1).map(|m| m.as_str().to_string()).unwrap_or_default(),
            }
        })
        .collect()
}

/// Turns a skill Markdown file into one or more candidates. Splitting rules:
/// frontmatter fences > multiple H1 headings > the whole file.
pub fn parse_skill_markdown(text: &str, fallback_name: &str, origin: Option<&str>) -> (Vec<Value>, Vec<String>) {
    if text.trim().is_empty() {
        return (vec![], vec![]);
    }

    let blocks = find_frontmatter_blocks(text);
    let mut skills = vec![];

    if !blocks.is_empty() {
        // Content before the first fence is a preamble, not a skill.
        for (index, entry) in blocks.iter().enumerate() {
            let end = if index + 1 < blocks.len() { blocks[index + 1].start } else { text.len() };
            let body = &text[entry.body_start..end];
            let fallback = if blocks.len() > 1 { format!("{fallback_name}-{}", index + 1) } else { fallback_name.to_string() };
            if let Some(candidate) = build_candidate(Some(parse_frontmatter(&entry.block)), body, &fallback, origin) {
                skills.push(candidate);
            }
        }
        return if skills.is_empty() {
            (vec![], vec!["识别到 frontmatter，但没有正文内容".to_string()])
        } else {
            (skills, vec![])
        };
    }

    let heading_re = regex::Regex::new(r"(?m)^#\s+.+$").unwrap();
    let headings: Vec<(usize, usize)> = heading_re.find_iter(text).map(|m| (m.start(), m.end())).collect();
    if headings.len() >= 2 {
        for (index, (start, _)) in headings.iter().enumerate() {
            let end = if index + 1 < headings.len() { headings[index + 1].0 } else { text.len() };
            let fallback = format!("{fallback_name}-{}", index + 1);
            if let Some(candidate) = build_candidate(None, &text[*start..end], &fallback, origin) {
                skills.push(candidate);
            }
        }
        return (skills, vec![]);
    }

    match build_candidate(None, text, fallback_name, origin) {
        Some(single) => (vec![single], vec![]),
        None => (vec![], vec!["文件没有可用内容".to_string()]),
    }
}
