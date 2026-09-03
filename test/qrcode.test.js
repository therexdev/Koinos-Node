"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const QR = require("../ui/qrcode.js");

// The golden fingerprints below were verified module-for-module against the
// reference `qrcode` npm package (error-correction level M, single byte-mode
// segment) across versions 1-10 — version, mask and every module matched. They
// pin that verified output so a regression here can't ship an unscannable code.
const fingerprint = (q) =>
  crypto.createHash("sha256").update(q.modules.map((r) => Array.from(r).join("")).join("\n")).digest("hex").slice(0, 32);

const KOINOS_ADDR = "1CZ4AV3jbGB7fi9bqarouyquFQ94DpLsqi";
const ETH_ADDR = "0x71C7656EC7ab88b098defB751B7401B5f6d8976F";

test("encodes a Koinos address to the reference-verified matrix", () => {
  const q = QR.encode(KOINOS_ADDR);
  assert.equal(q.version, 3);
  assert.equal(q.size, 29);
  assert.equal(q.mask, 3);
  assert.equal(fingerprint(q), "635b71dbc148245a598d7c18cbaa785e");
});

test("encodes an Ethereum address to the reference-verified matrix", () => {
  const q = QR.encode(ETH_ADDR);
  assert.equal(q.version, 3);
  assert.equal(q.mask, 2);
  assert.equal(fingerprint(q), "8ad8f9139e00fc48d10c494102dab90e");
});

test("matches the reference at the small and large ends of the range", () => {
  assert.equal(fingerprint(QR.encode("hello world")), "851bd1031e2539fc5e015f26d9096341");
  assert.equal(fingerprint(QR.encode("r".repeat(213))), "4f2a0eab7d05c2971b8fb6d30a34d604");
});

test("picks the smallest version that fits, and sizes the matrix by it", () => {
  // Boundaries account for the 12-bit byte-mode header (16-bit count from v10).
  for (const [len, version] of [[14, 1], [15, 2], [26, 2], [27, 3], [42, 3], [43, 4], [62, 4], [63, 5], [213, 10]]) {
    const q = QR.encode("x".repeat(len));
    assert.equal(q.version, version, `${len} bytes should be version ${version}`);
    assert.equal(q.size, version * 4 + 17);
    assert.equal(q.modules.length, q.size);
  }
});

test("rejects empty input and data beyond version 10", () => {
  assert.throws(() => QR.encode(""), /nothing to encode/);
  assert.throws(() => QR.encode("x".repeat(214)), /too long/);
});

test("places the mandatory function patterns", () => {
  const { size, modules } = QR.encode(KOINOS_ADDR);
  // Finder patterns: dark 7x7 border with a dark 3x3 core, at three corners.
  for (const [top, left] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    for (let i = 0; i < 7; i++) {
      assert.equal(modules[top][left + i], 1, "finder top edge");
      assert.equal(modules[top + 6][left + i], 1, "finder bottom edge");
      assert.equal(modules[top + i][left], 1, "finder left edge");
      assert.equal(modules[top + i][left + 6], 1, "finder right edge");
    }
    assert.equal(modules[top + 1][left + 1], 0, "finder inner ring is light");
    assert.equal(modules[top + 3][left + 3], 1, "finder core is dark");
  }
  // The bottom-right corner must NOT hold a finder pattern.
  assert.equal(modules[size - 1][size - 1], 0);
  // Timing patterns alternate along row 6 and column 6.
  for (let i = 8; i < size - 8; i++) {
    assert.equal(modules[6][i], i % 2 === 0 ? 1 : 0, `row-6 timing at ${i}`);
    assert.equal(modules[i][6], i % 2 === 0 ? 1 : 0, `col-6 timing at ${i}`);
  }
  // The module above the bottom-left finder's format strip is always dark.
  assert.equal(modules[size - 8][8], 1);
});

test("emits only 0/1 modules", () => {
  const { modules } = QR.encode(ETH_ADDR);
  for (const row of modules) for (const v of row) assert.ok(v === 0 || v === 1);
});

test("toSvg needs a DOM (renderer-only helper)", () => {
  assert.throws(() => QR.toSvg(KOINOS_ADDR), /needs a DOM/);
});
