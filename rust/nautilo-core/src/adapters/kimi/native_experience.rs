//! This harness owns its transport and native capability declarations.
use agenthub_plugin_sdk::capabilities::profile;
use serde_json::{json, Value};
pub fn declarations() -> Value {
    json!({"evidenceSource":"adapter-contract","default":profile("acp",true,&["approval"],false,true,true,false),"variants":[{"when":{"pointer":"/providerOptions/runtimeConnectionId","nonempty":true},"profile":profile("stream-json",false,&[],false,true,false,false)},{"when":{"pointer":"/baseArgs","nonempty":true},"profile":profile("stream-json",false,&[],false,true,false,false)}]})
}
