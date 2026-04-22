/* ─────────────────────────────────────────────────
   CAGR Calculator — Chart Rendering
   Manages: allocation, performance, net-worth charts
   and benchmark management UI.
   ───────────────────────────────────────────────── */

'use strict';

/* ── Color palette ── */
const C = {
  teal:      '#00d4aa',
  red:       '#ff3b5c',
  blue:      '#4f8ef7',
  gold:      '#f5a623',
  muted:     '#334155',
  tooltip_bg: '#0d1220',
};
const BENCHMARK_COLORS = [C.red, C.gold, '#8b5cf6', '#f97316', '#06b6d4', '#ec4899'];

/* ── Apply Chart.js defaults ── */
Chart.defaults.color       = '#64748b';
Chart.defaults.font.family = "'DM Mono', monospace";
Chart.defaults.font.size   = 11;

/* ── Chart instances ── */
let allocationChart = null;
let performanceChart = null;
let networthChart   = null;
let currentTimeline = '1Y';

/* ── Tooltip shared config ── */
const tooltipBase = {
  backgroundColor: C.tooltip_bg,
  borderColor:     'rgba(255,255,255,0.1)',
  borderWidth:     1,
  padding:         13,
};

/* ───────────────────────────────────────
   Allocation (doughnut)
─────────────────────────────────────── */
function loadAllocationChart() {
  fetch('/api/portfolio_data')
    .then(r => r.json())
    .then(data => {
      const ctx = document.getElementById('allocationChart');
      if (!ctx) return;

      if (allocationChart) allocationChart.destroy();

      const palette = [C.teal, C.blue, C.gold, '#8b5cf6', '#f97316', '#06b6d4', '#84cc16', C.red, '#ec4899'];

      allocationChart = new Chart(ctx, {
        type: 'doughnut',
        data: {
          labels: data.allocation.map(i => i.symbol),
          datasets: [{
            data:                data.allocation.map(i => i.value),
            backgroundColor:     palette.slice(0, data.allocation.length).map(c => c + '22'),
            borderColor:         palette.slice(0, data.allocation.length),
            borderWidth:         2,
            hoverBackgroundColor: palette.slice(0, data.allocation.length).map(c => c + '44'),
          }]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          cutout: '68%',
          plugins: {
            legend: {
              position: 'right',
              labels: { padding:16, usePointStyle:true, pointStyleWidth:8, color:'#64748b', font:{size:11} }
            },
            tooltip: {
              ...tooltipBase,
              callbacks: {
                label: ctx => {
                  const item = data.allocation[ctx.dataIndex];
                  return `  $${item.value.toFixed(2)}  (${item.percentage.toFixed(1)}%)`;
                }
              }
            }
          }
        }
      });
    });
}

/* ───────────────────────────────────────
   Performance (grouped bar)
─────────────────────────────────────── */
function loadPerformanceChart() {
  fetch('/api/performance_data')
    .then(r => r.json())
    .then(data => {
      const ctx = document.getElementById('performanceChart');
      if (!ctx) return;

      if (performanceChart) performanceChart.destroy();

      performanceChart = new Chart(ctx, {
        type: 'bar',
        data: {
          labels: data.map(i => i.symbol),
          datasets: [
            {
              label: 'Invested',
              data: data.map(i => i.investment),
              backgroundColor: C.blue + '28', borderColor: C.blue,
              borderWidth: 1.5, borderRadius: 6, borderSkipped: false,
            },
            {
              label: 'Current Value',
              data: data.map(i => i.current_value),
              backgroundColor: C.teal + '28', borderColor: C.teal,
              borderWidth: 1.5, borderRadius: 6, borderSkipped: false,
            }
          ]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: {
            legend: { position:'bottom', labels:{ usePointStyle:true, padding:16, color:'#64748b' } },
            tooltip: {
              ...tooltipBase,
              callbacks: { label: c => `  ${c.dataset.label}: $${c.parsed.y.toFixed(2)}` }
            }
          },
          scales: {
            y: {
              grid: { color: 'rgba(255,255,255,0.04)' },
              ticks: { callback: v => '$' + (Math.abs(v) >= 1000 ? (v/1000).toFixed(1)+'k' : v) }
            },
            x: { grid: { display: false } }
          }
        }
      });
    });
}

/* ───────────────────────────────────────
   Net-worth vs Benchmarks (line)
─────────────────────────────────────── */
function setTimeline(tl, btn) {
  currentTimeline = tl;
  document.querySelectorAll('.tl-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  loadNetworthChart();
}

function loadNetworthChart() {
  const url = '/api/networth_data/' + currentTimeline;
  fetch(url)
    .then(r => r.json())
    .then(data => {
      const ctx = document.getElementById('networthChart');
      if (!ctx) return;

      if (networthChart) networthChart.destroy();

      const totalInv  = data.total_investments[data.total_investments.length - 1] || 0;
      const finalVal  = data.portfolio_values[data.portfolio_values.length - 1]   || 0;
      const portRet   = totalInv > 0 ? ((finalVal - totalInv) / totalInv * 100) : 0;
      const sign      = v => v >= 0 ? '+' : '';

      // Build gradient fill for portfolio line
      const canvasCtx = ctx.getContext('2d');
      const height    = ctx.parentElement.clientHeight || 340;
      const grad      = canvasCtx.createLinearGradient(0, 0, 0, height);
      grad.addColorStop(0, C.teal + '33');
      grad.addColorStop(1, C.teal + '00');

      const datasets = [{
        label:              `Portfolio (${sign(portRet)}${portRet.toFixed(1)}%)`,
        data:               data.portfolio_values,
        borderColor:        C.teal,
        backgroundColor:    grad,
        borderWidth:        2, fill: true, tension: 0.3,
        pointRadius:        0, pointHoverRadius: 5,
        pointHoverBackgroundColor: C.teal,
      }];

      const benchmarkTickers = Object.keys(data.benchmarks || {});
      benchmarkTickers.forEach((ticker, i) => {
        const vals   = data.benchmarks[ticker];
        const finalB = vals[vals.length - 1] || 0;
        const bmRet  = totalInv > 0 ? ((finalB - totalInv) / totalInv * 100) : 0;
        const color  = BENCHMARK_COLORS[i % BENCHMARK_COLORS.length];
        datasets.push({
          label:           `${ticker} (${sign(bmRet)}${bmRet.toFixed(1)}%)`,
          data:            vals,
          borderColor:     color, backgroundColor: 'transparent',
          borderWidth:     1.5, fill: false, tension: 0.3,
          borderDash:      [5, 4],
          pointRadius:     0, pointHoverRadius: 4,
          pointHoverBackgroundColor: color,
        });
      });

      datasets.push({
        label:          'Total Invested',
        data:           data.total_investments,
        borderColor:    C.muted, backgroundColor: 'transparent',
        borderWidth:    1, borderDash: [3, 3],
        fill: false, tension: 0.1, pointRadius: 0,
      });

      const timeUnit =
        currentTimeline === '1M' ? 'day'  :
        currentTimeline === '3M' ? 'week' : 'month';

      networthChart = new Chart(ctx, {
        type: 'line',
        data: { labels: data.dates, datasets },
        options: {
          responsive: true, maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: { position:'bottom', labels:{ usePointStyle:true, padding:20, color:'#64748b' } },
            tooltip: {
              ...tooltipBase,
              callbacks: {
                label: c => `  ${c.dataset.label}: $${c.parsed.y.toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:2 })}`
              }
            }
          },
          scales: {
            y: {
              grid: { color:'rgba(255,255,255,0.04)' },
              ticks: { callback: v => '$' + (Math.abs(v) >= 1000 ? (v/1000).toFixed(1)+'k' : v) }
            },
            x: {
              type: 'time', grid: { display: false },
              time: {
                unit: timeUnit,
                displayFormats: { day:'MMM d', week:'MMM d', month:'MMM yy' }
              },
              ticks: { maxTicksLimit: 8 }
            }
          }
        }
      });

      renderBenchmarkChips(benchmarkTickers);
    })
    .catch(e => {
      console.error(e);
      if (typeof showNotification === 'function')
        showNotification('Error loading chart data', 'error');
    });
}

/* ───────────────────────────────────────
   Benchmark chip UI
─────────────────────────────────────── */
function renderBenchmarkChips(tickers) {
  const container = document.getElementById('benchmarkChips');
  if (!container) return;
  container.innerHTML = '';
  tickers.forEach((ticker, i) => {
    const color = BENCHMARK_COLORS[i % BENCHMARK_COLORS.length];
    const chip  = document.createElement('span');
    chip.style.cssText = [
      'display:inline-flex', 'align-items:center', 'gap:5px',
      'padding:4px 10px', 'border-radius:20px',
      "font-family:'DM Mono',monospace", 'font-size:0.7rem', 'font-weight:500',
      `background:${color}18`, `color:${color}`, `border:1px solid ${color}44`
    ].join(';');
    chip.innerHTML = ticker === 'SPY'
      ? ticker
      : `${ticker} <button onclick="removeBenchmark('${ticker}')"
           style="background:none;border:none;cursor:pointer;color:${color};font-size:13px;line-height:1;padding:0 2px;">&times;</button>`;
    container.appendChild(chip);
  });
}

function addBenchmark() {
  const input  = document.getElementById('benchmarkInput');
  const status = document.getElementById('benchmarkStatus');
  const ticker = input.value.trim().toUpperCase();
  if (!ticker) return;
  status.textContent = 'Validating…';
  fetch('/api/benchmarks/add', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ticker }),
  })
    .then(r => r.json())
    .then(data => {
      if (data.status === 'success') { input.value = ''; status.textContent = ''; loadNetworthChart(); }
      else { status.textContent = data.message || 'Invalid ticker'; }
    })
    .catch(() => { status.textContent = 'Error'; });
}

function removeBenchmark(ticker) {
  fetch('/api/benchmarks/remove/' + ticker, { method: 'POST' })
    .then(() => loadNetworthChart())
    .catch(() => showNotification && showNotification('Error removing benchmark', 'error'));
}

/* ── Init ── */
document.addEventListener('DOMContentLoaded', () => {
  if (!document.getElementById('allocationChart')) return; // no portfolio yet
  loadAllocationChart();
  loadPerformanceChart();
  loadNetworthChart();
});
