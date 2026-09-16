"use strict";
const fs = require("fs");
const path = require("path");
const DATA_DIRS = ["chain", "block_store", "mempool", "transaction_store", "account_history", "contract_meta_store"];

function inspectLogs(text) {
  let health = null;
  if (/replayed state delta merkle root does not match block receipt/i.test(text)) {
    health = { ok: false, needsRepair: true, reason: "replay-mismatch", service: "chain" };
  } else if (/fatal.*chain|chain[^\n]*fatal/i.test(text)) {
    health = { ok: false, reason: "chain-failed", service: "chain" };
  } else if ((text.match(/No response to client request[^\n]*within 30000ms/gi) || []).length >= 2) {
    health = { ok: false, reason: "chain-unresponsive", service: "chain" };
  }
  // Official koinos-p2p emits this snapshot once a minute. Never turn a
  // missing/truncated snapshot into a zero or reuse it beyond the log window.
  const lines = String(text).split(/\r?\n/);
  let peers = null;
  for (let i = 0; i < lines.length; i++) {
    if (!/Connected peers:/.test(lines[i])) continue;
    let count = 0, lowerBound = false;
    for (let j = i + 1; j < lines.length; j++) {
      if (/Connected peers:|My address:/.test(lines[j])) break;
      if (!/p2p[^|]*\|/.test(lines[j])) continue;
      if (/ - .*\/p2p\/\S+/.test(lines[j])) count++;
      else if (/and \d+ more/.test(lines[j])) { lowerBound = true; break; }
      else break;
    }
    peers = { count, lowerBound, observedAt: lines[i].match(/\d{4}-\d\d-\d\dT[\d:.]+Z/)?.[0] || null };
  }
  let production = null;
  for (const line of lines) {
    if (!/block_producer[^|]*\|/.test(line)) continue;
    if (/Error while submitting block:/i.test(line)) production = {
      reason: /could not burn vhp/i.test(line) ? "vhp-burn-rejected" : "block-submission-rejected",
      observedAt: line.match(/\d{4}-\d\d-\d\d[T ][\d:.]+Z?/)?.[0] || null,
    };
    else if (/Produced block - Height:/i.test(line)) production = { reason: null };
  }
  return { health, peers, production };
}

function lockError(e) {
  if (["EPERM", "EACCES", "EBUSY"].includes(e.code)) {
    return new Error(`The node data folder is locked or access was denied. Restart Windows fully, then open KoinosKit and run Quick Sync before starting the node. Closing Docker or WSL alone may not release the lock. If it persists, check folder permissions and security software. (${e.code})`);
  }
  return e;
}
function assertRestoreReady(basedir) {
  if (fs.existsSync(path.join(basedir, ".koinoskit-restore-incomplete.json")) || DATA_DIRS.some(name => fs.existsSync(path.join(basedir, `.koinoskit-check-${name}`)))) {
    throw new Error("A previous restore or folder check was interrupted. Recover the original folders using the restore marker before starting the node or Quick Sync.");
  }
}
function preflightFolders(basedir) {
  assertRestoreReady(basedir);
  for (const name of DATA_DIRS) {
    const src = path.join(basedir, name), probe = path.join(basedir, `.koinoskit-check-${name}`);
    if (!fs.existsSync(src)) continue;
    if (fs.existsSync(probe)) throw new Error(`A previous folder check remains at ${probe}. Restore it before Quick Sync.`);
    try { fs.renameSync(src, probe); } catch (e) { throw lockError(e); }
    try { fs.renameSync(probe, src); } catch (e) {
      throw new Error(`Could not restore the folder check. Your data is at ${probe}; restore it to ${src} before starting the node. ${lockError(e).message}`);
    }
  }
}
function installSnapshot(basedir, rollback, chain, blockStore) {
  fs.mkdirSync(rollback, { recursive: true });
  const moved = [], installed = [];
  const marker = path.join(basedir, ".koinoskit-restore-incomplete.json");
  fs.writeFileSync(marker, JSON.stringify({ rollback, chain, blockStore }), { flag: "wx" });
  try {
    for (const name of DATA_DIRS) {
      const src = path.join(basedir, name);
      if (fs.existsSync(src)) { fs.renameSync(src, path.join(rollback, name)); moved.push(name); }
    }
    for (const [src, name] of [[chain, "chain"], [blockStore, "block_store"]]) {
      fs.renameSync(src, path.join(basedir, name)); installed.push([src, name]);
    }
  } catch (e) {
    const failures = [];
    for (const [src, name] of installed.reverse()) {
      try { fs.renameSync(path.join(basedir, name), src); } catch (err) { failures.push(err.message); }
    }
    for (const name of moved.reverse()) {
      try { fs.renameSync(path.join(rollback, name), path.join(basedir, name)); } catch (err) { failures.push(err.message); }
    }
    if (failures.length) throw new Error(`Restore failed. Some original data remains in ${rollback}. Do not start the node until recovered. ${failures.join("; ")}`);
    fs.rmdirSync(rollback);
    fs.unlinkSync(marker);
    throw lockError(e);
  }
  fs.unlinkSync(marker);
}
module.exports = { assertRestoreReady, inspectLogs, preflightFolders, installSnapshot };
