"use strict";

const { Provider, Contract, utils } = require("koilib");
const { NETWORKS, POB_ABI, TOKEN_ABI } = require("./constants");
const { cmpSats } = require("./format");

const RC_LIMIT_CAP = 1000000000n; // never ask for more than 10 KOIN of mana
const MIN_MANA = 5000000n;        // refuse to send with < 0.05 KOIN of mana
const WAIT_TIMEOUT_MS = 60000;

function rpcError(e) {
  let msg = String(e?.message ?? e ?? "RPC error");
  // koilib sometimes surfaces raw JSON errors; extract the useful part.
  try {
    const parsed = JSON.parse(msg);
    msg = parsed?.error?.message ?? parsed?.message ?? msg;
  } catch {
    /* not JSON */
  }
  return new Error(msg);
}

const CONTRACT_NAMES = ["koin", "vhp", "pob"];
const RESOLVE_TTL_MS = 60 * 60 * 1000;

class ChainService {
  constructor(settings) {
    this.settings = settings;
    this._resolved = {}; // { [networkId]: { addrs, at } }
  }

  clearCache() {
    this._resolved = {};
  }

  // The canonical KOIN/VHP/PoB addresses can change (the token contracts have
  // migrated on mainnet before), so ask the chain via the
  // get_contract_address system call and fall back to the vendored addresses.
  async resolveContracts() {
    const net = this.network();
    const cached = this._resolved[net.id];
    if (cached && Date.now() - cached.at < RESOLVE_TTL_MS) return cached.addrs;
    const provider = this.provider();
    const addrs = { ...net.contracts };
    await Promise.all(
      CONTRACT_NAMES.map(async (name) => {
        try {
          const r = await provider.invokeGetContractAddress(name);
          const a = r?.value?.address;
          if (a && this.isValidAddress(a)) addrs[name] = a;
        } catch {
          /* keep fallback address */
        }
      })
    );
    this._resolved[net.id] = { addrs, at: Date.now() };
    return addrs;
  }

  network() {
    return NETWORKS[this.settings.get("network", "mainnet")] ?? NETWORKS.mainnet;
  }

  rpcUrls() {
    const net = this.network();
    const custom = this.settings.get(`customRpc.${net.id}`, "");
    if (custom && /^https?:\/\//.test(custom)) return [custom];
    return net.rpcUrls.length > 0 ? net.rpcUrls : [net.localRpcUrl];
  }

  provider(urls) {
    return new Provider(urls ?? this.rpcUrls());
  }

  isValidAddress(address) {
    try {
      return utils.isChecksumAddress(String(address).trim());
    } catch {
      return false;
    }
  }

  async _contract(kind, { signer, provider } = {}) {
    const p = provider ?? this.provider();
    const addrs = await this.resolveContracts();
    if (signer) signer.provider = p;
    // TOKEN_ABI/POB_ABI are vendored from the chain's contract meta store —
    // koilib's bundled tokenAbi trips protobufjs 7.x extension resolution.
    return new Contract({
      id: addrs[kind],
      abi: kind === "pob" ? POB_ABI : TOKEN_ABI,
      provider: p,
      signer,
    });
  }

  async balances(address) {
    const provider = this.provider();
    try {
      const [koin, vhp] = await Promise.all([
        this._contract("koin", { provider }),
        this._contract("vhp", { provider }),
      ]);
      const [k, v, rc] = await Promise.all([
        koin.functions.balance_of({ owner: address }),
        vhp.functions.balance_of({ owner: address }),
        provider.getAccountRc(address).catch(() => "0"),
      ]);
      return {
        koin: k?.result?.value ?? "0",
        vhp: v?.result?.value ?? "0",
        mana: rc ?? "0",
      };
    } catch (e) {
      throw rpcError(e);
    }
  }

  async headInfo(urls) {
    try {
      const head = await this.provider(urls).getHeadInfo();
      return {
        height: Number(head.head_topology?.height ?? 0),
        lastIrreversible: Number(head.last_irreversible_block ?? 0),
        headBlockTimeMs: Number(head.head_block_time ?? 0),
      };
    } catch (e) {
      throw rpcError(e);
    }
  }

  // Compares the local node's head with public RPC (when available) and with
  // wall-clock time to report sync progress.
  async syncStatus() {
    const net = this.network();
    const [local, remote] = await Promise.all([
      this.headInfo([net.localRpcUrl]).catch((e) => ({ error: String(e.message) })),
      net.rpcUrls.length > 0
        ? this.headInfo(net.rpcUrls).catch(() => null)
        : Promise.resolve(null),
    ]);
    const out = { local, remote, inSync: false, progressPct: null };
    if (!local.error) {
      out.inSync = Date.now() - local.headBlockTimeMs < 60000;
      if (remote && remote.height > 0) {
        out.progressPct = Math.min(100, (local.height / remote.height) * 100);
      } else if (out.inSync) {
        out.progressPct = 100;
      }
    }
    return out;
  }

  async _rcLimit(provider, address) {
    let rc = 0n;
    try {
      rc = BigInt((await provider.getAccountRc(address)) || "0");
    } catch {
      /* treated as zero */
    }
    if (rc < MIN_MANA) {
      throw new Error(
        "Not enough mana to send a transaction. Keep some liquid KOIN in the wallet and let mana recharge."
      );
    }
    return (rc < RC_LIMIT_CAP ? rc : RC_LIMIT_CAP).toString();
  }

  async _finalize(transaction) {
    const out = { txId: transaction.id, confirmed: false, blockNumber: null };
    try {
      const { blockNumber } = await transaction.wait("by_block", WAIT_TIMEOUT_MS);
      out.confirmed = true;
      out.blockNumber = blockNumber ?? null;
    } catch {
      out.note = "Transaction submitted; confirmation timed out. Check the explorer.";
    }
    return out;
  }

  // Burn KOIN belonging to `signer` and credit VHP to the same address
  // (or `vhpAddress` when given) via the PoB contract.
  async burn(signer, amountSat, { vhpAddress } = {}) {
    const address = signer.getAddress();
    if (cmpSats(amountSat, "0") <= 0) throw new Error("Burn amount must be positive");
    const { koin } = await this.balances(address);
    if (cmpSats(amountSat, koin) > 0) throw new Error("Insufficient KOIN balance");
    const provider = this.provider();
    const rcLimit = await this._rcLimit(provider, address);
    const pob = await this._contract("pob", { signer, provider });
    try {
      const { transaction } = await pob.functions.burn(
        {
          token_amount: String(amountSat),
          burn_address: address,
          vhp_address: vhpAddress || address,
        },
        { rcLimit }
      );
      return await this._finalize(transaction);
    } catch (e) {
      throw rpcError(e);
    }
  }

  async transfer(signer, { to, amountSat, token = "koin" }) {
    const address = signer.getAddress();
    if (!["koin", "vhp"].includes(token)) throw new Error(`Unknown token: ${token}`);
    if (!this.isValidAddress(to)) throw new Error("Invalid recipient address");
    if (cmpSats(amountSat, "0") <= 0) throw new Error("Amount must be positive");
    const balances = await this.balances(address);
    if (cmpSats(amountSat, balances[token]) > 0) {
      throw new Error(`Insufficient ${token.toUpperCase()} balance`);
    }
    const provider = this.provider();
    const rcLimit = await this._rcLimit(provider, address);
    const contract = await this._contract(token, { signer, provider });
    try {
      const { transaction } = await contract.functions.transfer(
        { from: address, to: String(to).trim(), value: String(amountSat) },
        { rcLimit }
      );
      return await this._finalize(transaction);
    } catch (e) {
      throw rpcError(e);
    }
  }

  // Registers the node's block-signing public key (base64url, as written by
  // the block producer to public.key) to the producer address.
  async registerProducerKey(signer, publicKeyB64url) {
    const producer = signer.getAddress();
    if (!publicKeyB64url) throw new Error("Missing block producer public key");
    const provider = this.provider();
    const rcLimit = await this._rcLimit(provider, producer);
    const pob = await this._contract("pob", { signer, provider });
    try {
      const { transaction } = await pob.functions.register_public_key(
        { producer, public_key: String(publicKeyB64url).trim() },
        { rcLimit }
      );
      return await this._finalize(transaction);
    } catch (e) {
      throw rpcError(e);
    }
  }

  async registeredPublicKey(producer) {
    try {
      const pob = await this._contract("pob");
      // Reverts with "given address has no public key record" when unset.
      const res = await pob.functions.get_public_key({ producer });
      return res?.result?.value ?? null;
    } catch {
      return null;
    }
  }
}

module.exports = { ChainService };
