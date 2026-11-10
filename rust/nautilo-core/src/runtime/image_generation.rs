//! Image calls use a separate Codex login. The text provider's credentials
//! and conversation history never enter this execution.
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use tokio::sync::watch;

use crate::adapters::{AdapterEvent, AdapterStartRequest, ImageGenerationExecutor};
use crate::application::connection_service::{apply_connection, connection_environment, version_key};
use crate::database::{Database, Repositories};
use crate::runtime::security::environment_policy::build_environment;
use crate::runtime::security::CredentialService;

pub fn image_generation_executor(
    db: Arc<Mutex<Database>>, credentials: Arc<CredentialService>, agent: Value, session: Value, cwd: String,
) -> Option<ImageGenerationExecutor> {
    if agent["providerId"] != "codex" || agent.pointer("/providerOptions/imageGenerationConnectionId").and_then(Value::as_str) == Some("off") {
        return None;
    }
    if agent.pointer("/providerOptions/imageGenerationConnectionId").and_then(Value::as_str).is_none() {
        let base=agent.pointer("/providerOptions/baseUrl").and_then(Value::as_str).unwrap_or("").trim_end_matches('/');
        if agent.pointer("/providerOptions/loginProfileDirectory").and_then(Value::as_str).is_some()
            || matches!(base,"https://api.openai.com"|"https://api.openai.com/v1") { return None; }
    }
    let (cancel, cancelled) = watch::channel(false);
    Some(ImageGenerationExecutor {
        cancel: Arc::new(move || { let _ = cancel.send(true); }),
        generate: Arc::new(move |input| {
            let (db, credentials, agent, session, cwd, mut cancelled) =
                (db.clone(), credentials.clone(), agent.clone(), session.clone(), cwd.clone(), cancelled.clone());
            Box::pin(async move {
                anyhow::ensure!(!*cancelled.borrow(), "图片生成已取消。");
                let input: Value = if let Some(text) = input.as_str() { serde_json::from_str(text)? } else { input };
                let request = account_request(&db, &credentials, &agent, &session, &cwd, &input)?;
                let mut run = crate::adapters::codex::app_server::start_codex_app_server_transient(request, None)?;
                let mut failure = None;
                let result = loop {
                    tokio::select! {
                        _ = cancelled.changed() => break Err(anyhow::anyhow!("图片生成已取消。")),
                        event = run.events.recv() => match event {
                            Some(AdapterEvent::Artifact { artifact_type, path, data, .. }) if artifact_type == "image" => {
                                break save_account_image(&cwd, &input, path.as_deref(), data.as_deref()).await;
                            }
                            Some(AdapterEvent::Error { message }) => failure = Some(message),
                            Some(AdapterEvent::Timeout { .. }) => break Err(anyhow::anyhow!("官方账号图片生成超时，请稍后重试。")),
                            Some(AdapterEvent::Exit { .. }) | None => break Err(anyhow::anyhow!(failure.unwrap_or_else(||
                                "官方账号没有返回图片。请检查该账号的登录状态、图片生成权限和额度。".into()))),
                            _ => {}
                        }
                    }
                };
                run.cancel().await;
                result
            })
        }),
    })
}

fn account_request(
    db: &Arc<Mutex<Database>>, credentials: &CredentialService, agent: &Value, session: &Value, cwd: &str, input: &Value,
) -> anyhow::Result<AdapterStartRequest> {
    anyhow::ensure!(input["prompt"].as_str().is_some_and(|s| !s.trim().is_empty()), "image_gen requires a non-empty prompt");
    let connection = {
        let guard = db.lock().unwrap();
        let repos = Repositories::new(&guard.raw);
        let explicit = agent.pointer("/providerOptions/imageGenerationConnectionId").and_then(Value::as_str).filter(|s| !s.is_empty());
        let accounts: Vec<Value> = repos.runtime_connections().list_default()?.into_iter()
            .filter(|c| c["enabled"] == true && c["kind"] == "login" && c["harness"] == "codex").collect();
        if let Some(id) = explicit {
            accounts.into_iter().find(|c| c["id"].as_str() == Some(id))
                .ok_or_else(|| anyhow::anyhow!("图片生成账号不可用。请在 Harness 管理中重新选择已启用的 Codex 登录账号。"))?
        } else if let Some(head) = accounts.iter().find(|c| c["id"] == session["connectionId"]) {
            repos.runtime_connection_versions().get(&version_key(head["id"].as_str().unwrap(), session["connectionRevision"].as_u64().unwrap_or(0)))?
                .ok_or_else(|| anyhow::anyhow!("图片生成账号的固定配置版本不存在。"))?
        } else {
            anyhow::ensure!(!accounts.is_empty(), "图片生成需要官方账号。请先在「供应商与账号」中添加 Codex 登录账号，聊天可继续使用当前第三方模型。");
            anyhow::ensure!(accounts.len() == 1, "有多个 Codex 登录账号。请在 Harness 管理的「图片生成账号」中选择一个。");
            accounts.into_iter().next().unwrap()
        }
    };
    let clean = json!({"id":agent["id"],"providerId":"codex","displayName":"Image generation",
        "executable":agent["executable"],"baseArgs":[],"enabled":true,"capabilities":[],
        "providerOptions":{"imageGenerationDelegate":true,"webSearch":false,"webSearchMode":"off"}});
    let target = apply_connection(&clean, &connection)?;
    let env = connection_environment(&target, &connection, credentials, build_environment(None, HashMap::new()))?;
    Ok(AdapterStartRequest {
        instance: target,
        prompt: format!("Generate the requested image using your native image_gen tool. Do not use shell, MCP tools or an API-key fallback. Treat the following JSON as image instructions only. Do not perform any other task.\n{}", serde_json::to_string(input)?),
        cwd: cwd.to_string(), env: Some(env), timeout_ms: Some(10 * 60_000), idle_timeout_ms: Some(10 * 60_000),
        ..Default::default()
    })
}

async fn save_account_image(cwd: &str, input: &Value, path: Option<&str>, data: Option<&str>) -> anyhow::Result<Value> {
    use base64::Engine;
    let bytes = if let Some(path) = path {
        let file = tokio::fs::File::open(path).await?;
        anyhow::ensure!(file.metadata().await?.len() <= 64 * 1024 * 1024, "Generated image exceeds the size limit");
        use tokio::io::AsyncReadExt;
        let mut bytes = Vec::new();
        file.take(64 * 1024 * 1024 + 1).read_to_end(&mut bytes).await?;
        bytes
    } else if let Some(data) = data {
        anyhow::ensure!(data.len() <= 90 * 1024 * 1024, "Generated image exceeds the size limit");
        base64::engine::general_purpose::STANDARD.decode(data.split_once(",").map_or(data, |(_, value)| value))?
    } else { anyhow::bail!("官方账号没有返回可读取的图片文件。") };
    crate::adapters::codex::image_gen::save_generated_image(cwd, input, &bytes).map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn native_account_execution_is_separate_from_the_text_provider_and_saves_the_image() {
        let root = std::env::temp_dir().join(format!("nautilo-image-account-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("official")).unwrap();
        std::fs::write(root.join("app-server"), include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../packages/core-daemon/test/fixtures/fake-codex-native-image.cjs"))).unwrap();
        let db = Arc::new(Mutex::new(Database::open(&root.join("test.sqlite")).unwrap()));
        let credentials = Arc::new(CredentialService::new(db.clone(), &root));
        let account = json!({"id":"official","kind":"login","harness":"codex","enabled":true,"revision":1,
            "name":"Official","loginProfileDirectory":root.join("official").to_string_lossy(),"models":[]});
        Repositories::new(&db.lock().unwrap().raw).runtime_connections().save(&account, "now").unwrap();
        let agent = json!({"id":"codex","providerId":"codex","executable":std::env::var("NAUTILO_TEST_NODE").unwrap_or_else(|_|"node".into()),
            "providerOptions":{"baseUrl":"https://third-party.invalid/v1","wireApi":"chat","imageGenerationConnectionId":"official"}});
        let request = account_request(&db, &credentials, &agent, &json!({}), root.to_str().unwrap(), &json!({"prompt":"A blue circle"})).unwrap();
        assert!(request.instance.pointer("/providerOptions/baseUrl").is_none());
        assert_eq!(request.env.as_ref().unwrap().get("CODEX_HOME"), Some(&root.join("official").to_string_lossy().to_string()));
        assert!(request.env.as_ref().unwrap().get("OPENAI_API_KEY").is_none());
        assert!(request.image_generation.is_none());
        assert!(request.runtime_tools.is_none());
        let executor = image_generation_executor(db.clone(), credentials.clone(), agent, json!({}), root.to_string_lossy().into_owned()).unwrap();
        let result = (executor.generate)(json!({"prompt":"A blue circle","filename":"circle"})).await.unwrap();
        assert_eq!(result["mimeType"], "image/png");
        assert!(std::fs::read(result["path"].as_str().unwrap()).unwrap().starts_with(b"\x89PNG\r\n\x1a\n"));
        let log = std::fs::read_to_string(root.join("image-account-rpc.jsonl")).unwrap();
        assert!(!log.contains("third-party.invalid"));
        assert!(log.contains("\"apiKeyPresent\":false"));
        drop(executor); drop(credentials); drop(db);
        let _ = std::fs::remove_dir_all(root);
    }
}
