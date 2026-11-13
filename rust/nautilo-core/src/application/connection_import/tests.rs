use super::*;
use super::{document::Documents, locations::NativeLocation};
use crate::{adapters::registry::AdapterRegistry, database::Database};
use std::path::Path;

fn docs() -> Documents {
    Documents {
        env: HashMap::from([("FIXTURE_API_KEY".into(), "fixture-secret".into())]),
        reports: vec![],
    }
}
fn temp() -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("nautilo-native-import-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}
fn write(root: &Path, file: &str, text: &str) {
    let file = root.join(file);
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(file, text).unwrap();
}

#[test]
fn native_import_reads_codex_toml_profiles_and_never_projects_secrets() {
    let dir = temp();
    write(&dir,"config.toml","model_provider='work'\nmodel='one'\n[model_providers.work]\nbase_url='https://relay.example/v1'\nwire_api='responses'\nenv_key='FIXTURE_API_KEY'\n[profiles.fast]\nmodel_provider='work'\nmodel='two'\n");
    let original = std::fs::read(dir.join("config.toml")).unwrap();
    let mut d = docs();
    let mut out = Vec::new();
    parsers::codex(&mut d, &dir, &mut out);
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].secret.as_deref(), Some("fixture-secret"));
    assert_eq!(out[0].public["models"].as_array().unwrap().len(), 2);
    assert!(!out[0].public.to_string().contains("fixture-secret"));
    assert_eq!(std::fs::read(dir.join("config.toml")).unwrap(), original);
    std::fs::remove_dir_all(dir).unwrap();
}
#[test]
fn native_import_preserves_model_transport_and_rejects_key_helpers_and_oauth() {
    let d = docs();
    assert_eq!(
        d.key(
            &json!("{env:FIXTURE_API_KEY}"),
            &json!({"FIXTURE_API_KEY":"stored-key"}),
            Path::new(".")
        )
        .as_deref(),
        Some("stored-key")
    );
    let mut out = Vec::new();
    let cfg = json!({"providers":{"work":{"baseUrl":"https://relay.example/v1","apiKey":"${FIXTURE_API_KEY}","models":[{"id":"one","api":"openai-responses"},{"id":"two","api":"anthropic-messages","input":["text","image"]}]}}});
    parsers::provider_map(
        &d,
        "pi",
        Path::new("models.json"),
        &cfg,
        &Value::Null,
        &Value::Null,
        &mut out,
    );
    assert_eq!(out.len(), 2);
    assert_eq!(
        out.iter()
            .filter(|c| c.secret.as_deref() == Some("fixture-secret"))
            .count(),
        2
    );
    let anthropic = out
        .iter()
        .find(|c| c.public["protocol"] == "anthropic")
        .unwrap();
    assert_eq!(anthropic.public["baseUrl"], "https://relay.example");
    assert_eq!(
        anthropic.public["models"][0]["inputModalities"],
        json!(["text", "image"])
    );
    for key in [
        "!cat secret",
        "${UNKNOWN_KEY}",
        "{env:UNKNOWN_KEY}",
        "sk-ant-oat-test",
    ] {
        assert!(d.key(&json!(key), &Value::Null, Path::new(".")).is_none());
    }
}
#[test]
fn native_import_reads_yaml_jsonc_kimi_and_trae_without_aborting_on_broken_files() {
    let dir = temp();
    write(&dir,"profiles/desktop/cordis.patch.yml","- id: llm-pi-ai\n  config:\n    providers:\n      work:\n        api: openai-completions\n        baseURL: https://relay.example/v1\n        apiKeyEnv: PRIVATE_REF\n        models:\n          - id: model-one\n");
    write(&dir,".dsh/.credentials.yaml","version: 1\nrefs:\n  PRIVATE_REF: fixture-dsh-key\nrecords:\n  account:\n    token: never-import-this\n");
    write(&dir,"opencode.jsonc","{ // comment\n\"provider\":{\"relay\":{\"npm\":\"@ai-sdk/openai\",\"options\":{\"baseURL\":\"https://open.example/v1\",\"apiKey\":\"fixture-key\"},\"models\":{\"model-two\":{\"name\":\"Two\"}},},},}");
    write(&dir,"config.toml","[providers.local]\ntype='anthropic'\nbase_url='https://kimi.example'\napi_key='fixture-kimi-key'\n[models.local]\nprovider='local'\nmodel='kimi-model'\n");
    write(&dir,"trae_config.yaml","model_providers:\n  local:\n    provider: openai\n    base_url: https://trae.example/v1\n    api_key: fixture-trae-key\nmodels:\n  main:\n    model_provider: local\n    model: trae-model\n");
    write(&dir, "bad.jsonc", "{password: do-not-echo}");
    let locations = vec![
        NativeLocation {
            harness: "deepseek".into(),
            root: dir.join("profiles/desktop"),
            config: None,
        },
        NativeLocation {
            harness: "opencode".into(),
            root: dir.clone(),
            config: None,
        },
        NativeLocation {
            harness: "kimi-code".into(),
            root: dir.clone(),
            config: None,
        },
        NativeLocation {
            harness: "trae".into(),
            root: dir.clone(),
            config: None,
        },
    ];
    let mut d = docs();
    let out = discovery::discover(&mut d, &locations, &dir);
    assert_eq!(out.len(), 4);
    assert_eq!(
        out.iter()
            .find(|c| c.public["sources"][0]["harness"] == "deepseek")
            .unwrap()
            .secret
            .as_deref(),
        Some("fixture-dsh-key")
    );
    d.read("opencode", &dir.join("bad.jsonc"));
    assert_eq!(d.reports.last().unwrap()["error"], "CONFIG_UNREADABLE");
    assert!(!json!(d.reports).to_string().contains("do-not-echo"));
    std::fs::remove_dir_all(dir).unwrap();
}
#[test]
fn native_import_is_idempotent_uses_vault_and_keeps_existing_revisions() {
    let dir = temp();
    let db = Arc::new(Mutex::new(
        Database::open(&dir.join("test.sqlite")).unwrap(),
    ));
    let credentials = Arc::new(CredentialService::new(db.clone(), &dir));
    let connections = ConnectionService::new(
        db.clone(),
        credentials.clone(),
        AdapterRegistry::with_builtins(),
    );
    let service = ConnectionImportService::new(connections.clone(), credentials.clone());
    let d = docs();
    let mut candidates = Vec::new();
    for harness in ["pi", "opencode"] {
        parsers::add(
            &mut candidates,
            &d,
            harness,
            Path::new("models.json"),
            "Work",
            "responses",
            "https://relay.example/v1",
            &json!("fixture-key"),
            &Value::Null,
            vec![json!({"id":"one","reasoningEfforts":[]})],
        );
    }
    let candidates = deduplicate(candidates);
    assert_eq!(candidates.len(), 1);
    assert_eq!(candidates[0].public["sources"].as_array().unwrap().len(), 2);
    let preview = service.cache(candidates, vec![], &[]).unwrap();
    assert!(!preview.to_string().contains("fixture-key"));
    let input = json!({"scanId":preview["scanId"],"candidateIds":[preview["candidates"][0]["id"]]});
    let imported = service.import(&input).unwrap();
    let c = &imported["items"][0]["connection"];
    assert_eq!(c["hasCredential"], true);
    assert_eq!(c["revision"], 1);
    let key = credentials
        .read(&super::super::connection_service::credential_key(
            c["id"].as_str().unwrap(),
            1,
        ))
        .unwrap()
        .unwrap();
    assert_eq!(key["apiKey"], "fixture-key");
    assert_eq!(
        service.import(&input).unwrap()["items"][0]["status"],
        "existing"
    );
    assert_eq!(connections.list().unwrap().len(), 1);
    let stored = crate::database::Repositories::new(&db.lock().unwrap().raw)
        .credentials()
        .get(&super::super::connection_service::credential_key(
            c["id"].as_str().unwrap(),
            1,
        ))
        .unwrap()
        .unwrap();
    assert!(!stored.to_string().contains("fixture-key"));
    assert!(service
        .import(&json!({"scanId":"expired","candidateIds":["one"]}))
        .is_err());
    drop(service);
    drop(connections);
    drop(credentials);
    drop(db);
    std::fs::remove_dir_all(dir).unwrap();
}
