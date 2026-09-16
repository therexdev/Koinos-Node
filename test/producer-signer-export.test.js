"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto"), vm = require("node:vm");
const { exportSigner } = require("../scripts/export-producer-signer");
const { TOKEN_ABI, POB_ABI } = require("../electron/lib/constants");

test("signer export includes every local script and license and records exact bundle hashes", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kit-signer-export-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  exportSigner(dir);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  assert.equal(manifest.koilibVersion, "9.3.0");
  const html = fs.readFileSync(path.join(dir, "index.html"), "utf8");
  for (const [, name] of html.matchAll(/<script src="([^"]+)"/g)) assert.ok(manifest.files[name], name);
  assert.ok(manifest.files["koinos.min.js.LICENSE.txt"]);
  for (const [name, expected] of Object.entries(manifest.files)) {
    assert.equal(crypto.createHash("sha256").update(fs.readFileSync(path.join(dir, name))).digest("hex"), expected);
  }
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(dir, "abis.js"), "utf8"), context);
  const abis = JSON.parse(JSON.stringify(context.KaiProducerAbis));
  assert.deepEqual(abis.tokenAbi, TOKEN_ABI);
  assert.deepEqual(abis.pobAbi, POB_ABI);
});
