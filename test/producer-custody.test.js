"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path");
const { Signer, Transaction, utils } = require("koilib");
const { JsonStore } = require("../electron/lib/store");
const { DEFAULT_SETTINGS, NETWORKS, POB_ABI, TOKEN_ABI } = require("../electron/lib/constants");
const { inspectDraft } = require("../ui/producer-signer/validation");
const { ChainService } = require("../electron/lib/chain");
const { NodeManager } = require("../electron/lib/node-manager");
const { RewardEngine } = require("../electron/lib/rewards");
const { ProducerCustody } = require("../electron/lib/producer-custody");
const { buildChannels } = require("./helpers/ipc");
const { inspect } = require("../scripts/sign-producer-transaction");
function fixture(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-cold-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const settings = new JsonStore(path.join(dir, "settings.json"), DEFAULT_SETTINGS), state = new JsonStore(path.join(dir, "state.json"));
  const owner = Signer.fromSeed("cold test owner"), local = Signer.fromSeed("unrelated earning wallet");
  const wallet = { address: local.getAddress(), status: () => ({ exists: true, unlocked: true, address: local.getAddress() }), get signer() { throw new Error("LOCAL SIGNER ACCESSED"); }, signerFor() { throw new Error("LOCAL SIGNER ACCESSED"); } };
  const chain = new ChainService(settings), calls = [];
  const provider = { getAccountRc: async () => "10000000000", getChainId: async () => utils.encodeBase64url(new Uint8Array(34).fill(1)), getNextNonce: async () => "KAE=", sendTransaction: async tx => { calls.push(tx); return { transaction: tx, receipt: {} }; } };
  chain.provider = () => provider; chain.resolveContracts = async () => NETWORKS.mainnet.contracts;
  chain._isAllowanceToken = async () => true;
  chain.balances = async () => ({ koin: "10000000000", vhp: "10000000000", mana: "10000000000" });
  let registered = null;
  chain.registeredPublicKey = async () => registered;
  const nodeMgr = new NodeManager({ dataRoot: dir, templateRoot: path.join(__dirname, "../node-template") });
  nodeMgr.status = async () => ({ docker: { ok: true }, isRunning: false }); nodeMgr.dockerInfo = async () => ({ ok: true });
  nodeMgr.start = async (network, address) => ({ network, address });
  const rewards = new RewardEngine({ settings, state, chain, wallet, stats: { refresh() { throw new Error("REWARD READ IN COLD MODE"); } } });
  t.after(() => rewards.stop());
  const args = { settings, state, chain, wallet, nodeMgr, rewards, ...overrides };
  const custody = new ProducerCustody(args);
  const channels = buildChannels({ ...args, setup: { optimizeWslMemory: async () => {} }, stats: {}, userData: dir, appVersion: "test" });
  return { ...args, dir, owner, custody, channels, provider, calls, registered: value => { registered = value; } };
}
test("external producer setup, restart, rotation and host files never need the cold private key", async t => {
  const f = fixture(t), address = f.owner.getAddress();
  await f.custody.configure({ mode: "external", address });
  const made = await f.custody.key();
  assert.equal(f.custody.config().localWalletAddress, f.wallet.address);
  assert.notEqual(address, f.wallet.address);
  await assert.rejects(f.channels.get("node:start")({ produce: true }), /registration/);
  f.registered(made.publicKey);
  assert.equal((await f.channels.get("node:start")({ produce: true })).address, address);
  const restarted = new ProducerCustody({ ...f, settings: new JsonStore(path.join(f.dir, "settings.json")), state: new JsonStore(path.join(f.dir, "state.json")) });
  assert.equal((await restarted.status()).matches, true);
  assert.equal((await restarted.key()).publicKey, made.publicKey);
  const rotated = await restarted.key({ rotate: true, confirm: true });
  assert.notEqual(rotated.publicKey, made.publicKey);
  assert.ok(fs.existsSync(path.join(rotated.backupDirectory, "private.key")));
  assert.equal((await restarted.status()).matches, false);
  await assert.rejects(f.channels.get("node:start")({ produce: true }), /registration/);
  f.registered(rotated.publicKey);
  assert.equal((await restarted.status()).matches, true);
  for (const file of fs.readdirSync(f.dir, { recursive: true }).map(p => path.join(f.dir, p)).filter(p => fs.statSync(p).isFile())) {
    const content = fs.readFileSync(file, "utf8");
    assert.ok(!content.includes(f.owner.getPrivateKey("wif")) && !content.includes(f.owner.getPrivateKey()), file);
  }
});
test("local wallet sends remain separate from the external producer", async t => {
  const f = fixture(t);
  await f.custody.configure({ mode: "external", address: f.owner.getAddress() });
  const signer = Signer.fromSeed("unrelated earning wallet");
  Object.defineProperty(f.wallet, "signer", { get: () => signer });
  f.chain.transfer = async (actual, input) => {
    assert.equal(actual.getAddress(), f.wallet.address);
    assert.notEqual(actual.getAddress(), f.owner.getAddress());
    assert.equal(input.amountSat, "100000000");
    return { txId: "fixture-local-transfer" };
  };
  await f.channels.get("chain:send")({ to: f.owner.getAddress(), amount: "1", token: "koin" });
});
test("cold producer refuses local signing and disables even previously configured automatic funds operations", async t => {
  const f = fixture(t);
  await f.custody.configure({ mode: "external", address: f.owner.getAddress() });
  for (const channel of ["chain:burn", "producer:register", "rewards:runNow"]) await assert.rejects(async () => f.channels.get(channel)({ amount: "1", token: "koin", to: f.wallet.address }), /External producer/);
  assert.throws(() => f.rewards.configure({ enabled: true }), /disabled/);
  f.settings.set("rewards.enabled", true); f.rewards.start();
  assert.equal(f.rewards.status().running, false);
  assert.equal((await f.rewards.tick("manual")).last.outcome, "external-wallet");
  await assert.rejects(f.custody.configure({ mode: "external", address: f.wallet.address }), /already has a private key/);
  f.nodeMgr._desiredRunning = true;
  await assert.rejects(f.custody.key({ rotate: true, confirm: true }), /Stop the node/);
  f.nodeMgr._desiredRunning = false;
  f.nodeMgr.status = async () => ({ docker: { ok: true }, isRunning: true });
  await assert.rejects(f.custody.key({ rotate: true, confirm: true }), /Stop the node/);
});
test("external registration, KCS-4 burn and KOIN/VHP transfers prepare, decode, sign offline and broadcast only exact producer-signed drafts", async t => {
  const f = fixture(t); await f.custody.configure({ mode: "external", address: f.owner.getAddress() }); await f.custody.key();
  for (const input of [{ action: "register" }, { action: "burn", amount: "1" }, { action: "transfer", token: "koin", amount: "1", to: f.wallet.address }, { action: "transfer", token: "vhp", amount: "1", to: f.wallet.address }]) {
    const draft = await f.custody.prepare(input);
    assert.equal(f.calls.length, 0);
    const review = await inspect(draft);
    assert.equal(review.payer, f.owner.getAddress());
    assert.equal(review.operations.length, input.action === "burn" ? 2 : 1);
    const signed = await f.owner.signTransaction(structuredClone(draft.transaction));
    const mutated = structuredClone(signed); mutated.header.rc_limit = "1";
    await assert.rejects(f.custody.broadcast({ transaction: mutated, confirm: true }), /differs/);
    await assert.rejects(f.custody.broadcast({ transaction: signed, confirm: false }), /confirm/);
    const wrong = await Signer.fromSeed("wrong key").signTransaction(structuredClone(draft.transaction));
    await assert.rejects(f.custody.broadcast({ transaction: wrong, confirm: true }), /does not belong/);
    const result = await f.custody.broadcast({ transaction: signed, confirm: true });
    assert.equal(result.txId, signed.id); assert.equal(f.calls.length, 1); f.calls.length = 0;
    await assert.rejects(f.custody.broadcast({ transaction: signed, confirm: true }), /expired/);
  }
});
test("failed chain reads, changed nonce, expiry and changed network never authorize external production or broadcast", async t => {
  const f = fixture(t); await f.custody.configure({ mode: "external", address: f.owner.getAddress() }); await f.custody.key();
  f.chain.registeredPublicKey = async () => { throw new Error("RPC unavailable"); };
  assert.match((await f.custody.status()).verificationError, /Could not verify/);
  await assert.rejects(f.channels.get("node:start")({ produce: true }), /Could not verify/);
  const d = await f.custody.prepare({ action: "register" }), signed = await f.owner.signTransaction(structuredClone(d.transaction));
  f.provider.getNextNonce = async () => "KAI=";
  await assert.rejects(f.custody.broadcast({ transaction: signed, confirm: true }), /nonce changed/);
  f.state.set("producerDraft.expiresAt", 1);
  await assert.rejects(f.custody.broadcast({ transaction: signed, confirm: true }), /expired/);
  assert.equal(f.calls.length, 0);
});

test("Kondor can lower mana for registration, burn and both transfers; review ignores untrusted summary", async t => {
  const f = fixture(t); await f.custody.configure({ mode: "external", address: f.owner.getAddress() }); await f.custody.key();
  for (const input of [{ action: "register" }, { action: "burn", amount: "1" }, { action: "transfer", token: "koin", amount: "1", to: f.wallet.address }, { action: "transfer", token: "vhp", amount: "1", to: f.wallet.address }]) {
    const draft = await f.custody.prepare(input);
    const untrusted = structuredClone(draft); untrusted.summary = { action: "safe", amount: "0", producer: "someone else" };
    const review = await inspectDraft(untrusted, { chainId: await f.provider.getChainId(), contracts: NETWORKS.mainnet.contracts, pobAbi: POB_ABI, tokenAbi: TOKEN_ABI });
    assert.equal(review.action, input.action); assert.equal(review.payer, f.owner.getAddress());
    const tx = structuredClone(draft.transaction); tx.header.rc_limit = "5000000";
    await Transaction.prepareTransaction(tx); await f.owner.signTransaction(tx);
    assert.notEqual(tx.id, draft.transaction.id);
    assert.equal((await f.custody.broadcast({ transaction: tx, confirm: true })).txId, tx.id);
    assert.equal(f.calls.at(-1).header.rc_limit, "5000000");
  }
});

test("even valid owner signatures cannot change operations, headers, payer, nonce, network or exceed mana cap", async t => {
  const f = fixture(t); await f.custody.configure({ mode: "external", address: f.owner.getAddress() }); await f.custody.key();
  const draft = await f.custody.prepare({ action: "burn", amount: "1" });
  const other = await f.custody.prepare({ action: "transfer", amount: "2", to: f.wallet.address });
  f.state.set("producerDraft", draft);
  const mutations = [
    tx => { tx.header.rc_limit = "1000000001"; },
    tx => { tx.header.payer = f.wallet.address; },
    tx => { tx.header.payee = f.owner.getAddress(); },
    tx => { tx.header.chain_id = utils.encodeBase64url(new Uint8Array(34).fill(2)); },
    tx => { tx.header.nonce = "KAI="; },
    tx => { tx.operations = other.transaction.operations; },
    tx => { tx.operations.reverse(); },
    tx => { tx.operations.pop(); },
    tx => { tx.operations[0].call_contract.contract_id = f.wallet.address; },
  ];
  for (const mutate of mutations) {
    const tx = structuredClone(draft.transaction); mutate(tx); await Transaction.prepareTransaction(tx); await f.owner.signTransaction(tx);
    await assert.rejects(f.custody.broadcast({ transaction: tx, confirm: true }));
  }
  for (const value of ["0", "-1", "01", "1e6", "18446744073709551616", 5000000, null]) {
    const tx = await f.owner.signTransaction(structuredClone(draft.transaction)); tx.header.rc_limit = value;
    await assert.rejects(f.custody.broadcast({ transaction: tx, confirm: true }));
  }
  const tx = await f.owner.signTransaction(structuredClone(draft.transaction));
  tx.header.rc_limit = "5000000"; await Transaction.prepareTransaction(tx); // old signature on a new ID
  await assert.rejects(f.custody.broadcast({ transaction: tx, confirm: true }), /signature/);
  tx.header.unknown = "ignored by protobuf";
  await assert.rejects(f.custody.broadcast({ transaction: tx, confirm: true }), /header/);
  assert.equal(f.calls.length, 0);
});

test("browser review rejects wrong chains/contracts and unrelated or excessive burn approvals", async t => {
  const f = fixture(t); await f.custody.configure({ mode: "external", address: f.owner.getAddress() }); await f.custody.key();
  const options = { chainId: await f.provider.getChainId(), contracts: NETWORKS.mainnet.contracts, pobAbi: POB_ABI, tokenAbi: TOKEN_ABI };
  const draft = await f.custody.prepare({ action: "burn", amount: "1" });
  await assert.rejects(inspectDraft(draft, { ...options, chainId: "wrong" }), /network/);
  await assert.rejects(inspectDraft(draft, { ...options, contracts: { ...options.contracts, koin: f.wallet.address } }), /unrecognized/);
  const { Contract } = require("koilib"), koin = new Contract({ id: options.contracts.koin, abi: TOKEN_ABI });
  for (const args of [{ owner: f.owner.getAddress(), spender: options.contracts.pob, value: "200000000" }, { owner: f.owner.getAddress(), spender: f.wallet.address, value: "100000000" }]) {
    const bad = structuredClone(draft); bad.transaction.operations[0] = (await koin.functions.approve(args, { onlyOperation: true })).operation;
    await Transaction.prepareTransaction(bad.transaction);
    await assert.rejects(inspectDraft(bad, options), /Unexpected/);
  }
});

test("concurrent broadcasts consume a draft once, and rotation invalidates signed registration", async t => {
  const f = fixture(t); await f.custody.configure({ mode: "external", address: f.owner.getAddress() }); await f.custody.key();
  let draft = await f.custody.prepare({ action: "register" });
  let signed = await f.owner.signTransaction(structuredClone(draft.transaction));
  const results = await Promise.allSettled([1, 2].map(() => f.custody.broadcast({ transaction: signed, confirm: true })));
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1); assert.equal(f.calls.length, 1);
  draft = await f.custody.prepare({ action: "register" }); signed = await f.owner.signTransaction(structuredClone(draft.transaction));
  await f.custody.key({ rotate: true, confirm: true });
  await assert.rejects(f.custody.broadcast({ transaction: signed, confirm: true }), /expired/);
});

test("producer UI configures cold custody without a local wallet, generates a key and prepares external registration", { skip: !process.env.KOINOSKIT_TEST_BROWSER, timeout: 45000 }, async t => {
  const f = fixture(t); f.wallet.address = null; f.wallet.status = () => ({ exists: false, unlocked: false, address: null });
  const { startSignerServer: startMascotServer } = require("./helpers/browser");
  const server = await startMascotServer(f.dir);
  const browser = await require("playwright").chromium.launch({ executablePath: process.env.KOINOSKIT_TEST_CHROMIUM || undefined, args: ["--no-sandbox"] });
  t.after(async () => { await browser.close(); await server.close(); });
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 } }), errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.exposeFunction("kitInvoke", async (channel, payload) => {
    try { return { ok: true, data: await f.channels.get(channel)(payload || {}) }; }
    catch (e) { return { ok: false, error: e.message }; }
  });
  await page.addInitScript(() => { window.koinos = { invoke: (channel, payload) => window.kitInvoke(channel, payload), onEvent: () => () => {} }; });
  await page.goto(server.origin + "/index.html");
  await page.locator('[data-view="node"]').click();
  await page.selectOption("#pc-mode", "external"); await page.fill("#pc-address", f.owner.getAddress());
  await page.click("#pc-save");
  await page.waitForFunction(() => document.querySelector("#pc-result").textContent.includes("Custody saved"));
  await page.click("#pc-key");
  await page.waitForFunction(() => document.querySelector("#pc-public").value.length > 20);
  assert.equal(await page.locator("#n-register").isDisabled(), true);
  await page.locator("summary").filter({ hasText: "External signing:" }).click();
  await page.check("#pc-offline");
  await page.click("#pc-prepare");
  await page.waitForFunction(() => document.querySelector("#pc-unsigned").value.includes("kai-producer-transaction-v1"));
  const draft = JSON.parse(await page.inputValue("#pc-unsigned"));
  assert.equal(draft.signingWindow, "offline-24h");
  await page.evaluate(() => { document.querySelector("#pc-unsigned").value = ""; });
  await page.click("#pc-resume");
  await page.waitForFunction(() => document.querySelector("#pc-broadcast-result").textContent.includes("Saved draft restored"));
  assert.deepEqual(JSON.parse(await page.inputValue("#pc-unsigned")), draft);
  const downloading = page.waitForEvent("download"); await page.click("#pc-download-draft");
  const download = await downloading;
  assert.deepEqual(JSON.parse(fs.readFileSync(await download.path(), "utf8")), draft);
  const adjusted = structuredClone(draft.transaction); adjusted.header.rc_limit = "5000000"; await Transaction.prepareTransaction(adjusted);
  const signed = await f.owner.signTransaction(adjusted);
  await page.check("#pc-confirm");
  await page.setInputFiles("#pc-import-signed", { name: "signed.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(signed)) });
  await page.waitForFunction(() => document.querySelector("#pc-signed-review").textContent.includes("0.05000000"));
  assert.equal(await page.isChecked("#pc-confirm"), false);
  await page.check("#pc-confirm"); await page.click("#pc-broadcast");
  await page.waitForFunction(() => document.querySelector("#pc-result").textContent.includes("Submitted"));
  assert.equal(f.calls.length, 1);
  f.registered(await page.inputValue("#pc-public"));
  await page.click("#pc-verify");
  await page.waitForFunction(() => document.querySelector("#pc-result").textContent.includes("matches this node"));
  assert.equal((await f.channels.get("node:start")({ produce: true })).address, f.owner.getAddress());
  await page.locator('[data-view="returns"]').click();
  assert.match(await page.locator("#view-returns").textContent(), /Automatic burns and transfers are disabled/);
  assert.deepEqual(errors, []);
});

test("Koin Vault QR connects a producer, requests registration and handles rejection and disconnection in the node UI", { skip: !process.env.KOINOSKIT_TEST_BROWSER, timeout: 45000 }, async t => {
  let connected = false, requested = null, status = "pending", f;
  const vaultRequest = async (route, body) => {
    if (route === "config") return { network: "mainnet", demo: false, features: { kaiProducer: true, kaiProductionAllowance: true, kaiBurnFullVhp: true } };
    if (route === "dapp/create") return { sessionId: "a".repeat(24), secret: "b".repeat(43), expiresAt: Date.now() + 1800000 };
    if (route === "dapp/status") return { connected, address: connected ? f.owner.getAddress() : null };
    if (route === "dapp/request") { requested = body; return { requestId: "r".repeat(24), expiresAt: Date.now() + 600000 }; }
    if (route === "dapp/request-status") return { status };
    if (route === "dapp/disconnect") { connected = false; return {}; }
    throw new Error(route);
  };
  f = fixture(t, { vaultRequest });
  const { startSignerServer: startMascotServer } = require("./helpers/browser");
  const server = await startMascotServer(f.dir);
  const browser = await require("playwright").chromium.launch({ executablePath: process.env.KOINOSKIT_TEST_CHROMIUM || undefined, args: ["--no-sandbox"] });
  t.after(async () => { await browser.close(); await server.close(); });
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  const errors = []; page.on("pageerror", e => errors.push(e.message));
  await page.exposeFunction("kitInvoke", async (channel, payload) => {
    try { return { ok: true, data: await f.channels.get(channel)(payload || {}) }; }
    catch (e) { return { ok: false, error: e.message }; }
  });
  await page.addInitScript(() => { window.koinos = { invoke: (channel, payload) => window.kitInvoke(channel, payload), onEvent: () => () => {} }; });
  await page.goto(server.origin + "/index.html");
  await page.locator('[data-view="node"]').click();
  await page.click("#pc-vault-connect");
  await page.waitForSelector("#pc-vault-qr svg");
  const uri = await page.locator("#pc-vault-qr").getAttribute("data-uri");
  assert.equal(new URL(uri).origin, "https://koinvault.app");
  assert.equal(await page.locator("#pc-vault-qr path").getAttribute("d"), await page.evaluate(url => QRCode.toSvg(url).querySelector("path").getAttribute("d"), uri));
  assert.equal(f.settings.get("producer.mode", "local"), "local");
  connected = true; await page.evaluate(() => refreshVault());
  await page.click("#pc-vault-prepare");
  await page.waitForFunction(() => document.querySelector("#pc-vault-result").textContent.includes("Use this producer wallet"));
  assert.equal(requested, null);
  await page.click("#pc-vault-use");
  await page.waitForFunction(() => document.querySelector("#pc-result").textContent.includes("Koin Vault producer saved"));
  assert.equal(f.settings.get("producer.mode"), "external");
  assert.equal(f.settings.get("producer.addresses.mainnet"), f.owner.getAddress());
  await page.click("#pc-key");
  await page.waitForFunction(() => document.querySelector("#pc-public").value.length > 20);
  await page.click("#pc-vault-prepare");
  await page.waitForSelector(".modal");
  const pub = await page.inputValue("#pc-public");
  assert.match(await page.locator(".modal").textContent(), /Wallet approval submits/);
  assert.ok((await page.locator(".modal").textContent()).includes(pub));
  await page.getByRole("button", { name: "Request wallet approval", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("#pc-vault-status").textContent.includes("Waiting for your approval"));
  assert.ok(requested.operations.length === 1); assert.equal(f.calls.length, 0, "KAI never uses local signing or broadcasts a vault request");
  await assert.rejects(f.channels.get("producer:key")({ rotate: true, confirm: true }), /Finish or cancel/);
  status = "rejected"; await page.evaluate(() => refreshVault());
  await page.waitForFunction(() => document.querySelector("#pc-vault-status").textContent.includes("rejected"));
  const originalContract = f.chain._contract.bind(f.chain);
  f.chain._contract = async (...args) => {
    const c = await originalContract(...args);
    if (args[0] === "vhp") c.functions.allowance = async () => ({ result: { value: "0" } });
    return c;
  };
  await page.selectOption("#pc-vault-action", "productionAllowance");
  await page.fill("#pc-vault-amount", "10");
  await page.click("#pc-vault-prepare");
  await page.waitForSelector(".modal");
  assert.match(await page.locator(".modal").textContent(), /10 VHP/);
  assert.match(await page.locator(".modal").textContent(), /set 0 to revoke/i);
  status = "pending";
  await page.getByRole("button", { name: "Request wallet approval", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("#pc-vault-status").textContent.includes("Waiting for your approval"));
  const vhp = await originalContract("vhp", { provider: f.provider });
  const approved = await vhp.decodeOperation(requested.operations[0]);
  assert.equal(approved.name, "approve");
  assert.equal(approved.args.spender, NETWORKS.mainnet.contracts.pob);
  assert.equal(approved.args.value, "1000000000");
  status = "rejected"; await page.evaluate(() => refreshVault());
  await page.selectOption("#pc-vault-action", "burn");
  assert.equal(await page.isChecked("#pc-vault-burn-full"), true);
  await page.fill("#pc-vault-amount", "20");
  await page.click("#pc-vault-prepare");
  await page.waitForSelector(".modal");
  assert.match(await page.locator(".modal").textContent(), /120 VHP/);
  assert.match(await page.locator(".modal").textContent(), /Both changes succeed together/);
  status = "pending";
  await page.getByRole("button", { name: "Request wallet approval", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("#pc-vault-status").textContent.includes("Waiting for your approval"));
  assert.equal(requested.operations.length, 3);
  status = "rejected"; await page.evaluate(() => refreshVault());
  if (process.env.KAI_VAULT_SCREENSHOT) await page.screenshot({ path: process.env.KAI_VAULT_SCREENSHOT, fullPage: true });
  await page.click("#pc-vault-disconnect");
  await page.waitForFunction(() => !document.querySelector("#pc-vault-connect").hidden);
  assert.equal(await page.locator("#pc-vault-account").textContent(), "");
  assert.equal(f.settings.get("producer.addresses.mainnet"), f.owner.getAddress(), "disconnect preserves the node's producer");
  assert.deepEqual(errors, []);
});

test("production allowance targets official PoB, is balance-limited, revocable and unsigned", async t => {
  const f = fixture(t); await f.custody.configure({ mode: "external", address: f.owner.getAddress() });
  const original = f.chain._contract.bind(f.chain);
  let supported = true;
  f.chain._contract = async (...args) => {
    const c = await original(...args);
    if (args[0] === "vhp") c.functions.allowance = async () => {
      if (!supported) throw new Error("allowance unavailable");
      return { result: { value: "0" } };
    };
    return c;
  };
  for (const amount of ["10", "0"]) {
    const d = await f.custody.operations({ action: "productionAllowance", amount });
    assert.equal(d.operations.length, 1);
    const c = await original("vhp", { provider: f.provider });
    const decoded = await c.decodeOperation(d.operations[0]);
    assert.equal(decoded.name, "approve");
    assert.equal(decoded.args.owner, f.owner.getAddress());
    assert.equal(decoded.args.spender, NETWORKS.mainnet.contracts.pob);
    assert.equal(BigInt(decoded.args.value || "0"), BigInt(amount) * 100000000n);
    assert.equal(d.summary.spender, NETWORKS.mainnet.contracts.pob);
    assert.equal(f.calls.length, 0);
  }
  await assert.rejects(f.custody.operations({ action: "productionAllowance", amount: "101" }), /balance/);
  const full = await f.custody.operations({ action: "productionAllowance", useFullBalance: true });
  assert.equal(full.summary.amount, "100");
  const burn = await f.custody.operations({ action: "burn", amount: "20", allowFullVhp: true });
  assert.equal(burn.operations.length, 3);
  assert.equal(burn.summary.productionAllowance, "120");
  const token = await original("vhp", { provider: f.provider });
  const approval = await token.decodeOperation(burn.operations[2]);
  assert.equal(approval.args.value, "12000000000");
  assert.equal(approval.args.spender, NETWORKS.mainnet.contracts.pob);
  assert.equal((await f.custody.operations({ action: "burn", amount: "20" })).operations.length, 2);
  supported = false;
  await assert.rejects(f.custody.operations({ action: "productionAllowance", amount: "1" }), /unavailable/);
});

test("real allowance decoder accepts protobuf zero and preserves nonzero values, but rejects RPC errors", async t => {
  const f = fixture(t); await f.custody.configure({ mode: "external", address: f.owner.getAddress() });
  // The uint64 value 0 can be omitted by protobuf, yielding an empty result.
  let encoded = "";
  f.provider.readContract = async () => ({ result: encoded });
  const vhp = await f.chain._contract("vhp", { provider: f.provider });
  assert.equal((await vhp.functions.allowance({ owner: f.owner.getAddress(), spender: NETWORKS.mainnet.contracts.pob })).result.value, "0");
  const full = await f.custody.operations({ action: "productionAllowance", useFullBalance: true });
  assert.equal(full.summary.amount, "100");
  const burn = await f.custody.operations({ action: "burn", amount: "20", allowFullVhp: true });
  assert.equal(burn.operations.length, 3);
  assert.equal(burn.summary.productionAllowance, "120");
  encoded = "CAc="; // protobuf field 1, uint64 7
  assert.equal((await vhp.functions.allowance({ owner: f.owner.getAddress(), spender: NETWORKS.mainnet.contracts.pob })).result.value, "7");
  f.provider.readContract = async () => { throw new Error("RPC unavailable"); };
  await assert.rejects(f.custody.operations({ action: "productionAllowance", useFullBalance: true }), /RPC unavailable/);
  await assert.rejects(f.custody.operations({ action: "burn", amount: "20", allowFullVhp: true }), /RPC unavailable/);
  assert.equal(f.calls.length, 0);
});


test("dual-boot draft survives disk reopen and two hours offline, validates and submits only once", async t => {
  const f = fixture(t); await f.custody.configure({ mode: "external", address: f.owner.getAddress() }); await f.custody.key();
  const draft = await f.custody.prepare({ action: "register", offlineSigning: true });
  assert.equal(draft.expiresAt - draft.createdAt, 24 * 60 * 60000);
  const signed = await f.owner.signTransaction(structuredClone(draft.transaction));
  t.mock.timers.enable({ apis: ["Date"], now: draft.createdAt + 2 * 60 * 60000 });
  const restarted = new ProducerCustody({ ...f, settings: new JsonStore(path.join(f.dir, "settings.json")), state: new JsonStore(path.join(f.dir, "state.json")) });
  assert.deepEqual(restarted.savedDraft(), draft);
  await inspectDraft(draft, { chainId: await f.provider.getChainId(), contracts: NETWORKS.mainnet.contracts, pobAbi: POB_ABI, tokenAbi: TOKEN_ABI });
  const wrong = await Signer.fromSeed("another offline owner").signTransaction(structuredClone(draft.transaction));
  await assert.rejects(restarted.broadcast({ transaction: wrong, confirm: true }), /does not belong/);
  f.provider.getNextNonce = async () => "KAI=";
  await assert.rejects(restarted.broadcast({ transaction: signed, confirm: true }), /nonce changed/);
  f.provider.getNextNonce = async () => "KAE=";
  assert.equal((await restarted.broadcast({ transaction: signed, confirm: true })).txId, signed.id);
  assert.equal(f.calls.length, 1);
  assert.throws(() => restarted.savedDraft(), /expired/);
  await assert.rejects(restarted.broadcast({ transaction: signed, confirm: true }), /expired/);
});

test("offline expiry stays bounded and legacy drafts still expire after 15 minutes", async t => {
  const f = fixture(t); await f.custody.configure({ mode: "external", address: f.owner.getAddress() }); await f.custody.key();
  const standard = await f.custody.prepare({ action: "register" });
  assert.equal(standard.expiresAt - standard.createdAt, 15 * 60000);
  const { fresh } = require("../ui/producer-signer/validation");
  assert.throws(() => fresh(standard, standard.createdAt + 16 * 60000), /expired/);
  const offline = await f.custody.prepare({ action: "register", offlineSigning: true });
  assert.throws(() => fresh(offline, offline.expiresAt), /expired/);
  assert.throws(() => fresh({ ...offline, expiresAt: offline.expiresAt + 60000 }), /Invalid/);
  await f.custody.key({ rotate: true, confirm: true });
  assert.throws(() => f.custody.savedDraft(), /expired/);
});

test("unreadable custody cannot start production or automatic returns, and only explicit custody selection repairs it", async t => {
  const f = fixture(t);
  await f.custody.configure({ mode: "external", address: f.owner.getAddress() });
  fs.writeFileSync(f.settings.filePath, "{broken");
  fs.writeFileSync(f.settings.filePath + ".last-good", "{also-broken");
  const settings = new JsonStore(f.settings.filePath, DEFAULT_SETTINGS);
  const chain = new ChainService(settings);
  chain.registeredPublicKey = f.chain.registeredPublicKey;
  const rewards = new RewardEngine({ ...f, settings, chain });
  const args = { ...f, settings, chain, rewards };
  const restarted = new ProducerCustody(args), channels = buildChannels(args);
  t.after(() => rewards.stop());
  assert.equal(restarted.config().mode, "unresolved");
  rewards.start(); assert.equal(rewards.status().running, false);
  assert.equal((await rewards.tick("manual")).last.outcome, "custody-unresolved");
  assert.equal((await channels.get("app:info")()).settingsHealth.ok, false);
  for (const action of ["node:start", "node:rebuildState"]) {
    await assert.rejects(channels.get(action)({ produce: true }), /could not be loaded safely/);
  }
  await assert.rejects(channels.get("settings:update")({ keepLiquidKoin: "20" }), /unresolved/);
  assert.equal(settings.health().ok, false);
  await restarted.configure({ mode: "external", address: f.owner.getAddress() });
  assert.equal(settings.health().ok, true);
  assert.equal(new JsonStore(f.settings.filePath).get("producer.mode"), "external");
  assert.equal(rewards.config().enabled, false);
});

test("rebuild verifies the external producer; dashboard and Wallet read separate accounts", async t => {
  const f = fixture(t);
  await f.custody.configure({ mode: "external", address: f.owner.getAddress() });
  const key = await f.custody.key();
  f.nodeMgr.rebuildState = async (network, address) => ({ network, address });
  await assert.rejects(f.channels.get("node:rebuildState")({ produce: true }), /registration/);
  f.registered(key.publicKey);
  assert.equal((await f.channels.get("node:rebuildState")({ produce: true })).address, f.owner.getAddress());
  const read = [];
  f.chain.balances = async address => { read.push(address); return { koin: "0", vhp: "0", mana: "0" }; };
  const stats = { refresh: async address => { assert.equal(address, f.owner.getAddress()); return { available: false }; } };
  const channels = buildChannels({ ...f, stats });
  const dashboard = await channels.get("dashboard:summary")();
  assert.equal(dashboard.wallet.address, f.owner.getAddress());
  assert.equal(dashboard.custody.localWalletAddress, f.wallet.address);
  assert.equal(read.at(-1), f.owner.getAddress());
  assert.equal((await channels.get("chain:balances")()).address, f.wallet.address);
  assert.equal(read.at(-1), f.wallet.address);
  await assert.rejects(channels.get("wallet:import")({ wif: f.owner.getPrivateKey("wif"), password: "not-used" }), /Keep the external/);
});

test("in-flight production verification serializes custody, keys, network and recovery changes", async t => {
  const f = fixture(t);
  await f.custody.configure({ mode: "external", address: f.owner.getAddress() });
  const key = await f.custody.key();
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  f.chain.registeredPublicKey = () => { entered(); return new Promise(resolve => { release = resolve; }); };
  const starting = f.channels.get("node:start")({ produce: true });
  await waiting;
  for (const [name, input] of [["producer:configure", { mode: "local" }], ["producer:key", {}], ["settings:update", { network: "harbinger" }], ["node:rebuildState", { produce: true }]]) {
    await assert.rejects(f.channels.get(name)(input), /current producer operation/);
  }
  release(key.publicKey);
  assert.equal((await starting).address, f.owner.getAddress());
  f.nodeMgr.status = async () => ({ docker: { ok: true }, isRunning: true });
  await assert.rejects(f.channels.get("settings:update")({ network: "harbinger" }), /Stop the node/);
});

test("switching networks invalidates saved drafts and never reuses another network's external address", async t => {
  const f = fixture(t);
  await f.custody.configure({ mode: "external", address: f.owner.getAddress() }); await f.custody.key();
  await f.custody.prepare({ action: "register", offlineSigning: true });
  await f.channels.get("settings:update")({ network: "harbinger" });
  assert.equal(f.state.get("producerDraft"), null);
  assert.equal(f.custody.config().address, "");
  await assert.rejects(f.channels.get("node:start")({ produce: true }), /watch-only producer address/);
  await f.channels.get("settings:update")({ network: "mainnet" });
  assert.equal(f.custody.config().address, f.owner.getAddress());
});
