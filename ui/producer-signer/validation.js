/* Shared by the desktop and the browser signer. No network or key access. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("koilib"));
  else root.KaiProducerValidation = factory(root);
})(typeof globalThis !== "undefined" ? globalThis : this, function (koilib) {
  "use strict";
  const { Transaction, Signer, Contract, utils } = koilib;
  const clone = value => JSON.parse(JSON.stringify(value));
  const plain = value => !!value && typeof value === "object" && !Array.isArray(value);
  const keys = (value, allowed) => plain(value) && Object.keys(value).every(key => allowed.includes(key));
  function equal(a, b) {
    if (a === b) return true;
    if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b)) return false;
    const ak = Object.keys(a), bk = Object.keys(b);
    return ak.length === bk.length && ak.every(k => Object.hasOwn(b, k) && equal(a[k], b[k]));
  }
  function uint(value) {
    if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(value) || BigInt(value) > 18446744073709551615n) throw new Error("Invalid mana limit or token amount.");
    return BigInt(value);
  }
  function shape(tx) {
    if (!keys(tx, ["id", "header", "operations", "signatures"]) || JSON.stringify(tx).length > 100000 || typeof tx.id !== "string") throw new Error("Provide only transaction JSON, never a private key.");
    const h = tx.header;
    if (!keys(h, ["payer", "chain_id", "nonce", "rc_limit", "operation_merkle_root"]) || ["payer", "chain_id", "nonce", "operation_merkle_root"].some(k => typeof h[k] !== "string" || !h[k])) throw new Error("Unsupported transaction header. Keep the original payer; disable Kondor free mana.");
    if (uint(h.rc_limit) <= 0n) throw new Error("Mana limit must be positive.");
    if (!Array.isArray(tx.operations) || tx.operations.length < 1 || tx.operations.length > 2 || tx.operations.some(op => !keys(op, ["call_contract"]) || !keys(op.call_contract, ["contract_id", "entry_point", "args"]) || typeof op.call_contract.contract_id !== "string" || !Number.isInteger(op.call_contract.entry_point) || typeof op.call_contract.args !== "string")) throw new Error("Unsupported producer operations.");
  }
  async function hash(tx) {
    const prepared = await Transaction.prepareTransaction(clone(tx));
    if (prepared.id !== tx.id || prepared.header.operation_merkle_root !== tx.header.operation_merkle_root) throw new Error("Transaction hash differs from its contents. Nothing was broadcast.");
  }
  function fresh(draft, now = Date.now()) {
    if (draft?.signingWindow === "offline-24h" && (!Number.isSafeInteger(draft.createdAt) || draft.createdAt > now + 30000 || draft.expiresAt - draft.createdAt !== 24 * 60 * 60000)) throw new Error("Invalid offline signing window. Prepare a fresh transaction in KoinosKit.");
    if (!draft || draft.format !== "kai-producer-transaction-v1" || !Number.isSafeInteger(draft.expiresAt) || draft.expiresAt <= now || draft.expiresAt > now + (draft.signingWindow === "offline-24h" ? 24 * 60 : 15) * 60000 + 30000) throw new Error("Invalid or expired draft. Prepare a fresh transaction in KoinosKit.");
  }
  async function validateSigned(draft, transaction) {
    fresh(draft); shape(draft.transaction); shape(transaction);
    if (draft.transaction.signatures?.length) throw new Error("The prepared draft must be unsigned.");
    const expected = clone(draft.transaction), actual = clone(transaction);
    delete expected.signatures; delete actual.signatures;
    // A wallet may reduce rc_limit and recalculate id. Everything else stays exact.
    if (uint(actual.header.rc_limit) > uint(expected.header.rc_limit)) throw new Error("Kondor's mana limit exceeds the prepared maximum. Lower Max mana in Kondor and sign again.");
    actual.id = expected.id; actual.header.rc_limit = expected.header.rc_limit;
    if (!equal(actual, expected)) throw new Error("Signed transaction differs from the prepared draft. Nothing was broadcast.");
    await hash(draft.transaction); await hash(transaction);
    const signatures = transaction.signatures;
    if (!Array.isArray(signatures) || signatures.length !== 1 || typeof signatures[0] !== "string" || signatures[0].length > 100) throw new Error("A single external producer signature is required.");
    let signers;
    try { signers = await Signer.recoverAddresses(transaction); } catch { throw new Error("Invalid producer signature."); }
    if (!signers.includes(draft.transaction.header.payer)) throw new Error("The signature does not belong to the external producer address.");
    return clone(transaction);
  }
  async function inspectDraft(draft, { chainId, contracts, pobAbi, tokenAbi }) {
    fresh(draft); const tx = draft.transaction; shape(tx); await hash(tx);
    if (tx.signatures?.length) throw new Error("Load the unsigned draft exported by KoinosKit.");
    if (!chainId || tx.header.chain_id !== chainId) throw new Error("This draft does not match the network selected on the signing page.");
    const payer = tx.header.payer, operations = [], abis = {};
    for (const op of tx.operations) {
      const id = op.call_contract.contract_id;
      const token = id === contracts.koin ? "KOIN" : id === contracts.vhp ? "VHP" : null;
      const abi = id === contracts.pob ? pobAbi : token ? tokenAbi : null;
      if (!abi) throw new Error("An operation uses an unrecognized contract for this network.");
      const contract = new Contract({ id, abi }), decoded = await contract.decodeOperation(op);
      const permitted = id === contracts.pob ? ["register_public_key", "burn"] : token === "KOIN" ? ["transfer", "approve"] : ["transfer"];
      if (!permitted.includes(decoded.name)) throw new Error("Unsupported producer operation.");
      const encoded = await contract.functions[decoded.name](decoded.args, { onlyOperation: true });
      if (!equal(encoded.operation, op)) throw new Error("Operation contains noncanonical or unexpected fields.");
      operations.push({ contract: id, token, ...decoded }); abis[id] = abi;
    }
    const last = operations.at(-1), a = last.args;
    let action;
    if (last.name === "register_public_key" && operations.length === 1 && a.producer === payer && utils.decodeBase64url(a.public_key).length === 33) action = "register";
    if (last.name === "transfer" && operations.length === 1 && a.from === payer && utils.isChecksumAddress(a.to) && uint(a.value) > 0n) action = "transfer";
    if (last.name === "burn" && a.burn_address === payer && a.vhp_address === payer && uint(a.token_amount) > 0n) {
      const approval = operations[0];
      if (operations.length === 1 || (approval.name === "approve" && approval.token === "KOIN" && approval.args.owner === payer && approval.args.spender === contracts.pob && approval.args.value === a.token_amount)) action = "burn";
    }
    if (!action) throw new Error("Unexpected account, recipient, approval or producer operation sequence.");
    return { action, payer, chainId, nonce: tx.header.nonce, id: tx.id, manaLimitSatoshis: tx.header.rc_limit, operations, abis };
  }
  return { validateSigned, inspectDraft, fresh, equal };
});
