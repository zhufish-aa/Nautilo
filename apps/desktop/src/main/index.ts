import { app, BrowserWindow, dialog, ipcMain, session, shell } from "electron";
import { join } from "node:path";
import { readWindowState, trackWindowState } from "./window-state";
import { CoreDaemonClient } from "./core-daemon-client";
import { ARTIFACT_SCHEME, registerArtifactProtocol, registerArtifactScheme } from "./artifact-protocol";
import { importClipboardAttachment, prepareAttachmentPaths } from "./attachment-file-service";

const isDev = !!process.env.ELECTRON_RENDERER_URL;
const coreDaemon = new CoreDaemonClient();
registerArtifactScheme();

/** Strict CSP for the packaged app; dev mode keeps Vite HMR working instead. */
function applyContentSecurityPolicy(): void {
  if (isDev) return;
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [
          `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: ${ARTIFACT_SCHEME}:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'`
        ]
      }
    });
  });
}

function registerIpcHandlers(): void {
  // Whitelisted shell-level IPC only. Business APIs are served by the Core
  // Daemon gateway (backend scope) and are intentionally not bridged here.
  ipcMain.handle("app:get-info", () => ({
    name: "AgentHub",
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node
  }));

  ipcMain.handle("core:request", async (_event, request: { requestId?: string; method: string; input?: unknown }) => {
    return coreDaemon.request(request);
  });

  ipcMain.handle("window:minimize", (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize();
  });

  ipcMain.handle("window:toggle-maximize", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });

  ipcMain.handle("window:close", (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close();
  });

  ipcMain.handle("window:is-maximized", (event) => {
    return BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false;
  });

  ipcMain.handle("dialog:pick-directory", async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, {
      title: "选择项目目录",
      properties: ["openDirectory", "createDirectory", "dontAddToRecent"]
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle("dialog:pick-files", async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return [];
    const result = await dialog.showOpenDialog(win, {
      title: "选择文件",
      properties: ["openFile", "multiSelections", "dontAddToRecent"]
    });
    if (result.canceled) return [];
    return prepareAttachmentPaths(app.getPath("userData"), result.filePaths);
  });

  ipcMain.handle("attachment:describe-paths", async (_event, paths: string[]) => prepareAttachmentPaths(app.getPath("userData"), paths));
  ipcMain.handle("attachment:import-clipboard", async (_event, input: { name: string; mimeType?: string; data: Uint8Array }) =>
    importClipboardAttachment(app.getPath("userData"), input)
  );
}

function createMainWindow(): BrowserWindow {
  const state = readWindowState();

  const win = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: 1024,
    minHeight: 660,
    show: false,
    frame: false,
    autoHideMenuBar: true,
    backgroundColor: "#090b10",
    title: "AgentHub",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false
    }
  });

  trackWindowState(win);

  win.once("ready-to-show", () => {
    if (state.isMaximized) win.maximize();
    win.show();
  });

  win.on("maximize", () => win.webContents.send("window:maximized-changed", true));
  win.on("unmaximize", () => win.webContents.send("window:maximized-changed", false));

  // Renderer never gets to open windows or navigate away on its own.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    const allowed = isDev ? process.env.ELECTRON_RENDERER_URL! : "file://";
    if (!url.startsWith(allowed)) event.preventDefault();
  });

  if (isDev) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL!);
  } else {
    void win.loadFile(join(__dirname, "../renderer/index.html"));
  }

  return win;
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  void app.whenReady().then(async () => {
    applyContentSecurityPolicy();
    registerArtifactProtocol();
    await coreDaemon.start(app.getPath("userData"));
    registerIpcHandlers();
    createMainWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      void coreDaemon.stop();
      app.quit();
    }
  });
}
