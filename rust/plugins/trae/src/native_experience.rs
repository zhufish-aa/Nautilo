//! This harness owns its transport and native capability declarations.
use agenthub_plugin_sdk::capabilities::profile;
use serde_json::{json, Value};
pub fn declarations() -> Value {
    let mut native = profile("native-cli", false, &["approval", "question"], false, false, false, false);
    native["resources"]["managedSkills"] = json!("unknown");
    json!({"default": native, "variants": []})
}
