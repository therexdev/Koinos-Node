/* global kondor, KaiProducerValidation, KaiProducerAbis */
"use strict";
(() => {
  const koilib = window;
  const $ = id => document.getElementById(id), V = KaiProducerValidation;
  let draft = null, review = null, signed = null, generation = 0, busy = false;
  const amount = raw => { const n = BigInt(raw); return `${n / 100000000n}.${(n % 100000000n).toString().padStart(8, "0")}`; };
  function status(message, error = false) { $("status").textContent = message; $("status").dataset.error = String(error); }
  function controls() {
    $("sign").disabled = busy || !review || !$("confirmed").checked || !!signed;
    $("review").disabled = busy; $("unsigned-file").disabled = busy; $("unsigned").disabled = busy;
    $("download").disabled = !signed || busy;
  }
  function reset() {
    generation++; draft = review = signed = null; $("confirmed").checked = false;
    $("review-panel").hidden = true; $("signed-details").hidden = true; $("signed").value = "";
    $("signed-status").textContent = "After signing, download the signed JSON and take it back to the node computer."; controls();
  }
  async function bounded(promise, message, ms = 120000) {
    let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]); } finally { clearTimeout(timer); }
  }
  $("unsigned").addEventListener("input", reset);
  $("unsigned-file").addEventListener("change", async () => {
    reset(); const g = generation, file = $("unsigned-file").files[0]; if (!file) return;
    try { if (file.size > 100000) throw new Error("Choose a JSON file smaller than 100 KB."); const content = await file.text(); if (g !== generation) return; $("unsigned").value = content; status("File loaded. Click Review transaction."); }
    catch (e) { status(e.message, true); }
  });
  $("confirmed").addEventListener("change", controls);
  $("review").addEventListener("click", async () => {
    reset(); busy = true; controls(); status("Checking Mainnet and its canonical contracts…");
    try {
      const candidate = JSON.parse($("unsigned").value); V.fresh(candidate);
      // Read-only checks against a fixed trusted endpoint, never a URL from the file.
      const provider = new koilib.Provider(["https://api.koinos.io"]);
      const [chainId, ...addresses] = await bounded(Promise.all([provider.getChainId(), ...["koin", "vhp", "pob"].map(name => provider.invokeGetContractAddress(name))]), "Mainnet verification timed out. Check your connection and retry.", 30000);
      const contracts = Object.fromEntries(["koin", "vhp", "pob"].map((name, i) => [name, addresses[i]?.value?.address]));
      if (Object.values(contracts).some(a => !a || !koilib.utils.isChecksumAddress(a))) throw new Error("Cannot verify Mainnet contract addresses. Retry later.");
      const checked = await V.inspectDraft(candidate, { chainId, contracts, ...KaiProducerAbis });
      const last = checked.operations.at(-1), a = last.args;
      const rows = [["Action", { register: "Register hot production key", burn: "Burn KOIN → own VHP", transfer: "Transfer " + last.token }[checked.action]], ["Network", "Koinos Mainnet"], ["Producer / payer", checked.payer]];
      if (checked.action === "register") rows.push(["Hot public key", a.public_key]);
      else rows.push(["Amount", amount(a.value || a.token_amount) + " " + (checked.action === "burn" ? "KOIN" : last.token)], ["Recipient", a.to || a.vhp_address]);
      rows.push(["Maximum mana", amount(checked.manaLimitSatoshis) + " mana"], ["Expires in KoinosKit", new Date(candidate.expiresAt).toLocaleString()], ["Chain ID", checked.chainId], ["Nonce", checked.nonce], ["Unsigned transaction ID", checked.id]);
      $("review-fields").replaceChildren();
      for (const [label, value] of rows) { const dt = document.createElement("dt"), dd = document.createElement("dd"); dt.textContent = label; dd.textContent = value; $("review-fields").append(dt, dd); }
      $("operations").textContent = JSON.stringify(checked.operations, null, 2);
      draft = candidate; review = checked; $("review-panel").hidden = false;
      status("Network and contracts verified. Review the actual operations above before signing.");
    } catch (e) { reset(); status(e.message, true); }
    finally { busy = false; controls(); }
  });
  $("sign").addEventListener("click", async () => {
    if (busy || !review || !$("confirmed").checked || signed) return;
    busy = true; controls(); const original = structuredClone(draft);
    try {
      V.fresh(original); status("Open Kondor and approve access to the producer account…");
      const accounts = await bounded(kondor.getAccounts(), "Kondor did not respond. Close any pending wallet prompt, unlock Kondor in this browser and retry.");
      if (!Array.isArray(accounts) || !accounts.some(account => account.address === review.payer)) throw new Error("Choose the producer account shown above in Kondor, then retry.");
      V.fresh(original); status("Review and approve the signature in Kondor. Keep Use free mana off.");
      // Kondor mutates its input. Preserve the original for independent checks.
      const result = await bounded(kondor.getSigner(review.payer).signTransaction(structuredClone(original.transaction), review.abis), "Signing timed out. Close the pending Kondor prompt before retrying.", 240000);
      signed = await V.validateSigned(original, result);
      $("signed").value = JSON.stringify(signed, null, 2); $("signed-details").hidden = false;
      $("signed-status").textContent = `Signature verified. Final mana limit: ${amount(signed.header.rc_limit)} mana. Transaction ID: ${signed.id}`;
      status("Signed transaction verified. Download it and return to KoinosKit to broadcast.");
    } catch (e) {
      signed = null;
      const message = /connection lost/i.test(e.message)
        ? "Kondor closed the connection before this page received a signed transaction. No signed file is available and this page has not broadcast anything. Close leftover Kondor prompts and use only one Kondor extension in this browser profile. If it repeats, capture the error from Kondor’s extension console immediately after pressing Sign; changing the mana limit or registering another hot key will not repair a missing response."
        : e.message;
      status(message, true);
    }
    finally { busy = false; controls(); }
  });
  $("download").addEventListener("click", () => {
    if (!signed) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(signed, null, 2) + "\n"], { type: "application/json" }));
    const a = document.createElement("a"); a.href = url; a.download = "koinoskit-producer-signed.json"; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
})();
