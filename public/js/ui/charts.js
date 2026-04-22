/**
 * Charts UI
 *
 * Renders allocation, performance, and net-worth charts from
 * pre-computed data produced by the portfolio / benchmark engines.
 * Consumed by app.js — no direct API fetching here.
 */

import { filterByTimeline } from '../core/benchmark-engine.js';

/* ── Palette ── */
const C = {
  teal:  '#00d4aa', red: '#ff3b5c', blue: '#4f8ef7',
  gold:  '#f5a623', muted: '#334155',
  bg:    '#0d1220',
};
export const BENCHMARK_COLORS = [C.red, C.gold, '#8b5cf6', '#f97316', '#06b6d4', '#ec4899'];

/* ── Chart.js defaults ── */
Chart.defaults.color       = '#64748b';
Chart.defaults.font.family = "'DM Mono', monospace";
Chart.defaults.font.size   = 11;

const tooltipBase = {
  backgroundColor: C.bg,
  borderColor:     'rgba(255,255,255,0.1)',
  borderWidth:     1,
  padding:         13,
};

/* ── Chart instances ── */
let allocationChart  = null;
let performanceChart = null;
let networthChart    = null;

/* ── Store full series for timeline filtering ── */
let _fullSeries   = null;
let _benchmarks   = [];

/* ─────────────────────────────────────────────────────
   renderAllocation(allocationData)
   allocationData = { items: [{symbol, value, percentage}], totalValue }
─────────────────────────────────────────────────────── */
export function renderAllocation(allocationData) {
  const ctx = document.getElementById('allocationChart');
  if (!ctx) return;
  if (allocationChart) allocationChart.destroy();

  const palette = [C.teal, C.blue, C.gold, '#8b5cf6', '#f97316', '#06b6d4', '#84cc16', C.red, '#ec4899'];
  const { items } = allocationData;

  allocationChart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels:   items.map(i => i.symbol),
      datasets: [{
        data:                 items.map(i => i.value),
        backgroundColor:      palette.slice(0, items.length).map(c => c + '22'),
        borderColor:          palette.slice(0, items.length),
        borderWidth:          2,
        hoverBackgroundColor: palette.slice(0, items.length).map(c => c + '44'),
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: '68%',
      plugins: {
        legend: { position:'right', labels:{ padding:16, usePointStyle:true, pointStyleWidth:8 } },
        tooltip: {
          ...tooltipBase,
          callbacks: {
            label: ctx => {
              const item = items[ctx.dataIndex];
              return `  $${item.value.toFixed(2)}  (${item.percentage.toFixed(1)}%)`;
            },
          },
        },
      },
    },
  });
}

/* ─────────────────────────────────────────────────────
   renderPerformance(performanceData)
   performanceData = [{symbol, investment, currentValue, …}]
─────────────────────────────────────────────────────── */
export function renderPerformance(performanceData) {
  const ctx = document.getElementById('performanceChart');
  if (!ctx) return;
  if (performanceChart) performanceChart.destroy();

  performanceChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: performanceData.map(d => d.symbol),
      datasets: [
        {
          label: 'Invested',
          data: performanceData.map(d => d.investment),
          backgroundColor: C.blue + '28', borderColor: C.blue,
          borderWidth: 1.5, borderRadius: 6, borderSkipped: false,
        },
        {
          label: 'Current Value',
          data: performanceData.map(d => d.currentValue),
          backgroundColor: C.teal + '28', borderColor: C.teal,
          borderWidth: 1.5, borderRadius: 6, borderSkipped: false,
        },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position:'bottom', labels:{ usePointStyle:true, padding:16 } },
        tooltip: {
          ...tooltipBase,
          callbacks: { label: c => `  ${c.dataset.label}: $${c.parsed.y.toFixed(2)}` },
        },
      },
      scales: {
        y: {
          grid: { color:'rgba(255,255,255,0.04)' },
          ticks: { callback: v => '$' + (Math.abs(v) >= 1000 ? (v/1000).toFixed(1)+'k' : v) },
        },
        x: { grid: { display:false } },
      },
    },
  });
}

/* ─────────────────────────────────────────────────────
   renderNetworth(series, benchmarks)
   series = { dates, portfolioValues, totalInvestments, benchmarks:{SPY:[…]} }
   Call renderNetworthTimeline(tl) to change timeline without re-computing.
─────────────────────────────────────────────────────── */
export function renderNetworth(fullSeries, benchmarkTickers) {
  _fullSeries = fullSeries;
  _benchmarks = benchmarkTickers;
  renderNetworthTimeline('1Y');
}

export function renderNetworthTimeline(timeline) {
  const ctx = document.getElementById('networthChart');
  if (!ctx || !_fullSeries) return;

  const series = filterByTimeline(_fullSeries, timeline);
  if (networthChart) networthChart.destroy();

  const totalInv  = series.totalInvestments[series.totalInvestments.length - 1] ?? 0;
  const finalVal  = series.portfolioValues[series.portfolioValues.length - 1]   ?? 0;
  const portRet   = totalInv > 0 ? (finalVal - totalInv) / totalInv * 100 : 0;
  const sign      = v => v >= 0 ? '+' : '';

  const canvasCtx = ctx.getContext('2d');
  const height    = ctx.parentElement.clientHeight || 340;
  const grad      = canvasCtx.createLinearGradient(0, 0, 0, height);
  grad.addColorStop(0, C.teal + '33');
  grad.addColorStop(1, C.teal + '00');

  const datasets = [{
    label:                     `Portfolio (${sign(portRet)}${portRet.toFixed(1)}%)`,
    data:                      series.portfolioValues,
    borderColor:               C.teal,
    backgroundColor:           grad,
    borderWidth:               2, fill: true, tension: 0.3,
    pointRadius:               0, pointHoverRadius: 5,
    pointHoverBackgroundColor: C.teal,
  }];

  _benchmarks.forEach((ticker, i) => {
    const vals  = series.benchmarks[ticker] ?? [];
    const final = vals[vals.length - 1] ?? 0;
    const ret   = totalInv > 0 ? (final - totalInv) / totalInv * 100 : 0;
    const color = BENCHMARK_COLORS[i % BENCHMARK_COLORS.length];
    datasets.push({
      label:                     `${ticker} (${sign(ret)}${ret.toFixed(1)}%)`,
      data:                      vals,
      borderColor:               color,
      backgroundColor:           'transparent',
      borderWidth:               1.5, fill: false, tension: 0.3,
      borderDash:                [5, 4],
      pointRadius:               0, pointHoverRadius: 4,
      pointHoverBackgroundColor: color,
    });
  });

  datasets.push({
    label:           'Total Invested',
    data:            series.totalInvestments,
    borderColor:     C.muted, backgroundColor: 'transparent',
    borderWidth:     1, borderDash: [3, 3],
    fill: false, tension: 0.1, pointRadius: 0,
  });

  const timeUnit = timeline === '1M' ? 'day' : timeline === '3M' ? 'week' : 'month';

  networthChart = new Chart(ctx, {
    type: 'line',
    data: { labels: series.dates, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode:'index', intersect:false },
      plugins: {
        legend: { position:'bottom', labels:{ usePointStyle:true, padding:20 } },
        tooltip: {
          ...tooltipBase,
          callbacks: {
            label: c => `  ${c.dataset.label}: $${c.parsed.y.toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:2 })}`,
          },
        },
      },
      scales: {
        y: {
          grid: { color:'rgba(255,255,255,0.04)' },
          ticks: { callback: v => '$' + (Math.abs(v) >= 1000 ? (v/1000).toFixed(1)+'k' : v) },
        },
        x: {
          type: 'time', grid: { display:false },
          time: {
            unit: timeUnit,
            displayFormats: { day:'MMM d', week:'MMM d', month:'MMM yy' },
          },
          ticks: { maxTicksLimit:8 },
        },
      },
    },
  });
}

/* ── Benchmark chips ── */
export function renderBenchmarkChips(tickers, onRemove) {
  const container = document.getElementById('benchmarkChips');
  if (!container) return;
  container.innerHTML = '';
  tickers.forEach((ticker, i) => {
    const color = BENCHMARK_COLORS[i % BENCHMARK_COLORS.length];
    const chip  = document.createElement('span');
    chip.style.cssText = [
      'display:inline-flex','align-items:center','gap:5px',
      'padding:4px 10px','border-radius:20px',
      "font-family:'DM Mono',monospace",'font-size:0.7rem','font-weight:500',
      `background:${color}18`,`color:${color}`,`border:1px solid ${color}44`,
    ].join(';');
    chip.innerHTML = ticker === 'SPY'
      ? ticker
      : `${ticker} <button style="background:none;border:none;cursor:pointer;color:${color};font-size:13px;line-height:1;padding:0 2px;">&times;</button>`;
    if (ticker !== 'SPY') {
      chip.querySelector('button').onclick = () => onRemove(ticker);
    }
    container.appendChild(chip);
  });
}
