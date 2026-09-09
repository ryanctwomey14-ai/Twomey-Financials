/**
 * Plaid -> dashboard shape.
 *
 * Everything the dashboard renders is derived here so the browser never has to
 * know Plaid exists. Where Plaid genuinely cannot supply something, this file
 * says so rather than inventing it (see promoEnds and the leak notes below).
 */

/* ---------- category mapping ---------- */
const DETAILED = {
  RENT_AND_UTILITIES_RENT: "Housing",
  RENT_AND_UTILITIES_GAS_AND_ELECTRICITY: "Utilities",
  RENT_AND_UTILITIES_WATER: "Utilities",
  RENT_AND_UTILITIES_INTERNET_AND_CABLE: "Utilities",
  RENT_AND_UTILITIES_TELEPHONE: "Utilities",
  RENT_AND_UTILITIES_SEWAGE_AND_WASTE: "Utilities",
  FOOD_AND_DRINK_GROCERIES: "Groceries",
  FOOD_AND_DRINK_RESTAURANT: "Dining & delivery",
  FOOD_AND_DRINK_FAST_FOOD: "Dining & delivery",
  FOOD_AND_DRINK_COFFEE: "Dining & delivery",
  FOOD_AND_DRINK_ALCOHOL_AND_BARS: "Dining & delivery",
  FOOD_AND_DRINK_VENDING_MACHINES: "Dining & delivery",
  FOOD_AND_DRINK_BEER_WINE_AND_LIQUOR: "Groceries"
};
const PRIMARY = {
  INCOME: "Income",
  TRANSFER_IN: "Transfer",
  TRANSFER_OUT: "Transfer",
  LOAN_PAYMENTS: "Debt payment",
  BANK_FEES: "Everything else",
  ENTERTAINMENT: "Everything else",
  FOOD_AND_DRINK: "Dining & delivery",
  GENERAL_MERCHANDISE: "Shopping",
  HOME_IMPROVEMENT: "Housing",
  MEDICAL: "Health & fitness",
  PERSONAL_CARE: "Health & fitness",
  GENERAL_SERVICES: "Everything else",
  GOVERNMENT_AND_NON_PROFIT: "Everything else",
  TRANSPORTATION: "Transport",
  TRAVEL: "Travel",
  RENT_AND_UTILITIES: "Utilities"
};
const NON_BUDGET = new Set(["Income", "Transfer", "Debt payment"]);

export const merchantKey = t =>
  String(t.merchant_name || t.name || "").toLowerCase().replace(/\s+/g, " ").trim();

/* Precedence: what the user said about this exact transaction, then what they
 * said about this merchant, then Plaid's own classification. */
export function categoryOf(txn, recurringIds, settings) {
  const ov = settings?.txnOverrides?.[txn.transaction_id];
  if (ov?.c) return ov.c;
  const rule = settings?.merchantRules?.[merchantKey(txn)];
  if (rule) return rule;
  const d = txn.personal_finance_category?.detailed;
  const p = txn.personal_finance_category?.primary;
  /* Transfers, card payments and income are recurring by nature. Letting the
   * recurring-stream check run first labelled every card payment a Subscription
   * and inflated that budget line enormously. */
  if (p && NON_BUDGET.has(PRIMARY[p])) return PRIMARY[p];
  if (recurringIds?.has(txn.transaction_id)) return "Subscriptions";
  return DETAILED[d] || PRIMARY[p] || "Everything else";
}

/* ---------- account bucketing ---------- */
const mark = name => (name || "??")
  .replace(/[^A-Za-z ]/g, "")
  .split(/\s+/).filter(Boolean).slice(0, 2)
  .map(w => w[0].toUpperCase()).join("") || "AC";

export function bucketOf(account, promo) {
  if (account.type === "depository") return "cash";
  if (account.type === "investment" || account.type === "brokerage") return "invest";
  if (promo) return "promo";
  return "credit";
}

/* ---------- promo APR detection ----------
 * Plaid reports the APR table on a card, so a 0% window is detectable. It does
 * NOT report the promo END DATE — no aggregator does, it lives in the cardmember
 * agreement. That one field is user-supplied via settings.promoEnds[accountId].
 */
export function detectPromo(creditRow, accountBalance) {
  if (!creditRow?.aprs?.length) return null;
  /* Plaid's docs show balance_subject_to_apr populated, but most real issuers
   * return null for it. The 0% APR row is itself the signal; the balance riding
   * on it comes from the account when the field is absent. */
  const zero = creditRow.aprs.find(a =>
    Number(a.apr_percentage) === 0 &&
    ["purchase_apr", "special", "balance_transfer_apr"].includes(a.apr_type));
  if (!zero) return null;
  const subject = zero.balance_subject_to_apr == null ? null : Number(zero.balance_subject_to_apr);
  if (subject === 0) return null;                       // explicitly nothing on the promo
  const onPromo = subject ?? Math.abs(Number(accountBalance ?? 0));
  if (!onPromo) return null;                            // a 0% rate with no balance is not news
  /* When a promo lapses the balance reverts to the go-to purchase rate, not to
   * whatever rate is numerically largest. Cash-advance APR is usually the highest
   * on the card and almost never the one that applies, so pick by intent. */
  const rated = creditRow.aprs.filter(a => Number(a.apr_percentage) > 0);
  /* If the purchase APR row IS the 0% one, the go-to rate is not in the table at
   * all -- the issuer swaps it in at expiry. The lowest positive rate is a closer
   * guess than the highest (which is nearly always the cash-advance rate). */
  const explicit = rated.find(a => a.apr_type === "purchase_apr")
                || rated.find(a => a.apr_type === "balance_transfer_apr");
  const fallback = rated.slice().sort((a, b) => a.apr_percentage - b.apr_percentage)[0];
  const standard = explicit || fallback;
  return {
    balanceOnPromo: onPromo,
    aprType: zero.apr_type || "special",
    postApr: standard ? Number(standard.apr_percentage) / 100 : null,
    postAprEstimated: !explicit && Boolean(fallback)
  };
}

/* A card can be mis-read in both directions: some issuers do not publish the 0%
 * row in their APR table, and occasionally a 0% line is stale. promoOverrides
 * lets the user force it on or off per account. */
export function promoFor(account, creditRow, settings) {
  const ov = (settings.promoOverrides || {})[account.account_id];
  if (ov?.isPromo === false) return null;
  let p = detectPromo(creditRow, account.balances?.current);
  if (!p && ov?.isPromo === true) {
    p = {
      balanceOnPromo: Number(ov.balance) || Math.abs(Number(account.balances?.current ?? 0)),
      aprType: "manual",
      postApr: ov.postApr != null ? Number(ov.postApr) : (creditRow ? purchaseApr(creditRow) : null),
      manual: true
    };
  }
  if (p && ov?.postApr != null) p = { ...p, postApr: Number(ov.postApr) };
  return p;
}

/* Returns null when the issuer gave us no APR table at all. An unknown rate is
 * not the same as a 0% rate and must never be displayed as one. */
const purchaseApr = creditRow => {
  if (!creditRow?.aprs?.length) return null;
  const a = creditRow.aprs.find(x => x.apr_type === "purchase_apr")
        || creditRow.aprs.filter(x => Number(x.apr_percentage) > 0)
             .sort((p, q) => q.apr_percentage - p.apr_percentage)[0];
  return a ? Number(a.apr_percentage) / 100 : null;
};

/* Some issuers return names carrying broken trademark bytes. */
const clean = n => String(n || "").replace(/[\uFFFD\u0000-\u001F]+/g, "").replace(/\s{2,}/g, " ").trim();

const daysBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000);

/* Payments per year. Cadence is not cosmetic: quarterly PIK compounds four times
 * a year rather than twelve, and a quarterly coupon is three months of cash you
 * cannot reinvest until it lands. */
export const PER_YEAR = { monthly: 12, quarterly: 4, semiannual: 2, annual: 1 };
export const freqOf = f => PER_YEAR[f] || 12;
export const freqLabel = f => ({ monthly: "monthly", quarterly: "quarterly",
  semiannual: "twice a year", annual: "annually" })[f] || "monthly";

/* ---------- main ---------- */
export function buildState({ items, accounts, transactions, liabilities, recurring, store, today = new Date() }) {
  const settings = store.settings;
  const promoEnds = settings.promoEnds || {};
  const iso = today.toISOString().slice(0, 10);

  /* --- liabilities lookup --- */
  const credit = new Map((liabilities?.credit || []).map(c => [c.account_id, c]));
  const student = new Map((liabilities?.student || []).map(c => [c.account_id, c]));
  const mortgage = new Map((liabilities?.mortgage || []).map(c => [c.account_id, c]));

  /* --- recurring streams --- */
  const outflows = (recurring?.outflow_streams || []).filter(s => s.is_active !== false);
  const recurringTxnIds = new Set(outflows.flatMap(s => s.transaction_ids || []));

  /* --- accounts ---
   * Hiding is by account id and survives re-sync: a closed or empty account
   * comes back from Plaid on every refresh, so it has to be suppressed here
   * rather than deleted. Its transactions go with it, so an account you are
   * not tracking cannot quietly move your budget numbers. */
  const hiddenAccounts = new Set(settings.hiddenAccounts || []);
  const hiddenList = accounts.filter(a => hiddenAccounts.has(a.account_id)).map(a => ({
    id: a.account_id,
    name: clean(a.official_name || a.name),
    balance: Number(a.balances?.current ?? 0),
    type: a.subtype || a.type
  }));

  const grouped = { cash: [], invest: [], credit: [], promo: [] };
  let assets = 0, liab = 0, invested = 0, liquid = 0;

  for (const a of accounts) {
    if (hiddenAccounts.has(a.account_id)) continue;
    const inst = items.find(i => i.itemId === a.itemId);
    const c = credit.get(a.account_id);
    const promo = promoFor(a, c, settings);
    const bucket = bucketOf(a, promo);
    const isDebt = a.type === "credit" || a.type === "loan";
    const bal = Number(a.balances.current ?? 0);
    const signed = isDebt ? -Math.abs(bal) : Math.abs(bal);

    if (isDebt) liab += Math.abs(bal); else assets += Math.abs(bal);
    if (bucket === "invest") invested += Math.abs(bal);
    if (bucket === "cash") liquid += Math.abs(bal);

    const end = promoEnds[a.account_id];
    const daysLeft = end ? daysBetween(iso, end) : null;

    grouped[bucket].push({
      id: a.account_id,
      mark: mark(inst?.institutionName || a.name),
      name: clean(a.official_name || a.name),
      meta: [
        a.mask ? "••" + a.mask : null,
        promo
          ? (end ? `0% until ${end}` : "0% promo — end date not set")
          : c ? (purchaseApr(c) != null ? `${(purchaseApr(c) * 100).toFixed(2)}% APR` : "APR not reported")
          : a.subtype || a.type
      ].filter(Boolean).join(" · "),
      v: signed,
      sub: promo
        ? (daysLeft != null
            ? `${daysLeft} days · then ${promo.postApr ? (promo.postApr * 100).toFixed(2) + "%" + (promo.postAprEstimated ? " est." : "") : "an unknown rate"}`
            : "Set the promo end date")
        : c?.next_payment_due_date
          ? `Due ${c.next_payment_due_date} · ${c.minimum_payment_amount != null ? "$" + c.minimum_payment_amount + " min" : "min unknown"}`
          : inst?.institutionName || "",
      crit: promo && daysLeft != null && daysLeft <= 120,
      vio: promo && (daysLeft == null || daysLeft > 120),
      needsPromoDate: !!promo && !end
    });
  }

  /* --- illiquid holdings: GP/LP real estate positions ---
   * These are carried at the sponsor's mark, not a market price, and they do not
   * compound smoothly. Each one is a lump that lands on its exit date, which is
   * why the projection treats them separately from the securities balance. */
  const yearsUntil = d => {
    if (!d) return null;
    const ms = new Date(d + "T00:00:00") - today;
    return Math.max(0, ms / (365.25 * 86400000));
  };
  /* A private position has no market price. With no sponsor mark, the value is
   * carried straight-line between the capital you put in and the expected exit
   * value, by how far through the hold you are. It is a modelled figure, not a
   * valuation -- a real appraisal should always replace it, which is what
   * currentValue does. */
  /* A private position has no market price. With no sponsor mark, the value is
   * carried straight-line between the capital you put in and the expected exit
   * value, by how far through the hold you are. It is a modelled figure, not a
   * valuation -- a real appraisal should always replace it, which is what
   * currentValue does. */
  const realEstate = (store.realEstate || []).filter(p => p.status !== "exited").map(p => {
    const invested = Number(p.invested) || 0;
    const mult = Number(p.multiple) || 0;
    const exitValue = invested * mult;
    const entered = p.currentValue == null || p.currentValue === "" ? null : Number(p.currentValue);

    const entry = p.entryDate ? new Date(p.entryDate + "T00:00:00") : null;
    const exit = p.exitDate ? new Date(p.exitDate + "T00:00:00") : null;
    const holdYears = entry && exit ? (exit - entry) / (365.25 * 86400000) : null;
    const heldYears = entry ? Math.max(0, (today - entry) / (365.25 * 86400000)) : null;
    const progress = holdYears > 0 && heldYears != null ? Math.min(1, heldYears / holdYears) : null;

    let mark, markSource;
    if (entered != null && entered > 0) { mark = entered; markSource = "entered"; }
    else if (progress != null && exitValue > 0) {
      mark = invested + (exitValue - invested) * progress;
      markSource = "estimated";
    } else { mark = invested; markSource = "cost"; }

    return {
      id: p.id, kind: p.kind, name: p.name,
      invested, mark, markSource, multiple: mult, exitValue,
      entryDate: p.entryDate || null,
      exitDate: p.exitDate || null,
      holdYears, heldYears, progress,
      yearsToExit: yearsUntil(p.exitDate),
      projectedProceeds: exitValue,
      unrealisedGain: mark - invested
    };
  });
  for (const p of realEstate) assets += p.mark;

  /* --- promissory notes (you are the lender) ---
   * Value depends on how interest is paid, not just the rate. Interest paid out
   * monthly never joins the principal; accrued (PIK) interest does. */
  const notes = (store.notes || []).filter(n => n.status !== "repaid").map(n => {
    const principal = Number(n.principal) || 0;
    const rate = Number(n.rate) || 0;
    const received = Number(n.received) || 0;
    const start = n.startDate ? new Date(n.startDate + "T00:00:00") : null;
    const mat = n.maturityDate ? new Date(n.maturityDate + "T00:00:00") : null;
    const heldYears = start ? Math.max(0, (today - start) / (365.25 * 86400000)) : 0;
    const termYears = start && mat ? Math.max(0, (mat - start) / (365.25 * 86400000)) : null;
    const structure = n.structure || "interest-only";
    const freq = n.payFrequency || "monthly";
    const per = freqOf(freq);                           // payments per year

    let mark, atMaturity;
    if (structure === "accrued") {
      /* PIK compounds at the payment cadence, not annually. */
      mark = principal * Math.pow(1 + rate / per, per * heldYears);
      atMaturity = termYears != null ? principal * Math.pow(1 + rate / per, per * termYears) : mark;
    } else if (structure === "amortizing") {
      const i = rate / per, nTot = termYears != null ? Math.round(termYears * per) : 0;
      const nEl = Math.min(nTot, Math.round(heldYears * per));
      if (i > 0 && nTot > 0) {
        const pay = principal * i / (1 - Math.pow(1 + i, -nTot));
        const g = Math.pow(1 + i, nEl);
        mark = Math.max(0, principal * g - pay * (g - 1) / i);
      } else mark = Math.max(0, principal * (1 - (nTot ? nEl / nTot : 0)));
      atMaturity = 0;                                   // fully repaid by the schedule
    } else {
      mark = principal;                                 // interest paid out as cash
      atMaturity = principal;                           // principal returns at maturity
    }
    return {
      id: n.id, name: n.name, borrower: n.borrower || "",
      principal, rate, structure, received,
      payFrequency: freq,
      paymentsPerYear: per,
      payLabel: freqLabel(freq),
      startDate: n.startDate || null, maturityDate: n.maturityDate || null,
      heldYears, termYears,
      yearsToMaturity: yearsUntil(n.maturityDate),
      mark, atMaturity,
      annualIncome: structure === "interest-only" ? principal * rate : 0,
      perPayment: structure === "interest-only"
        ? (principal * rate) / per
        : structure === "amortizing" && termYears
          ? (rate > 0
              ? principal * (rate / per) / (1 - Math.pow(1 + rate / per, -Math.round(termYears * per)))
              : principal / Math.round(termYears * per))
          : 0
    };
  });
  for (const n of notes) assets += n.mark;

  /* --- crypto ---
   * Priced by hand: no price feed reaches this process. Growth is whatever the
   * user assumes, defaulting to zero rather than borrowing the equity return. */
  const crypto = (store.crypto || []).map(c => {
    const qty = Number(c.quantity) || 0;
    const px = Number(c.unitPrice) || 0;
    const mark = qty * px;
    return {
      id: c.id, name: c.name, symbol: (c.symbol || "").toUpperCase(),
      quantity: qty, unitPrice: px, mark,
      growthRate: Number(c.growthRate) || 0,
      priceUpdated: c.priceUpdated || null,
      priceSource: c.priceSource || null,
      change24h: c.change24h ?? null,
      coingeckoId: c.coingeckoId || null
    };
  });
  for (const c of crypto) assets += c.mark;

  /* --- owned property and its mortgage --- */
  const properties = (store.properties || []).map(p => {
    const value = Number(p.value) || 0;
    const m = p.mortgage || null;
    const linked = p.mortgageAccountId
      ? accounts.find(a => a.account_id === p.mortgageAccountId)
      : null;
    const balance = linked
      ? Math.abs(Number(linked.balances?.current ?? 0))
      : Math.abs(Number(m?.balance) || 0);
    return {
      id: p.id, name: p.name, value,
      appreciationRate: Number(p.appreciationRate ?? 0.03),
      mortgage: balance > 0 ? {
        balance,
        rate: Number(linked ? (mortgage.get(p.mortgageAccountId)?.interest_rate?.percentage || 0) / 100 : m?.rate) || 0,
        monthlyPayment: Number(linked ? mortgage.get(p.mortgageAccountId)?.next_monthly_payment : m?.monthlyPayment) || 0,
        linked: Boolean(linked)
      } : null,
      equity: value - balance
    };
  });
  for (const p of properties) {
    assets += p.value;
    /* A Plaid-linked mortgage is already counted as a loan account. */
    if (p.mortgage && !p.mortgage.linked) liab += p.mortgage.balance;
  }

  /* --- manual assets (property, vehicles) --- */
  for (const m of store.manualAssets || []) {
    assets += Number(m.value) || 0;
    grouped.invest.push({
      id: "manual:" + m.id, mark: "MA", name: m.name,
      meta: "manual · " + (m.kind || "asset"), v: Number(m.value) || 0, sub: "Updated " + (m.updated || "—")
    });
  }

  /* --- debts --- */
  const debts = [];
  for (const a of accounts) {
    if (hiddenAccounts.has(a.account_id)) continue;
    if (a.type !== "credit" && a.type !== "loan") continue;
    const bal = Math.abs(Number(a.balances.current ?? 0));
    if (bal < 1) continue;
    const c = credit.get(a.account_id), s = student.get(a.account_id), m = mortgage.get(a.account_id);
    const promo = promoFor(a, c, settings);
    const end = promoEnds[a.account_id];
    const monthsToPromo = end
      ? Math.max(0, (new Date(end).getFullYear() - today.getFullYear()) * 12 + (new Date(end).getMonth() - today.getMonth()) + 1)
      : null;
    /* The promo clock needs a countdown and a ring fraction. Without a known
     * promo start the window defaults to a year; promoStarts refines it. */
    const startISO = (settings.promoStarts || {})[a.account_id] || null;
    const daysLeft = end ? daysBetween(iso, end) : null;

    /* A $0 minimum means the issuer did not report one, not that nothing is due.
     * Left as 0 the payoff simulator would never retire the card. */
    const rawMin = Number(c?.minimum_payment_amount ?? s?.minimum_payment_amount ?? m?.next_monthly_payment ?? NaN);
    const minKnown = Number.isFinite(rawMin) && rawMin > 0;
    const rawApr = promo ? 0
      : c ? purchaseApr(c)
      : s?.interest_rate_percentage != null ? Number(s.interest_rate_percentage) / 100
      : m?.interest_rate?.percentage != null ? Number(m.interest_rate.percentage) / 100
      : null;

    debts.push({
      id: a.account_id,
      n: clean(a.official_name || a.name),
      sn: clean(a.name || "Account").split(/\s+/).slice(-1)[0],
      aprKnown: promo ? true : rawApr != null,
      minKnown,
      end: end ? new Date(end + "T00:00:00").toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" }) : null,
      endISO: end || null,
      days: daysLeft,
      window: startISO ? Math.max(1, daysBetween(startISO, end)) : 365,
      needsPromoDate: !!promo && !end,
      manualPromo: Boolean(promo?.manual),
      bal,
      apr: rawApr ?? 0,
      post: promo ? (promo.postApr ?? 0.2499) : undefined,
      postKnown: promo ? Boolean(promo.postApr != null && !promo.postAprEstimated) : undefined,
      promoEnd: promo ? monthsToPromo : undefined,
      min: minKnown ? rawMin : Math.max(25, Math.round(bal * 0.02)),
      kind: promo ? "0% promo" : a.type === "loan" ? (s ? "Student" : m ? "Mortgage" : "Loan") : "Card"
    });
  }
  debts.sort((x, y) => x.bal - y.bal);

  /* --- transactions --- */
  /* Hiding is by id and survives re-sync: transactionsSync would otherwise
   * re-add a duplicate the moment it is deleted. */
  const hidden = new Set(settings.hiddenTxns || []);
  const txns = transactions
    .filter(t => !t.pending && !hidden.has(t.transaction_id) && !hiddenAccounts.has(t.account_id))
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 400)
    .map(t => {
      const acct = accounts.find(a => a.account_id === t.account_id);
      const cat = categoryOf(t, recurringTxnIds, settings);
      return {
        id: t.transaction_id,
        d: new Date(t.date + "T00:00:00").toLocaleDateString("en-US", { day: "numeric", month: "short" }),
        date: t.date,
        n: t.merchant_name || t.name,
        c: cat,
        v: -Number(t.amount),                       // Plaid: positive = money out
        a: acct?.name || "Account",
        sub: recurringTxnIds.has(t.transaction_id) ? 1 : 0,
        merchant: merchantKey(t),
        edited: Boolean(settings.txnOverrides?.[t.transaction_id]?.c),
        flag: 0
      };
    });

  /* --- month-to-date budget --- */
  const monthStart = iso.slice(0, 8) + "01";
  const day = today.getDate();
  const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  const mtd = {};
  for (const t of txns) {
    if (t.date < monthStart) continue;
    if (NON_BUDGET.has(t.c) || t.v > 0) continue;
    mtd[t.c] = (mtd[t.c] || 0) + Math.abs(t.v);
  }
  const FIXED = new Set(["Housing", "Subscriptions"]);
  const budget = Object.entries(store.budget).map(([n, t]) => ({
    n, t: Number(t) || 0, a: Math.round((mtd[n] || 0) * 100) / 100, fixed: FIXED.has(n)
  }));
  const thru = day / daysInMonth;

  /* The shipped budget targets belong to a demo persona, so pace and leak maths
   * would be wrong for a real user until they are replaced. Derive a suggestion
   * from the last three complete months of their own spending. */
  const suggestedBudget = (() => {
    const start = new Date(today.getFullYear(), today.getMonth() - 3, 1).toISOString().slice(0, 10);
    const perMonth = {};
    for (const t of txns) {
      if (t.date < start || t.date >= monthStart) continue;      // whole months only
      if (NON_BUDGET.has(t.c) || t.v > 0) continue;
      const m = t.date.slice(0, 7);
      (perMonth[t.c] ||= {})[m] = (perMonth[t.c]?.[m] || 0) + Math.abs(t.v);
    }
    const out = {};
    const seen = new Set();
    for (const [cat, months] of Object.entries(perMonth)) {
      const vals = Object.values(months);
      if (!vals.length) continue;
      Object.keys(months).forEach(m => seen.add(m));
      const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
      out[cat] = Math.max(25, Math.round(mean / 25) * 25);        // round to $25
    }
    /* Report the months actually available, not the months requested. With one
     * month of history this is a single month's spend, not an average. */
    return { targets: out, months: seen.size, basedOn: Object.keys(out).length };
  })();

  /* --- leaks (only what bank data can actually prove) --- */
  const leaks = [];
  const ignored = new Set(settings.ignoredLeaks || []);
  const byCategory = new Map();
  for (const s of outflows) {
    const key = s.personal_finance_category?.detailed || "OTHER";
    byCategory.set(key, [...(byCategory.get(key) || []), s]);
  }
  for (const s of outflows) {
    if (ignored.has(s.stream_id)) continue;
    const avg = Math.abs(Number(s.average_amount?.amount ?? 0));
    const last = Math.abs(Number(s.last_amount?.amount ?? avg));
    const name = s.merchant_name || s.description || "Recurring charge";
    const monthly = /WEEKLY/.test(s.frequency) ? last * 4.33 : /ANNUALLY/.test(s.frequency) ? last / 12 : last;
    const peers = byCategory.get(s.personal_finance_category?.detailed || "OTHER") || [];

    if (last > avg * 1.25 && avg > 0) {
      leaks.push({ id: s.stream_id, n: name, kind: "creep", m: monthly, cancel: true,
        why: `Charge rose from $${avg.toFixed(2)} to $${last.toFixed(2)} — a ${Math.round((last / avg - 1) * 100)}% increase with no plan change.` });
    } else if (peers.length > 1) {
      leaks.push({ id: s.stream_id, n: name, kind: "dupe", m: monthly, cancel: true,
        why: `Overlaps ${peers.length - 1} other active subscription${peers.length > 2 ? "s" : ""} in the same category.` });
    } else if (monthly > 0) {
      leaks.push({ id: s.stream_id, n: name, kind: "review", m: monthly, cancel: false,
        why: `Active ${String(s.frequency || "monthly").toLowerCase()} charge since ${s.first_date}. Bank data cannot see usage — confirm you still want it.` });
    }
  }
  for (const b of budget) {
    if (b.fixed || !b.t) continue;
    const ratio = b.a / (b.t * thru);
    if (ratio > 1.5) {
      leaks.push({ id: "pace:" + b.n, n: b.n, kind: "pace", cancel: false, m: Math.max(0, b.a / thru - b.t),
        why: `Running ${Math.round(ratio * 100)}% of pace. Projects to $${Math.round(b.a / thru)} against a $${b.t} budget.` });
    }
  }
  leaks.sort((a, b) => b.m - a.m);

  /* --- net worth history --- */
  const snapshots = store.snapshots || [];
  const anchors = snapshots.map(p => ({ date: p.date, v: p.net }));

  /* --- health --- */
  const monthlyBurn = budget.reduce((s, b) => s + b.t, 0) || 1;
  const income = txns.filter(t => t.date >= monthStart && t.c === "Income").reduce((s, t) => s + t.v, 0);

  return {
    live: true,
    asOf: today.toISOString(),
    accounts: grouped,
    totals: {
      assets: Math.round(assets), liabilities: Math.round(liab),
      net: Math.round(assets - liab), invested: Math.round(invested), liquid: Math.round(liquid)
    },
    metrics: {
      runwayMonths: +(liquid / monthlyBurn).toFixed(1),
      monthlyBurn,
      incomeMTD: Math.round(income),
      savingsRate: null                                  // needs gross income; set in settings if wanted
    },
    realEstate,
    properties,
    notes,
    crypto,
    altsTotal: realEstate.reduce((s, p) => s + p.mark, 0)
              + notes.reduce((s, n) => s + n.mark, 0)
              + crypto.reduce((s, c) => s + c.mark, 0),
    homeEquity: properties.reduce((s, p) => s + p.equity, 0),
    debts,
    txns,
    hiddenTxns: (settings.hiddenTxns || []).length,
    hiddenAccounts: hiddenList,
    budget,
    knownCategories: [...new Set([...Object.values(DETAILED), ...Object.values(PRIMARY), "Subscriptions"])]
      .filter(c => !NON_BUDGET.has(c)).sort(),
    suggestedBudget,
    budgetCustomised: Boolean(store.budgetCustomised),
    thru,
    day,
    daysInMonth,
    leaks,
    anchors,
    settings,
    items: items.map(i => ({
      itemId: i.itemId, institutionName: i.institutionName,
      status: i.status, lastSync: i.lastSync, error: i.error,
      addedAt: i.addedAt
    })),
    needsPromoDates: Object.values(grouped).flat().filter(a => a.needsPromoDate)
      .map(a => ({ id: a.id, name: a.name }))
  };
}
