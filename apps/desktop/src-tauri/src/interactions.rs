//! Chat-surface interactions: open/reveal files, copy or save images, the
//! native context menu, and preview-panel file reads/writes/deletes.
//! Mirrors apps/desktop/src/main/desktop-interactions.ts.
//!
//! Result shapes intentionally match the Electron bridge (`{ ok: true, ... }`
//! with boolean discriminants), so they are built with `serde_json::json!`
//! rather than derived enums.

use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, WebviewWindow};

use crate::attachment_files;
use crate::file_search;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeMenuItemPayload {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub r#type: Option<String>, // "normal" | "separator"
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImagePayload {
    pub path: Option<String>,
    pub data_url: Option<String>,
    pub default_name: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileReadTextPayload {
    pub path: String,
    /// Base directories used to resolve relative paths, first match wins.
    pub base_paths: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
pub struct FileWriteTextPayload {
    pub path: String,
    pub content: String,
}

#[derive(Debug, Deserialize)]
pub struct FilePathPayload {
    pub path: String,
}

const MAX_TEXT_PREVIEW_BYTES: u64 = 2 * 1024 * 1024;
const MAX_TEXT_WRITE_BYTES: usize = 8 * 1024 * 1024;

// --- shell ---------------------------------------------------------------

#[tauri::command]
pub fn shell_open_external(url: String) -> Result<(), String> {
    let parsed = tauri::Url::parse(&url).map_err(|e| e.to_string())?;
    if parsed.scheme() != "https" || parsed.host_str().is_none() || !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("Expected an HTTPS authorization URL".into());
    }
    opener::open(parsed.as_str()).map_err(|e| e.to_string())
}

/// Resolves to "" on success or an error message string (shell.openPath contract).
#[tauri::command]
pub fn shell_open_path(path: String) -> String {
    match opener::open(&path) {
        Ok(()) => String::new(),
        Err(error) => error.to_string(),
    }
}

#[tauri::command]
pub fn shell_show_item_in_folder(path: String) -> Result<(), String> {
    opener::reveal(&path).map_err(|e| e.to_string())
}

// --- images ---------------------------------------------------------------

#[tauri::command]
pub fn clipboard_write_image(payload: ImagePayload) -> bool {
    let Some(image) = decode_image(&payload) else {
        return false;
    };
    let rgba = image.to_rgba8();
    let (width, height) = rgba.dimensions();
    let mut clipboard = match arboard::Clipboard::new() {
        Ok(clipboard) => clipboard,
        Err(_) => return false,
    };
    clipboard
        .set_image(arboard::ImageData {
            width: width as usize,
            height: height as usize,
            bytes: rgba.into_raw().into(),
        })
        .is_ok()
}

#[tauri::command]
pub async fn image_save_as(payload: ImagePayload) -> Result<Option<String>, String> {
    let saved = tauri::async_runtime::spawn_blocking(move || {
        rfd::FileDialog::new()
            .set_title("Save image")
            .set_file_name(payload.default_name.clone().unwrap_or_else(|| "image.png".to_string()))
            .save_file()
            .map(|path| (path, payload))
    })
    .await
    .map_err(|e| e.to_string())?;
    let Some((target, payload)) = saved else {
        return Ok(None);
    };
    if let Some(path) = &payload.path {
        std::fs::copy(path, &target).map_err(|e| e.to_string())?;
    } else if payload.data_url.is_some() {
        let image = decode_image(&payload).ok_or("Invalid image data")?;
        image
            .save_with_format(&target, image::ImageFormat::Png)
            .map_err(|e| e.to_string())?;
    } else {
        return Ok(None);
    }
    Ok(Some(target.to_string_lossy().to_string()))
}

fn decode_image(payload: &ImagePayload) -> Option<image::DynamicImage> {
    if let Some(path) = &payload.path {
        return image::open(path).ok();
    }
    let data_url = payload.data_url.as_ref()?;
    let base64 = data_url.split_once(',')?.1;
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD.decode(base64).ok()?;
    image::load_from_memory(&bytes).ok()
}

// --- native context menu ---------------------------------------------------

/// Popup state: which menu each item id belongs to, plus the single waiter
/// for the menu currently on screen.
pub struct MenuRegistry {
    inner: Mutex<MenuRegistryState>,
}

#[derive(Default)]
struct MenuRegistryState {
    items: HashMap<String, String>,
    waiter: Option<(String, tokio::sync::oneshot::Sender<Option<String>>)>,
}

impl MenuRegistry {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(MenuRegistryState::default()),
        }
    }

    /// Called from the global on_menu_event handler with the clicked item id.
    pub fn resolve(&self, item_id: &str) {
        let Ok(mut state) = self.inner.lock() else {
            return;
        };
        let Some(menu_id) = state.items.remove(item_id) else {
            return;
        };
        state.items.retain(|_, owner| owner != &menu_id);
        if let Some((owner, sender)) = state.waiter.take() {
            if owner == menu_id {
                let _ = sender.send(Some(item_id.to_string()));
            } else {
                // A click from a superseded menu should not resolve the new one.
                state.waiter = Some((owner, sender));
            }
        }
    }

    /// Dismissal path: resolve the active menu's waiter with null.
    pub fn dismiss_active(&self) {
        let Ok(mut state) = self.inner.lock() else {
            return;
        };
        state.items.clear();
        if let Some((_, sender)) = state.waiter.take() {
            let _ = sender.send(None);
        }
    }
}

/// Native context menu; resolves to the clicked item id or null when dismissed.
#[tauri::command]
pub async fn menu_popup(
    window: WebviewWindow,
    app: AppHandle,
    items: Vec<NativeMenuItemPayload>,
) -> Result<Option<String>, String> {
    if items.is_empty() {
        return Ok(None);
    }
    let registry = app.state::<MenuRegistry>();
    // A new popup supersedes any menu that is still open.
    registry.dismiss_active();

    use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem};
    let menu_id = uuid::Uuid::new_v4().to_string();
    let mut builder = MenuBuilder::new(&app);
    for item in &items {
        if item.r#type.as_deref() == Some("separator") {
            builder = builder.item(&PredefinedMenuItem::separator(&app).map_err(|e| e.to_string())?);
        } else {
            let entry = MenuItemBuilder::with_id(item.id.clone(), item.label.clone())
                .enabled(item.enabled.unwrap_or(true))
                .build(&app)
                .map_err(|e| e.to_string())?;
            builder = builder.item(&entry);
        }
    }
    let (sender, receiver) = tokio::sync::oneshot::channel::<Option<String>>();
    {
        let mut state = registry.inner.lock().map_err(|e| e.to_string())?;
        for item in &items {
            state.items.insert(item.id.clone(), menu_id.clone());
        }
        state.waiter = Some((menu_id.clone(), sender));
    }
    let menu = builder.build().map_err(|e| e.to_string())?;
    window.popup_menu(&menu).map_err(|e| e.to_string())?;

    // Click resolves with the id; supersede/close resolves with null. The
    // timeout only guards a leaked promise — the OS gives no dismiss event.
    let resolved = match tokio::time::timeout(std::time::Duration::from_secs(300), receiver).await {
        Ok(Ok(value)) => value,
        _ => None,
    };
    let mut state = registry.inner.lock().map_err(|e| e.to_string())?;
    state.items.retain(|_, owner| owner != &menu_id);
    if state.waiter.as_ref().map(|(owner, _)| owner) == Some(&menu_id) {
        state.waiter = None;
    }
    Ok(resolved)
}

// --- preview-panel file access ---------------------------------------------

/// Reads a text file for the in-app preview panel. Relative paths resolve
/// against the provided base directories; binaries and huge files are refused
/// or truncated so a chat message can never wedge the renderer.
#[tauri::command]
pub fn file_read_text(payload: FileReadTextPayload) -> Value {
    let is_abs = Path::new(&payload.path).is_absolute() || payload.path.starts_with("\\\\");
    let candidates: Vec<PathBuf> = if is_abs {
        vec![PathBuf::from(&payload.path)]
    } else {
        payload
            .base_paths
            .clone()
            .unwrap_or_default()
            .iter()
            .map(|base| Path::new(base).join(&payload.path))
            .collect()
    };
    let mut resolved: Option<(PathBuf, u64)> = None;
    for candidate in &candidates {
        match std::fs::metadata(candidate) {
            Ok(info) => {
                if !info.is_file() {
                    return json!({ "ok": false, "reason": "not-file" });
                }
                resolved = Some((candidate.clone(), info.len()));
                break;
            }
            Err(_) => continue, // Try the next base directory.
        }
    }
    let (resolved_path, size_bytes) = match resolved {
        Some(found) => found,
        None => {
            // Fallback: bare names and partial paths get a bounded recursive
            // search so `Timeline.tsx` finds apps/.../features/timeline/Timeline.tsx.
            let found = file_search::search_file_references(&payload.path, &payload.base_paths.unwrap_or_default());
            match found.len() {
                0 => return json!({ "ok": false, "reason": "not-found" }),
                1 => {
                    let path = PathBuf::from(&found[0]);
                    let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
                    (path, size)
                }
                _ => return json!({ "ok": false, "reason": "ambiguous", "candidates": found }),
            }
        }
    };

    let file = match std::fs::File::open(&resolved_path) {
        Ok(file) => file,
        Err(_) => return json!({ "ok": false, "reason": "not-found" }),
    };
    let (bytes, truncated) = match read_text_preview(file) {
        Ok(preview) => preview,
        Err(_) => return json!({ "ok": false, "reason": "read-failed" }),
    };
    // Binary sniff: a NUL byte in the first chunk means this is not text.
    if bytes.iter().take(8192).any(|b| *b == 0) {
        return json!({ "ok": false, "reason": "binary" });
    }
    let preview = &bytes[..];
    json!({
        "ok": true,
        "resolvedPath": resolved_path.to_string_lossy(),
        "content": String::from_utf8_lossy(preview),
        "truncated": truncated,
        "sizeBytes": size_bytes,
    })
}

/// Writes text back from the in-app diff editor. Absolute paths only — the
/// renderer passes the resolvedPath it got from file_read_text, so no fuzzy
/// resolution happens on the write path.
#[tauri::command]
pub fn file_write_text(payload: FileWriteTextPayload) -> Value {
    if attachment_files::require_absolute(&payload.path).is_err() {
        return json!({ "ok": false, "reason": "not-absolute" });
    }
    if payload.content.len() > MAX_TEXT_WRITE_BYTES {
        return json!({ "ok": false, "reason": "too-large" });
    }
    match std::fs::write(&payload.path, payload.content) {
        Ok(()) => json!({ "ok": true }),
        Err(error) => json!({ "ok": false, "reason": "write-failed", "message": error.to_string() }),
    }
}

/// Moves a file to the OS trash (revert of an agent-created file). Trash, not
/// unlink, so the action stays recoverable from the recycle bin.
#[tauri::command]
pub fn file_delete(payload: FilePathPayload) -> Value {
    if attachment_files::require_absolute(&payload.path).is_err() {
        return json!({ "ok": false, "reason": "not-absolute" });
    }
    match trash::delete(&payload.path) {
        Ok(()) => json!({ "ok": true }),
        Err(error) => json!({ "ok": false, "reason": "delete-failed", "message": error.to_string() }),
    }
}

/// Cap allocation and reads regardless of stale metadata, file growth, or shrinkage.
fn read_text_preview(reader: impl Read) -> std::io::Result<(Vec<u8>, bool)> {
    let mut bytes = Vec::new();
    reader.take(MAX_TEXT_PREVIEW_BYTES + 1).read_to_end(&mut bytes)?;
    let truncated = bytes.len() > MAX_TEXT_PREVIEW_BYTES as usize;
    bytes.truncate(MAX_TEXT_PREVIEW_BYTES as usize);
    Ok((bytes, truncated))
}

#[cfg(test)]
mod preview_read_tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn huge_stream_is_bounded_and_marked_truncated() {
        let (bytes, truncated) = read_text_preview(std::io::repeat(b'a')).unwrap();
        assert_eq!(bytes.len(), MAX_TEXT_PREVIEW_BYTES as usize);
        assert!(truncated);
    }

    #[test]
    fn shrunken_file_uses_actual_bytes_without_metadata_slicing() {
        let (bytes, truncated) = read_text_preview(Cursor::new(b"small")).unwrap();
        assert_eq!(bytes, b"small");
        assert!(!truncated);
    }

    #[test]
    fn exact_limit_is_not_truncated() {
        let source = vec![b'a'; MAX_TEXT_PREVIEW_BYTES as usize];
        let (bytes, truncated) = read_text_preview(Cursor::new(&source)).unwrap();
        assert_eq!(bytes, source);
        assert!(!truncated);
    }
}
