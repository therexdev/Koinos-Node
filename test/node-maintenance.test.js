"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { installSnapshot, preflightFolders } = require("../electron/lib/node-maintenance");
const { NodeManager } = require("../electron/lib/node-manager");
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kit-maintenance-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function data(root, name, text) {
  fs.mkdirSync(path.join(root, name), { recursive: true });
  fs.writeFileSync(path.join(root, name, "data"), text);
}

test("snapshot install preserves original databases and leaves producer and peer identity untouched", t => {
  const root = fixture(t), live = path.join(root, "live"), staged = path.join(root, "staged"), backup = path.join(root, "backup");
  for (const name of ["chain", "block_store", "mempool", "block_producer", "p2p"]) data(live, name, "old-" + name);
  for (const name of ["chain", "block_store"]) data(staged, name, "new-" + name);
  installSnapshot(live, backup, path.join(staged, "chain"), path.join(staged, "block_store"));
  for (const name of ["chain", "block_store"]) {
    assert.equal(fs.readFileSync(path.join(live, name, "data"), "utf8"), "new-" + name);
    assert.equal(fs.readFileSync(path.join(backup, name, "data"), "utf8"), "old-" + name);
  }
  for (const name of ["block_producer", "p2p"]) assert.equal(fs.readFileSync(path.join(live, name, "data"), "utf8"), "old-" + name);
  assert.equal(fs.existsSync(path.join(live, ".koinoskit-restore-incomplete.json")), false);
});

test("a failed second database install restores both originals", t => {
  const root = fixture(t), live = path.join(root, "live"), staged = path.join(root, "staged"), backup = path.join(root, "backup");
  for (const name of ["chain", "block_store"]) { data(live, name, "old"); data(staged, name, "new"); }
  const rename = fs.renameSync;
  t.mock.method(fs, "renameSync", (src, dst) => {
    if (src === path.join(staged, "block_store")) throw Object.assign(new Error("locked"), { code: "EPERM" });
    return rename(src, dst);
  });
  assert.throws(() => installSnapshot(live, backup, path.join(staged, "chain"), path.join(staged, "block_store")), /locked|Restart Windows/);
  for (const name of ["chain", "block_store"]) assert.equal(fs.readFileSync(path.join(live, name, "data"), "utf8"), "old");
  assert.equal(fs.existsSync(path.join(live, ".koinoskit-restore-incomplete.json")), false);
});

test("failed rollback leaves a recovery marker and the original data available", t => {
  const root = fixture(t), live = path.join(root, "live"), staged = path.join(root, "staged"), backup = path.join(root, "backup");
  for (const name of ["chain", "block_store"]) { data(live, name, "old"); data(staged, name, "new"); }
  const rename = fs.renameSync;
  t.mock.method(fs, "renameSync", (src, dst) => {
    if (src === path.join(staged, "block_store") || src === path.join(backup, "chain")) throw Object.assign(new Error("locked"), { code: "EPERM" });
    return rename(src, dst);
  });
  assert.throws(() => installSnapshot(live, backup, path.join(staged, "chain"), path.join(staged, "block_store")), /Do not start/);
  assert.equal(fs.readFileSync(path.join(backup, "chain/data"), "utf8"), "old");
  assert.equal(fs.existsSync(path.join(live, ".koinoskit-restore-incomplete.json")), true);
  assert.throws(() => preflightFolders(live), /interrupted/);
});

test("folder preflight never changes data and reports locked folders before download", t => {
  const root = fixture(t); data(root, "chain", "original");
  preflightFolders(root);
  assert.equal(fs.readFileSync(path.join(root, "chain/data"), "utf8"), "original");
  t.mock.method(fs, "renameSync", () => { throw Object.assign(new Error("busy"), { code: "EBUSY" }); });
  assert.throws(() => preflightFolders(root), /Restart Windows/);
});

test("interrupted restore blocks start, automatic monitoring, local rebuild, and another restore", async t => {
  const mgr = new NodeManager({ dataRoot: fixture(t), templateRoot: path.join(__dirname, "../node-template") });
  t.after(() => mgr.dispose());
  mgr.ensureFiles("mainnet", null);
  fs.writeFileSync(path.join(mgr.dirs("mainnet").basedir, ".koinoskit-restore-incomplete.json"), "{}");
  await assert.rejects(mgr.start("mainnet", null), /interrupted/);
  await assert.rejects(mgr.rebuildState("mainnet", null), /interrupted/);
  await assert.rejects(mgr.quickSync("mainnet"), /interrupted/);
  await mgr.resumeMonitoring("mainnet", [{ service: "chain", state: "running" }]);
  assert.equal(mgr._watch, null);
});

test("local rebuild aborts before deleting data when shutdown fails", async t => {
  const mgr = new NodeManager({ dataRoot: fixture(t), templateRoot: path.join(__dirname, "../node-template") });
  t.after(() => mgr.dispose());
  mgr.ensureFiles("mainnet", null);
  const live = mgr.dirs("mainnet").basedir;
  data(live, "chain", "keep-state"); data(live, "block_store", "keep-blocks");
  mgr._rebuildAbort = new AbortController();
  mgr._compose = async () => ({ ok: false, error: "shutdown failed" });
  await assert.rejects(mgr._runRebuildState("mainnet", null, { lines: [] }), /shutdown failed/);
  assert.equal(fs.readFileSync(path.join(live, "chain/data"), "utf8"), "keep-state");
  assert.equal(fs.readFileSync(path.join(live, "block_store/data"), "utf8"), "keep-blocks");
});
