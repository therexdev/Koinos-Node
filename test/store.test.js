"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { JsonStore, deepMerge } = require("../electron/lib/store");

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "kai-store-")), "s.json");
}

function koinosSettingsFile() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kai-node-store-"));
  const dir = path.join(root, "koinos-node");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "settings.json");
}

test("get/set with dotted paths persists atomically", () => {
  const file = tmpFile();
  const s = new JsonStore(file, { a: { b: 1 } });
  assert.equal(s.get("a.b"), 1);
  s.set("a.c.d", "x");
  const reread = new JsonStore(file);
  assert.equal(reread.get("a.c.d"), "x");
  assert.equal(reread.get("a.b"), 1);
  assert.ok(!fs.existsSync(file + ".tmp"), "tmp file cleaned up by rename");
});

test("corrupt non-critical file falls back to defaults", () => {
  const file = tmpFile();
  fs.writeFileSync(file, "{nope");
  const s = new JsonStore(file, { ok: true });
  assert.equal(s.get("ok"), true);
});

test("Koinos node settings keep and recover external custody from last-known-good backup", () => {
  const file = koinosSettingsFile();
  const defaults = { network: "mainnet" };
  const s = new JsonStore(file, defaults);
  s.set("producer", { mode: "external", addresses: { mainnet: "1ColdProducer" } });
  assert.ok(fs.existsSync(file + ".last-good"));

  fs.writeFileSync(file, "{broken-json");
  const recovered = new JsonStore(file, defaults);
  assert.equal(recovered.health().ok, true);
  assert.equal(recovered.health().recoveredFromBackup, true);
  assert.equal(recovered.get("producer.mode"), "external");
  assert.equal(recovered.get("producer.addresses.mainnet"), "1ColdProducer");
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).producer.mode, "external");
});

test("Koinos node settings fail closed when an existing corrupt custody file has no recovery copy", () => {
  const file = koinosSettingsFile();
  fs.writeFileSync(file, "{broken-json");
  const s = new JsonStore(file, { network: "mainnet" });
  assert.equal(s.health().ok, false);
  assert.match(s.health().error, /unreadable.*no last-known-good/i);
  assert.equal(s.get("producer.mode", "local"), "local"); // callers must consult health before trusting this fallback
});

test("verified critical save can explicitly repair an unresolved custody store", () => {
  const file = koinosSettingsFile();
  fs.writeFileSync(file, "{broken-json");
  const s = new JsonStore(file, { network: "mainnet" });
  assert.equal(s.health().ok, false);
  s.set("producer", { mode: "external", addresses: { mainnet: "1ConfirmedAgain" } });
  assert.equal(s.health().ok, true);
  const restarted = new JsonStore(file, { network: "mainnet" });
  assert.equal(restarted.health().ok, true);
  assert.equal(restarted.get("producer.mode"), "external");
  assert.equal(restarted.get("producer.addresses.mainnet"), "1ConfirmedAgain");
});

test("deepMerge merges nested objects and overwrites arrays", () => {
  const out = deepMerge({ a: { x: 1, y: 2 }, list: [1] }, { a: { y: 3 }, list: [2, 3] });
  assert.deepEqual(out, { a: { x: 1, y: 3 }, list: [2, 3] });
});

test("valid JSON with an invalid custody shape fails closed instead of becoming local", () => {
  for (const value of [null, [], "settings", { producer: null }, { producer: { mode: "externla", addresses: {} } }]) {
    const file = koinosSettingsFile();
    fs.writeFileSync(file, JSON.stringify(value));
    const settings = new JsonStore(file, { producer: { mode: "local", addresses: {} } });
    assert.equal(settings.health().ok, false);
    assert.throws(() => settings.set("node.autoRecover", true), /unresolved/);
    assert.equal(settings.health().ok, false);
  }
});
