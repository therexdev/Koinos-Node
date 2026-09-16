#!/usr/bin/env node
"use strict";
// Run on a separate signing machine. No Provider is instantiated: no network.
const fs = require("fs");
const { Transaction, Signer, Contract } = require("koilib");
const { POB_ABI, TOKEN_ABI } = require("../electron/lib/constants");
async function inspect(draft) {
  if (draft.format !== "kai-producer-transaction-v1" || !draft.transaction || draft.expiresAt < Date.now()) throw new Error("Invalid or expired draft.");
  const tx = draft.transaction;
  if (tx.signatures?.length || !tx.header?.payer || tx.header.payee || !tx.header.chain_id || !tx.header.nonce || !tx.header.rc_limit || !tx.operations?.length || tx.operations.length > 2) throw new Error("Unsupported transaction header or operations.");
  const prepared = await Transaction.prepareTransaction(JSON.parse(JSON.stringify(tx)));
  if (prepared.id !== tx.id || prepared.header.operation_merkle_root !== tx.header.operation_merkle_root) throw new Error("Transaction hash does not match its contents.");
  const operations = [];
  for (const op of tx.operations) {
    let decoded;
    for (const abi of [POB_ABI, TOKEN_ABI]) {
      try { decoded = await new Contract({ id: op.call_contract.contract_id, abi }).decodeOperation(op); break; } catch { /* try the other ABI */ }
    }
    if (!decoded || !["register_public_key", "approve", "burn", "transfer"].includes(decoded.name)) throw new Error("Unsupported operation.");
    operations.push({ contract: op.call_contract.contract_id, ...decoded });
  }
  return { id: tx.id, chainId: tx.header.chain_id, payer: tx.header.payer, manaLimitSatoshis: tx.header.rc_limit, nonce: tx.header.nonce, operations };
}
async function main() {
  const [input, keyFile, output, confirmedId, expectedChainId] = process.argv.slice(2);
  if (!input) throw new Error("Inspect: node scripts/sign-producer-transaction.js unsigned.json\nSign after review: node scripts/sign-producer-transaction.js unsigned.json /secure/producer.wif signed.json REVIEWED_TX_ID VERIFIED_CHAIN_ID");
  const draft = JSON.parse(fs.readFileSync(input, "utf8")), review = await inspect(draft);
  console.log(JSON.stringify(review, null, 2));
  if (!keyFile) return;
  if (!output || confirmedId !== review.id || expectedChainId !== review.chainId) throw new Error("Review the decoded operations and independently verify the chain ID before signing.");
  const signer = Signer.fromWif(fs.readFileSync(keyFile, "utf8").trim());
  if (signer.getAddress() !== review.payer) throw new Error("External key does not control the transaction payer.");
  const signed = await signer.signTransaction(draft.transaction);
  fs.writeFileSync(output, JSON.stringify(signed, null, 2), { mode: 0o600, flag: "wx" });
  console.log("Signed transaction written. No network request or broadcast was made.");
}
if (require.main === module) main().catch(e => { console.error(e.message); process.exitCode = 1; });
module.exports = { inspect };
