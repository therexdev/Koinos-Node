"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../ui/renderer.js"), "utf8");
function painter() {
  const nodes = new Map();
  const $ = id => {
    if (!nodes.has(id)) nodes.set(id, { textContent: "", innerHTML: "", className: "", dataset: {}, addEventListener() {} });
    return nodes.get(id);
  };
  const S = { node: { docker: { ok: true }, isRunning: true, health: { ok: true }, services: [],
    sync: { inSync: true, local: { height: 100 }, progressPct: 100 } },
    wallet: { exists: true }, producer: { filePublicKey: "fixture", matches: true }, walletStage: "locked", dashboardRendered: true };
  const context = vm.createContext({ S, $, ONE: 100000000n, sym: () => "KOIN", onQuickSync() {}, onRebuild() {} });
  for (const name of ["esc", "fmtSat", "fmtTime", "fmtPct", "fmtBytes", "tile", "nodeDisplayState", "patchNodeView", "patchDashboardView"]) {
    const start = source.indexOf(`function ${name}(`); assert.ok(start >= 0);
    const rest = source.slice(start), end = rest.search(/\n(?:async )?function \w+\(/);
    vm.runInContext(end < 0 ? rest : rest.slice(0, end), context);
  }
  return { S, $, paint() {
    S.dashboard = { node: S.node, sync: S.node.sync, network: { label: "Mainnet", tokenSymbol: "KOIN" }, wallet: { exists: false } };
    vm.runInContext("patchNodeView(); patchDashboardView();", context);
  } };
}

test("Stop stays busy on both screens until completion, then explicitly permits reboot", () => {
  const { S, $, paint } = painter();
  S.node.op = { name: "stop", running: true, tail: [] }; paint();
  assert.equal($("#d-status-text").textContent, "Stopping");
  assert.equal($("#d-toggle").disabled, true);
  assert.equal($("#n-start").disabled, true);
  assert.match($("#n-health").innerHTML, /Wait for shutdown/);
  S.node.op = { name: "stop", running: false, code: 0 }; S.node.isRunning = false; paint();
  assert.equal($("#d-status-text").textContent, "Stopped");
  assert.match($("#n-op").innerHTML, /now restart/);
  assert.equal($("#d-toggle").disabled, false);
});

test("restore hides stale sync and earning claims and disables conflicting controls", () => {
  const { S, $, paint } = painter();
  for (const name of ["quick-sync", "rebuild-state"]) {
    S.node.op = { name, running: true, tail: [], progress: { stage: "extract", pct: 20 } }; paint();
    assert.equal($("#d-dot").className, "dot amber");
    assert.equal($("#d-sync").innerHTML, "");
    for (const id of ["#n-start", "#n-stop", "#n-rebuild", "#n-quicksync"]) assert.equal($(id).disabled, true);
    assert.match($("#n-health").innerHTML, /paused/);
    assert.doesNotMatch($("#n-reg-hint").textContent, /your node signs blocks/);
  }
});

test("failed RPC never shows green, and replay is shown as progress", () => {
  const { S, $, paint } = painter();
  S.node.health = { ok: false, reason: "local-chain-unavailable" }; paint();
  assert.equal($("#d-dot").className, "dot red");
  assert.equal($("#n-run-pill").textContent, "Needs attention");
  assert.match($("#n-health").innerHTML, /RPC is unavailable/);
  S.node.health = { ok: true, reason: "replaying" }; paint();
  assert.equal($("#d-status-text").textContent, "Replaying blocks");
});

test("memory-saver explains missing RPC without claiming block production", () => {
  const { S, $, paint } = painter();
  S.node.memorySaver = true; S.node.sync = { local: { error: "unavailable" } }; paint();
  assert.equal($("#d-status-text").textContent, "Services running");
  assert.match($("#n-sync").innerHTML, /disabled in memory-saver/);
  assert.doesNotMatch($("#n-health").innerHTML, /up and earning/);
});
