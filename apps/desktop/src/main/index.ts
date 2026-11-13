import { registerAccountLoginHandlers } from "./account-login";
import { app, BrowserWindow, dialog, ipcMain, session, shell } from "electron";
import { isAbsolute, join } from "node:path";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { registerPanelWindows } from "./panel-windows";
import type { PanelTarget } from "../shared/panel-window";
import { WorkspaceAssistant } from "./assistant/workspace-assistant";
import type { CoreRequest } from "./assistant/context";
import type { AssistantSettings } from "../shared/workspace-assistant";
import { TaskBrowser } from "./task-browser";
import { readWindowState, trackWindowState } from "./window-state";
import { CoreDaemonClient } from "./core-daemon-client";
import { ARTIFACT_SCHEME, registerArtifactProtocol, registerArtifactScheme } from "./artifact-protocol";
import { importClipboardAttachment, prepareAttachmentPaths } from "./attachment-file-service";
import { registerInteractionHandlers } from "./desktop-interactions";
import { registerProviderUpdateHandlers } from "./provider-updates";
import { RemoteBackground } from "./remote-background";

const isDev = !!process.env.ELECTRON_RENDERER_URL;
function traceStartup(phase: string): void {
  if (process.env.NAUTILO_STARTUP_TRACE) appendFileSync(process.env.NAUTILO_STARTUP_TRACE, `[startup] ${phase}\n`);
}
traceStartup("Main imports loaded");
const configuredUserDataPath = process.env.NAUTILO_USER_DATA_DIR?.trim();
if (configuredUserDataPath && !isAbsolute(configuredUserDataPath)) throw new Error("NAUTILO_USER_DATA_DIR must be an absolute path");
const legacyUserDataPath = configuredUserDataPath || app.getPath("userData");
app.setName("Nautilo");
mkdirSync(legacyUserDataPath, { recursive: true });
app.setPath("userData", legacyUserDataPath);
if (configuredUserDataPath) {
  app.setPath("sessionData", legacyUserDataPath);
  const crashPath = join(legacyUserDataPath, "crashes");
  mkdirSync(crashPath, { recursive: true });
  app.setPath("crashDumps", crashPath);
  app.setAppLogsPath(join(legacyUserDataPath, "logs"));
}
// A local preview has no Vite URL, but still uses workspace resources.
const appIcon = app.isPackaged
  ? join(process.resourcesPath, "app", "resources", "nautilo-icon.png")
  : join(__dirname, "../../resources/nautilo-icon-512.png");
const taskBrowser = new TaskBrowser();
taskBrowser.trackRuns(true);
const coreDaemon = new CoreDaemonClient((stepId,text)=>workspaceAssistant.receiveText(stepId,text),update=>taskBrowser.observeRun(update));
const remoteBackground = new RemoteBackground(appIcon,
  () => coreDaemon.request({ method: "remote.status", input: {} }) as Promise<import("@agenthub/schemas").RemoteStatus>,
  settings => {
    const win = workbenchWindow && !workbenchWindow.isDestroyed() ? workbenchWindow : createMainWindow();
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    if (settings) {
      const navigate = () => { void win.webContents.executeJavaScript('window.location.hash = "/settings?section=remote"'); };
      if (win.webContents.isLoadingMainFrame()) win.webContents.once("did-finish-load", navigate);
      else navigate();
    }
  });
const requestForAssistant: CoreRequest = (method, input) => coreDaemon.request({method,input}) as Promise<import("@agenthub/schemas").IpcRequestMap[typeof method]["output"]>;
const workspaceAssistant = new WorkspaceAssistant(requestForAssistant, sessionId => {
  if (workbenchWindow && !workbenchWindow.isDestroyed()) workbenchWindow.webContents.send("assistant:changed",sessionId);
},draft=>{if(workbenchWindow&&!workbenchWindow.isDestroyed())workbenchWindow.webContents.send("assistant:output",draft);});
let closeSessionPanels: ((id:string)=>void) | undefined;
let cycleBrowserWindows: (() => void) | undefined;
taskBrowser.setSessionCatalog(async () => {
  const projects = await coreDaemon.request({ method: "project.list" }) as Array<{id:string}>;
  const results = await Promise.allSettled(projects.map(project => coreDaemon.request({method:"session.list",input:{projectId:project.id}})));
  return results.flatMap(result => result.status === "fulfilled" && Array.isArray(result.value)
    ? result.value.map((row: {id:string;title:string;status?:string}) => ({id:row.id,title:row.title,status:row.status})) : []);
});
registerArtifactScheme();

/** Strict CSP for the packaged app; dev mode keeps Vite HMR working instead. */
function applyContentSecurityPolicy(): void {
  if (isDev) return;
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [
          `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: ${ARTIFACT_SCHEME}:; media-src 'self' blob:; font-src 'self' data:; connect-src 'self' blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'self'`
        ]
      }
    });
  });
}

function registerIpcHandlers(): void {
  // Whitelisted shell-level IPC only. Business APIs are served by the Core
  // Daemon gateway (backend scope) and are intentionally not bridged here.
  ipcMain.handle("app:get-info", () => ({
    name: "Nautilo",
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node
  }));

  ipcMain.handle("core:request", async (_event, request: { requestId?: string; method: string; input?: unknown }) => {
    const result = await coreDaemon.request(request);
    if (request.method === "remote.configure") remoteBackground.apply(result as import("@agenthub/schemas").RemoteStatus);
    if (request.method === "session.delete") {
      for (const id of (result as {sessionIds?: string[]})?.sessionIds ?? []) { closeSessionPanels?.(id); taskBrowser.release(id); }
    }
    return result;
  });

  ipcMain.handle("assistant:view", (_event,before?:number) => workspaceAssistant.view(before));
  ipcMain.handle("assistant:configure", (_event,settings:AssistantSettings) => workspaceAssistant.configure(settings));
  ipcMain.handle("assistant:submit", (_event,id:string,text:string) => workspaceAssistant.submit(id,text));
  ipcMain.handle("assistant:stop", (_event,id:string) => workspaceAssistant.stop(id));

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

  const panelWindows = registerPanelWindows(() => workbenchWindow, createPanelWindow, loadWorkbenchRenderer,
    (win,target,userInitiated) => taskBrowser.selectBrowserSpace(win,target.sessionId,userInitiated));
  closeSessionPanels = panelWindows;
  cycleBrowserWindows = panelWindows.cycle;
  taskBrowser.setWindowCycle(panelWindows.cycle);
  taskBrowser.setWindowOpener(id => panelWindows.open({kind:"browser",sessionId:id}));
  registerInteractionHandlers();
  registerProviderUpdateHandlers();
  registerAccountLoginHandlers();
}

async function registeredProjectRoots(): Promise<string[]> {
  try {
    const projects = await coreDaemon.request({ method: "project.list" }) as Array<{ rootPath?: unknown }>;
    return projects.flatMap((project) => typeof project.rootPath === "string" && project.rootPath.trim() ? [project.rootPath] : []);
  } catch {
    // The fixed roots still work while the daemon is restarting or unavailable.
    return [];
  }
}

let workbenchWindow: BrowserWindow | undefined;
function loadWorkbenchRenderer(win:BrowserWindow) {
  return isDev ? win.loadURL(process.env.ELECTRON_RENDERER_URL!) : win.loadFile(join(__dirname,"../renderer/index.html"));
}

function createPanelWindow(target:PanelTarget) {
  const browser = target.kind === "browser" || target.kind === "browser-spaces";
  const win = new BrowserWindow({
    width: target.kind === "browser-spaces" ? 1480 : 1220, height:target.kind === "browser-spaces" ? 920 : 820, minWidth:500, minHeight:360,
    frame: !browser, backgroundColor: browser ? "#eef3f8" : undefined,
    show:false, autoHideMenuBar:true, icon:appIcon, title:browser ? "Nautilo · 浏览器" : "Nautilo · Git",
    webPreferences:{preload:join(__dirname,"../preload/index.js"),sandbox:true,contextIsolation:true,
      nodeIntegration:false,webSecurity:true,spellcheck:false,
      additionalArguments:["--nautilo-panel="+encodeURIComponent(JSON.stringify(target))]},
  });
  win.webContents.setWindowOpenHandler(()=>({action:"deny"}));
  win.webContents.on("will-navigate",event=>event.preventDefault());
  if (browser) {
    win.webContents.on("page-title-updated", event => event.preventDefault());
    win.on("maximize", () => win.webContents.send("window:maximized-changed", true));
    win.on("unmaximize", () => win.webContents.send("window:maximized-changed", false));
    win.webContents.on("before-input-event", (event, input) => {
      if (input.type === "keyDown" && input.alt && input.key.toLowerCase() === "s") {
        event.preventDefault();
        if (!input.isAutoRepeat) cycleBrowserWindows?.();
      }
    });
  }
  if (browser) taskBrowser.attachBrowserHost(win);
  return win;
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
    icon: appIcon,
    title: "Nautilo",
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

  workbenchWindow = win;
  remoteBackground.attach(win);
  win.once("closed", () => { if (workbenchWindow === win) workbenchWindow = undefined; });
  trackWindowState(win);
  taskBrowser.attachWindow(win);

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

  void loadWorkbenchRenderer(win);

  return win;
}

traceStartup("Requesting the single-instance lock");
const gotSingleInstanceLock = app.requestSingleInstanceLock();
traceStartup(`Single-instance lock: ${gotSingleInstanceLock}`);
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const win = workbenchWindow;
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });

  void app.whenReady().then(async () => {
    traceStartup("Electron ready");
    applyContentSecurityPolicy();
    registerArtifactProtocol(registeredProjectRoots);
    const dataDir = app.getPath("userData");
    const port = await taskBrowser.start(() => readFileSync(join(dataDir, "core.token"), "utf8").trim());
    traceStartup("Browser service ready");
    await coreDaemon.start(dataDir, port);
    traceStartup("Rust backend ready");
    await remoteBackground.start();
    taskBrowser.register();
    registerIpcHandlers();
    void workspaceAssistant.start().catch(error => console.error("Assistant startup:",error.message));
    traceStartup("Creating the main window");
    createMainWindow();
    traceStartup("Main window created");

    app.on("activate", () => {
      if (!workbenchWindow) createMainWindow();
    });
  });

  let browserShutdownReady=false, browserShutdownPending=false;
  app.on("before-quit", event => {
    if(browserShutdownReady)return;
    event.preventDefault();
    if(browserShutdownPending)return;
    browserShutdownPending=true;
    remoteBackground.close();
    workspaceAssistant.close();
    void taskBrowser.close().catch(error=>console.error("Browser shutdown:",error.message)).finally(()=>{
      browserShutdownReady=true;
      app.quit();
    });
  });
  app.on("window-all-closed", () => {
    if (remoteBackground.running) return;
    if (process.platform !== "darwin") {
      void coreDaemon.stop();
      app.quit();
    }
  });
}
