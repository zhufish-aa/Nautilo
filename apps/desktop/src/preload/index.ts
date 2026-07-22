import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { DesktopAttachment } from "../main/attachment-file-service";

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
  core: {
    request: (request: { requestId?: string; method: string; input?: unknown }): Promise<unknown> => ipcRenderer.invoke("core:request", request)
  }
} as const;

export type AgentHubBridge = typeof bridge;

contextBridge.exposeInMainWorld("agenthub", bridge);
