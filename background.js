// Service worker: manages a hidden browser tab to scan Amazon order history.
// Amazon encrypts order data client-side, so fetch+DOMParser cannot read it.

const BASE_URL = 'https://www.amazon.com';
let scanState = null;

function isStale(s) {
  return Date.now() - (s.startedAt || 0) > 5 * 60 * 1000;
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type === 'startScan') {
    beginScan(msg.baseUrl || BASE_URL, msg.targetMonth);
  }
  if (msg.type === 'pageScraped' && scanState && sender.tab?.id === scanState.tabId) {
    handlePageScraped(msg.orders, msg.nextUrl, msg.totalCount).catch(console.error);
  }
});

function isValidPaymentMethod(s) {
  if (!s || typeof s !== 'string') return false;
  if (/ending in \d{4}/i.test(s)) return true;
  if (/^Gift Card Balance$|^Promotional Credit$/i.test(s)) return true;
  return false;
}

async function beginScan(baseUrl, targetMonth) {
  console.log('[ABT] beginScan called - targetMonth:', targetMonth, 'baseUrl:', baseUrl);
  const data = await chrome.storage.local.get({ scanStatus: null, orders: {} });
  if (data.scanStatus && data.scanStatus.scanning && !isStale(data.scanStatus)) {
    console.log('[ABT] Scan already in progress, aborting');
    return;
  }

  // Clean up bad payment method values from previous scans so they get re-fetched
  let cleared = 0;
  Object.values(data.orders).forEach(o => {
    if (o.paymentMethod && !isValidPaymentMethod(o.paymentMethod)) {
      delete o.paymentMethod;
      cleared++;
    }
  });
  if (cleared > 0) {
    console.log('[ABT] Cleared', cleared, 'invalid payment method values; will re-fetch.');
    await chrome.storage.local.set({ orders: data.orders });
  }

  const startedAt = Date.now();
  const [year] = targetMonth.split('-').map(Number);
  console.log('[ABT] Scanning year:', year, 'for month:', targetMonth);

  scanState = {
    baseUrl,
    targetMonth,   // "YYYY-MM"
    startedAt,
    stored: data.orders,
    scanned: 0,
    total: null,   // filled from Amazon's "N orders placed" header
    newIds: new Set(),
    tabId: null,
  };

  await chrome.storage.local.set({ scanStatus: { scanning: true, scanned: 0, total: null, phase: 'orders', startedAt } });

  const url = `${baseUrl}/your-orders/orders?timeFilter=year-${year}`;

  // Reuse an existing Amazon orders tab if one is open, so user keeps DevTools attached.
  const existing = await chrome.tabs.query({
    url: ['*://www.amazon.com/gp/your-account/order-history*', '*://www.amazon.com/your-orders/*']
  });
  let tab;
  if (existing.length > 0) {
    console.log('[ABT] Reusing existing Amazon orders tab:', existing[0].id, existing[0].url);
    tab = await chrome.tabs.update(existing[0].id, { url, active: false });
    scanState.reusedTab = true;
  } else {
    console.log('[ABT] No existing Amazon orders tab; creating new one.');
    tab = await chrome.tabs.create({ url, active: false });
    scanState.reusedTab = false;
  }
  scanState.tabId = tab.id;

  chrome.tabs.onRemoved.addListener(function onRemoved(tabId) {
    if (tabId !== scanState?.tabId) return;
    chrome.tabs.onRemoved.removeListener(onRemoved);
    chrome.storage.local.set({ scanStatus: { scanning: false, scanned: scanState.scanned } });
    scanState = null;
  });
}

async function handlePageScraped(orders, nextUrl, totalCount) {
  const { stored, newIds, startedAt, targetMonth } = scanState;

  console.log('[ABT] handlePageScraped - targetMonth:', targetMonth, 'orders received:', orders.length, 'totalCount:', totalCount, 'nextUrl:', nextUrl);
  console.log('[ABT] Order dates on this page:', orders.map(o => o.date));
  console.log('[ABT] Sample order:', orders[0]);

  // Capture the year total from the first page
  if (totalCount && scanState.total === null) {
    scanState.total = totalCount;
  }

  // Only keep orders in the target month; stop if we've passed it
  const targetOrders = orders.filter(o => o.date && o.date.startsWith(targetMonth));
  const passedMonth = orders.some(o => o.date && o.date.slice(0, 7) < targetMonth);
  console.log('[ABT] Target-month orders:', targetOrders.length, 'passedMonth:', passedMonth);

  targetOrders.forEach(o => {
    const key = o.id || `${o.date}_${o.amount}`;
    const existing = stored[key] || {};
    stored[key] = {
      ...existing, ...o,
      productName: o.productName || existing.productName || null,
      paymentMethod: existing.paymentMethod || null,
    };
    if (o.id && !existing.paymentMethod) newIds.add(o.id);
  });

  // Use all orders seen (not just target month) for progress bar so it moves
  // while scanning through pages that precede the target month
  scanState.scanned += orders.length;
  scanState.monthFound = (scanState.monthFound || 0) + targetOrders.length;

  await chrome.storage.local.set({ orders: stored, lastScan: Date.now() });
  await chrome.storage.local.set({
    scanStatus: {
      scanning: true,
      scanned: scanState.scanned,
      monthFound: scanState.monthFound,
      total: scanState.total,
      phase: 'orders',
      startedAt,
    }
  });

  if (!passedMonth && nextUrl) {
    await chrome.tabs.update(scanState.tabId, { url: nextUrl });
    return;
  }

  console.log('[ABT] Order scan complete. Pages scanned (orders count):', scanState.scanned, 'matching', targetMonth, ':', scanState.monthFound, '/', scanState.total, 'passedMonth:', passedMonth, 'nextUrl was:', nextUrl);
  if (scanState.monthFound === 0) {
    console.warn('[ABT] No orders found for', targetMonth, '- Amazon pagination ended at order date:', orders[orders.length - 1]?.date);
  }

  // Done with order scan - start payment phase
  await startPaymentPhase();
}

async function startPaymentPhase() {
  // Null out tabId first so the onRemoved listener ignores the programmatic close
  const tabId = scanState.tabId;
  const reused = scanState.reusedTab;
  scanState.tabId = null;
  // Don't close a tab the user already had open; only close ones we created
  if (tabId && !reused) {
    try { await chrome.tabs.remove(tabId); } catch (e) {}
  }

  const newIdsArr = Array.from(scanState.newIds);
  const { stored, scanned, total, startedAt, baseUrl } = scanState;

  if (newIdsArr.length > 0) {
    const BATCH = 5;
    for (let i = 0; i < newIdsArr.length; i += BATCH) {
      await chrome.storage.local.set({
        scanStatus: { scanning: true, scanned, total, phase: 'details', detailTotal: newIdsArr.length, detailDone: i, startedAt }
      });
      const batch = newIdsArr.slice(i, i + BATCH);
      await Promise.all(batch.map(async id => {
        const method = await fetchPaymentMethod(baseUrl, id);
        if (method && stored[id]) stored[id] = { ...stored[id], paymentMethod: method };
      }));
      await chrome.storage.local.set({ orders: stored });
    }
  }

  const monthFound = scanState.monthFound || 0;
  const targetMonth = scanState.targetMonth;
  const finalStatus = { scanning: false, scanned, monthFound, targetMonth };
  if (monthFound === 0) {
    finalStatus.info = `No orders found for ${targetMonth}. (Amazon returned ${scanned} orders for the year, but none in this month.)`;
  }
  console.log('[ABT] Scan finished:', finalStatus);
  await chrome.storage.local.set({ scanStatus: finalStatus });
  scanState = null;
}

async function fetchPaymentMethod(baseUrl, orderId) {
  try {
    const url = `${baseUrl}/your-orders/order-details?orderID=${encodeURIComponent(orderId)}`;
    const resp = await fetch(url, { credentials: 'include' });
    if (!resp.ok) return null;
    const html = await resp.text();

    // Amazon's order detail page renders payment as:
    //   <img alt="Visa" ... class="pmts-payment-credit-card-instrument-logo"> ... ending in NNNN
    // The card name comes from the img alt, and "ending in NNNN" appears within ~500 chars after.
    const cardImg = html.match(/<img\s+alt="([^"]+)"[^>]*pmts-payment-credit-card-instrument-logo[\s\S]{0,800}?ending in (\d{4})/i);
    if (cardImg) {
      const result = `${cardImg[1].trim()} ending in ${cardImg[2]}`;
      console.log('[ABT] Payment for', orderId, '->', result);
      return result;
    }

    // Fallbacks for non-card payments
    if (/Gift\s+Card\s+Balance/i.test(html)) return 'Gift Card Balance';
    if (/Promotional\s+(?:Credit|Balance)/i.test(html)) return 'Promotional Credit';

    // DEBUG: dump snippets around payment-related keywords so we can see Amazon's format
    console.log('[ABT] Payment for', orderId, '-> none matched. HTML length:', html.length);
    const keywords = ['ending in', 'Payment Method', 'Payment information', 'Visa', 'Mastercard', 'Discover', 'Amex', 'card-info', 'pmts-payment', 'credit card'];
    for (const kw of keywords) {
      const idx = html.toLowerCase().indexOf(kw.toLowerCase());
      if (idx !== -1) {
        const snippet = html.slice(Math.max(0, idx - 80), idx + 200).replace(/\s+/g, ' ');
        console.log(`[ABT]   keyword "${kw}" found @ ${idx}:`, snippet);
      } else {
        console.log(`[ABT]   keyword "${kw}" NOT found`);
      }
    }
    return null;
  } catch (e) {
    console.warn('[ABT] fetchPaymentMethod error for', orderId, e);
    return null;
  }
}
