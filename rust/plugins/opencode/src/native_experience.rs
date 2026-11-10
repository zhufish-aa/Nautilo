//! This harness owns its transport and native capability declarations.
use agenthub_plugin_sdk::capabilities::profile;
use serde_json::{json, Value};
pub fn declarations() -> Value {
    json!({"default":profile("http-sse",true,&["approval","question"],true,true,true,true),"variants":[{"when":{"pointer":"/baseArgs","nonempty":true},"profile":profile("stream-json",false,&[],false,true,false,false)}]})
}
