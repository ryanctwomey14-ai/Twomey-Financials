/* ---------------- weekly send ----------------
 *
 * Runs inside the server rather than as its own scheduled process, so it reuses
 * the sync path the dashboard already uses instead of a second copy of it.
 *
 * The rule: on or after Sunday noon Eastern, if the week that just ended has
 * not been sent, sync and send it. Nothing depends on the tick landing exactly
 * at noon -- the check is "is it due and unsent", so a machine that was asleep
 * at noon still sends when it wakes, and a machine left running all week sends
 * once and not again.
 */
import * as store from "./store.js";
import * as digest from "./digest.js";
import * as mailer from "./mailer.js";

const CHECK_EVERY_MS = 10 * 60 * 1000;

/* Eastern, not the machine's clock. The schedule was specified in ET and should
 * not move because a laptop travelled. */
const ZONE = "America/New_York";
const easternParts = (d = new Date()) => {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: ZONE, weekday: "short", hour: "numeric", hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(d);
  const g = t => f.find(p => p.type === t)?.value;
  return {
    weekday: g("weekday"),
    hour: Number(g("hour")),
    date: `${g("year")}-${g("month")}-${g("day")}`
  };
};

/* Eastern midnight for the given instant, so the digest's week boundaries are
 * drawn in ET rather than wherever the process happens to be. */
const easternNow = (d = new Date()) => new Date(easternParts(d).date + "T12:00:00");

export function dueState(now = new Date()) {
  const { weekday, hour } = easternParts(now);
  const w = digest.weekWindow(easternNow(now));
  const settings = store.read().settings || {};
  const alreadySent = settings.lastDigestWeek === w.to;

  /* A week that ended before tracking began has nothing in it. Reporting zeroes
   * for it would look like a week of no spending rather than a week of no data,
   * so it is skipped outright. */
  const beforeTracking = Boolean(settings.trackFrom) && w.to < settings.trackFrom;

  /* Sunday from noon. On any later day the week is still unsent and still worth
   * sending -- a missed Sunday should arrive late, not vanish. */
  const pastNoonSunday = weekday === "Sun" && hour >= 12;
  const laterInWeek = weekday !== "Sun";

  return {
    week: w.to,
    weekday, hour,
    enabled: settings.digestEnabled !== false,
    to: settings.digestTo || "",
    alreadySent, beforeTracking,
    due: (settings.digestEnabled !== false) && Boolean(settings.digestTo) &&
         !alreadySent && !beforeTracking && (pastNoonSunday || laterInWeek)
  };
}

/* `syncAll` is passed in rather than imported: the sync lives in server.js with
 * the Plaid client, and lifting it out to break the cycle would mean moving
 * working code for the sake of an import. */
export async function sendNow({ assemble, syncAll, force = false, now = new Date() } = {}) {
  const state = dueState(now);
  if (!force && !state.due) return { sent: false, reason: reasonFor(state), ...state };
  if (!mailer.configured()) return { sent: false, reason: "no mail transport: " + mailer.describe() };
  if (!state.to) return { sent: false, reason: "no recipient set" };

  /* Sync first. A week's figures reported from a stale file would be wrong in a
   * way nobody reading the email could detect. */
  if (syncAll) {
    try { await syncAll(); }
    catch (e) { console.error("[digest] sync failed, sending on stored data:", e.message); }
  }

  const S = assemble();
  const d = digest.buildDigest(S, store.read(), easternNow(now));
  const out = await mailer.send({
    to: state.to,
    subject: digest.subjectFor(d),
    html: digest.renderHtml(d),
    text: digest.renderText(d)
  });

  /* Stamped only after the send resolves, so a failure is retried on the next
   * tick instead of being recorded as delivered. */
  store.update(s => {
    s.settings.lastDigestWeek = d.window.to;
    s.settings.lastDigestAt = new Date().toISOString();
  });

  console.log(`[digest] sent ${d.window.from}..${d.window.to} to ${state.to} via ${out.via}`);
  return { sent: true, week: d.window.to, to: state.to, via: out.via, id: out.id };
}

function reasonFor(s) {
  if (!s.enabled) return "disabled";
  if (!s.to) return "no recipient set";
  if (s.alreadySent) return `already sent for the week ending ${s.week}`;
  if (s.beforeTracking) return `the week ending ${s.week} predates tracking — nothing to report`;
  return `not due yet (${s.weekday} ${s.hour}:00 ET; sends Sunday from 12:00)`;
}

export function start({ assemble, syncAll }) {
  const tick = async () => {
    try {
      const r = await sendNow({ assemble, syncAll });
      if (!r.sent && r.reason && !/not due|already sent|disabled|no recipient/.test(r.reason))
        console.log("[digest]", r.reason);
    } catch (e) {
      /* A failed send must never take the server with it. It will be retried on
       * the next tick, because lastDigestWeek was not stamped. */
      console.error("[digest] send failed:", e.message);
    }
  };
  setTimeout(tick, 20_000).unref?.();          // once shortly after boot
  setInterval(tick, CHECK_EVERY_MS).unref?.();
  console.log(`[digest] scheduler running — Sundays from 12:00 ET, checking every ${CHECK_EVERY_MS / 60000}m`);
}
