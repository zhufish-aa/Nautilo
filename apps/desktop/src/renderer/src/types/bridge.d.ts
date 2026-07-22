export interface AppInfo {
  name: string;
  version: string;
  platform: string;
  arch: string;
  electron: string;
  chrome: string;
  node: string;
}

export interface DesktopAttachment {
  path: string;
  name: string;
  kind: "image" | "file";
  mimeType?: string;
  sizeBytes: number;
}

/** Mirrors the preload bridge. Kept in sync with src/preload/index.ts. */
export interface AgentHubBridge {
  readonly isElectron: true;
  readonly platform: string;
  getAppInfo(): Promise<AppInfo>;
  window: {
    minimize(): Promise<void>;
    toggleMaximize(): Promise<void>;
    close(): Promise<void>;
    isMaximized(): Promise<boolean>;
    onMaximizedChange(callback: (maximized: boolean) => void): () => void;
  };
  dialog: {
    pickDirectory(): Promise<string | null>;
    pickFiles(): Promise<DesktopAttachment[]>;
  };
  attachments: {
    pathForFile(file: File): string;
    describePaths(paths: string[]): Promise<DesktopAttachment[]>;
    importClipboard(input: { name: string; mimeType?: string; data: Uint8Array }): Promise<DesktopAttachment>;
  };
  core: {
    request(request: { requestId?: string; method: string; input?: unknown }): Promise<unknown>;
  };
}

declare global {
  interface Window {
    agenthub?: AgentHubBridge;
  }
}

export {};
