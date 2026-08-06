"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { computeReturnPlan, validateRewardsConfig } = require("../electron/lib/rewards");

const KOIN = (n) => String(BigInt(n) * 100000000n);

test("no change means no action", () => {
  const plan = computeReturnPlan({ baseline: KOIN(100), current: KOIN(100), pct: 50, minReturnSat: KOIN(1) });
  assert.equal(plan.action, "none");
});

test("balance decrease resets baseline", () => {
  const plan = computeReturnPlan({ baseline: KOIN(100), current: KOIN(90), pct: 50, minReturnSat: KOIN(1) });
  assert.equal(plan.action, "reset");
});

test("small rewards accumulate below the minimum", () => {
  const plan = computeReturnPlan({ baseline: KOIN(100), current: KOIN(101), pct: 50, minReturnSat: KOIN(1) });
  // 1 KOIN of rewards at 50% -> 0.5 KOIN return, below 1 KOIN minimum
  assert.equal(plan.action, "accumulate");
  assert.equal(plan.returnAmount, "50000000");
});

test("returns the configured percentage once above the minimum", () => {
  const plan = computeReturnPlan({ baseline: KOIN(100), current: KOIN(110), pct: 50, minReturnSat: KOIN(1) });
  assert.equal(plan.action, "return");
  assert.equal(plan.delta, KOIN(10));
  assert.equal(plan.returnAmount, KOIN(5));
});

test("fractional percentages work", () => {
  const plan = computeReturnPlan({ baseline: "0", current: KOIN(100), pct: 12.5, minReturnSat: "1" });
  assert.equal(plan.returnAmount, "1250000000");
});

test("zero percent never returns", () => {
  const plan = computeReturnPlan({ baseline: "0", current: KOIN(100), pct: 0, minReturnSat: "1" });
  assert.equal(plan.action, "accumulate");
  assert.equal(plan.returnAmount, "0");
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
