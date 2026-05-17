// Service worker: manages a hidden browser tab to scan Amazon order history.
// Amazon encrypts order data client-side, so fetch+DOMParser cannot read it.
//
// Scan strategy:
//   Phase 'discover' - binary search over startIndex to find the first page where
//     the oldest order on the page is at or before the target month.
//   Phase 'collect'  - linear scan forward from that boundary, collecting target-month
//     orders, until we hit an order older than the target month.

const BASE_URL = 'https://www.amazon.com';
const PAGE_SIZE = 10;
let scanState = null;

// --- CartWatch window management ---

let watchWindowId = null;

chrome.action.onClicked.addListener(async () => {
  if (watchWindowId !== null) {
    try {
      await chrome.windows.update(watchWindowId, { focused: true });
      return;
    } catch (e) {
      watchWindowId = null;
    }
  }
  const { winBounds } = await chrome.storage.local.get({ winBounds: { width: 420, height: 620 } });
  const createOpts = {
    url: chrome.runtime.getURL('popup.html'),
    type: 'popup',
    width: winBounds.width,
    height: winBounds.height,
    focused: true,
  };
  if (winBounds.left !== undefined) {
    createOpts.left = winBounds.left;
    createOpts.top  = winBounds.top;
  }
  const win = await chrome.windows.create(createOpts);
  watchWindowId = win.id;
});

chrome.windows.onRemoved.addListener(id => {
  if (id === watchWindowId) watchWindowId = null;
});

chrome.windows.onBoundsChanged.addListener(win => {
  if (win.id === watchWindowId) {
    chrome.storage.local.set({ winBounds: { width: win.width, height: win.height, left: win.left, top: win.top } });
  }
});

function isStale(s) {
  return Date.now() - (s.startedAt || 0) > 5 * 60 * 1000;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'startScan') {
    beginScan(msg.baseUrl || BASE_URL, msg.targetMonth);
  }
  if (msg.type === 'pageScraped' && scanState && sender.tab?.id === scanState.tabId) {
    handlePageScraped(msg.orders, msg.totalCount).catch(console.error);
  }
  if (msg.type === 'isScanActive') {
    sendResponse({ active: scanState !== null });
    return true;
  }
  if (msg.type === 'walletScraped') {
    handleWalletScraped(msg.cards).catch(console.error);
  }
});

async function handleWalletScraped(cards) {
  if (!Array.isArray(cards) || cards.length === 0) {
    console.log('[ABT] Wallet message had no cards; nothing to store.');
    return;
  }
  const { walletCards = [] } = await chrome.storage.local.get({ walletCards: [] });
  // index existing by last4 so we update in-place
  const byLast4 = new Map(walletCards.map(c => [c.last4, c]));
  cards.forEach(c => byLast4.set(c.last4, { ...byLast4.get(c.last4), ...c }));
  const merged = Array.from(byLast4.values());
  await chrome.storage.local.set({ walletCards: merged, walletScannedAt: Date.now() });
  console.log('[ABT] Wallet stored:', merged.length, 'cards total');

  // backfill any stored orders whose paymentMethod is partial (no name) using wallet data
  const { orders = {} } = await chrome.storage.local.get({ orders: {} });
  let updated = 0;
  Object.values(orders).forEach(o => {
    if (!o.paymentMethod) return;
    const m = o.paymentMethod.match(/ending in (\d{4})/i);
    if (!m) return;
    const card = byLast4.get(m[1]);
    if (!card || !card.name) return;
    if (/ · .+/.test(o.paymentMethod)) return; // already has a name
    o.paymentMethod = `${card.cardType || o.paymentMethod.split(' ending')[0]} ending in ${m[1]} · ${card.name}`;
    updated++;
  });
  if (updated > 0) {
    await chrome.storage.local.set({ orders });
    console.log('[ABT] Backfilled', updated, 'orders with cardholder name from wallet');
  }
}

function buildUrl(baseUrl, year, startIndex) {
  return `${baseUrl}/your-orders/orders?timeFilter=year-${year}&startIndex=${startIndex}`;
}

async function beginScan(baseUrl, targetMonth) {
  console.log('[ABT] beginScan called - targetMonth:', targetMonth, 'baseUrl:', baseUrl);
  const data = await chrome.storage.local.get({ scanStatus: null, orders: {} });
  if (data.scanStatus && data.scanStatus.scanning && !isStale(data.scanStatus)) {
    console.log('[ABT] Scan already in progress, aborting');
    return;
  }

  const startedAt = Date.now();
  const [year] = targetMonth.split('-').map(Number);
  console.log('[ABT] Scanning year:', year, 'for month:', targetMonth, '(binary search)');

  scanState = {
    baseUrl,
    year,
    targetMonth,
    startedAt,
    stored: data.orders,
    scanned: 0,
    monthFound: 0,
    total: null,
    tabId: null,

    // Binary search state
    phase: 'discover',
    lo: 0,
    hi: null,                  // shrinks during binary search
    lastPageIndex: null,       // fixed end-of-year boundary used by collect phase
    currentStartIndex: 0,
    probes: 0,                 // count of discover-phase page loads
  };

  await chrome.storage.local.set({
    scanStatus: { scanning: true, scanned: 0, monthFound: 0, total: null, phase: 'orders', startedAt }
  });

  const url = buildUrl(baseUrl, year, 0);
  // Always create as a background tab. active:false means it appears in the
  // user's tab bar but stays unfocused; their current tab and window keep focus.
  const tab = await chrome.tabs.create({ url, active: false });
  scanState.tabId = tab.id;
  console.log('[ABT] Scan tab created, id:', tab.id, 'windowId:', tab.windowId, 'active:', tab.active);

  chrome.tabs.onRemoved.addListener(function onRemoved(tabId) {
    if (tabId !== scanState?.tabId) return;
    chrome.tabs.onRemoved.removeListener(onRemoved);
    chrome.storage.local.set({ scanStatus: { scanning: false, scanned: scanState.scanned } });
    scanState = null;
  });
}

async function navigateToStartIndex(startIndex) {
  scanState.currentStartIndex = startIndex;
  const url = buildUrl(scanState.baseUrl, scanState.year, startIndex);
  console.log('[ABT] Navigate -> startIndex', startIndex, '(phase:', scanState.phase + ')');
  await chrome.tabs.update(scanState.tabId, { url });
}

async function handlePageScraped(orders, totalCount) {
  const { targetMonth, currentStartIndex } = scanState;

  // Capture year total from the first page
  if (totalCount && scanState.total === null) {
    scanState.total = totalCount;
    const lastPage = Math.max(0, Math.floor((totalCount - 1) / PAGE_SIZE) * PAGE_SIZE);
    scanState.lastPageIndex = lastPage;
    scanState.hi = lastPage;
    console.log('[ABT] Year total:', totalCount, 'lastPageIndex:', lastPage);
  }

  console.log('[ABT] Page received - phase:', scanState.phase, 'startIndex:', currentStartIndex, 'orders:', orders.length, 'lo:', scanState.lo, 'hi:', scanState.hi);
  if (orders.length > 0) {
    console.log('[ABT] Dates:', orders.map(o => o.date));
  }

  // Update progress (count every order we examine, not just target-month matches)
  scanState.scanned += orders.length;
  await chrome.storage.local.set({
    scanStatus: {
      scanning: true,
      scanned: scanState.scanned,
      monthFound: scanState.monthFound,
      total: scanState.total,
      phase: 'orders',
      startedAt: scanState.startedAt,
    }
  });

  if (orders.length === 0) {
    console.warn('[ABT] Empty page at startIndex', currentStartIndex, '- ending order scan.');
    return finalizeScan();
  }

  if (scanState.phase === 'discover') {
    return discoverStep(orders);
  }
  return collectStep(orders);
}

// Binary search: find the smallest startIndex where the page's oldest order
// has month <= targetMonth. (Orders are sorted newest-first.)
async function discoverStep(orders) {
  scanState.probes++;
  const { targetMonth, currentStartIndex } = scanState;
  const firstMonth = orders[0].date?.slice(0, 7);
  const lastMonth = orders[orders.length - 1].date?.slice(0, 7);
  console.log('[ABT discover] probe', scanState.probes, 'firstMonth:', firstMonth, 'lastMonth:', lastMonth);

  if (lastMonth <= targetMonth) {
    // page contains target-or-older orders; boundary is here or earlier
    scanState.hi = currentStartIndex;
  } else {
    // entire page is newer than target; boundary is later (older orders)
    scanState.lo = currentStartIndex + PAGE_SIZE;
  }

  if (scanState.lo >= scanState.hi) {
    console.log('[ABT discover] Converged at startIndex', scanState.hi, 'after', scanState.probes, 'probes');
    scanState.phase = 'collect';

    if (currentStartIndex === scanState.hi) {
      // We're already on the converged page - process it now.
      return collectStep(orders);
    }
    return navigateToStartIndex(scanState.hi);
  }

  // Probe the midpoint, aligned to a page boundary
  const mid = Math.floor((scanState.lo + scanState.hi) / (2 * PAGE_SIZE)) * PAGE_SIZE;
  // Defensive: ensure mid moves forward, otherwise we'd loop forever
  const next = (mid === currentStartIndex) ? currentStartIndex + PAGE_SIZE : mid;
  return navigateToStartIndex(next);
}

// Linear scan forward, collecting target-month orders until we cross before it.
async function collectStep(orders) {
  const { stored, targetMonth } = scanState;
  const targetOrders = orders.filter(o => o.date && o.date.startsWith(targetMonth));
  const passedMonth = orders.some(o => o.date && o.date.slice(0, 7) < targetMonth);
  console.log('[ABT collect] startIndex:', scanState.currentStartIndex, 'targetOrders:', targetOrders.length, 'passedMonth:', passedMonth);

  targetOrders.forEach(o => {
    const key = o.id || `${o.date}_${o.amount}`;
    const existing = stored[key] || {};
    stored[key] = {
      ...existing, ...o,
      productName: o.productName || existing.productName || null,
      productNames: o.productNames || existing.productNames || null,
      shipTo: o.shipTo || existing.shipTo || null,
      paymentMethod: o.paymentMethod || existing.paymentMethod || null,
    };
  });

  scanState.monthFound += targetOrders.length;

  await chrome.storage.local.set({ orders: stored, lastScan: Date.now() });
  await chrome.storage.local.set({
    scanStatus: {
      scanning: true,
      scanned: scanState.scanned,
      monthFound: scanState.monthFound,
      total: scanState.total,
      phase: 'orders',
      startedAt: scanState.startedAt,
    }
  });

  if (passedMonth) {
    console.log('[ABT] Order scan complete -', scanState.monthFound, 'matched after', scanState.probes, 'discover probes.');
    return finalizeScan();
  }

  const nextIndex = scanState.currentStartIndex + PAGE_SIZE;
  if (scanState.lastPageIndex !== null && nextIndex > scanState.lastPageIndex) {
    console.log('[ABT] Reached last page of year; scan complete.');
    return finalizeScan();
  }
  return navigateToStartIndex(nextIndex);
}

async function finalizeScan() {
  const tabId = scanState.tabId;
  scanState.tabId = null;
  if (tabId) {
    try { await chrome.tabs.remove(tabId); } catch (e) {}
  }
  const monthFound = scanState.monthFound || 0;
  const targetMonth = scanState.targetMonth;
  const { scanned } = scanState;
  const finalStatus = { scanning: false, scanned, monthFound, targetMonth };
  if (monthFound === 0) finalStatus.info = `No orders found for ${targetMonth}.`;
  console.log('[ABT] Scan finished:', finalStatus);
  await chrome.storage.local.set({ scanStatus: finalStatus });
  scanState = null;
}

