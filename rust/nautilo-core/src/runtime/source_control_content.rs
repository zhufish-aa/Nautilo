//! Bounded, read-only text versions for a syntax-aware native Git diff.
use super::{checked, file_token, git, required};
use crate::runtime::git::source_control_io::git_bytes;
use serde_json::{json, Value};

const LIMIT: usize = 1024 * 1024;
pub(super) fn numstat(raw:&str)->anyhow::Result<std::collections::HashMap<String,Value>>{
    let records=raw.split('\0').collect::<Vec<_>>();let mut cursor=0;let mut result=std::collections::HashMap::new();
    while cursor<records.len()&&!records[cursor].is_empty(){
        let fields=records[cursor].splitn(3,'\t').collect::<Vec<_>>();cursor+=1;
        if fields.len()!=3{anyhow::bail!("Git 变更统计不完整");}
        let name=if fields[2].is_empty(){if cursor+1>=records.len(){anyhow::bail!("Git 重命名统计不完整");}cursor+=2;records[cursor-1]}else{fields[2]};
        super::path(name)?;let mut stat=json!({"binary":fields[0]=="-"||fields[1]=="-"});
        if let(Ok(added),Ok(removed))=(fields[0].parse::<u64>(),fields[1].parse::<u64>()){stat["additions"]=json!(added);stat["deletions"]=json!(removed);}
        result.insert(name.to_string(),stat);
    }Ok(result)
}
pub(super) struct TextVersion {
    pub text: Option<String>,
    pub reason: Option<&'static str>,
}
pub(super) async fn staged_rename_source(root: &str, name: &str) -> anyhow::Result<Option<String>> {
    // Match git status's rename configuration while comparing HEAD with the index only.
    let config = git(root, &["config", "--get-regexp", "^status\\.(renames|renamelimit)$"], None, 8192).await?;
    if config.code != 0 && config.code != 1 { anyhow::bail!("{}", config.stderr); }
    let overrides = config.stdout.lines().filter_map(|line| line.split_once(' '))
        .map(|(key, value)| format!("diff.{}={value}", key.trim_start_matches("status.")))
        .collect::<Vec<_>>();
    let mut args = Vec::new();
    for setting in &overrides { args.extend(["-c", setting.as_str()]); }
    args.extend(["diff", "--cached", "--no-ext-diff", "--no-textconv", "--name-status", "-z", "--diff-filter=RC", "--"]);
    let records = checked(root, &args, None).await?;
    let mut fields = records.split_terminator('\0');
    while fields.next().is_some() {
        let original = fields.next().ok_or_else(|| anyhow::anyhow!("Git 重命名记录不完整"))?;
        let destination = fields.next().ok_or_else(|| anyhow::anyhow!("Git 重命名记录不完整"))?;
        if destination == name {
            super::path(original)?;
            return Ok(Some(original.to_string()));
        }
    }
    Ok(None)
}
impl TextVersion {
    fn empty() -> Self { Self { text: Some(String::new()), reason: None } }
    fn from_bytes(bytes: Vec<u8>, truncated: bool) -> Self {
        if truncated { return Self { text: None, reason: Some("large") }; }
        if bytes.contains(&0) { return Self { text: None, reason: Some("binary") }; }
        match String::from_utf8(bytes) {
            Ok(text) => Self { text: Some(text), reason: None },
            Err(_) => Self { text: None, reason: Some("encoding") },
        }
    }
}
async fn blob(root: &str, mode: &str, oid: &str) -> anyhow::Result<TextVersion> {
    if mode == "160000" { return Ok(TextVersion { text: None, reason: Some("submodule") }); }
    let result = Box::pin(git_bytes(root, &["cat-file", "blob", oid], None, LIMIT)).await?;
    if result.code != 0 { anyhow::bail!("{}", result.stderr); }
    Ok(TextVersion::from_bytes(result.stdout, result.truncated))
}
pub(super) async fn tree_text(root: &str, revision: Option<&str>, name: &str) -> anyhow::Result<TextVersion> {
    let Some(revision) = revision else { return Ok(TextVersion::empty()); };
    let entries = checked(root, &["ls-tree", "-z", revision, "--", name], None).await?;
    for entry in entries.split('\0').filter(|entry| !entry.is_empty()) {
        let Some((metadata, path)) = entry.split_once('\t') else { anyhow::bail!("Git 文件记录不完整"); };
        if path != name { continue; }
        let fields = metadata.split_whitespace().collect::<Vec<_>>();
        if fields.len() != 3 { anyhow::bail!("Git 文件记录不完整"); }
        return blob(root, fields[0], fields[2]).await;
    }
    Ok(TextVersion::empty())
}
async fn index_text(root: &str, name: &str, stage: &str) -> anyhow::Result<TextVersion> {
    let entries = checked(root, &["ls-files", "--stage", "-z", "--", name], None).await?;
    for entry in entries.split('\0').filter(|entry| !entry.is_empty()) {
        let Some((metadata, path)) = entry.split_once('\t') else { anyhow::bail!("Git 暂存记录不完整"); };
        let fields = metadata.split_whitespace().collect::<Vec<_>>();
        if fields.len() != 3 { anyhow::bail!("Git 暂存记录不完整"); }
        if path == name && fields[2] == stage { return blob(root, fields[0], fields[1]).await; }
    }
    Ok(TextVersion::empty())
}
async fn working_text(root: &str, name: &str) -> anyhow::Result<TextVersion> {
    use std::io::Read;
    // Verifies parent junctions before reading; never follows a file symlink.
    let target = super::verified_worktree_path(root, name)?;
    let metadata = match std::fs::symlink_metadata(&target) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(TextVersion::empty()),
        Err(error) => return Err(error.into()),
    };
    if metadata.file_type().is_symlink() {
        return Ok(TextVersion { text: Some(std::fs::read_link(target)?.to_string_lossy().into_owned()), reason: None });
    }
    if !metadata.is_file() { return Ok(TextVersion { text: None, reason: Some("submodule") }); }
    let mut bytes = Vec::new();
    std::fs::File::open(target)?.take((LIMIT + 1) as u64).read_to_end(&mut bytes)?;
    let truncated = bytes.len() > LIMIT;
    Ok(TextVersion::from_bytes(bytes, truncated))
}
pub(super) async fn identity(root: &str, name: &str, change: &Value, working: &str) -> anyhow::Result<String> {
    let index_args = ["ls-files", "--stage", "-z", "--", name, change["originalPath"].as_str().unwrap_or(name)];
    let (head, index) = tokio::try_join!(
        git(root, &["rev-parse", "--verify", "--quiet", "HEAD"], None, 8192),
        checked(root, &index_args, None),
    )?;
    Ok(super::hash(format!("{}\0{}\0{}", head.stdout, index, working)))
}
pub(super) async fn attach(root: &str, change: &Value, expected: &str, mut diff: Value) -> anyhow::Result<Value> {
    let name = required(&diff, "path")?;
    let source = required(&diff, "source")?;
    if change["submodule"] == true { diff["previewReason"] = json!("submodule"); return Ok(diff); }
    let (before, after) = if source == "index" {
        tokio::try_join!(async {
            let head = git(root, &["rev-parse", "--verify", "--quiet", "HEAD"], None, 8192).await?;
            let revision = (head.code == 0).then(|| head.stdout.trim());
            tree_text(root, revision, change["originalPath"].as_str().unwrap_or(name)).await
        }, index_text(root, name, "0"))?
    } else {
        tokio::try_join!(index_text(root, name, if change["conflict"] == true { "2" } else { "0" }), working_text(root, name))?
    };
    let working = if source == "worktree" { file_token(root, name).await? } else { String::new() };
    if expected != identity(root, name, change, &working).await? { anyhow::bail!("文件内容已改变，正在等待最新差异，请重试。"); }
    if let Some(reason) = before.reason.or(after.reason) { diff["previewReason"] = json!(reason); }
    else { diff["before"] = json!(before.text); diff["after"] = json!(after.text); }
    Ok(diff)
}
