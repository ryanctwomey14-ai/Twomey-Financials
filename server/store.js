/**
 * Local store for Meridian.
 *
 * Access tokens are the only secret here, so they are the only thing encrypted
 * (AES-256-GCM). Everything else stays readable JSON on purpose — budget targets
 * and goals are yours to edit in a text editor.
 *
 * Nothing in this file is ever transmitted anywhere. The file lives beside the
 * server and is gitignored.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(DIR, "data");
const STORE = path.join(DATA, "store.json");
const KEYFILE = path.join(DATA, ".key");

fs.mkdirSync(DATA, { recursive: true });

/* ---------- key management ---------- */
function loadKey() {
  if (process.env.MERIDIAN_KEY) {
    const k = Buffer.from(process.env.MERIDIAN_KEY.trim(), "hex");
    if (k.length !== 32) throw new Error("MERIDIAN_KEY must be 64 hex characters (32 bytes).");
    return k;
  }
  if (fs.existsSync(KEYFILE)) return Buffer.from(fs.readFileSync(KEYFILE, "utf8").trim(), "hex");
  const k = crypto.randomBytes(32);
  fs.writeFileSync(KEYFILE, k.toString("hex"), { mode: 0o600 });
  console.log("[store] generated a new encryption key at server/data/.key — back it up, or relinking is required.");
  return k;
}
const KEY = loadKey();

export function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return [iv.toString("base64"), c.getAuthTag().toString("base64"), enc.toString("base64")].join(".");
}

export function decrypt(blob) {
  const [iv, tag, data] = String(blob).split(".");
  const d = crypto.createDecipheriv("aes-256-gcm", KEY, Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(data, "base64")), d.final()]).toString("utf8");
}

/* ---------- defaults ---------- */
const BLANK = {
  items: [],
  snapshots: [],
  manualAssets: [],
  realEstate: [],          // GP and LP positions, marked at sponsor value until exit
  properties: [],          // primary home and other owned property, with its mortgage
  notes: [],               // promissory notes you hold as the lender
  crypto: [],              // self-custodied or unlinked crypto, priced by hand
  budget: {
    Housing: 2850, Groceries: 750, "Dining & delivery": 400, Shopping: 500,
    Subscriptions: 180, Transport: 320, "Health & fitness": 210,
    Utilities: 240, Travel: 600, "Everything else": 300
  },
  settings: {
    goal: 3200000,
    goalYears: 18,
    contribution: 4200,
    baseReturn: 0.075,
    extraDebtPayment: 954,
    emergencyMonths: 6,
    ignoredLeaks: []
  }
};

/* ---------- read / write ---------- */
let cache = null;

export function read() {
  if (cache) return cache;
  if (!fs.existsSync(STORE)) { cache = structuredClone(BLANK); return cache; }
  try {
    const raw = JSON.parse(fs.readFileSync(STORE, "utf8"));
    cache = { ...structuredClone(BLANK), ...raw,
      /* Once the user has edited their budget, the shipped defaults must not be
       * merged back in -- otherwise a deleted line reappears on restart. */
      budget: raw.budgetCustomised ? (raw.budget || {}) : { ...BLANK.budget, ...(raw.budget || {}) },
      settings: { ...BLANK.settings, ...(raw.settings || {}) } };
  } catch (e) {
    console.error("[store] store.json is unreadable, starting fresh:", e.message);
    cache = structuredClone(BLANK);
  }
  return cache;
}

/* Write atomically where the OS allows it.
 *
 * On Windows a rename fails with EPERM whenever anything else holds the target
 * open for even a moment -- Defender, the search indexer and OneDrive all do
 * this to files under Documents. The rename is still worth attempting, because
 * it is the only way to guarantee a reader never sees a half-written store, but
 * a transient lock must not lose the write and must never take down the server.
 */
const RETRYABLE = new Set(["EPERM", "EACCES", "EBUSY"]);

export function write(next) {
  cache = next ?? cache;
  const body = JSON.stringify(cache, null, 2);
  const tmp = STORE + ".tmp";

  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      fs.writeFileSync(tmp, body, { mode: 0o600 });
      fs.renameSync(tmp, STORE);
      return cache;
    } catch (e) {
      if (!RETRYABLE.has(e.code) || attempt === 5) {
        /* Last resort: write in place. Briefly non-atomic, but losing the write
         * outright is worse than a reader catching a partial file. */
        try {
          fs.writeFileSync(STORE, body, { mode: 0o600 });
          try { fs.unlinkSync(tmp); } catch {}
          console.warn(`[store] rename blocked (${e.code}); wrote in place instead`);
          return cache;
        } catch (fatal) {
          console.error("[store] could not persist:", fatal.message);
          throw fatal;                 // the caller decides; the process stays up
        }
      }
      /* Back off briefly and try again -- these locks last milliseconds. */
      const until = Date.now() + 15 * (attempt + 1);
      while (Date.now() < until) { /* spin: writes are rare and must stay sync */ }
    }
  }
  return cache;
}

export function update(fn) {
  const s = read();
  fn(s);
  return write(s);
}

/* ---------- items ---------- */
export function addItem({ itemId, accessToken, institutionId, institutionName, env = "sandbox" }) {
  return update(s => {
    const existing = s.items.find(i => i.itemId === itemId);
    const rec = {
      itemId,
      accessToken: encrypt(accessToken),
      institutionId,
      institutionName,
      env,                                 // a token is only valid in the env that minted it

      cursor: existing?.cursor ?? null,
      addedAt: existing?.addedAt ?? new Date().toISOString(),
      status: "ok",
      lastSync: null,
      error: null
    };
    if (existing) Object.assign(existing, rec);
    else s.items.push(rec);
  });
}

export function itemToken(item) { return decrypt(item.accessToken); }

export function removeItem(itemId) {
  return update(s => {
    s.items = s.items.filter(i => i.itemId !== itemId);
    s.transactions = (s.transactions || []).filter(t => t.itemId !== itemId);
    s.accounts = (s.accounts || []).filter(a => a.itemId !== itemId);
  });
}

/* ---------- daily net-worth snapshots ---------- */
export function recordSnapshot(assets, liabilities) {
  const date = new Date().toISOString().slice(0, 10);
  return update(s => {
    const net = assets - liabilities;
    const today = s.snapshots.find(p => p.date === date);
    if (today) Object.assign(today, { assets, liabilities, net });
    else s.snapshots.push({ date, assets, liabilities, net });
    s.snapshots.sort((a, b) => a.date.localeCompare(b.date));
    if (s.snapshots.length > 3700) s.snapshots = s.snapshots.slice(-3700);  // ~10 years
  });
}

export const paths = { DATA, STORE, KEYFILE };
