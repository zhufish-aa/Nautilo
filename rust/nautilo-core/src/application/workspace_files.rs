//! Owner-authorized, project-confined browsing and bounded preview transport.
use std::{collections::{HashSet, VecDeque}, path::{Path, PathBuf}, sync::{Arc, Mutex}};
use serde_json::{json, Value};
use crate::{database::{Database, Repositories}, errors::{invalid, not_found, CoreResult}};

fn root(db: &Arc<Mutex<Database>>, input: &Value) -> CoreResult<PathBuf> {
    let id = input["projectId"].as_str().unwrap_or("");
    let project = Repositories::new(&db.lock().unwrap().raw).projects().get(id)?.ok_or_else(|| not_found("project", id))?;
    crate::paths::canonicalize_plain(Path::new(project["rootPath"].as_str().unwrap_or(""))).map_err(|_| not_found("project", id))
}

fn inside(root: &Path, path: &Path) -> bool { path == root || path.starts_with(root) }
fn relative(root: &Path, path: &Path) -> String { path.strip_prefix(root).unwrap_or(path).to_string_lossy().replace('\\', "/") }

pub fn list(db: &Arc<Mutex<Database>>, input: &Value) -> CoreResult<Value> {
    let root = root(db, input)?;
    let raw = input["path"].as_str().unwrap_or("");
    // This endpoint accepts relative directory paths. Absolute file links use
    // the preview reader, which also validates Windows /D:/ URL references.
    let path = crate::paths::canonicalize_plain(&root.join(raw)).map_err(|_| not_found("directory", raw))?;
    if !inside(&root, &path) { return Err(invalid("path", "Directory is outside this project.")); }
    let offset = input["offset"].as_u64().unwrap_or(0).min(10_000) as usize;
    let query = input["query"].as_str().unwrap_or("").to_lowercase();
    let mut entries = Vec::new();
    let mut scanned = 0;
    for entry in std::fs::read_dir(&path).map_err(|_| not_found("directory", raw))? {
        let Ok(entry) = entry else { continue };
        scanned += 1;
        if scanned > 10_000 { break; }
        let name = entry.file_name().to_string_lossy().into_owned();
        if !query.is_empty() && !name.to_lowercase().contains(&query) { continue; }
        let Ok(actual) = crate::paths::canonicalize_plain(&entry.path()) else { continue };
        if !inside(&root, &actual) { continue; }
        let Ok(info) = std::fs::metadata(&actual) else { continue };
        if !info.is_file() && !info.is_dir() { continue; }
        entries.push(json!({"name":name,"path":relative(&root,&entry.path()),"directory":info.is_dir(),"size":info.len()}));
    }
    entries.sort_by_key(|v| (v["directory"] != true, v["name"].as_str().unwrap_or("").to_lowercase()));
    let count = entries.len();
    let parent = if path == root { None } else { path.parent().map(|p|relative(&root,p)) };
    Ok(json!({"path":relative(&root,&path),"parent":parent,"entries":entries.into_iter().skip(offset).take(100).collect::<Vec<_>>(),
        "nextOffset":if offset+100<count{Some(offset+100)}else{None},"scanLimited":scanned>10_000}))
}

pub fn preview(db: &Arc<Mutex<Database>>, input: &Value) -> CoreResult<Value> {
    let root = root(db, input)?;
    let raw = input["path"].as_str().filter(|s| !s.is_empty() && s.len() <= 4096).ok_or_else(|| invalid("path", "Choose a project file."))?;
    let mut input = input.clone();
    // A bare filename in prose is useful only when it has one unambiguous
    // match. Never silently choose a different file with the same name.
    if !raw.contains(['/', '\\', ':']) && !root.join(raw).exists() {
        let mut queue = VecDeque::from([root.clone()]);
        let mut visited = HashSet::new();
        let mut matches = Vec::new();
        let mut scanned = 0;
        while let Some(folder) = queue.pop_front() {
            if !visited.insert(folder.clone()) { continue; }
            let Ok(children) = std::fs::read_dir(folder) else { continue };
            for entry in children.flatten() {
                scanned += 1;
                if scanned > 20_000 { break; }
                let Ok(actual) = crate::paths::canonicalize_plain(&entry.path()) else { continue };
                if !inside(&root, &actual) { continue; }
                let name = entry.file_name().to_string_lossy().into_owned();
                if actual.is_dir() {
                    if ![".git","node_modules","target","build",".gradle",".pnpm"].contains(&name.as_str()) { queue.push_back(actual); }
                } else if name.eq_ignore_ascii_case(raw) { matches.push(relative(&root,&actual)); }
            }
            if scanned > 20_000 || matches.len() >= 20 { break; }
        }
        matches.sort(); matches.dedup();
        if matches.len() != 1 || scanned > 20_000 {
            return Ok(json!({"candidates":matches,"searchLimited":scanned>20_000,"path":raw}));
        }
        input["path"] = json!(matches[0]);
    }
    let offset = input["offset"].as_u64().unwrap_or(0);
    let length = input["length"].as_u64().unwrap_or(524_288).clamp(1, 524_288);
    super::artifact_read::read_workspace_range(db, &input, offset, length)
}
