/**
 * Compute Worker
 *
 * Runs the portfolio engine off the main thread so large datasets
 * (many transactions, long date ranges) do not freeze the UI.
 *
 * Protocol:
 *   Main → Worker:  { type: 'COMPUTE', payload: { transactions, currentPrices, historicalPrices, benchmarks } }
 *   Worker → Main:  { type: 'RESULT',  payload: { holdings, summary, allocationData, performanceData, networthSeries } }
 *                 | { type: 'ERROR',   payload: { message } }
 */

import {
  consolidateHoldings,
  enrichHoldings,
  computeSummary,
  buildAllocationData,
  buildPerformanceData,
  normalizeSplitAdjustedLots,
  normalizeTransferPrices,
} from '../core/portfolio-engine.js';

import { computeNetworthSeries } from '../core/benchmark-engine.js';

self.onmessage = function (e) {
  const { type, payload } = e.data;
  if (type !== 'COMPUTE') return;

  try {
    const result = compute(payload);
    self.postMessage({ type: 'RESULT', payload: result });
  } catch (err) {
    self.postMessage({ type: 'ERROR', payload: { message: err.message } });
  }
};

function compute({ transactions, currentPrices, historicalPrices, benchmarks }) {
  // Separate transaction types
  const splitTransactions = transactions.filter(t => t.type === 'split');
  const splitNormalized = normalizeSplitAdjustedLots(
    transactions.filter(t => t.type === 'stock'),
    splitTransactions,
  );
  const rawStocks       = normalizeTransferPrices(
    splitNormalized.stocks,
    splitNormalized.splits,
    historicalPrices,
  );
  const cashTransactions = transactions.filter(t => t.type === 'cash');

  // Consolidate + enrich holdings
  const consolidated = consolidateHoldings(rawStocks);
  const enriched     = enrichHoldings(consolidated, currentPrices);

  // Summary stats
  const summary = computeSummary(enriched, rawStocks, cashTransactions);

  // Chart payloads
  const allocationData  = buildAllocationData(enriched, summary.cashSafe);
  const performanceData = buildPerformanceData(enriched);

  // Net worth vs benchmark series (full ALL-TIME; filtered in main thread per timeline)
  const networthSeries = computeNetworthSeries({
    rawStocks,
    cashTransactions,
    benchmarkTickers: benchmarks,
    symbolHistory:    historicalPrices,
    benchmarkHistory: Object.fromEntries(
      benchmarks.map(t => [t, historicalPrices[t] ?? {}])
    ),
  });

  return { holdings: enriched, summary, allocationData, performanceData, networthSeries };
}
