export interface AppInfo {
  name: string;
  version: string;
  platform: string;
  arch: string;
  electron: string;
  chrome: string;
  node: string;
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
