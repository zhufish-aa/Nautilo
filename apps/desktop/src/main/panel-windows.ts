import { BrowserWindow, ipcMain } from "electron";
import type { PanelTarget } from "../shared/panel-window";

const validId = (id: unknown): id is string =>
  typeof id === "string" && /^[\w-]{1,160}$/.test(id);

function parseTarget(value: PanelTarget): PanelTarget {
  if (
    !value ||
    !["browser", "source-control"].includes(value.kind) ||
    (value.sessionId !== undefined && !validId(value.sessionId)) ||
    (value.projectId !== undefined && !validId(value.projectId)) ||
    (!value.sessionId && (value.kind === "browser" || !value.projectId))
  )
    throw Error("Invalid panel target");
  return {
    kind: value.kind,
    sessionId: value.sessionId,
    projectId: value.projectId,
  };
}

export function registerPanelWindows(
  workbench: () => BrowserWindow | undefined,
  create: (target: PanelTarget) => BrowserWindow,
  load: (win: BrowserWindow) => Promise<void>,
) {
  const panels = new Map<
    string,
    { win: BrowserWindow; target: PanelTarget; dock: boolean }
  >();
  const focus = (win: BrowserWindow) => {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  };
  ipcMain.handle(
    "panels:open",
    async (event, candidate: PanelTarget, focusOnly = false) => {
      const owner = workbench();
      if (
        !owner ||
        event.sender !== owner.webContents ||
        event.senderFrame !== event.sender.mainFrame
      )
        throw Error("Workbench required");
      const target = parseTarget(candidate);
      const key =
        target.kind +
        "/" +
        (target.sessionId
          ? "session/" + target.sessionId
          : "project/" + target.projectId);
      const existing = panels.get(key);
      if (existing && !existing.win.isDestroyed()) {
        focus(existing.win);
        return true;
      }
      if (focusOnly) return false;
      const win = create(target);
      const record = { win, target, dock: false };
      panels.set(key, record);
      const closeWithOwner = () => {
        if (!win.isDestroyed()) win.destroy();
      };
      owner.once("closed", closeWithOwner);
      win.once("closed", () => {
        owner.removeListener("closed", closeWithOwner);
        panels.delete(key);
        if (record.dock && !owner.isDestroyed()) {
          owner.webContents.send("panels:docked", target);
          focus(owner);
        }
      });
      try {
        await load(win);
        if (!win.isDestroyed()) focus(win);
        return true;
      } catch (error) {
        if (!win.isDestroyed()) win.destroy();
        throw error;
      }
    },
  );
  ipcMain.handle("panels:dock", (event) => {
    const entry = [...panels.values()].find(
      (p) => p.win.webContents === event.sender,
    );
    if (!entry || event.senderFrame !== event.sender.mainFrame)
      throw Error("Panel window required");
    entry.dock = true;
    entry.win.close();
  });
  return (id: string) => {
    for (const entry of panels.values())
      if (entry.target.sessionId === id) entry.win.close();
  };
}
