/**
 * Access control.
 *
 * On localhost with no password set, this does nothing — the server is only
 * reachable from your own machine anyway. The moment it is bound to anything
 * other than a loopback address, a password becomes mandatory and the process
 * refuses to start without one. Exposing real balances unauthenticated should
 * not be something you can do by forgetting a setting.
 */
import crypto from "node:crypto";

/* TWOMEY_PASSWORD is the current name; MERIDIAN_PASSWORD is still read so an
 * existing .env keeps working after the rename. */
const PASSWORD = process.env.TWOMEY_PASSWORD || process.env.MERIDIAN_PASSWORD || "";
const HOST = process.env.HOST || "127.0.0.1";
const LOOPBACK = /^(127\.|::1$|localhost$)/.test(HOST);

/* Sessions live in memory: restarting the server signs everyone out, which is
 * the right default for something holding financial data. */
const sessions = new Map();
const DAY = 86400_000;
const TTL = 7 * DAY;

const newToken = () => crypto.randomBytes(32).toString("base64url");

/* Constant-time compare so a wrong password cannot be found byte by byte. */
function samePassword(given) {
  const a = Buffer.from(String(given || ""));
  const b = Buffer.from(PASSWORD);
  if (a.length !== b.length) {
    crypto.timingSafeEqual(b, b);          // keep the timing flat anyway
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

function sweep() {
  const now = Date.now();
  for (const [t, exp] of sessions) if (exp < now) sessions.delete(t);
}

export function preflight() {
  if (!LOOPBACK && !PASSWORD) {
    console.error(`
  Refusing to start.

  HOST is set to ${HOST}, which is reachable from outside this machine, but
  TWOMEY_PASSWORD is not set. That combination would publish your accounts,
  balances and transactions to anyone who finds the address.

  Set TWOMEY_PASSWORD in server/.env, or leave HOST at 127.0.0.1.
`);
    process.exit(1);
  }
  return { enabled: Boolean(PASSWORD), host: HOST, loopback: LOOPBACK };
}

const parseCookies = h =>
  Object.fromEntries(String(h || "").split(";").map(s => s.trim().split("=")).filter(p => p[0]));

export function middleware(req, res, next) {
  if (!PASSWORD) return next();                       // localhost, no password configured
  if (req.path === "/api/login" || req.path === "/login.html") return next();

  const tok = parseCookies(req.headers.cookie).twomey;
  if (tok && sessions.has(tok) && sessions.get(tok) > Date.now()) {
    sessions.set(tok, Date.now() + TTL);               // sliding expiry
    return next();
  }
  if (req.path.startsWith("/api/")) return res.status(401).json({ error: "Not signed in." });
  res.redirect("/login.html");
}

export function login(req, res) {
  if (!PASSWORD) return res.json({ ok: true, authDisabled: true });
  if (!samePassword((req.body || {}).password)) {
    /* A flat delay blunts online guessing without needing a rate limiter. */
    return setTimeout(() => res.status(401).json({ error: "Wrong password." }), 600);
  }
  sweep();
  const tok = newToken();
  sessions.set(tok, Date.now() + TTL);
  res.setHeader("Set-Cookie",
    `twomey=${tok}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${TTL / 1000}${LOOPBACK ? "" : "; Secure"}`);
  res.json({ ok: true });
}

export function logout(req, res) {
  const tok = parseCookies(req.headers.cookie).twomey;
  if (tok) sessions.delete(tok);
  res.setHeader("Set-Cookie", "twomey=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
  res.json({ ok: true });
}

export const status = () => ({ enabled: Boolean(PASSWORD), host: HOST, loopback: LOOPBACK, sessions: sessions.size });
