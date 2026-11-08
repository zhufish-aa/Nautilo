//! This harness owns its transport and native capability declarations.
use agenthub_plugin_sdk::capabilities::profile;
use serde_json::{json, Value};
pub fn declarations() -> Value {
    json!({"evidenceSource":"adapter-contract","default":profile("stream-json",true,&["approval","question","plan"],true,true,true,false),"variants":[]})
}
