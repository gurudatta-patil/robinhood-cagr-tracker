/**
 * CAGR Calculator — Main App
 *
 * Owns the application lifecycle:
 *   1. Load transactions from IndexedDB
 *   2. Fetch prices (current + historical) from Node backend
 *   3. Spin up Web Worker for portfolio computation
 *   4. Render appropriate view (upload hero vs dashboard)
 *   5. Handle user actions: add position, delete, benchmark management
 */

import { getTransactions, saveTransactions, addTransaction,
         deleteTransactionsBySymbol, clearAllTransactions,
         getSetting, setSetting }                          from '../store/db.js';
import { fetchCurrentPrices, fetchAllHistoricalPrices,
         validateTicker }                                  from '../core/price-service.js';
import { getCumulativeSplitFactor }                        from '../core/csv-parser.js';
import { enrichLots }                                      from '../core/portfolio-engine.js';
import { renderAllocation, renderPerformance, renderNetworth,
         renderNetworthTimeline, renderBenchmarkChips,
         BENCHMARK_COLORS }                                from './charts.js';
import { wireUploadZone }                                  from './upload.js';

/* ── Worker ── */
const worker = new Worker('/js/worker/compute.worker.js', { type: 'module' });

/* ── App state ── */
let state = {
  transactions:    [],
  currentPrices:   {},
  historicalPrices:{},
  benchmarks:      ['SPY'],
  computed:        null,   // last worker result
  currentTimeline: '1Y',
};

/* ═══════════════════════════════════════════════════
   BOOT
═══════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', async () => {
  // Wire upload zones (hero + modal)
  wireUploadZone('hero-upload-zone',  'hero-csv-input',  'hero-upload-status',  onImportComplete);
  wireUploadZone('modal-upload-zone', 'modal-csv-input', 'modal-upload-status', onImportComplete);

  // Set today's date on add-stock form
  const dateInput = document.getElementById('buy_date');
  if (dateInput) dateInput.valueAsDate = new Date();

  // Add-stock forms (hero view + dashboard view)
  document.getElementById('add-stock-form')?.addEventListener('submit', handleAddStock);
  document.getElementById('add-stock-form-dashboard')?.addEventListener('submit', handleAddStock);

  // Worker result handler
  worker.onmessage = e => {
    const { type, payload } = e.data;
    if (type === 'RESULT') {
      state.computed = payload;
      renderDashboard(payload);
      hideLoading();
    } else if (type === 'ERROR') {
      console.error('[worker]', payload.message);
      showNotification('Computation error: ' + payload.message, 'error');
      hideLoading();
    }
  };

  // Load state from IndexedDB and decide which view to show
  state.benchmarks  = await getSetting('benchmarks', ['SPY']);
  state.transactions = await getTransactions();

  if (!state.transactions.length) {
    showView('upload');
  } else {
    showView('loading');
    await refreshAndCompute();
  }

  // Auto-refresh prices every 5 minutes when dashboard is visible
  setInterval(async () => {
    if (state.computed) {
      await refreshAndCompute(true);
    }
  }, 5 * 60 * 1000);
});

/* ═══════════════════════════════════════════════════
   CORE COMPUTE FLOW
═══════════════════════════════════════════════════ */
async function refreshAndCompute(silent = false) {
  if (!silent) showLoading('Loading prices…');

  const stockTxs = state.transactions.filter(t => t.type === 'stock');
  const symbols  = [...new Set(stockTxs.map(t => t.symbol)), ...state.benchmarks];

  // Date range
  const dates    = stockTxs.map(t => t.date).sort();
  const startDate = dates[0] ?? new Date().toISOString().split('T')[0];
  const endDate   = new Date().toISOString().split('T')[0];

  // Fetch prices in parallel
  const [currentPrices, historicalPrices] = await Promise.all([
    fetchCurrentPrices(symbols),
    fetchAllHistoricalPrices(symbols, startDate, endDate),
  ]);

  state.currentPrices    = currentPrices;
  state.historicalPrices = historicalPrices;

  // Update last-refreshed label
  const lbl = document.getElementById('last-updated');
  if (lbl) lbl.textContent = 'Updated ' + new Date().toLocaleTimeString();

  // Dispatch to worker
  worker.postMessage({
    type:    'COMPUTE',
    payload: {
      transactions:     state.transactions,
      currentPrices:    currentPrices,
      historicalPrices: historicalPrices,
      benchmarks:       state.benchmarks,
    },
  });
}

/* ═══════════════════════════════════════════════════
   RENDER DASHBOARD
═══════════════════════════════════════════════════ */
function renderDashboard(computed) {
  const { holdings, summary, allocationData, performanceData, networthSeries } = computed;

  showView('dashboard');

  // Stats cards
  renderStats(summary);

  // Holdings table
  renderHoldings(holdings);

  // Charts
  renderAllocation(allocationData);
  renderPerformance(performanceData);
  renderNetworth(networthSeries, state.benchmarks);
  renderBenchmarkChips(state.benchmarks, removeBenchmark);
}

/* ── Stats cards ── */
function renderStats(s) {
  const el = document.getElementById('stats-row');
  if (!el) return;

  const fmt = n => '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:2 });
  const sign = n => n >= 0 ? '+' : '-';
  const pct  = (n, d) => d > 0 ? (n / d * 100).toFixed(1) : '0.0';

  const retPct = pct(s.totalPL, s.basis);

  el.innerHTML = `
    <div class="stat-card">
      <div class="stat-label">${s.hasCashData ? 'Total Deposited' : 'Total Invested'}</div>
      <div class="stat-value">${fmt(s.basis)}</div>
      <div class="stat-sub">Cost basis</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Stocks Value</div>
      <div class="stat-value">${fmt(s.totalCurrentValue)}</div>
      <div class="stat-sub">Market value</div>
    </div>
    ${s.hasCashData ? `
    <div class="stat-card">
      <div class="stat-label">Cash Balance</div>
      <div class="stat-value">${fmt(s.cashSafe)}</div>
      <div class="stat-sub">Uninvested</div>
    </div>
    <div class="stat-card highlight">
      <div class="stat-label">Total Portfolio</div>
      <div class="stat-value">${fmt(s.totalPortfolio)}</div>
      <div class="stat-sub">Net worth</div>
    </div>` : ''}
    <div class="stat-card">
      <div class="stat-label">Total P&amp;L</div>
      <div class="stat-value ${s.totalPL >= 0 ? 'positive' : 'negative'}">
        ${sign(s.totalPL)}${fmt(s.totalPL)}
      </div>
      <div class="stat-sub">${sign(parseFloat(retPct))}${retPct}% total return</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Portfolio CAGR</div>
      <div class="stat-value ${s.portfolioCAGR >= 0 ? 'positive' : 'negative'}">
        ${sign(s.portfolioCAGR)}${Math.abs(s.portfolioCAGR).toFixed(1)}%
      </div>
      <div class="stat-sub">Annualised return</div>
    </div>
  `;
}

/* ── Holdings table ── */
function renderHoldings(holdings) {
  const count = document.getElementById('holdings-count');
  if (count) count.textContent = `${holdings.length} position${holdings.length !== 1 ? 's' : ''}`;

  const tbody = document.getElementById('holdings-body');
  if (!tbody) return;

  if (!holdings.length) {
    tbody.innerHTML = `<tr><td colspan="11" style="text-align:center;padding:60px;color:var(--fg-muted);font-family:var(--font-mono);font-size:.85rem;">No positions</td></tr>`;
    return;
  }

  const cagrClass = c => c >= 15 ? 'cagr-excellent' : c >= 10 ? 'cagr-good' : c >= 5 ? 'cagr-average' : 'cagr-poor';
  const sign = n => n >= 0 ? '+' : '';
  const fmt  = n => '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:2 });

  tbody.innerHTML = holdings.map(h => `
    <tr class="${h.purchaseCount > 1 ? 'clickable-row' : ''}"
        ${h.purchaseCount > 1 ? `onclick="window.__showLots('${h.symbol}')"` : ''}>
      <td>
        <div class="symbol-cell">
          <div class="symbol-icon">${h.symbol.slice(0, 3)}</div>
          <div>
            <div class="symbol-name">${h.symbol}</div>
            <div class="symbol-lots">
              ${h.purchaseCount} lot${h.purchaseCount !== 1 ? 's' : ''}
              ${h.purchaseCount > 1 ? '&nbsp;·&nbsp;<span style="color:var(--teal)">view</span>' : ''}
            </div>
          </div>
        </div>
      </td>
      <td class="mono">${h.quantity.toFixed(3)}</td>
      <td class="mono">${fmt(h.buyPrice)}</td>
      <td class="mono">${fmt(h.currentPrice)}</td>
      <td class="mono">${fmt(h.totalInvestment)}</td>
      <td class="mono">${fmt(h.currentValue)}</td>
      <td class="mono ${h.profitLoss >= 0 ? 'positive' : 'negative'}">${sign(h.profitLoss)}${fmt(h.profitLoss)}</td>
      <td class="mono ${h.profitLossPercent >= 0 ? 'positive' : 'negative'}">${sign(h.profitLossPercent)}${Math.abs(h.profitLossPercent).toFixed(1)}%</td>
      <td><span class="cagr-badge ${cagrClass(h.cagr)}">${sign(h.cagr)}${Math.abs(h.cagr).toFixed(1)}%</span></td>
      <td class="mono" style="color:var(--fg-muted)">${h.daysHeld}</td>
      <td onclick="event.stopPropagation()">
        <button class="btn-delete" onclick="window.__deleteSymbol('${h.symbol}')" title="Delete all ${h.symbol} positions">
          <i class="fas fa-trash"></i>
        </button>
      </td>
    </tr>
  `).join('');
}

/* ═══════════════════════════════════════════════════
   USER ACTIONS
═══════════════════════════════════════════════════ */

/* ── Add stock (manual) ── */
async function handleAddStock(e) {
  e.preventDefault();
  const form    = e.target;
  const symbol  = form.symbol.value.trim().toUpperCase();
  const qty     = parseFloat(form.quantity.value);
  const price   = parseFloat(form.buy_price.value);
  const date    = form.buy_date.value;

  if (!symbol || isNaN(qty) || isNaN(price) || !date) return;

  // Apply post-purchase splits
  const splitTxs    = state.transactions.filter(t => t.type === 'split');
  const splitFactor = getCumulativeSplitFactor(symbol, date, splitTxs);
  const adjQty      = parseFloat((qty   * splitFactor).toFixed(6));
  const adjPrice    = parseFloat((price / splitFactor).toFixed(4));

  const tx = { type:'stock', symbol, quantity:adjQty, price:adjPrice, date, source:'buy' };
  await addTransaction(tx);
  state.transactions = await getTransactions();

  form.reset();
  form.buy_date.valueAsDate = new Date();

  showNotification('Position added', 'success');
  showLoading('Recalculating…');
  await refreshAndCompute(true);
}

/* ── Delete all positions for a symbol ── */
window.__deleteSymbol = async function (symbol) {
  if (!confirm(`Delete ALL ${symbol} positions?`)) return;
  await deleteTransactionsBySymbol(symbol);
  state.transactions = await getTransactions();

  if (!state.transactions.filter(t => t.type === 'stock').length) {
    state.computed = null;
    showView('upload');
    return;
  }
  showLoading('Recalculating…');
  await refreshAndCompute(true);
};

/* ── Lot detail modal ── */
window.__showLots = function (symbol) {
  if (!state.computed) return;
  const holding = state.computed.holdings.find(h => h.symbol === symbol);
  if (!holding) return;

  const lots = enrichLots(holding.lots, holding.currentPrice);

  const sign = n => n >= 0 ? '+' : '-';
  const fmt  = n => '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:2 });

  let totalInv = 0, totalVal = 0, totalQty = 0;
  const rows = lots.map(l => {
    totalInv += l.investment; totalVal += l.currentValue; totalQty += parseFloat(l.quantity);
    const cls = l.profitLoss >= 0 ? 'positive' : 'negative';
    return `<tr>
      <td>${l.date}</td>
      <td>${parseFloat(l.quantity).toFixed(3)}</td>
      <td>${fmt(l.buyPrice)}</td>
      <td>${fmt(l.investment)}</td>
      <td>${fmt(l.currentPrice)}</td>
      <td>${fmt(l.currentValue)}</td>
      <td class="${cls}">${sign(l.profitLoss)}${fmt(l.profitLoss)}</td>
      <td class="${cls}">${sign(l.profitLossPercent)}${Math.abs(l.profitLossPercent).toFixed(1)}%</td>
    </tr>`;
  }).join('');

  const totalPL    = totalVal - totalInv;
  const totalPLpct = totalInv > 0 ? totalPL / totalInv * 100 : 0;
  const tcls       = totalPL >= 0 ? 'positive' : 'negative';

  document.getElementById('modal-title').textContent = `${symbol} — Purchase Lots`;
  document.getElementById('modal-body').innerHTML = `
    <table class="details-table">
      <thead><tr>
        <th>Date</th><th>Qty</th><th>Cost</th><th>Invested</th>
        <th>Price Now</th><th>Value</th><th>P&amp;L</th><th>Return</th>
      </tr></thead>
      <tbody>
        ${rows}
        <tr class="total-row">
          <td>TOTAL</td>
          <td>${totalQty.toFixed(3)}</td>
          <td>${fmt(totalInv / totalQty)}</td>
          <td>${fmt(totalInv)}</td>
          <td>${fmt(holding.currentPrice)}</td>
          <td>${fmt(totalVal)}</td>
          <td class="${tcls}">${sign(totalPL)}${fmt(totalPL)}</td>
          <td class="${tcls}">${sign(totalPLpct)}${Math.abs(totalPLpct).toFixed(1)}%</td>
        </tr>
      </tbody>
    </table>`;
  document.getElementById('purchase-modal').classList.add('open');
};

/* ── Modals ── */
window.closePurchaseDetails = () =>
  document.getElementById('purchase-modal').classList.remove('open');

window.openUploadModal = () =>
  document.getElementById('upload-modal').classList.add('open');

window.closeUploadModal = () =>
  document.getElementById('upload-modal').classList.remove('open');

document.addEventListener('click', e => {
  ['purchase-modal','upload-modal'].forEach(id => {
    const el = document.getElementById(id);
    if (el && e.target === el) el.classList.remove('open');
  });
});

/* ── Timeline ── */
window.setTimeline = function (tl, btn) {
  state.currentTimeline = tl;
  document.querySelectorAll('.tl-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  renderNetworthTimeline(tl);
};

/* ── Benchmark management ── */
window.addBenchmark = async function () {
  const input  = document.getElementById('benchmarkInput');
  const status = document.getElementById('benchmarkStatus');
  const ticker = input.value.trim().toUpperCase();
  if (!ticker) return;
  if (state.benchmarks.includes(ticker)) { input.value = ''; return; }

  status.textContent = 'Validating…';
  const { ok, error } = await validateTicker(ticker);
  if (!ok) { status.textContent = error || `Invalid ticker: ${ticker}`; return; }

  state.benchmarks = [...state.benchmarks, ticker];
  await setSetting('benchmarks', state.benchmarks);
  input.value = '';
  status.textContent = '';
  showLoading('Adding benchmark…');
  await refreshAndCompute(true);
};

async function removeBenchmark(ticker) {
  if (ticker === 'SPY') return;
  state.benchmarks = state.benchmarks.filter(t => t !== ticker);
  await setSetting('benchmarks', state.benchmarks);
  showLoading('Removing benchmark…');
  await refreshAndCompute(true);
}

/* ── Refresh prices ── */
window.refreshPrices = async function () {
  ['topbar-refresh-icon','fab-refresh-icon'].forEach(id => {
    document.getElementById(id)?.classList.add('fa-spin');
  });
  await refreshAndCompute(true);
  ['topbar-refresh-icon','fab-refresh-icon'].forEach(id => {
    document.getElementById(id)?.classList.remove('fa-spin');
  });
};

/* ── CSV import complete callback ── */
async function onImportComplete() {
  state.transactions = await getTransactions();
  const uploadModal = document.getElementById('upload-modal');
  if (uploadModal) uploadModal.classList.remove('open');
  showLoading('Computing portfolio…');
  await refreshAndCompute();
}

/* ═══════════════════════════════════════════════════
   VIEW MANAGEMENT
═══════════════════════════════════════════════════ */
function showView(view) {
  const views = { upload:'upload-view', dashboard:'dashboard-view', loading:'loading-view' };
  Object.values(views).forEach(id => {
    const el = document.getElementById(id);
    if (el) el.hidden = true;
  });
  const target = document.getElementById(views[view]);
  if (target) target.hidden = false;

  // Show / hide topbar dashboard controls and FAB
  const isDash = view === 'dashboard';
  document.getElementById('dashboard-actions')?.toggleAttribute('hidden', !isDash);
  document.getElementById('fab-btn')?.toggleAttribute('hidden', !isDash);
}

function showLoading(msg = 'Loading…') {
  const el = document.getElementById('loading-message');
  if (el) el.textContent = msg;
  showView('loading');
}

function hideLoading() {
  // called after worker posts RESULT; renderDashboard already called showView('dashboard')
}

/* ═══════════════════════════════════════════════════
   NOTIFICATIONS
═══════════════════════════════════════════════════ */
export function showNotification(message, type = 'info') {
  const el   = document.getElementById('notification');
  const text = document.getElementById('notification-text');
  const icon = document.getElementById('notif-icon');
  if (!el) return;

  text.textContent = message;
  icon.innerHTML =
    type === 'success' ? '<i class="fas fa-check-circle" style="color:var(--teal)"></i>' :
    type === 'error'   ? '<i class="fas fa-times-circle" style="color:var(--red)"></i>'  :
                         '<i class="fas fa-info-circle"  style="color:var(--blue)"></i>';
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 3600);
}
window.showNotification = showNotification;
