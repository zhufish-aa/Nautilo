//! Authentication checks use the selected CLI and its isolated environment.
use crate::{
    adapters::AdapterStartRequest,
    errors::{CoreError, CoreResult, ErrorCode},
    process_runtime::{ProcessEvent, ProcessRequest, ProcessRuntime},
};
use serde_json::Value;

pub fn is_authentication_error(message: &str) -> bool {
    let message = message.to_ascii_lowercase();
    [
        "agent_not_authenticated",
        "authentication required",
        "not logged in",
        "signed out",
        "sign in again",
        "sign in to this account again",
        "401 unauthorized",
        "http 401",
        "status 401",
        "token_expired",
        "token has expired",
        "invalid_grant",
        "refresh_token_reused",
        "refresh_token_expired",
        "refresh_token_revoked",
        "missing bearer or basic authentication",
    ]
    .iter()
    .any(|text| message.contains(text))
}

pub fn required(connection: &Value) -> CoreError {
    let mut error = CoreError::new(ErrorCode::AgentNotAuthenticated);
    error.0.message = format!(
        "账号“{}”登录已失效，请重新登录。",
        connection["name"].as_str().unwrap_or("当前账号")
    );
    error.0.user_action = "打开供应商与账号，重新登录此账号后重试。".into();
    error.0.details = serde_json::json!({"connectionId": connection["id"]})
        .as_object()
        .cloned();
    error
}

pub async fn check_native_login(
    connection: &Value,
    request: &AdapterStartRequest,
) -> CoreResult<()> {
    let provider = connection["harness"].as_str().unwrap_or("");
    let command = request.instance["executable"].as_str().unwrap_or(provider);
    let mut args: Vec<String> = request.instance["baseArgs"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect();
    args.extend(match provider {
        "codex" => ["login", "status"].map(str::to_owned).to_vec(),
        "claude-code" => ["auth", "status", "--json"].map(str::to_owned).to_vec(),
        _ => return Ok(()),
    });
    let (command, args) = if provider == "codex" {
        crate::adapters::codex::resolve_codex_invocation(
            command,
            &args,
            request
                .env
                .as_ref()
                .and_then(|env| env.get("PATH"))
                .map(String::as_str),
        )
    } else {
        (command.to_owned(), args)
    };
    let mut process = ProcessRuntime::start(&ProcessRequest {
        command,
        args,
        cwd: Some(request.cwd.clone()),
        env: request.env.clone(),
        timeout_ms: Some(8_000),
        max_output_bytes: Some(64 * 1024),
        ..Default::default()
    })
    .map_err(|e| CoreError::reason(ErrorCode::RunStartFailed, e.to_string()))?;
    let mut output = String::new();
    let mut exit = None;
    while let Some(event) = process.events.recv().await {
        match event {
            ProcessEvent::Stdout(text) | ProcessEvent::Stderr(text) => output.push_str(&text),
            ProcessEvent::Exit { exit_code, .. } => exit = exit_code,
            ProcessEvent::Timeout { .. } => {
                return Err(CoreError::reason(
                    ErrorCode::RunStartFailed,
                    "账号登录状态检查超时，请重试。",
                ))
            }
            _ => {}
        }
    }
    let signed_out = is_authentication_error(&output)
        || serde_json::from_str::<Value>(output.trim())
            .ok()
            .is_some_and(|value| value["loggedIn"] == false);
    if signed_out {
        return Err(required(connection));
    }
    if exit == Some(0) {
        return Ok(());
    }
    Err(CoreError::reason(
        ErrorCode::RunStartFailed,
        "无法检查所选账号的登录状态，请查看原生 CLI 是否正常。",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn auth_failures_are_distinct_from_transport_and_history_errors() {
        for error in [
            "HTTP 401",
            "Not logged in",
            "refresh_token_expired",
            "Missing bearer or basic authentication in header",
        ] {
            assert!(is_authentication_error(error));
        }
        for error in [
            "Connection error",
            "HTTP 500",
            "409 NATIVE_CONVERSATION_DIVERGED",
            "quota exceeded",
        ] {
            assert!(!is_authentication_error(error));
        }
        let error = required(&serde_json::json!({"id":"account-1","name":"工作账号"}));
        assert_eq!(error.0.code, "AGENT_NOT_AUTHENTICATED");
        assert_eq!(error.0.details.unwrap()["connectionId"], "account-1");
        assert!(!error.0.retryable);
    }
}
