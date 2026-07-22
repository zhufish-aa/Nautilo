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
    pickDirectory: () => electron.ipcRenderer.invoke("dialog:pick-directory")
  },
  core: {
    request: (request) => electron.ipcRenderer.invoke("core:request", request)
  }
};
electron.contextBridge.exposeInMainWorld("agenthub", bridge);
//# sourceMappingURL=index.js.map
