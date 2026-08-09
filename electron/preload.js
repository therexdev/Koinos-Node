"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const CHANNELS = new Set([
  "app:info",
  "settings:update",
  "wallet:status",
  "wallet:create",
  "wallet:import",
  "wallet:unlock",
  "wallet:lock",
  "wallet:revealWif",
  "wallet:remove",
  "chain:balances",
  "chain:burn",
  "chain:send",
  "chain:sync",
  "chain:maxBurn",
  "producer:status",
  "producer:register",
  "node:status",
  "node:start",
  "node:stop",
  "node:logs",
  "node:quickSyncInfo",
  "node:quickSync",
  "node:quickSyncCancel",
  "setup:status",
  "setup:installWsl",
  "setup:restart",
  "setup:cancelRestart",
  "setup:installDocker",
  "setup:cancelInstallDocker",
  "setup:startDocker",
  "setup:markWslReady",
  "setup:openDockerDocs",
  "dashboard:summary",
  "rewards:status",
  "rewards:configure",
  "rewards:runNow",
  "util:copy",
  "util:openExternal",
  "util:openPath",
]);

contextBridge.exposeInMainWorld("koinos", {
  invoke: (channel, payload) => {
    if (!CHANNELS.has(channel)) {
      return Promise.resolve({ ok: false, error: `Unknown channel: ${channel}` });
    }
    return ipcRenderer.invoke(channel, payload);
  },
  onEvent: (cb) => {
    const listener = (_evt, data) => cb(data);
    ipcRenderer.on("app:event", listener);
    return () => ipcRenderer.removeListener("app:event", listener);
  },
});
