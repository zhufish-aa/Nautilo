//! This harness owns its transport and native capability declarations.
use agenthub_plugin_sdk::capabilities::profile;
use serde_json::{json, Value};
pub fn declarations() -> Value {
    let acp = profile("acp", true, &["approval"], false, true, true, false);
    let stream = profile("stream-json", false, &[], false, true, false, false);
    json!({"evidenceSource":"adapter-contract","default":acp,"variants":[
        {"when":{"pointer":"/providerOptions/runtimeConnectionId","nonempty":true},"profile":stream},
        {"when":{"pointer":"/baseArgs","nonempty":true},"profile":stream},
        {"when":{"pointer":"/providerOptions/loginProfileDirectory","nonempty":true},"profile":acp}
    ]})
}
