"use strict";

const { parseAmount, percentOf, addSats, subSats, cmpSats, formatAmount } = require("./format");

// Given the real block rewards earned since auto-returns were enabled, decide
// how much to return now. Pure and unit-tested. Everything is in satoshis.
//
//   returnable  = rewards actually minted to the wallet from producing blocks,
//                 since the engine was enabled (NOT balance deltas — so
//                 deposits and manual burns never count as "rewards").
//   desired     = returnable * pct
//   pending     = desired - already returned
function computeReturn({ rewardsSinceEnable, returnedSoFar, pct, minReturnSat, availableLiquidSat }) {
  const returnable = cmpSats(rewardsSinceEnable, "0") > 0 ? rewardsSinceEnable : "0";
  const desired = percentOf(returnable, pct);
  let pending = subSats(desired, returnedSoFar);
  if (cmpSats(pending, "0") < 0) pending = "0";

  if (cmpSats(pending, minReturnSat) < 0 || cmpSats(pending, "0") === 0) {
    return { action: "accumulate", returnAmount: "0", desired, pending };
  }
  // Never return more liquid KOIN than is available above the mana buffer.
  const amount = cmpSats(pending, availableLiquidSat) <= 0 ? pending : availableLiquidSat;
  if (cmpSats(amount, minReturnSat) < 0) {
    return { action: "insufficient-liquid", returnAmount: "0", desired, pending };
  }
  return { action: "return", returnAmount: amount, desired, pending };
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

// Periodically compounds/sends the configured percentage of the block rewards
// the node actually earns. Rewards are read from on-chain block-reward events
// (via ProducerStats) — the same source the Dashboard uses — so the two always
// agree, and deposits or manual burns are never mistaken for rewards.
class RewardEngine {
  constructor({ chain, wallet, settings, state, stats, onEvent }) {
    this.chain = chain;
    this.wallet = wallet;
    this.settings = settings;
    this.state = state;
    this.stats = stats;
    this.onEvent = onEvent || (() => {});
    this._timer = null;
    this._busy = false;
    this.last = null;
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
    return `returns.${networkId}.${address}`;
  }

  _readState(key) {
    return (
      this.state.get(key, null) ?? {
        anchor: null,          // lifetime rewards (sat) when auto-returns began
        returned: "0",         // KOIN returned since then
        lifetimeRewards: "0",  // last-seen lifetime rewards, for display
        actions: [],
      }
    );
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

    const networkId = this.chain.network().id;
    const address = ws.address;
    const key = this._stateKey(networkId, address);

    // Real block rewards come from ProducerStats (on-chain reward events).
    let statsRes;
    try {
      statsRes = await this.stats.refresh(address);
    } catch (e) {
      return done("rpc-error", { message: String(e.message) });
    }
    if (!statsRes || statsRes.available === false) {
      return done("history-unavailable", {
        message: "Block-reward history isn't available on this network's RPC, so returns can't run here.",
      });
    }
    if (statsRes.syncing) {
      return done("syncing", { message: "Reading reward history… returns resume once it's caught up." });
    }

    const st = this._readState(key);
    st.lifetimeRewards = statsRes.totals.rewards;

    // Anchor on first run: only rewards earned from here forward are returned.
    if (st.anchor === null) {
      st.anchor = statsRes.totals.rewards;
      this.state.set(key, st);
      return done("anchored", {
        message: `Tracking rewards from now (lifetime so far: ${formatAmount(st.anchor)} KOIN). New block rewards will be returned.`,
      });
    }

    const rewardsSinceEnable = cmpSats(st.lifetimeRewards, st.anchor) > 0
      ? subSats(st.lifetimeRewards, st.anchor)
      : "0";

    let balances;
    try {
      balances = await this.chain.balances(address);
    } catch (e) {
      this.state.set(key, st);
      return done("rpc-error", { message: String(e.message) });
    }
    const keep = parseAmount(this.settings.get("keepLiquidKoin", "10"));
    const availableLiquid = cmpSats(balances.koin, keep) > 0 ? subSats(balances.koin, keep) : "0";

    const plan = computeReturn({
      rewardsSinceEnable,
      returnedSoFar: st.returned,
      pct: cfg.pct,
      minReturnSat: parseAmount(cfg.minReturnKoin),
      availableLiquidSat: availableLiquid,
    });
    this.state.set(key, st); // persist refreshed lifetimeRewards

    if (plan.action === "accumulate") {
      return done("accumulating", {
        plan,
        message: cmpSats(plan.pending, "0") > 0
          ? `Pending return ${formatAmount(plan.pending)} KOIN — waiting until it reaches ${cfg.minReturnKoin} KOIN.`
          : "No new rewards to return yet.",
      });
    }
    if (plan.action === "insufficient-liquid") {
      return done("insufficient-liquid", {
        plan,
        message: `Return of ${formatAmount(plan.pending)} KOIN is pending, but not enough liquid KOIN is free above your ${formatAmount(keep)} mana buffer.`,
      });
    }

    // plan.action === "return" — needs a signer.
    if (!ws.unlocked) {
      return done("locked", { plan, message: "Unlock the wallet so the pending return can be signed." });
    }
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

    st.returned = addSats(st.returned, plan.returnAmount);
    st.actions.unshift({
      time: Date.now(),
      network: networkId,
      mode: cfg.mode,
      amount: plan.returnAmount,
      txId: tx.txId,
      confirmed: tx.confirmed,
    });
    st.actions = st.actions.slice(0, 50);
    this.state.set(key, st);

    const msg =
      cfg.mode === "burn"
        ? `Compounded ${formatAmount(plan.returnAmount)} KOIN → VHP (${cfg.pct}% of block rewards)`
        : `Sent ${formatAmount(plan.returnAmount)} KOIN to ${cfg.toAddress} (${cfg.pct}% of block rewards)`;
    this.onEvent({ type: "rewards", message: msg, txId: tx.txId });
    return done("returned", { plan, tx, message: msg });
  }

  status() {
    const cfg = this.config();
    const ws = this.wallet.status();
    const networkId = this.chain.network().id;
    const st = ws.address ? this._readState(this._stateKey(networkId, ws.address)) : null;

    let derived = null;
    if (st) {
      const rewardsSinceEnable =
        st.anchor == null
          ? "0"
          : cmpSats(st.lifetimeRewards, st.anchor) > 0
            ? subSats(st.lifetimeRewards, st.anchor)
            : "0";
      const desired = percentOf(rewardsSinceEnable, cfg.pct);
      let pending = subSats(desired, st.returned);
      if (cmpSats(pending, "0") < 0) pending = "0";
      derived = {
        anchored: st.anchor != null,
        lifetimeRewards: st.lifetimeRewards,
        rewardsSinceEnable,
        returned: st.returned,
        pending,
        actions: st.actions,
      };
    }
    return {
      config: cfg,
      running: !!this._timer,
      nextRunAt: this.nextRunAt,
      last: this.last,
      derived,
      network: networkId,
      address: ws.address,
    };
  }
}

module.exports = { RewardEngine, computeReturn, validateRewardsConfig };
