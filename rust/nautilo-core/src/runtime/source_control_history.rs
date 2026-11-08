//! Immutable commit details; merge commits compare with their first parent.
use super::{checked, content, git, path, required};
use serde_json::{json, Value};

fn valid_hash(hash: &str) -> anyhow::Result<()> {
    if !matches!(hash.len(), 40 | 64) || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()) { anyhow::bail!("请选择有效的提交记录"); }
    Ok(())
}
async fn resolve(root: &str, hash: &str) -> anyhow::Result<String> {
    valid_hash(hash)?;
    Ok(checked(root, &["rev-parse", "--verify", &format!("{hash}^{{commit}}")], None).await?.trim().into())
}
async fn comparison_base(root: &str, parents: &[Value]) -> anyhow::Result<String> {
    if let Some(parent) = parents.first().and_then(Value::as_str) { return Ok(parent.into()); }
    Ok(checked(root, &["hash-object", "-t", "tree", "--stdin"], Some("")).await?.trim().into())
}
pub(super) async fn commit(root: &str, hash: &str) -> anyhow::Result<Value> {
    let hash = resolve(root, hash).await?;
    let details = checked(root, &["show", "-s", "--format=%H%x00%P%x00%s%x00%b%x00%an%x00%ae%x00%cI", &hash], None).await?;
    let fields = details.trim_end_matches(['\r', '\n']).split('\0').collect::<Vec<_>>();
    if fields.len() != 7 { anyhow::bail!("Git 提交记录不完整"); }
    let parents = fields[1].split_whitespace().map(|value| json!(value)).collect::<Vec<_>>();
    let base = comparison_base(root, &parents).await?;
    let names = checked(root, &["diff", "--no-ext-diff", "--no-textconv", "--name-status", "-z", "-M", &base, &hash, "--"], None).await?;
    let records = names.split('\0').collect::<Vec<_>>();
    let mut files = Vec::new(); let mut cursor = 0;
    while cursor < records.len() && !records[cursor].is_empty() {
        let status = records[cursor]; cursor += 1;
        let first = records.get(cursor).filter(|name| !name.is_empty()).ok_or_else(|| anyhow::anyhow!("Git 文件变更记录不完整"))?; cursor += 1;
        path(first)?;
        let (name, original) = if status.starts_with('R') || status.starts_with('C') {
            let name = records.get(cursor).filter(|name| !name.is_empty()).ok_or_else(|| anyhow::anyhow!("Git 重命名记录不完整"))?; cursor += 1; path(name)?; (*name, Some(*first))
        } else { (*first, None) };
        files.push(json!({"path":name,"originalPath":original,"status":&status[..1],"binary":false}));
    }
    let stats = checked(root, &["diff", "--no-ext-diff", "--no-textconv", "--numstat", "-z", "-M", &base, &hash, "--"], None).await?;
    let records = stats.split('\0').collect::<Vec<_>>(); let mut cursor = 0;
    while cursor < records.len() && !records[cursor].is_empty() {
        let fields = records[cursor].splitn(3, '\t').collect::<Vec<_>>(); cursor += 1;
        if fields.len() != 3 { anyhow::bail!("Git 变更统计不完整"); }
        let name = if fields[2].is_empty() {
            if cursor + 1 >= records.len() { anyhow::bail!("Git 重命名统计不完整"); }
            cursor += 2; records[cursor - 1]
        } else { fields[2] };
        if let Some(file) = files.iter_mut().find(|file| file["path"] == name) {
            file["binary"] = json!(fields[0] == "-" || fields[1] == "-");
            if let (Ok(added), Ok(removed)) = (fields[0].parse::<u64>(), fields[1].parse::<u64>()) { file["additions"] = json!(added); file["deletions"] = json!(removed); }
        }
    }
    Ok(json!({"rootPath":root,"hash":hash,"parents":parents,"subject":fields[2],"body":fields[3],"author":fields[4],"authorEmail":fields[5],"committedAt":fields[6],"files":files}))
}
pub(super) async fn diff(root: &str, input: &Value) -> anyhow::Result<Value> {
    let name = required(input, "path")?; path(name)?;
    let details = commit(root, required(input, "hash")?).await?;
    let file = details["files"].as_array().unwrap().iter().find(|file| file["path"] == name).ok_or_else(|| anyhow::anyhow!("此文件不在所选提交的更改中"))?;
    let hash = required(&details, "hash")?;
    let parents = details["parents"].as_array().unwrap();
    let base = comparison_base(root, parents).await?;
    let original = file["originalPath"].as_str().unwrap_or(name);
    let result = git(root, &["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--patch", "-M", &base, hash, "--", original, name], None, 1024 * 1024).await?;
    if result.code != 0 { anyhow::bail!("{}", result.stderr); }
    let before = content::tree_text(root, parents.first().and_then(Value::as_str), original).await?;
    let after = content::tree_text(root, Some(hash), name).await?;
    let mut result = json!({"rootPath":root,"path":name,"source":"commit","commitHash":hash,"patch":result.stdout,"binary":file["binary"],"truncated":result.truncated});
    if let Some(reason) = before.reason.or(after.reason) { result["previewReason"] = json!(reason); }
    else { result["before"] = json!(before.text); result["after"] = json!(after.text); }
    Ok(result)
}
