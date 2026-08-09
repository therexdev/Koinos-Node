"use strict";

const { app, BrowserWindow, ipcMain, shell, clipboard, dialog } = require("electron");
const path = require("path");
const fs = require("fs");

const { JsonStore } = require("./lib/store");
const { NETWORKS, DEFAULT_SETTINGS } = require("./lib/constants");
const { WalletService, MIN_PASSWORD_LENGTH } = require("./lib/wallet");
const { ChainService } = require("./lib/chain");
const { NodeManager } = require("./lib/node-manager");
const { SetupService } = require("./lib/setup");
const { RewardEngine } = require("./lib/rewards");
const { ProducerStats } = require("./lib/producer-stats");

// Optional override so the guided-setup UI can be exercised for other
// platforms during development/screenshots. Never set in production.
const FORCED_PLATFORM = process.env.KND_FORCE_PLATFORM || null;
const { parseAmount, formatAmount, subSats, cmpSats } = require("./lib/format");
const { weiToEth } = require("./lib/eth");
const { BridgeOrchestrator, MAX_BRIDGE_ETH } = require("./lib/bridge-orchestrator");
const { quoteDeposit, maxBridgeable } = require("./lib/eth-bridge");
const { quoteSwap } = require("./lib/koindx");

// Shared Coinbase Onramp endpoint + app-identity key (see onramp-endpoint/). At
// module scope so both the IPC handlers and the bridge orchestrator use them.
const DEFAULT_ONRAMP_ENDPOINT = "https://koinos-node.vercel.app/api/session";
const ONRAMP_APP_KEY = "kkapp_71854dc40591df1aeb8811a514e3dbc302bb382f";

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
          for (const view of ["dashboard", "wallet", "fund", "burn", "node", "returns", "settings"]) {
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
    const setup = new SetupService({
      platform: FORCED_PLATFORM || process.platform,
      arch: process.arch,
      downloadDir: path.join(userData, "downloads"),
      state,
      onEvent: sendEvent,
    });
    const stats = new ProducerStats({ chain, state });
    const rewards = new RewardEngine({ chain, wallet, settings, state, stats, onEvent: sendEvent });
    rewards.start();

    const bridge = new BridgeOrchestrator({
      wallet,
      provider: chain.provider(),
      store: new JsonStore(path.join(userData, "fund-bridge.json"), { job: null }),
      settings,
      appKey: ONRAMP_APP_KEY,
      network: settings.get("network", "mainnet"),
      onEvent: sendEvent,
    });
    // Driver: advance an active (non-terminal) bridge job every 15s. Deposit is
    // user-initiated; everything after it (poll → redeem → swap) auto-advances.
    setInterval(() => {
      const job = bridge.status();
      if (job && !["done", "error", "depositing"].includes(job.status)) bridge.advance().catch(() => {});
    }, 15000);

    registerIpc({ settings, wallet, chain, nodeMgr, setup, rewards, stats, bridge, userData });
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
  // Channel selection by the running build's own version: a prerelease build
  // (e.g. 0.3.0-beta.1 — anything with a "-" per semver) follows the beta line
  // and always takes the highest version (betas now, stable when it's higher);
  // a stable build ignores prereleases entirely. This keeps beta/test builds
  // off your live users' machines with no separate app or feed.
  updater.allowPrerelease = app.getVersion().includes("-");
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

function registerIpc({ settings, wallet, chain, nodeMgr, setup, rewards, stats, bridge, userData }) {
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
    platform: FORCED_PLATFORM || process.platform,
    userData,
    networks: publicNetworks,
    settings: settings.all(),
    minPasswordLength: MIN_PASSWORD_LENGTH,
  }));

  handle("settings:update", ({ network, customRpc, keepLiquidKoin, onrampEndpoint }) => {
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
    if (onrampEndpoint !== undefined) {
      const u = String(onrampEndpoint).trim();
      // Must be https — this endpoint holds the Coinbase secret key.
      if (u && !/^https:\/\/\S+$/.test(u)) throw new Error("Onramp endpoint must be an https:// URL");
      settings.set("onrampEndpoint", u);
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
    const { koin, mana } = await chain.balances(address);
    const keep = parseAmount(settings.get("keepLiquidKoin", "10"));
    // Cap by liquid balance above the mana buffer AND by mana actually available
    // now — burning requires mana >= amount, so a balance-only Max can suggest an
    // amount that reverts with "could not burn KOIN".
    const byBalance = cmpSats(koin, keep) > 0 ? subSats(koin, keep) : "0";
    const byMana = chain.burnableFromMana(mana);
    const manaLimited = cmpSats(byMana, byBalance) < 0;
    const max = manaLimited ? byMana : byBalance;
    return {
      maxSat: max,
      maxFormatted: formatAmount(max, { grouping: false }),
      manaLimited,
      manaFormatted: formatAmount(mana),
    };
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
    // Only probe prerequisites while Docker isn't usable yet — this is what
    // drives the guided setup card.
    let setupStatus = null;
    if (!status.docker?.ok) {
      setupStatus = await setup.status().catch(() => null);
    }
    return { network: networkId, ...status, sync, setup: setupStatus };
  });

  // ----- guided setup (WSL + Docker) -----
  handle("setup:status", () => setup.status());
  handle("setup:installWsl", () => setup.installWsl());
  handle("setup:restart", () => setup.restart());
  handle("setup:cancelRestart", () => setup.cancelRestart());
  handle("setup:installDocker", () => setup.installDocker());
  handle("setup:cancelInstallDocker", () => setup.cancelInstallDocker());
  handle("setup:startDocker", () => setup.startDocker());
  handle("setup:markWslReady", () => setup.markWslReady());
  handle("setup:openDockerDocs", () => {
    shell.openExternal(setup.dockerDocsUrl());
    return true;
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
  handle("node:quickSyncInfo", () => nodeMgr.quickSyncInfo(chain.network().id));
  handle("node:quickSync", () => nodeMgr.quickSync(chain.network().id));
  handle("node:quickSyncCancel", () => nodeMgr.cancelQuickSync());

  // ----- dashboard -----
  handle("dashboard:summary", async () => {
    const net = chain.network();
    const address = wallet.address;
    const ws = wallet.status();
    const out = {
      network: { id: net.id, label: net.label, tokenSymbol: net.tokenSymbol, explorer: net.explorer },
      wallet: { exists: ws.exists, unlocked: ws.unlocked, address },
      node: null,
      balances: null,
      stats: null,
      rewards: rewards.status().config,
    };
    // Node running state (docker + services).
    try {
      const ns = await nodeMgr.status(net.id);
      out.node = {
        docker: ns.docker,
        isRunning: ns.isRunning,
        runningCount: ns.runningCount,
        op: ns.op,
        producerRegistered: null,
      };
      if (ns.isRunning) {
        out.sync = await chain.syncStatus().catch(() => null);
      }
    } catch (e) {
      out.node = { error: String(e.message) };
    }
    if (!address) return out;
    // Balances + producer stats (both hit the RPC).
    const [balances, statsRes] = await Promise.all([
      chain.balances(address).catch((e) => ({ error: String(e.message) })),
      stats.refresh(address).catch((e) => ({ available: false, error: String(e.message) })),
    ]);
    out.balances = balances;
    out.stats = statsRes;

    // Screenshot/demo-only override (never set in production): present a
    // running, synced node with representative balances so marketing shots
    // show a live dashboard.
    if (process.env.KND_DEMO) {
      out.node = { docker: { ok: true }, isRunning: true, runningCount: 7, op: null };
      out.sync = {
        inSync: true,
        local: { height: 38297044, headBlockTimeMs: Date.now(), error: null },
        remote: { height: 38297044 },
        progressPct: 100,
      };
      out.balances = { koin: "4308560000", vhp: "228813610000", mana: "3822790000" };
    }
    return out;
  });

  // ----- rewards -----
  handle("rewards:status", () => rewards.status());
  handle("rewards:configure", (patch) => rewards.configure(patch));
  handle("rewards:runNow", () => rewards.tick("manual"));

  // ----- fund node (Ethereum on-ramp — Phase 1) -----
  // Shared, app-hosted Coinbase Onramp endpoint. Every install uses this by
  // default so the Buy button works with zero setup; advanced users can override
  // it with their own endpoint in the Fund tab. (DEFAULT_ONRAMP_ENDPOINT and
  // ONRAMP_APP_KEY are defined at module scope.)
  const effectiveOnrampEndpoint = () => settings.get("onrampEndpoint", "") || DEFAULT_ONRAMP_ENDPOINT;

  handle("fund:status", () => ({
    ethAddress: wallet.ethAddress,
    onrampEndpoint: settings.get("onrampEndpoint", ""), // user override; blank = built-in default
    onrampDefault: DEFAULT_ONRAMP_ENDPOINT,
    onrampConfigured: !!effectiveOnrampEndpoint(),
  }));

  // Asks the user's own Coinbase Onramp endpoint (a small serverless function
  // holding their CDP secret) to mint a session token for the wallet's ETH
  // address, then builds the hosted Coinbase Pay URL. Post-2025 Onramp requires
  // this server-minted session token — the secret never lives in the app.
  handle("fund:buyUrl", async ({ amountUsd } = {}) => {
    const address = wallet.ethAddress;
    if (!address) throw new Error("Create or unlock your wallet first to get a funding address.");
    const endpoint = effectiveOnrampEndpoint();
    if (!endpoint) throw new Error("No Coinbase Onramp endpoint is configured.");
    let token;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      const resp = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", "x-koinoskit-app": ONRAMP_APP_KEY },
        body: JSON.stringify({ address, asset: "ETH", network: "ethereum" }),
        signal: controller.signal,
      }).finally(() => clearTimeout(timer));
      if (!resp.ok) throw new Error(`endpoint returned HTTP ${resp.status}`);
      const data = await resp.json();
      token = data.token || data.sessionToken;
    } catch (e) {
      throw new Error(`Couldn't reach your Onramp endpoint: ${String(e.message || e)}`);
    }
    if (!token) throw new Error("Your Onramp endpoint didn't return a session token.");
    const u = new URL("https://pay.coinbase.com/buy/select-asset");
    u.searchParams.set("sessionToken", token);
    u.searchParams.set("defaultAsset", "ETH");
    u.searchParams.set("defaultNetwork", "ethereum");
    u.searchParams.set("fiatCurrency", "USD");
    if (amountUsd && Number(amountUsd) > 0) u.searchParams.set("presetFiatAmount", String(Number(amountUsd)));
    return { url: u.toString() };
  });

  // Read-only ETH balance of the wallet's funding address, via public RPCs
  // (tried in order). Lets the user confirm funds arrived before bridging.
  const ETH_RPCS = [
    "https://ethereum-rpc.publicnode.com",
    "https://eth.llamarpc.com",
    "https://cloudflare-eth.com",
    "https://rpc.ankr.com/eth",
  ];
  handle("fund:ethBalance", async () => {
    const address = wallet.ethAddress;
    if (!address) throw new Error("Create or unlock your wallet first.");
    let lastErr;
    for (const rpc of ETH_RPCS) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10000);
        const resp = await fetch(rpc, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [address, "latest"] }),
          signal: controller.signal,
        }).finally(() => clearTimeout(timer));
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        if (data.error) throw new Error(data.error.message || "RPC error");
        return { address, wei: data.result, eth: weiToEth(data.result) };
      } catch (e) {
        lastErr = e;
      }
    }
    throw new Error(`Couldn't fetch ETH balance: ${String(lastErr?.message || lastErr)}`);
  });

  // ----- fund node bridge (Phase 2: ETH -> vETH -> KOIN) -----
  handle("fund:bridgeStatus", () => bridge.status());
  handle("fund:bridgeReset", () => bridge.reset());
  handle("fund:bridgeAdvance", () => bridge.advance());
  handle("fund:bridgeStart", ({ amountEth, slippageBps } = {}) => bridge.start({ amountEth, slippageBps }));
  handle("fund:bridgeMax", async () => {
    const address = wallet.ethAddress;
    if (!address) throw new Error("Create or unlock your wallet first.");
    return maxBridgeable({
      fromAddress: address,
      koinosRecipient: wallet.address,
      network: settings.get("network", "mainnet"),
      capEth: MAX_BRIDGE_ETH,
    });
  });
  handle("fund:bridgeQuote", async ({ amountEth, slippageBps } = {}) => {
    const address = wallet.ethAddress;
    if (!address) throw new Error("Create or unlock your wallet first.");
    const network = settings.get("network", "mainnet");
    const deposit = await quoteDeposit({ fromAddress: address, amountEth, koinosRecipient: wallet.address, network });
    let swap = null;
    try {
      swap = await quoteSwap({ amountInSats: deposit.vethSats, slippageBps: slippageBps || 150, network, provider: chain.provider() });
    } catch (e) {
      swap = { error: String(e.message || e) };
    }
    return { deposit, swap, maxEth: MAX_BRIDGE_ETH };
  });

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
