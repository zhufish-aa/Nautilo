//! This harness owns its transport and native capability declarations.
use agenthub_plugin_sdk::capabilities::profile;
use serde_json::{json, Value};
pub fn declarations() -> Value {
    json!({"default":profile("ndjson",false,&[],false,true,false,true),"variants":[]})
}
