"use strict";

const { ProducerCustody } = require("./producer-custody");
const { ProducerVault } = require("./producer-vault");

// Shared by the IPC handlers: a registration check must not race a custody,
// network or hot-key change. NodeManager keeps its own longer-running lock.
function createProducerRuntime(args) {
  const custody = new ProducerCustody(args);
  const vault = new ProducerVault({ custody, chain: args.chain, request: args.vaultRequest });
  const mutations = new Set([
    "producer:vaultConnect", "producer:vaultUse", "producer:vaultPrepare",
    "producer:vaultSend", "producer:vaultDisconnect", "producer:vaultStatus",
    "producer:configure", "producer:key", "producer:prepare", "producer:broadcast",
    "producer:register", "settings:update", "node:start", "node:stop",
    "node:quickSync", "node:rebuildState", "node:setAutoRecover",
    "chain:burn", "chain:send", "rewards:runNow", "rewards:configure",
    "wallet:create", "wallet:import", "wallet:remove",
  ]);
  let busy = false;
  return {
    custody,
    register(handle) {
      for (const [channel, method] of Object.entries({
        status: "status", configure: "configure", key: "key", prepare: "prepare",
        draft: "savedDraft", broadcast: "broadcast",
      })) handle("producer:" + channel, input => custody[method](input));
      for (const [channel, method] of Object.entries({
        vaultConnect: "connect", vaultStatus: "status", vaultUse: "useWallet",
        vaultPrepare: "prepare", vaultSend: "send", vaultDisconnect: "disconnect",
      })) handle("producer:" + channel, input => vault[method](input));
      handle("producer:balances", async () => {
        const address = custody.config().address;
        return address ? { address, ...await args.chain.balances(address) } : { address: null };
      });
    },
    async invoke(channel, fn, input) {
      if (!mutations.has(channel)) return fn(input);
      if (busy) throw new Error("Wait for the current producer operation to finish.");
      busy = true;
      try {
        if (!channel.startsWith("producer:vault") && channel !== "node:stop") vault.guardMutation();
        return await fn(input);
      } finally { busy = false; }
    },
    async productionAddress(produce) {
      if (!produce) return null;
      const config = custody.config();
      if (config.mode === "unresolved") custody.requireLocal(); // fail closed
      if (config.mode === "external") {
        custody.requireExternal();
        if (config.address === args.wallet.address) throw new Error("External producer key is present in the local wallet. Use a separate cold address.");
        const registration = await custody.status();
        if (!registration.matches) throw new Error(registration.verificationError || "Verify the external producer registration before starting production.");
      }
      if (!config.address) throw new Error("Create a wallet or configure an external producer first to enable block production.");
      return config.address;
    },
  };
}

module.exports = { createProducerRuntime };
