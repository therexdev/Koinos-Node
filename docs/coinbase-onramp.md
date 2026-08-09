# Set up the "Buy ETH with Coinbase" button

The Fund node tab can open Coinbase Pay with your ETH address pre-filled. Since
mid-2025 Coinbase requires the purchase to be authorized by a **session token**
that is minted with your **CDP secret key** — so it can't live inside the
desktop app. You deploy a tiny endpoint that mints those tokens and paste its
URL into KoinosKit.

You do this once. It's free, you don't need a business, and you don't earn or
pay anything — Coinbase charges the buyer directly.

> Don't want to bother? You can skip all of this. Just use the ETH address shown
> in the Fund tab and send ETH to it from any exchange or wallet.

## 1. Get a free Coinbase Developer (CDP) key

1. Go to the [CDP Portal](https://portal.cdp.coinbase.com/) and sign in (email + 2FA — an individual account is fine).
2. Create a **Secret API Key**. You'll get a **key id** and a **key secret**.
3. Keep both somewhere safe — you'll paste them as environment variables next.

## 2. Deploy the endpoint (Vercel — easiest, free)

The endpoint is in this repo under [`onramp-endpoint/`](../onramp-endpoint). It's
one function (`api/session.js`) plus a `package.json`.

**Option A — Vercel web (no terminal):**
1. Put the `onramp-endpoint/` folder in its own GitHub repo (or fork this one).
2. On [vercel.com](https://vercel.com), **Add New → Project**, import that repo, set the **Root Directory** to `onramp-endpoint`.
3. Under **Environment Variables**, add:
   - `CDP_API_KEY_ID` = your CDP key id
   - `CDP_API_KEY_SECRET` = your CDP key secret
4. **Deploy.** Your endpoint URL will be `https://<your-project>.vercel.app/api/session`.

**Option B — Vercel CLI:**
```bash
cd onramp-endpoint
npm install
npm i -g vercel
vercel            # follow prompts
vercel env add CDP_API_KEY_ID
vercel env add CDP_API_KEY_SECRET
vercel --prod
```

(The same function works on Netlify or any Node serverless host — it just needs
the two env vars and Node 18+. Cloudflare Workers use a different runtime, so
prefer a Node host.)

## 3. Paste the URL into KoinosKit

In the app: **Fund node → Coinbase Onramp endpoint**, paste
`https://<your-project>.vercel.app/api/session`, and **Save**. The "Buy ETH with
Coinbase" button now works.

## Test it

```bash
curl -s -X POST https://<your-project>.vercel.app/api/session \
  -H 'content-type: application/json' \
  -d '{"address":"0x0000000000000000000000000000000000000000","asset":"ETH","network":"ethereum"}'
```
A healthy response looks like `{"token":"..."}`. Errors come back as
`{"error":"..."}` with the reason.

## The function

See [`onramp-endpoint/api/session.js`](../onramp-endpoint/api/session.js). It:
1. reads the ETH address from the request,
2. generates a CDP JWT with `generateJwt` from `@coinbase/cdp-sdk`,
3. calls `POST https://api.developer.coinbase.com/onramp/v1/token` with
   `{ addresses: [{ address, blockchains: ["ethereum"] }], assets: ["ETH"] }`,
4. returns `{ token }`.

The desktop app then opens
`https://pay.coinbase.com/buy/select-asset?sessionToken=<token>&defaultAsset=ETH&defaultNetwork=ethereum`.

## Notes & security

- The secret key lives **only** in your endpoint's environment variables, never in the app.
- The endpoint only mints session tokens for an address the caller supplies; it can't move funds. If you want to limit who can call it, add a shared secret header or an allowlist — but it's low-risk since Coinbase bills the buyer.
- Session tokens expire after ~5 minutes, which is why they're minted on demand each time you click Buy.
- Coinbase Onramp availability and payment methods depend on the buyer's region; the hosted Coinbase Pay page handles all KYC/limits.
- Source of truth for the API: Coinbase's official [onramp-demo-application](https://github.com/coinbase/onramp-demo-application) and [Create session token](https://docs.cdp.coinbase.com/api-reference/rest-api/onramp-offramp/create-session-token) docs. If Coinbase changes the SDK import path or fields, follow the demo.
