/**
 * Robinhood CSV parser — browser-side
 * Ported from the legacy server implementation.
 *
 * Uses Papa Parse (loaded as a global from CDN) for robust CSV tokenisation.
 * Returns normalised transaction arrays used by the browser-side app.
 */

/* ── Amount parser (port of parse_amount) ── */
function parseAmount(s) {
  if (!s || String(s).trim() === '') return 0;
  s = String(s).trim();
  const negative = s.startsWith('(') && s.endsWith(')');
  s = s.replace(/[()$,]/g, '');
  const val = parseFloat(s);
  if (isNaN(val)) return 0;
  return negative ? -val : val;
}

/* ── Date normaliser: MM/DD/YYYY → YYYY-MM-DD ── */
function normaliseDate(raw) {
  const m = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const [, mon, day, yr] = m;
  return `${yr}-${mon.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

/**
 * parseRobinhoodCSV(csvText)
 *
 * Returns:
 *   {
 *     buys: [{symbol, quantity, price, date, source:'buy'}],
 *     cashEvents: [{date, transCode, amount, description}],
 *     splits: [{symbol, date, sharesAdded}],
 *     acatTransfers: [{symbol, quantity, date, description}]
 *   }
 */
export function parseRobinhoodCSV(csvText) {
  // Papa Parse — expects global Papa from CDN
  const parsed = Papa.parse(csvText.trim(), {
    skipEmptyLines: true,
    header: false,
  });

  const rows = parsed.data;

  // Find the header row
  let headerIdx = -1;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i][0] && rows[i][0].toString().trim().replace(/"/g, '') === 'Activity Date') {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) throw new Error('No "Activity Date" header found — is this a Robinhood activity CSV?');

  const buys         = [];
  const cashEvents   = [];
  const splits       = [];
  const acatTransfers = [];

  const CASH_CODES = new Set(['RTP', 'ACH', 'JNLE', 'CDIV', 'MISC', 'SLIP', 'INT',
                               'GDBP', 'XENT_CC', 'ABIP', 'T/A', 'REC', 'GMPC', 'DTAX', 'GOLD']);

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length < 9 || !row[0]?.trim()) continue;

    const activityDate = row[0].trim().replace(/"/g, '');
    const instrument   = row[3].trim().replace(/"/g, '');
    const description  = row[4].trim().replace(/"/g, '').replace(/\n/g, ' ').slice(0, 200);
    const transCode    = row[5].trim().replace(/"/g, '');
    const quantityStr  = row[6].trim().replace(/"/g, '');
    const priceStr     = row[7].trim().replace(/"/g, '');
    const amountStr    = row[8].trim().replace(/"/g, '');

    if (!transCode || !activityDate) continue;

    const date = normaliseDate(activityDate);
    if (!date) continue;

    const amount = parseAmount(amountStr);

    if (transCode === 'Buy') {
      const quantity = quantityStr ? parseFloat(quantityStr) : 0;
      const price    = parseAmount(priceStr);
      if (instrument && quantity > 0 && price > 0) {
        buys.push({ symbol: instrument, quantity, price, date, source: 'buy' });
      }

    } else if (transCode === 'SPL') {
      if (instrument) {
        const sharesAdded = quantityStr ? parseFloat(quantityStr) : 0;
        splits.push({ symbol: instrument, date, sharesAdded });
      }

    } else if (transCode === 'ACATI') {
      if (instrument && quantityStr) {
        const qty = parseFloat(quantityStr);
        if (qty > 0) {
          acatTransfers.push({ symbol: instrument, quantity: qty, date, description });
        }
      } else if (amount !== 0) {
        cashEvents.push({ date, transCode: 'ACATI', amount, description });
      }

    } else if (CASH_CODES.has(transCode)) {
      cashEvents.push({ date, transCode, amount, description });
    }
  }

  return { buys, cashEvents, splits, acatTransfers };
}

/**
 * applySplitsToLots(buys, splits)
 *
 * Mutates quantities/prices in `buys` based on SPL events.
 * Mirrors the legacy split-application logic.
 */
export function applySplitsToLots(buys, splits) {
  const result = buys.map(b => ({ ...b })); // shallow copy
  const workingSplits = splits.map(s => ({ ...s }));

  for (let idx = 0; idx < workingSplits.length; idx++) {
    const spl = workingSplits[idx];
    const { symbol, date: splitDate, sharesAdded } = spl;

    // Pre-split lots for this symbol
    const preLots = result.filter(b => b.symbol === symbol && b.date < splitDate);
    const preTotal = preLots.reduce((s, b) => s + b.quantity, 0);
    if (preTotal <= 0) continue;

    const ratio = Math.round(1 + sharesAdded / preTotal);
    if (ratio < 2) continue;

    splits[idx].ratio = ratio;

    for (const lot of result) {
      if (lot.symbol === symbol && lot.date < splitDate) {
        lot.quantity = parseFloat((lot.quantity * ratio).toFixed(6));
        lot.price    = parseFloat((lot.price    / ratio).toFixed(4));
      }
    }
  }

  return result;
}

/**
 * getCumulativeSplitFactor(symbol, afterDate, splits)
 *
 * Returns the total split multiplier for splits that happened AFTER afterDate.
 * Used when normalising ACAT transfers and manual lots.
 */
export function getCumulativeSplitFactor(symbol, afterDate, splits) {
  return splits
    .filter(s => s.symbol === symbol && s.date > afterDate)
    .reduce((factor, s) => factor * s.ratio, 1);
}
