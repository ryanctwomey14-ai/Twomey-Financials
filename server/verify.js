/**
 * Confirms your Plaid credentials work, without you having to click through Link.
 *
 *   node verify.js          check the keys and report what products are enabled
 *   node verify.js --seed   additionally link a Plaid Sandbox test bank so the
 *                           dashboard has real API-sourced data to render
 *
 * --seed only works when PLAID_ENV=sandbox. It refuses to run against production.
 */
import "dotenv/config";
import { Configuration, PlaidApi, PlaidEnvironments, Products, CountryCode } from "plaid";
import * as store from "./store.js";

const ENV = (process.env.PLAID_ENV || "sandbox").toLowerCase();
const CLIENT_ID = process.env.PLAID_CLIENT_ID || "";
const SECRET = process.env.PLAID_SECRET || "";
const seed = process.argv.includes("--seed");

const ok = m => console.log("  \x1b[32mok\x1b[0m   " + m);
const no = m => console.log("  \x1b[31mfail\x1b[0m " + m);
const info = m => console.log("       " + m);

console.log(`\nMeridian credential check — environment: ${ENV}\n`);

if (!CLIENT_ID || !SECRET) {
  no("PLAID_CLIENT_ID and PLAID_SECRET are not both set in server/.env");
  info("Get them from https://dashboard.plaid.com/developers/keys");
  info("Remember: the secret is per-environment. Use the one matching PLAID_ENV.");
  process.exit(1);
}
ok(`keys present (client …${CLIENT_ID.slice(-4)}, secret …${SECRET.slice(-4)})`);

const plaid = new PlaidApi(new Configuration({
  basePath: PlaidEnvironments[ENV] || PlaidEnvironments.sandbox,
  baseOptions: { headers: { "PLAID-CLIENT-ID": CLIENT_ID, "PLAID-SECRET": SECRET } }
}));

const boom = (e, what) => {
  const d = e?.response?.data;
  no(`${what}: ${d?.error_code || e.message}`);
  if (d?.error_message) info(d.error_message);
  if (d?.error_code === "INVALID_API_KEYS")
    info("This usually means the secret belongs to a different environment than PLAID_ENV.");
  if (d?.error_code === "INVALID_PRODUCT" || d?.error_code === "PRODUCTS_NOT_SUPPORTED")
    info("Enable the product on your Plaid dashboard, or it will simply be skipped.");
  return null;
};

/* 1. credentials */
try {
  const r = await plaid.institutionsGet({ count: 1, offset: 0, country_codes: [CountryCode.Us] });
  ok(`credentials accepted by api.plaid.com (${r.data.total} US institutions reachable)`);
} catch (e) {
  boom(e, "credential check");
  if (ENV === "production" && e?.response?.data?.error_code === "INVALID_API_KEYS") {
    info("");
    info("In production this almost always means one of two things:");
    info("  1. You used the sandbox secret. Production has its own secret.");
    info("  2. Your Plaid account does not have production access approved yet.");
    info("     Request it at dashboard.plaid.com -> Team Settings -> Company Details,");
    info("     then Developers -> Keys will show a production secret.");
  }
  process.exit(1);
}

/* 2. can we actually create a production-grade link token with our products? */
try {
  const REQUIRED = (process.env.PLAID_PRODUCTS || "transactions").split(",").map(s => s.trim());
  const OPTIONAL = (process.env.PLAID_OPTIONAL_PRODUCTS || "liabilities,investments").split(",").map(s => s.trim()).filter(Boolean);
  const r = await plaid.linkTokenCreate({
    user: { client_user_id: "meridian-verify" },
    client_name: "Meridian Wealth Console",
    country_codes: [CountryCode.Us],
    language: "en",
    products: REQUIRED,
    ...(OPTIONAL.length ? { optional_products: OPTIONAL } : {})
  });
  ok(`link token created — required: ${REQUIRED.join(", ")}; optional: ${OPTIONAL.join(", ") || "none"}`);
  if (r.data.expiration) info(`token expires ${new Date(r.data.expiration).toLocaleTimeString()} (they are short-lived by design)`);
} catch (e) {
  boom(e, "link token");
  info("If a product is not enabled on your account, remove it from PLAID_OPTIONAL_PRODUCTS in .env.");
}

if (ENV === "production") {
  info("");
  info("Production reminders:");
  info("  • Plaid bills per connected item. Check your plan before linking many accounts.");
  info("  • Sandbox items already in store.json are held back automatically — tokens do not cross environments.");
  info("  • Without PLAID_WEBHOOK_URL, data refreshes when you press sync. That is fine for one user.");
}

/* 2. seed a sandbox item */
if (seed) {
  if (ENV !== "sandbox") {
    no("--seed refuses to run outside sandbox. Nothing was changed.");
    process.exit(1);
  }
  try {
    const inst = "ins_109508"; // First Platypus Bank
    const pub = await plaid.sandboxPublicTokenCreate({
      institution_id: inst,
      initial_products: [Products.Transactions]
    });
    const x = await plaid.itemPublicTokenExchange({ public_token: pub.data.public_token });
    store.addItem({
      itemId: x.data.item_id,
      accessToken: x.data.access_token,
      institutionId: inst,
      institutionName: "First Platypus Bank (Sandbox)"
    });
    ok(`sandbox item linked (${x.data.item_id})`);
    info("Now run:  npm start   then open http://127.0.0.1:4800  and press the sync button.");
  } catch (e) { boom(e, "sandbox seed"); }
} else {
  info("");
  info("Add --seed to link a Plaid Sandbox bank and see real API data flow through.");
}

console.log("");
