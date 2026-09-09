/* ---------------- weekly digest ----------------
 *
 * Builds the Sunday email from the same assembled state the dashboard renders,
 * so the two can never disagree. Nothing is recomputed here that normalize.js
 * already works out.
 *
 * The reporting week is Sunday 00:00 to Saturday 23:59 -- seven complete days
 * ending yesterday. Sending at Sunday noon means the week being described is
 * finished, never half-done.
 */

const D = 86400000;
const iso = d => d.toISOString().slice(0, 10);

export function weekWindow(now = new Date()) {
  /* Walk back to the most recent Saturday, then back six more days. */
  const end = new Date(now);
  end.setHours(0, 0, 0, 0);
  end.setDate(end.getDate() - (end.getDay() === 6 ? 0 : end.getDay() + 1));
  const start = new Date(end.getTime() - 6 * D);
  const prevEnd = new Date(start.getTime() - D);
  const prevStart = new Date(prevEnd.getTime() - 6 * D);
  return { from: iso(start), to: iso(end), prevFrom: iso(prevStart), prevTo: iso(prevEnd) };
}

const money = n => (n < 0 ? "-" : "") + "$" + Math.abs(Math.round(n)).toLocaleString("en-US");
const signed = n => (n > 0 ? "+" : n < 0 ? "-" : "") + "$" + Math.abs(Math.round(n)).toLocaleString("en-US");
const pctOf = n => (Math.round(n * 10) / 10).toFixed(1) + "%";
const dayName = s => new Date(s + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });

/* The dashboard's short name is the last word of the account title -- fine on a
 * cramped chip, meaningless in a sentence ("it: 334 days of 0% left"). Prose
 * gets the full name, with shouty issuer names put into title case. */
const cardName = d => {
  const raw = String(d.n || d.sn || "Card").replace(/\s+/g, " ").trim();
  const tidy = /[a-z]/.test(raw) ? raw
    : raw.replace(/[A-Z]{2,}/g, w => w[0] + w.slice(1).toLowerCase());
  return tidy.length > 42 ? tidy.slice(0, 40).trim() + "…" : tidy;
};

/* A snapshot taken before every institution was linked is not a smaller net
 * worth, it is a partial one. Comparing against it invents an enormous gain. */
function anchorAt(snapshots, onOrBefore, latestNet) {
  const usable = snapshots
    .filter(s => s.date <= onOrBefore)
    .filter(s => !latestNet || Math.abs(s.net) >= Math.abs(latestNet) * 0.5);
  return usable.length ? usable[usable.length - 1] : null;
}

export function buildDigest(S, store, now = new Date()) {
  const w = weekWindow(now);
  const snaps = (store.snapshots || []).slice().sort((a, b) => a.date.localeCompare(b.date));
  const txns = S.txns || [];

  const between = (d, a, b) => d >= a && d <= b;
  const week = txns.filter(t => between(t.date, w.from, w.to));
  const prior = txns.filter(t => between(t.date, w.prevFrom, w.prevTo));

  const OFF = new Set(["Income", "Transfer", "Debt payment"]);
  const spendOf = list => list.filter(t => t.v < 0 && !OFF.has(t.c));

  /* --- spending by category, this week against last --- */
  const bucket = list => {
    const m = {};
    for (const t of spendOf(list)) m[t.c] = (m[t.c] || 0) + Math.abs(t.v);
    return m;
  };
  const thisWk = bucket(week), lastWk = bucket(prior);
  const targets = Object.fromEntries((S.budget || []).map(b => [b.n, Number(b.t) || 0]));

  const categories = [...new Set([...Object.keys(thisWk), ...Object.keys(lastWk)])]
    .map(n => ({
      name: n,
      spent: thisWk[n] || 0,
      prior: lastWk[n] || 0,
      delta: (thisWk[n] || 0) - (lastWk[n] || 0),
      /* A monthly target set against one week is apples to oranges. Scale it to
       * the week so the comparison carries meaning. */
      weeklyTarget: targets[n] ? (targets[n] * 12) / 52 : 0
    }))
    .sort((a, b) => b.spent - a.spent);

  const spentTotal = categories.reduce((s, c) => s + c.spent, 0);
  const spentPrior = categories.reduce((s, c) => s + c.prior, 0);
  const income = week.filter(t => t.c === "Income").reduce((s, t) => s + t.v, 0);

  /* --- net worth --- */
  const latest = snaps.length ? snaps[snaps.length - 1] : null;
  const startAnchor = anchorAt(snaps, w.from, latest ? latest.net : null);
  const netNow = (S.totals && S.totals.net) || (latest ? latest.net : 0);
  const netThen = startAnchor ? startAnchor.net : null;

  /* --- investing: what you added, separated from what the market did --- */
  const contribRows = week.filter(t => t.contribution && t.v < 0);
  const contribWeek = contribRows.reduce((s, t) => s + Math.abs(t.v), 0);
  const investedNow = (S.totals && S.totals.invested) || 0;
  const investedThen = startAnchor && startAnchor.invested != null ? startAnchor.invested : null;
  const marketMove = investedThen === null ? null : investedNow - investedThen - contribWeek;
  const marketPct = investedThen ? (marketMove / investedThen) * 100 : null;

  const leaks = (S.leaks || []).slice().sort((a, b) => b.m - a.m);

  return {
    window: w,
    label: dayName(w.from) + " – " + dayName(w.to),
    coverage: {
      trackFrom: S.trackFrom,
      /* The first weeks after a reset have nothing to compare against. Saying
       * so beats printing a comparison that is really an artefact. */
      /* Tested against the tracking window, not against whether rows happen to
       * exist. A back-imported transfer sitting in the prior week does not mean
       * that week was tracked, and a comparison drawn from it would mislead. */
      hasPriorWeek: (S.trackFrom || "9999-99-99") <= w.prevFrom,
      hasStartAnchor: Boolean(startAnchor),
      daysTracked: S.trackingDays
    },
    spend: { total: spentTotal, prior: spentPrior, delta: spentTotal - spentPrior, income, categories },
    net: {
      now: netNow, then: netThen,
      delta: netThen === null ? null : netNow - netThen,
      assets: (S.totals && S.totals.assets) || 0,
      liabilities: (S.totals && S.totals.liabilities) || 0
    },
    investing: {
      contributed: contribWeek,
      count: contribRows.length,
      monthToDate: (S.metrics && S.metrics.investedMTD) || 0,
      target: (S.metrics && S.metrics.investmentTarget) || 0,
      balance: investedNow,
      marketMove, marketPct
    },
    leaks: leaks.map(l => ({ name: l.n, monthly: l.m, thirtyYear: l.c30, why: l.why, cancel: l.cancel })),
    recommendations: recommend({ S, spentTotal, spentPrior, categories, now })
  };
}

/* Advice is only worth reading if it comes from this week's numbers. Every rule
 * below is gated on a real figure, and each carries that figure with it. */
function recommend({ S, spentTotal, spentPrior, categories, now }) {
  const out = [];
  const m = S.metrics || {};

  /* 1. the investing goal, with the days left to act on it */
  const target = m.investmentTarget || 0, mtd = m.investedMTD || 0;
  if (target) {
    const daysLeft = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate() - now.getDate();
    if (mtd < target) {
      out.push({
        tone: "act",
        head: money(target - mtd) + " short of the " + money(target) + " investing goal",
        body: daysLeft > 0
          ? daysLeft + " day" + (daysLeft === 1 ? "" : "s") + " left \u2014 " +
            money((target - mtd) / Math.max(1, daysLeft / 7)) + " a week closes it."
          : "The month is out of days."
      });
    } else {
      out.push({
        tone: "good",
        head: "Investing goal met \u2014 " + money(mtd) + " of " + money(target),
        body: money(mtd - target) + " past target. Worth raising it."
      });
    }
  }

  /* 2. the category that moved most against last week */
  const worst = categories.filter(c => c.prior > 0).sort((a, b) => b.delta - a.delta)[0];
  if (worst && worst.delta > 50) {
    out.push({
      tone: "watch",
      head: worst.name + " up " + money(worst.delta),
      body: money(worst.spent) + " against " + money(worst.prior) + " last week" +
            (worst.weeklyTarget ? ". Target " + money(worst.weeklyTarget) + "/wk." : ", with no target set.")
    });
  }

  /* 3. categories running past their weekly share of the monthly target */
  const over = categories.filter(c => c.weeklyTarget && c.spent > c.weeklyTarget * 1.25);
  if (over.length) {
    const excess = over.reduce((s, c) => s + (c.spent - c.weeklyTarget), 0);
    out.push({
      tone: "watch",
      head: over.length + " categor" + (over.length === 1 ? "y" : "ies") + " ahead of pace",
      body: over.slice(0, 3).map(c => c.name).join(", ") +
            " \u2014 " + money(excess * 4.33) + " over budget if the month holds."
    });
  }

  /* 4. the most expensive cancellable recurring charge */
  const leak = (S.leaks || []).filter(l => l.cancel).sort((a, b) => b.c30 - a.c30)[0];
  if (leak) {
    out.push({
      tone: "act",
      head: "Cancel " + leak.n,
      body: money(leak.m) + " a month \u2014 " + money(leak.c30) + " over 30 years if invested instead."
    });
  }

  /* 5. the promo clock closest to expiring */
  const promo = (S.debts || []).filter(d => d.days != null && d.bal > 0).sort((a, b) => a.days - b.days)[0];
  if (promo && promo.days < 400) {
    const perMonth = promo.bal / Math.max(1, promo.days / 30.44);
    out.push({
      tone: promo.days < 120 ? "act" : "watch",
      head: cardName(promo) + ": " + promo.days + " days of 0% left",
      body: money(promo.bal) + " outstanding \u2014 " + money(perMonth) +
            " a month clears it before interest starts."
    });
  }

  /* 6. spending direction overall, when there is a week to compare against */
  if (spentPrior > 0 && spentTotal - spentPrior < -25) {
    const d = spentPrior - spentTotal;
    out.push({
      tone: "good",
      head: "Spending down " + money(d),
      body: money(spentTotal) + " against " + money(spentPrior) +
            " last week \u2014 " + money(d * 52) + " a year at that rate."
    });
  }

  /* Three at most. A list long enough to skim past is a list that gets skimmed
   * past, and the ones below the fold were the weakest anyway. */
  const rank = { act: 0, watch: 1, good: 2 };
  return out.sort((a, b) => rank[a.tone] - rank[b.tone]).slice(0, 3);
}

/* ---------------- rendering ----------------
 * Email HTML is not web HTML. Tables for layout, inline styles only, no flex,
 * no grid, no custom fonts -- Outlook and Gmail strip or ignore all of it. The
 * palette matches the console so the two read as one product.
 */
const C = {
  bg: "#0A0D0F", card: "#141A1E", line: "#232C31", soft: "#1B2328",
  t0: "#ECF2EF", t1: "#9EACA7", t2: "#6C7A75",
  gold: "#D4AF61", em: "#3DD68C", rose: "#E5686A"
};
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MONO = "'SF Mono',SFMono-Regular,Consolas,'Liberation Mono',Menlo,monospace";
const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const row = (label, value, colour, sub) =>
  '<tr>' +
    '<td style="padding:7px 0;border-bottom:1px solid ' + C.line + ';font:400 13.5px ' + FONT + ';color:' + C.t1 + '">' +
      esc(label) +
      (sub ? '<div style="font:400 11px ' + FONT + ';color:' + C.t2 + ';padding-top:2px">' + esc(sub) + '</div>' : '') +
    '</td>' +
    '<td align="right" style="padding:7px 0;border-bottom:1px solid ' + C.line + ';font:600 13.5px ' + MONO +
      ';color:' + (colour || C.t0) + ';white-space:nowrap">' + esc(value) + '</td>' +
  '</tr>';

const section = (title, inner) =>
  '<tr><td style="padding:20px 22px 0">' +
    '<div style="font:600 11px ' + MONO + ';letter-spacing:.14em;text-transform:uppercase;color:' + C.t2 +
      ';padding-bottom:10px">' + esc(title) + '</div>' + inner +
  '</td></tr>';

const TONE = { act: C.gold, watch: C.rose, good: C.em };

export function renderHtml(d) {
  const s = d.spend, n = d.net, inv = d.investing;

  const netLine = n.delta === null
    ? '<div style="font:400 12px ' + FONT + ';color:' + C.t2 + ';padding-top:4px">No snapshot from ' +
        esc(dayName(d.window.from)) + ' to compare against yet.</div>'
    : '<div style="font:600 13px ' + MONO + ';color:' + (n.delta >= 0 ? C.em : C.rose) + ';padding-top:4px">' +
        esc(signed(n.delta)) + ' this week</div>';

  const catRows = s.categories.length
    /* Six rows, and the target is named only where it is being missed. A target
     * repeated on every line is noise on the lines that are fine. */
    ? s.categories.slice(0, 6).map(c => {
        const over = c.weeklyTarget && c.spent > c.weeklyTarget;
        return row(c.name, money(c.spent), over ? C.rose : C.t0,
          over ? signed(c.delta) + " \u00b7 over " + money(c.weeklyTarget) + " target"
               : (c.prior > 0 ? signed(c.delta) + " vs last week" : null));
      }).join("")
    : '<tr><td style="font:400 13px ' + FONT + ';color:' + C.t2 + ';padding:6px 0">No spending recorded this week.</td></tr>';

  const invRows = [
    row("Into the brokerage", money(inv.contributed), inv.contributed > 0 ? C.em : C.t0,
        inv.count ? inv.count + " transfer" + (inv.count === 1 ? "" : "s") : "none this week"),
    row("Month to date", money(inv.monthToDate) + (inv.target ? " of " + money(inv.target) : ""),
        inv.target && inv.monthToDate >= inv.target ? C.em : C.gold,
        inv.target ? (inv.monthToDate >= inv.target ? "goal met" : money(inv.target - inv.monthToDate) + " short") : null),
    inv.marketMove === null
      ? row("Market", "not measurable yet", C.t2, "needs last Sunday's balance")
      : row("Market", signed(inv.marketMove), inv.marketMove >= 0 ? C.em : C.rose,
            inv.marketPct === null ? null : pctOf(inv.marketPct) + ", contributions excluded")
  ].join("");

  const leakRows = d.leaks.length
    ? d.leaks.slice(0, 3).map(l => row(l.name, money(l.monthly) + "/mo", C.t0,
        l.thirtyYear ? money(l.thirtyYear) + " over 30 years" + (l.why ? " \u00b7 " + l.why : "") : l.why)).join("")
    : '<tr><td style="font:400 13px ' + FONT + ';color:' + C.t2 + ';padding:6px 0;line-height:1.55">' +
      'Nothing flagged yet \u2014 detecting a recurring charge takes a few months of repeats.</td></tr>';

  const recs = d.recommendations.length
    ? d.recommendations.map(r =>
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:9px">' +
        '<tr><td style="background:' + C.soft + ';border-left:3px solid ' + (TONE[r.tone] || C.gold) +
          ';border-radius:0 8px 8px 0;padding:12px 14px">' +
          '<div style="font:600 14px ' + FONT + ';color:' + C.t0 + ';line-height:1.35">' + esc(r.head) + '</div>' +
          '<div style="font:400 12.5px ' + FONT + ';color:' + C.t1 + ';line-height:1.55;padding-top:5px">' +
            esc(r.body) + '</div>' +
        '</td></tr></table>').join("")
    : '<div style="font:400 13px ' + FONT + ';color:' + C.t2 + '">Nothing to flag this week.</div>';

  const sampleBanner = d.sample
    ? '<tr><td style="padding:16px 22px 0"><div style="background:rgba(229,104,106,.1);' +
      'border:1px solid rgba(229,104,106,.35);border-radius:8px;padding:11px 13px;font:600 12px ' + FONT +
      ';color:' + C.rose + ';line-height:1.5">SAMPLE — illustrative figures, not your accounts.' +
      '</div></td></tr>'
    : "";

  const caveat = d.coverage.hasPriorWeek ? "" :
    '<tr><td style="padding:16px 22px 0">' +
      '<div style="background:rgba(212,175,97,.08);border:1px solid rgba(212,175,97,.25);border-radius:8px;' +
        'padding:11px 13px;font:400 12px ' + FONT + ';color:' + C.t1 + ';line-height:1.55">' +
        'Tracking started ' + esc(dayName(d.coverage.trackFrom || d.window.from)) +
        ' \u2014 no earlier week to compare against yet.</div></td></tr>';

  return '<!doctype html>\n<html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="color-scheme" content="dark">' +
    '<title>Weekly review — ' + esc(d.label) + '</title></head>' +
    '<body style="margin:0;padding:0;background:' + C.bg + '">' +

    /* Preheader: the line inboxes show beside the subject. Hidden in the body. */
    '<div style="display:none;max-height:0;overflow:hidden;opacity:0">' +
      esc(money(s.total)) + ' spent · ' + esc(money(inv.contributed)) + ' invested · net worth ' +
      esc(money(n.now)) + '</div>' +

    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:' + C.bg +
      ';padding:22px 12px"><tr><td align="center">' +
    '<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;' +
      'background:' + C.card + ';border:1px solid ' + C.line + ';border-radius:14px;overflow:hidden">' +

    '<tr><td style="padding:22px 22px 0">' +
      '<div style="font:600 10.5px ' + MONO + ';letter-spacing:.18em;text-transform:uppercase;color:' + C.gold +
        '">Weekly review</div>' +
      '<div style="font:700 19px ' + FONT + ';color:' + C.t0 + ';padding-top:5px">' + esc(d.label) + '</div>' +
      '<div style="font:400 13px ' + FONT + ';color:' + C.t1 + ';padding-top:7px;line-height:1.55">' +
        'Spent <b style="color:' + C.t0 + '">' + esc(money(s.total)) + '</b>, invested ' +
        '<b style="color:' + (inv.contributed > 0 ? C.em : C.t0) + '">' + esc(money(inv.contributed)) +
        '</b>, net worth ' + (n.delta === null ? "at" : n.delta >= 0 ? "up to" : "down to") +
        ' <b style="color:' + C.t0 + '">' + esc(money(n.now)) + '</b>.' +
      '</div></td></tr>' +
    sampleBanner + caveat +

    section("Net worth",
      '<div style="font:700 30px ' + MONO + ';color:' + C.t0 + ';letter-spacing:-.02em">' + esc(money(n.now)) + '</div>' +
      netLine +
      /* Two rows for two numbers that are always read together is a table for
         no reason. One line says the same thing. */
      '<div style="font:400 12px ' + FONT + ';color:' + C.t2 + ';padding-top:7px">' +
        esc(money(n.assets)) + ' in assets, ' + esc(money(n.liabilities)) + ' owed</div>') +

    section("Spending by category",
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0">' + catRows +
      row("Total", money(s.total), C.t0, s.prior > 0 ? signed(s.delta) + " vs last week" : null) + '</table>') +

    section("Investing",
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0">' + invRows + '</table>') +

    section("Money leaks",
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0">' + leakRows + '</table>') +

    section("What to do about it", recs) +

    '<tr><td style="padding:20px 22px">' +
      '<div style="border-top:1px solid ' + C.line + ';padding-top:12px;font:400 11px ' + FONT + ';color:' +
        C.t2 + ';line-height:1.6">' +
        'From your linked accounts as of ' + esc(dayName(d.window.to)) + '. A late-posting charge can ' +
        'land in next week&rsquo;s figures. Not investment advice.' +
      '</div></td></tr>' +

    '</table></td></tr></table></body></html>';
}

export function renderText(d) {
  const s = d.spend, n = d.net, inv = d.investing;
  const L = [];
  L.push("WEEKLY REVIEW — " + d.label, "");
  if (d.sample) L.push("*** SAMPLE — illustrative figures, not your accounts. ***", "");
  L.push("Spent " + money(s.total) + " · invested " + money(inv.contributed) +
         " · net worth " + money(n.now), "");
  if (!d.coverage.hasPriorWeek)
    L.push("(Tracking started " + dayName(d.coverage.trackFrom || d.window.from) +
           " — no earlier week to compare against yet.)", "");

  L.push("NET WORTH",
         "  " + money(n.now) + (n.delta === null ? "" : "   " + signed(n.delta) + " this week"),
         "  " + money(n.assets) + " in assets, " + money(n.liabilities) + " owed", "");

  L.push("SPENDING BY CATEGORY");
  if (!s.categories.length) L.push("  Nothing recorded this week.");
  for (const c of s.categories.slice(0, 6)) {
    const over = c.weeklyTarget && c.spent > c.weeklyTarget;
    L.push("  " + c.name.padEnd(16) + money(c.spent).padStart(9) +
           (c.prior > 0 ? "   " + signed(c.delta) + " vs last week" : "") +
           (over ? "   over " + money(c.weeklyTarget) + " target" : ""));
  }
  L.push("  " + "TOTAL".padEnd(18) + money(s.total).padStart(9), "");

  L.push("INVESTING",
         "  Into the brokerage " + money(inv.contributed) +
           " (" + inv.count + " transfer" + (inv.count === 1 ? "" : "s") + ")",
         "  Month to date      " + money(inv.monthToDate) + (inv.target ? " of " + money(inv.target) : ""),
         "  Market             " + (inv.marketMove === null ? "not measurable yet" : signed(inv.marketMove)), "");

  L.push("MONEY LEAKS");
  if (!d.leaks.length) L.push("  Nothing flagged yet \u2014 needs a few months of repeats to detect.");
  for (const l of d.leaks.slice(0, 3))
    L.push("  " + l.name + " — " + money(l.monthly) + "/mo" +
           (l.thirtyYear ? ", " + money(l.thirtyYear) + " over 30 years" : ""));
  L.push("");

  L.push("WHAT TO DO ABOUT IT");
  if (!d.recommendations.length) L.push("  Nothing to flag this week.");
  for (const r of d.recommendations) L.push("  * " + r.head, "    " + r.body, "");

  L.push("—", "From your linked accounts. Not investment advice.");
  return L.join("\n");
}

/* ---------------- sample ----------------
 * A digest built from representative figures rather than the real ones. Its
 * only job is to let the layout be judged before there is enough history to
 * fill it: with one week tracked, the real email renders half its sections
 * empty. Every screen that shows it must say it is a sample. */
export function sampleDigest(now = new Date()) {
  const w = weekWindow(now);
  const cat = (name, spent, prior, monthlyTarget) => ({
    name, spent, prior, delta: spent - prior,
    weeklyTarget: monthlyTarget ? (monthlyTarget * 12) / 52 : 0
  });
  return {
    sample: true,
    window: w,
    label: dayName(w.from) + " – " + dayName(w.to),
    coverage: { trackFrom: null, hasPriorWeek: true, hasStartAnchor: true, daysTracked: 84 },
    spend: {
      total: 1418, prior: 1642, delta: -224, income: 3120,
      categories: [
        cat("Dining", 412, 268, 1200),
        cat("Groceries", 336, 291, 1600),
        cat("Shopping", 264, 402, 1300),
        cat("Transport", 178, 210, 900),
        cat("Subscriptions", 128, 128, 600),
        cat("Health", 100, 341, 500)
      ]
    },
    net: { now: 358420, then: 352110, delta: 6310, assets: 798640, liabilities: 440220 },
    investing: {
      contributed: 1250, count: 2, monthToDate: 5199, target: 5000,
      balance: 63480, marketMove: 936, marketPct: 1.5
    },
    leaks: [
      { name: "Peloton All-Access", monthly: 44, thirtyYear: 89400, why: "Unused for 3 months", cancel: true },
      { name: "Adobe Creative Cloud", monthly: 60, thirtyYear: 121900, why: "Two overlapping plans", cancel: true },
      { name: "SiriusXM", monthly: 22, thirtyYear: 44700, why: "Promo rate ended", cancel: true }
    ],
    recommendations: [
      { tone: "act", head: "Cancel Adobe Creative Cloud",
        body: "$60 a month — $121,900 over 30 years if invested instead." },
      { tone: "watch", head: "Dining up $144",
        body: "$412 against $268 last week. Target $277/wk." },
      { tone: "good", head: "Investing goal met — $5,199 of $5,000",
        body: "$199 past target. Worth raising it." }
    ]
  };
}

export function subjectFor(d) {
  const bits = ["Spent " + money(d.spend.total)];
  if (d.investing.contributed > 0) bits.push("invested " + money(d.investing.contributed));
  if (d.net.delta !== null) bits.push("net " + signed(d.net.delta));
  return "Weekly review — " + d.label + " · " + bits.join(", ");
}
