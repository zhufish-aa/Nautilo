import { BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, shell, type MenuItemConstructorOptions } from "electron";
import { copyFile, open, stat, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { searchFileReferences } from "./file-search";

export interface NativeMenuItemPayload {
  id: string;
  label: string;
  enabled?: boolean;
  type?: "normal" | "separator";
}

export interface ImagePayload {
  path?: string;
  dataUrl?: string;
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
  /** Absolute path — typically the resolvedPath returned by file:read-text. */
  path: string;
  content: string;
}

export type FileWriteTextResult =
  | { ok: true }
  | { ok: false; reason: "not-absolute" | "too-large" | "write-failed"; message?: string };

export type FileDeleteResult =
  | { ok: true }
  | { ok: false; reason: "not-absolute" | "delete-failed"; message?: string };

const MAX_TEXT_PREVIEW_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_WRITE_BYTES = 8 * 1024 * 1024;

/**
 * Chat-surface interactions: open/reveal files, copy or save images, and the
 * native context menu. All payloads come from the renderer's own conversation
 * data (paths the user attached or artifacts the app generated).
 */
export function registerInteractionHandlers(): void {
  // Resolves to "" on success or an error message string (shell.openPath contract).
  ipcMain.handle("shell:open-path", (_event, path: string) => shell.openPath(path));

  ipcMain.handle("shell:show-item-in-folder", (_event, path: string) => {
    shell.showItemInFolder(path);
  });

  ipcMain.handle("clipboard:write-image", (_event, payload: ImagePayload) => {
    const image = payload.path
      ? nativeImage.createFromPath(payload.path)
      : payload.dataUrl
        ? nativeImage.createFromDataURL(payload.dataUrl)
        : nativeImage.createEmpty();
    if (image.isEmpty()) return false;
    clipboard.writeImage(image);
    return true;
  });

  ipcMain.handle("image:save-as", async (event, payload: ImagePayload & { defaultName?: string }) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return null;
    const result = await dialog.showSaveDialog(win, {
      title: "Save image",
      defaultPath: payload.defaultName ?? "image.png"
    });
    if (result.canceled || !result.filePath) return null;
    if (payload.path) {
      await copyFile(payload.path, result.filePath);
    } else if (payload.dataUrl) {
      const image = nativeImage.createFromDataURL(payload.dataUrl);
      if (image.isEmpty()) throw new Error("Invalid image data");
      await writeFile(result.filePath, image.toPNG());
    } else {
      return null;
    }
    return result.filePath;
  });

  // Native context menu; resolves to the clicked item id or null when dismissed.
  ipcMain.handle("menu:popup", async (event, items: NativeMenuItemPayload[]) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || !Array.isArray(items) || items.length === 0) return null;
    return new Promise<string | null>((resolve) => {
      let settled = false;
      const settle = (id: string | null): void => {
        if (settled) return;
        settled = true;
        resolve(id);
      };
      const template: MenuItemConstructorOptions[] = items.map((item) =>
        item.type === "separator"
          ? { type: "separator" }
          : { label: item.label, enabled: item.enabled ?? true, click: () => settle(item.id) }
      );
      Menu.buildFromTemplate(template).popup({ window: win, callback: () => settle(null) });
    });
  });

  // Reads a text file for the in-app preview panel. Relative paths resolve
  // against the provided base directories; binaries and huge files are refused
  // or truncated so a chat message can never wedge the renderer.
  ipcMain.handle("file:read-text", async (_event, payload: FileReadTextPayload): Promise<FileReadTextResult> => {
    const candidates = isAbsolute(payload.path)
      ? [payload.path]
      : (payload.basePaths ?? []).map((base) => resolve(base, payload.path));
    let resolvedPath: string | undefined;
    let sizeBytes = 0;
    for (const candidate of candidates) {
      try {
        const info = await stat(candidate);
        if (!info.isFile()) return { ok: false, reason: "not-file" };
        resolvedPath = candidate;
        sizeBytes = info.size;
        break;
      } catch {
        // Try the next base directory.
      }
    }
    if (!resolvedPath) {
      // Fallback: bare names and partial paths get a bounded recursive search
      // so `Timeline.tsx` finds apps/.../features/timeline/Timeline.tsx.
      const found = await searchFileReferences(payload.path, payload.basePaths ?? []);
      if (found.length === 0) return { ok: false, reason: "not-found" };
      if (found.length > 1) return { ok: false, reason: "ambiguous", candidates: found };
      const info = await stat(found[0]);
      resolvedPath = found[0];
      sizeBytes = info.size;
    }

    // Binary sniff: a NUL byte in the first chunk means this is not text.
    const handle = await open(resolvedPath, "r");
    try {
      const probe = Buffer.alloc(Math.min(8192, sizeBytes));
      if (probe.length > 0) await handle.read(probe, 0, probe.length, 0);
      if (probe.includes(0)) return { ok: false, reason: "binary" };
    } finally {
      await handle.close();
    }

    const truncated = sizeBytes > MAX_TEXT_PREVIEW_BYTES;
    const buffer = Buffer.alloc(Math.min(sizeBytes, MAX_TEXT_PREVIEW_BYTES));
    if (buffer.length > 0) {
      const handle2 = await open(resolvedPath, "r");
      try {
        await handle2.read(buffer, 0, buffer.length, 0);
      } finally {
        await handle2.close();
      }
    }
    return { ok: true, resolvedPath, content: buffer.toString("utf8"), truncated, sizeBytes };
  });

  // Writes text back from the in-app diff editor. Absolute paths only — the
  // renderer passes the resolvedPath it got from file:read-text, so no fuzzy
  // resolution happens on the write path.
  ipcMain.handle("file:write-text", async (_event, payload: FileWriteTextPayload): Promise<FileWriteTextResult> => {
    if (!isAbsolute(payload.path)) return { ok: false, reason: "not-absolute" };
    if (Buffer.byteLength(payload.content, "utf8") > MAX_TEXT_WRITE_BYTES) return { ok: false, reason: "too-large" };
    try {
      await writeFile(payload.path, payload.content, "utf8");
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: "write-failed", message: error instanceof Error ? error.message : String(error) };
    }
  });

  // Moves a file to the OS trash (revert of an agent-created file). Trash, not
  // unlink, so the action stays recoverable from the recycle bin.
  ipcMain.handle("file:delete", async (_event, payload: { path: string }): Promise<FileDeleteResult> => {
    if (!isAbsolute(payload.path)) return { ok: false, reason: "not-absolute" };
    try {
      await shell.trashItem(payload.path);
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: "delete-failed", message: error instanceof Error ? error.message : String(error) };
    }
  });
}
