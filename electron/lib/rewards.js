"use strict";

const { parseAmount, percentOf, addSats, subSats, formatAmount } = require("./format");

// Decides what to do given the KOIN balance movement since the last baseline.
// Balance increases on a dedicated producer wallet are block rewards; a
// decrease means the user spent/burned manually, so the baseline resets.
function computeReturnPlan({ baseline, current, pct, minReturnSat }) {
  const delta = subSats(current, baseline);
  if (BigInt(delta) < 0n) {
    return { delta, action: "reset", returnAmount: "0" };
  }
  if (BigInt(delta) === 0n) {
    return { delta, action: "none", returnAmount: "0" };
  }
  const returnAmount = percentOf(delta, pct);
  if (BigInt(returnAmount) < BigInt(minReturnSat) || BigInt(returnAmount) === 0n) {
    return { delta, action: "accumulate", returnAmount };
  }
  return { delta, action: "return", returnAmount };
}

function validateRewardsConfig(cfg) {
  const pct = Number(cfg.pct);
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
    throw new Error("Return percentage must be between 0 and 100");
  }
  if (!["burn", "send"].includes(cfg.mode)) {
    throw new Error("Return mode must be burn or send");
  }
  const poll = Number(cfg.pollMinutes);
  if (!Number.isFinite(poll) || poll < 1 || poll > 24 * 60) {
    throw new Error("Check interval must be between 1 minute and 24 hours");
  }
  parseAmount(cfg.minReturnKoin); // throws when invalid
  return {
    enabled: !!cfg.enabled,
    pct,
    mode: cfg.mode,
    toAddress: String(cfg.toAddress ?? "").trim(),
    minReturnKoin: String(cfg.minReturnKoin),
    pollMinutes: poll,
  };
}

// Periodically checks the producer wallet for new block rewards and returns
// the configured percentage — either burned back to VHP (compounding the
// node's hash power) or sent to a chosen address.
class RewardEngine {
  constructor({ chain, wallet, settings, state, onEvent }) {
    this.chain = chain;
    this.wallet = wallet;
    this.settings = settings;
    this.state = state;
    this.onEvent = onEvent || (() => {});
    this._timer = null;
    this._busy = false;
    this.last = null; // { time, trigger, outcome, detail }
    this.nextRunAt = null;
  }

  config() {
    return this.settings.get("rewards");
  }

  configure(patch) {
    const cfg = validateRewardsConfig({ ...this.config(), ...patch });
    if (cfg.enabled && cfg.mode === "send" && !this.chain.isValidAddress(cfg.toAddress)) {
      throw new Error("Enter a valid Koinos address to send returns to");
    }
    this.settings.set("rewards", cfg);
    this.start();
    return cfg;
  }

  start() {
    this.stop();
    const cfg = this.config();
    if (!cfg.enabled) return;
    const ms = cfg.pollMinutes * 60 * 1000;
    this.nextRunAt = Date.now() + ms;
    this._timer = setInterval(() => {
      this.nextRunAt = Date.now() + ms;
      this.tick("timer").catch(() => {});
    }, ms);
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    this.nextRunAt = null;
  }

  _stateKey(networkId, address) {
    return `rewards.${networkId}.${address}`;
  }

  _readState(key) {
    return this.state.get(key, null) ?? {
      baseline: null,
      totals: { detected: "0", returned: "0" },
      actions: [],
    };
  }

  async tick(trigger = "timer") {
    if (this._busy) return this.status();
    this._busy = true;
    try {
      return await this._tick(trigger);
    } finally {
      this._busy = false;
    }
  }

  async _tick(trigger) {
    const done = (outcome, detail = {}) => {
      this.last = { time: Date.now(), trigger, outcome, ...detail };
      return this.status();
    };
    const cfg = this.config();
    if (!cfg.enabled && trigger === "timer") return done("disabled");
    const ws = this.wallet.status();
    if (!ws.exists) return done("no-wallet");
    if (!ws.unlocked) return done("locked", { message: "Wallet is locked — unlock it so returns can be signed." });

    const networkId = this.chain.network().id;
    const address = ws.address;
    const key = this._stateKey(networkId, address);

    let balances;
    try {
      balances = await this.chain.balances(address);
    } catch (e) {
      return done("rpc-error", { message: String(e.message) });
    }

    const st = this._readState(key);
    if (st.baseline === null) {
      st.baseline = balances.koin;
      this.state.set(key, st);
      return done("baseline-set", {
        message: `Baseline set at ${formatAmount(balances.koin)} KOIN. New rewards are tracked from here.`,
      });
    }

    const plan = computeReturnPlan({
      baseline: st.baseline,
      current: balances.koin,
      pct: cfg.pct,
      minReturnSat: parseAmount(cfg.minReturnKoin),
    });

    if (plan.action === "reset") {
      st.baseline = balances.koin;
      this.state.set(key, st);
      return done("baseline-reset", {
        message: "Balance decreased (manual spend or burn detected) — baseline reset.",
      });
    }
    if (plan.action === "none") return done("no-rewards", { plan });
    if (plan.action === "accumulate") {
      return done("accumulating", {
        plan,
        message: `Pending rewards ${formatAmount(plan.delta)} KOIN — waiting until the return reaches ${cfg.minReturnKoin} KOIN.`,
      });
    }

    // plan.action === "return"
    if (cfg.mode === "send" && !this.chain.isValidAddress(cfg.toAddress)) {
      return done("config-error", { message: "Return mode is `send` but the target address is invalid." });
    }
    let tx;
    try {
      tx =
        cfg.mode === "burn"
          ? await this.chain.burn(this.wallet.signer, plan.returnAmount)
          : await this.chain.transfer(this.wallet.signer, {
              to: cfg.toAddress,
              amountSat: plan.returnAmount,
              token: "koin",
            });
    } catch (e) {
      return done("tx-error", { plan, message: String(e.message) });
    }

    // Refresh the balance after the return so the remainder isn't counted again.
    let newBaseline;
    try {
      newBaseline = (await this.chain.balances(address)).koin;
    } catch {
      newBaseline = subSats(balances.koin, plan.returnAmount);
    }
    st.baseline = newBaseline;
    st.totals.detected = addSats(st.totals.detected, plan.delta);
    st.totals.returned = addSats(st.totals.returned, plan.returnAmount);
    st.actions.unshift({
      time: Date.now(),
      network: networkId,
      mode: cfg.mode,
      rewards: plan.delta,
      amount: plan.returnAmount,
      txId: tx.txId,
      confirmed: tx.confirmed,
    });
    st.actions = st.actions.slice(0, 50);
    this.state.set(key, st);

    const msg =
      cfg.mode === "burn"
        ? `Returned ${formatAmount(plan.returnAmount)} KOIN → VHP (${cfg.pct}% of ${formatAmount(plan.delta)} KOIN rewards)`
        : `Sent ${formatAmount(plan.returnAmount)} KOIN to ${cfg.toAddress} (${cfg.pct}% of ${formatAmount(plan.delta)} KOIN rewards)`;
    this.onEvent({ type: "rewards", message: msg, txId: tx.txId });
    return done("returned", { plan, tx, message: msg });
  }

  status() {
    const cfg = this.config();
    const ws = this.wallet.status();
    const networkId = this.chain.network().id;
    const st = ws.address ? this._readState(this._stateKey(networkId, ws.address)) : null;
    return {
      config: cfg,
      running: !!this._timer,
      nextRunAt: this.nextRunAt,
      last: this.last,
      state: st,
      network: networkId,
      address: ws.address,
    };
  }
}

module.exports = { RewardEngine, computeReturnPlan, validateRewardsConfig };
