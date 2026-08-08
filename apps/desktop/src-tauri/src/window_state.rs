//! Persisted main-window bounds, restored on the next launch (F-001).
//! Mirrors apps/desktop/src/main/window-state.ts.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{PhysicalPosition, PhysicalSize, WebviewWindow};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WindowState {
    pub width: u32,
    pub height: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub x: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub y: Option<i32>,
    #[serde(rename = "isMaximized")]
    pub is_maximized: bool,
}

const DEFAULT_WIDTH: u32 = 1360;
const DEFAULT_HEIGHT: u32 = 860;

fn state_file_path(data_dir: &std::path::Path) -> PathBuf {
    data_dir.join("window-state.json")
}

/// Read the persisted window bounds; positions outside every display are dropped.
pub fn read_window_state(data_dir: &std::path::Path) -> WindowState {
    let fallback = WindowState {
        width: DEFAULT_WIDTH,
        height: DEFAULT_HEIGHT,
        x: None,
        y: None,
        is_maximized: false,
    };
    let read = (|| -> Option<WindowState> {
        let raw = fs::read_to_string(state_file_path(data_dir)).ok()?;
        let parsed: WindowState = serde_json::from_str(&raw).ok()?;
        Some(WindowState {
            width: parsed.width.max(960),
            height: parsed.height.max(640),
            x: parsed.x,
            y: parsed.y,
            is_maximized: parsed.is_maximized,
        })
    })();
    let mut state = read.unwrap_or(fallback);
    if !is_visible_on_some_display(&state) {
        state.x = None;
        state.y = None;
    }
    state
}

fn is_visible_on_some_display(state: &WindowState) -> bool {
    let (Some(x), Some(y)) = (state.x, state.y) else {
        return false;
    };
    // Monitor enumeration happens later against the live window; at read time
    // we only sanity-check the coordinates are finite. The applying step
    // re-validates against actual displays.
    x > -100_000 && y > -100_000 && x < 100_000 && y < 100_000
}

/// Apply the persisted bounds to a freshly created window.
pub fn apply_window_state(window: &WebviewWindow, state: &WindowState) {
    let visible = match (state.x, state.y) {
        (Some(x), Some(y)) => window
            .available_monitors()
            .map(|monitors| {
                monitors.iter().any(|monitor| {
                    let area = monitor.work_area();
                    x >= area.position.x - 8
                        && y >= area.position.y - 8
                        && x < area.position.x + area.size.width as i32
                        && y < area.position.y + area.size.height as i32
                })
            })
            .unwrap_or(false),
        _ => false,
    };
    let _ = window.set_size(PhysicalSize::new(state.width, state.height));
    if visible {
        let _ = window.set_position(PhysicalPosition::new(state.x.unwrap(), state.y.unwrap()));
    }
    if state.is_maximized {
        let _ = window.maximize();
    }
}

/// Debounce-persist window bounds whenever they change.
pub fn track_window_state(window: &WebviewWindow, data_dir: PathBuf) {
    let saving = Arc::new(AtomicBool::new(false));
    let window_for_event = window.clone();
    window.on_window_event(move |event| {
        use tauri::WindowEvent::*;
        match event {
            Resized(_) | Moved(_) => {
                // Simple debounce: skip while a save is already queued. Window
                // chrome persistence is best-effort and a dropped intermediate
                // state is harmless — the close handler saves the final one.
                if saving.swap(true, Ordering::SeqCst) {
                    return;
                }
                let saving = Arc::clone(&saving);
                let window = window_for_event.clone();
                let dir = data_dir.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(400));
                    saving.store(false, Ordering::SeqCst);
                    save_window_state(&window, &dir);
                });
            }
            CloseRequested { .. } | Destroyed => {
                save_window_state(&window_for_event, &data_dir);
            }
            _ => {}
        }
    });
}

fn save_window_state(window: &WebviewWindow, data_dir: &std::path::Path) {
    let is_maximized = window.is_maximized().unwrap_or(false);
    // getNormalBounds equivalent: skip persisting while maximized beyond the
    // flag — Electron saved the pre-maximize bounds; we approximate with the
    // current outer position/size which is good enough for restore purposes.
    let (Ok(size), Ok(position)) = (window.outer_size(), window.outer_position()) else {
        return;
    };
    let state = WindowState {
        width: size.width,
        height: size.height,
        x: Some(position.x),
        y: Some(position.y),
        is_maximized,
    };
    let file = state_file_path(data_dir);
    if let Some(parent) = file.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_string_pretty(&state) {
        let _ = fs::write(file, json);
    }
}
