# Twomey Household Wealth Console

A personal wealth console: net worth, cash flow, money-leak detection, 0% APR promo
tracking, and a 30-year projection engine — running against real accounts via Plaid.

## Two ways to run it

| | What it shows | Where |
|---|---|---|
| **`twomey-console-demo.html`** | A worked demo on fictional data. Fully interactive, self-contained, no server. | Open the file, or GitHub Pages |
| **`app/index.html` + `server/`** | **Your real accounts**, live via Plaid. | `localhost` only |

### The live demo link only shows the demo

GitHub Pages serves static files. It cannot run the Node server, so it cannot reach
Plaid and has no access to your data. Opening `app/index.html` from Pages will show a
**"Demo data"** banner and the fixture numbers — by design.

That is not a limitation to work around. Exchanging a Plaid `public_token` requires your
**secret**, which can never live in browser-delivered code. The server exists for exactly
that reason.

## Running the real dashboard

```bash
cd server
npm install
cp .env.example .env      # then fill in your Plaid keys
npm run verify            # confirms the keys work
npm start                 # http://127.0.0.1:4800
```

See [SETUP.md](SETUP.md) for the full walkthrough, including Plaid production access.

## What is deliberately not in this repository

- `server/.env` — Plaid client ID and secret
- `server/data/store.json` — your accounts, balances and transactions
- `server/data/.key` — the AES-256-GCM key that encrypts your Plaid access tokens

All three are gitignored. **Nothing in this repository contains financial data or
credentials.** If you ever see one of them appear in `git status`, stop and fix the
ignore rules before committing.

## Layout

```
twomey-console-demo.html   self-contained demo (fixture data)
app/index.html          the live client
server/server.js        Express API, binds to 127.0.0.1 only
server/normalize.js     Plaid shapes -> dashboard shapes
server/store.js         local store; access tokens encrypted at rest
server/verify.js        credential check + sandbox seeder
server/doctor.js        post-sync diagnostic
server/test-normalize.js  39 assertions against Plaid-shaped payloads
```

```bash
cd server && npm test     # run the normalizer test suite
```

## Security posture

- Server binds to `127.0.0.1`; nothing on your network can reach it
- Cross-origin API requests rejected
- Read-only Plaid scopes only (`transactions`, `liabilities`, `investments`) — no
  payment scope is requested, so moving money is not technically possible
- Unlinking calls Plaid `/item/remove`, invalidating the token on their side too
- Access tokens encrypted at rest with AES-256-GCM

## Not investment advice

Projections are arithmetic applied to assumptions you supply. They are not forecasts,
not recommendations, and make no allowance for taxes, fees, or sequence-of-returns risk.
