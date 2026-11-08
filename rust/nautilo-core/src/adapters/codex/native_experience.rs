//! This harness owns its transport and native capability declarations.
use agenthub_plugin_sdk::capabilities::profile;
use serde_json::{json, Value};
pub fn declarations() -> Value {
    json!({"evidenceSource":"adapter-contract","default":profile("app-server",true,&["approval","question","elicitation"],true,true,true,true),"variants":[{"when":{"pointer":"/baseArgs","nonempty":true},"profile":profile("exec-json",false,&[],false,true,false,true)}]})
}
