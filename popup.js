// Popup script: reads stored orders and budget from chrome.storage.local and renders the UI.

(function () {
  let viewMonth = currentYearMonth();
  let allOrders = {};
  let budget = 0;
  let excludedAddresses = new Set(); // ship-to names the user has unchecked
  let excludedPayments = new Set();  // payment methods the user has unchecked
  let sortBy = 'date';           // 'date' | 'amount'
  let sortDir = -1;              // -1 = descending, 1 = ascending
  let hideZero = false;
  const expandedOrders = new Set();

  // --- Init ---

  document.getElementById('scan-btn').addEventListener('click', startScan);
  document.getElementById('clear-btn').addEventListener('click', clearData);
  document.getElementById('prev-month').addEventListener('click', () => { viewMonth = offsetMonth(viewMonth, -1); render(); });
  document.getElementById('next-month').addEventListener('click', () => { viewMonth = offsetMonth(viewMonth, +1); render(); });
  document.getElementById('budget-input').addEventListener('change', onBudgetChange);
  document.getElementById('budget-input').addEventListener('keydown', e => { if (e.key === 'Enter') e.target.blur(); });
  document.getElementById('hide-zero').addEventListener('change', e => { hideZero = e.target.checked; render(); });
  // Resize handle between filter panel and orders list
  document.getElementById('filter-resize-handle').addEventListener('mousedown', e => {
    e.preventDefault();
    const filterRow = document.getElementById('filter-row');
    const startY = e.clientY;
    const startH = filterRow.getBoundingClientRect().height;
    document.getElementById('filter-resize-handle').classList.add('dragging');
    function onMove(ev) {
      const newH = Math.max(50, Math.min(500, startH + (ev.clientY - startY)));
      filterRow.style.height = newH + 'px';
    }
    function onUp() {
      document.getElementById('filter-resize-handle').classList.remove('dragging');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

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
    // self-heal: clear any "scanning" flag if no scan is actually running in background
    if (data.scanStatus && data.scanStatus.scanning) {
      const stale = isStale(data.scanStatus);
      const finish = () => renderScanProgress(data.scanStatus, data.lastScan);
      if (stale) {
        data.scanStatus = { scanning: false, info: 'Previous scan was interrupted.' };
        chrome.storage.local.set({ scanStatus: data.scanStatus }, finish);
      } else {
        chrome.runtime.sendMessage({ type: 'isScanActive' }, resp => {
          if (chrome.runtime.lastError || !resp || !resp.active) {
            data.scanStatus = { scanning: false, info: 'Previous scan was interrupted.' };
            chrome.storage.local.set({ scanStatus: data.scanStatus }, finish);
          } else {
            finish();
          }
        });
      }
    } else {
      renderScanProgress(data.scanStatus, data.lastScan);
    }
    renderSortButtons();
    render();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.orders) { allOrders = changes.orders.newValue || {}; }
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

    renderAddressFilter();
    renderPaymentFilter();

    const monthOrders = getOrdersForMonth(viewMonth);
    // subtract any refunded amount (full or partial) from each order's spend
    const spent = monthOrders.reduce((s, o) => s + Math.max(0, o.amount - (o.refundedAmount || 0)), 0);

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
    const savedScroll = list.scrollTop;
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
        const key = o.id || `${o.date}_${o.amount}`;
        const names = o.productNames && o.productNames.length > 0
          ? o.productNames
          : (o.productName ? [o.productName] : ['Unknown order']);
        const isMulti = names.length > 1;
        const isExpanded = expandedOrders.has(key);

        const refunded = o.refundedAmount || 0;
        const isFullRefund = o.refundComplete || (refunded > 0 && refunded >= o.amount);
        const isPartialRefund = refunded > 0 && !isFullRefund;

        const li = document.createElement('li');
        li.className = 'order-item';
        const displayName = isMulti && !isExpanded
          ? `${names[0]} +${names.length - 1} more`
          : names[0];

        let refundBadge = '';
        if (o.cancelled) {
          refundBadge = '<span class="refund-badge cancelled">CANCELLED</span>';
        } else if (o.returnStarted) {
          refundBadge = '<span class="refund-badge return-started">RETURNING</span>';
        } else if (isFullRefund) {
          refundBadge = '<span class="refund-badge">REFUNDED</span>';
        } else if (isPartialRefund) {
          refundBadge = `<span class="refund-badge partial" title="Partial refund of ${fmt(refunded)}">−${fmt(refunded)}</span>`;
        }

        li.innerHTML = `
          <span class="order-date">${formatDate(o.date)}</span>
          ${isMulti ? `<button class="expand-btn" title="${isExpanded ? 'Collapse' : 'Expand'}">${isExpanded ? '▼' : '▶'}</button>` : '<span class="expand-placeholder"></span>'}
          ${refundBadge}
          <span class="order-name" title="${escapeHtml(names[0])}">${escapeHtml(displayName)}</span>
          <span class="order-amount">${fmt(o.amount)}</span>
        `;

        if (isMulti) {
          li.querySelector('.expand-btn').addEventListener('click', () => {
            if (expandedOrders.has(key)) expandedOrders.delete(key);
            else expandedOrders.add(key);
            render();
          });
        }
        list.appendChild(li);

        if (isMulti && isExpanded) {
          names.slice(1).forEach(name => {
            const sub = document.createElement('li');
            sub.className = 'order-item order-item-sub';
            sub.innerHTML = `
              <span class="order-date"></span>
              <span class="expand-placeholder"></span>
              <span class="order-name sub-name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
              <span class="order-amount"></span>
            `;
            list.appendChild(sub);
          });
        }
      });
    }

    list.scrollTop = savedScroll;
  }

  // Show or hide the overall filter panel depending on whether either sub-section has data.
  function updateFilterPanel(hasAddresses, hasPayments) {
    const filterRow = document.getElementById('filter-row');
    const handle = document.getElementById('filter-resize-handle');
    const hasAny = hasAddresses || hasPayments;
    if (!hasAny) {
      filterRow.style.display = 'none';
      handle.style.display = 'none';
    } else {
      if (filterRow.style.display === 'none') {
        filterRow.style.display = '';
        if (!filterRow.style.height) filterRow.style.height = '120px';
      }
      handle.style.display = '';
    }
  }

  function renderAddressFilter() {
    const container = document.getElementById('card-filter-checks');
    const filterAllCb = document.getElementById('filter-all');
    const section = document.getElementById('address-filter-section');

    const names = new Set();
    Object.values(allOrders).forEach(o => {
      if (o.shipTo && o.date && o.date.startsWith(viewMonth)) names.add(o.shipTo);
    });

    section.style.display = names.size === 0 ? 'none' : '';

    // remove stale exclusions
    for (const n of excludedAddresses) {
      if (!names.has(n)) excludedAddresses.delete(n);
    }

    container.innerHTML = '';
    Array.from(names).sort().forEach(n => {
      const label = document.createElement('label');
      label.className = 'filter-check-item';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = n;
      cb.checked = !excludedAddresses.has(n);
      cb.addEventListener('change', () => {
        if (cb.checked) excludedAddresses.delete(n); else excludedAddresses.add(n);
        filterAllCb.checked = excludedAddresses.size === 0;
        filterAllCb.indeterminate = excludedAddresses.size > 0 && excludedAddresses.size < names.size;
        render();
      });
      const span = document.createElement('span');
      span.textContent = n;
      label.appendChild(cb);
      label.appendChild(span);
      container.appendChild(label);
    });

    filterAllCb.checked = excludedAddresses.size === 0;
    filterAllCb.indeterminate = excludedAddresses.size > 0 && excludedAddresses.size < names.size;
    filterAllCb.onchange = () => {
      if (filterAllCb.checked) excludedAddresses.clear();
      else names.forEach(n => excludedAddresses.add(n));
      renderAddressFilter();
      renderPaymentFilter();
      render();
    };
  }

  function renderPaymentFilter() {
    const container = document.getElementById('payment-filter-checks');
    const filterAllCb = document.getElementById('filter-payments-all');
    const section = document.getElementById('payment-filter-section');

    const methods = new Set();
    Object.values(allOrders).forEach(o => {
      if (o.paymentMethod && o.date && o.date.startsWith(viewMonth)) methods.add(o.paymentMethod);
    });

    section.style.display = methods.size === 0 ? 'none' : '';

    // remove stale exclusions
    for (const m of excludedPayments) {
      if (!methods.has(m)) excludedPayments.delete(m);
    }

    container.innerHTML = '';
    Array.from(methods).sort().forEach(m => {
      const label = document.createElement('label');
      label.className = 'filter-check-item';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = m;
      cb.checked = !excludedPayments.has(m);
      cb.addEventListener('change', () => {
        if (cb.checked) excludedPayments.delete(m); else excludedPayments.add(m);
        filterAllCb.checked = excludedPayments.size === 0;
        filterAllCb.indeterminate = excludedPayments.size > 0 && excludedPayments.size < methods.size;
        render();
      });
      const span = document.createElement('span');
      span.textContent = m;
      label.appendChild(cb);
      label.appendChild(span);
      container.appendChild(label);
    });

    filterAllCb.checked = excludedPayments.size === 0;
    filterAllCb.indeterminate = excludedPayments.size > 0 && excludedPayments.size < methods.size;
    filterAllCb.onchange = () => {
      if (filterAllCb.checked) excludedPayments.clear();
      else methods.forEach(m => excludedPayments.add(m));
      renderPaymentFilter();
      render();
    };

    // update the outer panel now that both sub-sections have been rendered
    const hasAddresses = document.getElementById('address-filter-section').style.display !== 'none';
    updateFilterPanel(hasAddresses, methods.size > 0);
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
        barFill.classList.add('indeterminate');
        barFill.style.width = '';
        progressEl.textContent = `Scanning... ${status.monthFound || 0} found`;
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
    // clear any leftover state so background doesn't think a scan is already in progress
    chrome.storage.local.set({ scanStatus: { scanning: false } }, () => {
      chrome.runtime.sendMessage({ type: 'startScan', baseUrl: 'https://www.amazon.com', targetMonth: viewMonth });
    });
  }

  function clearData() {
    if (!confirm('Clear all stored orders and budget? This cannot be undone.')) return;
    chrome.storage.local.clear(() => {
      allOrders = {};
      budget = 0;
      excludedAddresses = new Set();
      excludedPayments = new Set();
      document.getElementById('budget-input').value = '';
      renderScanProgress(null, 0);
      render();
    });
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
      if (hideZero && o.amount === 0) return false;
      // only filter orders that have a known value; orders without one are always shown
      if (o.shipTo && excludedAddresses.has(o.shipTo)) return false;
      if (o.paymentMethod && excludedPayments.has(o.paymentMethod)) return false;
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
