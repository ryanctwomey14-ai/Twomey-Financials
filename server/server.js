/**
 * Meridian local server.
 *
 * Binds to 127.0.0.1 only. Your Plaid secret stays in server/.env, your access
 * tokens stay encrypted in server/data/, and no request from this process goes
 * anywhere except api.plaid.com.
 */
import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Configuration, PlaidApi, PlaidEnvironments, Products, CountryCode } from "plaid";
import * as store from "./store.js";
import { buildState } from "./normalize.js";
import { fetchPrices } from "./prices.js";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4800);
const ENV = (process.env.PLAID_ENV || "sandbox").toLowerCase();
const CLIENT_ID = process.env.PLAID_CLIENT_ID || "";
const SECRET = process.env.PLAID_SECRET || "";
const WEBHOOK = process.env.PLAID_WEBHOOK_URL || "";

const parseProducts = (v, dflt) =>
  (v ? v.split(",").map(s => s.trim()).filter(Boolean) : dflt);

/* Only `transactions` is required. Liabilities and investments are requested as
 * optional so a bank that lacks them cannot fail the whole link. */
const REQUIRED = parseProducts(process.env.PLAID_PRODUCTS, [Products.Transactions]);
const OPTIONAL = parseProducts(process.env.PLAID_OPTIONAL_PRODUCTS, [Products.Liabilities, Products.Investments]);

const configured = Boolean(CLIENT_ID && SECRET);
const plaid = configured
  ? new PlaidApi(new Configuration({
      basePath: PlaidEnvironments[ENV] || PlaidEnvironments.sandbox,
      baseOptions: { headers: { "PLAID-CLIENT-ID": CLIENT_ID, "PLAID-SECRET": SECRET } }
    }))
  : null;

const app = express();
app.use(express.json({ limit: "4mb" }));
app.use(express.static(path.join(DIR, "..", "app")));

app.use("/api", (req, res, next) => {
  if (req.path === "/webhook") return next();          // Plaid posts here, no Origin header
  const o = req.get("origin");
  if (o && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o)) {
    return res.status(403).json({ error: "Cross-origin requests are not accepted." });
  }
  next();
});

const errOf = e => e?.response?.data || null;
const fail = (res, e, where) => {
  const d = errOf(e);
  console.error(`[${where}]`, d || e.message);
  res.status(d ? 400 : 500).json({
    error: d?.error_message || e.message,
    code: d?.error_code || null,
    type: d?.error_type || null,
    where
  });
};

/* Production is rate-limited per item and a fresh item's data is not instantly
 * ready. Both are transient and both deserve a backoff rather than a failure. */
const TRANSIENT = new Set([
  "PRODUCT_NOT_READY", "RATE_LIMIT_EXCEEDED", "INTERNAL_SERVER_ERROR",
  "INSTITUTION_DOWN", "INSTITUTION_NOT_RESPONDING"
]);
async function withRetry(fn, label, tries = 5) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) {
      last = e;
      const code = errOf(e)?.error_code;
      if (!TRANSIENT.has(code) || i === tries - 1) throw e;
      const wait = Math.min(10000, 800 * 2 ** i);
      console.log(`[retry] ${label}: ${code} — retrying in ${wait}ms`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
  throw last;
}

/* Items are tagged with the environment that created them. A sandbox token is
 * meaningless in production and vice versa, so mismatches are held back rather
 * than silently producing wrong totals. */
const liveItems = () => store.read().items.filter(i => (i.env || "sandbox") === ENV);
const strayItems = () => store.read().items.filter(i => (i.env || "sandbox") !== ENV);

/* ---------------- health ---------------- */
app.get("/api/health", (req, res) => {
  const s = store.read();
  res.json({
    configured, env: ENV,
    clientIdTail: CLIENT_ID ? "…" + CLIENT_ID.slice(-4) : null,
    items: liveItems().length,
    strayItems: strayItems().map(i => ({ institutionName: i.institutionName, env: i.env || "sandbox" })),
    snapshots: s.snapshots.length,
    webhook: Boolean(WEBHOOK),
    products: { required: REQUIRED, optional: OPTIONAL },
    node: process.version
  });
});

/* ---------------- link ---------------- */
app.post("/api/link/token", async (req, res) => {
  if (!plaid) return res.status(503).json({ error: "Plaid keys are not configured. Add them to server/.env." });
  try {
    const { itemId } = req.body || {};
    const base = {
      user: { client_user_id: "meridian-local-user" },
      client_name: "Meridian Wealth Console",
      country_codes: [CountryCode.Us],
      language: "en",
      ...(WEBHOOK ? { webhook: WEBHOOK } : {})
    };
    if (itemId) {                                       // update mode: re-auth an existing item
      const item = store.read().items.find(i => i.itemId === itemId);
      if (!item) return res.status(404).json({ error: "Unknown item." });
      const r = await plaid.linkTokenCreate({ ...base, access_token: store.itemToken(item) });
      return res.json({ link_token: r.data.link_token, mode: "update" });
    }
    const r = await plaid.linkTokenCreate({
      ...base,
      products: REQUIRED,
      ...(OPTIONAL.length ? { optional_products: OPTIONAL } : {})
    });
    res.json({ link_token: r.data.link_token, mode: "create" });
  } catch (e) { fail(res, e, "link/token"); }
});

app.post("/api/link/exchange", async (req, res) => {
  if (!plaid) return res.status(503).json({ error: "Plaid keys are not configured." });
  try {
    const { public_token, institution } = req.body || {};
    if (!public_token) return res.status(400).json({ error: "public_token is required." });

    const x = await plaid.itemPublicTokenExchange({ public_token });
    const accessToken = x.data.access_token;
    const itemId = x.data.item_id;

    let institutionName = institution?.name || "Institution";
    let institutionId = institution?.institution_id || null;
    try {
      const it = await plaid.itemGet({ access_token: accessToken });
      institutionId = it.data.item.institution_id || institutionId;
      if (institutionId) {
        const inst = await plaid.institutionsGetById({ institution_id: institutionId, country_codes: [CountryCode.Us] });
        institutionName = inst.data.institution.name;
      }
    } catch { /* name is cosmetic */ }

    store.addItem({ itemId, accessToken, institutionId, institutionName, env: ENV });
    const result = await syncItem(itemId);
    snapshotNow();                       // first net-worth point, so the chart starts immediately
    res.json({ itemId, institutionName, ...result });
  } catch (e) { fail(res, e, "link/exchange"); }
});

/* ---------------- sync ---------------- */
async function paginate(access_token, startCursor) {
  let cursor = startCursor || undefined;
  const added = [], modified = [], removed = [];
  let more = true, guard = 0;
  while (more && guard++ < 120) {
    const r = await plaid.transactionsSync({ access_token, cursor, count: 500 });
    added.push(...r.data.added);
    modified.push(...r.data.modified);
    removed.push(...r.data.removed);
    cursor = r.data.next_cursor;
    more = r.data.has_more;
  }
  return { added, modified, removed, cursor };
}

async function syncItem(itemId) {
  const item = store.read().items.find(i => i.itemId === itemId);
  if (!item) throw new Error("Unknown item.");
  const access_token = store.itemToken(item);

  /* Balances: /accounts/balance/get forces a live pull from the institution.
   * /accounts/get would return Plaid's cached copy, which can be a day stale. */
  let accounts;
  try {
    const r = await withRetry(() => plaid.accountsBalanceGet({ access_token }), "balanceGet");
    accounts = r.data.accounts;
  } catch (e) {
    console.log("[sync] balance/get unavailable, falling back to accounts/get:", errOf(e)?.error_code);
    accounts = (await withRetry(() => plaid.accountsGet({ access_token }), "accountsGet")).data.accounts;
  }
  accounts = accounts.map(a => ({ ...a, itemId }));

  /* If the account set mutates mid-pagination Plaid asks us to start over. */
  let page;
  try {
    page = await withRetry(() => paginate(access_token, item.cursor), "transactionsSync");
  } catch (e) {
    if (errOf(e)?.error_code === "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION") {
      console.log("[sync] account set changed mid-pagination, restarting from saved cursor");
      page = await paginate(access_token, item.cursor);
    } else throw e;
  }

  let liabilities = null, recurring = null;
  try { liabilities = (await withRetry(() => plaid.liabilitiesGet({ access_token }), "liabilitiesGet")).data; }
  catch (e) { console.log("[sync] liabilities skipped:", errOf(e)?.error_code || e.message); }
  try {
    recurring = (await withRetry(() => plaid.transactionsRecurringGet({
      access_token, account_ids: accounts.map(a => a.account_id)
    }), "recurringGet")).data;
  } catch (e) { console.log("[sync] recurring skipped:", errOf(e)?.error_code || e.message); }

  store.update(st => {
    const it = st.items.find(i => i.itemId === itemId);
    it.cursor = page.cursor;
    it.lastSync = new Date().toISOString();
    it.status = "ok";
    it.error = null;

    st.accounts = [...(st.accounts || []).filter(a => a.itemId !== itemId), ...accounts];

    const gone = new Set(page.removed.map(r => r.transaction_id));
    const changed = new Set(page.modified.map(m => m.transaction_id));
    const keep = (st.transactions || []).filter(t =>
      t.itemId !== itemId || (!gone.has(t.transaction_id) && !changed.has(t.transaction_id)));
    st.transactions = [...keep,
      ...page.added.map(t => ({ ...t, itemId })),
      ...page.modified.map(t => ({ ...t, itemId }))];

    st.liabilitiesByItem = { ...(st.liabilitiesByItem || {}), [itemId]: liabilities };
    st.recurringByItem = { ...(st.recurringByItem || {}), [itemId]: recurring };
  });

  return {
    accounts: accounts.length,
    added: page.added.length,
    modified: page.modified.length,
    removed: page.removed.length,
    liabilities: Boolean(liabilities),
    investments: accounts.some(a => a.type === "investment")
  };
}

app.post("/api/sync", async (req, res) => {
  if (!plaid) return res.status(503).json({ error: "Plaid keys are not configured." });
  const items = liveItems();
  if (!items.length) return res.json({ items: 0, results: [] });
  const results = [];
  for (const item of items) {
    try {
      results.push({ itemId: item.itemId, institution: item.institutionName, ...(await syncItem(item.itemId)) });
    } catch (e) {
      const code = errOf(e)?.error_code || null;
      store.update(st => {
        const it = st.items.find(i => i.itemId === item.itemId);
        if (it) { it.status = code === "ITEM_LOGIN_REQUIRED" ? "reauth" : "error"; it.error = code || e.message; }
      });
      results.push({ itemId: item.itemId, institution: item.institutionName, error: code || e.message });
    }
  }
  try { await refreshCryptoPrices(); } catch (e) { console.log("[prices]", e.message); }
  snapshotNow();
  res.json({ items: items.length, results, at: new Date().toISOString() });
});

/* ---------------- webhook ----------------
 * Only reachable if PLAID_WEBHOOK_URL points at a public tunnel. Without one,
 * pressing sync is the refresh path — which is fine for a single user. */
app.post("/api/webhook", async (req, res) => {
  const { webhook_type, webhook_code, item_id } = req.body || {};
  console.log(`[webhook] ${webhook_type}/${webhook_code} ${item_id || ""}`);
  res.json({ ok: true });                                // acknowledge fast, work after
  try {
    if (webhook_code === "ITEM_LOGIN_REQUIRED") {
      store.update(st => {
        const it = st.items.find(i => i.itemId === item_id);
        if (it) { it.status = "reauth"; it.error = "ITEM_LOGIN_REQUIRED"; }
      });
    } else if (["SYNC_UPDATES_AVAILABLE", "DEFAULT_UPDATE", "TRANSACTIONS_REMOVED"].includes(webhook_code)) {
      if (store.read().items.some(i => i.itemId === item_id)) { await syncItem(item_id); snapshotNow(); }
    }
  } catch (e) { console.error("[webhook]", e.message); }
});

/* ---------------- state ---------------- */
function assemble() {
  const s = store.read();
  const live = liveItems();
  const ids = new Set(live.map(i => i.itemId));
  const liabilities = { credit: [], student: [], mortgage: [] };
  for (const [itemId, l] of Object.entries(s.liabilitiesByItem || {})) {
    if (!ids.has(itemId) || !l?.liabilities) continue;
    for (const k of ["credit", "student", "mortgage"]) liabilities[k].push(...(l.liabilities[k] || []));
  }
  const recurring = { outflow_streams: [], inflow_streams: [] };
  for (const [itemId, r] of Object.entries(s.recurringByItem || {})) {
    if (!ids.has(itemId) || !r) continue;
    recurring.outflow_streams.push(...(r.outflow_streams || []));
    recurring.inflow_streams.push(...(r.inflow_streams || []));
  }
  return buildState({
    items: live,
    accounts: (s.accounts || []).filter(a => ids.has(a.itemId)),
    transactions: (s.transactions || []).filter(t => ids.has(t.itemId)),
    liabilities, recurring, store: s
  });
}

function snapshotNow() {
  const st = assemble();
  store.recordSnapshot(st.totals.assets, st.totals.liabilities);
}

app.get("/api/state", (req, res) => {
  try {
    if (!liveItems().length) {
      return res.json({ live: false, reason: "no-items", configured, env: ENV, strayItems: strayItems().length });
    }
    res.json({ ...assemble(), env: ENV });
  } catch (e) { fail(res, e, "state"); }
});

/* ---------------- items ---------------- */
/* Hide a Plaid-supplied account. It cannot be deleted -- the next sync returns
 * it -- so the id is suppressed at render time and can be restored. */
app.delete("/api/accounts/:id", (req, res) => {
  const id = req.params.id;
  if (!(store.read().accounts || []).some(a => a.account_id === id))
    return res.status(404).json({ error: "No such account." });
  store.update(s => {
    s.settings.hiddenAccounts = [...new Set([...(s.settings.hiddenAccounts || []), id])];
  });
  snapshotNow();
  res.json({ hidden: id, total: store.read().settings.hiddenAccounts.length });
});

app.post("/api/accounts/:id/restore", (req, res) => {
  store.update(s => {
    s.settings.hiddenAccounts = (s.settings.hiddenAccounts || []).filter(x => x !== req.params.id);
  });
  snapshotNow();
  res.json({ restored: req.params.id });
});

app.get("/api/items", (req, res) => {
  res.json(store.read().items.map(({ accessToken, cursor, ...rest }) => rest));
});

app.delete("/api/items/:itemId", async (req, res) => {
  try {
    const item = store.read().items.find(i => i.itemId === req.params.itemId);
    if (!item) return res.status(404).json({ error: "Unknown item." });
    if (plaid && (item.env || "sandbox") === ENV) {
      try { await plaid.itemRemove({ access_token: store.itemToken(item) }); } catch { /* already gone */ }
    }
    store.removeItem(req.params.itemId);
    res.json({ removed: req.params.itemId });
  } catch (e) { fail(res, e, "items/remove"); }
});

/* ---------------- settings ---------------- */
/* Per-account override objects must merge field-by-field: writing postApr alone
 * must not erase an isPromo flag set earlier. */
const mergeById = (a = {}, b = {}) => {
  const out = { ...a };
  for (const [id, v] of Object.entries(b)) out[id] = { ...(a[id] || {}), ...v };
  return out;
};

app.post("/api/settings", (req, res) => {
  const patch = req.body || {};
  store.update(s => {
    s.settings = { ...s.settings, ...patch,
      promoEnds:      { ...(s.settings.promoEnds || {}),      ...(patch.promoEnds || {}) },
      promoStarts:    { ...(s.settings.promoStarts || {}),    ...(patch.promoStarts || {}) },
      promoOverrides: mergeById(s.settings.promoOverrides, patch.promoOverrides),
      txnOverrides:   { ...(s.settings.txnOverrides || {}),   ...(patch.txnOverrides || {}) },
      merchantRules:  { ...(s.settings.merchantRules || {}),  ...(patch.merchantRules || {}) },
      hiddenAccounts: patch.hiddenAccounts ?? s.settings.hiddenAccounts ?? [] };
  });
  res.json(store.read().settings);
});

app.post("/api/budget", (req, res) => {
  const patch = req.body || {};
  for (const [k, v] of Object.entries(patch)) {
    if (!k.trim()) return res.status(400).json({ error: "Category names cannot be blank." });
    if (!Number.isFinite(Number(v)) || Number(v) < 0) return res.status(400).json({ error: `"${k}" needs a number of 0 or more.` });
  }
  store.update(s => {
    for (const [k, v] of Object.entries(patch)) s.budget[k.trim()] = Math.round(Number(v));
    s.budgetCustomised = true;
  });
  res.json(store.read().budget);
});

app.delete("/api/budget/:name", (req, res) => {
  const name = decodeURIComponent(req.params.name);
  if (!(name in store.read().budget)) return res.status(404).json({ error: `No budget line called "${name}".` });
  store.update(s => { delete s.budget[name]; s.budgetCustomised = true; });
  res.json(store.read().budget);
});

app.post("/api/budget/rename", (req, res) => {
  const { from, to } = req.body || {};
  const b = store.read().budget;
  if (!(from in b)) return res.status(404).json({ error: `No budget line called "${from}".` });
  if (!to?.trim()) return res.status(400).json({ error: "The new name cannot be blank." });
  store.update(s => { s.budget[to.trim()] = s.budget[from]; delete s.budget[from]; s.budgetCustomised = true; });
  res.json(store.read().budget);
});

/* Replace the demo persona's targets with the user's own trailing averages. */
app.post("/api/budget/auto", (req, res) => {
  try {
    const suggested = assemble().suggestedBudget;
    if (!suggested.basedOn) return res.status(400).json({ error: "Not enough history yet. Sync at least one full month first." });
    store.update(s => {
      s.budget = { ...s.budget, ...suggested.targets };
      s.budgetCustomised = true;
    });
    res.json({ applied: suggested.targets, budget: store.read().budget });
  } catch (e) { fail(res, e, "budget/auto"); }
});

/* Recategorise one transaction, and optionally teach the rule for its merchant. */
app.post("/api/transactions/:id", (req, res) => {
  const id = req.params.id;
  const { category, merchant, applyToMerchant } = req.body || {};
  if (!category?.trim()) return res.status(400).json({ error: "A category is required." });
  store.update(s => {
    s.settings.txnOverrides = { ...(s.settings.txnOverrides || {}), [id]: { c: category.trim() } };
    if (applyToMerchant && merchant) {
      s.settings.merchantRules = { ...(s.settings.merchantRules || {}), [merchant]: category.trim() };
    }
  });
  res.json({ id, category: category.trim(), appliedToMerchant: Boolean(applyToMerchant && merchant) });
});

/* Hide by id rather than erase: the next sync would re-add a deleted row. */
app.delete("/api/transactions/:id", (req, res) => {
  const id = req.params.id;
  store.update(s => {
    const set = new Set(s.settings.hiddenTxns || []);
    set.add(id);
    s.settings.hiddenTxns = [...set];
  });
  res.json({ hidden: id, total: store.read().settings.hiddenTxns.length });
});

app.post("/api/transactions/:id/restore", (req, res) => {
  const id = req.params.id;
  store.update(s => { s.settings.hiddenTxns = (s.settings.hiddenTxns || []).filter(x => x !== id); });
  res.json({ restored: id });
});

/* ---------------- illiquid holdings ---------------- */
const slug = n => String(n).toLowerCase().replace(/\W+/g, "-").replace(/^-|-$/g, "") || "item";

app.post("/api/real-estate", (req, res) => {
  const b = req.body || {};
  if (!b.name?.trim()) return res.status(400).json({ error: "Give the position a name." });
  if (!["gp", "lp"].includes(b.kind)) return res.status(400).json({ error: 'kind must be "gp" or "lp".' });
  const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const rec = {
    id: b.id || slug(b.name) + "-" + slug(b.kind),
    kind: b.kind,
    name: b.name.trim(),
    invested: num(b.invested),
    /* Blank means "estimate it" -- do not silently substitute cost. */
    currentValue: (b.currentValue === "" || b.currentValue == null) ? null : num(b.currentValue),
    entryDate: b.entryDate || null,
    distributions: num(b.distributions),
    multiple: num(b.multiple, 1),
    prefRate: num(b.prefRate),
    promotePct: num(b.promotePct),
    exitDate: b.exitDate || null,
    status: b.status || "active",
    note: (b.note || "").trim()
  };
  store.update(s => {
    const i = s.realEstate.findIndex(x => x.id === rec.id);
    if (i >= 0) s.realEstate[i] = { ...s.realEstate[i], ...rec }; else s.realEstate.push(rec);
  });
  snapshotNow();
  res.json(store.read().realEstate);
});

app.delete("/api/real-estate/:id", (req, res) => {
  store.update(s => { s.realEstate = s.realEstate.filter(x => x.id !== req.params.id); });
  snapshotNow();
  res.json(store.read().realEstate);
});

app.post("/api/notes", (req, res) => {
  const b = req.body || {};
  if (!b.name?.trim()) return res.status(400).json({ error: "Give the note a name." });
  const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const rec = {
    id: b.id || slug(b.name) + "-note",
    name: b.name.trim(),
    borrower: (b.borrower || "").trim(),
    principal: num(b.principal),
    rate: num(b.rate),
    structure: ["interest-only", "accrued", "amortizing"].includes(b.structure) ? b.structure : "interest-only",
    startDate: b.startDate || null,
    maturityDate: b.maturityDate || null,
    received: num(b.received),
    status: b.status || "active"
  };
  store.update(s => {
    const i = s.notes.findIndex(x => x.id === rec.id);
    if (i >= 0) s.notes[i] = { ...s.notes[i], ...rec }; else s.notes.push(rec);
  });
  snapshotNow();
  res.json(store.read().notes);
});

app.delete("/api/notes/:id", (req, res) => {
  store.update(s => { s.notes = s.notes.filter(x => x.id !== req.params.id); });
  snapshotNow();
  res.json(store.read().notes);
});

/* Refresh crypto marks from a live feed. Only tickers leave this machine. */
async function refreshCryptoPrices() {
  const held = store.read().crypto || [];
  if (!held.length) return { updated: 0, unresolved: [] };
  const { prices, unresolved } = await fetchPrices(held);
  let updated = 0;
  store.update(s => {
    for (const c of s.crypto) {
      const hit = prices[String(c.symbol || "").toUpperCase()];
      if (!hit) continue;
      c.unitPrice = hit.usd;
      c.change24h = hit.change24h;
      c.priceUpdated = new Date().toISOString();
      c.priceSource = "coingecko";
      updated++;
    }
  });
  return { updated, unresolved };
}

app.post("/api/crypto/refresh", async (req, res) => {
  try {
    const r = await refreshCryptoPrices();
    snapshotNow();
    res.json({ ...r, at: new Date().toISOString() });
  } catch (e) {
    res.status(502).json({ error: "Price feed unavailable: " + e.message });
  }
});

app.post("/api/crypto", async (req, res) => {
  const b = req.body || {};
  if (!b.name?.trim() && !b.symbol?.trim()) return res.status(400).json({ error: "Give the holding a name or symbol." });
  const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const rec = {
    id: b.id || slug(b.symbol || b.name) + "-crypto",
    name: (b.name || b.symbol).trim(),
    symbol: (b.symbol || "").trim().toUpperCase(),
    quantity: num(b.quantity),
    costBasis: num(b.costBasis),
    growthRate: num(b.growthRate),
    coingeckoId: (b.coingeckoId || "").trim() || null
  };
  /* unitPrice is deliberately not taken from the request: it comes from the
   * feed, so a stale number typed once cannot linger as if it were current. */
  if (b.unitPrice != null && b.unitPrice !== "") {
    rec.unitPrice = num(b.unitPrice);
    rec.priceSource = "manual";
    rec.priceUpdated = new Date().toISOString();
  }
  store.update(s => {
    const i = s.crypto.findIndex(x => x.id === rec.id);
    if (i >= 0) s.crypto[i] = { ...s.crypto[i], ...rec }; else s.crypto.push(rec);
  });
  try { await refreshCryptoPrices(); } catch (e) { console.log("[prices]", e.message); }
  snapshotNow();
  res.json(store.read().crypto);
});

app.delete("/api/crypto/:id", (req, res) => {
  store.update(s => { s.crypto = s.crypto.filter(x => x.id !== req.params.id); });
  snapshotNow();
  res.json(store.read().crypto);
});

app.post("/api/properties", (req, res) => {
  const b = req.body || {};
  if (!b.name?.trim()) return res.status(400).json({ error: "Give the property a name." });
  const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const rec = {
    id: b.id || slug(b.name),
    name: b.name.trim(),
    value: num(b.value),
    appreciationRate: num(b.appreciationRate, 0.03),
    mortgageAccountId: b.mortgageAccountId || null,
    mortgage: b.mortgageAccountId ? null : {
      balance: num(b.mortgageBalance),
      rate: num(b.mortgageRate),
      monthlyPayment: num(b.mortgagePayment),
      lender: (b.lender || "").trim()
    }
  };
  store.update(s => {
    const i = s.properties.findIndex(x => x.id === rec.id);
    if (i >= 0) s.properties[i] = { ...s.properties[i], ...rec }; else s.properties.push(rec);
  });
  snapshotNow();
  res.json(store.read().properties);
});

app.delete("/api/properties/:id", (req, res) => {
  store.update(s => { s.properties = s.properties.filter(x => x.id !== req.params.id); });
  snapshotNow();
  res.json(store.read().properties);
});

app.post("/api/manual-assets", (req, res) => {
  const { id, name, value, kind } = req.body || {};
  if (!name) return res.status(400).json({ error: "name is required." });
  store.update(s => {
    const key = id || name.toLowerCase().replace(/\W+/g, "-");
    const rec = { id: key, name, value: Number(value) || 0, kind: kind || "asset", updated: new Date().toISOString().slice(0, 10) };
    const i = s.manualAssets.findIndex(m => m.id === key);
    if (i >= 0) s.manualAssets[i] = rec; else s.manualAssets.push(rec);
  });
  res.json(store.read().manualAssets);
});

/* ---------------- boot ---------------- */
app.listen(PORT, "127.0.0.1", () => {
  const stray = strayItems();
  console.log(`\n  Meridian  →  http://127.0.0.1:${PORT}`);
  console.log(`  Plaid env: ${ENV}${configured ? `  (client …${CLIENT_ID.slice(-4)})` : "   keys missing — add server/.env"}`);
  console.log(`  Products:  ${REQUIRED.join(", ")}${OPTIONAL.length ? `  (optional: ${OPTIONAL.join(", ")})` : ""}`);
  console.log(`  Linked:    ${liveItems().length} institution(s) in ${ENV}`);
  if (stray.length) console.log(`  Held back: ${stray.length} item(s) linked in a different environment`);
  if (ENV === "production" && !WEBHOOK) console.log(`  Note:      no PLAID_WEBHOOK_URL set — refresh with the sync button`);
  console.log("");
});
