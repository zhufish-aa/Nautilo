//! This harness owns its transport and native capability declarations.
use agenthub_plugin_sdk::capabilities::profile;
use serde_json::{json, Value};
pub fn declarations() -> Value {
    json!({"default":profile("native-web",true,&["approval","question"],true,false,true,false),"variants":[]})
}
