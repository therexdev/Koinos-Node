"use strict";
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const { createRequire } = require("node:module");

// Exercise the shipping Electron handlers without launching Electron or Docker.
function buildChannels(args) {
  const main = path.resolve(__dirname, "../../electron/main.js"), handles = new Map();
  const nativeRequire = createRequire(main);
  const electron = {
    app: { requestSingleInstanceLock: () => false, quit() {} },
    ipcMain: { handle: (name, fn) => handles.set(name, fn) },
    shell: { openExternal() {}, openPath() {} }, clipboard: { writeText() {} },
  };
  const context = vm.createContext({
    require: name => name === "electron" ? electron : nativeRequire(name),
    __dirname: path.dirname(main), process, console, Buffer, URL, fetch,
    setTimeout, clearTimeout, setInterval, clearInterval,
  });
  vm.runInContext(fs.readFileSync(main, "utf8"), context, { filename: main });
  context.registerIpc(args);
  return new Map([...handles].map(([name, fn]) => [name, async input => {
    const result = await fn({}, input);
    if (!result.ok) throw new Error(result.error);
    return result.data;
  }]));
}
module.exports = { buildChannels };
