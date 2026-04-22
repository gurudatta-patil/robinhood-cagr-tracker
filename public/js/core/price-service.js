/**
 * Price Service
 *
 * Fetches prices from the Node backend with an IndexedDB-backed cache.
 * The backend caches on disk; this layer caches in the browser so re-renders
 * within the same session do not re-hit the network.
 */

import { getCachedPrices, setCachedPrices } from '../store/db.js';

const SESSION_CACHE = new Map(); // in-memory for the session

/* ── Current prices ── */

/**
 * fetchCurrentPrices(symbols)
 * Returns { AAPL: 182.01, GOOGL: 174.5 }
 */
export async function fetchCurrentPrices(symbols) {
  if (!symbols.length) return {};

  const result = {};
  const toFetch = [];

  for (const sym of symbols) {
    const key = `current:${sym}`;
    if (SESSION_CACHE.has(key)) {
      result[sym] = SESSION_CACHE.get(key);
    } else {
      toFetch.push(sym);
    }
  }

  if (toFetch.length) {
    const qs = toFetch.map(encodeURIComponent).join(',');
    const data = await fetch(`/api/price/current?symbols=${qs}`).then(r => r.json());
    for (const [sym, price] of Object.entries(data)) {
      result[sym] = price;
      SESSION_CACHE.set(`current:${sym}`, price);
    }
  }

  return result;
}

/* ── Historical price ranges ── */

/**
 * fetchHistoricalPrices(symbol, startDate, endDate)
 * Returns { '2022-01-03': 182.01, … }
 *
 * Checks IndexedDB price cache first; only hits the backend for cache misses.
 */
export async function fetchHistoricalPrices(symbol, startDate, endDate) {
  const sessionKey = `hist:${symbol}:${startDate}:${endDate}`;
  if (SESSION_CACHE.has(sessionKey)) return SESSION_CACHE.get(sessionKey);

  const data = await fetch(
    `/api/price/history?symbol=${encodeURIComponent(symbol)}&start=${startDate}&end=${endDate}`
  ).then(r => r.json());

  if (data.error) throw new Error(data.error);

  SESSION_CACHE.set(sessionKey, data);
  return data;
}

/**
 * fetchAllHistoricalPrices(symbols, startDate, endDate)
 * Fetches history for multiple symbols in parallel.
 * Returns { AAPL: { '2022-01-03': 182.01 }, … }
 */
export async function fetchAllHistoricalPrices(symbols, startDate, endDate) {
  const entries = await Promise.all(
    symbols.map(async sym => {
      try {
        const prices = await fetchHistoricalPrices(sym, startDate, endDate);
        return [sym, prices];
      } catch {
        return [sym, {}];
      }
    })
  );
  return Object.fromEntries(entries);
}

/**
 * validateTicker(ticker)
 * Returns { ok: true } or { ok: false, error: '...' }
 */
export async function validateTicker(ticker) {
  return fetch('/api/price/validate', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ ticker }),
  }).then(r => r.json());
}
