"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { computeReturn, validateRewardsConfig } = require("../electron/lib/rewards");

const KOIN = (n) => String(BigInt(n) * 100000000n);
const base = { pct: 80, minReturnSat: KOIN(1), availableLiquidSat: KOIN(1000) };

test("no rewards yet -> accumulate nothing", () => {
  const p = computeReturn({ rewardsSinceEnable: "0", returnedSoFar: "0", ...base });
  assert.equal(p.action, "accumulate");
  assert.equal(p.returnAmount, "0");
});

test("returns the configured percentage of real rewards", () => {
  const p = computeReturn({ rewardsSinceEnable: KOIN(10), returnedSoFar: "0", ...base });
  assert.equal(p.action, "return");
  assert.equal(p.desired, KOIN(8)); // 80% of 10
  assert.equal(p.returnAmount, KOIN(8));
});

test("only the not-yet-returned remainder is returned", () => {
  // 10 KOIN rewards, 80% target = 8, already returned 5 -> return 3 more
  const p = computeReturn({ rewardsSinceEnable: KOIN(10), returnedSoFar: KOIN(5), ...base });
  assert.equal(p.action, "return");
  assert.equal(p.pending, KOIN(3));
  assert.equal(p.returnAmount, KOIN(3));
});

test("once caught up to target, nothing pending", () => {
  const p = computeReturn({ rewardsSinceEnable: KOIN(10), returnedSoFar: KOIN(8), ...base });
  assert.equal(p.action, "accumulate");
  assert.equal(p.pending, "0");
});

test("small rewards accumulate below the minimum", () => {
  const p = computeReturn({ rewardsSinceEnable: KOIN(1), returnedSoFar: "0", pct: 50, minReturnSat: KOIN(1), availableLiquidSat: KOIN(100) });
  assert.equal(p.action, "accumulate"); // 50% of 1 = 0.5 < 1
});

test("return is capped by available liquid above the mana buffer", () => {
  const p = computeReturn({ rewardsSinceEnable: KOIN(10), returnedSoFar: "0", pct: 80, minReturnSat: KOIN(1), availableLiquidSat: KOIN(5) });
  assert.equal(p.action, "return");
  assert.equal(p.pending, KOIN(8));
  assert.equal(p.returnAmount, KOIN(5)); // capped
});

test("too little liquid to meet the minimum -> insufficient-liquid", () => {
  const p = computeReturn({ rewardsSinceEnable: KOIN(10), returnedSoFar: "0", pct: 80, minReturnSat: KOIN(1), availableLiquidSat: "50000000" });
  assert.equal(p.action, "insufficient-liquid");
  assert.equal(p.returnAmount, "0");
});

test("0% never returns", () => {
  const p = computeReturn({ rewardsSinceEnable: KOIN(100), returnedSoFar: "0", pct: 0, minReturnSat: KOIN(1), availableLiquidSat: KOIN(1000) });
  assert.equal(p.action, "accumulate");
});

test("deposits/burns can't inflate rewards (returnable clamps at 0)", () => {
  const p = computeReturn({ rewardsSinceEnable: "-500000000", returnedSoFar: "0", ...base });
  assert.equal(p.action, "accumulate");
  assert.equal(p.returnAmount, "0");
});

test("validateRewardsConfig normalizes and rejects bad values", () => {
  const cfg = validateRewardsConfig({
    enabled: 1, pct: "25", mode: "burn", toAddress: null, minReturnKoin: "2", pollMinutes: "15",
  });
  assert.deepEqual(cfg, {
    enabled: true, pct: 25, mode: "burn", toAddress: "", minReturnKoin: "2", pollMinutes: 15,
  });
  assert.throws(() => validateRewardsConfig({ pct: 101, mode: "burn", minReturnKoin: "1", pollMinutes: 10 }), /percentage/);
  assert.throws(() => validateRewardsConfig({ pct: 10, mode: "yeet", minReturnKoin: "1", pollMinutes: 10 }), /mode/);
  assert.throws(() => validateRewardsConfig({ pct: 10, mode: "send", minReturnKoin: "1", pollMinutes: 0 }), /interval/);
  assert.throws(() => validateRewardsConfig({ pct: 10, mode: "burn", minReturnKoin: "x", pollMinutes: 10 }), /Invalid amount/);
});
