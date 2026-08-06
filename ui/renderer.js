"use strict";

/* global window, document */

// ---------- IPC + state ----------

async function call(channel, payload) {
  const res = await window.koinos.invoke(channel, payload);
  if (!res.ok) throw new Error(res.error || "Unknown error");
  return res.data;
}

const S = {
  appInfo: null,
  wallet: null,       // wallet:status
  balances: null,     // chain:balances
  balancesAt: 0,
  node: null,         // node:status
  producer: null,     // producer:status
  rewards: null,      // rewards:status
  view: "wallet",
  walletStage: null,  // "none" | "locked" | "unlocked"
  pendingWif: null,   // shown once after create
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// ---------- formatting ----------

const ONE = 100000000n;

function fmtSat(sats, maxDecimals = 8) {
  let v;
  try { v = BigInt(String(sats ?? "0")); } catch { return "0"; }
  const neg = v < 0n;
  if (neg) v = -v;
  const whole = (v / ONE).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  let frac = (v % ONE).toString().padStart(8, "0").slice(0, maxDecimals).replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? "." + frac : ""}`;
}

function fmtTime(ts) {
  if (!ts) return "—";
  return new Date(ts).toLocaleString();
}

function shortTx(txId) {
  const s = String(txId ?? "");
  return s.length > 18 ? `${s.slice(0, 10)}…${s.slice(-6)}` : s;
}

function net() {
  return S.appInfo.networks[S.appInfo.settings.network];
}

function sym() {
  return net().tokenSymbol;
}

// ---------- toasts / modals ----------

function toast(message, kind = "info", ms = 5000) {
  const div = document.createElement("div");
  div.className = `toast ${kind}`;
  div.textContent = message;
  $("#toasts").appendChild(div);
  setTimeout(() => div.remove(), ms);
}

function showModal({ title, body, actions = [], onMount }) {
  const root = $("#modal-root");
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `<div class="modal"><h2>${esc(title)}</h2><div class="modal-body">${body}</div><div class="actions"></div></div>`;
  const close = () => backdrop.remove();
  const actionsEl = $(".actions", backdrop);
  for (const a of actions) {
    const b = document.createElement("button");
    b.className = `btn ${a.class || ""}`;
    b.textContent = a.label;
    b.addEventListener("click", () => a.onClick?.(close, backdrop));
    actionsEl.appendChild(b);
  }
  backdrop.addEventListener("mousedown", (e) => {
    if (e.target === backdrop && !actions.some((a) => a.required)) close();
  });
  root.appendChild(backdrop);
  onMount?.(backdrop, close);
  return close;
}

function busyButton(btn, busy, labelBusy = "Working…") {
  if (!btn) return;
  if (busy) {
    btn.dataset.label = btn.textContent;
    btn.innerHTML = `<span class="spin"></span> ${esc(labelBusy)}`;
    btn.disabled = true;
  } else {
    btn.textContent = btn.dataset.label || btn.textContent;
    btn.disabled = false;
  }
}

async function openTx(txId) {
  const ex = net().explorer;
  if (!ex) {
    await call("util:copy", { text: txId });
    toast("Transaction ID copied (no explorer for this network)");
    return;
  }
  call("util:openExternal", { url: ex.tx + txId }).catch(() => {});
}

// ---------- data refreshers ----------

async function refreshWallet() {
  S.wallet = await call("wallet:status");
  const stage = !S.wallet.exists ? "none" : S.wallet.unlocked ? "unlocked" : "locked";
  if (stage !== S.walletStage) {
    S.walletStage = stage;
    renderWalletView();
    renderBurnView();
  }
}

async function refreshBalances(force = false) {
  if (!S.wallet?.exists) { S.balances = null; return; }
  if (!force && Date.now() - S.balancesAt < 25000) return;
  try {
    S.balances = await call("chain:balances");
    S.balancesAt = Date.now();
    patchBalances();
  } catch (e) {
    S.balances = { error: e.message };
    patchBalances();
  }
}

async function refreshNode() {
  try {
    S.node = await call("node:status");
  } catch (e) {
    S.node = { error: e.message };
  }
  try {
    S.producer = await call("producer:status");
  } catch {
    S.producer = null;
  }
  patchNodeView();
}

async function refreshRewards() {
  try {
    S.rewards = await call("rewards:status");
    patchReturnsView();
  } catch { /* ignore */ }
}

// ---------- wallet view ----------

function renderWalletView() {
  const root = $("#view-wallet");
  const stage = S.walletStage;

  if (stage === "none") {
    root.innerHTML = `
      <h1>Welcome 👋</h1>
      <p class="lead">Set up a Koinos wallet to get started. It takes a few seconds — your key is generated locally and encrypted with a password on this computer.</p>
      <div class="grid-2">
        <div class="card">
          <h2>🆕 Create a new wallet</h2>
          <label class="field"><span>Password (min ${S.appInfo.minPasswordLength} characters)</span>
            <input id="cw-pass" type="password" autocomplete="new-password"></label>
          <label class="field"><span>Confirm password</span>
            <input id="cw-pass2" type="password" autocomplete="new-password"></label>
          <button id="cw-go" class="btn primary">Create wallet</button>
          <p class="hint">You'll be shown a private key backup right after — write it down and keep it safe.</p>
        </div>
        <div class="card">
          <h2>📥 Import an existing wallet</h2>
          <label class="field"><span>Private key (WIF)</span>
            <input id="iw-wif" type="password" class="mono" autocomplete="off"></label>
          <label class="field"><span>New password for this device</span>
            <input id="iw-pass" type="password" autocomplete="new-password"></label>
          <button id="iw-go" class="btn">Import wallet</button>
          <p class="hint">The key is encrypted with your password and stored only on this machine.</p>
        </div>
      </div>`;
    $("#cw-go").addEventListener("click", onCreateWallet);
    $("#iw-go").addEventListener("click", onImportWallet);
    return;
  }

  if (stage === "locked") {
    root.innerHTML = `
      <h1>Unlock your wallet</h1>
      <p class="lead">Wallet <span class="mono">${esc(S.wallet.address ?? "")}</span></p>
      <div class="card" style="max-width:420px">
        <label class="field"><span>Password</span>
          <input id="uw-pass" type="password" autocomplete="current-password"></label>
        <button id="uw-go" class="btn primary">Unlock</button>
        <p class="hint">Unlocking is required to burn, send, register the producer key, and for automatic reward returns.</p>
      </div>`;
    const go = () => onUnlock();
    $("#uw-go").addEventListener("click", go);
    $("#uw-pass").addEventListener("keydown", (e) => e.key === "Enter" && go());
    $("#uw-pass").focus();
    return;
  }

  // unlocked
  root.innerHTML = `
    <div class="row spread">
      <h1>Wallet</h1>
      <div class="row">
        <button id="w-send" class="btn">Send</button>
        <button id="w-lock" class="btn ghost">🔒 Lock</button>
      </div>
    </div>
    <p class="lead">Your address — share it to receive ${esc(sym())} or VHP.</p>
    <div class="card">
      <div class="row">
        <div class="addr" style="flex:1">${esc(S.wallet.address)}</div>
        <button id="w-copy" class="btn">Copy</button>
        ${net().explorer ? '<button id="w-explore" class="btn ghost">Explorer ↗</button>' : ""}
      </div>
    </div>
    <div class="grid-3">
      <div class="stat"><div class="label">${esc(sym())} (liquid)</div><div class="value" id="bal-koin">…</div><div class="sub">spendable + fuels mana</div></div>
      <div class="stat"><div class="label">VHP</div><div class="value" id="bal-vhp">…</div><div class="sub">virtual hash power for block production</div></div>
      <div class="stat"><div class="label">Mana</div><div class="value" id="bal-mana">…</div><div class="sub">recharges over time, spent by transactions</div></div>
    </div>
    <p class="muted" id="bal-note" style="margin-top:8px"></p>`;
  $("#w-lock").addEventListener("click", async () => {
    await call("wallet:lock");
    toast("Wallet locked");
    refreshWallet();
  });
  $("#w-copy").addEventListener("click", async () => {
    await call("util:copy", { text: S.wallet.address });
    toast("Address copied");
  });
  $("#w-explore")?.addEventListener("click", () =>
    call("util:openExternal", { url: net().explorer.address + S.wallet.address }).catch(() => {})
  );
  $("#w-send").addEventListener("click", openSendModal);
  patchBalances();
  refreshBalances(true);
}

function patchBalances() {
  const b = S.balances;
  const setText = (id, v) => { const e = $(id); if (e) e.textContent = v; };
  if (!b || b.error) {
    setText("#bal-koin", "—"); setText("#bal-vhp", "—"); setText("#bal-mana", "—");
    const note = $("#bal-note");
    if (note) note.textContent = b?.error ? `RPC error: ${b.error}` : "";
  } else {
    setText("#bal-koin", fmtSat(b.koin, 4));
    setText("#bal-vhp", fmtSat(b.vhp, 4));
    setText("#bal-mana", fmtSat(b.mana, 4));
    const note = $("#bal-note");
    if (note) note.textContent = `Updated ${new Date(S.balancesAt).toLocaleTimeString()}`;
  }
  patchBurnBalances();
}

async function onCreateWallet() {
  const pass = $("#cw-pass").value;
  const pass2 = $("#cw-pass2").value;
  if (pass !== pass2) return toast("Passwords don't match", "bad");
  const btn = $("#cw-go");
  busyButton(btn, true, "Creating…");
  try {
    const { address, wif } = await call("wallet:create", { password: pass });
    showBackupModal(address, wif);
    await refreshWallet();
  } catch (e) {
    toast(e.message, "bad");
  } finally {
    busyButton(btn, false);
  }
}

function showBackupModal(address, wif) {
  showModal({
    title: "🔑 Back up your private key now",
    body: `
      <p class="small">This is the only time it will be shown automatically. Anyone with this key controls the wallet — write it down and store it offline.</p>
      <div class="wif-box">${esc(wif)}</div>
      <p class="small muted">Address: <span class="mono">${esc(address)}</span></p>`,
    actions: [
      { label: "Copy key", onClick: async () => { await call("util:copy", { text: wif }); toast("Private key copied — clear your clipboard after saving it", "warn"); } },
      { label: "I saved my key", class: "primary", required: true, onClick: (close) => close() },
    ],
  });
}

async function onImportWallet() {
  const wif = $("#iw-wif").value.trim();
  const pass = $("#iw-pass").value;
  const btn = $("#iw-go");
  busyButton(btn, true, "Importing…");
  try {
    const { address } = await call("wallet:import", { wif, password: pass });
    toast(`Wallet imported: ${address}`, "good");
    await refreshWallet();
  } catch (e) {
    toast(e.message, "bad");
  } finally {
    busyButton(btn, false);
  }
}

async function onUnlock() {
  const btn = $("#uw-go");
  busyButton(btn, true, "Unlocking…");
  try {
    await call("wallet:unlock", { password: $("#uw-pass").value });
    toast("Wallet unlocked", "good");
    await refreshWallet();
  } catch (e) {
    toast(e.message, "bad");
    busyButton(btn, false);
  }
}

function openSendModal() {
  showModal({
    title: "Send tokens",
    body: `
      <label class="field"><span>Token</span>
        <select id="s-token"><option value="koin">${esc(sym())}</option><option value="vhp">VHP</option></select></label>
      <label class="field"><span>Recipient address</span>
        <input id="s-to" type="text" class="mono" placeholder="1…"></label>
      <label class="field"><span>Amount</span>
        <input id="s-amount" type="text" class="mono" placeholder="0.0"></label>
      <p class="small muted">Transactions consume mana (not a fee — it recharges).</p>`,
    actions: [
      { label: "Cancel", onClick: (close) => close() },
      {
        label: "Send", class: "primary",
        onClick: async (close, modal) => {
          const btn = $$(".btn.primary", modal).pop();
          busyButton(btn, true, "Sending…");
          try {
            const res = await call("chain:send", {
              to: $("#s-to", modal).value.trim(),
              amount: $("#s-amount", modal).value.trim(),
              token: $("#s-token", modal).value,
            });
            close();
            txToast(res, "Transfer");
            refreshBalances(true);
          } catch (e) {
            toast(e.message, "bad");
            busyButton(btn, false);
          }
        },
      },
    ],
  });
}

function txToast(res, label) {
  const div = document.createElement("div");
  div.className = "toast good";
  div.innerHTML = `${esc(label)} ${res.confirmed ? "confirmed" : "submitted"} · <button class="link">${esc(shortTx(res.txId))} ↗</button>`;
  $("button", div).addEventListener("click", () => openTx(res.txId));
  $("#toasts").appendChild(div);
  setTimeout(() => div.remove(), 9000);
}

// ---------- burn view ----------

function renderBurnView() {
  const root = $("#view-burn");
  if (S.walletStage !== "unlocked") {
    root.innerHTML = `
      <h1>Burn ${esc(sym())} → VHP</h1>
      <p class="lead">Burning converts liquid ${esc(sym())} into Virtual Hash Power (VHP) — the stake that lets your node produce blocks and earn rewards.</p>
      <div class="banner info">${S.walletStage === "none" ? "Create a wallet first (Wallet tab)." : "Unlock your wallet to burn (Wallet tab)."}</div>`;
    return;
  }
  root.innerHTML = `
    <h1>Burn ${esc(sym())} → VHP</h1>
    <p class="lead">Burning converts liquid ${esc(sym())} into VHP 1:1. VHP is consumed slowly while producing blocks, and you earn ${esc(sym())} rewards in return.</p>
    <div class="grid-2">
      <div class="card">
        <h2>🔥 Burn</h2>
        <div class="row" style="margin-bottom:8px">
          <span class="muted">Balance:</span> <span class="mono" id="burn-koin">…</span>
          <span class="muted" style="margin-left:12px">VHP:</span> <span class="mono" id="burn-vhp">…</span>
        </div>
        <label class="field"><span>Amount to burn (${esc(sym())})</span>
          <div class="row">
            <input id="burn-amount" type="text" class="mono" placeholder="0.0" style="flex:1">
            <button id="burn-max" class="btn ghost">Max</button>
          </div>
        </label>
        <div class="muted" id="burn-est" style="margin-bottom:12px">You will receive: —</div>
        <div id="burn-warn"></div>
        <button id="burn-go" class="btn primary">Burn ${esc(sym())}</button>
      </div>
      <div class="card">
        <h2>ℹ️ How it works</h2>
        <p class="hint">
          • Proof-of-Burn is Koinos consensus: VHP acts like mining hardware that slowly "depreciates".<br><br>
          • Producing blocks consumes VHP and mints ${esc(sym())} rewards to your wallet — roughly 2% APY network-wide, more per participant when fewer VHP are competing.<br><br>
          • Keep some liquid ${esc(sym())} — mana from liquid balance pays for your transactions (Max leaves ${esc(S.appInfo.settings.keepLiquidKoin)} ${esc(sym())} by default, adjustable in Settings).<br><br>
          • Use the <b>Reward returns</b> tab to automatically re-burn a percentage of rewards and keep your VHP topped up.
        </p>
      </div>
    </div>`;
  patchBurnBalances();
  $("#burn-max").addEventListener("click", async () => {
    try {
      const { maxFormatted } = await call("chain:maxBurn");
      $("#burn-amount").value = maxFormatted;
      updateBurnEstimate();
    } catch (e) {
      toast(e.message, "bad");
    }
  });
  $("#burn-amount").addEventListener("input", updateBurnEstimate);
  $("#burn-go").addEventListener("click", onBurn);
}

function patchBurnBalances() {
  const b = S.balances;
  if ($("#burn-koin") && b && !b.error) {
    $("#burn-koin").textContent = `${fmtSat(b.koin, 4)} ${sym()}`;
    $("#burn-vhp").textContent = fmtSat(b.vhp, 4);
  }
}

function updateBurnEstimate() {
  const v = $("#burn-amount").value.trim();
  const est = $("#burn-est");
  const warn = $("#burn-warn");
  warn.innerHTML = "";
  if (!v || !/^\d+(\.\d{1,8})?$/.test(v.replace(/,/g, ""))) {
    est.textContent = "You will receive: —";
    return;
  }
  est.textContent = `You will receive: ${v} VHP`;
  try {
    const sats = toSat(v);
    const bal = BigInt(S.balances?.koin ?? "0");
    const keep = toSatBig(S.appInfo.settings.keepLiquidKoin);
    if (sats > bal) {
      warn.innerHTML = `<div class="banner bad">Amount exceeds your balance.</div>`;
    } else if (bal - sats < keep) {
      warn.innerHTML = `<div class="banner warn">This leaves less than ${esc(S.appInfo.settings.keepLiquidKoin)} ${esc(sym())} liquid. You need liquid ${esc(sym())} for mana to keep transacting.</div>`;
    }
  } catch { /* ignore */ }
}

function toSat(v) {
  const [w, f = ""] = String(v).replace(/,/g, "").split(".");
  return BigInt(w || "0") * ONE + BigInt((f.padEnd(8, "0") || "0").slice(0, 8));
}
function toSatBig(v) { try { return toSat(v); } catch { return 0n; } }

function onBurn() {
  const amount = $("#burn-amount").value.trim();
  if (!amount) return toast("Enter an amount to burn", "warn");
  showModal({
    title: "Confirm burn",
    body: `
      <p>You are about to <b>permanently burn</b> <span class="mono">${esc(amount)} ${esc(sym())}</span> and receive <span class="mono">${esc(amount)} VHP</span>.</p>
      <p class="small muted" style="margin-top:8px">VHP is only useful for producing blocks with a node. It converts back to ${esc(sym())} gradually through block rewards.</p>`,
    actions: [
      { label: "Cancel", onClick: (close) => close() },
      {
        label: "Burn", class: "danger",
        onClick: async (close, modal) => {
          const btn = $$(".btn.danger", modal).pop();
          busyButton(btn, true, "Burning…");
          try {
            const res = await call("chain:burn", { amount });
            close();
            txToast(res, `Burned ${amount} ${sym()} → VHP.`);
            refreshBalances(true);
          } catch (e) {
            toast(e.message, "bad");
            busyButton(btn, false);
          }
        },
      },
    ],
  });
}

// ---------- node view ----------

function renderNodeView() {
  const root = $("#view-node");
  root.innerHTML = `
    <div class="row spread">
      <h1>Koinos node</h1>
      <div class="row">
        <button id="n-open" class="btn ghost">📁 Data folder</button>
        <button id="n-stop" class="btn">Stop</button>
        <button id="n-start" class="btn primary">Start node</button>
      </div>
    </div>
    <p class="lead">Runs the official Koinos microservices with Docker. First start downloads images and syncs the chain — this can take a while.</p>
    <div id="n-docker"></div>
    <div id="n-op"></div>
    <div class="grid-2">
      <div class="card">
        <h2>📡 Status <span id="n-run-pill"></span></h2>
        <div id="n-sync" class="stack"></div>
        <div style="margin-top:10px"><table id="n-services"><tbody></tbody></table></div>
      </div>
      <div class="card">
        <h2>⛏️ Block production setup</h2>
        <ul class="checklist" id="n-checklist"></ul>
        <div class="row" style="margin-top:6px">
          <button id="n-register" class="btn">Register signing key</button>
        </div>
        <p class="hint" id="n-reg-hint"></p>
      </div>
    </div>
    <div class="card">
      <div class="row spread">
        <h2>📜 Logs</h2>
        <div class="row">
          <select id="n-log-svc" style="width:auto">
            <option value="">all services</option>
            ${["chain", "p2p", "block_producer", "mempool", "block_store", "jsonrpc", "amqp"]
              .map((s) => `<option value="${s}">${s}</option>`).join("")}
          </select>
          <button id="n-log-refresh" class="btn">Refresh</button>
        </div>
      </div>
      <pre class="logs" id="n-log-out">Press Refresh to load logs.</pre>
    </div>`;

  $("#n-open").addEventListener("click", () => call("util:openPath", { which: "nodeData" }).catch(() => {}));
  $("#n-start").addEventListener("click", onStartNode);
  $("#n-stop").addEventListener("click", onStopNode);
  $("#n-register").addEventListener("click", onRegisterKey);
  $("#n-log-refresh").addEventListener("click", loadLogs);
  patchNodeView();
}

function onStartNode() {
  const canProduce = S.wallet?.exists;
  showModal({
    title: "Start Koinos node",
    body: `
      <label class="field"><span class="row" style="gap:8px">
        <input type="checkbox" id="ns-produce" ${canProduce ? "checked" : "disabled"} style="width:auto">
        <span>Enable block production (uses your wallet address <span class="mono">${esc(S.wallet?.address ?? "no wallet yet")}</span> as producer)</span>
      </span></label>
      <p class="small muted">The node runs in Docker in the background and keeps running even if you close this app. First sync downloads the whole chain.</p>`,
    actions: [
      { label: "Cancel", onClick: (close) => close() },
      {
        label: "Start", class: "primary",
        onClick: async (close, modal) => {
          const produce = $("#ns-produce", modal)?.checked ?? false;
          try {
            await call("node:start", { produce });
            close();
            toast("Node starting — pulling images and launching services…", "good");
            refreshNode();
          } catch (e) {
            toast(e.message, "bad");
          }
        },
      },
    ],
  });
}

async function onStopNode() {
  try {
    await call("node:stop");
    toast("Stopping node…");
    refreshNode();
  } catch (e) {
    toast(e.message, "bad");
  }
}

async function onRegisterKey() {
  const btn = $("#n-register");
  busyButton(btn, true, "Registering…");
  try {
    const res = await call("producer:register");
    txToast(res, "Producer key registration");
    refreshNode();
  } catch (e) {
    toast(e.message, "bad");
  } finally {
    busyButton(btn, false);
  }
}

async function loadLogs() {
  const out = $("#n-log-out");
  out.textContent = "Loading…";
  try {
    const text = await call("node:logs", { service: $("#n-log-svc").value || undefined, tail: 200 });
    out.textContent = text || "(no output)";
    out.scrollTop = out.scrollHeight;
  } catch (e) {
    out.textContent = `Failed to load logs: ${e.message}`;
  }
}

function patchNodeView() {
  if (!$("#n-docker")) return;
  const n = S.node;

  // docker banner
  const dockerEl = $("#n-docker");
  if (n?.docker && !n.docker.ok) {
    dockerEl.innerHTML = `<div class="banner bad"><b>Docker unavailable.</b> ${esc(n.docker.error)}<br>
      Install Docker Desktop (macOS/Windows) or Docker Engine + Compose (Linux), start it, then come back.</div>`;
  } else {
    dockerEl.innerHTML = "";
  }

  // operation progress
  const opEl = $("#n-op");
  const op = n?.op;
  if (op?.running) {
    opEl.innerHTML = `<div class="banner info"><span class="spin"></span> <b>${esc(op.name)}</b> in progress…<br>
      <span class="mono small">${op.tail.slice(-4).map(esc).join("<br>")}</span></div>`;
  } else if (op && op.code !== 0 && op.error) {
    opEl.innerHTML = `<div class="banner bad"><b>${esc(op.name)} failed:</b> ${esc(op.error)}</div>`;
  } else {
    opEl.innerHTML = "";
  }

  // run pill + services
  const pill = $("#n-run-pill");
  if (pill) {
    pill.className = "pill " + (n?.isRunning ? "good" : "warn");
    pill.textContent = n?.isRunning ? `running (${n.runningCount} services)` : "stopped";
  }
  const tbody = $("#n-services tbody");
  if (tbody) {
    tbody.innerHTML = (n?.services ?? [])
      .map(
        (s) => `<tr><td class="mono">${esc(s.service)}</td>
          <td><span class="pill ${/running|up/i.test(s.state) ? "good" : "warn"}">${esc(s.state)}</span></td>
          <td class="muted">${esc(s.status)}</td></tr>`
      )
      .join("") || `<tr><td class="muted">No services running.</td></tr>`;
  }

  // sync
  const syncEl = $("#n-sync");
  if (syncEl) {
    const sync = n?.sync;
    if (!n?.isRunning) {
      syncEl.innerHTML = `<span class="muted">Start the node to sync the chain.</span>`;
    } else if (!sync || sync.local?.error) {
      syncEl.innerHTML = `<span class="muted">Waiting for local RPC… (services may still be starting)</span>`;
    } else {
      const pct = sync.progressPct != null ? sync.progressPct : sync.inSync ? 100 : 0;
      syncEl.innerHTML = `
        <div class="row spread">
          <span>${sync.inSync ? '<span class="pill good">in sync</span>' : '<span class="pill warn">syncing</span>'}</span>
          <span class="mono small">${sync.local.height.toLocaleString()}${sync.remote ? " / " + sync.remote.height.toLocaleString() : ""} blocks</span>
        </div>
        <div class="progress"><div style="width:${pct.toFixed(1)}%"></div></div>
        <span class="muted small">Head block time: ${fmtTime(sync.local.headBlockTimeMs)}</span>`;
    }
  }

  // checklist
  const p = S.producer;
  const checklist = $("#n-checklist");
  if (checklist) {
    const vhpOk = S.balances && !S.balances.error && BigInt(S.balances.vhp ?? "0") > 0n;
    const items = [
      [S.wallet?.exists, "Wallet created", "Create one in the Wallet tab."],
      [vhpOk, "VHP in wallet", `Burn some ${sym()} in the Burn tab — VHP is your block-producing stake.`],
      [n?.isRunning, "Node running", "Start the node above."],
      [!!p?.filePublicKey, "Signing key generated", "Generated automatically by the node on first start."],
      [!!p?.matches, "Signing key registered on chain", "Register it with the button below (needs unlocked wallet + mana)."],
    ];
    checklist.innerHTML = items
      .map(
        ([ok, label, hint]) => `<li><span class="tick">${ok ? "✅" : "⬜"}</span>
          <span>${esc(label)}${ok ? "" : `<br><span class="muted small">${esc(hint)}</span>`}</span></li>`
      )
      .join("");
    const reg = $("#n-register");
    const regHint = $("#n-reg-hint");
    const canRegister = !!p?.filePublicKey && S.walletStage === "unlocked" && !p?.matches;
    reg.disabled = !canRegister;
    if (p?.matches) {
      regHint.textContent = "✅ Registered — your node signs blocks with this key. Rewards arrive at your wallet address.";
    } else if (p?.registeredPublicKey && p?.filePublicKey && !p.matches) {
      regHint.textContent = "⚠️ A different key is registered on chain for this address. Register the current node key to replace it.";
    } else if (!p?.filePublicKey) {
      regHint.textContent = "The signing key appears after the node's first start.";
    } else if (S.walletStage !== "unlocked") {
      regHint.textContent = "Unlock your wallet to register.";
    } else {
      regHint.textContent = "";
    }
  }
}

// ---------- returns view ----------

function renderReturnsView() {
  const root = $("#view-returns");
  const cfg = S.rewards?.config ?? S.appInfo.settings.rewards;
  root.innerHTML = `
    <h1>Reward returns</h1>
    <p class="lead">Automatically return a percentage of the block rewards your node earns — compound them back into VHP to keep producing, or send them to any address.</p>
    <div class="grid-2">
      <div class="card">
        <h2>⚙️ Configuration</h2>
        <label class="field"><span class="row" style="gap:8px">
          <input type="checkbox" id="r-enabled" ${cfg.enabled ? "checked" : ""} style="width:auto">
          <b>Enable automatic returns</b></span></label>
        <label class="field"><span>Return percentage: <b id="r-pct-label">${cfg.pct}%</b> of new rewards</span>
          <input type="range" id="r-pct" min="0" max="100" step="1" value="${cfg.pct}"></label>
        <label class="field"><span>What to do with returned ${esc(sym())}</span>
          <select id="r-mode">
            <option value="burn" ${cfg.mode === "burn" ? "selected" : ""}>♻️ Compound — burn back into VHP (keeps node producing)</option>
            <option value="send" ${cfg.mode === "send" ? "selected" : ""}>📤 Send to another address</option>
          </select></label>
        <label class="field" id="r-to-wrap" style="display:${cfg.mode === "send" ? "block" : "none"}"><span>Send returns to</span>
          <input id="r-to" type="text" class="mono" placeholder="1…" value="${esc(cfg.toAddress)}"></label>
        <div class="grid-2">
          <label class="field"><span>Minimum return (${esc(sym())})</span>
            <input id="r-min" type="text" class="mono" value="${esc(cfg.minReturnKoin)}"></label>
          <label class="field"><span>Check every (minutes)</span>
            <input id="r-poll" type="number" min="1" value="${cfg.pollMinutes}"></label>
        </div>
        <div class="row">
          <button id="r-save" class="btn primary">Save</button>
          <button id="r-now" class="btn">Check now</button>
        </div>
        <p class="hint">Returns are signed locally, so the app must be open with the wallet unlocked. Rewards are detected as increases of the wallet's liquid ${esc(sym())} — use this wallet only for producing to keep the numbers accurate.</p>
      </div>
      <div class="card">
        <h2>📊 Status</h2>
        <div id="r-status" class="stack"></div>
      </div>
    </div>
    <div class="card">
      <h2>🧾 Return history</h2>
      <table><thead><tr><th>When</th><th>Rewards detected</th><th>Returned</th><th>Mode</th><th>Tx</th></tr></thead>
      <tbody id="r-history"></tbody></table>
    </div>`;

  $("#r-pct").addEventListener("input", () => {
    $("#r-pct-label").textContent = `${$("#r-pct").value}%`;
  });
  $("#r-mode").addEventListener("change", () => {
    $("#r-to-wrap").style.display = $("#r-mode").value === "send" ? "block" : "none";
  });
  $("#r-save").addEventListener("click", onSaveRewards);
  $("#r-now").addEventListener("click", onRunRewardsNow);
  patchReturnsView();
}

async function onSaveRewards() {
  const btn = $("#r-save");
  busyButton(btn, true, "Saving…");
  try {
    await call("rewards:configure", {
      enabled: $("#r-enabled").checked,
      pct: Number($("#r-pct").value),
      mode: $("#r-mode").value,
      toAddress: $("#r-to").value.trim(),
      minReturnKoin: $("#r-min").value.trim(),
      pollMinutes: Number($("#r-poll").value),
    });
    toast("Return settings saved", "good");
    refreshRewards();
  } catch (e) {
    toast(e.message, "bad");
  } finally {
    busyButton(btn, false);
  }
}

async function onRunRewardsNow() {
  const btn = $("#r-now");
  busyButton(btn, true, "Checking…");
  try {
    S.rewards = await call("rewards:runNow");
    patchReturnsView();
    const last = S.rewards.last;
    toast(last?.message || `Check complete: ${last?.outcome ?? "done"}`, last?.outcome === "returned" ? "good" : "info", 7000);
  } catch (e) {
    toast(e.message, "bad");
  } finally {
    busyButton(btn, false);
  }
}

const OUTCOME_LABELS = {
  disabled: ["pill", "disabled"],
  "no-wallet": ["pill warn", "no wallet"],
  locked: ["pill warn", "wallet locked"],
  "rpc-error": ["pill bad", "RPC error"],
  "baseline-set": ["pill accent", "baseline set"],
  "baseline-reset": ["pill accent", "baseline reset"],
  "no-rewards": ["pill", "no new rewards"],
  accumulating: ["pill accent", "accumulating"],
  returned: ["pill good", "returned"],
  "tx-error": ["pill bad", "tx failed"],
  "config-error": ["pill bad", "config error"],
};

function patchReturnsView() {
  const statusEl = $("#r-status");
  if (!statusEl) return;
  const r = S.rewards;
  if (!r) { statusEl.innerHTML = `<span class="muted">Loading…</span>`; return; }
  const st = r.state;
  const last = r.last;
  const [pillClass, pillLabel] = last ? OUTCOME_LABELS[last.outcome] ?? ["pill", last.outcome] : ["pill", "no checks yet"];
  const pending = last?.plan?.delta && last.outcome !== "returned" ? last.plan.delta : null;
  statusEl.innerHTML = `
    <div class="row spread"><span class="muted">Engine</span>
      <span class="pill ${r.config.enabled ? "good" : "warn"}">${r.config.enabled ? "enabled" : "disabled"}</span></div>
    <div class="row spread"><span class="muted">Last check</span>
      <span class="small">${last ? `${fmtTime(last.time)} · ` : ""}<span class="${pillClass}">${esc(pillLabel)}</span></span></div>
    ${last?.message ? `<div class="muted small">${esc(last.message)}</div>` : ""}
    <div class="row spread"><span class="muted">Next automatic check</span>
      <span class="small mono">${r.nextRunAt ? fmtTime(r.nextRunAt) : "—"}</span></div>
    <hr style="border-color:var(--border);border-style:solid;opacity:.4">
    <div class="row spread"><span class="muted">Pending rewards (since baseline)</span>
      <span class="mono">${pending ? fmtSat(pending, 4) + " " + sym() : "—"}</span></div>
    <div class="row spread"><span class="muted">Total rewards detected</span>
      <span class="mono">${st ? fmtSat(st.totals.detected, 4) : "0"} ${sym()}</span></div>
    <div class="row spread"><span class="muted">Total returned</span>
      <span class="mono">${st ? fmtSat(st.totals.returned, 4) : "0"} ${sym()}</span></div>
    <div class="row spread"><span class="muted">Tracking baseline</span>
      <span class="mono small">${st?.baseline != null ? fmtSat(st.baseline, 4) + " " + sym() : "not set yet"}</span></div>`;

  const hist = $("#r-history");
  if (hist) {
    const rows = (st?.actions ?? []).map((a) => {
      return `<tr>
        <td class="small">${fmtTime(a.time)}</td>
        <td class="mono">${fmtSat(a.rewards, 4)}</td>
        <td class="mono">${fmtSat(a.amount, 4)}</td>
        <td>${a.mode === "burn" ? "♻️ VHP" : "📤 send"}</td>
        <td><button class="link" data-tx="${esc(a.txId)}">${esc(shortTx(a.txId))}</button></td>
      </tr>`;
    });
    hist.innerHTML = rows.join("") || `<tr><td colspan="5" class="muted">No returns yet.</td></tr>`;
    $$("button[data-tx]", hist).forEach((b) =>
      b.addEventListener("click", () => openTx(b.dataset.tx))
    );
  }
}

// ---------- settings view ----------

function renderSettingsView() {
  const root = $("#view-settings");
  const s = S.appInfo.settings;
  const networks = Object.values(S.appInfo.networks);
  root.innerHTML = `
    <h1>Settings</h1>
    <p class="lead">Network, RPC and wallet management.</p>
    <div class="card">
      <h2>🌐 Network</h2>
      <div class="stack">
        ${networks
          .map(
            (n) => `<label class="row" style="gap:8px">
          <input type="radio" name="set-net" value="${n.id}" ${s.network === n.id ? "checked" : ""} style="width:auto">
          <b>${esc(n.label)}</b>
          <span class="muted small">${n.rpcUrls[0] ?? "local node RPC"} · token ${esc(n.tokenSymbol)}</span></label>`
          )
          .join("")}
      </div>
      <p class="hint">Harbinger is the Koinos testnet (worthless tKOIN from the faucet in the Koinos Discord). It has no public RPC — the app talks to your local node once it's running, or set a custom RPC below.</p>
    </div>
    <div class="card">
      <h2>🔌 Custom RPC (optional)</h2>
      ${networks
        .map(
          (n) => `<label class="field"><span>${esc(n.label)} RPC URL</span>
        <input type="text" class="mono set-rpc" data-net="${n.id}" placeholder="${n.rpcUrls[0] ?? n.localRpcUrl}" value="${esc(s.customRpc?.[n.id] ?? "")}"></label>`
        )
        .join("")}
      <label class="field"><span>Liquid ${esc(sym())} to keep when using Max burn</span>
        <input id="set-keep" type="text" class="mono" value="${esc(s.keepLiquidKoin)}" style="max-width:160px"></label>
      <button id="set-save" class="btn primary">Save settings</button>
    </div>
    <div class="card">
      <h2>🔐 Wallet security</h2>
      <div class="row">
        <button id="set-reveal" class="btn">Reveal private key</button>
        <button id="set-remove" class="btn danger">Remove wallet from this device</button>
      </div>
      <p class="hint">Files live in <span class="mono">${esc(S.appInfo.userData)}</span> <button class="link" id="set-open">open ↗</button></p>
    </div>`;

  $("#set-save").addEventListener("click", onSaveSettings);
  $("#set-open").addEventListener("click", () => call("util:openPath", { which: "userData" }).catch(() => {}));
  $("#set-reveal").addEventListener("click", onRevealWif);
  $("#set-remove").addEventListener("click", onRemoveWallet);
}

async function onSaveSettings() {
  const btn = $("#set-save");
  busyButton(btn, true, "Saving…");
  try {
    const network = $$('input[name="set-net"]').find((r) => r.checked)?.value;
    const customRpc = {};
    $$(".set-rpc").forEach((i) => { customRpc[i.dataset.net] = i.value.trim(); });
    const settings = await call("settings:update", {
      network,
      customRpc,
      keepLiquidKoin: $("#set-keep").value.trim(),
    });
    S.appInfo.settings = settings;
    $("#network-pill").textContent = net().label;
    toast("Settings saved", "good");
    S.balancesAt = 0;
    await Promise.all([refreshBalances(true), refreshNode(), refreshRewards()]);
    renderBurnView();
  } catch (e) {
    toast(e.message, "bad");
  } finally {
    busyButton(btn, false);
  }
}

function onRevealWif() {
  if (!S.wallet?.exists) return toast("No wallet on this device", "warn");
  showModal({
    title: "Reveal private key",
    body: `
      <p class="small">Enter your password. Never share this key or enter it on websites.</p>
      <label class="field"><span>Password</span><input id="rv-pass" type="password"></label>
      <div id="rv-out"></div>`,
    actions: [
      { label: "Close", onClick: (close) => close() },
      {
        label: "Reveal", class: "primary",
        onClick: async (_close, modal) => {
          try {
            const { wif } = await call("wallet:revealWif", { password: $("#rv-pass", modal).value });
            $("#rv-out", modal).innerHTML = `<div class="wif-box">${esc(wif)}</div>`;
          } catch (e) {
            toast(e.message, "bad");
          }
        },
      },
    ],
  });
}

function onRemoveWallet() {
  if (!S.wallet?.exists) return toast("No wallet on this device", "warn");
  showModal({
    title: "⚠️ Remove wallet",
    body: `
      <p class="small">This deletes the encrypted key file from this device. <b>Without a backup of the private key, the funds are lost forever.</b></p>
      <label class="field"><span>Password</span><input id="rm-pass" type="password"></label>
      <label class="field"><span>Type <b>REMOVE</b> to confirm</span><input id="rm-confirm" type="text" class="mono"></label>`,
    actions: [
      { label: "Cancel", onClick: (close) => close() },
      {
        label: "Remove wallet", class: "danger",
        onClick: async (close, modal) => {
          try {
            await call("wallet:remove", {
              password: $("#rm-pass", modal).value,
              confirm: $("#rm-confirm", modal).value.trim(),
            });
            close();
            toast("Wallet removed from this device", "warn");
            await refreshWallet();
          } catch (e) {
            toast(e.message, "bad");
          }
        },
      },
    ],
  });
}

// ---------- navigation + heartbeat ----------

function switchView(view) {
  S.view = view;
  $$(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  $$(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${view}`));
  if (view === "node") refreshNode();
  if (view === "returns") refreshRewards();
  if (view === "wallet" || view === "burn") refreshBalances();
}

async function heartbeat() {
  try {
    await refreshWallet();
    if (S.view === "wallet" || S.view === "burn") await refreshBalances();
    if (S.view === "node") await refreshNode();
    if (S.view === "returns") await refreshRewards();
  } catch { /* keep ticking */ }
}

async function init() {
  S.appInfo = await call("app:info");
  $("#network-pill").textContent = net().label;
  $("#version-tag").textContent = `v${S.appInfo.version}`;

  $$(".nav-item").forEach((b) => b.addEventListener("click", () => switchView(b.dataset.view)));

  window.koinos.onEvent((evt) => {
    if (evt.message) {
      toast(evt.message, evt.level === "error" ? "bad" : evt.type === "rewards" ? "good" : "info", 7000);
    }
    if (evt.type === "node" && S.view === "node") refreshNode();
    if (evt.type === "rewards") { refreshRewards(); S.balancesAt = 0; }
  });

  await refreshWallet();
  renderNodeView();
  renderReturnsView();
  renderSettingsView();
  refreshRewards();

  setInterval(heartbeat, 5000);
}

init().catch((e) => {
  document.body.innerHTML = `<div style="padding:40px;font-family:monospace">Failed to start UI: ${esc(e.message)}</div>`;
});
