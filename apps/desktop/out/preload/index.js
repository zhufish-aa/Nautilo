"use strict";
const electron = require("electron");
const bridge = {
  isElectron: true,
  platform: process.platform,
  getAppInfo: () => electron.ipcRenderer.invoke("app:get-info"),
  window: {
    minimize: () => electron.ipcRenderer.invoke("window:minimize"),
    toggleMaximize: () => electron.ipcRenderer.invoke("window:toggle-maximize"),
    close: () => electron.ipcRenderer.invoke("window:close"),
    isMaximized: () => electron.ipcRenderer.invoke("window:is-maximized"),
    onMaximizedChange: (callback) => {
      const listener = (_event, maximized) => {
        callback(maximized);
      };
      electron.ipcRenderer.on("window:maximized-changed", listener);
      return () => {
        electron.ipcRenderer.removeListener("window:maximized-changed", listener);
      };
    }
  },
  dialog: {
    pickDirectory: () => electron.ipcRenderer.invoke("dialog:pick-directory"),
    pickFiles: () => electron.ipcRenderer.invoke("dialog:pick-files")
  },
  attachments: {
    pathForFile: (file) => electron.webUtils.getPathForFile(file),
    describePaths: (paths) => electron.ipcRenderer.invoke("attachment:describe-paths", paths),
    importClipboard: (input) => electron.ipcRenderer.invoke("attachment:import-clipboard", input)
  },
  shell: {
    openPath: (path) => electron.ipcRenderer.invoke("shell:open-path", path),
    showItemInFolder: (path) => electron.ipcRenderer.invoke("shell:show-item-in-folder", path)
  },
  images: {
    copyToClipboard: (input) => electron.ipcRenderer.invoke("clipboard:write-image", input),
    saveAs: (input) => electron.ipcRenderer.invoke("image:save-as", input)
  },
  menu: {
    popup: (items) => electron.ipcRenderer.invoke("menu:popup", items)
  },
  files: {
    readText: (input) => electron.ipcRenderer.invoke("file:read-text", input)
  },
  providers: {
    startUpdate: (input) => electron.ipcRenderer.invoke("provider:update-start", input),
    cancelUpdate: (updateId) => electron.ipcRenderer.invoke("provider:update-cancel", updateId),
    onUpdateOutput: (callback) => {
      const listener = (_event, payload) => {
        callback(payload.updateId, payload.chunk);
      };
      electron.ipcRenderer.on("provider:update-output", listener);
      return () => {
        electron.ipcRenderer.removeListener("provider:update-output", listener);
      };
    },
    onUpdateExit: (callback) => {
      const listener = (_event, payload) => {
        callback(payload.updateId, payload.exitCode, payload.error);
      };
      electron.ipcRenderer.on("provider:update-exit", listener);
      return () => {
        electron.ipcRenderer.removeListener("provider:update-exit", listener);
      };
    }
  },
  core: {
    request: (request) => electron.ipcRenderer.invoke("core:request", request)
  }
};
electron.contextBridge.exposeInMainWorld("agenthub", bridge);
//# sourceMappingURL=index.js.map
