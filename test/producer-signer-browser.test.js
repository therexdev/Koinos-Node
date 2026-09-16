"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("fs"), path = require("path"), os = require("os"), vm = require("vm"), crypto = require("crypto");
const { Signer, Transaction, Contract, utils } = require("koilib");
const { NETWORKS, TOKEN_ABI, POB_ABI } = require("../electron/lib/constants");
const root = path.resolve(__dirname, "../ui/producer-signer");
const owner = Signer.fromSeed("disposable producer browser fixture"), recipient = Signer.fromSeed("disposable recipient").getAddress();
const chainId = utils.encodeBase64url(new Uint8Array(34).fill(1)), contracts = NETWORKS.mainnet.contracts;
async function draftFor(action, token = "koin") {
  const c = name => new Contract({ id: contracts[name], abi: name === "pob" ? POB_ABI : TOKEN_ABI });
  const tx = new Transaction({ options: { payer: owner.getAddress(), chainId, nonce: "KAE=", rcLimit: "1000000000" } });
  if (action === "register") await tx.pushOperation(c("pob").functions.register_public_key, { producer: owner.getAddress(), public_key: utils.encodeBase64url(Signer.fromSeed("disposable hot key").publicKey) });
  if (action === "burn") {
    await tx.pushOperation(c("koin").functions.approve, { owner: owner.getAddress(), spender: contracts.pob, value: "100000000" });
    await tx.pushOperation(c("pob").functions.burn, { burn_address: owner.getAddress(), vhp_address: owner.getAddress(), token_amount: "100000000" });
  }
  if (action === "transfer") await tx.pushOperation(c(token).functions.transfer, { from: owner.getAddress(), to: recipient, value: "100000000" });
  await tx.prepare(); return { format: "kai-producer-transaction-v1", expiresAt: Date.now() + 900000, summary: { action: "UNTRUSTED SUMMARY" }, transaction: tx.transaction };
}
test("actual pinned browser Koilib bundle decodes and verifies signatures", async () => {
  const context = vm.createContext({ console, crypto: crypto.webcrypto, TextEncoder, TextDecoder, setTimeout, clearTimeout, Uint8Array, ArrayBuffer }, { codeGeneration: { strings: true, wasm: false } });
  vm.runInContext("window = globalThis", context);
  for (const file of [path.join(path.dirname(require.resolve("koilib/package.json")), "dist/koinos.min.js"), path.join(root, "abis.js"), path.join(root, "validation.js")]) vm.runInContext(fs.readFileSync(file, "utf8"), context);
  const draft = await draftFor("burn");
  context.input = JSON.stringify({ draft, chainId, contracts });
  const review = await vm.runInContext("(async () => { const {draft,chainId,contracts}=JSON.parse(input); return KaiProducerValidation.inspectDraft(draft,{chainId,contracts,...KaiProducerAbis}); })()", context);
  assert.equal(review.action, "burn");
  const signed = structuredClone(draft.transaction); signed.header.rc_limit = "5000000"; await Transaction.prepareTransaction(signed); await owner.signTransaction(signed);
  context.input = JSON.stringify({ draft, signed });
  assert.equal((await vm.runInContext("(async () => { const {draft,signed}=JSON.parse(input); return KaiProducerValidation.validateSigned(draft,signed); })()", context)).id, signed.id);
});

test("browser file review, real Kondor SDK messaging, mana adjustment and signed download", { skip: !process.env.KOINOSKIT_TEST_BROWSER, timeout: 60000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-kondor-browser-"));
  const { startSignerServer: startMascotServer } = require("./helpers/browser");
  const server = await startMascotServer(dir);
  const browser = await require("playwright").chromium.launch({ executablePath: process.env.KOINOSKIT_TEST_CHROMIUM || undefined, args: ["--no-sandbox"] });
  t.after(async () => { await browser.close(); await server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const page = await browser.newPage({ viewport: { width: 1040, height: 1100 }, acceptDownloads: true }), errors = [], commands = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.route("**/koinos.min.js", route => route.fulfill({ path: path.join(path.dirname(require.resolve("koilib/package.json")), "dist/koinos.min.js"), contentType: "text/javascript" }));
  await page.route("https://**", route => route.abort());
  await page.exposeFunction("fixtureWallet", async message => {
    commands.push(message.command);
    if (message.command === "getAccounts") return [{ address: owner.getAddress(), name: "Fixture owner" }];
    assert.equal(message.command, "signer:signTransaction"); assert.equal(message.args.signerAddress, owner.getAddress()); assert.ok(message.args.abis[contracts.pob] || message.args.abis[contracts.koin] || message.args.abis[contracts.vhp]);
    const tx = structuredClone(message.args.transaction); tx.header.rc_limit = "5000000";
    await Transaction.prepareTransaction(tx); return owner.signTransaction(tx);
  });
  await page.goto(server.origin + "/producer-signer/index.html");
  await page.evaluate(({ chainId, contracts }) => {
    Provider.prototype.getChainId = async () => chainId;
    Provider.prototype.invokeGetContractAddress = async name => ({ value: { address: contracts[name] } });
    window.addEventListener("message", async e => {
      if (!e.data?.command || e.data.to !== "popup") return;
      try { window.postMessage({ id: e.data.id, result: await window.fixtureWallet(e.data) }, "*"); }
      catch (error) { window.postMessage({ id: e.data.id, error: error.message }, "*"); }
    });
  }, { chainId, contracts });
  for (const [action, token] of [["register", "koin"], ["burn", "koin"], ["transfer", "koin"], ["transfer", "vhp"]]) {
    const draft = await draftFor(action, token);
    await page.setInputFiles("#unsigned-file", { name: "unsigned.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(draft)) });
    await page.waitForFunction(() => document.getElementById("status").textContent.includes("File loaded"));
    await page.click("#review"); await page.waitForFunction(() => !document.getElementById("review-panel").hidden);
    assert.equal(await page.locator("#sign").isDisabled(), true);
    assert.ok(!(await page.locator("#review-fields").textContent()).includes("UNTRUSTED"));
    await page.check("#confirmed"); await page.click("#sign");
    await page.waitForFunction(() => !document.getElementById("download").disabled);
    const downloading = page.waitForEvent("download"); await page.click("#download"); const download = await downloading;
    const signed = JSON.parse(fs.readFileSync(await download.path(), "utf8"));
    assert.equal(signed.header.rc_limit, "5000000"); assert.notEqual(signed.id, draft.transaction.id);
    assert.equal((await Signer.recoverAddresses(signed))[0], owner.getAddress());
    assert.deepEqual(signed.operations, draft.transaction.operations);
  }
  if (process.env.KAI_MASCOT_QA_DIR) { fs.mkdirSync(process.env.KAI_MASCOT_QA_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.KAI_MASCOT_QA_DIR, "producer-signer.png"), fullPage: true }); }
  // Editing loaded input must invalidate previous review and signature.
  await page.locator("details").first().locator("summary").click(); await page.fill("#unsigned", "{}");
  assert.equal(await page.locator("#sign").isDisabled(), true); assert.equal(await page.locator("#download").isDisabled(), true);
  assert.deepEqual(errors, []); assert.equal(commands.filter(c => c === "signer:signTransaction").length, 4);
});
