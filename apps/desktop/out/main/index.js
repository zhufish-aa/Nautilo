"use strict";
const electron = require("electron");
const node_path = require("node:path");
const node_fs = require("node:fs");
const node_child_process = require("node:child_process");
const node_net = require("node:net");
const node_os = require("node:os");
const node_url = require("node:url");
const node_crypto = require("node:crypto");
const promises = require("node:fs/promises");
const DEFAULT_STATE = {
  width: 1360,
  height: 860,
  isMaximized: false
};
function stateFilePath() {
  return node_path.join(electron.app.getPath("userData"), "window-state.json");
}
function isVisibleOnSomeDisplay(state) {
  if (state.x === void 0 || state.y === void 0) return false;
  return electron.screen.getAllDisplays().some((display) => {
    const { x, y, width, height } = display.workArea;
    return state.x >= x - 8 && state.y >= y - 8 && state.x < x + width && state.y < y + height;
  });
}
function readWindowState() {
  try {
    const file = stateFilePath();
    if (!node_fs.existsSync(file)) return { ...DEFAULT_STATE };
    const parsed = JSON.parse(node_fs.readFileSync(file, "utf-8"));
    const state = {
      width: Math.max(960, Number(parsed.width) || DEFAULT_STATE.width),
      height: Math.max(640, Number(parsed.height) || DEFAULT_STATE.height),
      x: typeof parsed.x === "number" ? parsed.x : void 0,
      y: typeof parsed.y === "number" ? parsed.y : void 0,
      isMaximized: parsed.isMaximized === true
    };
    if (!isVisibleOnSomeDisplay(state)) {
      state.x = void 0;
      state.y = void 0;
    }
    return state;
  } catch {
    return { ...DEFAULT_STATE };
  }
}
function trackWindowState(win) {
  let timer;
  const save = () => {
    if (win.isDestroyed()) return;
    const isMaximized = win.isMaximized();
    const bounds = isMaximized ? win.getNormalBounds() : win.getBounds();
    const state = {
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y,
      isMaximized
    };
    try {
      const file = stateFilePath();
      node_fs.mkdirSync(node_path.dirname(file), { recursive: true });
      node_fs.writeFileSync(file, JSON.stringify(state, null, 2), "utf-8");
    } catch {
    }
  };
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(save, 400);
  };
  win.on("resize", schedule);
  win.on("move", schedule);
  win.on("maximize", schedule);
  win.on("unmaximize", schedule);
  win.on("close", save);
}
class CoreDaemonClient {
  process;
  socketPath;
  tokenPath;
  async start(userDataPath) {
    if (this.process) return;
    const daemonEntry = this.resolveDaemonEntry();
    const nodeCommand = this.resolveNodeCommand();
    const socketPath = process.platform === "win32" ? "\\\\.\\pipe\\agenthub-core" : node_path.join(userDataPath, "core.sock");
    this.tokenPath = node_path.join(userDataPath, "core.token");
    this.process = node_child_process.spawn(nodeCommand, [daemonEntry, "--serve"], {
      cwd: userDataPath,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, AGENTHUB_DATA_DIR: userDataPath, AGENTHUB_SOCKET: socketPath, AGENTHUB_TOKEN_PATH: this.tokenPath }
    });
    const ready = await this.waitForReady(this.process);
    this.socketPath = ready.socketPath;
  }
  resolveDaemonEntry() {
    const candidates = [
      // Development/build layout: apps/desktop/out/main -> repository root.
      node_path.join(__dirname, "../../../../packages/core-daemon/dist/index.js"),
      // Packaged layout reserved for the release bundle.
      node_path.join(process.resourcesPath, "core-daemon/index.js")
    ];
    const entry = candidates.find((candidate) => node_fs.existsSync(candidate));
    if (!entry) throw new Error(`Core Daemon entry was not found: ${candidates.join(", ")}`);
    return entry;
  }
  resolveNodeCommand() {
    if (process.env.AGENTHUB_NODE_PATH) return process.env.AGENTHUB_NODE_PATH;
    const executable = process.platform === "win32" ? "node.exe" : "node";
    const bundledRuntime = node_path.join(process.resourcesPath, "node", executable);
    return node_fs.existsSync(bundledRuntime) ? bundledRuntime : executable;
  }
  async request(request) {
    if (!this.socketPath || !this.tokenPath) throw new Error("Core Daemon is not ready");
    if (!node_fs.existsSync(this.tokenPath)) throw new Error("Core Daemon authentication token is missing");
    const token = node_fs.readFileSync(this.tokenPath, "utf8").trim();
    const socket = await this.connect(this.socketPath);
    const lines = this.readLines(socket);
    socket.write(`${JSON.stringify({ token })}
`);
    const authenticated = await lines.next();
    if (!authenticated.value?.ok) {
      socket.destroy();
      throw new Error("Core Daemon authentication failed");
    }
    socket.write(`${JSON.stringify({ request })}
`);
    const response = await lines.next();
    socket.end();
    if (!response.value?.ok) {
      const reason = response.value?.error?.details?.reason;
      throw new Error(typeof reason === "string" ? reason : response.value?.error?.message ?? "Core Daemon request failed");
    }
    return response.value.data;
  }
  async stop() {
    const child = this.process;
    this.process = void 0;
    this.socketPath = void 0;
    if (!child) return;
    child.kill();
    await new Promise((resolve) => child.once("close", () => resolve()));
  }
  async waitForReady(child) {
    return new Promise((resolve, reject) => {
      let buffer = "";
      const timer = setTimeout(() => reject(new Error("Core Daemon did not become ready")), 15e3);
      const onData = (chunk) => {
        buffer += chunk.toString("utf8");
        const parts = buffer.split(/\r?\n/);
        buffer = parts.pop() ?? "";
        for (const line of parts) {
          if (!line.trim()) continue;
          try {
            const message = JSON.parse(line);
            if (message.status === "ok") {
              clearTimeout(timer);
              resolve(message);
              return;
            }
          } catch {
          }
        }
      };
      child.stdout?.on("data", onData);
      child.stderr?.on("data", (chunk) => console.error(`[core-daemon] ${chunk.toString("utf8")}`));
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code) => {
        if (code !== 0) {
          clearTimeout(timer);
          reject(new Error(`Core Daemon exited with ${code}`));
        }
      });
    });
  }
  connect(path) {
    return new Promise((resolve, reject) => {
      const socket = node_net.connect(path);
      socket.once("connect", () => resolve(socket));
      socket.once("error", reject);
    });
  }
  readLines(socket) {
    let buffer = "";
    const queue = [];
    const waiters = [];
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const parts = buffer.split("\n");
      buffer = parts.pop() ?? "";
      for (const line of parts) {
        if (!line.trim()) continue;
        const value = JSON.parse(line);
        const waiter = waiters.shift();
        if (waiter) waiter({ value, done: false });
        else queue.push(value);
      }
    });
    socket.once("close", () => {
      for (const waiter of waiters.splice(0)) waiter({ value: void 0, done: true });
    });
    return {
      next: async () => queue.length ? { value: queue.shift(), done: false } : new Promise((resolve) => waiters.push(resolve)),
      return: async () => ({ value: void 0, done: true })
    };
  }
}
const ARTIFACT_SCHEME = "agenthub-artifact";
function registerArtifactScheme() {
  electron.protocol.registerSchemesAsPrivileged([{
    scheme: ARTIFACT_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
  }]);
}
function registerArtifactProtocol() {
  const allowedRoots = [
    node_path.resolve(node_os.homedir(), ".codex", "generated_images"),
    node_path.resolve(electron.app.getPath("userData"), "attachments")
  ];
  electron.protocol.handle(ARTIFACT_SCHEME, (request) => {
    const requestedPath = new URL(request.url).searchParams.get("path");
    if (!requestedPath) return new Response("Missing artifact path", { status: 400 });
    const candidate = node_path.resolve(requestedPath);
    if (!allowedRoots.some((root) => isWithin$1(root, candidate))) return new Response("Forbidden", { status: 403 });
    if (!node_fs.existsSync(candidate)) return new Response("Artifact not found", { status: 404 });
    return electron.net.fetch(node_url.pathToFileURL(candidate).toString());
  });
}
function isWithin$1(root, candidate) {
  const path = node_path.relative(root, candidate);
  return path === "" || !path.startsWith("..") && !node_path.isAbsolute(path);
}
const MAX_CLIPBOARD_BYTES = 32 * 1024 * 1024;
const IMAGE_EXTENSIONS = /* @__PURE__ */ new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".avif"]);
async function describeAttachmentPaths(paths) {
  return Promise.all(paths.map(async (path) => {
    const file = await promises.stat(path);
    if (!file.isFile()) throw new Error(`Attachment is not a file: ${path}`);
    const name = node_path.basename(path);
    const mimeType = inferMimeType(name);
    return { path, name, sizeBytes: file.size, kind: mimeType?.startsWith("image/") ? "image" : "file", mimeType };
  }));
}
async function prepareAttachmentPaths(dataDir, paths) {
  const described = await describeAttachmentPaths(paths);
  const directory = node_path.resolve(dataDir, "attachments", "selected");
  await promises.mkdir(directory, { recursive: true });
  return Promise.all(described.map(async (attachment) => {
    if (attachment.kind !== "image" || isWithin(node_path.resolve(dataDir, "attachments"), node_path.resolve(attachment.path))) return attachment;
    const extension = node_path.extname(attachment.name).slice(0, 16);
    const path = node_path.join(directory, `${node_crypto.randomUUID()}${extension}`);
    await promises.copyFile(attachment.path, path);
    return { ...attachment, path };
  }));
}
async function importClipboardAttachment(dataDir, input) {
  const bytes = Buffer.from(input.data);
  if (!bytes.length || bytes.length > MAX_CLIPBOARD_BYTES) {
    throw new Error(`Clipboard attachment must be between 1 byte and ${MAX_CLIPBOARD_BYTES} bytes`);
  }
  const originalExtension = node_path.extname(input.name).slice(0, 16);
  const extension = originalExtension || extensionForMime(input.mimeType);
  const directory = node_path.join(dataDir, "attachments", "clipboard");
  await promises.mkdir(directory, { recursive: true });
  const path = node_path.join(directory, `${node_crypto.randomUUID()}${extension}`);
  await promises.writeFile(path, bytes, { flag: "wx" });
  const mimeType = input.mimeType || inferMimeType(input.name);
  return {
    path,
    name: input.name || `clipboard${extension}`,
    sizeBytes: bytes.length,
    kind: mimeType?.startsWith("image/") ? "image" : "file",
    mimeType
  };
}
function inferMimeType(name) {
  const extension = node_path.extname(name).toLowerCase();
  const known = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".svg": "image/svg+xml",
    ".avif": "image/avif",
    ".pdf": "application/pdf",
    ".json": "application/json",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".csv": "text/csv",
    ".html": "text/html",
    ".ts": "text/typescript",
    ".tsx": "text/typescript",
    ".js": "text/javascript",
    ".jsx": "text/javascript"
  };
  return known[extension] ?? (IMAGE_EXTENSIONS.has(extension) ? `image/${extension.slice(1)}` : void 0);
}
function extensionForMime(mimeType) {
  const extensions = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/bmp": ".bmp",
    "image/svg+xml": ".svg",
    "application/pdf": ".pdf",
    "text/plain": ".txt"
  };
  return mimeType ? extensions[mimeType] ?? "" : "";
}
function isWithin(root, candidate) {
  const path = node_path.relative(root, candidate);
  return path === "" || !path.startsWith("..") && !node_path.isAbsolute(path);
}
const SKIP_DIRS = /* @__PURE__ */ new Set([
  "node_modules",
  ".git",
  "dist",
  "out",
  "release",
  "coverage",
  "build",
  ".idea",
  ".vscode",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  ".parcel-cache",
  "target",
  "__pycache__",
  ".pytest_cache",
  ".svn",
  ".hg",
  "vendor",
  "tmp",
  "temp"
]);
const MAX_DEPTH = 8;
const MAX_MATCHES = 50;
async function searchFileReferences(queryPath, basePaths) {
  const query = queryPath.replace(/\\/g, "/").toLowerCase().replace(/^\.\//, "");
  if (!query) return [];
  const bare = !query.includes("/");
  const matches = [];
  const walk = async (dir, depth) => {
    if (depth > MAX_DEPTH || matches.length >= MAX_MATCHES) return;
    let entries;
    try {
      entries = await promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (matches.length >= MAX_MATCHES) return;
      if (entry.isSymbolicLink()) continue;
      const full = node_path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(full, depth + 1);
      } else if (entry.isFile()) {
        if (bare) {
          if (entry.name.toLowerCase() === query) matches.push(full);
        } else {
          const candidate = full.replace(/\\/g, "/").toLowerCase();
          if (candidate.endsWith(query) && (candidate.length === query.length || candidate[candidate.length - query.length - 1] === "/")) {
            matches.push(full);
          }
        }
      }
    }
  };
  for (const base of new Set(basePaths)) {
    await walk(base, 0);
    if (matches.length >= MAX_MATCHES) break;
  }
  return matches;
}
const MAX_TEXT_PREVIEW_BYTES = 2 * 1024 * 1024;
function registerInteractionHandlers() {
  electron.ipcMain.handle("shell:open-path", (_event, path) => electron.shell.openPath(path));
  electron.ipcMain.handle("shell:show-item-in-folder", (_event, path) => {
    electron.shell.showItemInFolder(path);
  });
  electron.ipcMain.handle("clipboard:write-image", (_event, payload) => {
    const image = payload.path ? electron.nativeImage.createFromPath(payload.path) : payload.dataUrl ? electron.nativeImage.createFromDataURL(payload.dataUrl) : electron.nativeImage.createEmpty();
    if (image.isEmpty()) return false;
    electron.clipboard.writeImage(image);
    return true;
  });
  electron.ipcMain.handle("image:save-as", async (event, payload) => {
    const win = electron.BrowserWindow.fromWebContents(event.sender);
    if (!win) return null;
    const result = await electron.dialog.showSaveDialog(win, {
      title: "Save image",
      defaultPath: payload.defaultName ?? "image.png"
    });
    if (result.canceled || !result.filePath) return null;
    if (payload.path) {
      await promises.copyFile(payload.path, result.filePath);
    } else if (payload.dataUrl) {
      const image = electron.nativeImage.createFromDataURL(payload.dataUrl);
      if (image.isEmpty()) throw new Error("Invalid image data");
      await promises.writeFile(result.filePath, image.toPNG());
    } else {
      return null;
    }
    return result.filePath;
  });
  electron.ipcMain.handle("menu:popup", async (event, items) => {
    const win = electron.BrowserWindow.fromWebContents(event.sender);
    if (!win || !Array.isArray(items) || items.length === 0) return null;
    return new Promise((resolve2) => {
      let settled = false;
      const settle = (id) => {
        if (settled) return;
        settled = true;
        resolve2(id);
      };
      const template = items.map(
        (item) => item.type === "separator" ? { type: "separator" } : { label: item.label, enabled: item.enabled ?? true, click: () => settle(item.id) }
      );
      electron.Menu.buildFromTemplate(template).popup({ window: win, callback: () => settle(null) });
    });
  });
  electron.ipcMain.handle("file:read-text", async (_event, payload) => {
    const candidates = node_path.isAbsolute(payload.path) ? [payload.path] : (payload.basePaths ?? []).map((base) => node_path.resolve(base, payload.path));
    let resolvedPath;
    let sizeBytes = 0;
    for (const candidate of candidates) {
      try {
        const info = await promises.stat(candidate);
        if (!info.isFile()) return { ok: false, reason: "not-file" };
        resolvedPath = candidate;
        sizeBytes = info.size;
        break;
      } catch {
      }
    }
    if (!resolvedPath) {
      const found = await searchFileReferences(payload.path, payload.basePaths ?? []);
      if (found.length === 0) return { ok: false, reason: "not-found" };
      if (found.length > 1) return { ok: false, reason: "ambiguous", candidates: found };
      const info = await promises.stat(found[0]);
      resolvedPath = found[0];
      sizeBytes = info.size;
    }
    const handle = await promises.open(resolvedPath, "r");
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
      const handle2 = await promises.open(resolvedPath, "r");
      try {
        await handle2.read(buffer, 0, buffer.length, 0);
      } finally {
        await handle2.close();
      }
    }
    return { ok: true, resolvedPath, content: buffer.toString("utf8"), truncated, sizeBytes };
  });
}
const MAX_OUTPUT_BYTES = 256 * 1024;
const activeUpdates = /* @__PURE__ */ new Map();
function spawnUpdate(executable, args) {
  if (process.platform === "win32") {
    const line = [`"${executable}"`, ...args.map((arg) => `"${arg.replace(/"/g, "")}"`)].join(" ");
    return node_child_process.spawn(line, { shell: true, windowsHide: true });
  }
  return node_child_process.spawn(executable, args, { windowsHide: true });
}
function registerProviderUpdateHandlers() {
  electron.ipcMain.handle("provider:update-start", (event, payload) => {
    const updateId = typeof payload?.updateId === "string" ? payload.updateId : "";
    const executable = typeof payload?.executable === "string" ? payload.executable.trim() : "";
    const args = Array.isArray(payload?.args) ? payload.args.filter((arg) => typeof arg === "string" && arg.trim().length > 0) : [];
    if (!updateId || !executable || args.length === 0) return { ok: false, reason: "invalid-payload" };
    if (activeUpdates.has(updateId)) return { ok: false, reason: "busy" };
    const sender = event.sender;
    const send = (channel, data) => {
      if (!sender.isDestroyed()) sender.send(channel, data);
    };
    let child;
    try {
      child = spawnUpdate(executable, args);
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
    activeUpdates.set(updateId, child);
    let buffered = 0;
    const decoder = new TextDecoder(process.platform === "win32" ? "gbk" : "utf-8");
    const onData = (chunk) => {
      buffered += chunk.length;
      if (buffered > MAX_OUTPUT_BYTES) return;
      send("provider:update-output", { updateId, chunk: decoder.decode(chunk, { stream: true }) });
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (error) => {
      activeUpdates.delete(updateId);
      send("provider:update-exit", { updateId, exitCode: -1, error: error.message });
    });
    child.on("exit", (code) => {
      activeUpdates.delete(updateId);
      send("provider:update-exit", { updateId, exitCode: code ?? -1 });
    });
    return { ok: true };
  });
  electron.ipcMain.handle("provider:update-cancel", (_event, updateId) => {
    if (typeof updateId === "string") activeUpdates.get(updateId)?.kill();
  });
}
const isDev = !!process.env.ELECTRON_RENDERER_URL;
const coreDaemon = new CoreDaemonClient();
registerArtifactScheme();
function applyContentSecurityPolicy() {
  if (isDev) return;
  electron.session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
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
function registerIpcHandlers() {
  electron.ipcMain.handle("app:get-info", () => ({
    name: "AgentHub",
    version: electron.app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node
  }));
  electron.ipcMain.handle("core:request", async (_event, request) => {
    return coreDaemon.request(request);
  });
  electron.ipcMain.handle("window:minimize", (event) => {
    electron.BrowserWindow.fromWebContents(event.sender)?.minimize();
  });
  electron.ipcMain.handle("window:toggle-maximize", (event) => {
    const win = electron.BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  electron.ipcMain.handle("window:close", (event) => {
    electron.BrowserWindow.fromWebContents(event.sender)?.close();
  });
  electron.ipcMain.handle("window:is-maximized", (event) => {
    return electron.BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false;
  });
  electron.ipcMain.handle("dialog:pick-directory", async (event) => {
    const win = electron.BrowserWindow.fromWebContents(event.sender);
    if (!win) return null;
    const result = await electron.dialog.showOpenDialog(win, {
      title: "选择项目目录",
      properties: ["openDirectory", "createDirectory", "dontAddToRecent"]
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });
  electron.ipcMain.handle("dialog:pick-files", async (event) => {
    const win = electron.BrowserWindow.fromWebContents(event.sender);
    if (!win) return [];
    const result = await electron.dialog.showOpenDialog(win, {
      title: "选择文件",
      properties: ["openFile", "multiSelections", "dontAddToRecent"]
    });
    if (result.canceled) return [];
    return prepareAttachmentPaths(electron.app.getPath("userData"), result.filePaths);
  });
  electron.ipcMain.handle("attachment:describe-paths", async (_event, paths) => prepareAttachmentPaths(electron.app.getPath("userData"), paths));
  electron.ipcMain.handle(
    "attachment:import-clipboard",
    async (_event, input) => importClipboardAttachment(electron.app.getPath("userData"), input)
  );
  registerInteractionHandlers();
  registerProviderUpdateHandlers();
}
function createMainWindow() {
  const state = readWindowState();
  const win = new electron.BrowserWindow({
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
      preload: node_path.join(__dirname, "../preload/index.js"),
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
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void electron.shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    const allowed = isDev ? process.env.ELECTRON_RENDERER_URL : "file://";
    if (!url.startsWith(allowed)) event.preventDefault();
  });
  if (isDev) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(node_path.join(__dirname, "../renderer/index.html"));
  }
  return win;
}
const gotSingleInstanceLock = electron.app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  electron.app.quit();
} else {
  electron.app.on("second-instance", () => {
    const [win] = electron.BrowserWindow.getAllWindows();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  void electron.app.whenReady().then(async () => {
    applyContentSecurityPolicy();
    registerArtifactProtocol();
    await coreDaemon.start(electron.app.getPath("userData"));
    registerIpcHandlers();
    createMainWindow();
    electron.app.on("activate", () => {
      if (electron.BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
  });
  electron.app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      void coreDaemon.stop();
      electron.app.quit();
    }
  });
}
//# sourceMappingURL=index.js.map
