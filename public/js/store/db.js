/**
 * IndexedDB wrapper — promise-based
 *
 * Stores:
 *   transactions  – all imported stock/cash/split rows
 *   settings      – benchmarks list, etc.
 *   priceCache    – daily close prices keyed by "SYMBOL:YYYY-MM-DD"
 */

const DB_NAME    = 'cagr-calculator';
const DB_VERSION = 1;

let _db = null;

function open() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = e => {
      const db = e.target.result;

      // Transactions: stock buys, transfers, cash events, splits
      if (!db.objectStoreNames.contains('transactions')) {
        const ts = db.createObjectStore('transactions', { keyPath: 'id', autoIncrement: true });
        ts.createIndex('type',   'type',   { unique: false });
        ts.createIndex('symbol', 'symbol', { unique: false });
        ts.createIndex('date',   'date',   { unique: false });
      }

      // Key-value settings (benchmarks, lastImport, …)
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' });
      }

      // Price cache: { id: "AAPL:2024-01-03", price, fetchedAt }
      if (!db.objectStoreNames.contains('priceCache')) {
        db.createObjectStore('priceCache', { keyPath: 'id' });
      }
    };

    req.onsuccess = e => { _db = e.target.result; resolve(_db); };
    req.onerror   = e => reject(e.target.error);
  });
}

function tx(storeName, mode = 'readonly') {
  return open().then(db => {
    const transaction = db.transaction(storeName, mode);
    const store = transaction.objectStore(storeName);
    return { store, transaction };
  });
}

function req2promise(r) {
  return new Promise((res, rej) => {
    r.onsuccess = e => res(e.target.result);
    r.onerror   = e => rej(e.target.error);
  });
}

/* ── Transactions ── */

export async function saveTransactions(rows) {
  const { store } = await tx('transactions', 'readwrite');
  // Clear existing, then add fresh
  await req2promise(store.clear());
  for (const row of rows) {
    // Remove id so autoIncrement works
    const { id: _id, ...rest } = row;
    store.add(rest);
  }
}

export async function getTransactions() {
  const { store } = await tx('transactions', 'readonly');
  return req2promise(store.getAll());
}

export async function addTransaction(row) {
  const { store } = await tx('transactions', 'readwrite');
  const { id: _id, ...rest } = row;
  return req2promise(store.add(rest));
}

export async function deleteTransactionsBySymbol(symbol) {
  const { store } = await tx('transactions', 'readwrite');
  const index = store.index('symbol');
  const keys = await req2promise(index.getAllKeys(IDBKeyRange.only(symbol)));
  for (const key of keys) store.delete(key);
}

export async function clearAllTransactions() {
  const { store } = await tx('transactions', 'readwrite');
  return req2promise(store.clear());
}

/* ── Settings ── */

export async function getSetting(key, defaultValue = null) {
  const { store } = await tx('settings', 'readonly');
  const record = await req2promise(store.get(key));
  return record ? record.value : defaultValue;
}

export async function setSetting(key, value) {
  const { store } = await tx('settings', 'readwrite');
  return req2promise(store.put({ key, value }));
}

/* ── Price cache ── */

export async function getCachedPrices(ids) {
  const { store } = await tx('priceCache', 'readonly');
  const result = {};
  await Promise.all(ids.map(async id => {
    const record = await req2promise(store.get(id));
    if (record) result[id] = record.price;
  }));
  return result;
}

export async function setCachedPrices(entries) {
  // entries: [{ id, price }]
  const { store } = await tx('priceCache', 'readwrite');
  for (const entry of entries) store.put({ ...entry, fetchedAt: Date.now() });
}
