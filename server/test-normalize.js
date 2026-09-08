/**
 * Exercises buildState() against realistic Plaid response shapes.
 *
 * The normalizer is the riskiest code in this project: it is the only place that
 * assumes Plaid field names, sign conventions and enum values. Without keys it
 * would otherwise ship completely unexercised, so this stands in for a real sync.
 *
 *   node test-normalize.js
 */
import { buildState, detectPromo, categoryOf } from "./normalize.js";

let pass = 0, failed = 0;
const eq = (got, want, label) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) { pass++; console.log(`  \x1b[32mok\x1b[0m   ${label}`); }
  else { failed++; console.log(`  \x1b[31mFAIL\x1b[0m ${label}\n         got  ${a}\n         want ${b}`); }
};
const ok = (cond, label) => eq(Boolean(cond), true, label);
const near = (got, want, label, tol = 1e-9) => {
  if (Math.abs(got - want) < tol) { pass++; console.log(`  [32mok[0m   ${label}`); }
  else { failed++; console.log(`  [31mFAIL[0m ${label}
         got  ${got}
         want ${want}`); }
};

/* ---------- fixtures in Plaid's actual response shapes ---------- */
const ITEM = "itm_1";
const items = [{ itemId: ITEM, institutionName: "First Platypus Bank", status: "ok", lastSync: null, error: null, addedAt: "2026-09-01T00:00:00Z", env: "sandbox" }];

const accounts = [
  { itemId: ITEM, account_id: "chk", name: "Plaid Checking", official_name: "Plaid Gold Checking",
    mask: "0000", type: "depository", subtype: "checking",
    balances: { available: 100, current: 12480.42, iso_currency_code: "USD", limit: null } },
  { itemId: ITEM, account_id: "sav", name: "Plaid Saving", official_name: null,
    mask: "1111", type: "depository", subtype: "savings",
    balances: { available: 34200, current: 34200, iso_currency_code: "USD", limit: null } },
  { itemId: ITEM, account_id: "brk", name: "Plaid IRA", official_name: null,
    mask: "2222", type: "investment", subtype: "ira",
    balances: { available: null, current: 148300, iso_currency_code: "USD", limit: null } },
  { itemId: ITEM, account_id: "cc", name: "Plaid Credit Card", official_name: "Plaid Diamond Card",
    mask: "3333", type: "credit", subtype: "credit card",
    balances: { available: 4800, current: 5340, iso_currency_code: "USD", limit: 10000 } },
  { itemId: ITEM, account_id: "std", name: "Plaid Student Loan", official_name: null,
    mask: "4444", type: "loan", subtype: "student",
    balances: { available: null, current: 21540, iso_currency_code: "USD", limit: null } }
];

/* Plaid sign convention: positive amount = money OUT of the account. */
const transactions = [
  { transaction_id: "t1", account_id: "chk", amount: -5412.88, date: "2026-09-06", pending: false,
    name: "PAYROLL NORTHWIND", merchant_name: "Northwind Labs",
    personal_finance_category: { primary: "INCOME", detailed: "INCOME_WAGES" } },
  { transaction_id: "t2", account_id: "cc", amount: 47.20, date: "2026-09-07", pending: false,
    name: "DOORDASH", merchant_name: "DoorDash",
    personal_finance_category: { primary: "FOOD_AND_DRINK", detailed: "FOOD_AND_DRINK_RESTAURANT" } },
  { transaction_id: "t3", account_id: "chk", amount: 2850.00, date: "2026-09-01", pending: false,
    name: "RENT", merchant_name: null,
    personal_finance_category: { primary: "RENT_AND_UTILITIES", detailed: "RENT_AND_UTILITIES_RENT" } },
  { transaction_id: "t4", account_id: "chk", amount: 128.44, date: "2026-09-07", pending: false,
    name: "WHOLE FOODS", merchant_name: "Whole Foods",
    personal_finance_category: { primary: "FOOD_AND_DRINK", detailed: "FOOD_AND_DRINK_GROCERIES" } },
  { transaction_id: "t5", account_id: "cc", amount: 19.99, date: "2026-09-04", pending: false,
    name: "NETFLIX", merchant_name: "Netflix",
    personal_finance_category: { primary: "ENTERTAINMENT", detailed: "ENTERTAINMENT_STREAMING" } },
  { transaction_id: "t6", account_id: "cc", amount: 11.99, date: "2026-09-04", pending: false,
    name: "HULU", merchant_name: "Hulu",
    personal_finance_category: { primary: "ENTERTAINMENT", detailed: "ENTERTAINMENT_STREAMING" } },
  { transaction_id: "tp", account_id: "cc", amount: 9.99, date: "2026-09-09", pending: true,
    name: "PENDING THING", merchant_name: "Pending",
    personal_finance_category: { primary: "GENERAL_MERCHANDISE", detailed: "GENERAL_MERCHANDISE_OTHER" } }
];

const liabilities = {
  credit: [{
    account_id: "cc",
    aprs: [
      { apr_percentage: 24.99, apr_type: "purchase_apr", balance_subject_to_apr: 0, interest_charge_amount: 0 },
      { apr_percentage: 27.95, apr_type: "cash_apr", balance_subject_to_apr: 0, interest_charge_amount: 0 },
      { apr_percentage: 0, apr_type: "special", balance_subject_to_apr: 5340, interest_charge_amount: 0 }
    ],
    is_overdue: false, last_payment_amount: 168.25, last_statement_balance: 5340,
    minimum_payment_amount: 54, next_payment_due_date: "2026-09-25"
  }],
  student: [{ account_id: "std", interest_rate_percentage: 5.4, minimum_payment_amount: 232 }],
  mortgage: []
};

const recurring = {
  outflow_streams: [
    { stream_id: "s1", account_id: "cc", merchant_name: "Netflix", description: "NETFLIX",
      first_date: "2025-01-04", last_date: "2026-09-04", frequency: "MONTHLY", is_active: true,
      transaction_ids: ["t5"], average_amount: { amount: 15.99 }, last_amount: { amount: 19.99 },
      personal_finance_category: { primary: "ENTERTAINMENT", detailed: "ENTERTAINMENT_STREAMING" } },
    { stream_id: "s2", account_id: "cc", merchant_name: "Hulu", description: "HULU",
      first_date: "2025-03-04", last_date: "2026-09-04", frequency: "MONTHLY", is_active: true,
      transaction_ids: ["t6"], average_amount: { amount: 11.99 }, last_amount: { amount: 11.99 },
      personal_finance_category: { primary: "ENTERTAINMENT", detailed: "ENTERTAINMENT_STREAMING" } }
  ],
  inflow_streams: []
};

const store = {
  budget: { Housing: 2850, Groceries: 750, "Dining & delivery": 400, Subscriptions: 180, "Everything else": 300 },
  settings: { goal: 3200000, goalYears: 18, contribution: 4200, baseReturn: 0.075,
              extraDebtPayment: 954, emergencyMonths: 6, ignoredLeaks: [],
              promoEnds: { cc: "2026-11-30" } },
  snapshots: [{ date: "2026-09-07", assets: 195000, liabilities: 26880, net: 168120 },
              { date: "2026-09-08", assets: 195020, liabilities: 26880, net: 168140 }],
  manualAssets: [{ id: "car", name: "2019 Subaru Outback", value: 19400, kind: "vehicle", updated: "2026-09-01" }]
};

const today = new Date(2026, 8, 8);           // 8 Sep 2026

console.log("\nnormalize.js against Plaid-shaped payloads\n");

/* ---------- unit-level ---------- */
eq(detectPromo(liabilities.credit[0]).balanceOnPromo, 5340, "detectPromo finds the 0% balance");
near(detectPromo(liabilities.credit[0]).postApr, 0.2499, "post-promo rate is the purchase APR, not the higher cash APR");
eq(detectPromo({ aprs: [{ apr_percentage: 19.9, apr_type: "purchase_apr", balance_subject_to_apr: 100 }] }), null,
   "detectPromo returns null when there is no 0% window");
eq(categoryOf(transactions[3]), "Groceries", "detailed PFC beats primary (groceries, not dining)");
eq(categoryOf(transactions[0]), "Income", "income maps to Income");
eq(categoryOf(transactions[4], new Set(["t5"])), "Subscriptions", "a recurring transaction becomes Subscriptions");

/* ---------- whole-state ---------- */
const S = buildState({ items, accounts, transactions, liabilities, recurring, store, today });

eq(S.totals.assets, 214380, "assets = 12480 + 34200 + 148300 + 19400 manual");
eq(S.totals.liabilities, 26880, "liabilities = 5340 card + 21540 student");
eq(S.totals.net, 187500, "net worth");
eq(S.totals.invested, 148300, "invested counts the brokerage only, not the manual car");
eq(S.totals.liquid, 46680, "liquid = checking + savings");

eq(S.accounts.cash.length, 2, "two cash accounts");
eq(S.accounts.promo.length, 1, "the 0% card is bucketed as promo, not credit");
eq(S.accounts.credit.length, 1, "the student loan sits in credit");
ok(S.accounts.invest.some(a => a.id === "manual:car"), "manual asset appears in invest");

const promoAcct = S.accounts.promo[0];
eq(promoAcct.needsPromoDate, false, "promo end date supplied, so no prompt");
ok(/83 days/.test(promoAcct.sub), "countdown reads 83 days to 30 Nov 2026");
eq(promoAcct.crit, true, "under 120 days is flagged critical");

const card = S.debts.find(d => d.id === "cc");
eq(card.apr, 0, "promo card carries 0% right now");
near(card.post, 0.2499, "and the post-promo rate it will revert to");
eq(card.promoEnd, 3, "promo ends in 3 statements (Sep, Oct, Nov)");
eq(card.min, 54, "minimum payment read from liabilities");
const loan = S.debts.find(d => d.id === "std");
near(loan.apr, 0.054, "student loan rate converted from percentage");
eq(loan.min, 232, "student minimum payment");

eq(S.txns.length, 6, "pending transactions are excluded");
eq(S.txns.find(t => t.id === "t1").v, 5412.88, "income is positive after sign flip");
eq(S.txns.find(t => t.id === "t2").v, -47.20, "spending is negative after sign flip");
eq(S.txns.find(t => t.id === "t5").sub, 1, "recurring transaction tagged");

const bDining = S.budget.find(b => b.n === "Dining & delivery");
const bHousing = S.budget.find(b => b.n === "Housing");
const bSubs = S.budget.find(b => b.n === "Subscriptions");
eq(bDining.a, 47.2, "dining MTD");
eq(bHousing.a, 2850, "housing MTD");
eq(bSubs.a, 31.98, "both streaming charges land in Subscriptions, not Entertainment");
eq(bHousing.fixed, true, "housing treated as fixed");
eq(Number(S.thru.toFixed(4)), 0.2667, "8 of 30 days elapsed");

ok(S.leaks.some(l => l.kind === "creep" && /Netflix/.test(l.n)), "price increase on Netflix detected");
ok(S.leaks.some(l => l.kind === "dupe" && /Hulu/.test(l.n)), "overlapping streaming subscription detected");
eq(S.metrics.incomeMTD, 5413, "income month-to-date");
ok(S.metrics.runwayMonths > 0, "runway computed");
eq(S.anchors.length, 2, "net worth anchors come from snapshots");
eq(S.items.length, 1, "one linked institution reported");

console.log(`\n  ${pass} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
