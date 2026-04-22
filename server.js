/**
 * CAGR Calculator — Node.js Backend
 *
 * Sole responsibility: historical + current price lookups with disk cache.
 * Uses Yahoo Finance v8 chart API directly (no external SDK dependency).
 * All portfolio state, CSV parsing, and computation live in the browser.
 */

import express      from 'express';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname }   from 'path';
import { fileURLToPath }   from 'url';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const PORT       = process.env.PORT || 3000;
const CACHE_FILE = join(__dirname, 'price-cache.json');

// Cache TTLs (ms)
const TTL_CURRENT = 5  * 60 * 1000;      // 5 min  — live prices
const TTL_HISTORY = 24 * 60 * 60 * 1000; // 24 h   — historical bars

/* ── Disk-backed price cache ── */
let priceCache = {};
try {
  if (existsSync(CACHE_FILE)) priceCache = JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
} catch { /* start fresh */ }

function persistCache() {
  try { writeFileSync(CACHE_FILE, JSON.stringify(priceCache), 'utf8'); } catch {}
}

/* ── Yahoo Finance v8 helpers ── */
const YF_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; CAGR-Calculator/1.0)',
  'Accept':     'application/json',
};

async function yfFetch(url) {
  const res = await fetch(url, { headers: YF_HEADERS });
  if (!res.ok) throw new Error(`Yahoo Finance returned ${res.status}`);
  return res.json();
}

/** Fetch current price for one symbol */
async function getCurrentPrice(symbol) {
  const url  = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1d`;
  const json = await yfFetch(url);
  return json?.chart?.result?.[0]?.meta?.regularMarketPrice ?? 0;
}

/** Fetch daily close prices for a symbol over a date range.
 *  Returns { 'YYYY-MM-DD': price, … }  */
async function getHistoricalPrices(symbol, startDate, endDate) {
  const p1   = Math.floor(new Date(startDate).getTime() / 1000);
  const p2   = Math.floor(new Date(endDate).getTime()   / 1000) + 86400;
  const url  = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&period1=${p1}&period2=${p2}&events=splits`;
  const json = await yfFetch(url);

  const result = json?.chart?.result?.[0];
  if (!result) return {};

  const timestamps  = result.timestamps  ?? result.timestamp ?? [];
  const quotes      = result.indicators?.adjclose?.[0]?.adjclose
                   ?? result.indicators?.quote?.[0]?.close
                   ?? [];

  const prices = {};
  for (let i = 0; i < timestamps.length; i++) {
    const price = quotes[i];
    if (price == null) continue;
    const d = new Date(timestamps[i] * 1000).toISOString().split('T')[0];
    prices[d] = price;
  }

  // Heuristic retroactive split correction (same logic as original Python app)
  const sorted = Object.entries(prices).sort(([a], [b]) => a.localeCompare(b));
  for (let i = sorted.length - 1; i > 0; i--) {
    const prev = sorted[i - 1][1], curr = sorted[i][1];
    if (curr > 0 && prev / curr > 1.5) {
      const ratio = Math.round(prev / curr);
      for (let j = 0; j < i; j++) prices[sorted[j][0]] /= ratio;
    }
  }

  return prices;
}

/* ── Express app ── */
const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

/* ─────────────────────────────────────────────────────
   GET /api/price/current?symbols=AAPL,GOOGL,SPY
   Returns { AAPL: 182.01, GOOGL: 174.5, SPY: 510.2 }
───────────────────────────────────────────────────── */
app.get('/api/price/current', async (req, res) => {
  const symbols = (req.query.symbols || '')
    .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  if (!symbols.length) return res.json({});

  const result  = {};
  const toFetch = [];

  for (const sym of symbols) {
    const cached = priceCache[`${sym}:current`];
    if (cached && Date.now() - cached.at < TTL_CURRENT) {
      result[sym] = cached.price;
    } else {
      toFetch.push(sym);
    }
  }

  await Promise.allSettled(toFetch.map(async sym => {
    try {
      const price = await getCurrentPrice(sym);
      priceCache[`${sym}:current`] = { price, at: Date.now() };
      result[sym] = price;
    } catch {
      // Return stale price on error rather than 0
      result[sym] = priceCache[`${sym}:current`]?.price ?? 0;
    }
  }));

  persistCache();
  res.json(result);
});

/* ─────────────────────────────────────────────────────
   GET /api/price/history?symbol=AAPL&start=2022-01-01&end=2024-04-01
   Returns { "2022-01-03": 182.01, "2022-01-04": 180.5, … }
───────────────────────────────────────────────────── */
app.get('/api/price/history', async (req, res) => {
  const { symbol, start, end } = req.query;
  if (!symbol || !start || !end) {
    return res.status(400).json({ error: 'symbol, start, and end are required' });
  }

  const sym    = symbol.toUpperCase();
  const key    = `${sym}:hist:${start}:${end}`;
  const cached = priceCache[key];
  if (cached && Date.now() - cached.at < TTL_HISTORY) {
    return res.json(cached.prices);
  }

  try {
    const prices = await getHistoricalPrices(sym, start, end);
    priceCache[key] = { prices, at: Date.now() };
    persistCache();
    res.json(prices);
  } catch (e) {
    if (cached) return res.json(cached.prices); // stale fallback
    res.status(500).json({ error: e.message });
  }
});

/* ─────────────────────────────────────────────────────
   POST /api/price/validate  { ticker: "QQQ" }
───────────────────────────────────────────────────── */
app.post('/api/price/validate', async (req, res) => {
  const ticker = (req.body.ticker || '').toUpperCase().trim();
  if (!ticker) return res.status(400).json({ ok: false, error: 'No ticker provided' });
  try {
    const price = await getCurrentPrice(ticker);
    if (!price) return res.json({ ok: false, error: `No data found for ${ticker}` });
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

/* ── Catch-all: SPA routing ── */
app.get('*', (_req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n  CAGR Calculator  →  http://localhost:${PORT}\n`);
});
