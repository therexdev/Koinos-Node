"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const { validateSigned, fresh } = require("../../ui/producer-signer/validation");
const { Signer, Transaction, utils } = require("koilib");
const { parseAmount, cmpSats } = require("./format");
const keyText = value => value ? Buffer.from(value, "base64").toString("base64url") : null;
const settingsHealth = settings => typeof settings.health === "function" ? settings.health() : { ok: true, error: null, recoveredFromBackup: false, backupError: null };
const requireHealthySettings = settings => { const health = settingsHealth(settings); if (!health.ok) throw new Error("Producer custody settings could not be loaded safely. Production and producer wallet actions are disabled until you stop the node and explicitly save the intended custody mode again."); return health; };
const externalMode = settings => { requireHealthySettings(settings); return settings.get("producer.mode", "local") === "external"; };
const producerAddress = (settings, wallet) => externalMode(settings) ? settings.get(`producer.addresses.${settings.get("network", "mainnet")}`, "") : wallet.address;

class ProducerCustody {
  constructor({ settings, state, wallet, chain, nodeMgr, rewards }) { Object.assign(this, { settings, state, wallet, chain, nodeMgr, rewards }); }
  config() { const health = settingsHealth(this.settings); if (!health.ok) return { mode: "unresolved", address: null, localWalletAddress: this.wallet.address || null, settingsHealth: health }; return { mode: externalMode(this.settings) ? "external" : "local", address: producerAddress(this.settings, this.wallet), localWalletAddress: this.wallet.address || null, settingsHealth: health }; }
  requireExternal() { requireHealthySettings(this.settings); if (!externalMode(this.settings)) throw new Error("Select External/cold producer wallet first."); if (!this.chain.isValidAddress(this.config().address)) throw new Error("Set a valid watch-only producer address for this network."); }
  requireLocal() { requireHealthySettings(this.settings); if (externalMode(this.settings)) throw new Error("External producer mode never signs with the local wallet. Use External signing in Node setup."); }
  hotPublicKey() {
    requireHealthySettings(this.settings);
    const pub = keyText(this.nodeMgr.readProducerPublicKey(this.chain.network().id));
    if (!externalMode(this.settings)) return pub;
    const file = path.join(this.nodeMgr.dirs(this.chain.network().id).producerKeyDir, "private.key");
    if (!fs.existsSync(file) && !pub) return null;
    try {
      const signer = Signer.fromWif(fs.readFileSync(file, "utf8").trim());
      if (utils.encodeBase64url(signer.publicKey) === pub) return pub;
    } catch { /* no secret or parser details in UI errors */ }
    throw new Error("Hot key files are missing or inconsistent. Stop the node and use Generate hot key to restore the public file from its private key.");
  }
  async stopped() {
    if (this.rewards._busy) throw new Error("Wait for the current reward operation to finish.");
    const s = await this.nodeMgr.status(this.chain.network().id);
    if (!s.docker?.ok || s.isRunning || s.op?.running || this.nodeMgr._op?.running || this.nodeMgr._desiredRunning) throw new Error("Stop the node and wait for it to finish before changing producer custody or keys. Docker must be available to verify it is stopped.");
  }
  async configure({ mode, address }) {
    if (!["local", "external"].includes(mode)) throw new Error("Choose local or external producer custody.");
    address = String(address || "").trim();
    if (mode === "external" && !this.chain.isValidAddress(address)) throw new Error("Enter a valid watch-only Koinos address.");
    if (mode === "external" && address === this.wallet.address) throw new Error("This address already has a private key in the local local wallet. Choose a separately controlled external address.");
    await this.stopped();
    if (this.rewards._busy) throw new Error("Wait for the current reward operation to finish.");
    const addresses = { ...this.settings.get("producer.addresses", {}), ...(mode === "external" ? { [this.chain.network().id]: address } : {}) };
    // Explicit custody selection repairs an unreadable store. Disable returns
    // before re-enabling any timer, including when switching back to local.
    this.rewards.stop();
    if (this.settings.health?.().ok !== false) this.rewards.configure({ enabled: false });
    this.settings.set("producer", { mode, addresses });
    this.rewards.configure({ enabled: false });
    // Do not report success from in-memory state alone. Re-open the settings
    // file and verify the exact custody selection/address that will be loaded
    // by the next KoinosKit process.
    const { JsonStore } = require("./store");
    const { DEFAULT_SETTINGS } = require("./constants");
    const reread = new JsonStore(this.settings.filePath, DEFAULT_SETTINGS);
    const expectedAddress = mode === "external" ? address : this.wallet.address;
    const persistedMode = reread.get("producer.mode", "local");
    const persistedAddress = mode === "external" ? reread.get(`producer.addresses.${this.chain.network().id}`, "") : this.wallet.address;
    if (!reread.health().ok || persistedMode !== mode || persistedAddress !== expectedAddress) throw new Error("Producer custody could not be verified on disk. Leave the node stopped and save the custody mode again.");
    this.state.set("producerDraft", null);
    return this.config();
  }
  async status() {
    const config = this.config();
    if (config.mode === "unresolved") return { ...config, filePublicKey: null, registeredPublicKey: null, matches: false, verificationError: "Producer custody settings could not be loaded safely. Node production is disabled until custody mode is confirmed again.", keyDirectory: this.nodeMgr.dirs(this.chain.network().id).producerKeyDir };
    const filePublicKey = this.hotPublicKey();
    let registeredPublicKey = null, verificationError = null;
    if (config.address) {
      try { registeredPublicKey = keyText(await this.chain.registeredPublicKey(config.address, { strict: true })); }
      catch { verificationError = "Could not verify registration on-chain. Check the network/RPC and retry."; }
    }
    return { ...config, filePublicKey, registeredPublicKey, matches: !!filePublicKey && filePublicKey === registeredPublicKey && !verificationError, verificationError,
      keyDirectory: this.nodeMgr.dirs(this.chain.network().id).producerKeyDir };
  }
  async key({ rotate = false, confirm = false } = {}) {
    this.requireExternal(); await this.stopped();
    const dir = this.nodeMgr.dirs(this.chain.network().id).producerKeyDir;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const priv = path.join(dir, "private.key"), pub = path.join(dir, "public.key");
    if (rotate && !confirm) throw new Error("Confirm rotation: production needs a new external registration before restarting.");
    let backup = null;
    if (rotate && fs.existsSync(priv)) {
      backup = path.join(dir, "key-backup-" + Date.now() + "-" + crypto.randomBytes(4).toString("hex"));
      fs.mkdirSync(backup, { mode: 0o700 });
      fs.copyFileSync(priv, path.join(backup, "private.key")); fs.chmodSync(path.join(backup, "private.key"), 0o600);
      if (fs.existsSync(pub)) fs.copyFileSync(pub, path.join(backup, "public.key"));
      fs.unlinkSync(priv);
    }
    if (!fs.existsSync(priv)) {
      const signer = new Signer({ privateKey: crypto.randomBytes(32) });
      fs.writeFileSync(priv, signer.getPrivateKey("wif") + "\n", { flag: "wx", mode: 0o600 });
    }
    const signer = Signer.fromWif(fs.readFileSync(priv, "utf8").trim());
    const publicKey = utils.encodeBase64url(signer.publicKey);
    fs.writeFileSync(pub, publicKey + "\n", { mode: 0o600 });
    this.state.set("producerDraft", null);
    return { publicKey, keyDirectory: dir, backupDirectory: backup };
  }
  async operations({ action, amount, to, token = "koin", useFullBalance = false, allowFullVhp = false }) {
    this.requireExternal();
    const { address } = this.config(), network = this.chain.network().id;
    const provider = this.chain.provider();
    const tx = new Transaction({ provider });
    const summary = { action, producer: address, network };
    if (action === "register") {
      const publicKey = this.hotPublicKey();
      if (!publicKey) throw new Error("Generate the hot production key first.");
      const pob = await this.chain._contract("pob", { provider });
      await tx.pushOperation(pob.functions.register_public_key, { producer: address, public_key: publicKey });
      summary.publicKey = publicKey;
    } else if (action === "productionAllowance") {
      if (network !== "mainnet") throw new Error("Production allowance currently supports Mainnet only.");
      const balances = await this.chain.balances(address);
      const amountSat = useFullBalance === true ? balances.vhp : parseAmount(amount);
      if (cmpSats(amountSat, "0") < 0) throw new Error("Allowance cannot be negative.");
      if (cmpSats(amountSat, balances.vhp) > 0) throw new Error("Choose a VHP allowance no larger than your current VHP balance.");
      const vhp = await this.chain._contract("vhp", { provider }), addrs = await this.chain.resolveContracts();
      // Probe support before preparing any approval. Never fall back to changing
      // account authority or giving the hot key permission to move tokens.
      const result = await vhp.functions.allowance({ owner: address, spender: addrs.pob });
      if (!/^(0|[1-9][0-9]*)$/.test(String(result.result?.value ?? ""))) throw new Error("Could not verify VHP allowance support on this network.");
      await tx.pushOperation(vhp.functions.approve, { owner: address, spender: addrs.pob, value: amountSat });
      Object.assign(summary, { amount: utils.formatUnits(amountSat, 8), token: "vhp", spender: addrs.pob });
    } else if (action === "burn" || action === "transfer") {
      const amountSat = parseAmount(amount);
      if (cmpSats(amountSat, "0") <= 0) throw new Error("Amount must be positive.");
      if (!["koin", "vhp"].includes(token)) throw new Error("Choose KOIN or VHP.");
      const balances = await this.chain.balances(address);
      if (cmpSats(amountSat, balances[action === "burn" ? "koin" : token]) > 0) throw new Error("Insufficient balance.");
      Object.assign(summary, { amount: String(amount), token: action === "burn" ? "koin" : token, to: action === "burn" ? address : to });
      if (action === "burn") {
        this.chain._assertMana(amountSat, balances.mana, "burn");
        const pob = await this.chain._contract("pob", { provider });
        if (await this.chain._isAllowanceToken(provider)) {
          const koin = await this.chain._contract("koin", { provider }), addrs = await this.chain.resolveContracts();
          await tx.pushOperation(koin.functions.approve, { owner: address, spender: addrs.pob, value: amountSat });
        }
        await tx.pushOperation(pob.functions.burn, { token_amount: amountSat, burn_address: address, vhp_address: address });
        if (allowFullVhp === true) {
          if (network !== "mainnet") throw new Error("Production allowance currently supports Mainnet only.");
          const total = BigInt(balances.vhp) + BigInt(amountSat);
          if (total >= 18446744073709551615n) throw new Error("VHP allowance exceeds the supported limit.");
          const vhp = await this.chain._contract("vhp", { provider }), addrs = await this.chain.resolveContracts();
          const result = await vhp.functions.allowance({ owner: address, spender: addrs.pob });
          if (!/^(0|[1-9][0-9]*)$/.test(String(result.result?.value ?? ""))) throw new Error("Could not verify VHP allowance support on this network.");
          await tx.pushOperation(vhp.functions.approve, { owner: address, spender: addrs.pob, value: total.toString() });
          summary.productionAllowance = utils.formatUnits(total.toString(), 8);
          summary.spender = addrs.pob;
        }
      } else {
        if (!this.chain.isValidAddress(to)) throw new Error("Invalid recipient address.");
        if (token === "koin") this.chain._assertMana(amountSat, balances.mana, "send");
        const contract = await this.chain._contract(token, { provider });
        await tx.pushOperation(contract.functions.transfer, { from: address, to, value: amountSat });
      }
    } else throw new Error("Choose register, burn or transfer.");
    return { summary, operations: tx.transaction.operations };
  }
  savedDraft() {
    this.requireExternal();
    const draft = this.state.get("producerDraft", null);
    fresh(draft);
    if (draft.summary.network !== this.chain.network().id || draft.summary.producer !== this.config().address) throw new Error("Producer or network changed. Prepare a new draft.");
    if (draft.summary.action === "register" && draft.summary.publicKey !== this.hotPublicKey()) throw new Error("The hot key changed. Prepare a new registration.");
    return structuredClone(draft);
  }
  async prepare(input) {
    const { summary, operations } = await this.operations(input);
    const provider = this.chain.provider(), rcLimit = await this.chain._rcLimit(provider, summary.producer);
    const tx = new Transaction({ provider, options: { payer: summary.producer, rcLimit } });
    for (const op of operations) await tx.pushOperation(op);
    await tx.prepare();
    const createdAt = Date.now(), offline = input.offlineSigning === true;
    const draft = { format: "kai-producer-transaction-v1", createdAt, signingWindow: offline ? "offline-24h" : "standard-15m", expiresAt: createdAt + (offline ? 24 * 60 : 15) * 60000, summary, transaction: tx.transaction };
    this.state.set("producerDraft", draft);
    return draft;
  }
  async broadcast({ transaction, confirm }) {
    this.requireExternal();
    if (confirm !== true) throw new Error("Review and confirm the signed transaction before broadcasting.");
    const draft = this.state.get("producerDraft", null);
    if (!draft || draft.expiresAt < Date.now()) throw new Error("The draft expired. Prepare and sign a fresh transaction.");
    if (draft.summary.network !== this.chain.network().id || draft.summary.producer !== this.config().address) throw new Error("Producer or network changed. Prepare a new draft.");
    transaction = await validateSigned(draft, transaction);
    if (draft.summary.action === "register" && draft.summary.publicKey !== this.hotPublicKey()) throw new Error("The hot key changed. Prepare a new registration.");
    const provider = this.chain.provider();
    if (await provider.getChainId() !== transaction.header.chain_id || await provider.getNextNonce(this.config().address) !== transaction.header.nonce) throw new Error("Network or account nonce changed. Prepare a new draft.");
    // Recheck after asynchronous validation; two clicks must never submit twice.
    const current = this.state.get("producerDraft", null);
    if (!current || current.transaction.id !== draft.transaction.id || current.expiresAt !== draft.expiresAt || current.expiresAt <= Date.now() || this.config().mode !== "external" || this.config().address !== draft.summary.producer || this.chain.network().id !== draft.summary.network) throw new Error("The draft changed or expired. Prepare a fresh transaction.");
    if (draft.summary.action === "register" && draft.summary.publicKey !== this.hotPublicKey()) throw new Error("The hot key changed. Prepare a new registration.");
    this.state.set("producerDraft", null);
    const tx = new Transaction({ provider, transaction });
    await tx.send();
    return { txId: transaction.id, confirmed: false, note: "Submitted. Verify confirmation in the explorer; registration must be checked on-chain before starting production." };
  }
}
module.exports = { ProducerCustody, externalMode, producerAddress, requireHealthySettings };
