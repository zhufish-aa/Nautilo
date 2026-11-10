import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { AgentHubBridge, NativeMenuItemPayload } from "../types/bridge";

/**
 * Installs the same `window.agenthub` surface the Electron preload exposes,
 * backed by Tauri invokes. Imported for its side effect from `main.tsx`; it is
 * a no-op outside the Tauri shell so the Electron build keeps working.
 */

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

function toBase64(data: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < data.length; offset += chunkSize) {
    binary += String.fromCharCode(...data.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function installTauriBridge(): void {
  const appWindow = getCurrentWindow();

  const bridge: AgentHubBridge = {
    isElectron: true,
    platform: navigator.userAgent.includes("Windows") ? "win32" : navigator.userAgent.includes("Mac") ? "darwin" : "linux",
    getAppInfo: () => invoke("app_get_info"),
    window: {
      minimize: async () => appWindow.minimize(),
      toggleMaximize: async () => appWindow.toggleMaximize(),
      close: async () => appWindow.close(),
      isMaximized: async () => appWindow.isMaximized(),
      onMaximizedChange: (callback) => {
        let last: boolean | undefined;
        const unlisten = appWindow.onResized(async () => {
          const maximized = await appWindow.isMaximized();
          if (maximized !== last) {
            last = maximized;
            callback(maximized);
          }
        });
        return () => {
          void unlisten.then((dispose) => dispose());
        };
      }
    },
    dialog: {
      pickDirectory: () => invoke("dialog_pick_directory"),
      pickFiles: () => invoke("dialog_pick_files")
    },
    attachments: {
      // HTML File objects carry no filesystem path outside Electron; callers
      // fall back to a byte import when this throws.
      pathForFile: () => {
        throw new Error("File paths are unavailable in the Tauri shell");
      },
      describePaths: (paths) => invoke("attachment_describe_paths", { paths }),
      importClipboard: (input) =>
        invoke("attachment_import_clipboard", { input: { name: input.name, mimeType: input.mimeType, dataBase64: toBase64(input.data) } })
    },
    shell: {
      openExternal: (url) => invoke("shell_open_external", { url }),
      openPath: (path) => invoke("shell_open_path", { path }),
      showItemInFolder: async (path) => {
        await invoke("shell_show_item_in_folder", { path });
      }
    },
    images: {
      copyToClipboard: (input) => invoke("clipboard_write_image", { payload: input }),
      saveAs: (input) => invoke("image_save_as", { payload: input })
    },
    menu: {
      popup: (items: NativeMenuItemPayload[]) => invoke("menu_popup", { items })
    },
    files: {
      readText: (input) => invoke("file_read_text", { payload: input }),
      writeText: (input) => invoke("file_write_text", { payload: input }),
      delete: (input) => invoke("file_delete", { payload: input })
    },
    accounts: {
      recoverableLogins: () => invoke("account_login_recoverable"),
      acknowledgeLogin: (input) => invoke("account_login_attached", { providerId: input.providerId, profileId: input.profileId }),
      prepareLogin: (providerId) => invoke("account_login_prepare", { providerId }),
      startLogin: (input) => invoke("account_login_start", { input }),
      loginStatus: (profileId) => invoke("account_login_status", { profileId }),
      cancelLogin: (profileId) => invoke("account_login_cancel", { profileId })
    },
    providers: {
      startUpdate: (input) => invoke("provider_update_start", { payload: input }),
      cancelUpdate: async (updateId) => {
        await invoke("provider_update_cancel", { updateId });
      },
      onUpdateOutput: (callback) => {
        const unlisten = listen<{ updateId: string; chunk: string }>("provider:update-output", (event) => {
          callback(event.payload.updateId, event.payload.chunk);
        });
        return () => {
          void unlisten.then((dispose) => dispose());
        };
      },
      onUpdateExit: (callback) => {
        const unlisten = listen<{ updateId: string; exitCode: number; error?: string }>("provider:update-exit", (event) => {
          callback(event.payload.updateId, event.payload.exitCode, event.payload.error);
        });
        return () => {
          void unlisten.then((dispose) => dispose());
        };
      }
    },
    core: {
      request: (request) => invoke("core_request", { request })
    }
  };

  window.agenthub = bridge;
}

if (typeof window !== "undefined" && window.__TAURI_INTERNALS__) {
  installTauriBridge();
  installDragRegion();
}

/**
 * The frameless Electron window used `-webkit-app-region: drag` CSS, which
 * WebView2 does not implement. Reproduce it: on left-button mousedown, walk
 * up from the target and start window dragging on the first `drag` region,
 * unless a `no-drag` element is hit first.
 */
function installDragRegion(): void {
  const appWindow = getCurrentWindow();
  window.addEventListener(
    "mousedown",
    (event) => {
      if (event.button !== 0) return;
      for (let element = event.target as HTMLElement | null; element; element = element.parentElement) {
        const style = getComputedStyle(element) as CSSStyleDeclaration & { webkitAppRegion?: string };
        const region = style.webkitAppRegion ?? (style as unknown as { appRegion?: string }).appRegion;
        if (region === "no-drag") return;
        if (region === "drag") {
          void appWindow.startDragging();
          return;
        }
      }
    },
    true
  );
}
