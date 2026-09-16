# External/cold producer wallets

Koinos Node → Node → **Producer wallet custody** supports two modes:

- **Local wallet (hot wallet)**: the existing convenient setup. KoinosKit stores the account key locally and uses it for account operations. A separate block key does not make this a cold-wallet setup.
- **External/cold producer wallet**: KoinosKit stores only the public producer address and the separate hot block key. KOIN/VHP balances and block rewards belong to the external address; the local KoinosKit local wallet is unchanged. Registration, burns and transfers need a separate external signature. Automatic reward burns/transfers are disabled, including after restart and through Run now.

This follows Koinos's [block producer security design](https://docs.koinos.io/architecture/proof-of-burn/#block-producer-security).

## First setup

1. Create/control the producer account on a separate trusted wallet or offline signing machine. **Never import its WIF into the production host.** The account can differ from the local KoinosKit local wallet; no local wallet is required for block production.
2. Stop the node. Docker must be available so KoinosKit can verify that it is stopped.
3. Select External/cold producer wallet, paste its public address and save. The address is saved separately for each network. Automatic returns are turned off when switching either direction; switching back never silently re-enables them.
4. Click **Generate hot key**. KoinosKit creates `private.key` (WIF) and `public.key` (compressed secp256k1 public key, base64url) in the node's `basedir/block_producer` directory, matching the official block producer's key formats. Existing keys are reused. Copy the displayed public key.
5. Use **External signing → Register hot public key → Prepare unsigned transaction**. Click **Download unsigned JSON** and take the file to the signing machine. No funds or registration have been submitted yet.
6. Sign externally as described below. Use **Import signed JSON** (or paste it), tick the review checkbox and broadcast.
7. Wait for confirmation, then click **Verify registration**. Start production only when the on-chain key matches. An RPC failure is reported as unverified. A successful broadcast alone is not a verified registration.
8. Fund/burn to the external producer as needed. Its VHP is shown in the production checklist; the node dashboard shows this producer's balances and rewards. The Wallet tab remains the local wallet.

The node's Docker services use the configured public producer address and hot key across restarts. Account keys are unnecessary for signing blocks. KoinosKit checks registration when you start production; ordinary Docker restart/recovery continues the existing configuration and cannot sign account transactions.

## Kondor on a separate computer

No WIF export is needed. The browser signer is available at **https://koinoskit.site/producer-signer/** for Mainnet, including KoinosKit installations connected to Mainnet. It works in the browser where Kondor is installed; the secure computer does not need KoinosKit, Docker or Node.js.

1. In KoinosKit on the node computer, prepare the registration, burn or transfer and click **Download unsigned JSON**. **Copy signer link** gives you the page address to open on the other computer.
2. On the secure computer, open the signer page in your Kondor browser. Choose the unsigned JSON file and click **Review transaction**. The page checks the chain ID and current canonical contract addresses through the fixed Mainnet RPC. It decodes actual operations without trusting the file's descriptive summary, including exact-amount burn approvals.
3. Independently check the producer address, recipient, token amount, network, maximum mana and (for registration) the hot public key copied from your node. Tick the review checkbox and click **Sign with Kondor**. Select the matching producer account and approve the signature in Kondor.
4. Keep Kondor's **Use free mana** off: changing payer/payee is not supported. **Optimize mana** can remain on. KoinosKit accepts a positive mana limit at or below the prepared maximum; it verifies the resulting ID and signature and requires every other header field and operation to remain unchanged. If Kondor exceeds that maximum, lower Max mana in its advanced controls and sign again. Do not edit the already signed JSON.
5. Download the verified signed JSON, return it to the node computer and choose **Import signed JSON**. Confirm and broadcast. For registration, wait for confirmation and **Verify registration** before starting production.

This page never requests a private key, uploads the JSON to KoinosKit's website, or requests a broadcast. Kondor itself may contact its configured RPC to simulate the transaction before returning a signature, so this is an online wallet workflow. Protect signed files; the 15-minute expiry is enforced by KoinosKit, not by the blockchain.

If Kondor is missing, locked, denied, or its popup is closed, the page reports the error or times out. Close any pending Kondor prompt before retrying. If the draft expires, prepare a fresh one. For Harbinger or a fully offline signing machine, use the CLI helper below. The signer supports one ordinary account signature; multisig and contract-wallet authorization remain unsupported.

The signer uses a pinned Kondor JS SDK and the website's locked Koilib 9.3.0 bundle, with no CDN scripts, analytics or persistent transaction storage. `scripts/export-producer-signer.js` copies the exact UI and shared validator to the website checkout and records their hashes. Automated tests cover the browser SDK message flow with disposable test keys; installed-extension approvals and real-network confirmation still need tester validation.

## Offline signing helper

The repository includes `scripts/sign-producer-transaction.js`. On the **separate signing machine**, obtain a reviewed copy of this revision and install its pinned dependencies with `npm ci` before disconnecting. The helper uses Koilib serialization/signing with **no Provider and no network calls**.

Inspect the transaction first:

```sh
node scripts/sign-producer-transaction.js unsigned.json
```

This prints the transaction ID, chain ID, payer, mana limit, nonce and **decoded actual operations**, rather than trusting the descriptive summary in the exported file. Independently verify:

- The chain ID is the intended Koinos network, using a trusted wallet/RPC or previously verified network configuration.
- Contract addresses are the intended network's canonical KOIN/VHP/PoB contracts.
- Registration names your cold producer and the hot public key you copied.
- A burn credits VHP to your producer. Current KCS-4 KOIN requires an exact-amount approval followed by the burn in the same transaction.
- Transfers use the intended token, recipient and amount. Decoded token quantities and mana limits are satoshis (8 decimal places).

After reviewing, sign with the existing WIF file **on that separate machine**:

```sh
node scripts/sign-producer-transaction.js unsigned.json /secure/producer.wif signed.json REVIEWED_TRANSACTION_ID VERIFIED_CHAIN_ID
```

Replace the last two arguments with the reviewed ID and independently verified chain ID. On Windows, use the corresponding file paths. Only file paths and public identifiers are command arguments; the helper never prints the key. It refuses to overwrite an existing output file.

Return only `signed.json` to KoinosKit. The desktop accepts the exact prepared transaction plus the producer's signature, or a lower positive mana limit with a correctly recomputed ID and signature. It rejects changed contents, another signer's signature, a changed hot registration key, changed network/account nonce and expired drafts. It rechecks the chain ID and next nonce before submission. Drafts expire locally after 15 minutes; this is an application check, not an on-chain expiry guarantee. Signing an account transaction authorizes its contents, so protect unused signed files too.

Registration, burn, KOIN transfer and VHP transfer use this same flow. The initial implementation supports a single ordinary producer-account signature; smart-contract/multisig wallet authorization and unattended remote signers are not supported. A compatible wallet may sign the raw prepared transaction instead of the helper, provided it preserves all operations and header fields other than the permitted mana reduction.

Submission consumes the local draft before broadcasting. If the response is uncertain, check the transaction ID in the explorer before preparing another payment. KoinosKit never automatically retries a funds operation.

## Hot-key backup and rotation

The hot key authorizes blocks, not transfers from the external account. It is still a secret: restrict node-data access and keep an encrypted backup of both hot-key files on separate storage. On Unix KoinosKit creates private files with mode 0600; on Windows protect the node-data directory with your account's file permissions. Do not put keys in support screenshots or issue reports.

For planned rotation: stop the node, click **Rotate hot key**, confirm, then register the new public key using the external wallet. Rotation preserves the previous hot files in the displayed `key-backup-*` directory. This is a recovery copy on the same host, not an off-host backup. Verification must match the new key before KoinosKit starts production again. Keep recovery backups until the new registration is confirmed, then manage them under your normal secure-backup policy.

If the host was compromised, rotate registration from a trusted external machine and rebuild the host. Do not treat a new key generated on a still-compromised host as secure.

## Existing wallet migration and scope

Selecting external mode does not delete existing wallet/session files or old backups. KoinosKit refuses to label its current local-wallet address as an external producer. For actual cold custody, use a producer whose account private key has never been on the production host. If the old producer key was stored there, moving it elsewhere does not erase prior exposure; use a new externally controlled account and migrate assets with your wallet's normal reviewed process. This update performs no automatic transfers or wallet deletion.

Verification covers setup without the cold WIF, persistent configuration, hot-key reuse/rotation, exact signed-transaction validation, nonce/network checks, and disabled local/automatic signing. No real funds are moved by development tests. Actual mainnet signing remains an explicit user operation.

## Sign with Koin Vault on your phone

1. Stop the node. Open **Node → Producer wallet custody → Koin Vault → Connect Koin Vault**.
2. In Koin Vault on your phone, choose **Connect App** and scan the QR. Approve the connection with your fingerprint or device passkey. You can also open/copy the connection link. Keep this link private and keep the wallet open while approving requests.
3. In KoinosKit, check the connected address and click **Use this producer wallet**. This saves external custody and turns off automatic burns/transfers. It does not move funds from any previous wallet.
4. Click **Generate hot key**. In the Koin Vault section select **Register hot public key**, then **Review and sign with Koin Vault**. Check the producer address and full hot public key in KoinosKit and the wallet. Approve in Koin Vault; that approval submits the transaction.
5. Click **Verify registration** in KoinosKit. Once the on-chain key matches, the node can produce blocks for that wallet. Fund that producer address and approve a burn to VHP through the same Koin Vault section as needed.

For burns, the confirmation shows the permanent KOIN burn amount and the same-wallet VHP destination. For transfers, it shows token, amount and full recipient. Each action requires its own wallet approval. Your phone's fingerprint/device passkey signs through Koin Vault's smart-account flow; it is never exported to KoinosKit. The local block key handles normal block production without repeated fingerprint prompts.

Connections last up to 30 minutes and requests up to 10 minutes. KoinosKit retains the producer address across restarts, but keeps connection credentials only in memory: reconnect after restarting KoinosKit. Disconnecting revokes the connection and unsubmitted requests; it does not switch custody, stop the node or reverse a submitted transaction. If a network error leaves delivery uncertain, check Koin Vault before retrying, or disconnect successfully first. Changing custody or hot keys while approval is pending is blocked.

This integration uses Koinos Mainnet, when Mainnet is selected. Koin Vault prepares its own sponsored smart-account transaction; this is separate from importing a Kondor signature. KoinosKit compares the submitted operations and payee with its request on-chain. Registration is independently checked before allowing production. The authoritative wallet backend must expose `features.kaiProducer: true`; deployments with an explicit `DAPP_ORIGINS` setting must include `https://koinoskit.site`.

## Dual-boot signing on one PC

Before preparing in Windows, select **Dual-boot / offline signing — keep this draft for 24 hours**. Download the unsigned JSON, boot Linux and sign with Kondor. Return to Windows, reopen the same KoinosKit profile, and choose **Resume saved draft**. Import the signed JSON, confirm the review and broadcast. Do not generate a new hot key or prepare a replacement draft between these steps.

KoinosKit saves the original unsigned draft locally; a signed file cannot replace that reference. A new draft replaces the old one. Changing custody, generating/rotating a hot key, or attempting broadcast clears the pending draft. A changed account nonce requires preparing and signing again. The 24-hour limit is a KoinosKit validation limit, not a blockchain-enforced expiry; protect signed files even after it passes.

## Development and release checks

The protocol identifier `kai-producer-transaction-v1` is retained for compatibility with the reviewed KAI signer. The Koilib dependency is pinned to 9.3.0 for consistent desktop/browser serialization. Run `npm test` for backend checks. Run `npx playwright install chromium`, then set `KOINOSKIT_TEST_BROWSER=1` and run `npm test` to include the renderer and Kondor SDK integration checks. These use disposable keys and simulated wallet approvals, and move no real funds.

To publish the same signer on the KoinosKit website, run `node scripts/export-producer-signer.js ../koinoskit/producer-signer`. This exports the pinned browser bundle and licenses along with a SHA-256 manifest. Run `node scripts/verify-producer-signer-network.js` to verify the fixed read-only Mainnet RPC and browser CORS before releasing.

Koin Vault uses the existing `kaiProducer`, `kaiProductionAllowance`, and `kaiBurnFullVhp` protocol capability names, with **KoinosKit** as the connection name and `https://koinoskit.site` as its origin. Wallet deployments must allow that origin or enable open dapp connections. An unavailable capability or refused origin is reported before requesting approval.

Before publishing installers, validate an installed Kondor extension and a Koin Vault phone approval, and repeat the Windows → Linux → Windows workflow on a real dual-boot PC. Browser tests simulate extension responses; they do not claim hardware or mainnet validation.
