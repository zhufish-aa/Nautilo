//! Nautilo desktop shell (Tauri). Mirrors apps/desktop/src/main/index.ts.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod artifact_protocol;
mod attachment_files;
mod core_daemon;
mod file_search;
mod interactions;
mod provider_updates;
mod shell_commands;
mod window_state;

use std::path::PathBuf;
use std::time::Duration;
use tauri::{Manager, RunEvent};

use artifact_protocol::WorkspaceRoots;
use core_daemon::CoreDaemonClient;
use interactions::MenuRegistry;
use provider_updates::ProviderUpdateRegistry;
use shell_commands::ShellPaths;

/// Same directory the Electron shell used (`app.getPath("userData")` with the
/// sanitized package name), so user data survives the migration untouched.
/// AGENTHUB_DATA_DIR overrides it — test instances must NEVER share the real
/// directory: the daemon rotates core.token on startup, which would break the
/// auth of a concurrently running instance.
fn legacy_user_data_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("AGENTHUB_DATA_DIR") {
        return PathBuf::from(dir);
    }
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("@agenthub")
        .join("desktop")
}

fn main() {
    let data_dir = legacy_user_data_dir();
    let _ = std::fs::create_dir_all(&data_dir);

    let protocol_data_dir = data_dir.clone();
    let setup_data_dir = data_dir.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // Second launch: restore and focus the existing window.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .manage(CoreDaemonClient::new())
        .manage(MenuRegistry::new())
        .manage(ProviderUpdateRegistry::new())
        .manage(WorkspaceRoots::new())
        .manage(ShellPaths {
            data_dir: data_dir.clone(),
        })
        .register_uri_scheme_protocol("agenthub-artifact", move |ctx, request| {
            artifact_protocol::handle(request, &protocol_data_dir, ctx.app_handle().state::<WorkspaceRoots>().inner())
        })
        .invoke_handler(tauri::generate_handler![
            show_main_window,
            shell_commands::app_get_info,
            shell_commands::core_request,
            shell_commands::dialog_pick_directory,
            shell_commands::dialog_pick_files,
            shell_commands::attachment_describe_paths,
            shell_commands::attachment_import_clipboard,
            interactions::shell_open_path,
            interactions::shell_show_item_in_folder,
            interactions::clipboard_write_image,
            interactions::image_save_as,
            interactions::menu_popup,
            interactions::file_read_text,
            interactions::file_write_text,
            interactions::file_delete,
            provider_updates::provider_update_start,
            provider_updates::provider_update_cancel,
        ])
        .on_menu_event(|app, event| {
            app.state::<MenuRegistry>().resolve(event.id().as_ref());
        })
        .setup(move |app| {
            let window = app
                .get_webview_window("main")
                .ok_or("main window missing from config")?;

            let state = window_state::read_window_state(&setup_data_dir);
            window_state::apply_window_state(&window, &state);
            window_state::track_window_state(&window, setup_data_dir.clone());

            // Start the daemon before the window shows; a failure leaves the
            // shell usable but core requests report "not ready".
            let client = app.state::<CoreDaemonClient>();
            if let Err(error) = client.start(&setup_data_dir) {
                eprintln!("[shell] Core Daemon failed to start: {error}");
            }

            // Keep artifact-protocol workspace roots in sync with the daemon.
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    shell_commands::refresh_workspace_roots(app_handle.clone()).await;
                    tokio::time::sleep(Duration::from_secs(30)).await;
                }
            });

            // The window starts hidden (visible: false). The renderer calls
            // show_main_window once React has painted its first frame, so the
            // dark background never flashes before the UI is ready.
            // Safety net: if the renderer never signals (crash or a blank
            // error overlay), force-show so the app is never stuck invisible.
            {
                let app_handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(Duration::from_secs(8)).await;
                    if let Some(w) = app_handle.get_webview_window("main") {
                        let _ = w.show();
                        let _ = w.set_focus();
                    }
                });
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let RunEvent::ExitRequested { .. } | RunEvent::Exit = event {
                app.state::<CoreDaemonClient>().stop();
            }
        });
}

/// Called by the renderer after React has painted its first frame, so the
/// window never flashes its dark background before the UI is ready.
#[tauri::command]
fn show_main_window(window: tauri::WebviewWindow) -> Result<(), String> {
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())?;
    Ok(())
}
