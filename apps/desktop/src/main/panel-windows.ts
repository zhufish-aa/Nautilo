import { BrowserWindow, ipcMain } from "electron";
import type { PanelTarget } from "../shared/panel-window";
export const dockingBrowserWindows = new WeakSet<BrowserWindow>();

const validId = (id: unknown): id is string =>
  typeof id === "string" && /^[\w-]{1,160}$/.test(id);

function parseTarget(value: PanelTarget): PanelTarget {
  if (
    !value ||
    !["browser", "browser-spaces", "source-control"].includes(value.kind) ||
    (value.sessionId !== undefined && !validId(value.sessionId)) ||
    (value.projectId !== undefined && !validId(value.projectId)) ||
    (value.kind !== "browser-spaces" && !value.sessionId && (value.kind === "browser" || !value.projectId)) ||
    (value.kind === "browser-spaces" && (value.sessionId !== undefined || value.projectId !== undefined))
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
  selectBrowser?: (win: BrowserWindow, target: PanelTarget, userInitiated: boolean) => void,
) {
  const panels = new Map<
    string,
    { win: BrowserWindow; target: PanelTarget; dock: boolean; ready?: Promise<void> }
  >();
  const browserSpaces = new Set<string>();
  const isBrowser = (target:PanelTarget) => target.kind === "browser" || target.kind === "browser-spaces";
  const select = (entry: {win:BrowserWindow;target:PanelTarget},target:PanelTarget,userInitiated=false) => {
    entry.target=target;
    if(target.kind === "browser" && target.sessionId)browserSpaces.add(target.sessionId);
    if(isBrowser(target)) {
      selectBrowser?.(entry.win,target,userInitiated);
      if(!entry.win.webContents.isLoadingMainFrame())entry.win.webContents.send("panels:browser-target",target);
    }
  };
  const focus = (win: BrowserWindow) => {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  };
  const trusted = (sender: Electron.WebContents, frame: Electron.WebFrameMain | null) => {
      const owner = workbench();
      if (
        !owner ||
        (sender !== owner.webContents && ![...panels.values()].some(panel => panel.win.webContents === sender)) ||
        frame !== sender.mainFrame
      )
        throw Error("Workbench required");
  };
  const open = async (candidate: PanelTarget, focusOnly = false, userInitiated = false) => {
      const owner = workbench();
      if (!owner || owner.isDestroyed()) throw Error("Workbench required");
      const target = parseTarget(candidate);
      const key = isBrowser(target) ? "browser-host" : target.kind +
        "/" +
        (target.sessionId
          ? "session/" + target.sessionId
          : target.projectId ? "project/" + target.projectId : "global");
      const existing = panels.get(key);
      if (existing && !existing.win.isDestroyed()) {
        select(existing,target,userInitiated);
        await existing.ready;
        if(existing.win.isDestroyed())return false;
        if(isBrowser(existing.target))existing.win.webContents.send("panels:browser-target",existing.target);
        focus(existing.win);
        return true;
      }
      if (focusOnly) return false;
      const win = create(target);
      const record: {win:BrowserWindow;target:PanelTarget;dock:boolean;ready?:Promise<void>} = { win, target, dock: false };
      panels.set(key, record);
      select(record,target,userInitiated);
      const closeWithOwner = () => {
        if (!win.isDestroyed()) win.destroy();
      };
      owner.once("closed", closeWithOwner);
      win.once("closed", () => {
        owner.removeListener("closed", closeWithOwner);
        panels.delete(key);
        if (record.dock && !owner.isDestroyed()) {
          owner.webContents.send("panels:docked", record.target);
          focus(owner);
        }
      });
      try {
        record.ready=load(win);
        await record.ready;
        if (!win.isDestroyed() && isBrowser(record.target))win.webContents.send("panels:browser-target",record.target);
        if (!win.isDestroyed()) focus(win);
        return true;
      } catch (error) {
        if (!win.isDestroyed()) win.destroy();
        throw error;
      }
  };
  const cycle = () => {
    const host=panels.get("browser-host"), ids=[...browserSpaces];
    if(!host || host.win.isDestroyed() || !ids.length)return;
    const index=host.target.sessionId ? ids.indexOf(host.target.sessionId) : -1;
    select(host,{kind:"browser",sessionId:ids[(index+1)%ids.length]},true);
    focus(host.win);
  };
  ipcMain.handle("panels:open", (event, candidate: PanelTarget, focusOnly = false) => {
    trusted(event.sender, event.senderFrame);
    return open(candidate, focusOnly, true);
  });
  ipcMain.handle("panels:cycle", event => { trusted(event.sender, event.senderFrame); cycle(); });
  ipcMain.handle("panels:current",event=>{
    trusted(event.sender,event.senderFrame);
    return [...panels.values()].find(panel=>panel.win.webContents === event.sender)?.target;
  });
  ipcMain.handle("panels:dock", (event) => {
    const entry = [...panels.values()].find(
      (p) => p.win.webContents === event.sender,
    );
    if (!entry || event.senderFrame !== event.sender.mainFrame)
      throw Error("Panel window required");
    entry.dock = true;
    dockingBrowserWindows.add(entry.win);
    entry.win.close();
  });
  const closeForSession = (id: string) => {
    browserSpaces.delete(id);
    for (const entry of panels.values())
      if (entry.target.sessionId === id) {
        if(isBrowser(entry.target))select(entry,{kind:"browser-spaces"});
        else entry.win.close();
      }
  };
  return Object.assign(closeForSession, { open, cycle });
}
