// Popup script: reads stored orders and budget from chrome.storage.local and renders the UI.

(function () {
  let viewMonth = currentYearMonth();
  let allOrders = {};
  let budget = 0;
  let excludedCards = new Set(); // methods the user has unchecked
  let sortBy = 'date';           // 'date' | 'amount'
  let sortDir = -1;              // -1 = descending, 1 = ascending

  // --- Init ---

  document.getElementById('scan-btn').addEventListener('click', startScan);
  document.getElementById('prev-month').addEventListener('click', () => { viewMonth = offsetMonth(viewMonth, -1); render(); });
  document.getElementById('next-month').addEventListener('click', () => { viewMonth = offsetMonth(viewMonth, +1); render(); });
  document.getElementById('budget-input').addEventListener('change', onBudgetChange);
  document.getElementById('budget-input').addEventListener('keydown', e => { if (e.key === 'Enter') e.target.blur(); });
  document.getElementById('sort-date').addEventListener('click', () => {
    if (sortBy === 'date') sortDir = -sortDir; else { sortBy = 'date'; sortDir = -1; }
    renderSortButtons();
    render();
  });
  document.getElementById('sort-amount').addEventListener('click', () => {
    if (sortBy === 'amount') sortDir = -sortDir; else { sortBy = 'amount'; sortDir = -1; }
    renderSortButtons();
    render();
  });

  chrome.storage.local.get({ orders: {}, budget: 0, lastScan: 0, scanStatus: null }, data => {
    allOrders = data.orders;
    budget = data.budget;
    document.getElementById('budget-input').value = budget || '';
    renderScanProgress(data.scanStatus, data.lastScan);
    renderCardFilter();
    renderSortButtons();
    render();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.orders) { allOrders = changes.orders.newValue; renderCardFilter(); }
    if (changes.budget) { budget = changes.budget.newValue; document.getElementById('budget-input').value = budget || ''; }
    if (changes.scanStatus || changes.lastScan) {
      chrome.storage.local.get({ scanStatus: null, lastScan: 0 }, d => renderScanProgress(d.scanStatus, d.lastScan));
    }
    render();
  });

  // --- Render ---

  function render() {
    const now = currentYearMonth();
    document.getElementById('month-label').textContent = formatMonthLabel(viewMonth);
    document.getElementById('next-month').disabled = viewMonth >= now;

    const monthOrders = getOrdersForMonth(viewMonth);
    const spent = monthOrders.reduce((s, o) => s + o.amount, 0);

    const pct = budget > 0 ? Math.min((spent / budget) * 100, 100) : 0;
    const fill = document.getElementById('progress-fill');
    fill.style.width = pct + '%';
    fill.classList.toggle('warn', pct >= 75 && pct < 100);
    fill.classList.toggle('over', spent > budget && budget > 0);
    document.getElementById('progress-pct').textContent = budget > 0 ? Math.round(pct) + '%' : '--';

    document.getElementById('spent-amount').textContent = fmt(spent);

    const remainingEl = document.getElementById('remaining-amount');
    const remainingLabelEl = document.getElementById('remaining-label');
    if (budget > 0) {
      const rem = budget - spent;
      remainingEl.textContent = fmt(Math.abs(rem));
      remainingEl.classList.toggle('over', rem < 0);
      remainingLabelEl.textContent = rem < 0 ? 'over budget' : 'remaining';
    } else {
      remainingEl.textContent = '--';
      remainingEl.classList.remove('over');
      remainingLabelEl.textContent = 'remaining';
    }

    const list = document.getElementById('orders-list');
    list.innerHTML = '';

    if (monthOrders.length === 0) {
      const li = document.createElement('li');
      li.className = 'empty-state';
      li.textContent = 'No orders found for this month.';
      list.appendChild(li);
      document.getElementById('order-count').textContent = '';
    } else {
      document.getElementById('order-count').textContent = monthOrders.length;
      monthOrders.sort((a, b) => {
        if (sortBy === 'amount') return (a.amount - b.amount) * sortDir;
        return a.date.localeCompare(b.date) * sortDir;
      });
      monthOrders.forEach(o => {
        const displayName = o.productName || o.id || 'Unknown order';
        const li = document.createElement('li');
        li.className = 'order-item';
        li.innerHTML = `
          <span class="order-date">${formatDate(o.date)}</span>
          <span class="order-name" title="${escapeHtml(displayName)}">${escapeHtml(displayName)}</span>
          <span class="order-amount">${fmt(o.amount)}</span>
        `;
        list.appendChild(li);
      });
    }
  }

  function renderCardFilter() {
    const container = document.getElementById('card-filter-checks');
    const filterAllCb = document.getElementById('filter-all');
    const filterRow = document.getElementById('filter-row');

    const methods = new Set();
    Object.values(allOrders).forEach(o => {
      if (o.paymentMethod) methods.add(o.paymentMethod);
    });

    if (methods.size === 0) {
      filterRow.style.display = 'none';
      return;
    }
    filterRow.style.display = '';

    // remove excluded methods that no longer exist
    for (const m of excludedCards) {
      if (!methods.has(m)) excludedCards.delete(m);
    }

    container.innerHTML = '';
    Array.from(methods).sort().forEach(m => {
      const label = document.createElement('label');
      label.className = 'filter-check-item';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = m;
      cb.checked = !excludedCards.has(m);
      cb.addEventListener('change', () => {
        if (cb.checked) excludedCards.delete(m); else excludedCards.add(m);
        filterAllCb.checked = excludedCards.size === 0;
        filterAllCb.indeterminate = excludedCards.size > 0 && excludedCards.size < methods.size;
        render();
      });
      const span = document.createElement('span');
      span.textContent = m;
      label.appendChild(cb);
      label.appendChild(span);
      container.appendChild(label);
    });

    filterAllCb.checked = excludedCards.size === 0;
    filterAllCb.indeterminate = excludedCards.size > 0 && excludedCards.size < methods.size;
    filterAllCb.onchange = () => {
      if (filterAllCb.checked) {
        excludedCards.clear();
      } else {
        methods.forEach(m => excludedCards.add(m));
      }
      renderCardFilter();
      render();
    };
  }

  function renderSortButtons() {
    const dateBtn = document.getElementById('sort-date');
    const amtBtn = document.getElementById('sort-amount');
    const arrow = sortDir === -1 ? ' ↓' : ' ↑';
    dateBtn.textContent = 'Date' + (sortBy === 'date' ? arrow : '');
    dateBtn.classList.toggle('sort-active', sortBy === 'date');
    amtBtn.textContent = 'Amount' + (sortBy === 'amount' ? arrow : '');
    amtBtn.classList.toggle('sort-active', sortBy === 'amount');
  }

  function renderScanProgress(status, lastScanTs) {
    const btn = document.getElementById('scan-btn');
    const barWrap = document.getElementById('scan-bar-wrap');
    const barFill = document.getElementById('scan-bar-fill');
    const progressEl = document.getElementById('scan-progress');
    const lastScanEl = document.getElementById('last-scan');

    const scanning = status && status.scanning && !isStale(status);
    btn.disabled = scanning;
    btn.textContent = scanning ? 'Scanning...' : 'Update';

    if (scanning) {
      barWrap.style.display = '';
      if (status.phase === 'orders') {
        if (status.total > 0) {
          barFill.classList.remove('indeterminate');
          const pct = Math.min(Math.round((status.scanned / status.total) * 100), 99);
          barFill.style.width = pct + '%';
          progressEl.textContent = `Scanned ${status.scanned} of ${status.total}... ${status.monthFound || 0} match`;
        } else {
          barFill.classList.add('indeterminate');
          barFill.style.width = '';
          progressEl.textContent = `Scanning... ${status.monthFound || 0} found`;
        }
      } else if (status.phase === 'details') {
        barFill.classList.remove('indeterminate');
        const pct = status.detailTotal > 0 ? Math.round((status.detailDone / status.detailTotal) * 100) : 0;
        barFill.style.width = pct + '%';
        progressEl.textContent = `Getting payment info... ${status.detailDone || 0}/${status.detailTotal || 0}`;
      }
      progressEl.style.display = '';
      lastScanEl.textContent = '';
    } else {
      barWrap.style.display = 'none';
      barFill.classList.remove('indeterminate');
      if (status && status.error) {
        progressEl.textContent = status.error;
        progressEl.style.display = '';
      } else if (status && status.info) {
        progressEl.textContent = status.info;
        progressEl.style.display = '';
      } else {
        progressEl.style.display = 'none';
      }
      if (lastScanTs) {
        const d = new Date(lastScanTs);
        lastScanEl.textContent = 'Last scanned: ' + d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      } else {
        lastScanEl.textContent = 'Not scanned yet - click above to scan.';
      }
    }
  }

  // --- Actions ---

  function startScan() {
    chrome.runtime.sendMessage({ type: 'startScan', baseUrl: 'https://www.amazon.com', targetMonth: viewMonth });
  }

  function onBudgetChange(e) {
    budget = parseFloat(e.target.value) || 0;
    chrome.storage.local.set({ budget });
    render();
  }

  // --- Helpers ---

  function getOrdersForMonth(ym) {
    return Object.values(allOrders).filter(o => {
      if (!o.date || !o.date.startsWith(ym)) return false;
      if (excludedCards.size > 0 && excludedCards.has(o.paymentMethod || '')) return false;
      return true;
    });
  }

  function isStale(s) {
    return Date.now() - (s.startedAt || 0) > 5 * 60 * 1000;
  }

  function currentYearMonth() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  }

  function offsetMonth(ym, delta) {
    const [y, m] = ym.split('-').map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  }

  function formatMonthLabel(ym) {
    const [y, m] = ym.split('-').map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  }

  function formatDate(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function fmt(n) {
    return '$' + n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function truncate(s, len) {
    return s.length > len ? s.slice(0, len) + '...' : s;
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
})();
