//! Native experience contract. Unknown capabilities are never advertised as false.
use serde_json::{json, Value};
pub fn describe(provider: &str, instance: &Value, legacy: &Value) -> Value {
    let api = instance
        .pointer("/providerOptions/runtimeConnectionId")
        .is_some();
    let (transport, resident, dialogs, steer, terminal) = match provider {
        "codex" => (
            "app-server",
            true,
            vec!["approval", "question", "elicitation"],
            true,
            true,
        ),
        "claude-code" => (
            "stream-json",
            true,
            vec!["approval", "question", "plan"],
            true,
            true,
        ),
        "kimi-code" if !api => ("acp", true, vec!["approval"], false, true),
        "kimi-code" => ("stream-json", false, vec![], false, true),
        "pi" | "omp" => (
            "rpc",
            true,
            vec!["confirm", "select", "input", "editor"],
            true,
            true,
        ),
        "opencode" => ("http-sse", true, vec!["approval", "question"], true, true),
        "deepseek" => (
            "native-web",
            true,
            vec!["approval", "question"],
            true,
            false,
        ),
        "commandcode" => ("ndjson", false, vec![], false, true),
        "trae" => ("native-cli", false, vec!["approval"], false, false),
        _ => ("custom", false, vec![], false, false),
    };
    let custom = instance["baseArgs"]
        .as_array()
        .is_some_and(|args| !args.is_empty());
    let (transport, resident, steer) = if custom && provider == "codex" {
        ("exec-json", false, false)
    } else if custom && (provider == "kimi-code" || provider == "opencode") {
        ("stream-json", false, false)
    } else {
        (transport, resident, steer)
    };
    let background = legacy["sessionBackgroundEvents"] == true
        || provider == "claude-code"
        || provider == "kimi-code" && transport == "acp"
        || provider == "codex" && transport == "app-server";
    json!({"schemaVersion":1,"providerId":provider,"evidence":{"source":"adapter-contract","cliVersion":instance.get("version").or_else(||instance.pointer("/providerOptions/detectedVersion"))},
        "session":{"transport":transport,"processReuse":resident,"resume":if legacy["nativeResume"]==true{"native"}else{"unknown"},"backgroundEvents":if background{"session"}else{"unknown"}},
        "turn":{"interrupt":if resident{"native-or-process"}else{"process"},"steer":if steer{"native"}else{"queued"}},
        "interactions":{"dialogs":dialogs,"nativeTerminal":terminal,"unknownRequests":"visible-error"},
        "resources":{"nativeConfig":if transport=="custom"{"unknown"}else{"preserved"},"managedMcp":if transport=="custom"{"unknown"}else{"merged"},"managedSkills":if transport=="custom"{"unknown"}else{"merged"}},
        "legacy":legacy})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn codex_background_contract_only_covers_the_resident_transport() {
        let resident = describe("codex", &json!({}), &json!({"nativeResume":true}));
        assert_eq!(resident["session"]["backgroundEvents"], "session");
        let custom = describe(
            "codex",
            &json!({"baseArgs":["exec","--json"]}),
            &json!({"nativeResume":true}),
        );
        assert_eq!(custom["session"]["transport"], "exec-json");
        assert_eq!(custom["session"]["backgroundEvents"], "unknown");
        assert_eq!(custom["session"]["processReuse"], false);
    }
}
