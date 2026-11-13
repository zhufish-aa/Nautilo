//! Portable data boundary, independent of configuration storage.
use serde_json::{json, Value};

pub(crate) fn portable(v: &Value) -> Value {
    match v {
        Value::Array(a) => json!(a.iter().map(portable).collect::<Vec<_>>()),
        Value::Object(o) => Value::Object(
            o.iter()
                .filter(|(k, _)| {
                    let k = k.replace(['_', '-'], "").to_ascii_lowercase();
                    ![
                        "apikey",
                        "accesstoken",
                        "refreshtoken",
                        "password",
                        "secret",
                        "authorization",
                        "credential",
                        "loginprofiledirectory",
                        "hascredential",
                    ]
                    .iter()
                    .any(|s| k.contains(s))
                })
                .map(|(k, v)| (k.clone(), portable(v)))
                .collect(),
        ),
        Value::String(s)
            if ["sk-", "ghp_", "github_pat_", "xoxb-"]
                .iter()
                .any(|p| s.starts_with(p)) =>
        {
            Value::Null
        }
        _ => v.clone(),
    }
}
