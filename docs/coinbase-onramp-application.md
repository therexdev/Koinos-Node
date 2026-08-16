# Coinbase Onramp application — responses to CDP

Draft answers to CDP's application questions for **Koinos Node Desktop**
(this repository). Copy/adapt these into the reply to Coinbase.

## ⚠️ Before sending — deploy the backend first

CDP will test the URLs in answer 4, so the session-token backend must be live
before this reply goes out. The website (koinoskit.site) is static GitHub
Pages and cannot host it; the backend is the small serverless function in
[`onramp-endpoint/`](../onramp-endpoint), deployed for free on Vercel
(~5 minutes, full steps in [coinbase-onramp.md](coinbase-onramp.md)):

1. On [vercel.com](https://vercel.com) (free hobby account): **Add New →
   Project**, import this GitHub repo, set **Root Directory** to
   `onramp-endpoint`, and **name the project `koinos-node`** — that makes the
   URL `koinos-node.vercel.app`, which is what the desktop app already uses as
   its built-in default. (A different name or a custom domain like
   `api.koinoskit.site` works too — then update `DEFAULT_ONRAMP_ENDPOINT` in
   `electron/main.js` and `DEFAULT_SPONSOR_ENDPOINT` in
   `electron/lib/sponsor-relay.js` / `electron/lib/bridge-orchestrator.js`.)
2. Set the environment variables: `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`
   (from the [CDP Portal](https://portal.cdp.coinbase.com/) → Secret API Key)
   and `ONRAMP_SHARED_SECRET` (the app key from the docs). The endpoint
   fails closed without the shared secret. (`KOINOS_SPONSOR_WIF` is only for
   the mana relayer — not needed for the Onramp review.)
3. Verify with the curl commands in [coinbase-onramp.md](coinbase-onramp.md):
   with the `x-koinoskit-app` header you get `{"token":"..."}`; without it,
   `{"error":"Unauthorized"}`.

---

## 1. Complete end-to-end flow and example use cases

**What the app is.** Koinos Node Desktop is a free, open-source desktop
application (Electron; Windows, macOS, Linux) that lets anyone run a Koinos
blockchain block-producer node: it creates a self-custody wallet locally,
manages the official Koinos node in Docker, and automates staking (burning KOIN
into VHP) and reward compounding. Source: https://github.com/therexdev/Koinos-Node

**Where Onramp fits.** A brand-new user owns no crypto, but needs KOIN to
stake. The app's **Fund node** tab closes that gap with Coinbase Onramp:

1. The app derives an **Ethereum funding address from the user's own
   locally-generated key** (the private key never leaves their machine).
2. The user clicks **"Buy ETH with Coinbase"**. The desktop app calls our
   backend session endpoint (`POST /api/session`, a serverless function we
   host) with the user's ETH address. The request is authenticated with an
   app API key sent in the `x-koinoskit-app` header; unauthenticated requests
   are rejected before Coinbase is ever contacted.
3. The backend — which alone holds the CDP secret API key — signs a CDP JWT
   and calls `POST https://api.developer.coinbase.com/onramp/v1/token` with
   `{ addresses: [{ address: <user's address>, blockchains: ["ethereum"] }],
   assets: ["ETH"] }`, and returns the session token to the app.
4. The app opens the hosted Coinbase Pay page in the user's browser:
   `https://pay.coinbase.com/buy/select-asset?sessionToken=<token>&defaultAsset=ETH&defaultNetwork=ethereum`.
   The user completes KYC and payment entirely on Coinbase's hosted flow.
5. Coinbase delivers the purchased ETH **directly on-chain to the user's own
   self-custodied address** — it never passes through us.
6. Back in the app, the user bridges/swaps in-app to native KOIN (via the
   Vortex bridge and KoinDX/Uniswap; our relayer sponsors the Koinos
   transaction fees, "mana", so a brand-new account can transact), then burns
   KOIN into VHP and starts producing blocks.

**Example use cases**

- *Zero-to-node onboarding:* a user with no crypto installs the app, buys a
  small amount of ETH with a card via Coinbase Onramp, and ends up with a
  staked, block-producing Koinos node — without ever touching an exchange.
- *Top-up:* an existing node operator whose liquid KOIN is running low (KOIN
  is consumed as staking VHP and as mana for transactions) buys more through
  the same flow.
- *Funding wallet operations:* small purchases to cover on-chain actions such
  as producer-key registration and reward-return transactions.

## 2. Wallet custody model

**Fully self-custodial (non-custodial).** The wallet is generated locally on
the user's machine with a CSPRNG, encrypted at rest with scrypt +
AES-256-GCM using the user's password, and the private key never leaves the
user's device. The same locally-held key controls both the Koinos wallet and
the Ethereum funding address used with Onramp. We (the developer) operate no
account system and no key storage; our backend holds no user keys and cannot
access or move user funds.

## 3. Who holds custody of the Onramp-ed funds?

**The end user, exclusively.** The session token is minted for the user's own
self-custodied Ethereum address, and Coinbase settles the purchase directly
on-chain to that address. At no point do we, or any service we operate, take
possession of the funds. Subsequent bridging/swapping to KOIN is signed
locally by the user's own key and lands in the same user's self-custodied
Koinos wallet.

## 4. URLs / links where Onramp is integrated

- **Production session-token backend:** `https://koinos-node.vercel.app/api/session`
  (POST, authenticated with the `x-koinoskit-app` app key; source in
  [`onramp-endpoint/api/session.js`](../onramp-endpoint/api/session.js)).
  *Goes live with the deployment step above — swap in your actual URL if you
  chose a different project name or domain.*
- **Production desktop app (installers for Windows/macOS/Linux):**
  https://github.com/therexdev/Koinos-Node/releases/latest — it's a desktop
  app, so there is no TestFlight build; to review the flow, install the app
  (or `npm install && npm start` from source), open the **Fund node** tab,
  and click **Buy ETH with Coinbase**.
- **Full source of the integration:** https://github.com/therexdev/Koinos-Node
  — session-token backend under `onramp-endpoint/`, desktop-side flow in
  `electron/main.js` (`fund:buyUrl`), Fund tab UI in `ui/renderer.js`,
  documentation in `docs/coinbase-onramp.md`.

## 5. Onramp usage intent

We use Coinbase Onramp solely as a **fiat → crypto onboarding ramp for
self-custody users** of an open-source node-runner app: users buy ETH (on
Ethereum mainnet) delivered straight to their own address, which the app then
helps them convert to KOIN for staking on the Koinos network. Expected
volumes are small and retail-sized — individual node operators making a
one-time onboarding purchase and occasional top-ups (the in-app bridge is
currently capped at ~0.05 ETH per run). We take no fees on purchases, never
pool or hold user funds, and do not resell the service; Onramp simply
replaces the "go buy ETH on an exchange and withdraw it" step that stops
non-crypto-native users from running a node.

## Security requirements compliance

Per https://docs.cdp.coinbase.com/onramp/security-requirements:

- **Backend authentication before minting session tokens:** the session
  endpoint requires an app API key in the `x-koinoskit-app` header and
  rejects unauthenticated callers (HTTP 401) before any request is made to
  Coinbase. A deployment with no key configured fails closed. Requests are
  additionally rate-limited per IP.
- **CDP secret key isolation:** the CDP secret API key exists only in the
  backend's environment variables; the desktop app never sees it. Session
  tokens are minted per-request and are short-lived.
- **No wildcard CORS:** the backend never sets
  `Access-Control-Allow-Origin: *`. By default no CORS headers are emitted at
  all (the desktop app calls the backend from its main process, where CORS
  does not apply); an explicit origin can be configured for web deployments.
