/**
 * Portfolio Engine
 *
 * Pure functions — no DOM, no fetch, no side effects.
 * Shared computation logic for the browser-side app.
 *
 * Input: raw transaction arrays + price maps.
 * Output: consolidated holdings, summary stats, chart payloads.
 */

/* ── Date helpers ── */
export function daysBetween(dateStr) {
  const buy  = new Date(dateStr + 'T00:00:00');
  const now  = new Date();
  return Math.floor((now - buy) / 86400000);
}

export function yearsFrom(dateStr) {
  return daysBetween(dateStr) / 365.25;
}

/** CAGR helper */
export function calcCAGR(initial, final, years) {
  if (years <= 0 || initial <= 0 || final < 0) return 0;
  return parseFloat(((Math.pow(final / initial, 1 / years) - 1) * 100).toFixed(2));
}

export function stockUsesCash(stock) {
  return stock.source !== 'transfer';
}

export function calculateTotalDeposited(rawStocks, cashTransactions) {
  const depositCodes = new Set(['RTP', 'ACH', 'JNLE']);

  const cashDeposits = cashTransactions
    .filter(tx => depositCodes.has(tx.transCode))
    .reduce((sum, tx) => sum + parseFloat(tx.amount), 0);

  const transferValue = rawStocks
    .filter(stock => !stockUsesCash(stock))
    .reduce((sum, stock) => sum + parseFloat(stock.quantity) * parseFloat(stock.price), 0);

  return cashDeposits + transferValue;
}

export function normalizeTransferPrices(rawStocks, splitTransactions, historicalPrices) {
  const splitFactorFor = (symbol, afterDate) => splitTransactions
    .filter(split => split.symbol === symbol && split.date > afterDate)
    .reduce((factor, split) => factor * (split.ratio ?? 1), 1);

  return rawStocks.map(stock => {
    if (stock.source !== 'transfer') return stock;

    const splitFactor = splitFactorFor(stock.symbol, stock.date);
    if (splitFactor <= 1) return stock;

    const symbolHistory = historicalPrices[stock.symbol] ?? {};
    const splitAdjustedPrice = symbolHistory[stock.date] ?? 0;
    const storedPrice = parseFloat(stock.price);

    if (!splitAdjustedPrice || !storedPrice) return stock;

    if (Math.abs(storedPrice * splitFactor - splitAdjustedPrice) / splitAdjustedPrice <= 0.05) {
      return {
        ...stock,
        price: parseFloat(splitAdjustedPrice.toFixed(4)),
      };
    }

    return stock;
  });
}

export function normalizeSplitAdjustedLots(rawStocks, splitTransactions) {
  const workingStocks = rawStocks.map(stock => ({ ...stock }));
  const laterCorrectFactors = new Map();

  const orderedSplits = [...splitTransactions]
    .filter(split => split.symbol && split.date && split.ratio && split.sharesAdded)
    .sort((a, b) => b.date.localeCompare(a.date));

  for (const split of orderedSplits) {
    const storedRatio = split.ratio ?? 1;
    if (storedRatio <= 1) continue;

    const laterFactor = laterCorrectFactors.get(split.symbol) ?? 1;
    const affectedLots = workingStocks.filter(stock => stock.symbol === split.symbol && stock.date < split.date);
    if (!affectedLots.length) continue;

    const preSplitTotal = affectedLots.reduce(
      (sum, stock) => sum + (parseFloat(stock.quantity) / storedRatio / laterFactor),
      0,
    );
    if (preSplitTotal <= 0) continue;

    const correctedRatio = Math.round(1 + parseFloat(split.sharesAdded) / preSplitTotal);
    if (correctedRatio < 2 || correctedRatio === storedRatio) {
      laterCorrectFactors.set(split.symbol, laterFactor * storedRatio);
      continue;
    }

    for (const stock of affectedLots) {
      stock.quantity = parseFloat((parseFloat(stock.quantity) / storedRatio * correctedRatio).toFixed(6));
      stock.price = parseFloat((parseFloat(stock.price) * storedRatio / correctedRatio).toFixed(4));
    }

    split.ratio = correctedRatio;
    laterCorrectFactors.set(split.symbol, laterFactor * correctedRatio);
  }

  return { stocks: workingStocks, splits: orderedSplits };
}

/* ─────────────────────────────────────────────────────
   consolidateHoldings
  Consolidate raw lots by symbol

   Takes raw stock transactions [{symbol,quantity,price,date,source}]
   and merges into per-symbol positions with weighted-avg cost.
─────────────────────────────────────────────────────── */
export function consolidateHoldings(rawStocks) {
  const map = new Map();

  for (const s of rawStocks) {
    const sym = s.symbol;
    const qty = parseFloat(s.quantity);
    const px  = parseFloat(s.price);

    if (!map.has(sym)) {
      map.set(sym, {
        symbol:          sym,
        totalQuantity:   qty,
        totalInvestment: qty * px,
        earliestDate:    s.date,
        latestDate:      s.date,
        lots:            [s],
      });
    } else {
      const pos = map.get(sym);
      pos.totalQuantity   += qty;
      pos.totalInvestment += qty * px;
      if (s.date < pos.earliestDate) pos.earliestDate = s.date;
      if (s.date > pos.latestDate)   pos.latestDate   = s.date;
      pos.lots.push(s);
    }
  }

  return Array.from(map.values()).map(pos => ({
    symbol:        pos.symbol,
    quantity:      pos.totalQuantity,
    buyPrice:      pos.totalInvestment / pos.totalQuantity, // weighted avg
    totalInvestment: pos.totalInvestment,
    buyDate:       pos.earliestDate,
    purchaseCount: pos.lots.length,
    dateRange:     pos.earliestDate === pos.latestDate
                     ? pos.earliestDate
                     : `${pos.earliestDate} to ${pos.latestDate}`,
    lots:          pos.lots,
  }));
}

/* ─────────────────────────────────────────────────────
   enrichHoldings
   Adds live-price dependent fields to each consolidated position.
─────────────────────────────────────────────────────── */
export function enrichHoldings(consolidated, currentPrices) {
  return consolidated.map(pos => {
    const cp      = currentPrices[pos.symbol] ?? 0;
    const cv      = pos.quantity * cp;
    const pl      = cv - pos.totalInvestment;
    const plPct   = pos.totalInvestment > 0 ? pl / pos.totalInvestment * 100 : 0;
    const years   = yearsFrom(pos.buyDate);
    const cagr    = calcCAGR(pos.totalInvestment, cv, years);
    const days    = daysBetween(pos.buyDate);

    return {
      ...pos,
      currentPrice:     cp,
      currentValue:     cv,
      profitLoss:       pl,
      profitLossPercent: plPct,
      cagr,
      daysHeld:         days,
    };
  });
}

/* ─────────────────────────────────────────────────────
   computeSummary
  Summary calculations for the dashboard
─────────────────────────────────────────────────────── */
export function computeSummary(enriched, rawStocks, cashTransactions) {
  const totalCurrentValue  = enriched.reduce((s, p) => s + p.currentValue, 0);
  const totalInvestment    = enriched.reduce((s, p) => s + p.totalInvestment, 0);

  const cashIn = cashTransactions.reduce((s, tx) => s + parseFloat(tx.amount), 0);
  const stockCosts = rawStocks
    .filter(stockUsesCash)
    .reduce((s, st) => s + parseFloat(st.quantity) * parseFloat(st.price), 0);

  const cashBalance    = cashIn - stockCosts;
  const totalDeposited = calculateTotalDeposited(rawStocks, cashTransactions);

  const hasCashData      = cashTransactions.length > 0;
  const basis            = hasCashData && totalDeposited > 0 ? totalDeposited : totalInvestment;
  const cashSafe         = Math.max(0, cashBalance);
  const totalPortfolio   = totalCurrentValue + cashSafe;
  const totalPL          = totalPortfolio - basis;
  const portfolioCAGR    = computePortfolioCAGR(rawStocks, enriched);

  return {
    totalDeposited,
    totalInvestment,
    totalCurrentValue,
    cashBalance,
    cashSafe,
    totalPortfolio,
    totalPL,
    basis,
    portfolioCAGR,
    hasCashData,
  };
}

/** Investment-weighted portfolio CAGR */
function computePortfolioCAGR(rawStocks, enriched) {
  if (!rawStocks.length) return 0;

  // Build current price map from enriched holdings
  const cpMap = new Map(enriched.map(p => [p.symbol, p.currentPrice]));

  let totalWeightedInv = 0, totalWeightedDays = 0, totalCurrentValue = 0;

  for (const s of rawStocks) {
    const cp  = cpMap.get(s.symbol) ?? 0;
    const inv = parseFloat(s.quantity) * parseFloat(s.price);
    const cv  = parseFloat(s.quantity) * cp;
    const days = daysBetween(s.date);

    totalWeightedInv  += inv;
    totalWeightedDays += days * inv;
    totalCurrentValue += cv;
  }

  if (!totalWeightedInv) return 0;
  const avgDays  = totalWeightedDays / totalWeightedInv;
  const avgYears = avgDays / 365.25;

  return calcCAGR(totalWeightedInv, totalCurrentValue, avgYears);
}

/* ─────────────────────────────────────────────────────
   Allocation + performance payloads for charts
  Allocation and performance payload builders
─────────────────────────────────────────────────────── */
export function buildAllocationData(enriched, cashSafe) {
  let totalValue = enriched.reduce((s, p) => s + p.currentValue, 0) + cashSafe;

  const items = enriched.map(p => ({
    symbol:     p.symbol,
    value:      p.currentValue,
    percentage: totalValue > 0 ? p.currentValue / totalValue * 100 : 0,
  }));

  if (cashSafe > 0) {
    items.push({
      symbol:     'CASH',
      value:      cashSafe,
      percentage: totalValue > 0 ? cashSafe / totalValue * 100 : 0,
    });
  }

  return { items, totalValue };
}

export function buildPerformanceData(enriched) {
  return enriched.map(p => ({
    symbol:           p.symbol,
    investment:       p.totalInvestment,
    currentValue:     p.currentValue,
    profitLoss:       p.profitLoss,
    profitLossPercent: p.profitLossPercent,
    cagr:             p.cagr,
    daysHeld:         p.daysHeld,
  }));
}

/* ─────────────────────────────────────────────────────
   Per-lot enrichment (for the details modal)
  Detailed lot enrichment for the holdings modal
─────────────────────────────────────────────────────── */
export function enrichLots(lots, currentPrice) {
  return lots.map(lot => {
    const qty  = parseFloat(lot.quantity);
    const bp   = parseFloat(lot.price);
    const inv  = qty * bp;
    const cv   = qty * currentPrice;
    const pl   = cv - inv;
    const plPct = inv > 0 ? pl / inv * 100 : 0;
    return { ...lot, buyPrice: bp, investment: inv, currentPrice, currentValue: cv, profitLoss: pl, profitLossPercent: plPct };
  });
}
