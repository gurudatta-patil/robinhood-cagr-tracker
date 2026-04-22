/* ─────────────────────────────────────────────────
   CAGR Calculator — CSV Upload Handler
   Wires up both the hero upload zone and the
   dashboard upload modal zone.
   ───────────────────────────────────────────────── */

'use strict';

document.addEventListener('DOMContentLoaded', () => {
  // Bind all upload zones on the page
  wireUploadZone('hero-upload-zone', 'hero-csv-input', 'hero-upload-status');
  wireUploadZone('modal-upload-zone', 'modal-csv-input', 'modal-upload-status');
});

function wireUploadZone(zoneId, inputId, statusId) {
  const zone   = document.getElementById(zoneId);
  const input  = document.getElementById(inputId);
  const status = document.getElementById(statusId);
  if (!zone || !input) return;

  // Click to open file picker
  zone.addEventListener('click', () => input.click());

  // Drag & drop
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) uploadFile(file, status);
  });

  // File input change
  input.addEventListener('change', () => {
    if (input.files[0]) uploadFile(input.files[0], status);
  });
}

function uploadFile(file, statusEl) {
  if (!file.name.toLowerCase().endsWith('.csv')) {
    setUploadStatus(statusEl, 'error', 'Please select a .csv file.');
    return;
  }

  setUploadStatus(statusEl, 'loading',
    '<i class="fas fa-spinner fa-spin"></i>  Importing ' + file.name + '…');

  const fd = new FormData();
  fd.append('file', file);

  fetch('/upload_csv', { method: 'POST', body: fd })
    .then(r => r.json())
    .then(data => {
      if (data.status === 'success') {
        const parts = [];
        if (data.new_stocks             > 0) parts.push(data.new_stocks + ' trades');
        if (data.acati_added            > 0) parts.push(data.acati_added + ' transfers auto-priced');
        if (data.new_cash_transactions  > 0) parts.push(data.new_cash_transactions + ' cash transactions');
        const skipped = (data.skipped_stocks || 0) + (data.acati_skipped || 0);
        if (skipped > 0) parts.push(skipped + ' duplicates skipped');
        if (data.splits_applied && data.splits_applied.length)
          parts.push('splits: ' + data.splits_applied.join(', '));

        const msg = parts.length ? parts.join(' · ') : 'Nothing new to import';
        setUploadStatus(statusEl, 'success',
          '<i class="fas fa-check-circle"></i>  ' + msg + '. Reloading…');
        setTimeout(() => location.reload(), 1600);
      } else {
        setUploadStatus(statusEl, 'error',
          '<i class="fas fa-times-circle"></i>  ' + data.message);
      }
    })
    .catch(() => setUploadStatus(statusEl, 'error', 'Upload failed — please try again.'));
}

function setUploadStatus(el, type, html) {
  if (!el) return;
  el.className = 'upload-status ' + type;
  el.innerHTML = html;
}
