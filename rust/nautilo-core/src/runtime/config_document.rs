//! Surgical JSON/JSONC and TOML edits. Unrelated native keys and comments survive.
use crate::errors::{invalid, CoreResult};
use serde_json::{json, Value};

#[derive(Clone)]
struct Node {
    start: usize,
    end: usize,
    props: Vec<(String, Node)>,
}
fn whitespace(bytes: &[u8], i: &mut usize) -> CoreResult<()> {
    loop {
        while bytes.get(*i).is_some_and(|c| c.is_ascii_whitespace()) {
            *i += 1;
        }
        if bytes.get(*i..*i + 2) == Some(b"//") {
            while bytes.get(*i).is_some_and(|c| *c != b'\n') {
                *i += 1;
            }
        } else if bytes.get(*i..*i + 2) == Some(b"/*") {
            *i += 2;
            while bytes.get(*i..*i + 2) != Some(b"*/") {
                if *i >= bytes.len() {
                    return Err(invalid("config", "Unterminated config comment"));
                }
                *i += 1;
            }
            *i += 2;
        } else {
            return Ok(());
        }
    }
}
fn quoted(bytes: &[u8], i: &mut usize) -> CoreResult<()> {
    *i += 1;
    while let Some(c) = bytes.get(*i) {
        match c {
            b'\\' => *i += 2,
            b'"' => {
                *i += 1;
                return Ok(());
            }
            _ => *i += 1,
        }
    }
    Err(invalid("config", "Unterminated config string"))
}
fn node(text: &str, i: &mut usize, depth: usize) -> CoreResult<Node> {
    if depth > 64 {
        return Err(invalid("config", "Config nesting limit exceeded"));
    }
    let b = text.as_bytes();
    whitespace(b, i)?;
    let start = *i;
    let mut props = vec![];
    match b.get(*i) {
        Some(b'{') => {
            *i += 1;
            loop {
                whitespace(b, i)?;
                if b.get(*i) == Some(&b'}') {
                    *i += 1;
                    break;
                }
                let k = *i;
                if b.get(*i) != Some(&b'"') {
                    return Err(invalid("config", "Expected an object key"));
                }
                quoted(b, i)?;
                let key: String = serde_json::from_str(&text[k..*i])
                    .map_err(|e| invalid("config", &e.to_string()))?;
                whitespace(b, i)?;
                if b.get(*i) != Some(&b':') {
                    return Err(invalid("config", "Expected a colon"));
                }
                *i += 1;
                let value = node(text, i, depth + 1)?;
                props.push((key, value));
                whitespace(b, i)?;
                match b.get(*i) {
                    Some(b',') => *i += 1,
                    Some(b'}') => {}
                    _ => return Err(invalid("config", "Expected a comma or closing brace")),
                }
            }
        }
        Some(b'[') => {
            *i += 1;
            loop {
                whitespace(b, i)?;
                if b.get(*i) == Some(&b']') {
                    *i += 1;
                    break;
                }
                node(text, i, depth + 1)?;
                whitespace(b, i)?;
                match b.get(*i) {
                    Some(b',') => *i += 1,
                    Some(b']') => {}
                    _ => return Err(invalid("config", "Expected an array separator")),
                }
            }
        }
        Some(b'"') => quoted(b, i)?,
        Some(_) => {
            while b
                .get(*i)
                .is_some_and(|c| !c.is_ascii_whitespace() && !b",]}".contains(c))
                && b.get(*i..*i + 2) != Some(b"/*")
                && b.get(*i..*i + 2) != Some(b"//")
            {
                *i += 1;
            }
            if *i == start {
                return Err(invalid("config", "Invalid value"));
            }
            serde_json::from_str::<Value>(&text[start..*i])
                .map_err(|e| invalid("config", &e.to_string()))?;
        }
        None => return Err(invalid("config", "Unexpected end of config")),
    }
    Ok(Node {
        start,
        end: *i,
        props,
    })
}
fn root(text: &str) -> CoreResult<Node> {
    let mut i = 0;
    let root = node(text, &mut i, 0)?;
    whitespace(text.as_bytes(), &mut i)?;
    if i != text.len() || text.as_bytes().get(root.start) != Some(&b'{') {
        return Err(invalid("config", "Config must be an object"));
    }
    Ok(root)
}
pub fn json_get(text: &str, path: &[&str]) -> CoreResult<Option<Value>> {
    let mut current = root(text)?;
    for key in path {
        let Some((_, child)) = current.props.iter().find(|(k, _)| k == key) else {
            return Ok(None);
        };
        current = child.clone();
    }
    // Strip comments and trailing commas only for the selected value's decode.
    let value = &text[current.start..current.end];
    let b = value.as_bytes();
    let mut i = 0;
    let mut clean = String::new();
    while i < b.len() {
        if b[i] == b'"' {
            let start = i;
            quoted(b, &mut i)?;
            clean.push_str(&value[start..i]);
        } else if b.get(i..i + 2) == Some(b"//") || b.get(i..i + 2) == Some(b"/*") {
            whitespace(b, &mut i)?;
        } else if b[i] == b',' {
            let mut next = i + 1;
            whitespace(b, &mut next)?;
            if !matches!(b.get(next), Some(b'}' | b']')) {
                clean.push(',');
            }
            i += 1;
        } else {
            let c = value[i..].chars().next().unwrap();
            clean.push(c);
            i += c.len_utf8();
        }
    }
    serde_json::from_str(&clean)
        .map(Some)
        .map_err(|e| invalid("config", &e.to_string()))
}
pub fn json_set(text: &str, path: &[&str], value: &Value) -> CoreResult<String> {
    let root = root(text)?;
    let mut current = &root;
    for (index, key) in path.iter().enumerate() {
        if let Some((_, next)) = current.props.iter().find(|(k, _)| k == key) {
            if index + 1 == path.len() {
                return Ok(format!(
                    "{}{}{}",
                    &text[..next.start],
                    serde_json::to_string_pretty(value).unwrap(),
                    &text[next.end..]
                ));
            }
            if text.as_bytes()[next.start] != b'{' {
                return Err(invalid("config", "MCP section is not an object"));
            }
            current = next;
        } else {
            let mut nested = value.clone();
            for segment in path[index + 1..].iter().rev() {
                nested = json!({*segment:nested});
            }
            let insert = current.end - 1;
            let key = serde_json::to_string(key).unwrap();
            let mut tail = current
                .props
                .last()
                .map(|(_, v)| v.end)
                .unwrap_or(current.start + 1);
            whitespace(text.as_bytes(), &mut tail)?;
            // Add the separator immediately after the last value, before any trailing comment.
            let mut out = text.to_string();
            let prefix = if current.props.is_empty() || text.as_bytes().get(tail) == Some(&b',') {
                ""
            } else {
                ","
            };
            out.insert_str(
                insert,
                &format!(
                    "\n  {key}: {}\n",
                    serde_json::to_string_pretty(&nested).unwrap()
                ),
            );
            if !prefix.is_empty() {
                out.insert_str(current.props.last().unwrap().1.end, prefix);
            }
            return Ok(out);
        }
    }
    Err(invalid("config", "Empty config edit path"))
}
pub fn toml_get(text: &str, path: &[&str]) -> CoreResult<Option<Value>> {
    let doc = text
        .parse::<toml_edit::DocumentMut>()
        .map_err(|e| invalid("config", &e.to_string()))?;
    let mut current = doc.as_item();
    for key in path {
        let Some(next) = current.get(key) else {
            return Ok(None);
        };
        current = next;
    }
    let wrapped = format!("value = {}", current);
    if current.is_value() {
        let parsed: Value =
            toml_edit::de::from_str(&wrapped).map_err(|e| invalid("config", &e.to_string()))?;
        Ok(parsed.get("value").cloned())
    } else {
        let parsed: Value = toml_edit::de::from_str(&current.to_string())
            .map_err(|e| invalid("config", &e.to_string()))?;
        Ok(Some(parsed))
    }
}
pub fn toml_set(text: &str, path: &[&str], value: &Value) -> CoreResult<String> {
    let mut doc = text
        .parse::<toml_edit::DocumentMut>()
        .map_err(|e| invalid("config", &e.to_string()))?;
    let replacement =
        toml_edit::ser::to_document(value).map_err(|e| invalid("config", &e.to_string()))?;
    let mut item = doc.as_item_mut();
    for key in path {
        if item.get(key).is_none() {
            item[key] = toml_edit::Item::Table(toml_edit::Table::new());
        }
        item = &mut item[key];
    }
    *item = toml_edit::Item::Table(replacement.as_table().clone());
    Ok(doc.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn jsonc_edits_preserve_unrelated_comments_and_unicode() {
        let text="{\n//keep root\n\"name\":\"中文\",\n\"mcpServers\":{/*keep*/\"native\":{\"command\":\"old\"},},\n\"other\":true,\n}";
        let next = json_set(text, &["mcpServers", "managed"], &json!({"command":"new"})).unwrap();
        assert_eq!(
            json_get(&next, &["mcpServers", "native"]).unwrap().unwrap()["command"],
            "old"
        );
        assert!(next.contains("/*keep*/"));
        assert!(next.contains("//keep root"));
        assert_eq!(json_get(&next, &["name"]).unwrap(), Some(json!("中文")));
    }
    #[test]
    fn toml_edits_preserve_native_sections() {
        let text = "# keep comment\nmodel = 'native'\n[mcp_servers.native]\ncommand='old'\n";
        let next = toml_set(
            text,
            &["mcp_servers", "managed"],
            &json!({"command":"new","args":["--x"]}),
        )
        .unwrap();
        assert!(next.contains("# keep comment"));
        assert!(next.contains("model = 'native'"));
        assert_eq!(
            toml_get(&next, &["mcp_servers", "managed"])
                .unwrap()
                .unwrap()["command"],
            "new"
        );
    }
}
