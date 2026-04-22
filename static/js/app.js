/* ─────────────────────────────────────────────────
   CAGR Calculator — Core App Logic
   Handles: notifications, refresh, modal, auto-refresh
   ───────────────────────────────────────────────── */

'use strict';

// Set today's date default on the add-stock form
(function () {
  const d = document.getElementById('buy_date');
  if (d) d.valueAsDate = new Date();
})();

/* ── Notification ── */
function showNotification(message, type = 'info') {
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

/* ── Refresh prices ── */
function setRefreshSpin(on) {
  ['topbar-refresh-icon', 'fab-refresh-icon'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('fa-spin', on);
  });
}

function refreshPrices() {
  setRefreshSpin(true);
  fetch('/api/refresh_prices')
    .then(r => r.json())
    .then(data => {
      if (data.status === 'success') {
        showNotification('Prices refreshed', 'success');
        const el = document.getElementById('last-updated');
        if (el) el.textContent = 'Updated ' + new Date().toLocaleTimeString();
        setTimeout(() => location.reload(), 1000);
      } else {
        showNotification('Error: ' + data.message, 'error');
      }
    })
    .catch(() => showNotification('Refresh failed', 'error'))
    .finally(() => setRefreshSpin(false));
}

/* ── Purchase details modal ── */
function showPurchaseDetails(symbol) {
  fetch('/view_details/' + symbol)
    .then(r => r.json())
    .then(data => {
      if (data.status === 'error') {
        showNotification('Error: ' + data.message, 'error');
        return;
      }

      document.getElementById('modal-title').textContent = data.symbol + ' — Purchase Lots';

      let totalInv = 0, totalVal = 0;
      let html = `
        <table class="details-table">
          <thead><tr>
            <th>Date</th><th>Qty</th><th>Cost</th><th>Invested</th>
            <th>Price Now</th><th>Value</th><th>P&amp;L</th><th>Return</th>
          </tr></thead>
          <tbody>`;

      data.details.forEach(d => {
        totalInv += d.total_investment;
        totalVal += d.current_value;
        const cls = d.profit_loss >= 0 ? 'positive' : 'negative';
        const sign = v => v >= 0 ? '+' : '';
        html += `<tr>
          <td>${d.buy_date}</td>
          <td>${d.quantity.toFixed(3)}</td>
          <td>$${d.buy_price.toFixed(2)}</td>
          <td>$${d.total_investment.toFixed(2)}</td>
          <td>$${d.current_price.toFixed(2)}</td>
          <td>$${d.current_value.toFixed(2)}</td>
          <td class="${cls}">${sign(d.profit_loss)}$${d.profit_loss.toFixed(2)}</td>
          <td class="${cls}">${sign(d.profit_loss_percent)}${d.profit_loss_percent.toFixed(1)}%</td>
        </tr>`;
      });

      const totalPL     = totalVal - totalInv;
      const totalPLpct  = totalInv > 0 ? (totalPL / totalInv * 100) : 0;
      const totalCls    = totalPL >= 0 ? 'positive' : 'negative';
      const totalQty    = data.details.reduce((s, d) => s + d.quantity, 0);
      const sign = v => v >= 0 ? '+' : '';

      html += `</tbody><tbody>
        <tr class="total-row">
          <td>TOTAL</td>
          <td>${totalQty.toFixed(3)}</td>
          <td>$${(totalInv / totalQty).toFixed(2)}</td>
          <td>$${totalInv.toFixed(2)}</td>
          <td>$${data.details[0].current_price.toFixed(2)}</td>
          <td>$${totalVal.toFixed(2)}</td>
          <td class="${totalCls}">${sign(totalPL)}$${totalPL.toFixed(2)}</td>
          <td class="${totalCls}">${sign(totalPLpct)}${totalPLpct.toFixed(1)}%</td>
        </tr>
      </tbody></table>`;

      document.getElementById('modal-body').innerHTML = html;
      document.getElementById('purchase-modal').classList.add('open');
    })
    .catch(() => showNotification('Error loading details', 'error'));
}

function closePurchaseDetails() {
  document.getElementById('purchase-modal').classList.remove('open');
}

/* ── Upload modal (dashboard → "Upload CSV" button) ── */
function openUploadModal() {
  document.getElementById('upload-modal').classList.add('open');
}
function closeUploadModal() {
  document.getElementById('upload-modal').classList.remove('open');
}

/* ── Close modals on backdrop click ── */
document.addEventListener('DOMContentLoaded', () => {
  ['purchase-modal', 'upload-modal'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', e => { if (e.target === el) el.classList.remove('open'); });
  });
});

/* ── Auto-refresh every 5 min when portfolio has data ── */
(function () {
  const hasData = document.querySelector('.holdings-table tbody tr');
  if (!hasData) return;
  setInterval(refreshPrices, 300_000);
})();
