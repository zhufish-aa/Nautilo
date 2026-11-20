import { ipcMain, type BrowserWindow } from "electron";
import { randomUUID } from "node:crypto";

const observed = new Set<number>();
const requests = new Map<string, { owner: number; finish: (saved: boolean) => void }>();

export function registerDraftCloseHandlers(): void {
  ipcMain.on("window:drafts-ready", event => observed.add(event.sender.id));
  ipcMain.handle("window:drafts-flushed", (event, id: string, saved: boolean) => {
    const request = requests.get(id);
    if (request?.owner === event.sender.id) request.finish(saved === true);
  });
}

/** Only an actual native close waits for a save. Reload/HMR keeps its own
 * lifecycle; it must never be turned into a request to close the window. */
export function protectWindowDrafts(win: BrowserWindow): void {
  const owner = win.webContents.id;
  let approved = false;
  let pending = false;
  const release = () => {
    observed.delete(owner);
    for (const request of requests.values()) if (request.owner === owner) request.finish(false);
  };
  win.webContents.on("render-process-gone", release);
  win.once("closed", release);
  win.on("close", event => {
    if (event.defaultPrevented || approved || !observed.has(owner) || win.webContents.isDestroyed()) return;
    event.preventDefault();
    if (pending) return;
    pending = true;
    const id = randomUUID();
    const timer = setTimeout(() => requests.get(id)?.finish(false), 5000);
    requests.set(id, { owner, finish: saved => {
      clearTimeout(timer);
      requests.delete(id);
      pending = false;
      if (saved && !win.isDestroyed()) { approved = true; win.close(); }
    } });
    win.webContents.send("window:flush-drafts", id);
  });
}
