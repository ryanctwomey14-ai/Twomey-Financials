/**
 * Post-sync diagnostic.
 *
 * Going straight to production means the normalizer meets your real accounts
 * without ever having seen a Plaid response. This reports what it did and did not
 * manage to map, so you can tell at a glance whether the dashboard's numbers are
 * trustworthy — rather than trusting them and finding out later.
 *
 *   node doctor.js          (run it after your first sync)
 */
import "dotenv/config";
import * as store from "./store.js";
import { buildState, detectPromo, categoryOf } from "./normalize.js";

const ENV = (process.env.PLAID_ENV || "sandbox").toLowerCase();
const g = s => `\x1b[32m${s}\x1b[0m`, r = s => `\x1b[31m${s}\x1b[0m`, y = s => `\x1b[33m${s}\x1b[0m`;
const dim = s => `\x1b[2m${s}\x1b[0m`;
const usd = n => "$" + Math.round(n).toLocaleString("en-US");

const s = store.read();
const items = s.items.filter(i => (i.env || "sandbox") === ENV);
const ids = new Set(items.map(i => i.itemId));
const accounts = (s.accounts || []).filter(a => ids.has(a.itemId));
const txns = (s.transactions || []).filter(t => ids.has(t.itemId));

console.log(`\nMeridian diagnostic — ${ENV}\n`);

if (!items.length) {
  console.log(r("  No linked items in this environment. Link an institution and sync first.\n"));
  process.exit(1);
}

const liabilities = { credit: [], student: [], mortgage: [] };
for (const [id, l] of Object.entries(s.liabilitiesByItem || {})) {
  if (!ids.has(id) || !l?.liabilities) continue;
  for (const k of ["credit", "student", "mortgage"]) liabilities[k].push(...(l.liabilities[k] || []));
}
const recurring = { outflow_streams: [], inflow_streams: [] };
for (const [id, rec] of Object.entries(s.recurringByItem || {})) {
  if (!ids.has(id) || !rec) continue;
  recurring.outflow_streams.push(...(rec.outflow_streams || []));
}

const S = buildState({ items, accounts, transactions: txns, liabilities, recurring, store: s });
const warn = [];

/* ---------- institutions ---------- */
console.log("INSTITUTIONS");
for (const i of items) {
  const n = accounts.filter(a => a.itemId === i.itemId).length;
  const bad = i.status !== "ok";
  console.log(`  ${bad ? r("!") : g("+")} ${i.institutionName} — ${n} account(s), last sync ${i.lastSync ? new Date(i.lastSync).toLocaleString() : r("never")}${bad ? r("  [" + i.error + "]") : ""}`);
  if (bad) warn.push(`${i.institutionName} needs re-authentication.`);
}

/* ---------- accounts ---------- */
console.log("\nACCOUNTS  " + dim("(type/subtype -> where it landed)"));
const buckets = { cash: "Cash", invest: "Invest", credit: "Credit", promo: "0% promo" };
for (const [bucket, list] of Object.entries(S.accounts)) {
  for (const a of list) {
    if (String(a.id).startsWith("manual:")) continue;
    const raw = accounts.find(x => x.account_id === a.id);
    console.log(`  ${g("+")} ${(raw?.type + "/" + (raw?.subtype || "?")).padEnd(24)} ${buckets[bucket].padEnd(9)} ${usd(a.v).padStart(12)}  ${a.name}`);
  }
}
const nullBal = accounts.filter(a => a.balances?.current == null);
if (nullBal.length) {
  console.log(r(`  ! ${nullBal.length} account(s) report no current balance — excluded from net worth`));
  warn.push(`${nullBal.length} account(s) returned a null balance; net worth is understated.`);
}
const fx = accounts.filter(a => a.balances?.iso_currency_code && a.balances.iso_currency_code !== "USD");
if (fx.length) {
  console.log(r(`  ! ${fx.length} account(s) are not USD (${[...new Set(fx.map(a => a.balances.iso_currency_code))].join(", ")}) — totals mix currencies`));
  warn.push("Non-USD accounts are summed as if they were USD. Tell me and I will add conversion.");
}

/* ---------- transactions ---------- */
console.log("\nTRANSACTIONS");
const dates = txns.map(t => t.date).sort();
console.log(`  ${g("+")} ${txns.length} transactions, ${dates[0] || "?"} to ${dates[dates.length - 1] || "?"}`);
const recIds = new Set(recurring.outflow_streams.flatMap(x => x.transaction_ids || []));
const cats = {};
for (const t of txns) { const c = categoryOf(t, recIds, s.settings); cats[c] = (cats[c] || 0) + 1; }
const fallback = cats["Everything else"] || 0;
const pctFall = txns.length ? (fallback / txns.length) * 100 : 0;
for (const [c, n] of Object.entries(cats).sort((a, b) => b[1] - a[1]))
  console.log(`      ${String(n).padStart(5)}  ${c}`);
if (pctFall > 15) {
  console.log(r(`  ! ${pctFall.toFixed(0)}% fell through to "Everything else" — budgets will be misleading`));
  warn.push(`${pctFall.toFixed(0)}% of transactions are uncategorised. Send me the category list and I will extend the mapping.`);
} else console.log(`  ${g("+")} ${pctFall.toFixed(0)}% uncategorised ${dim("(under 15% is healthy)")}`);

const noPfc = txns.filter(t => !t.personal_finance_category).length;
if (noPfc) {
  console.log(y(`  ~ ${noPfc} transaction(s) arrived without a category from Plaid`));
  warn.push(`${noPfc} transactions have no Plaid category.`);
}
if (!Object.keys(cats).includes("Income")) {
  console.log(y("  ~ no income transactions detected — savings rate and cash flow will read as blank"));
  warn.push("No income detected. If your paycheque lands in an unlinked account, link it or savings rate stays blank.");
}

/* ---------- debts and promos ---------- */
console.log("\nDEBTS");
if (!S.debts.length) console.log(dim("  none"));
for (const d of S.debts) {
  const promo = d.promoEnd != null;
  console.log(`  ${g("+")} ${d.n.padEnd(30)} ${usd(d.bal).padStart(11)}  ${promo ? y("0% promo") : (d.apr * 100).toFixed(2) + "%"}  min ${usd(d.min)}`);
}
const creditAccts = accounts.filter(a => a.type === "credit");
const withLiab = new Set(liabilities.credit.map(c => c.account_id));
const missing = creditAccts.filter(a => !withLiab.has(a.account_id));
if (missing.length) {
  console.log(r(`  ! ${missing.length} credit card(s) returned no liabilities data — APR and minimum payment are estimated`));
  warn.push(`${missing.length} card(s) have no APR data. Enable the liabilities product on your Plaid account, or debt routing is guesswork.`);
}
const needDates = (S.needsPromoDates || []).length;
if (needDates) {
  console.log(y(`  ~ ${needDates} card(s) have a 0% rate with no end date set — add it in the dashboard`));
  warn.push(`${needDates} promo card(s) need an end date before their clock works.`);
}

/* ---------- budget ---------- */
console.log("\nBUDGET");
if (!s.budgetCustomised) {
  console.log(r("  ! targets are still the demo persona's — every pace and leak alert is measured against the wrong numbers"));
  warn.push('Budget targets are still demo defaults. Press "Use my averages" in the dashboard, or POST /api/budget/auto.');
} else console.log(`  ${g("+")} targets customised`);
if (S.suggestedBudget?.basedOn)
  console.log(dim(`      suggestion available from ${S.suggestedBudget.basedOn} categories of your own history`));

/* ---------- totals ---------- */
console.log("\nTOTALS");
console.log(`  assets ${usd(S.totals.assets)}   liabilities ${usd(S.totals.liabilities)}   net ${usd(S.totals.net)}`);
console.log(`  invested ${usd(S.totals.invested)}   liquid ${usd(S.totals.liquid)}   runway ${S.metrics.runwayMonths} mo`);
console.log(dim(`  snapshots recorded: ${s.snapshots.length} ${s.snapshots.length < 2 ? "(the net worth chart needs 2)" : ""}`));

/* ---------- verdict ---------- */
console.log("");
if (!warn.length) {
  console.log(g("  Everything mapped cleanly. The numbers on the dashboard are trustworthy.\n"));
} else {
  console.log(y(`  ${warn.length} thing(s) to look at before trusting the numbers:\n`));
  warn.forEach((w, i) => console.log(`   ${i + 1}. ${w}`));
  console.log("");
}
