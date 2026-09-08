/**
 * Live crypto prices.
 *
 * This runs in Node on your own machine, so unlike the browser it can reach a
 * price feed. It sends only ticker symbols to CoinGecko -- never balances,
 * quantities, account identifiers or anything else about you.
 *
 * The free endpoint needs CoinGecko's own coin ids rather than tickers, so the
 * id list is fetched once and cached to disk. Common tickers are hardcoded so
 * the usual case needs no lookup at all.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(DIR, "data", "coingecko-ids.json");
const API = "https://api.coingecko.com/api/v3";

/* Tickers are ambiguous across chains; these are the intended mappings. */
const KNOWN = {
  BTC: "bitcoin", ETH: "ethereum", SOL: "solana", ADA: "cardano", XRP: "ripple",
  DOGE: "dogecoin", DOT: "polkadot", MATIC: "matic-network", POL: "polygon-ecosystem-token",
  AVAX: "avalanche-2", LINK: "chainlink", LTC: "litecoin", BCH: "bitcoin-cash",
  UNI: "uniswap", ATOM: "cosmos", XLM: "stellar", ALGO: "algorand", VET: "vechain",
  FIL: "filecoin", AAVE: "aave", MKR: "maker", CRV: "curve-dao-token", ARB: "arbitrum",
  OP: "optimism", NEAR: "near", APT: "aptos", SUI: "sui", TIA: "celestia",
  USDC: "usd-coin", USDT: "tether", DAI: "dai", SHIB: "shiba-inu", TRX: "tron",
  HBAR: "hedera-hashgraph", ICP: "internet-computer", ETC: "ethereum-classic",
  XMR: "monero", INJ: "injective-protocol", RNDR: "render-token", GRT: "the-graph"
};

let idIndex = null;      // ticker -> coingecko id, lazily built
let lastPrices = { at: 0, data: {} };
const TTL_MS = 60_000;   // do not hammer a free endpoint

const readCache = () => {
  try { return JSON.parse(fs.readFileSync(CACHE, "utf8")); } catch { return null; }
};

async function loadIdIndex() {
  if (idIndex) return idIndex;
  const cached = readCache();
  if (cached && cached.at && Date.now() - cached.at < 30 * 86400_000) {
    idIndex = cached.map;
    return idIndex;
  }
  const r = await fetch(`${API}/coins/list`, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`CoinGecko coin list failed (${r.status})`);
  const list = await r.json();
  const map = {};
  /* Later entries do not overwrite earlier ones, so the first (usually the
   * canonical) id wins for a duplicated ticker. */
  for (const c of list) {
    const sym = String(c.symbol || "").toUpperCase();
    if (sym && !map[sym]) map[sym] = c.id;
  }
  Object.assign(map, KNOWN);              // curated mappings always win
  idIndex = map;
  try { fs.writeFileSync(CACHE, JSON.stringify({ at: Date.now(), map }), { mode: 0o600 }); } catch {}
  return idIndex;
}

export function resolveId(symbol, override) {
  if (override) return override;
  const s = String(symbol || "").toUpperCase();
  return KNOWN[s] || (idIndex && idIndex[s]) || null;
}

/**
 * @param {Array<{symbol:string, coingeckoId?:string}>} holdings
 * @returns {Promise<{prices:Object, unresolved:string[], at:string, cached:boolean}>}
 */
export async function fetchPrices(holdings) {
  const wanted = holdings.filter(h => h.symbol || h.coingeckoId);
  if (!wanted.length) return { prices: {}, unresolved: [], at: new Date().toISOString(), cached: false };

  /* The cache is only usable if it already covers every symbol asked for --
   * otherwise a coin added seconds after the last fetch would price at zero. */
  const asked = wanted.map(h => String(h.symbol || h.coingeckoId).toUpperCase());
  const covered = asked.every(s => lastPrices.data?.prices?.[s] || lastPrices.data?.unresolved?.includes(s));
  if (covered && Date.now() - lastPrices.at < TTL_MS) {
    return { ...lastPrices.data, cached: true };
  }

  let index = null;
  const needsLookup = wanted.some(h => !h.coingeckoId && !KNOWN[String(h.symbol).toUpperCase()]);
  if (needsLookup) { try { index = await loadIdIndex(); } catch (e) { console.log("[prices]", e.message); } }
  void index;

  const pairs = [], unresolved = [];
  for (const h of wanted) {
    const id = resolveId(h.symbol, h.coingeckoId);
    if (id) pairs.push([String(h.symbol || id).toUpperCase(), id]);
    else unresolved.push(String(h.symbol || "?").toUpperCase());
  }
  if (!pairs.length) return { prices: {}, unresolved, at: new Date().toISOString(), cached: false };

  const ids = [...new Set(pairs.map(p => p[1]))].join(",");
  const url = `${API}/simple/price?ids=${encodeURIComponent(ids)}&vs_currencies=usd&include_24hr_change=true`;
  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`CoinGecko price lookup failed (${r.status})`);
  const json = await r.json();

  const prices = {};
  for (const [sym, id] of pairs) {
    const row = json[id];
    if (row && typeof row.usd === "number") {
      prices[sym] = { usd: row.usd, change24h: row.usd_24h_change ?? null, id };
    } else unresolved.push(sym);
  }

  const out = { prices, unresolved, at: new Date().toISOString() };
  lastPrices = { at: Date.now(), data: out };
  return { ...out, cached: false };
}
