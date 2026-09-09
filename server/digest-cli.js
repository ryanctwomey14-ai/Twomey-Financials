/**
 * Weekly digest, from the command line.
 *
 *   node digest-cli.js check    is the transport usable, and is a send due?
 *   node digest-cli.js send     send the current week now, whether due or not
 *
 * `send` exists so the whole path -- sync, build, deliver -- can be proven on a
 * Wednesday rather than discovered to be broken on a Sunday.
 */
import "dotenv/config";
import * as store from "./store.js";
import * as mailer from "./mailer.js";
import * as schedule from "./schedule.js";
import * as digest from "./digest.js";
import { buildState } from "./normalize.js";

const g = s => `\x1b[32m${s}\x1b[0m`, r = s => `\x1b[31m${s}\x1b[0m`;
const y = s => `\x1b[33m${s}\x1b[0m`, dim = s => `\x1b[2m${s}\x1b[0m`;

const cmd = (process.argv[2] || "check").toLowerCase();

/* The CLI has no Plaid client, so it reports on stored data. A send triggered
 * here therefore describes the last sync rather than a fresh one -- fine for
 * proving delivery, which is all this command is for. The scheduled send inside
 * the server does sync first. */
const assemble = () => buildState(store.read());

const state = schedule.dueState();
console.log("");
console.log(`  Transport   ${mailer.configured() ? g(mailer.describe()) : r(mailer.describe())}`);
console.log(`  Recipient   ${state.to ? g(state.to) : r("none set")}`);
console.log(`  Schedule    ${state.enabled ? "Sundays from 12:00 ET" : r("disabled")}`);
console.log(`  This week   ${state.week}  ${state.due ? y("due") : dim("not due")}`);
if (store.read().settings.lastDigestAt)
  console.log(`  Last sent   ${store.read().settings.lastDigestAt} ${dim("(week ending " + store.read().settings.lastDigestWeek + ")")}`);
console.log("");

if (cmd === "check") {
  const v = await mailer.verify();
  if (v.ok) {
    console.log("  " + g("✓") + ` credentials accepted${v.note ? dim("  (" + v.note + ")") : ""}`);
    console.log(dim("    Prove delivery end to end with:  npm run digest:send"));
  } else {
    console.log("  " + r("✗") + " " + v.reason);
    if (!mailer.configured()) {
      console.log("");
      console.log("    Add an app password to server/.env:");
      console.log(dim("      1. Turn on 2-Step Verification at https://myaccount.google.com/security"));
      console.log(dim("      2. Create one at https://myaccount.google.com/apppasswords"));
      console.log(dim("      3. Put it after GMAIL_APP_PASSWORD= in server/.env"));
    }
    process.exitCode = 1;
  }
  console.log("");
} else if (cmd === "send") {
  try {
    const out = await schedule.sendNow({ assemble, force: true });
    if (out.sent) {
      console.log("  " + g("✓") + ` sent to ${out.to} via ${out.via}`);
      console.log(dim(`    week ending ${out.week}  ·  message ${out.id}`));
    } else {
      console.log("  " + r("✗") + " not sent: " + out.reason);
      process.exitCode = 1;
    }
  } catch (e) {
    console.log("  " + r("✗") + " " + e.message);
    process.exitCode = 1;
  }
  console.log("");
} else {
  console.log(`  Unknown command "${cmd}". Use check or send.`);
  process.exitCode = 1;
}
