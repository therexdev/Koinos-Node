# Cloud node from your phone — architecture & roadmap

Goal: someone with **only a phone** runs **their own** Koinos block producer in the
cloud — keeping their stake, their vote, and 100% of rewards — instead of handing
it to a pool. Turnkey managed hosting (we run the fleet), PWA-first phone app.

## Why it's self-sovereign, not a pool

Koinos separates two keys, and the app already uses this (`chain.js` →
`pob.register_public_key`):

- **Main key (stays on the phone):** holds KOIN/VHP, burns KOIN→VHP, registers the
  producer key, votes on governance, and receives 100% of block rewards (minted
  straight to the user's address). Never leaves the device.
- **Block-signing key (lives on the cloud node):** can do exactly one thing —
  sign blocks for the registered producer address. It cannot move funds or vote.
  If it's ever compromised, the user just re-registers a new key from their phone;
  funds and vote are never exposed.

So the cloud box is a **dumb, replaceable block-signer** the user rents. That's the
whole difference from a pool (which holds your stake, votes for you, takes a cut).

## Components

1. **PWA (phone)** — installable mobile web app. Reuses our existing `koilib`
   wallet + chain logic (browser-adapted: Web Crypto + IndexedDB instead of
   Node crypto + a keystore file). Screens: wallet, fund (reuse the ETH→KOIN
   flow), burn→VHP, **Start my node**, node status/rewards, governance vote,
   subscription.
2. **Control plane (our backend)** — provisions + manages the fleet: one isolated
   node per user, health/restart/upgrades, billing, and an API the PWA calls
   (start/stop/status/logs, and the node's block-signing public key to register).
   Never holds the user's main key.
3. **Node image + agent (each cloud box)** — the existing `node-template` docker
   compose + quick-sync-from-backup, plus a small agent that: generates the
   block-signing key locally, exposes its **public** key + sync/status to the
   control plane, and applies start/stop. Same unit whether we use one VM per
   user or dense containers.

## Security model

- The control plane and node boxes **only ever hold block-signing (hot) keys**,
  scoped to producing blocks. The user's main key is client-side only.
- Registration flow: node generates keypair → agent reports the **public** key →
  PWA asks the user to sign `register_public_key` with their **main key** →
  broadcast. The user can re-register or unregister anytime from the phone.
- Rewards mint to the user's address; we never custody them.

## Cost reality (drives the subscription)

- A full node is always-on: ~2–4 GB RAM, ~30–60 GB storage (grows), 24/7.
- Cheapest viable ≈ **$6–15/mo** of cloud per node (e.g., Hetzner/DO), so the
  subscription must cover that + ops + margin.
- **Quick-sync-from-backup** (already built) makes a fresh cloud node ready in
  minutes, not days — critical for a good "Start my node" experience.
- Density (1 VM/user vs many containers/host) is the main cost lever; start simple
  (1 VM/user), optimize later.

## Roadmap

- **Phase 1 — Node unit (de-risk the core):** a provisioning script + agent that
  turns a bare Ubuntu VM into a running, quick-synced node that generates a
  block-signing key and reports status. The replicable unit the whole service is
  built on. Testable on any single VM.
- **Phase 2 — PWA:** browser-adapted wallet + chain (reuse `koilib`), node
  status/monitor, and the `register_public_key` flow. Works against a Phase-1 node
  by RPC.
- **Phase 3 — Control plane + billing:** fleet orchestration (spin up per user,
  monitor, upgrade), subscription billing, isolation, dashboards.
- **Phase 4 — Native app** (wrap/rebuild once proven), push notifications.

## Decisions needed before Phase 3 (not before Phase 1)

- Cloud provider (Hetzner = cheapest, DigitalOcean = easy API, AWS/GCP = scale).
- Node density (1 VM/user vs container density) and the resulting price point.
- Billing (card via Stripe, or crypto/KOIN subscription) and monthly price.
- PWA domain/branding.
