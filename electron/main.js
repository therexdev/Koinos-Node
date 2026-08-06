"use strict";

const { app, BrowserWindow, ipcMain, shell, clipboard, dialog } = require("electron");
const path = require("path");
const fs = require("fs");

const { JsonStore } = require("./lib/store");
const { NETWORKS, DEFAULT_SETTINGS } = require("./lib/constants");
const { WalletService, MIN_PASSWORD_LENGTH } = require("./lib/wallet");
const { ChainService } = require("./lib/chain");
const { NodeManager } = require("./lib/node-manager");
const { RewardEngine } = require("./lib/rewards");
const { parseAmount, formatAmount, subSats, cmpSats } = require("./lib/format");

let win = null;

function sendEvent(payload) {
  if (win && !win.isDestroyed()) {
    win.webContents.send("app:event", { time: Date.now(), ...payload });
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: "#0b0f17",
    autoHideMenuBar: true,
    title: "Koinos Node Desktop",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, "..", "ui", "index.html"));
  win.on("closed", () => {
    win = null;
  });

  // Headless smoke-test hook: when KND_SMOKE_DIR is set, click through every
  // view, capture PNGs, and exit. Used for automated sanity checks.
  const smokeDir = process.env.KND_SMOKE_DIR;
  if (smokeDir) {
    win.webContents.once("did-finish-load", () => {
      setTimeout(async () => {
        try {
          for (const view of ["wallet", "burn", "node", "returns", "settings"]) {
            await win.webContents.executeJavaScript(
              `document.querySelector('[data-view="${view}"]').click()`
            );
            await new Promise((r) => setTimeout(r, 1500));
            const img = await win.webContents.capturePage();
            fs.writeFileSync(path.join(smokeDir, `screenshot-${view}.png`), img.toPNG());
          }
          console.log("SMOKE_OK");
        } catch (e) {
          console.error("SMOKE_FAIL", e);
          process.exitCode = 1;
        } finally {
          app.quit();
        }
      }, 5000);
    });
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    const userData = app.getPath("userData");
    const settings = new JsonStore(path.join(userData, "settings.json"), DEFAULT_SETTINGS);
    const state = new JsonStore(path.join(userData, "state.json"), {});
    const wallet = new WalletService(path.join(userData, "wallet"));
    const chain = new ChainService(settings);
    const nodeMgr = new NodeManager({
      templateRoot: path.join(__dirname, "..", "node-template"),
      dataRoot: path.join(userData, "node"),
      onEvent: sendEvent,
    });
    const rewards = new RewardEngine({ chain, wallet, settings, state, onEvent: sendEvent });
    rewards.start();

    registerIpc({ settings, wallet, chain, nodeMgr, rewards, userData });
    createWindow();
    setupAutoUpdates();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
    app.on("before-quit", () => rewards.stop());
  });

  app.on("window-all-closed", () => {
    app.quit();
  });
}

// Checks GitHub Releases for new versions (installed builds only), downloads
// in the background, and offers to restart. "Later" still applies the update
// on quit.
function setupAutoUpdates() {
  if (!app.isPackaged) return;
  let updater;
  try {
    ({ autoUpdater: updater } = require("electron-updater"));
  } catch {
    return;
  }
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.on("update-available", (info) => {
    sendEvent({ type: "update", message: `Update v${info.version} found — downloading in the background…` });
  });
  updater.on("update-downloaded", async (info) => {
    sendEvent({ type: "update", message: `Update v${info.version} downloaded — restart to install.` });
    const { response } = await dialog.showMessageBox(win, {
      type: "info",
      buttons: ["Restart now", "Later"],
      defaultId: 0,
      cancelId: 1,
      message: `Koinos Node Desktop v${info.version} is ready to install`,
      detail:
        "Restart the app to apply the update now. If you choose Later, it installs automatically the next time you quit. Your wallet, settings, and the running node are not affected.",
    });
    if (response === 0) updater.quitAndInstall();
  });
  updater.on("error", () => {
    // Update checks are best-effort; never bother the user about them failing.
  });
  const check = () => updater.checkForUpdates().catch(() => {});
  check();
  setInterval(check, 4 * 60 * 60 * 1000);
}

function registerIpc({ settings, wallet, chain, nodeMgr, rewards, userData }) {
  const handle = (channel, fn) =>
    ipcMain.handle(channel, async (_evt, payload) => {
      try {
        return { ok: true, data: await fn(payload ?? {}) };
      } catch (e) {
        return { ok: false, error: String(e?.message ?? e) };
      }
    });

  const publicNetworks = Object.fromEntries(
    Object.entries(NETWORKS).map(([id, n]) => [
      id,
      {
        id,
        label: n.label,
        tokenSymbol: n.tokenSymbol,
        explorer: n.explorer,
        contracts: n.contracts,
        ports: n.ports,
        rpcUrls: n.rpcUrls,
        localRpcUrl: n.localRpcUrl,
      },
    ])
  );

  // ----- app / settings -----
  handle("app:info", () => ({
    version: require("../package.json").version,
    platform: process.platform,
    userData,
    networks: publicNetworks,
    settings: settings.all(),
    minPasswordLength: MIN_PASSWORD_LENGTH,
  }));

  handle("settings:update", ({ network, customRpc, keepLiquidKoin }) => {
    if (network !== undefined) {
      if (!NETWORKS[network]) throw new Error(`Unknown network: ${network}`);
      settings.set("network", network);
      chain.clearCache();
      rewards.start(); // re-arm timer; reward baselines are tracked per network
    }
    if (customRpc !== undefined) {
      for (const [netId, url] of Object.entries(customRpc)) {
        if (!NETWORKS[netId]) throw new Error(`Unknown network: ${netId}`);
        if (url && !/^https?:\/\/\S+$/.test(url)) throw new Error("RPC URL must start with http(s)://");
        settings.set(`customRpc.${netId}`, url || "");
      }
      chain.clearCache();
    }
    if (keepLiquidKoin !== undefined) {
      parseAmount(keepLiquidKoin);
      settings.set("keepLiquidKoin", String(keepLiquidKoin));
    }
    return settings.all();
  });

  // ----- wallet -----
  handle("wallet:status", () => wallet.status());
  handle("wallet:create", ({ password }) => wallet.create({ password }));
  handle("wallet:import", ({ wif, password }) => wallet.importWif({ wif, password }));
  handle("wallet:unlock", ({ password }) => wallet.unlock(password));
  handle("wallet:lock", () => wallet.lock());
  handle("wallet:revealWif", ({ password }) => wallet.revealWif(password));
  handle("wallet:remove", ({ password, confirm }) => wallet.remove({ password, confirm }));

  // ----- chain -----
  handle("chain:balances", async () => {
    const address = wallet.address;
    if (!address) return { address: null };
    const b = await chain.balances(address);
    return {
      address,
      ...b,
      formatted: {
        koin: formatAmount(b.koin),
        vhp: formatAmount(b.vhp),
        mana: formatAmount(b.mana),
      },
    };
  });

  handle("chain:burn", async ({ amount }) => {
    const amountSat = parseAmount(amount);
    const res = await chain.burn(wallet.signer, amountSat);
    sendEvent({
      type: "burn",
      message: `Burned ${formatAmount(amountSat)} ${chain.network().tokenSymbol} → VHP`,
      txId: res.txId,
    });
    return { ...res, amountSat, amountFormatted: formatAmount(amountSat) };
  });

  handle("chain:send", async ({ to, amount, token }) => {
    const amountSat = parseAmount(amount);
    const res = await chain.transfer(wallet.signer, { to, amountSat, token });
    sendEvent({
      type: "send",
      message: `Sent ${formatAmount(amountSat)} ${String(token).toUpperCase()} to ${to}`,
      txId: res.txId,
    });
    return { ...res, amountSat };
  });

  handle("chain:sync", () => chain.syncStatus());

  handle("chain:maxBurn", async () => {
    const address = wallet.address;
    if (!address) throw new Error("No wallet");
    const { koin } = await chain.balances(address);
    const keep = parseAmount(settings.get("keepLiquidKoin", "10"));
    const max = cmpSats(koin, keep) > 0 ? subSats(koin, keep) : "0";
    return { maxSat: max, maxFormatted: formatAmount(max, { grouping: false }) };
  });

  // ----- block producer registration -----
  handle("producer:status", async () => {
    const networkId = chain.network().id;
    const address = wallet.address;
    const filePublicKey = nodeMgr.readProducerPublicKey(networkId);
    let registeredPublicKey = null;
    if (address) {
      registeredPublicKey = await chain.registeredPublicKey(address);
    }
    return {
      address,
      filePublicKey,
      registeredPublicKey,
      matches: !!filePublicKey && filePublicKey === registeredPublicKey,
    };
  });

  handle("producer:register", async () => {
    const networkId = chain.network().id;
    const pub = nodeMgr.readProducerPublicKey(networkId);
    if (!pub) {
      throw new Error(
        "No signing key found yet. Start the node once — the block producer generates its key on first run."
      );
    }
    const res = await chain.registerProducerKey(wallet.signer, pub);
    sendEvent({ type: "producer", message: "Block production key registered on chain", txId: res.txId });
    return res;
  });

  // ----- node -----
  handle("node:status", async () => {
    const networkId = chain.network().id;
    const status = await nodeMgr.status(networkId);
    let sync = null;
    if (status.isRunning) {
      sync = await chain.syncStatus().catch(() => null);
    }
    return { network: networkId, ...status, sync };
  });

  handle("node:start", async ({ produce }) => {
    const networkId = chain.network().id;
    let producerAddress = null;
    if (produce) {
      producerAddress = wallet.address;
      if (!producerAddress) throw new Error("Create a wallet first to enable block production");
    }
    return nodeMgr.start(networkId, producerAddress);
  });

  handle("node:stop", () => nodeMgr.stop(chain.network().id));
  handle("node:logs", ({ service, tail }) => nodeMgr.logs(chain.network().id, service, tail));

  // ----- rewards -----
  handle("rewards:status", () => rewards.status());
  handle("rewards:configure", (patch) => rewards.configure(patch));
  handle("rewards:runNow", () => rewards.tick("manual"));

  // ----- utilities -----
  handle("util:copy", ({ text }) => {
    clipboard.writeText(String(text ?? ""));
    return true;
  });

  handle("util:openExternal", ({ url }) => {
    if (!/^https:\/\//.test(String(url))) throw new Error("Only https links can be opened");
    shell.openExternal(url);
    return true;
  });

  handle("util:openPath", ({ which }) => {
    const networkId = chain.network().id;
    const targets = {
      nodeData: nodeMgr.dirs(networkId).root,
      userData,
    };
    const target = targets[which];
    if (!target) throw new Error("Unknown path");
    shell.openPath(target);
    return true;
  });
}
