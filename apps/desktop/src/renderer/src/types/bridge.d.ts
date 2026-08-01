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

export interface ImagePayload {
  path?: string;
  dataUrl?: string;
}

export interface NativeMenuItemPayload {
  id: string;
  label: string;
  enabled?: boolean;
  type?: "normal" | "separator";
}

export interface FileReadTextPayload {
  path: string;
  /** Base directories used to resolve relative paths, first match wins. */
  basePaths?: string[];
}

export type FileReadTextResult =
  | { ok: true; resolvedPath: string; content: string; truncated: boolean; sizeBytes: number }
  | { ok: false; reason: "not-found" | "not-file" | "binary" }
  | { ok: false; reason: "ambiguous"; candidates: string[] };

export interface FileWriteTextPayload {
  /** Absolute path — typically the resolvedPath returned by readText. */
  path: string;
  content: string;
}

export type FileWriteTextResult =
  | { ok: true }
  | { ok: false; reason: "not-absolute" | "too-large" | "write-failed"; message?: string };

export type FileDeleteResult =
  | { ok: true }
  | { ok: false; reason: "not-absolute" | "delete-failed"; message?: string };

export interface ProviderUpdateStartPayload {
  updateId: string;
  executable: string;
  args: string[];
}

export type ProviderUpdateStartResult = { ok: true } | { ok: false; reason: string };

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
  shell: {
    /** Resolves to "" on success or an error message string. */
    openPath(path: string): Promise<string>;
    showItemInFolder(path: string): Promise<void>;
  };
  images: {
    copyToClipboard(input: ImagePayload): Promise<boolean>;
    /** Opens a save dialog; resolves to the saved path or null when cancelled. */
    saveAs(input: ImagePayload & { defaultName?: string }): Promise<string | null>;
  };
  menu: {
    /** Native context menu at the cursor; resolves to the clicked item id or null. */
    popup(items: NativeMenuItemPayload[]): Promise<string | null>;
  };
  files: {
    /** Reads a UTF-8 text file for preview; relative paths resolve against basePaths. */
    readText(input: FileReadTextPayload): Promise<FileReadTextResult>;
    /** Writes UTF-8 text back from the in-app diff editor; absolute paths only. */
    writeText(input: FileWriteTextPayload): Promise<FileWriteTextResult>;
    /** Moves a file to the OS trash (revert of an agent-created file). */
    delete(input: { path: string }): Promise<FileDeleteResult>;
  };
  providers: {
    /** Spawns the provider CLI's self-update command; output streams via onUpdateOutput. */
    startUpdate(input: ProviderUpdateStartPayload): Promise<ProviderUpdateStartResult>;
    cancelUpdate(updateId: string): Promise<void>;
    onUpdateOutput(callback: (updateId: string, chunk: string) => void): () => void;
    onUpdateExit(callback: (updateId: string, exitCode: number, error?: string) => void): () => void;
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
