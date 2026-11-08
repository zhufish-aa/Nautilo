import type { AccountLoginInput, AccountLoginStatus } from "../main/account-login";
import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { DesktopAttachment } from "../main/attachment-file-service";
import type { FileDeleteResult, FileReadTextPayload, FileReadTextResult, FileWriteTextPayload, FileWriteTextResult, ImagePayload, NativeMenuItemPayload } from "../main/desktop-interactions";
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
const panelArgument = process.argv.find(arg => arg.startsWith("--nautilo-panel="));
const panelContext = panelArgument ? JSON.parse(decodeURIComponent(panelArgument.slice("--nautilo-panel=".length))) : undefined;
const bridge = {
  assistant: {
    view: (before?:number) => ipcRenderer.invoke("assistant:view",before),
    configure: (settings:import("../shared/workspace-assistant").AssistantSettings) => ipcRenderer.invoke("assistant:configure",settings),
    submit: (id:string,text:string) => ipcRenderer.invoke("assistant:submit",id,text),
    stop: (id:string) => ipcRenderer.invoke("assistant:stop",id),
    onOutput:(cb:(output:import("../shared/workspace-assistant").AssistantLiveOutput)=>void)=>{
      const listener=(_event:Electron.IpcRendererEvent,draft:import("../shared/workspace-assistant").AssistantLiveOutput)=>cb(draft);
      ipcRenderer.on("assistant:output",listener);return ()=>{ipcRenderer.removeListener("assistant:output",listener);};
    },
    onChange: (cb:(sessionId?:string)=>void) => {
      const listener=(_event:Electron.IpcRendererEvent,id?:string)=>cb(id);
      ipcRenderer.on("assistant:changed",listener);
      return ()=>{ipcRenderer.removeListener("assistant:changed",listener);};
    },
  },
  panels: {
    context:panelContext,
    open:(target:import("../shared/panel-window").PanelTarget,focusOnly=false)=>ipcRenderer.invoke("panels:open",target,focusOnly),
    dock:()=>ipcRenderer.invoke("panels:dock"),
    onDock:(cb:(target:import("../shared/panel-window").PanelTarget)=>void)=>{
      const listener=(_event:Electron.IpcRendererEvent,target:import("../shared/panel-window").PanelTarget)=>cb(target);
      ipcRenderer.on("panels:docked",listener);
      return ()=>{ipcRenderer.removeListener("panels:docked",listener);};
    },
  },
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
    openExternal: (url: string): Promise<void> => ipcRenderer.invoke("shell:open-external", url),
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
    readText: (input: FileReadTextPayload): Promise<FileReadTextResult> => ipcRenderer.invoke("file:read-text", input),
    writeText: (input: FileWriteTextPayload): Promise<FileWriteTextResult> => ipcRenderer.invoke("file:write-text", input),
    delete: (input: { path: string }): Promise<FileDeleteResult> => ipcRenderer.invoke("file:delete", input)
  },
  accounts: {
    recoverableLogins: (): Promise<Array<{ profileId: string; providerId: string; directory: string; createdAt: number }>> => ipcRenderer.invoke("account:login-recoverable"),
    acknowledgeLogin: (input: { profileId: string; providerId: string }): Promise<void> => ipcRenderer.invoke("account:login-attached", input),
    prepareLogin: (providerId: string): Promise<{ profileId: string; directory: string }> => ipcRenderer.invoke("account:login-prepare", providerId),
    startLogin: (input: AccountLoginInput): Promise<{ ok: boolean; reason?: string }> => ipcRenderer.invoke("account:login-start", input),
    loginStatus: (profileId: string): Promise<AccountLoginStatus> => ipcRenderer.invoke("account:login-status", profileId),
    cancelLogin: (profileId: string): Promise<void> => ipcRenderer.invoke("account:login-cancel", profileId)
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
  browser: {
    panel: (sessionId: string, command: string, value?: unknown) => ipcRenderer.invoke("browser:panel",sessionId,command,value)
  },
  core: {
    request: (request: { requestId?: string; method: string; input?: unknown }): Promise<unknown> => ipcRenderer.invoke("core:request", request)
  }
} as const;

export type AgentHubBridge = typeof bridge;

contextBridge.exposeInMainWorld("agenthub", bridge);
