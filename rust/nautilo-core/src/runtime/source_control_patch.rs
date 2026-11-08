use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashSet;

#[derive(Clone)]
struct Row {
    sign: u8,
    text: String,
    no_newline: bool,
    line: usize,
}
struct Hunk {
    id: String,
    header: String,
    start: usize,
    end: usize,
    old_start: usize,
    new_start: usize,
    rows: Vec<Row>,
}
struct Parsed {
    hunks: Vec<Hunk>,
    kind: &'static str,
    mode: String,
}
fn hash(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}
pub fn token(path: &str, source: &str, patch: &str, file_token: Option<&str>) -> String {
    hash(&[path, source, patch, file_token.unwrap_or("")].join("\0"))
}
fn parse(patch: &str, path: &str, source: &str) -> anyhow::Result<Parsed> {
    let lines = patch.split_inclusive('\n').collect::<Vec<_>>();
    if lines
        .iter()
        .filter(|line| line.starts_with("diff --git "))
        .count()
        != 1
        || lines.iter().any(|line| {
            [
                "old mode ",
                "new mode ",
                "rename ",
                "copy ",
                "GIT binary patch",
                "Binary files",
            ]
            .iter()
            .any(|prefix| line.starts_with(prefix))
        })
    {
        anyhow::bail!("此差异不支持逐块操作，请使用整文件操作。");
    }
    let creation = lines.iter().find(|line| line.starts_with("new file mode "));
    let deletion = lines
        .iter()
        .find(|line| line.starts_with("deleted file mode "));
    let mode = creation
        .or(deletion)
        .or_else(|| lines.iter().find(|line| line.starts_with("index ")))
        .and_then(|line| line.split_whitespace().last())
        .unwrap_or("100644")
        .to_string();
    if matches!(mode.as_str(), "120000" | "160000") {
        anyhow::bail!("此文件类型不支持逐块操作。");
    }
    static HEADER: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let header = HEADER
        .get_or_init(|| regex::Regex::new(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@").unwrap());
    let mut hunks = Vec::new();
    let mut cursor = 0;
    while cursor < lines.len() {
        if !lines[cursor].starts_with("@@ ") {
            cursor += 1;
            continue;
        }
        let start = cursor;
        let captures = header
            .captures(lines[cursor])
            .ok_or_else(|| anyhow::anyhow!("差异区块格式无效。"))?;
        let mut rows = Vec::<Row>::new();
        let mut old_count = 0;
        let mut new_count = 0;
        while cursor + 1 < lines.len() && !lines[cursor + 1].starts_with("@@ ") {
            cursor += 1;
            let line = lines[cursor];
            if line.starts_with("\\ ") {
                rows.last_mut()
                    .ok_or_else(|| anyhow::anyhow!("差异换行标记无效。"))?
                    .no_newline = true;
                continue;
            }
            let sign = line.as_bytes()[0];
            if !matches!(sign, b' ' | b'+' | b'-') {
                anyhow::bail!("差异正文格式无效。");
            }
            if sign != b'+' {
                old_count += 1;
            }
            if sign != b'-' {
                new_count += 1;
            }
            rows.push(Row {
                sign,
                text: line[1..].into(),
                no_newline: false,
                line: cursor + 1,
            });
        }
        let expected_old = captures
            .get(2)
            .map(|value| value.as_str())
            .unwrap_or("1")
            .parse::<usize>()?;
        let expected_new = captures
            .get(4)
            .map(|value| value.as_str())
            .unwrap_or("1")
            .parse::<usize>()?;
        if old_count != expected_old || new_count != expected_new {
            anyhow::bail!("差异区块不完整，请刷新后重试。");
        }
        hunks.push(Hunk {
            id: hash(&[path, source, &lines[start..=cursor].concat()].join("\0")),
            header: lines[start].trim_end().into(),
            start: start + 1,
            end: cursor + 1,
            old_start: captures[1].parse()?,
            new_start: captures[3].parse()?,
            rows,
        });
        cursor += 1;
    }
    if hunks.is_empty() {
        anyhow::bail!("没有可操作的文本区块。");
    }
    Ok(Parsed {
        hunks,
        kind: if creation.is_some() {
            "new"
        } else if deletion.is_some() {
            "deleted"
        } else {
            "modified"
        },
        mode,
    })
}
pub fn describe(patch: &str, path: &str, source: &str) -> anyhow::Result<Value> {
    Ok(json!(parse(patch,path,source)?.hunks.iter().map(|hunk|json!({"id":hunk.id,"header":hunk.header,"startLine":hunk.start,"endLine":hunk.end})).collect::<Vec<_>>()))
}
fn quote(value: &str) -> String {
    let mut result = String::from("\"");
    for character in value.chars() {
        match character {
            '"' => result.push_str("\\\""),
            '\\' => result.push_str("\\\\"),
            c if (c as u32) < 32 || c == '\u{7f}' => {
                result.push_str(&format!("\\{:03o}", c as u32))
            }
            c => result.push(c),
        }
    }
    result.push('"');
    result
}
pub fn select(
    patch: &str,
    path: &str,
    source: &str,
    hunk_ids: &[String],
    selected_lines: &[usize],
) -> anyhow::Result<String> {
    let parsed = parse(patch, path, source)?;
    let mut selected = selected_lines.iter().copied().collect::<HashSet<_>>();
    let valid = parsed
        .hunks
        .iter()
        .flat_map(|hunk| {
            hunk.rows
                .iter()
                .filter(|row| row.sign != b' ')
                .map(|row| row.line)
        })
        .collect::<HashSet<_>>();
    if hunk_ids
        .iter()
        .any(|id| !parsed.hunks.iter().any(|hunk| &hunk.id == id))
        || selected_lines.iter().any(|line| !valid.contains(line))
    {
        anyhow::bail!("选择的差异已失效，请刷新后重试。");
    }
    for hunk in &parsed.hunks {
        if hunk_ids.contains(&hunk.id) {
            selected.extend(
                hunk.rows
                    .iter()
                    .filter(|row| row.sign != b' ')
                    .map(|row| row.line),
            );
        }
    }
    if selected.is_empty() {
        anyhow::bail!("请选择需要操作的区块或更改行。");
    }
    let reverse = source == "index";
    let kind = if reverse {
        match parsed.kind {
            "new" => "deleted",
            "deleted" => "new",
            _ => "modified",
        }
    } else {
        parsed.kind
    };
    let mut delta = 0isize;
    let mut complete_deletion = kind == "deleted";
    let mut body = String::new();
    for hunk in &parsed.hunks {
        let raw = hunk
            .rows
            .iter()
            .cloned()
            .map(|mut row| {
                if reverse {
                    row.sign = match row.sign {
                        b'+' => b'-',
                        b'-' => b'+',
                        _ => b' ',
                    };
                }
                row
            })
            .collect::<Vec<_>>();
        let mut oriented = Vec::new();
        let mut cursor = 0;
        while cursor < raw.len() {
            if raw[cursor].sign == b' ' {
                oriented.push(raw[cursor].clone());
                cursor += 1;
                continue;
            }
            let start = cursor;
            while cursor < raw.len() && raw[cursor].sign != b' ' {
                cursor += 1;
            }
            let removed = raw[start..cursor]
                .iter()
                .filter(|row| row.sign == b'-')
                .collect::<Vec<_>>();
            let added = raw[start..cursor]
                .iter()
                .filter(|row| row.sign == b'+')
                .collect::<Vec<_>>();
            for index in 0..removed.len().max(added.len()) {
                if let Some(row) = removed.get(index) {
                    oriented.push((*row).clone());
                }
                if let Some(row) = added.get(index) {
                    oriented.push((*row).clone());
                }
            }
        }
        if oriented
            .iter()
            .any(|row| row.sign == b'-' && !selected.contains(&row.line))
        {
            complete_deletion = false;
        }
        if !oriented
            .iter()
            .any(|row| row.sign != b' ' && selected.contains(&row.line))
        {
            continue;
        }
        let rows = oriented
            .into_iter()
            .filter_map(|mut row| {
                if row.sign == b'+' && !selected.contains(&row.line) {
                    return None;
                }
                if row.sign == b'-' && !selected.contains(&row.line) {
                    row.sign = b' ';
                }
                Some(row)
            })
            .collect::<Vec<_>>();
        let old_count = rows.iter().filter(|row| row.sign != b'+').count();
        let new_count = rows.iter().filter(|row| row.sign != b'-').count();
        let old_start = if reverse {
            hunk.new_start
        } else {
            hunk.old_start
        };
        let anchor = old_start as isize - if old_count > 0 { 1 } else { 0 } + delta;
        if anchor < 0 {
            anyhow::bail!("差异区块位置无效。");
        }
        let new_start = anchor + if new_count > 0 { 1 } else { 0 };
        body.push_str(&format!(
            "@@ -{old_start},{old_count} +{new_start},{new_count} @@\n"
        ));
        let last_new = rows.iter().rposition(|row| row.sign != b'-');
        for (index, row) in rows.iter().enumerate() {
            let text = if row.text.ends_with('\n') {
                row.text.clone()
            } else {
                row.text.clone() + "\n"
            };
            let new_no_newline = row.no_newline && last_new == Some(index);
            if row.sign == b' ' && row.no_newline && !new_no_newline {
                body.push('-');
                body.push_str(&text);
                body.push_str("\\ No newline at end of file\n+");
                body.push_str(&text);
            } else {
                body.push(row.sign as char);
                body.push_str(&text);
                if row.no_newline && (row.sign == b'-' || new_no_newline) {
                    body.push_str("\\ No newline at end of file\n");
                }
            }
        }
        delta += new_count as isize - old_count as isize;
    }
    let mut result = format!(
        "diff --git {} {}\n",
        quote(&format!("a/{path}")),
        quote(&format!("b/{path}"))
    );
    if kind == "new" {
        result.push_str(&format!("new file mode {}\n", parsed.mode));
    } else if complete_deletion {
        result.push_str(&format!("deleted file mode {}\n", parsed.mode));
    }
    result.push_str(&format!(
        "--- {}\n+++ {}\n",
        if kind == "new" {
            "/dev/null".into()
        } else {
            quote(&format!("a/{path}"))
        },
        if complete_deletion {
            "/dev/null".into()
        } else {
            quote(&format!("b/{path}"))
        }
    ));
    result.push_str(&body);
    Ok(result)
}
