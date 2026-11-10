//! Provider-owned native experience declarations. No provider names are interpreted by this SDK.
use serde_json::{json, Value};
pub fn profile(
    transport: &str,
    resident: bool,
    dialogs: &[&str],
    steer: bool,
    terminal: bool,
    background: bool,
    history: bool,
) -> Value {
    json!({"schemaVersion":1,
        "session":{"transport":transport,"processReuse":resident,"backgroundEvents":if background{"session"}else{"unknown"},"history":if history{"native"}else{"unknown"}},
        "turn":{"interrupt":if resident{"native-or-process"}else{"process"},"steer":if steer{"native"}else{"queued"}},
        "interactions":{"dialogs":dialogs,"nativeTerminal":terminal,"unknownRequests":"visible-error"},
        "resources":{"nativeConfig":"preserved","managedMcp":"merged","managedSkills":"merged"}})
}
pub fn with_profile(mut legacy: Value, declarations: Value) -> Value {
    legacy["nativeExperience"] = declarations;
    legacy
}
/// The plugin supplies a default and ordered variants. Predicates use JSON pointers on the instance.
pub fn describe(provider: &str, instance: &Value, legacy: &Value) -> Value {
    let declarations = &legacy["nativeExperience"];
    let mut value=declarations.get("default").cloned().unwrap_or_else(||json!({"schemaVersion":1,
        "session":{"transport":"unknown","processReuse":false,"backgroundEvents":"unknown","history":"unknown"},
        "turn":{"interrupt":"process","steer":"queued"},"interactions":{"dialogs":[],"nativeTerminal":false,"unknownRequests":"visible-error"},
        "resources":{"nativeConfig":"unknown","managedMcp":"unknown","managedSkills":"unknown"}}));
    for variant in declarations["variants"].as_array().into_iter().flatten() {
        let predicate = &variant["when"];
        let actual = predicate["pointer"]
            .as_str()
            .and_then(|p| instance.pointer(p));
        let matches = if predicate["nonempty"] == true {
            actual.is_some_and(|v| {
                v.as_array().is_some_and(|a| !a.is_empty())
                    || v.as_str().is_some_and(|s| !s.is_empty())
                    || v.as_object().is_some_and(|o| !o.is_empty())
            })
        } else {
            actual.is_some_and(|v| predicate.get("equals") == Some(v))
        };
        if matches {
            value = variant["profile"].clone();
        }
    }
    value["providerId"] = json!(provider);
    value["session"]["resume"] = json!(if legacy["nativeResume"] == true {
        "native"
    } else {
        "unknown"
    });
    value["evidence"] = json!({"source":declarations["evidenceSource"].as_str().unwrap_or("plugin-contract"),"cliVersion":instance.get("version").or_else(||instance.pointer("/providerOptions/detectedVersion"))});
    value["legacy"] = legacy.clone();
    value
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn arbitrary_plugin_owns_its_profile_and_instance_variants() {
        let declared = with_profile(
            json!({"nativeResume":true}),
            json!({"default":profile("custom-wire",true,&["question"],true,true,true,true),"variants":[{"when":{"pointer":"/baseArgs","nonempty":true},"profile":profile("single",false,&[],false,true,false,false)}]}),
        );
        assert_eq!(
            describe("brand-new", &json!({}), &declared)["session"]["history"],
            "native"
        );
        let custom = describe("brand-new", &json!({"baseArgs":["run"]}), &declared);
        assert_eq!(custom["session"]["transport"], "single");
        assert_eq!(custom["session"]["backgroundEvents"], "unknown");
        assert_eq!(
            describe("codex", &json!({}), &json!({}))["session"]["transport"],
            "unknown"
        );
    }
}
