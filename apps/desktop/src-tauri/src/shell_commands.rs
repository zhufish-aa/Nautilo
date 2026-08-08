//! Small whitelisted shell commands: app info, native dialogs, attachment
//! staging, and the Core Daemon gateway forwarder. Business APIs are served by
//! the daemon; this shell never imports SQLite.

use serde::Deserialize;
use serde_json::{json, Value};
use std::path::PathBuf;
use tauri::{AppHandle, Manager, State};

use crate::artifact_protocol::WorkspaceRoots;
use crate::attachment_files::{self, DesktopAttachment};
use crate::core_daemon::CoreDaemonClient;

/// Shell-wide shared paths.
pub struct ShellPaths {
    pub data_dir: PathBuf,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardImportInput {
    pub name: String,
    pub mime_type: Option<String>,
    pub data_base64: String,
}

#[tauri::command]
pub fn app_get_info() -> Value {
    json!({
        "name": "Nautilo",
        "version": env!("CARGO_PKG_VERSION"),
        "platform": std::env::consts::OS.replace("windows", "win32"),
        "arch": match std::env::consts::ARCH {
            "x86_64" => "x64",
            "aarch64" => "arm64",
            "x86" => "ia32",
            other => other,
        },
        // Renderer shows these two as the runtime line in Settings → About.
        "electron": "Tauri 2",
        "chrome": "WebView2",
        "node": "-",
    })
}

#[tauri::command]
pub async fn core_request(client: State<'_, CoreDaemonClient>, request: Value) -> Result<Value, String> {
    client.request(request).await
}

#[tauri::command]
pub async fn dialog_pick_directory() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        rfd::FileDialog::new()
            .set_title("选择项目目录")
            .pick_folder()
            .map(|path| path.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn dialog_pick_files(paths: State<'_, ShellPaths>) -> Result<Vec<DesktopAttachment>, String> {
    let data_dir = paths.data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let Some(files) = rfd::FileDialog::new().set_title("选择文件").pick_files() else {
            return Ok(Vec::new());
        };
        let paths: Vec<String> = files.iter().map(|p| p.to_string_lossy().to_string()).collect();
        attachment_files::prepare_attachment_paths(&data_dir, &paths)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn attachment_describe_paths(paths: State<'_, ShellPaths>, paths_arg: Vec<String>) -> Result<Vec<DesktopAttachment>, String> {
    // Mirrors Electron: attachment:describe-paths also runs prepare so
    // previewable images are copied into app-owned storage.
    attachment_files::prepare_attachment_paths(&paths.data_dir, &paths_arg)
}

#[tauri::command]
pub fn attachment_import_clipboard(
    paths: State<'_, ShellPaths>,
    input: ClipboardImportInput,
) -> Result<DesktopAttachment, String> {
    use base64::Engine;
    let data = base64::engine::general_purpose::STANDARD
        .decode(&input.data_base64)
        .map_err(|e| e.to_string())?;
    attachment_files::import_clipboard_attachment(&paths.data_dir, &input.name, input.mime_type.as_deref(), &data)
}

/// Background refresh of the workspace roots used by the artifact protocol.
pub async fn refresh_workspace_roots(app: AppHandle) {
    let client = app.state::<CoreDaemonClient>();
    let roots: Result<Vec<Value>, _> = client.request_typed("project.list", None).await;
    let Ok(projects) = roots else {
        return;
    };
    let parsed: Vec<PathBuf> = projects
        .iter()
        .filter_map(|project| project.get("rootPath").and_then(|p| p.as_str()))
        .filter(|root| !root.trim().is_empty())
        .map(PathBuf::from)
        .collect();
    app.state::<WorkspaceRoots>().replace(parsed);
}
