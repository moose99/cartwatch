// Popup script: reads stored orders and budget from chrome.storage.local and renders the UI.

(function () {
  const ORIGIN_META = {
    'https://www.amazon.com':    { symbol: '$',  label: 'USD' },
    'https://www.amazon.co.uk':  { symbol: '£',  label: 'GBP' },
    'https://www.amazon.ca':     { symbol: '$',  label: 'CAD' },
    'https://www.amazon.com.au': { symbol: '$',  label: 'AUD' },
    'https://www.amazon.in':     { symbol: '₹',  label: 'INR' },
  };
  const SUPPORTED_ORIGINS = Object.keys(ORIGIN_META);

  let viewMonth = currentYearMonth();
  let allOrders = {};
  let budget = 0;
  let currencySymbol = '$';
  let excludedAddresses = new Set(); // ship-to names the user has unchecked
  let excludedPayments = new Set();  // payment methods the user has unchecked
  let sortBy = 'date';           // 'date' | 'amount'
  let sortDir = -1;              // -1 = descending, 1 = ascending
  let hideCancelled = false;
  let lastAlertedAt = 0; // errorAt timestamp of the last alert we showed
  const expandedOrders = new Set();

  // --- Init ---

  // Help modal
  const EXTENSION_ID = chrome.runtime.id;
  const STORE_URL = `https://chromewebstore.google.com/detail/${EXTENSION_ID}`;
  document.getElementById('review-link').href = `${STORE_URL}/reviews`;
  document.getElementById('help-version').textContent = chrome.runtime.getManifest().version;
  document.getElementById('help-btn').addEventListener('click', () => {
    document.getElementById('help-overlay').style.display = 'flex';
  });
  document.getElementById('help-close').addEventListener('click', () => {
    document.getElementById('help-overlay').style.display = 'none';
  });
  document.getElementById('help-overlay').addEventListener('click', e => {
    if (e.target === document.getElementById('help-overlay'))
      document.getElementById('help-overlay').style.display = 'none';
  });

  document.getElementById('scan-btn').addEventListener('click', startScan);
  document.getElementById('clear-btn').addEventListener('click', clearData);
  document.getElementById('prev-month').addEventListener('click', () => { viewMonth = offsetMonth(viewMonth, -1); render(); });
  document.getElementById('next-month').addEventListener('click', () => { viewMonth = offsetMonth(viewMonth, +1); render(); });
  document.getElementById('budget-input').addEventListener('change', onBudgetChange);
  document.getElementById('budget-input').addEventListener('keydown', e => { if (e.key === 'Enter') e.target.blur(); });
  document.getElementById('hide-cancelled').addEventListener('change', e => { hideCancelled = e.target.checked; render(); });
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

  chrome.storage.local.get({ orders: {}, budget: 0, lastScan: 0, scanStatus: null, amazonOrigin: null }, data => {
    allOrders = data.orders || {};
    budget = data.budget;
    if (data.amazonOrigin && ORIGIN_META[data.amazonOrigin]) setCurrency(data.amazonOrigin);
    document.getElementById('budget-input').value = budget || '';
    // self-heal: clear any "scanning" flag if no scan is actually running in background
    if (data.scanStatus && data.scanStatus.scanning) {
      const stale = isStale(data.scanStatus);
      const finish = () => renderScanProgress(data.scanStatus, data.lastScan);
      if (stale) {
        data.scanStatus = { scanning: false, info: 'Previous scan was interrupted.' };
        safeSet({ scanStatus: data.scanStatus }, finish);
      } else {
        chrome.runtime.sendMessage({ type: 'isScanActive' }, resp => {
          if (chrome.runtime.lastError || !resp || !resp.active) {
            data.scanStatus = { scanning: false, info: 'Previous scan was interrupted.' };
            safeSet({ scanStatus: data.scanStatus }, finish);
          } else {
            finish();
          }
        });
      }
    } else {
      renderScanProgress(data.scanStatus, data.lastScan);
      // Auto-scan on open. The background does a single-page check first and
      // exits immediately if the year order count hasn't changed, so this is
      // cheap when there's nothing new.
      startScan();
    }
    renderSortButtons();
    render();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.orders) { allOrders = changes.orders.newValue || {}; }
    if (changes.budget) { budget = changes.budget.newValue; document.getElementById('budget-input').value = budget || ''; }
    if (changes.amazonOrigin) {
      const o = changes.amazonOrigin.newValue;
      if (o && ORIGIN_META[o]) setCurrency(o);
    }
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

    // Single pass over allOrders: compute filter sets and the filtered order list together.
    const { monthOrders, addressNames, paymentMethods } = computeMonthData(viewMonth);

    renderAddressFilter(addressNames);
    renderPaymentFilter(paymentMethods);

    // Budget summary
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

    renderOrdersList(monthOrders);
  }

  // Single pass: returns filtered orders for the list plus unfiltered name/payment sets for
  // the filter panel. Computing everything together avoids iterating allOrders three times.
  function computeMonthData(ym) {
    const addressNames = new Set();
    const paymentMethods = new Set();
    const monthOrders = [];
    for (const o of Object.values(allOrders)) {
      if (!o.date || !o.date.startsWith(ym)) continue;
      // collect filter options from all orders in the month before applying exclusions
      if (o.shipTo) addressNames.add(o.shipTo);
      if (o.paymentMethod) paymentMethods.add(o.paymentMethod);
      // apply active filters for the visible list
      if (hideCancelled && o.cancelled) continue;
      if (o.shipTo && excludedAddresses.has(o.shipTo)) continue;
      if (o.paymentMethod && excludedPayments.has(o.paymentMethod)) continue;
      monthOrders.push(o);
    }
    return { monthOrders, addressNames, paymentMethods };
  }

  function renderOrdersList(monthOrders) {
    const list = document.getElementById('orders-list');
    const savedScroll = list.scrollTop;
    list.innerHTML = '';

    if (monthOrders.length === 0) {
      const li = document.createElement('li');
      li.className = 'empty-state';
      li.textContent = 'No orders found for this month.';
      list.appendChild(li);
      document.getElementById('order-count').textContent = '';
      return;
    }

    document.getElementById('order-count').textContent = monthOrders.length;
    monthOrders.sort((a, b) => {
      if (sortBy === 'amount') return (a.amount - b.amount) * sortDir;
      return a.date.localeCompare(b.date) * sortDir;
    });

    // Build all rows into a fragment to minimize reflows
    const fragment = document.createDocumentFragment();
    monthOrders.forEach(o => {
      const key = o.id || `${o.date}_${o.amount}`;
      const names = o.productNames?.length > 0 ? o.productNames
        : o.productName ? [o.productName] : ['Unknown order'];
      const isMulti = names.length > 1;
      const isExpanded = expandedOrders.has(key);

      fragment.appendChild(buildOrderRow(o, key, names, isMulti, isExpanded));

      if (isMulti && isExpanded) {
        names.slice(1).forEach(name => fragment.appendChild(buildSubRow(name)));
      }
    });
    list.appendChild(fragment);
    list.scrollTop = savedScroll;
  }

  function buildOrderRow(o, key, names, isMulti, isExpanded) {
    const li = document.createElement('li');
    li.className = 'order-item';

    const dateEl = document.createElement('span');
    dateEl.className = 'order-date';
    dateEl.textContent = formatDate(o.date);
    li.appendChild(dateEl);

    if (isMulti) {
      const btn = document.createElement('button');
      btn.className = 'expand-btn';
      btn.title = isExpanded ? 'Collapse' : 'Expand';
      btn.textContent = isExpanded ? '▼' : '▶';
      btn.addEventListener('click', () => {
        if (expandedOrders.has(key)) expandedOrders.delete(key);
        else expandedOrders.add(key);
        render();
      });
      li.appendChild(btn);
    } else {
      const ph = document.createElement('span');
      ph.className = 'expand-placeholder';
      li.appendChild(ph);
    }

    const badge = buildBadgeEl(o);
    if (badge) li.appendChild(badge);

    const displayName = isMulti && !isExpanded ? `${names[0]} +${names.length - 1} more` : names[0];
    const nameEl = document.createElement('span');
    nameEl.className = 'order-name';
    nameEl.title = names[0];
    nameEl.textContent = displayName;
    li.appendChild(nameEl);

    const amtEl = document.createElement('span');
    amtEl.className = 'order-amount';
    amtEl.textContent = fmt(o.amount);
    li.appendChild(amtEl);

    return li;
  }

  function buildSubRow(name) {
    const sub = document.createElement('li');
    sub.className = 'order-item order-item-sub';

    const dateEl = document.createElement('span');
    dateEl.className = 'order-date';
    sub.appendChild(dateEl);

    const ph = document.createElement('span');
    ph.className = 'expand-placeholder';
    sub.appendChild(ph);

    const nameEl = document.createElement('span');
    nameEl.className = 'order-name sub-name';
    nameEl.title = name;
    nameEl.textContent = name;
    sub.appendChild(nameEl);

    const amtEl = document.createElement('span');
    amtEl.className = 'order-amount';
    sub.appendChild(amtEl);

    return sub;
  }

  function buildBadgeEl(o) {
    const refunded = o.refundedAmount || 0;
    const isFullRefund = o.refundComplete || (refunded > 0 && refunded >= o.amount);
    const isPartialRefund = refunded > 0 && !isFullRefund;

    let cls = null, text = null, title = null;
    if (o.cancelled)          { cls = 'cancelled';     text = 'CANCELLED'; }
    else if (o.returnStarted) { cls = 'return-started'; text = 'RETURNING'; }
    else if (isFullRefund)    {                          text = 'REFUNDED'; }
    else if (isPartialRefund) { cls = 'partial'; text = `−${fmt(refunded)}`; title = `Partial refund of ${fmt(refunded)}`; }

    if (!text) return null;
    const el = document.createElement('span');
    el.className = 'refund-badge' + (cls ? ' ' + cls : '');
    el.textContent = text;
    if (title) el.title = title;
    return el;
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

  function renderAddressFilter(names) {
    const container = document.getElementById('card-filter-checks');
    const filterAllCb = document.getElementById('filter-all');
    const section = document.getElementById('address-filter-section');

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
      render();
    };
  }

  function renderPaymentFilter(methods) {
    const container = document.getElementById('payment-filter-checks');
    const filterAllCb = document.getElementById('filter-payments-all');
    const section = document.getElementById('payment-filter-section');

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
    btn.textContent = scanning ? 'Scanning Amazon Orders...' : 'Update Amazon Orders';

    if (scanning) {
      barWrap.style.display = '';
      if (status.phase === 'orders') {
        barFill.classList.add('indeterminate');
        barFill.style.width = '';
        progressEl.textContent = `Scanning Amazon Orders... ${status.monthFound || 0} found`;
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
      } else if (status && status.upToDate) {
        progressEl.textContent = 'Up to date';
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

      // Pop up a prominent alert for scan errors the user should not miss
      // (timeouts, not-signed-in). errorAt ensures we only show each error once
      // per popup session.
      if (status && status.needsAttention && status.errorAt && status.errorAt > lastAlertedAt) {
        lastAlertedAt = status.errorAt;
        showAlert(status.info);
      }
    }
  }

  // --- Actions ---

  async function startScan() {
    // detect which Amazon domain the user has open; warn if unsupported; fall back to amazon.com
    let baseUrl = 'https://www.amazon.com';
    try {
      const tabs = await chrome.tabs.query({});
      const amazonTabs = tabs.filter(t => t.url && /https:\/\/www\.amazon\./i.test(t.url));
      const supportedTab = amazonTabs.find(t => SUPPORTED_ORIGINS.some(o => t.url.startsWith(o + '/')));
      if (supportedTab) {
        const origin = SUPPORTED_ORIGINS.find(o => supportedTab.url.startsWith(o + '/'));
        if (origin) baseUrl = origin;
      } else if (amazonTabs.length > 0) {
        // user has Amazon open but it's an unsupported region
        const domain = new URL(amazonTabs[0].url).hostname;
        renderScanProgress({
          scanning: false,
          info: `${domain} is not supported yet. Supported: amazon.com, .co.uk, .ca, .com.au, .in`
        }, 0);
        return;
      }
    } catch (e) { /* tabs query failed, use default */ }

    safeSet({ scanStatus: { scanning: false }, amazonOrigin: baseUrl }, () => {
      chrome.runtime.sendMessage({ type: 'startScan', baseUrl, targetMonth: viewMonth });
    });
  }

  // In-popup alert dialog. Reuses the confirm overlay with Cancel hidden.
  function showAlert(message) {
    const overlay = document.getElementById('confirm-overlay');
    const okBtn = document.getElementById('confirm-ok');
    const cancelBtn = document.getElementById('confirm-cancel');
    document.getElementById('confirm-message').textContent = message;
    cancelBtn.style.display = 'none';
    okBtn.classList.add('alert-mode');
    overlay.style.display = 'flex';
    function cleanup() {
      overlay.style.display = 'none';
      okBtn.removeEventListener('click', onOk);
      overlay.removeEventListener('click', onOverlay);
      cancelBtn.style.display = '';
      okBtn.classList.remove('alert-mode');
    }
    function onOk() { cleanup(); }
    function onOverlay(e) { if (e.target === overlay) cleanup(); }
    okBtn.addEventListener('click', onOk);
    overlay.addEventListener('click', onOverlay);
  }

  // In-popup confirmation dialog (native confirm() gets clipped in narrow popups).
  function showConfirm(message, onConfirm) {
    const overlay = document.getElementById('confirm-overlay');
    const okBtn = document.getElementById('confirm-ok');
    const cancelBtn = document.getElementById('confirm-cancel');
    document.getElementById('confirm-message').textContent = message;
    overlay.style.display = 'flex';
    function cleanup() {
      overlay.style.display = 'none';
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      overlay.removeEventListener('click', onOverlay);
    }
    function onOk() { cleanup(); onConfirm(); }
    function onCancel() { cleanup(); }
    function onOverlay(e) { if (e.target === overlay) cleanup(); }
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    overlay.addEventListener('click', onOverlay);
  }

  function clearData() {
    showConfirm('Clear all stored orders and budget? This cannot be undone.', doClearData);
  }

  function doClearData() {
    chrome.storage.local.clear(() => {
      if (chrome.runtime.lastError) {
        console.error('[CartWatch] clear failed:', chrome.runtime.lastError.message);
        return;
      }
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
    safeSet({ budget });
    render();
  }

  // --- Helpers ---

  function safeSet(data, callback) {
    chrome.storage.local.set(data, () => {
      if (chrome.runtime.lastError) {
        console.error('[CartWatch] storage write failed:', chrome.runtime.lastError.message);
      }
      if (callback) callback();
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

  function setCurrency(origin) {
    currencySymbol = ORIGIN_META[origin]?.symbol || '$';
    document.getElementById('currency-symbol').textContent = currencySymbol;
  }

  function fmt(n) {
    return currencySymbol + n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }


})();
