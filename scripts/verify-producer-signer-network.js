#!/usr/bin/env node
"use strict";
// Read-only release gate for the exact RPC and serialization used by the page.
const { Provider, utils } = require("koilib");
(async () => {
  const timer = setTimeout(() => { console.error("Producer signer RPC verification timed out."); process.exit(1); }, 45000);
  try {
    const provider = new Provider(["https://api.koinos.io"]);
    const chainId = await provider.getChainId();
    if (!chainId) throw new Error("Mainnet chain ID unavailable.");
    for (const name of ["koin", "vhp", "pob"]) {
      const result = await provider.invokeGetContractAddress(name);
      if (!utils.isChecksumAddress(result?.value?.address || "")) throw new Error("Cannot verify canonical " + name + " contract.");
    }
    const cors = await fetch("https://api.koinos.io", { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://koinoskit.site" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "chain.get_chain_id", params: {} }) });
    if (!cors.ok || !["*", "https://koinoskit.site"].includes(cors.headers.get("access-control-allow-origin"))) throw new Error("Mainnet RPC must permit the signer browser origin.");
    console.log("Producer signer: Mainnet chain, canonical contracts and browser CORS verified.");
  } finally { clearTimeout(timer); }
})().catch(e => { console.error(e.message); process.exitCode = 1; });
