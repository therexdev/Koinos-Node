#!/usr/bin/env node
"use strict";
// Export the exact reviewed desktop signer to the existing website checkout.
const fs = require("fs"), path = require("path"), crypto = require("crypto");
function exportSigner(destination) {
  const source = path.resolve(__dirname, "../ui/producer-signer");
  fs.mkdirSync(destination, { recursive: true });
  const koilibVersion = require("koilib/package.json").version;
  if (koilibVersion !== "9.3.0") throw new Error("Review the Koilib browser bundle before changing the signer deployment version.");
  const bundle = path.join(path.dirname(require.resolve("koilib/package.json")), "dist");
  const files = {};
  const sources = Object.fromEntries(["index.html", "signer.css", "signer.js", "validation.js", "abis.js", "kondor.min.js", "NOTICE.txt"].map(name => [name, path.join(source, name)]));
  for (const name of ["koinos.min.js", "koinos.min.js.LICENSE.txt"]) sources[name] = path.join(bundle, name);
  for (const [name, file] of Object.entries(sources)) {
    const bytes = fs.readFileSync(file);
    fs.writeFileSync(path.join(destination, name), bytes);
    files[name] = crypto.createHash("sha256").update(bytes).digest("hex");
  }
  fs.writeFileSync(path.join(destination, "manifest.json"), JSON.stringify({ format: "kai-producer-signer-v1", koilibVersion, kondorCommit: "e319c5f190ec6d4c3c644270ded85a1256cd8e7c", files }, null, 2) + "\n");
}
if (require.main === module) {
  if (!process.argv[2]) throw new Error("Usage: node scripts/export-producer-signer.js WEBSITE_CHECKOUT/public/producer-signer");
  exportSigner(path.resolve(process.argv[2]));
}
module.exports = { exportSigner };
