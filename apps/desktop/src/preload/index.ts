import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { DesktopAttachment } from "../main/attachment-file-service";
import type { FileReadTextPayload, FileReadTextResult, ImagePayload, NativeMenuItemPayload } from "../main/desktop-interactions";
import type { ProviderUpdateStartPayload, ProviderUpdateStartResult } from "../main/provider-updates";

export interface AppInfo {
  name: string;
  version: string;
  platform: string;
  arch: string;
  electron: string;
  chrome: string;
  node: string;
}

/**
 * The only surface a renderer can ever reach. Business data is served by the
 * Core Daemon over its own authenticated channel (backend scope); this bridge
 * exposes just the desktop shell primitives the workbench UI needs.
 */
const bridge = {
  isElectron: true,
  platform: process.platform,
  getAppInfo: (): Promise<AppInfo> => ipcRenderer.invoke("app:get-info"),
  window: {
    minimize: (): Promise<void> => ipcRenderer.invoke("window:minimize"),
    toggleMaximize: (): Promise<void> => ipcRenderer.invoke("window:toggle-maximize"),
    close: (): Promise<void> => ipcRenderer.invoke("window:close"),
    isMaximized: (): Promise<boolean> => ipcRenderer.invoke("window:is-maximized"),
    onMaximizedChange: (callback: (maximized: boolean) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, maximized: boolean): void => {
        callback(maximized);
      };
      ipcRenderer.on("window:maximized-changed", listener);
      return () => {
        ipcRenderer.removeListener("window:maximized-changed", listener);
      };
    }
  },
  dialog: {
    pickDirectory: (): Promise<string | null> => ipcRenderer.invoke("dialog:pick-directory"),
    pickFiles: (): Promise<DesktopAttachment[]> => ipcRenderer.invoke("dialog:pick-files")
  },
  attachments: {
    pathForFile: (file: File): string => webUtils.getPathForFile(file),
    describePaths: (paths: string[]): Promise<DesktopAttachment[]> => ipcRenderer.invoke("attachment:describe-paths", paths),
    importClipboard: (input: { name: string; mimeType?: string; data: Uint8Array }): Promise<DesktopAttachment> =>
      ipcRenderer.invoke("attachment:import-clipboard", input)
  },
  shell: {
    openPath: (path: string): Promise<string> => ipcRenderer.invoke("shell:open-path", path),
    showItemInFolder: (path: string): Promise<void> => ipcRenderer.invoke("shell:show-item-in-folder", path)
  },
  images: {
    copyToClipboard: (input: ImagePayload): Promise<boolean> => ipcRenderer.invoke("clipboard:write-image", input),
    saveAs: (input: ImagePayload & { defaultName?: string }): Promise<string | null> => ipcRenderer.invoke("image:save-as", input)
  },
  menu: {
    popup: (items: NativeMenuItemPayload[]): Promise<string | null> => ipcRenderer.invoke("menu:popup", items)
  },
  files: {
    readText: (input: FileReadTextPayload): Promise<FileReadTextResult> => ipcRenderer.invoke("file:read-text", input)
  },
  providers: {
    startUpdate: (input: ProviderUpdateStartPayload): Promise<ProviderUpdateStartResult> => ipcRenderer.invoke("provider:update-start", input),
    cancelUpdate: (updateId: string): Promise<void> => ipcRenderer.invoke("provider:update-cancel", updateId),
    onUpdateOutput: (callback: (updateId: string, chunk: string) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: { updateId: string; chunk: string }): void => {
        callback(payload.updateId, payload.chunk);
      };
      ipcRenderer.on("provider:update-output", listener);
      return () => {
        ipcRenderer.removeListener("provider:update-output", listener);
      };
    },
    onUpdateExit: (callback: (updateId: string, exitCode: number, error?: string) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: { updateId: string; exitCode: number; error?: string }): void => {
        callback(payload.updateId, payload.exitCode, payload.error);
      };
      ipcRenderer.on("provider:update-exit", listener);
      return () => {
        ipcRenderer.removeListener("provider:update-exit", listener);
      };
    }
  },
  core: {
    request: (request: { requestId?: string; method: string; input?: unknown }): Promise<unknown> => ipcRenderer.invoke("core:request", request)
  }
} as const;

export type AgentHubBridge = typeof bridge;

contextBridge.exposeInMainWorld("agenthub", bridge);
