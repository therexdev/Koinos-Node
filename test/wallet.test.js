"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Signer } = require("koilib");
const { WalletService } = require("../electron/lib/wallet");

function freshService() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "knd-wallet-"));
  return new WalletService(dir);
}

test("create, lock, unlock roundtrip", () => {
  const w = freshService();
  assert.deepEqual(w.status(), { exists: false, unlocked: false, address: null, createdAt: null });

  const { address, wif } = w.create({ password: "pw12345678" });
  assert.equal(Signer.fromWif(wif).getAddress(), address);
  assert.equal(w.status().unlocked, true);

  w.lock();
  assert.equal(w.status().unlocked, false);
  assert.equal(w.status().address, address); // address visible while locked

  assert.throws(() => w.unlock("wrong password"), /Incorrect password/);
  w.unlock("pw12345678");
  assert.equal(w.status().unlocked, true);
  assert.equal(w.signer.getAddress(), address);
});

test("import WIF preserves the address", () => {
  const seedSigner = Signer.fromSeed("wallet test seed");
  const wif = seedSigner.getPrivateKey("wif");
  const w = freshService();
  const { address } = w.importWif({ wif, password: "pw12345678" });
  assert.equal(address, seedSigner.getAddress());
  w.lock();
  w.unlock("pw12345678");
  assert.equal(w.signer.getAddress(), seedSigner.getAddress());
});

test("guards: weak password, invalid wif, existing wallet", () => {
  const w = freshService();
  assert.throws(() => w.create({ password: "short" }), /at least 8/);
  assert.throws(() => w.importWif({ wif: "garbage", password: "pw12345678" }), /Invalid private key/);
  w.create({ password: "pw12345678" });
  assert.throws(() => w.create({ password: "pw12345678" }), /already exists/);
  assert.throws(() => w.importWif({ wif: "x", password: "pw12345678" }), /already exists/);
});

test("revealWif requires the password even when unlocked", () => {
  const w = freshService();
  const { wif } = w.create({ password: "pw12345678" });
  assert.equal(w.revealWif("pw12345678").wif, wif);
  assert.throws(() => w.revealWif("nope-nope-nope"), /Incorrect password/);
});

test("remove needs password and typed confirmation", () => {
  const w = freshService();
  w.create({ password: "pw12345678" });
  assert.throws(() => w.remove({ password: "pw12345678", confirm: "nope" }), /REMOVE/);
  assert.throws(() => w.remove({ password: "wrong", confirm: "REMOVE" }), /Incorrect password/);
  w.remove({ password: "pw12345678", confirm: "REMOVE" });
  assert.equal(w.status().exists, false);
});
