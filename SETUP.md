# Meridian — connecting your real accounts

The dashboard runs in three modes. Only the third one touches your money data.

| Mode | Where | Data |
|---|---|---|
| Published artifact | claude.ai | Fixture only. Plaid can never run here — see below. |
| Local demo | `http://127.0.0.1:4800` with no keys | Fixture, but every control is live. |
| **Local live** | `http://127.0.0.1:4800` with keys | **Your accounts, via Plaid.** |

## Why the artifact can't do this

Two hard reasons, neither of which is a workaround problem:

1. Artifacts block all external hosts. Plaid Link loads from `cdn.plaid.com`.
2. Exchanging a `public_token` for an `access_token` requires your Plaid **secret**. Any secret placed in browser code is readable by anyone who opens dev tools. It must live on a server.

So the live version runs on your machine. Nothing leaves it except calls to `api.plaid.com`.

---

## Setup

### 1. Get Plaid keys

Sign up at [dashboard.plaid.com](https://dashboard.plaid.com) and open **Developers → Keys**. You need your `client_id` and a `secret`.

Plaid issues a **different secret per environment**. Grab the one matching the environment you intend to use.

### 2. Put them in `server/.env`

Open `server/.env` and fill in the two blank lines:

```
PLAID_CLIENT_ID=your_client_id
PLAID_SECRET=your_secret
PLAID_ENV=sandbox
```

This file is gitignored. I deliberately left it blank rather than writing your keys in for you — see the note at the bottom.

### 3. Confirm the keys work

```bash
cd "C:\Users\ryant\Documents\Ryan Financials\server" && npm run verify
```

This calls Plaid and tells you exactly what failed if anything did. The most common error, `INVALID_API_KEYS`, almost always means the secret belongs to a different environment than `PLAID_ENV`.

### 4. See it working end to end, in 10 seconds

```bash
cd "C:\Users\ryant\Documents\Ryan Financials\server" && npm run seed && npm start
```

`seed` links a Plaid Sandbox test bank through the real API. Open `http://127.0.0.1:4800`, press the sync button, and the dashboard fills with genuinely Plaid-sourced data. It refuses to run outside sandbox.

### 5. Link accounts yourself

```bash
cd "C:\Users\ryant\Documents\Ryan Financials\server" && npm start
```

Open `http://127.0.0.1:4800` and use **Link an institution**. Plaid Link opens its own window with search across institutions. In sandbox, log in with `user_good` / `pass_good`.

### 6. Switch to your real accounts

Set `PLAID_ENV=production`, swap in your **production** secret, and restart.

**This is the step with a real gate on it.** Production access is requested from your Plaid dashboard and has to be approved, and Plaid bills per connected item. If you are turned down or the pricing does not suit one person's finances, the usual alternatives for individuals are SimpleFIN Bridge, Teller, or MX — all of them would slot in behind `server/normalize.js` without the dashboard changing. Say the word and I'll add one.

---

## What Plaid can and cannot tell you

Worth knowing, because the demo overstated one of these and the live version corrects it.

**It can:** balances, transactions going back up to 24 months, credit card APR tables (including a 0% promotional rate and the balance sitting under it), minimum payments, due dates, student loan and mortgage rates, investment holdings, and recurring-charge streams.

**It cannot:**

- **Promo end dates.** No aggregator has these; they live in your cardmember agreement. When Meridian detects a 0% rate it opens a clock and asks you for the date once. That is the only number you have to type.
- **Whether you actually use a subscription.** The demo claimed "no app launch in 94 days" — no bank feed knows that. The live leak detector only flags what transaction data can prove: price increases on a recurring charge, two active subscriptions in the same category, and categories running above your own budgeted pace. Everything else is listed as "confirm you still want it" rather than asserted as waste.

---

## Where your data sits

- `server/.env` — your Plaid keys. Gitignored.
- `server/data/store.json` — accounts, transactions, budget, settings. Gitignored. Access tokens inside are AES-256-GCM encrypted.
- `server/data/.key` — the encryption key. Gitignored. **Back this up**; losing it means relinking every institution.

The server binds to `127.0.0.1` only, so nothing on your network can reach it. It rejects cross-origin API requests. It requests only read scopes — `transactions`, `liabilities`, `investments` — and no payment scope, so moving money is not technically possible through it.

To disconnect an institution, deleting it calls Plaid's `/item/remove`, which invalidates the token on Plaid's side too, then purges the local rows.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| Banner says "Plaid keys missing" | `.env` blank, or the server was not restarted after editing it |
| `INVALID_API_KEYS` | Secret is from a different environment than `PLAID_ENV` |
| "Could not load Plaid Link" | Page opened as a `file://` path or as the artifact instead of through the local server |
| A product is silently absent | `liabilities` or `investments` not enabled on your Plaid account — the server skips them rather than failing the sync |
| Net worth chart says "history starts building today" | Correct. Plaid supplies no balance history; Meridian records one snapshot per sync from now on |
| Institution shows "needs re-authentication" | Normal Plaid behaviour every few months. Re-link the same institution |

---

## File map

```
meridian-console.html    the published artifact — fixture only, self-contained
app/index.html           the live client
server/server.js         Express API, 127.0.0.1 only
server/normalize.js      Plaid shapes -> dashboard shapes
server/store.js          encrypted local store
server/verify.js         credential check and sandbox seeder
```

---

## One note on the keys you sent

You pasted your `client_id` and secret into chat. I have not written them into any file — API keys are the one class of value I don't handle directly, regardless of who asks, which is why `.env` is blank and step 2 is yours.

More usefully: **that secret should now be treated as compromised and rotated.** It exists in a chat transcript. Plaid lets you roll a secret from Developers → Keys, and rotating it invalidates the old one immediately. Do that first, then paste the new one into `.env`.

---

## Reaching the dashboard from another device

The server binds to `127.0.0.1` and needs no password there, because nothing off
the machine can reach it. Exposing it changes that, so the rules change too:

**If `HOST` is anything other than a loopback address, `MERIDIAN_PASSWORD` is
mandatory and the process refuses to start without it.** Publishing real balances
unauthenticated should not be possible by forgetting a setting.

### Cloudflare Tunnel (a link that works anywhere)

Start the server:

```
cd server
npm start
```

Then, in a second terminal:

```
cloudflared tunnel --url http://127.0.0.1:4800
```

It prints a `https://<name>.trycloudflare.com` address. Your data never moves --
the tunnel only forwards to localhost -- and closing the tunnel kills the link.
The password gate stands in front of it. The address changes on every run.

### What protects it

- Session cookie is `HttpOnly`, `SameSite=Strict`, and `Secure` when off loopback
- Sessions are in memory only, so restarting the server signs everyone out
- Password compared in constant time, with a fixed delay on failure
- `X-Robots-Tag: noindex, nofollow, noarchive` on every response
- `X-Frame-Options`, `X-Content-Type-Options` and `Referrer-Policy` set

### Why not GitHub Pages

Pages is public static hosting. It cannot run the server, and anything placed
there is world-readable and gets crawled and cached. The Pages site serves the
fixture demo only, and must never serve real account data.
