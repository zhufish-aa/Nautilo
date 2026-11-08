//! Page through a fixed commit graph even if the checked-out branch advances.
use super::{checked, git, hash};
use anyhow::{anyhow, bail, ensure, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{io::Read, path::Path};

const FORMAT: &str = "--format=%H%x00%s%x00%an%x00%cI";
const LOG_OPTIONS: &[&str] = &[
    "log",
    "--topo-order",
    "--no-show-signature",
    "--no-decorate",
    "--no-notes",
    "--encoding=UTF-8",
    "-z",
    FORMAT,
];
const INVALID_CURSOR: &str = "提交记录游标无效，请刷新。";
const STALE_CURSOR: &str = "提交历史、分支或搜索条件已改变，请刷新记录。";

#[derive(Serialize, Deserialize)]
struct Cursor {
    v: u8,
    root: String,
    #[serde(rename = "ref")]
    reference: String,
    query: String,
    graph: String,
    head: String,
    offset: u32,
}

fn oid(value: &str) -> bool {
    matches!(value.len(), 40 | 64) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn decode_cursor(value: &Value) -> Result<Option<Cursor>> {
    if value.is_null() {
        return Ok(None);
    }
    let text = value
        .as_str()
        .filter(|s| s.len() <= 4096)
        .ok_or_else(|| anyhow!(INVALID_CURSOR))?;
    let bytes = URL_SAFE_NO_PAD
        .decode(text)
        .map_err(|_| anyhow!(INVALID_CURSOR))?;
    let cursor: Cursor = serde_json::from_slice(&bytes).map_err(|_| anyhow!(INVALID_CURSOR))?;
    ensure!(cursor.v == 1 && oid(&cursor.head), INVALID_CURSOR);
    Ok(Some(cursor))
}

// Replace refs, grafts and a shallow boundary can change the parents of a fixed OID.
async fn graph_signature(root: &str) -> Result<String> {
    let mut signature = checked(
        root,
        &[
            "for-each-ref",
            "--format=%(refname)%00%(objectname)%00",
            "refs/replace/",
        ],
        None,
    )
    .await?;
    let common = checked(
        root,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        None,
    )
    .await?;
    for name in ["shallow", "info/grafts"] {
        let file = match std::fs::File::open(
            Path::new(common.trim_end_matches(['\r', '\n'])).join(name),
        ) {
            Ok(file) => file,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => continue,
            Err(err) => return Err(err.into()),
        };
        let mut bytes = Vec::new();
        file.take(4 * 1024 * 1024 + 1).read_to_end(&mut bytes)?;
        ensure!(
            bytes.len() <= 4 * 1024 * 1024,
            "Git 历史边界过大，请在原生终端检查。"
        );
        signature.push_str(&format!("\0{name}:{}", hash(bytes)));
    }
    Ok(hash(signature))
}

async fn summaries(root: &str, options: &[&str], head: &str) -> Result<Vec<Value>> {
    let mut args = LOG_OPTIONS.to_vec();
    args.extend_from_slice(options);
    args.extend([head, "--"]);
    let raw = checked(root, &args, None).await?;
    if raw.is_empty() {
        return Ok(Vec::new());
    }
    let fields: Vec<_> = raw
        .strip_suffix('\0')
        .ok_or_else(|| anyhow!("Git 提交记录不完整"))?
        .split('\0')
        .collect();
    ensure!(fields.len() % 4 == 0, "Git 提交记录不完整");
    fields
        .chunks_exact(4)
        .map(|row| {
            ensure!(oid(row[0]), "Git 提交记录无效");
            Ok(json!({"hash":row[0],"subject":row[1],"author":row[2],"committedAt":row[3]}))
        })
        .collect()
}

async fn is_ancestor(root: &str, candidate: &str, head: &str) -> Result<bool> {
    let result = git(
        root,
        &["merge-base", "--is-ancestor", candidate, head],
        None,
        8192,
    )
    .await?;
    match result.code {
        0 => Ok(true),
        1 => Ok(false),
        _ => bail!("无法读取提交历史：{}", result.stderr.trim()),
    }
}

pub(super) async fn read(root: &str, input: &Value) -> Result<Value> {
    let query = match &input["query"] {
        Value::Null => "",
        Value::String(s) => s.trim(),
        _ => bail!("搜索条件无效"),
    };
    ensure!(
        query.len() <= 2048 && !query.contains(['\0', '\r', '\n']),
        "搜索内容过长或包含无效字符"
    );
    let limit = if input["limit"].is_null() {
        50
    } else {
        input["limit"]
            .as_u64()
            .filter(|n| (1..=100).contains(n))
            .ok_or_else(|| anyhow!("每页提交数应为 1 到 100"))?
    };
    let cursor = decode_cursor(&input["cursor"])?;
    let symbolic = git(root, &["symbolic-ref", "--quiet", "HEAD"], None, 8192).await?;
    ensure!(matches!(symbolic.code, 0 | 1), "无法读取 Git 分支");
    let target = if symbolic.code == 0 {
        symbolic.stdout.trim()
    } else {
        "HEAD"
    };
    let revision = format!("{target}^{{commit}}");
    let live = git(
        root,
        &["rev-parse", "--verify", "--quiet", &revision],
        None,
        8192,
    )
    .await?;
    if live.code != 0 {
        if symbolic.code == 0
            && git(
                root,
                &["show-ref", "--verify", "--quiet", target],
                None,
                8192,
            )
            .await?
            .code
                == 1
        {
            ensure!(cursor.is_none(), STALE_CURSOR);
            return Ok(json!({"rootPath":root,"reference":target,"query":query,"items":[]}));
        }
        bail!("无法读取当前提交，请检查原生 Git 状态。");
    }
    let current_head = live.stdout.trim();
    ensure!(oid(current_head), "Git 当前提交无效");
    let mut page =
        json!({"rootPath":root, "reference":target, "query":query, "head":current_head, "currentHead":current_head});
    if cursor.is_none()
        && (4..=64).contains(&query.len())
        && query.bytes().all(|b| b.is_ascii_hexdigit())
    {
        let prefix = query.to_ascii_lowercase();
        let revision = format!("{prefix}^{{commit}}");
        let found = git(
            root,
            &["rev-parse", "--verify", "--quiet", &revision],
            None,
            8192,
        )
        .await?;
        let candidate = found.stdout.trim();
        if found.code == 0 && oid(candidate) && candidate.starts_with(&prefix) {
            page["items"] = json!(if is_ancestor(root, candidate, current_head).await? {
                summaries(root, &["-1"], candidate).await?
            } else {
                vec![]
            });
            return Ok(page);
        }
    }

    let reference = if symbolic.code == 0 {
        target.to_owned()
    } else {
        format!("HEAD@{current_head}")
    };
    let root_hash = hash(if cfg!(windows) {
        root.to_lowercase()
    } else {
        root.to_owned()
    });
    let query_hash = hash(query);
    let graph = graph_signature(root).await?;
    let (head, offset) = match cursor {
        Some(c) => {
            ensure!(
                c.root == root_hash
                    && c.reference == reference
                    && c.query == query_hash
                    && c.graph == graph,
                STALE_CURSOR
            );
            ensure!(
                c.head == current_head || is_ancestor(root, &c.head, current_head).await?,
                STALE_CURSOR
            );
            (c.head, c.offset)
        }
        None => (current_head.to_owned(), 0),
    };
    let count = format!("--max-count={}", limit + 1);
    let skip = format!("--skip={offset}");
    let grep = format!("--grep={query}");
    let mut options = vec![count.as_str(), skip.as_str()];
    if !query.is_empty() {
        options.extend(["--fixed-strings", "--regexp-ignore-case", &grep]);
    }
    let mut items = summaries(root, &options, &head).await?;
    page["head"] = json!(head);
    if items.len() > limit as usize {
        items.truncate(limit as usize);
        let next = Cursor {
            v: 1,
            root: root_hash,
            reference,
            query: query_hash,
            graph,
            head,
            offset: offset
                .checked_add(items.len() as u32)
                .ok_or_else(|| anyhow!(INVALID_CURSOR))?,
        };
        page["nextCursor"] = json!(URL_SAFE_NO_PAD.encode(serde_json::to_vec(&next)?));
    }
    page["items"] = json!(items);
    Ok(page)
}
