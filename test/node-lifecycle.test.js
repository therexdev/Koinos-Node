"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { NodeManager } = require("../electron/lib/node-manager");
const { withSyncHealth } = require("../electron/lib/node-health");
const { SetupService } = require("../electron/lib/setup");
const ADDRESS = "1K1AUovu5NjjPcaTxmde6wPB8Y8PQGFV3E";
const rows = () => ["chain", "block_store", "mempool", "p2p", "block_producer", "jsonrpc"].map(service => ({ service, state: "running" }));
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kit-lifecycle-"));
  const mgr = new NodeManager({ templateRoot: path.join(__dirname, "../node-template"), dataRoot: root, probeHead: async () => null, ...options });
  t.after(() => { mgr.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  mgr.ensureFiles("mainnet", ADDRESS);
  mgr.services = async () => rows();
  mgr.dockerInfo = async () => ({ ok: true });
  mgr._compose = async () => ({ ok: true, stdout: "", stderr: "" });
  mgr.assertProjectOwnership = async () => {};
  return { mgr, root };
}
function arm(mgr, saver = false) {
  mgr._desiredRunning = true;
  mgr._startWatchdog("mainnet", true, ADDRESS, saver);
  mgr._watch.graceUntil = 0;
  mgr._watch.lastHeightAt = Date.now() - 10 * 60000;
}
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { resolve, promise }; }

test("start reserves the operation while Docker is starting, and handles startup errors", async t => {
  const { mgr } = fixture(t);
  const ready = deferred();
  await mgr.start("mainnet", ADDRESS, { prepare: () => ready.promise });
  assert.equal(mgr.currentOp().running, true);
  await assert.rejects(mgr.start("mainnet", ADDRESS), /Another node operation/);
  await assert.rejects(mgr.stop("mainnet"), /Another node operation/);
  mgr._composeOp = async () => { throw new Error("RPC port already allocated"); };
  ready.resolve();
  await mgr._lifecycle;
  assert.equal(mgr.currentOp().running, false);
  assert.match(mgr.currentOp().error, /port already/);
  assert.equal(mgr._watch, null);
});

test("stop completes only after Docker exits and persists the explicit stop across reopening", async t => {
  const { mgr, root } = fixture(t);
  arm(mgr);
  const done = deferred(); let completed = false;
  mgr._composeOp = async (network, name, args, op) => {
    assert.deepEqual(args, ["down", "--timeout", "60"]);
    await done.promise; op.code = 0; return op;
  };
  const stopping = mgr.stop("mainnet").then(() => { completed = true; });
  assert.equal(completed, false);
  assert.equal(mgr.currentOp().running, true);
  const reopened = new NodeManager({ dataRoot: root });
  t.after(() => reopened.dispose());
  reopened.services = async () => rows();
  await reopened.resumeMonitoring("mainnet");
  assert.equal(reopened._watch, null, "residual running services cannot undo Stop");
  done.resolve(); await stopping; await mgr.waitForStop();
  assert.equal(completed, true);
  assert.equal(mgr.currentOp().running, false);
  assert.equal(mgr.currentOp().code, 0);
});

test("failed shutdown is reported and never presented as safe to reboot", async t => {
  const { mgr } = fixture(t);
  mgr._composeOp = async () => { throw new Error("Docker shutdown failed"); };
  await assert.rejects(mgr.stop("mainnet"), /shutdown failed/);
  await assert.rejects(mgr.waitForStop(), /shutdown failed/);
  assert.equal(mgr.currentOp().code, 1);
});

test("existing containers are adopted after reopening without rewriting config or starting Docker", async t => {
  const { mgr } = fixture(t);
  mgr.ensureFiles = () => { throw new Error("must not rewrite running node"); };
  await mgr.resumeMonitoring("mainnet");
  assert.equal(mgr._watch.producerAddress, ADDRESS);
  assert.equal(mgr._desiredRunning, true);
  assert.equal(mgr.currentOp(), null);
});

test("reopening retries discovery after Docker becomes available", async t => {
  const { mgr } = fixture(t);
  mgr.services = async () => [];
  await mgr.resumeMonitoring("mainnet");
  assert.equal(mgr._watch, null);
  mgr.services = async () => rows();
  await mgr.resumeMonitoring("mainnet");
  assert.ok(mgr._watch);
});

test("explicit Stop wins over an in-flight monitoring discovery", async t => {
  const { mgr } = fixture(t);
  const discovery = deferred();
  mgr.services = () => discovery.promise;
  const resume = mgr.resumeMonitoring("mainnet");
  mgr._composeOp = async (id, name, args, op) => { op.code = 0; return op; };
  await mgr.stop("mainnet");
  discovery.resolve(rows()); await resume;
  assert.equal(mgr._watch, null);
  assert.equal(mgr._desiredRunning, false);
});

test("missing RPC with running containers requests recovery after the grace window", async t => {
  const { mgr } = fixture(t); arm(mgr);
  let recovered = false;
  mgr._recover = async () => { recovered = true; };
  await mgr._watchTick();
  assert.equal(mgr._watch.health.reason, "chain-unresponsive");
  assert.equal(recovered, true);
});

test("advancing local replay is not restarted, while a frozen replay eventually is", async t => {
  const { mgr } = fixture(t); arm(mgr);
  let height = 110, recoveries = 0;
  mgr._compose = async () => ({ ok: true, stdout: `chain-1 | Indexing to target block - Height: 1000\nchain-1 | Block application - Height: ${height}`, stderr: "" });
  mgr._recover = async () => { recoveries++; };
  await mgr._watchTick();
  assert.equal(mgr._watch.health.reason, "replaying");
  mgr._watch.lastReplayAt = Date.now() - 25 * 60000;
  height = 200; mgr._observations.clear(); await mgr._watchTick();
  assert.equal(recoveries, 0, "fresh block application renews the grace period");
  mgr._watch.lastReplayAt = Date.now() - 25 * 60000;
  mgr._watch.lastHeightAt = Date.now() - 25 * 60000;
  mgr._observations.clear(); await mgr._watchTick();
  assert.equal(recoveries, 1, "unchanged logs cannot mask a stuck replay forever");
});

test("producer timeouts during active replay do not cause restart loops", async t => {
  const { mgr } = fixture(t); arm(mgr);
  const timeout = "block_producer-1 | No response to client request abc within 30000ms";
  mgr._compose = async () => ({ ok: true, stdout: `chain-1 | Block application - Height: 100\n${timeout}\n${timeout}`, stderr: "" });
  mgr._recover = async () => assert.fail("must not restart progressing replay");
  await mgr._watchTick();
  assert.equal(mgr._watch.health.reason, "replaying");
});

test("replay mismatches are visible despite running containers and do not delete local data", async t => {
  const { mgr } = fixture(t, { autoRecover: false }); arm(mgr);
  const logs = "chain-1 | replayed state delta merkle root does not match block receipt";
  mgr._compose = async () => ({ ok: true, stdout: logs, stderr: "" });
  mgr._recover = async () => assert.fail("deterministic failures require explicit repair");
  const status = await mgr.status("mainnet");
  assert.equal(status.health.needsRepair, true);
  assert.equal(status.health.repairReason, "state-mismatch");
  mgr.setAutoRecover(true); await mgr._watchTick();
  assert.equal(mgr._watch.needsRepair, true);
  assert.equal(typeof mgr.rebuildState, "function", "local rebuild remains available");
});

test("memory-saver survives reopening and does not treat disabled RPC as a failure", async t => {
  const { mgr } = fixture(t);
  mgr.ensureFiles("mainnet", ADDRESS, { memorySaver: true });
  await mgr.resumeMonitoring("mainnet");
  mgr._watch.graceUntil = 0; mgr._watch.lastHeightAt = Date.now() - 60 * 60000;
  mgr._recover = async () => assert.fail("RPC is intentionally disabled");
  await mgr._watchTick();
  const status = await mgr.status("mainnet");
  assert.equal(status.memorySaver, true);
  assert.equal(status.health.ok, true);
});

test("recovery refuses to start over an unsuccessful shutdown", async t => {
  const { mgr } = fixture(t); arm(mgr);
  const commands = [];
  mgr._compose = async (id, args) => { commands.push(args[0]); return { ok: false, error: "database still busy" }; };
  await assert.rejects(mgr._restartStack(mgr._watch), /database still busy/);
  assert.deepEqual(commands, ["down"]);
  assert.equal(mgr.currentOp().running, false);
});

test("a transient empty service response is unknown health and does not restart", async t => {
  const { mgr } = fixture(t); arm(mgr);
  mgr.services = async () => [];
  mgr._recover = async () => assert.fail("do not act on missing Docker data");
  await mgr._watchTick();
  assert.equal(mgr._watch.health.ok, false);
  assert.equal(mgr._watch.health.reason, "no-data");
});

test("health probes remain scoped to the watched network", async t => {
  let network;
  const { mgr } = fixture(t, { probeHead: async id => { network = id; return 10; } });
  arm(mgr); await mgr._watchTick(); assert.equal(network, "mainnet");
});

test("status never hides an unavailable RPC behind healthy containers", () => {
  const status = { isRunning: true, health: { ok: true } };
  assert.equal(withSyncHealth(status, { local: { error: "timeout" } }).health.ok, false);
  assert.equal(withSyncHealth({ ...status, memorySaver: true }, null).health.ok, true);
});

test("Docker startup waits for readiness and Linux gives the actual daemon error", async () => {
  const setup = new SetupService({ platform: "win32" });
  let probes = 0, starts = 0;
  setup.startDocker = async () => { starts++; return { started: true }; };
  await setup.ensureDockerReady(async () => ({ ok: ++probes >= 3 }), { wait: async () => {} });
  assert.equal(starts, 1); assert.equal(probes, 3);
  setup.platform = "linux";
  await assert.rejects(setup.ensureDockerReady(async () => ({ ok: false, error: "daemon stopped" })), /daemon stopped/);
  assert.equal(starts, 1);
});

test("Docker readiness times out without attempting to start a node prematurely", async () => {
  const setup = new SetupService({ platform: "win32" });
  setup.startDocker = async () => ({ started: true });
  await assert.rejects(setup.ensureDockerReady(async () => ({ ok: false }), { timeoutMs: 0 }), /still starting/);
});

test("shared Docker project names cannot make KoinosKit adopt or stop KAI containers", async t => {
  const { mgr } = fixture(t);
  mgr.assertProjectOwnership = NodeManager.prototype.assertProjectOwnership.bind(mgr);
  let owner = path.resolve(mgr.dirs("mainnet").root);
  mgr._exec = async (bin, args) => args[0] === "ps"
    ? { ok: true, stdout: "abc123\n" }
    : { ok: true, stdout: JSON.stringify({ "com.docker.compose.project.working_dir": owner }) };
  await mgr.assertProjectOwnership("mainnet");
  owner = path.resolve(mgr.dataRoot, "other-app", "mainnet");
  await assert.rejects(mgr.resumeMonitoring("mainnet"), /another app/);
  assert.equal(mgr._watch, null);
  await assert.rejects(mgr.stop("mainnet"), /another app/);
});

test("start and stop drive a real child process, retain chain data, and report completion", async t => {
  const { mgr, root } = fixture(t);
  const fake = path.join(root, "compose-fixture.js");
  fs.writeFileSync(fake, 'setTimeout(() => { console.log("fixture compose finished"); }, 30);');
  mgr._composeCmd = { bin: process.execPath, pre: [fake] };
  const sentinel = path.join(mgr.dirs("mainnet").basedir, "preserved-data");
  fs.writeFileSync(sentinel, "existing-chain");
  await mgr.start("mainnet", ADDRESS);
  assert.equal(mgr.currentOp().running, true);
  await mgr._lifecycle;
  assert.equal(mgr.currentOp().code, 0);
  assert.equal(mgr._watch.producerAddress, ADDRESS);
  assert.equal((await mgr.stop("mainnet")).stopped, true);
  assert.equal(mgr._watch, null);
  assert.equal(fs.readFileSync(sentinel, "utf8"), "existing-chain");
});
