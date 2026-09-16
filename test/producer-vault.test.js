"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const { Signer, Contract, Transaction, utils } = require("koilib");
const { ProducerVault } = require("../electron/lib/producer-vault");
const { NETWORKS, POB_ABI, TOKEN_ABI } = require("../electron/lib/constants");
const QR = require("../ui/qrcode");
function fixture() {
  const owner = Signer.fromSeed("vault owner fixture"), address = owner.getAddress(), hot = utils.encodeBase64url(Signer.fromSeed("node hot fixture").publicKey);
  const sessionId = "a".repeat(24), secret = "b".repeat(43), sent = [];
  let now = Date.now(), mode = "local", producer = null, connected = false, status = "pending", fail = false, network = "mainnet", chainResult = {};
  const chainId = utils.encodeBase64url(new Uint8Array(34).fill(1));
  const provider = { getChainId: async () => chainId, getTransactionsById: async () => chainResult, getBlocksById: async () => ({ block_items: [{ block_height: "1" }] }), getBlocks: async () => [{ block_id: "block" }] };
  const chain = { network: () => ({ id: network }), isValidAddress: value => value === address, provider: () => provider };
  const custody = { config: () => ({ mode, address: producer }), configure: async input => { mode = input.mode; producer = input.address; return custody.config(); },
    requireExternal: () => { if (mode !== "external") throw new Error("external required"); }, hotPublicKey: () => hot,
    operations: async () => {
      const c = new Contract({ id: NETWORKS.mainnet.contracts.pob, abi: POB_ABI });
      const { operation } = await c.functions.register_public_key({ producer: address, public_key: hot }, { onlyOperation: true });
      return { summary: { action: "register", producer: address, publicKey: hot, network }, operations: [operation] };
    } };
  const request = async (route, body) => {
    if (route === "config") return { demo: false, network: "mainnet", features: { kaiProducer: true } };
    if (route === "dapp/create") return { sessionId, secret, expiresAt: now + 1800000, uri: "https://evil.example/" };
    if (route === "dapp/status") return { connected, address: connected ? address : null };
    if (route === "dapp/request") { sent.push(body); if (fail) throw new Error("network lost"); return { requestId: "r".repeat(24), expiresAt: now + 600000 }; }
    if (route === "dapp/request-status") return { status, error: "fixture: insufficient mana", txid: chainResult.transactions?.[0]?.transaction.id || "0x1220" + "1".repeat(64) };
    if (route === "dapp/disconnect") { if (fail) throw new Error("network lost"); connected = false; return {}; }
    throw new Error(route);
  };
  const vault = new ProducerVault({ custody, chain, request, now: () => now });
  return { vault, address, sent, provider, chainId, hot, custody,
    connect: async () => { await vault.connect(); connected = true; await vault.useWallet(); },
    tick: ms => { now += ms; }, fail: v => { fail = v; }, status: v => { status = v; }, network: v => { network = v; }, chainResult: v => { chainResult = v; } };
}

test("Koin Vault pairing uses the fixed wallet URL, bounded QR and explicitly selected producer", async () => {
  const f = fixture(), v = await f.vault.connect();
  const url = new URL(v.uri); assert.equal(url.origin, "https://koinvault.app"); assert.equal(url.searchParams.get("connect").length, 24);
  assert.ok(QR.encode(v.uri).modules.length > 0);
  assert.equal(v.secret, undefined); assert.equal(f.custody.config().mode, "local");
  await assert.rejects(f.vault.useWallet(), /Scan the QR/);
  await assert.rejects(f.vault.connect(), /Disconnect/);
});

test("registration approval preserves operations and requires confirmation; pending requests block producer changes", async () => {
  const f = fixture(); await f.connect();
  const draft = await f.vault.prepare({ action: "register" }); assert.equal(draft.summary.producer, f.address);
  await assert.rejects(f.vault.send({}), /confirm/); assert.equal(f.sent.length, 0);
  await f.vault.send({ confirm: true, draftId: f.vault.draft?.id }); assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].operations.length, 1); assert.equal(f.sent[0].transaction, undefined);
  assert.throws(() => f.vault.guardMutation(), /Finish or cancel/);
  await assert.rejects(f.vault.send({ confirm: true, draftId: f.vault.draft?.id }), /pending/);
  f.status("rejected"); assert.equal((await f.vault.status()).pending.status, "rejected");
  f.vault.guardMutation();
});

test("uncertain delivery and failed disconnect preserve pending approval and prevent retries", async () => {
  const f = fixture(); await f.connect(); await f.vault.prepare({ action: "register" }); f.fail(true);
  await assert.rejects(f.vault.send({ confirm: true, draftId: f.vault.draft?.id }), /network lost/);
  assert.equal(f.vault.view().pending.status, "unknown");
  await assert.rejects(f.vault.disconnect(), /network lost/);
  assert.throws(() => f.vault.guardMutation(), /Finish or cancel/);
  await assert.rejects(f.vault.prepare({ action: "register" }), /existing/);
  assert.equal(f.sent.length, 1);
  f.fail(false); await f.vault.disconnect(); assert.equal(f.vault.view().connected, false); f.vault.guardMutation();
});

test("expired drafts, changed network and lost selected producer cannot request a signature", async () => {
  const f = fixture(); await f.connect(); await f.vault.prepare({ action: "register" });
  f.tick(300001); await assert.rejects(f.vault.send({ confirm: true, draftId: f.vault.draft?.id }), /fresh/);
  await f.vault.prepare({ action: "register" }); f.network("harbinger");
  await assert.rejects(f.vault.send({ confirm: true, draftId: f.vault.draft?.id }), /Mainnet/);
  f.network("mainnet"); await f.custody.configure({ mode: "external", address: "someone else" });
  await assert.rejects(f.vault.send({ confirm: true, draftId: f.vault.draft?.id }), /connected/); assert.equal(f.sent.length, 0);
});

test("wallet submission is checked against canonical chain operations, payee and transaction hash", async () => {
  const f = fixture(); await f.connect(); await f.vault.prepare({ action: "register" }); await f.vault.send({ confirm: true, draftId: f.vault.draft?.id });
  f.status("approved"); assert.equal((await f.vault.status()).pending.status, "submitted");
  // Fresh fixture supplies the response txid along with actual chain data.
  const g = fixture(); await g.connect(); await g.vault.prepare({ action: "register" }); await g.vault.send({ confirm: true, draftId: g.vault.draft?.id });
  const tx = new Transaction({ options: { payer: Signer.fromSeed("sponsor").getAddress(), payee: g.address, rcLimit: "10000000000" } });
  for (const op of g.sent[0].operations) await tx.pushOperation(op);
  await tx.prepare({ chainId: g.chainId, nonce: "KAE=" });
  g.chainResult({ transactions: [{ transaction: tx.transaction, containing_blocks: ["block"] }] }); g.status("approved");
  assert.equal((await g.vault.status()).pending.status, "confirmed");
  const h = fixture(); await h.connect(); await h.vault.prepare({ action: "register" }); await h.vault.send({ confirm: true, draftId: h.vault.draft?.id });
  const altered = structuredClone(tx.transaction); altered.header.payee = Signer.fromSeed("wrong wallet").getAddress(); await Transaction.prepareTransaction(altered);
  h.chainResult({ transactions: [{ transaction: altered, containing_blocks: ["block"] }] }); h.status("approved");
  assert.equal((await h.vault.status()).pending.status, "mismatch");
});

test("a newer prepared operation invalidates an earlier review", async () => {
  const f = fixture(); await f.connect();
  const first = await f.vault.prepare({ action: "register" });
  await f.vault.prepare({ action: "register" });
  await assert.rejects(f.vault.send({ confirm: true, draftId: first.id }), /fresh/);
  assert.equal(f.sent.length, 0);
});

test("older Koin Vault cannot receive unsupported production allowance requests", async () => {
  const f = fixture(); await f.connect();
  await assert.rejects(f.vault.prepare({ action: "productionAllowance", amount: "10" }), /production-allowance update/);
  assert.equal(f.sent.length, 0);
});

test("burn-and-allow refuses older wallet backends before preparing or sending", async () => {
  const f = fixture(); await f.connect();
  await assert.rejects(f.vault.prepare({ action: "burn", amount: "1", allowFullVhp: true }), /burn-and-allow update/);
  assert.equal(f.sent.length, 0);
});

test("failed wallet approvals retain the specific reason and transaction ID", async () => {
 const f = fixture(); await f.connect(); const d = await f.vault.prepare({ action: "register" });
 await f.vault.send({ confirm: true, draftId: d.id }); f.status("failed");
 const v = await f.vault.status();
 assert.match(v.pending.note, /fixture: insufficient mana/);
 assert.match(v.pending.note, /Check wallet history/);
 assert.match(v.pending.txId, /^0x1220/);
 assert.equal(v.pending.status, "failed");
});
