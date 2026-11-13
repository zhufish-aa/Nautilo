//! Git worktree state and explicit user operations; independent of task orchestration.
use crate::runtime::git::source_control_io::{checked, git};
#[path = "source_control_patch.rs"]
mod patch;
#[path = "source_control_content.rs"]
mod content;
#[path = "source_control_history.rs"]
mod history;
#[path = "source_control_history_page.rs"]
mod history_page;
#[path = "source_control_file.rs"]
mod file;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    path::Path,
    sync::{Arc, Mutex, Weak},
};

#[derive(Default)]
pub struct SourceControl {
    gates: Mutex<HashMap<String, Weak<tokio::sync::Mutex<()>>>>,
}
fn hash(data: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(data.as_ref()))
}
fn required<'a>(input: &'a Value, key: &str) -> anyhow::Result<&'a str> {
    input[key]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow::anyhow!("缺少 {key}"))
}
fn path(value: &str) -> anyhow::Result<()> {
    if value.is_empty()
        || value.contains('\0')
        || cfg!(windows) && value.contains('\\')
        || value.starts_with('/')
        || value
            .split('/')
            .any(|part| matches!(part, ".." | "." | ".git" | ""))
        || value.as_bytes().get(1) == Some(&b':')
    {
        anyhow::bail!("文件路径必须位于当前 Git 工作目录内");
    }
    Ok(())
}
fn parse_status(raw: &str) -> anyhow::Result<Value> {
    let mut state = json!({"changes":[],"ahead":0,"behind":0,"detached":false});
    let mut records = raw.split('\0');
    while let Some(record) = records.next() {
        if record.is_empty() {
            continue;
        }
        if let Some(value) = record.strip_prefix("# branch.oid ") {
            if value != "(initial)" {
                state["head"] = json!(value);
            }
            continue;
        }
        if let Some(value) = record.strip_prefix("# branch.head ") {
            if value == "(detached)" {
                state["detached"] = json!(true);
            } else {
                state["branch"] = json!(value);
            }
            continue;
        }
        if let Some(value) = record.strip_prefix("# branch.upstream ") {
            state["upstream"] = json!(value);
            continue;
        }
        if let Some(value) = record.strip_prefix("# branch.ab ") {
            let fields = value.split_whitespace().collect::<Vec<_>>();
            state["ahead"] = json!(fields
                .first()
                .and_then(|s| s.strip_prefix('+'))
                .and_then(|s| s.parse::<u64>().ok())
                .unwrap_or(0));
            state["behind"] = json!(fields
                .get(1)
                .and_then(|s| s.strip_prefix('-'))
                .and_then(|s| s.parse::<u64>().ok())
                .unwrap_or(0));
            continue;
        }
        if record.starts_with('#') {
            continue;
        }
        let kind = record.as_bytes()[0];
        let mut original = None;
        let (name, xy, sub) = match kind {
            b'?' => (&record[2..], "??", "N..."),
            b'1' | b'2' | b'u' => {
                let fields = record
                    .splitn(
                        if kind == b'1' {
                            9
                        } else if kind == b'2' {
                            10
                        } else {
                            11
                        },
                        ' ',
                    )
                    .collect::<Vec<_>>();
                let count = if kind == b'1' {
                    9
                } else if kind == b'2' {
                    10
                } else {
                    11
                };
                if fields.len() != count {
                    anyhow::bail!("Git 状态记录不完整");
                }
                if kind == b'2' {
                    original = records.next();
                    if original.is_none() {
                        anyhow::bail!("Git 重命名记录不完整");
                    }
                }
                (fields[count - 1], fields[1], fields[2])
            }
            _ => anyhow::bail!("无法识别的 Git 状态记录"),
        };
        // Porcelain keeps a trailing slash for untracked directories (notably
        // nested repositories), even with --untracked-files=all.
        let directory = kind == b'?' && name.ends_with('/');
        let name = if directory { &name[..name.len() - 1] } else { name };
        path(name)?;
        if let Some(old) = original {
            path(old)?;
        }
        if xy.len() != 2 {
            anyhow::bail!("Git 文件状态无效");
        }
        state["changes"].as_array_mut().unwrap().push(json!({"path":name,"originalPath":original,"indexStatus":&xy[..1],"worktreeStatus":&xy[1..],"untracked":kind==b'?',"conflict":kind==b'u',"submodule":sub.starts_with('S'),"directory":directory}));
    }
    Ok(state)
}
async fn root(cwd: &str) -> anyhow::Result<Option<String>> {
    let result = git(cwd, &["rev-parse", "--show-toplevel"], None, 16 * 1024).await?;
    if result.code != 0 {
        return Ok(None);
    }
    let absolute = std::fs::canonicalize(result.stdout.trim())?
        .to_string_lossy()
        .into_owned();
    Ok(Some(
        if let Some(unc) = absolute.strip_prefix("\\\\?\\UNC\\") {
            format!("\\\\{unc}")
        } else {
            absolute
                .strip_prefix("\\\\?\\")
                .unwrap_or(&absolute)
                .to_string()
        },
    ))
}
async fn file_token(root: &str, name: &str) -> anyhow::Result<String> {
    path(name)?;
    let target = Path::new(root).join(name);
    let mut ancestor = target.parent().unwrap();
    let parent = loop {
        match std::fs::canonicalize(ancestor) {
            Ok(parent) => break parent,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                ancestor = ancestor.parent().ok_or(error)?;
            }
            Err(error) => return Err(error.into()),
        }
    };
    if !parent.starts_with(std::fs::canonicalize(root)?) {
        anyhow::bail!("文件路径已指向工作目录之外");
    }
    match std::fs::symlink_metadata(&target) {
        Ok(info) if info.file_type().is_symlink() => Ok(hash(format!(
            "link:{}",
            std::fs::read_link(&target)?.to_string_lossy()
        ))),
        Ok(info) if info.is_file() => {
            use std::io::Read;
            let mut file = std::fs::File::open(target)?;
            let mut digest = Sha256::new();
            let mut buffer = vec![0; 65536];
            loop {
                let size = file.read(&mut buffer)?;
                if size == 0 {
                    break;
                }
                digest.update(&buffer[..size]);
            }
            Ok(format!("{:x}", digest.finalize()))
        }
        Ok(_) => anyhow::bail!("此项目不是普通文件"),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(hash("missing")),
        Err(error) => Err(error.into()),
    }
}
impl SourceControl {
    async fn lock(&self, root: &str) -> tokio::sync::OwnedMutexGuard<()> {
        let key = if cfg!(windows) {
            root.to_lowercase()
        } else {
            root.into()
        };
        let gate = {
            let mut gates = self.gates.lock().unwrap();
            gates.retain(|_, v| v.strong_count() > 0);
            if let Some(gate) = gates.get(&key).and_then(Weak::upgrade) {
                gate
            } else {
                let gate = Arc::new(tokio::sync::Mutex::new(()));
                gates.insert(key, Arc::downgrade(&gate));
                gate
            }
        };
        gate.lock_owned().await
    }
    pub async fn status(&self, cwd: &str) -> anyhow::Result<Value> {
        let Some(root) = root(cwd).await? else {
            return Ok(json!({"schemaVersion":1,"available":false,"workingDirectory":cwd}));
        };
        let _gate = self.lock(&root).await;
        self.snapshot(cwd, &root).await
    }
    async fn snapshot(&self, cwd: &str, root: &str) -> anyhow::Result<Value> {
        let raw = checked(
            root,
            &[
                "status",
                "--porcelain=v2",
                "-z",
                "--branch",
                "--untracked-files=all",
            ],
            None,
        )
        .await?;
        let mut state = parse_status(&raw)?;
        let base=if let Some(head)=state["head"].as_str(){head.to_string()}else{checked(root,&["hash-object","-t","tree","--stdin"],Some("")).await?.trim().to_string()};
        // These reads are independent. Keep the repository gate, but do not pay
        // Windows process startup latency once for every field of a snapshot.
        let (stat_raw, index_path, branches, remotes, log, git_dir, config) = tokio::try_join!(
            async { if state["changes"].as_array().unwrap().is_empty() { Ok(String::new()) } else { checked(root,&["diff","--no-ext-diff","--no-textconv","--numstat","-z","-M",&base,"--"],None).await } },
            checked(root, &["rev-parse", "--path-format=absolute", "--git-path", "index"], None),
            checked(root, &["for-each-ref", "--format=%(refname:short)%00%(HEAD)%00%(upstream:short)%00%(worktreepath)%00%(upstream:remotename)%00%(push:remotename)%00%(push:remoteref)%00", "refs/heads/"], None),
            checked(root, &["remote"], None),
            async { if state["head"].is_string() { checked(root, &["log", "-20", "--format=%H%x00%s%x00%an%x00%cI%x00"], None).await } else { Ok(String::new()) } },
            checked(root, &["rev-parse", "--absolute-git-dir"], None),
            checked(root, &["config", "--null", "--list"], None)
        )?;
        let stats=content::numstat(&stat_raw)?;
        for file in state["changes"].as_array_mut().unwrap(){if let Some(stat)=file["path"].as_str().and_then(|name|stats.get(name)){for(key,value)in stat.as_object().unwrap(){file[key]=value.clone();}}}
        let mut digest = Sha256::new();
        digest.update(root);
        digest.update(b"\0");
        digest.update(raw.as_bytes());
        // Porcelain can stay identical while an already modified file is edited
        // again. Include worktree revisions so preview caches cannot reuse it.
        for change in state["changes"].as_array().unwrap() {
            let name = change["path"].as_str().unwrap();
            digest.update(b"\0worktree\0");
            digest.update(name.as_bytes());
            match std::fs::symlink_metadata(Path::new(root).join(name)) {
                Ok(info) => {
                    digest.update(info.len().to_le_bytes());
                    for time in [info.modified(), info.created()] {
                        if let Ok(time) = time {
                            if let Ok(time) = time.duration_since(std::time::UNIX_EPOCH) {
                                digest.update(time.as_nanos().to_le_bytes());
                            }
                        }
                    }
                }
                Err(error) => digest.update(format!("{:?}", error.kind()).as_bytes()),
            }
        }
        match std::fs::File::open(index_path.trim()) {
            Ok(mut file) => {
                use std::io::Read;
                let mut buffer = vec![0; 65536];
                loop {
                    let size = file.read(&mut buffer)?;
                    if size == 0 {
                        break;
                    }
                    digest.update(&buffer[..size]);
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        };
        state["branches"]=json!(branches.lines().filter(|s|!s.is_empty()).map(|line|{let fields=line.split('\0').collect::<Vec<_>>();json!({"name":fields[0],"current":fields.get(1)==Some(&"*"),"upstream":fields.get(2).filter(|s|!s.is_empty()),"worktree":fields.get(3).filter(|s|!s.is_empty()),"upstreamRemote":fields.get(4).filter(|s|!s.is_empty()),"pushRemote":fields.get(5).filter(|s|!s.is_empty()),"pushRef":fields.get(6).filter(|s|!s.is_empty())})}).collect::<Vec<_>>());
        let upstream_remote = state["branches"]
            .as_array()
            .unwrap()
            .iter()
            .find(|branch| branch["current"] == true)
            .map(|branch| branch["upstreamRemote"].clone())
            .unwrap_or(Value::Null);
        state["upstreamRemote"] = upstream_remote;
        let push = state["branches"]
            .as_array()
            .unwrap()
            .iter()
            .find(|branch| branch["current"] == true)
            .cloned()
            .unwrap_or(Value::Null);
        state["pushRemote"] = push["pushRemote"].clone();
        state["pushRef"] = push["pushRef"].clone();
        state["remotes"] = json!(remotes
            .lines()
            .map(str::to_string)
            .collect::<Vec<_>>());
        state["recent"] = json!([]);
        if state["head"].is_string() {
            state["recent"]=json!(log.lines().filter(|s|!s.is_empty()).map(|line|{let f=line.split('\0').collect::<Vec<_>>();json!({"hash":f[0],"subject":f.get(1).unwrap_or(&""),"author":f.get(2).unwrap_or(&""),"committedAt":f.get(3).unwrap_or(&"")})}).collect::<Vec<_>>());
        }
        for (entry, operation) in [
            ("rebase-merge", "rebase"),
            ("rebase-apply", "rebase"),
            ("MERGE_HEAD", "merge"),
            ("CHERRY_PICK_HEAD", "cherry-pick"),
            ("REVERT_HEAD", "revert"),
        ] {
            if Path::new(git_dir.trim()).join(entry).exists() {
                state["operation"] = json!(operation);
                if entry == "MERGE_HEAD" {
                    use std::io::Read;
                    let mut bytes = Vec::new();
                    std::fs::File::open(Path::new(git_dir.trim()).join(entry))?
                        .take(65537)
                        .read_to_end(&mut bytes)?;
                    if bytes.len() > 65536 {
                        anyhow::bail!("Git 合并状态过大，请在原生终端检查。");
                    }
                    digest.update(bytes);
                }
                break;
            }
        }
        digest.update(b"\0");
        digest.update(state["operation"].as_str().unwrap_or(""));
        digest.update(config.as_bytes());
        state["token"] = json!(format!("{:x}", digest.finalize()));
        state["schemaVersion"] = json!(1);
        state["available"] = json!(true);
        state["workingDirectory"] = json!(cwd);
        state["rootPath"] = json!(root);
        Ok(state)
    }
    pub async fn diff(&self, cwd: &str, input: &Value) -> anyhow::Result<Value> {
        let root = root(cwd)
            .await?
            .ok_or_else(|| anyhow::anyhow!("当前目录不是 Git 仓库"))?;
        let _gate = self.lock(&root).await;
        self.read_diff(&root, input).await
    }
    pub async fn file(&self,cwd:&str,input:&Value)->anyhow::Result<Value>{
        let root=root(cwd).await?.ok_or_else(||anyhow::anyhow!("当前目录不是 Git 仓库"))?;let _gate=self.lock(&root).await;
        file::read(&root,required(input,"path")?,false).await
    }
    pub async fn save(&self,cwd:&str,input:&Value)->anyhow::Result<Value>{
        let root=root(cwd).await?.ok_or_else(||anyhow::anyhow!("当前目录不是 Git 仓库"))?;let _gate=self.lock(&root).await;
        let(staged,error)=file::write(&root,input).await?;let mut result=json!({"saved":true,"staged":staged});let mut errors=error.into_iter().collect::<Vec<_>>();
        match file::read(&root,required(input,"path")?,true).await{Ok(file)=>result["file"]=file,Err(error)=>errors.push(format!("读取保存后的文件状态失败：{error}"))};
        match self.snapshot(cwd,&root).await{Ok(status)=>result["status"]=status,Err(error)=>errors.push(format!("刷新 Git 状态失败：{error}"))};
        if !errors.is_empty(){result["error"]=json!(errors.join("\n"));}Ok(result)
    }
    pub async fn commit_details(&self, cwd: &str, input: &Value) -> anyhow::Result<Value> {
        let root = root(cwd).await?.ok_or_else(|| anyhow::anyhow!("当前目录不是 Git 仓库"))?;
        let _gate = self.lock(&root).await;
        history::commit(&root, required(input, "hash")?).await
    }
    pub async fn history(&self,cwd:&str,input:&Value)->anyhow::Result<Value>{
        let root=root(cwd).await?.ok_or_else(||anyhow::anyhow!("当前目录不是 Git 仓库"))?;let _gate=self.lock(&root).await;history_page::read(&root,input).await
    }
    pub async fn commit_diff(&self, cwd: &str, input: &Value) -> anyhow::Result<Value> {
        let root = root(cwd).await?.ok_or_else(|| anyhow::anyhow!("当前目录不是 Git 仓库"))?;
        let _gate = self.lock(&root).await;
        history::diff(&root, input).await
    }
    async fn read_diff(&self, root: &str, input: &Value) -> anyhow::Result<Value> {
        let name = required(input, "path")?;
        path(name)?;
        let source = required(input, "source")?;
        let state = parse_status(
            &checked(
                &root,
                &["status", "--porcelain=v2", "-z", "--untracked-files=all"],
                None,
            )
            .await?,
        )?;
        let change = state["changes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["path"] == name)
            .ok_or_else(|| anyhow::anyhow!("文件状态已改变，请刷新后重试"))?;
        if source == "index"
            && (change["untracked"] == true
                || change["conflict"] == true
                || matches!(change["indexStatus"].as_str(), Some(".") | Some("?")))
        {
            anyhow::bail!("此文件的暂存状态已改变，请刷新后重试。");
        }
        let mut args = vec![
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--no-color",
            "--no-renames",
            "--patch",
            "--",
        ];
        if source == "index" {
            args.insert(1, "--cached");
        } else if source != "worktree" {
            anyhow::bail!("未知差异来源");
        }
        if change["directory"] == true {
            return Ok(json!({"rootPath":root,"path":name,"source":source,"patch":"","binary":false,"truncated":false,"editable":false,"hunks":[],"partialReason":"directory","previewReason":"directory"}));
        }
        let token = if source == "worktree" && !change["submodule"].as_bool().unwrap_or(false) {
            Some(file_token(&root, name).await?)
        } else {
            None
        };
        let preview_identity = content::identity(root, name, change, source).await?;
        if change["untracked"] == true {
            let result = git(
                root,
                &[
                    "diff",
                    "--no-index",
                    "--no-ext-diff",
                    "--no-textconv",
                    "--no-color",
                    "--patch",
                    "--",
                    "/dev/null",
                    name,
                ],
                None,
                1024 * 1024,
            )
            .await?;
            if result.code != 0 && result.code != 1 {
                anyhow::bail!("{}", result.stderr);
            }
            let binary = result
                .stdout
                .lines()
                .any(|line| line.starts_with("Binary files ") || line == "GIT binary patch");
            return content::attach(root, change, &preview_identity, Self::describe_diff(
                root,
                &change,
                json!({"path":name,"source":source,"patch":result.stdout,"binary":binary,"truncated":result.truncated,"fileToken":token}),
            )).await;
        }
        args.push(name);
        if let Some(old) = change["originalPath"].as_str() {
            args.push(old);
        }
        let result = git(&root, &args, None, 1024 * 1024).await?;
        if result.code != 0 {
            anyhow::bail!("{}", result.stderr);
        }
        let binary = result
            .stdout
            .lines()
            .any(|line| line.starts_with("Binary files ") || line == "GIT binary patch");
        content::attach(root, change, &preview_identity, Self::describe_diff(
            root,
            &change,
            json!({"path":name,"source":source,"binary":binary,"patch":result.stdout,"truncated":result.truncated,"fileToken":token}),
        )).await
    }
    fn describe_diff(root: &str, change: &Value, mut diff: Value) -> Value {
        diff["rootPath"] = json!(root);
        let reason = if diff["binary"] == true {
            Some("binary")
        } else if diff["truncated"] == true {
            Some("truncated")
        } else if change["conflict"] == true {
            Some("conflict")
        } else if change["submodule"] == true {
            Some("submodule")
        } else if change["originalPath"].is_string() {
            Some("rename")
        } else {
            None
        };
        let described = if reason.is_none() {
            patch::describe(
                diff["patch"].as_str().unwrap_or(""),
                diff["path"].as_str().unwrap_or(""),
                diff["source"].as_str().unwrap_or(""),
            )
            .ok()
        } else {
            None
        };
        if let Some(hunks) = described {
            diff["hunks"] = hunks;
            diff["patchToken"] = json!(hash(format!(
                "{root}\0{}",
                patch::token(
                    diff["path"].as_str().unwrap(),
                    diff["source"].as_str().unwrap(),
                    diff["patch"].as_str().unwrap(),
                    diff["fileToken"].as_str()
                )
            )));
        } else {
            diff["hunks"] = json!([]);
            diff["partialReason"] = json!(reason.unwrap_or("unsupported"));
        }
        diff
    }
    pub async fn mutate(&self, cwd: &str, input: &Value) -> anyhow::Result<Value> {
        if input["action"] == "init" {
            if root(cwd).await?.is_some() {
                return Ok(json!({"status":self.status(cwd).await?}));
            }
            let directory = std::fs::canonicalize(cwd)?.to_string_lossy().into_owned();
            let _gate = self.lock(&directory).await;
            checked(cwd, &["init"], None).await?;
            let root = root(cwd)
                .await?
                .ok_or_else(|| anyhow::anyhow!("无法初始化 Git 仓库"))?;
            return Ok(json!({"status":self.snapshot(cwd,&root).await?}));
        }
        let root = root(cwd)
            .await?
            .ok_or_else(|| anyhow::anyhow!("当前目录不是 Git 仓库"))?;
        let _gate = self.lock(&root).await;
        let state = self.snapshot(cwd, &root).await?;
        if state["token"] != input["token"] {
            anyhow::bail!(if input["action"] == "discard" { "仓库状态或文件内容已改变，请重新查看差异后再试。" } else { "仓库状态已改变，请刷新后重试。" });
        }
        let action = required(input, "action")?;
        let changes = state["changes"].as_array().unwrap();
        let output;
        match action {
            "stage-hunks" | "unstage-hunks" => {
                let paths = input["paths"]
                    .as_array()
                    .filter(|paths| paths.len() == 1)
                    .ok_or_else(|| anyhow::anyhow!("请选择一个文件的更改区块。"))?;
                let name = paths[0]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("文件路径无效。"))?;
                path(name)?;
                let source = if action == "stage-hunks" {
                    "worktree"
                } else {
                    "index"
                };
                let diff =
                    Box::pin(self.read_diff(&root, &json!({"path":name,"source":source}))).await?;
                if !diff["patchToken"].is_string() || diff["patchToken"] != input["patchToken"] {
                    anyhow::bail!("差异内容已改变，请刷新后重新选择。");
                }
                let hunk_ids = input["hunkIds"]
                    .as_array()
                    .map(|ids| {
                        ids.iter()
                            .map(|id| {
                                id.as_str()
                                    .map(str::to_string)
                                    .ok_or_else(|| anyhow::anyhow!("区块选择无效。"))
                            })
                            .collect::<anyhow::Result<Vec<_>>>()
                    })
                    .transpose()?
                    .unwrap_or_default();
                let lines = input["lines"]
                    .as_array()
                    .map(|lines| {
                        lines
                            .iter()
                            .map(|line| {
                                line.as_u64()
                                    .and_then(|line| usize::try_from(line).ok())
                                    .ok_or_else(|| anyhow::anyhow!("更改行选择无效。"))
                            })
                            .collect::<anyhow::Result<Vec<_>>>()
                    })
                    .transpose()?
                    .unwrap_or_default();
                if hunk_ids.len() > 10000 || lines.len() > 100000 {
                    anyhow::bail!("选择的更改过多，请按区块操作。");
                }
                let selected = patch::select(
                    diff["patch"].as_str().unwrap(),
                    name,
                    source,
                    &hunk_ids,
                    &lines,
                )?;
                checked(
                    &root,
                    &["apply", "--cached", "--check", "--whitespace=nowarn", "-"],
                    Some(&selected),
                )
                .await?;
                output = checked(
                    &root,
                    &["apply", "--cached", "--whitespace=nowarn", "-"],
                    Some(&selected),
                )
                .await?;
            }
            "stage" | "unstage" | "discard" => {
                let names = input["paths"]
                    .as_array()
                    .filter(|paths| !paths.is_empty() && paths.len() <= 10000)
                    .ok_or_else(|| anyhow::anyhow!("请选择需要操作的文件（每次最多 10000 个）"))?;
                let mut paths = Vec::<String>::new();
                let mut selected = Vec::new();
                for value in names {
                    let name = value
                        .as_str()
                        .ok_or_else(|| anyhow::anyhow!("文件路径无效"))?;
                    path(name)?;
                    let change = changes
                        .iter()
                        .find(|item| item["path"] == name)
                        .ok_or_else(|| anyhow::anyhow!("文件状态已改变，请刷新后重试"))?;
                    paths.push(name.into());
                    if let Some(old) = change["originalPath"].as_str() {
                        paths.push(old.into());
                    }
                    selected.push(change);
                }
                let mut unique = HashSet::new();
                paths.retain(|name| unique.insert(name.clone()));
                let mut args = if action == "stage" {
                    vec!["add", "-A", "--"]
                } else if action == "unstage" {
                    if state["head"].is_string() {
                        vec!["restore", "--staged", "--"]
                    } else {
                        vec!["rm", "--cached", "-f", "--ignore-unmatch", "--"]
                    }
                } else {
                    if selected.len() != 1
                        || selected[0]["conflict"] == true
                        || selected[0]["untracked"] == true
                        || selected[0]["submodule"] == true
                    {
                        anyhow::bail!("请选择一个非冲突的已跟踪文件放弃未暂存更改。");
                    }
                    if input["fileToken"].as_str()
                        != Some(
                            file_token(&root, selected[0]["path"].as_str().unwrap())
                                .await?
                                .as_str(),
                        )
                    {
                        anyhow::bail!("文件内容已改变，请重新查看差异后再放弃更改。");
                    }
                    paths = vec![selected[0]["path"].as_str().unwrap().to_string()];
                    vec!["restore", "--worktree", "--"]
                };
                args.pop();
                args.extend(["--pathspec-from-file=-", "--pathspec-file-nul"]);
                output = checked(&root, &args, Some(&(paths.join("\0") + "\0"))).await?;
            }
            "commit" => {
                if changes.iter().any(|change| change["conflict"] == true) {
                    anyhow::bail!("请先解决冲突并暂存文件。");
                }
                if state["operation"] != "merge"
                    && !changes.iter().any(|change| {
                        !matches!(change["indexStatus"].as_str(), Some(".") | Some("?"))
                    })
                {
                    anyhow::bail!("请先暂存需要提交的更改。");
                }
                if state["operation"]
                    .as_str()
                    .is_some_and(|operation| operation != "merge")
                {
                    anyhow::bail!("请先在原生终端完成当前 Git 操作。");
                }
                let message = required(input, "message")?;
                if message.trim().is_empty() || message.len() > 64 * 1024 || message.contains('\0')
                {
                    anyhow::bail!("请输入有效的提交说明。");
                }
                output = checked(&root, &["commit", "--file=-"], Some(message)).await?;
            }
            "create-branch" | "switch-branch" => {
                let branch = required(input, "branch")?;
                if branch.starts_with('-')
                    || git(&root, &["check-ref-format", "--branch", branch], None, 8192)
                        .await?
                        .code
                        != 0
                {
                    anyhow::bail!("分支名称无效。");
                }
                if state["operation"].is_string() {
                    anyhow::bail!("请先完成当前 Git 操作。");
                }
                if action == "switch-branch" && !changes.is_empty() {
                    anyhow::bail!("请先提交或处理当前更改，再切换分支。");
                }
                let args = [
                    "switch",
                    if action == "create-branch" {
                        "-c"
                    } else {
                        "--"
                    },
                    branch,
                ];
                output = checked(&root, &args, None).await?;
            }
            "fetch" | "pull" | "push" => {
                let branch = state["branch"].as_str().unwrap_or("");
                let configured = if branch.is_empty() {
                    String::new()
                } else {
                    git(
                        &root,
                        &["config", "--get", &format!("branch.{branch}.remote")],
                        None,
                        8192,
                    )
                    .await?
                    .stdout
                    .trim()
                    .to_string()
                };
                let remote = input["remote"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| {
                        if action == "push"
                            && state["pushRemote"]
                                .as_str()
                                .is_some_and(|value| !value.is_empty())
                        {
                            state["pushRemote"].as_str().unwrap()
                        } else if !configured.is_empty() {
                            &configured
                        } else {
                            "origin"
                        }
                    });
                if !state["remotes"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|name| name == remote)
                    && !(remote == "." && (configured == "." || state["pushRemote"] == "."))
                {
                    anyhow::bail!("请选择已配置的远程仓库。");
                }
                if action == "fetch" {
                    output = checked(&root, &["fetch", "--prune", "--", remote], None).await?;
                } else {
                    if branch.is_empty() {
                        anyhow::bail!("请先切换到本地分支。");
                    }
                    let configured_merge = git(
                        &root,
                        &["config", "--get", &format!("branch.{branch}.merge")],
                        None,
                        8192,
                    )
                    .await?
                    .stdout
                    .trim()
                    .to_string();
                    let merge = if configured == remote {
                        configured_merge.clone()
                    } else {
                        String::new()
                    };
                    if action == "pull" {
                        if !changes.is_empty() || state["operation"].is_string() {
                            anyhow::bail!("请先提交或处理当前更改，再拉取更新。");
                        }
                        if merge.is_empty() {
                            anyhow::bail!("当前分支尚未设置上游，请先发布分支。");
                        }
                        output = checked(
                            &root,
                            &["pull", "--ff-only", "--no-rebase", "--", remote, &merge],
                            None,
                        )
                        .await?;
                    } else {
                        let target = if state["pushRemote"] == remote
                            && state["pushRef"]
                                .as_str()
                                .is_some_and(|value| !value.is_empty())
                        {
                            state["pushRef"].as_str().unwrap().to_string()
                        } else if merge.is_empty() {
                            format!("refs/heads/{branch}")
                        } else {
                            merge
                        };
                        if !target.starts_with("refs/heads/") {
                            anyhow::bail!("上游分支无效。");
                        }
                        let refspec = format!("HEAD:{target}");
                        let mut args = vec!["push", "--porcelain"];
                        if configured.is_empty() || configured_merge.is_empty() {
                            args.push("--set-upstream");
                        }
                        args.extend(["--", remote, &refspec]);
                        output = checked(&root, &args, None).await?;
                    }
                }
            }
            _ => anyhow::bail!("未知源码管理操作"),
        }
        Ok(json!({"status":self.snapshot(cwd,&root).await?,"output":output.trim()}))
    }
}

#[cfg(test)]
#[path = "source_control_tests.rs"]
mod tests;
