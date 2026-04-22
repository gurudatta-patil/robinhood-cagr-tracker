/**
 * Upload Handler
 *
 * Replaces the server-side CSV POST with browser-side parsing.
 * Uses csv-parser.js, then fetches ACAT prices from the Node backend,
 * saves everything to IndexedDB, and triggers a re-compute.
 */

import { parseRobinhoodCSV, applySplitsToLots } from '../core/csv-parser.js';
import { saveTransactions, setSetting }          from '../store/db.js';
import { fetchHistoricalPrices }                  from '../core/price-service.js';

/**
 * wireUploadZone(zoneId, inputId, statusId, onComplete)
 * Attaches click / drag-drop / change events to an upload zone.
 */
export function wireUploadZone(zoneId, inputId, statusId, onComplete) {
  const zone   = document.getElementById(zoneId);
  const input  = document.getElementById(inputId);
  const status = document.getElementById(statusId);
  if (!zone || !input) return;

  zone.addEventListener('click',    ()  => input.click());
  zone.addEventListener('dragover', e  => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file, status, onComplete);
  });
  input.addEventListener('change', () => {
    if (input.files[0]) handleFile(input.files[0], status, onComplete);
    input.value = ''; // reset so same file can be re-imported
  });
}

async function handleFile(file, statusEl, onComplete) {
  if (!file.name.toLowerCase().endsWith('.csv')) {
    setStatus(statusEl, 'error', 'Please select a .csv file.');
    return;
  }

  setStatus(statusEl, 'loading', '<i class="fas fa-spinner fa-spin"></i>  Parsing ' + file.name + '…');

  try {
    const text = await file.text();

    // 1. Parse CSV in browser
    const { buys, cashEvents, splits, acatTransfers } = parseRobinhoodCSV(text);

    setStatus(statusEl, 'loading',
      `<i class="fas fa-spinner fa-spin"></i>  Fetching prices for ${acatTransfers.length} transferred position(s)…`);

    // 2. Fetch historical prices for ACAT transfers (need transfer-day basis)
    const acatStocks = [];
    for (const t of acatTransfers) {
      const endDate   = addDays(t.date, 5);
      const startDate = addDays(t.date, -10);
      let prices = {};
      try {
        prices = await fetchHistoricalPrices(t.symbol, startDate, endDate);
      } catch { /* fallback to 0 */ }

      const rawPrice = getPriceNear(prices, t.date);

      acatStocks.push({
        symbol:   t.symbol,
        quantity: t.quantity,
        price:    parseFloat(rawPrice.toFixed(4)) || 0,
        date:     t.date,
        source:   'transfer',
      });
    }

    // 3. Apply split events across all pre-split stock lots, including ACAT transfers.
    // The split ratio has to be derived from every pre-split position, not only buy lots.
    const adjustedStocks = applySplitsToLots([
      ...buys.map(b => ({ ...b })),
      ...acatStocks,
    ], splits);

    // 4. Build final transaction list
    const stockTxs = adjustedStocks.map(stock => ({ type: 'stock', ...stock }));
    const cashTxs = cashEvents.map(c => ({ type: 'cash', ...c }));
    const splitTxs = splits.map(s => ({ type: 'split', ...s }));

    const all = [...stockTxs, ...cashTxs, ...splitTxs];

    // 5. Save to IndexedDB (replaces old data)
    await saveTransactions(all);

    // 6. Summary
    const parts = [];
    if (buys.length)         parts.push(`${buys.length} trade(s)`);
    if (acatStocks.length)   parts.push(`${acatStocks.length} transfer(s) priced`);
    if (cashEvents.length)   parts.push(`${cashEvents.length} cash transaction(s)`);
    if (splits.length)       parts.push(`${splits.length} split(s) applied`);

    const msg = parts.length ? parts.join(' · ') : 'Nothing new to import';
    setStatus(statusEl, 'success',
      '<i class="fas fa-check-circle"></i>  ' + msg + '. Loading dashboard…');

    // 7. Trigger re-compute
    if (typeof onComplete === 'function') onComplete();

  } catch (err) {
    setStatus(statusEl, 'error', '<i class="fas fa-times-circle"></i>  ' + err.message);
    console.error('[upload]', err);
  }
}

function setStatus(el, type, html) {
  if (!el) return;
  el.className = 'upload-status ' + type;
  el.innerHTML = html;
}

/* ── helpers (duplicated here so upload.js has no dep on portfolio-engine) ── */
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().split('T')[0];
}

function getPriceNear(priceMap, dateStr) {
  if (!priceMap) return 0;
  if (priceMap[dateStr] != null) return priceMap[dateStr];
  for (let i = 1; i <= 10; i++) {
    const d = addDays(dateStr, -i); if (priceMap[d] != null) return priceMap[d];
  }
  for (let i = 1; i <= 10; i++) {
    const d = addDays(dateStr, i);  if (priceMap[d] != null) return priceMap[d];
  }
  return 0;
}
