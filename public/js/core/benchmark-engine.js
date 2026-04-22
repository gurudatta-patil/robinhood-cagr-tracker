/**
 * Benchmark Engine
 *
 * Computes the weekly portfolio net-worth series and parallel benchmark series.
 *
 * Inputs:
 *   rawStocks:        [{symbol, quantity, price, date, source}]
 *   cashTransactions: [{date, transCode, amount}]
 *   benchmarkTickers: ['SPY', 'QQQ', ...]
 *   symbolHistory:    { AAPL: { '2022-01-03': 182.01, … }, … }
 *   benchmarkHistory: { SPY:  { '2022-01-03': 450.2,  … }, … }
 *
 * Output: { dates, portfolioValues, totalInvestments, benchmarks: {SPY:[…], QQQ:[…]} }
 */

const DEPOSIT_CODES = new Set(['RTP', 'ACH', 'JNLE']);

/* ── Date helpers ── */
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().split('T')[0];
}

function today() {
  return new Date().toISOString().split('T')[0];
}

/**
 * getPriceNear
 *
 * Looks up the closest available price to dateStr in priceMap,
 * searching backward then forward up to 30 days.
 */
export function getPriceNear(priceMap, dateStr) {
  if (!priceMap) return 0;
  if (priceMap[dateStr] != null) return priceMap[dateStr];

  for (let i = 1; i <= 30; i++) {
    const d = addDays(dateStr, -i);
    if (priceMap[d] != null) return priceMap[d];
  }
  for (let i = 1; i <= 30; i++) {
    const d = addDays(dateStr, i);
    if (priceMap[d] != null) return priceMap[d];
  }

  // Nearest available
  const dates = Object.keys(priceMap);
  if (!dates.length) return 0;
  const target = new Date(dateStr).getTime();
  let best = dates[0], bestDiff = Infinity;
  for (const d of dates) {
    const diff = Math.abs(new Date(d).getTime() - target);
    if (diff < bestDiff) { bestDiff = diff; best = d; }
  }
  return priceMap[best] ?? 0;
}

/* ─────────────────────────────────────────────────────
   computeNetworthSeries
  Compute portfolio and benchmark time series
─────────────────────────────────────────────────────── */
export function computeNetworthSeries({
  rawStocks,
  cashTransactions,
  benchmarkTickers,
  symbolHistory,
  benchmarkHistory,
}) {
  const empty = {
    dates: [], portfolioValues: [], totalInvestments: [],
    benchmarks: Object.fromEntries(benchmarkTickers.map(t => [t, []])),
  };

  if (!rawStocks.length && !cashTransactions.length) return empty;

  const deposits = cashTransactions
    .filter(tx => DEPOSIT_CODES.has(tx.transCode))
    .sort((a, b) => a.date.localeCompare(b.date));

  const sortedPurchases = [...rawStocks].sort((a, b) => a.date.localeCompare(b.date));

  // Transfers: value comes from ACAT (their price × qty), not cash
  const transferEvents = sortedPurchases
    .filter(s => s.source === 'transfer')
    .map(s => ({ date: s.date, amount: parseFloat(s.quantity) * parseFloat(s.price), cashAmount: 0 }));

  // Investment events: what benchmark "buys" on each event date
  let investmentEvents;
  if (deposits.length > 0) {
    investmentEvents = [
      ...deposits.map(d => ({ date: d.date, amount: parseFloat(d.amount), cashAmount: parseFloat(d.amount) })),
      ...transferEvents,
    ];
  } else {
    investmentEvents = sortedPurchases.map(s => {
      const inv = parseFloat(s.quantity) * parseFloat(s.price);
      return { date: s.date, amount: inv, cashAmount: s.source !== 'transfer' ? inv : 0 };
    });
  }
  investmentEvents.sort((a, b) => a.date.localeCompare(b.date));

  if (!investmentEvents.length && !sortedPurchases.length) return empty;

  // Pre-compute benchmark share counts per investment event
  const bmShareEvents = {};
  for (const ticker of benchmarkTickers) {
    bmShareEvents[ticker] = investmentEvents.map(ev => {
      const price = getPriceNear(benchmarkHistory[ticker], ev.date);
      return { date: ev.date, shares: price > 0 ? ev.amount / price : 0 };
    });
  }

  // Income flows (dividends, interest, etc.) — non-deposit cash
  const incomeData = cashTransactions
    .filter(tx => !DEPOSIT_CODES.has(tx.transCode))
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(tx => ({ date: tx.date, amount: parseFloat(tx.amount) }));

  // Purchase data — used to accumulate holdings
  const purchaseData = sortedPurchases.map(s => ({
    date:       s.date,
    symbol:     s.symbol,
    quantity:   parseFloat(s.quantity),
    investment: parseFloat(s.quantity) * parseFloat(s.price),
    usesCash:   s.source !== 'transfer',
  }));

  // Determine date range
  const candidateDates = [
    ...investmentEvents.map(e => e.date),
    sortedPurchases[0]?.date,
  ].filter(Boolean);
  const startDate = candidateDates.reduce((a, b) => a < b ? a : b);
  const endDate   = today();

  // Weekly timeline (same loop logic as Python)
  const datesOut      = [], portfolioValuesOut = [], totalInvestmentsOut = [];
  const bmValuesOut   = Object.fromEntries(benchmarkTickers.map(t => [t, []]));

  const holdings           = {};
  const bmCumShares        = Object.fromEntries(benchmarkTickers.map(t => [t, 0]));
  let cumulativeDeposited  = 0;
  let cumulativePrincipal  = 0;
  let cumulativeStockCost  = 0;
  let cumulativeIncome     = 0;

  let investIdx  = 0;
  let purchaseIdx = 0;
  let incomeIdx   = 0;
  const bmIdx     = Object.fromEntries(benchmarkTickers.map(t => [t, 0]));

  let currentDate  = startDate;
  let lastProcessed = null;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (currentDate > endDate) currentDate = endDate;

    // Accumulate investment events (for benchmark share counting)
    while (investIdx < investmentEvents.length && investmentEvents[investIdx].date <= currentDate) {
      cumulativeDeposited  += investmentEvents[investIdx].cashAmount;
      cumulativePrincipal  += investmentEvents[investIdx].amount;

      for (const ticker of benchmarkTickers) {
        while (bmIdx[ticker] < bmShareEvents[ticker].length &&
               bmShareEvents[ticker][bmIdx[ticker]].date <= currentDate) {
          bmCumShares[ticker] += bmShareEvents[ticker][bmIdx[ticker]].shares;
          bmIdx[ticker]++;
        }
      }
      investIdx++;
    }

    // Accumulate stock purchases
    while (purchaseIdx < purchaseData.length && purchaseData[purchaseIdx].date <= currentDate) {
      const p = purchaseData[purchaseIdx];
      holdings[p.symbol] = (holdings[p.symbol] ?? 0) + p.quantity;
      if (p.usesCash) cumulativeStockCost += p.investment;
      purchaseIdx++;
    }

    // Accumulate income
    while (incomeIdx < incomeData.length && incomeData[incomeIdx].date <= currentDate) {
      cumulativeIncome += incomeData[incomeIdx].amount;
      incomeIdx++;
    }

    const hasActivity = cumulativeDeposited > 0 || Object.keys(holdings).length > 0;
    if (hasActivity) {
      // Portfolio value = sum(symbol * price) + uninvested cash
      let portfolioValue = 0;
      for (const [sym, qty] of Object.entries(holdings)) {
        if (qty > 0) {
          const price = getPriceNear(symbolHistory[sym] ?? {}, currentDate);
          portfolioValue += qty * price;
        }
      }
      const cashBalance = cumulativeDeposited + cumulativeIncome - cumulativeStockCost;
      portfolioValue += Math.max(0, cashBalance);

      const totalInvested = cumulativePrincipal > 0 ? cumulativePrincipal : cumulativeStockCost;

      datesOut.push(currentDate);
      portfolioValuesOut.push(Math.round(portfolioValue * 100) / 100);
      totalInvestmentsOut.push(Math.round(totalInvested * 100) / 100);

      for (const ticker of benchmarkTickers) {
        const bmPrice = getPriceNear(benchmarkHistory[ticker] ?? {}, currentDate);
        bmValuesOut[ticker].push(Math.round(bmCumShares[ticker] * bmPrice * 100) / 100);
      }
    }

    lastProcessed = currentDate;
    if (currentDate === endDate) break;

    const next = addDays(currentDate, 7);
    currentDate = next > endDate && lastProcessed < endDate ? endDate : next;
  }

  return {
    dates:            datesOut,
    portfolioValues:  portfolioValuesOut,
    totalInvestments: totalInvestmentsOut,
    benchmarks:       bmValuesOut,
  };
}

/**
 * filterByTimeline — client-side slice of a full series.
 * Replaces the /api/networth_data/<timeline> endpoint.
 */
export function filterByTimeline(series, timeline) {
  if (timeline === 'ALL' || !series.dates.length) return series;

  const daysMap = { '1M': 30, '3M': 90, '6M': 180, '1Y': 365 };
  const days    = daysMap[timeline];
  if (!days) return series;

  const cutoff = addDays(today(), -days);
  const idxs   = series.dates.map((d, i) => [d, i]).filter(([d]) => d >= cutoff).map(([, i]) => i);
  if (!idxs.length) return series;

  return {
    dates:            idxs.map(i => series.dates[i]),
    portfolioValues:  idxs.map(i => series.portfolioValues[i]),
    totalInvestments: idxs.map(i => series.totalInvestments[i]),
    benchmarks:       Object.fromEntries(
      Object.entries(series.benchmarks).map(([t, vals]) => [t, idxs.map(i => vals[i])])
    ),
  };
}
