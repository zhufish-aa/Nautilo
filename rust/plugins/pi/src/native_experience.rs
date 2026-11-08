//! This harness owns its transport and native capability declarations.
use agenthub_plugin_sdk::capabilities::profile;
use serde_json::{json, Value};
pub fn declarations() -> Value {
    json!({"default":profile("rpc",true,&["confirm","select","input","editor"],true,true,true,true),"variants":[]})
}
