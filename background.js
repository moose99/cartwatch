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
const PAGE_TIMEOUT_MS = 12000; // max wait for a page to scrape before aborting
let scanState = null;
let pageTimer = null;

// On every service worker (re)start, close any scan tab left open by a previous
// instance that was killed mid-scan. The tab id is persisted to storage so it
// survives the service worker being terminated.
chrome.storage.local.get({ scanTabId: null, scanStatus: null }, ({ scanTabId, scanStatus }) => {
  if (scanTabId === null) return;
  chrome.tabs.remove(scanTabId, () => { void chrome.runtime.lastError; }); // suppress "no such tab"
  const update = { scanTabId: null };
  if (scanStatus?.scanning) {
    update.scanStatus = { scanning: false, info: 'Previous scan was interrupted.' };
  }
  chrome.storage.local.set(update, () => { void chrome.runtime.lastError; });
});

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
  gameWindowIds.delete(id);
});

chrome.windows.onBoundsChanged.addListener(win => {
  if (win.id === watchWindowId) {
    chrome.storage.local.set(
      { winBounds: { width: win.width, height: win.height, left: win.left, top: win.top } },
      () => { void chrome.runtime.lastError; }
    );
    return;
  }
  // Enforce minimum size on game windows. Chrome has no native "non-resizable"
  // option, so we snap the window back if the user drags it below the minimum.
  if (gameWindowIds.has(win.id)) {
    if (win.width < GAME_MIN_W || win.height < GAME_MIN_H) {
      chrome.windows.update(win.id, {
        width: Math.max(win.width, GAME_MIN_W),
        height: Math.max(win.height, GAME_MIN_H),
      }, () => { void chrome.runtime.lastError; });
    }
  }
});

// --- Game window management ---

const GAME_MIN_W = 360;
const GAME_MIN_H = 540;
const gameWindowIds = new Set();

async function openGameWindow() {
  const win = await chrome.windows.create({
    url: chrome.runtime.getURL('game.html'),
    type: 'popup',
    width: GAME_MIN_W,
    height: GAME_MIN_H,
    focused: true,
  });
  gameWindowIds.add(win.id);
}

function isStale(s) {
  return Date.now() - (s.startedAt || 0) > 5 * 60 * 1000;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'startScan') {
    beginScan(msg.baseUrl || BASE_URL, msg.targetMonth, msg.startMonth);
  }
  if (msg.type === 'pageScraped' && scanState && sender.tab?.id === scanState.tabId) {
    handlePageScraped(msg.orders, msg.totalCount).catch(console.error);
  }
  if (msg.type === 'isScanActive') {
    sendResponse({ active: scanState !== null });
    return true;
  }
  if (msg.type === 'openGame') {
    openGameWindow().catch(console.error);
  }
});

// Top-level listener (registered once) handles the user closing the scan tab.
chrome.tabs.onRemoved.addListener((tabId) => {
  if (!scanState || tabId !== scanState.tabId) return;
  const scanned = (scanState.cumScanned || 0) + (scanState.scanned || 0);
  chrome.storage.local.set(
    { scanStatus: { scanning: false, scanned }, scanTabId: null },
    () => { void chrome.runtime.lastError; }
  );
  scanState = null;
});

function armPageTimer() {
  clearPageTimer();
  pageTimer = setTimeout(async () => {
    if (!scanState) return;
    const tabId = scanState.tabId;

    // Check the scan tab's URL: if Amazon redirected to a sign-in page, the
    // user is not logged in. Otherwise fall back to a generic timeout message.
    let info = 'Scan timed out. Try again in a moment.';
    let needsLogin = false;
    if (tabId) {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.url && /\/(ap\/signin|ap\/identifierselect|gp\/sign-in)/i.test(tab.url)) {
          info = 'You are not signed in to Amazon. Please sign in to Amazon in any tab, then click Update Amazon Orders again.';
          needsLogin = true;
        }
      } catch (e) { /* tab already gone */ }
    }

    await chrome.storage.local.set({
      scanStatus: { scanning: false, info, needsLogin, needsAttention: true, errorAt: Date.now() },
      scanTabId: null,
    }, () => { void chrome.runtime.lastError; });
    scanState = null;
    if (tabId) { try { await chrome.tabs.remove(tabId); } catch (e) {} }
  }, PAGE_TIMEOUT_MS);
}

function clearPageTimer() {
  if (pageTimer) { clearTimeout(pageTimer); pageTimer = null; }
}

function buildUrl(baseUrl, year, startIndex) {
  return `${baseUrl}/your-orders/orders?timeFilter=year-${year}&startIndex=${startIndex}`;
}

// Returns all 'YYYY-MM' strings from start to end inclusive.
function monthsBetween(start, end) {
  const months = [];
  let [y, m] = start.split('-').map(Number);
  const [ey, em] = end.split('-').map(Number);
  while (y < ey || (y === ey && m <= em)) {
    months.push(`${y}-${String(m).padStart(2, '0')}`);
    if (++m > 12) { m = 1; y++; }
  }
  return months;
}

// Splits a [start, end] month range into per-calendar-year segments, since Amazon's
// order history page (timeFilter=year-N) only ever covers a single year.
function splitIntoYearSegments(startMonth, endMonth) {
  const segments = [];
  let [sy] = startMonth.split('-').map(Number);
  const [ey] = endMonth.split('-').map(Number);
  for (let y = sy; y <= ey; y++) {
    segments.push({
      year: y,
      startMonth: y === sy ? startMonth : `${y}-01`,
      targetMonth: y === ey ? endMonth : `${y}-12`,
    });
  }
  return segments;
}

async function beginScan(baseUrl, targetMonth, startMonth) {
  if (!startMonth) startMonth = targetMonth;
  const data = await chrome.storage.local.get({ scanStatus: null });
  if (data.scanStatus && data.scanStatus.scanning && !isStale(data.scanStatus)) {
    return;
  }

  scanState = {
    baseUrl,
    startedAt: Date.now(),
    overallStartMonth: startMonth,
    overallTargetMonth: targetMonth,
    segments: splitIntoYearSegments(startMonth, targetMonth), // remaining year-segments, oldest first
    cumScanned: 0,
    cumMonthFound: 0,
    didWork: false, // true once any segment actually scans (not just quick-exits)
    tabId: null,
  };

  await startSegment();
}

// Pulls the next queued year-segment into the active per-segment scan fields and
// navigates the scan tab to that year's first page (creating the tab on the first call;
// later segments reuse the same tab since it's just a URL change to a different year).
async function startSegment() {
  const seg = scanState.segments.shift();
  const data = await chrome.storage.local.get({ orders: {}, yearTotals: {}, completedMonths: {} });

  // Load this segment's orders into memory. collectStep does a read-modify-write
  // when saving, so orders outside this range are preserved.
  const stored = {};
  for (const [k, v] of Object.entries(data.orders)) {
    const mo = v.date?.slice(0, 7);
    if (mo && mo >= seg.startMonth && mo <= seg.targetMonth) stored[k] = v;
  }

  Object.assign(scanState, {
    year: seg.year,
    targetMonth: seg.targetMonth,
    startMonth: seg.startMonth,
    stored,
    scanned: 0,
    monthFound: 0,
    total: null,
    knownYearTotal: data.yearTotals[seg.year] ?? null, // used to detect if new orders exist
    completedMonths: data.completedMonths, // full map so quick-exit can check every month in range
    currentScanMonth: seg.targetMonth,

    // Binary search state
    phase: 'discover',
    lo: 0,
    hi: null,                  // shrinks during binary search
    lastPageIndex: null,       // fixed end-of-year boundary used by collect phase
    currentStartIndex: 0,
    probes: 0,                 // count of discover-phase page loads
  });

  await chrome.storage.local.set({
    scanStatus: {
      scanning: true,
      scanned: scanState.cumScanned,
      monthFound: scanState.cumMonthFound,
      total: null,
      phase: 'orders',
      startedAt: scanState.startedAt,
      targetMonth: scanState.overallTargetMonth,
      startMonth: scanState.overallStartMonth,
      currentScanMonth: scanState.currentScanMonth,
    }
  });

  const url = buildUrl(scanState.baseUrl, seg.year, 0);
  if (scanState.tabId) {
    scanState.currentStartIndex = 0;
    await chrome.tabs.update(scanState.tabId, { url });
  } else {
    // Chrome MV3 doesn't allow truly hidden tabs:
    //   - tabs.create({ windowId: popupWindowId }) is silently redirected away from popup windows
    //   - windows.create() creates a separate taskbar entry
    // The least intrusive option is a background tab in the user's main browser
    // window: it appears in the tab strip but doesn't take focus.
    const tab = await chrome.tabs.create({ url, active: false });
    scanState.tabId = tab.id;
    // Persist tab id before the tab loads so the orphan-cleanup on next SW startup can
    // close it if this service worker instance is terminated before the scan finishes.
    await chrome.storage.local.set({ scanTabId: tab.id });
  }
  armPageTimer();
}

async function navigateToStartIndex(startIndex) {
  scanState.currentStartIndex = startIndex;
  const url = buildUrl(scanState.baseUrl, scanState.year, startIndex);
  await chrome.tabs.update(scanState.tabId, { url });
  armPageTimer();
}

async function handlePageScraped(orders, totalCount) {
  clearPageTimer();
  // Capture year total from the first page
  if (totalCount && scanState.total === null) {
    scanState.total = totalCount;
    const lastPage = Math.max(0, Math.floor((totalCount - 1) / PAGE_SIZE) * PAGE_SIZE);
    scanState.lastPageIndex = lastPage;
    scanState.hi = lastPage;

    // Quick-exit this segment: year order count unchanged AND every month in this
    // segment's range was previously completed. Other queued segments (a different
    // calendar year) may still need scanning, so this only ends the current segment.
    if (scanState.knownYearTotal !== null && totalCount === scanState.knownYearTotal
        && monthsBetween(scanState.startMonth, scanState.targetMonth)
              .every(m => scanState.completedMonths[m])) {
      return finalizeSegment({ upToDate: true });
    }
  }

  scanState.scanned += orders.length;

  if (orders.length === 0) {
    return finalizeSegment();
  }

  if (scanState.phase === 'discover') {
    // Update progress during discover phase (no order writes yet)
    await chrome.storage.local.set({
      scanStatus: {
        scanning: true,
        scanned: scanState.cumScanned + scanState.scanned,
        monthFound: scanState.cumMonthFound + scanState.monthFound,
        total: scanState.total,
        phase: 'orders',
        startedAt: scanState.startedAt,
        targetMonth: scanState.overallTargetMonth,
        startMonth: scanState.overallStartMonth,
        currentScanMonth: scanState.currentScanMonth,
      }
    });
    return discoverStep(orders);
  }
  return collectStep(orders);
}

// Binary search: find the smallest startIndex where the page's oldest order
// has month <= targetMonth. (Orders are sorted newest-first.)
async function discoverStep(orders) {
  scanState.probes++;
  const { targetMonth, currentStartIndex } = scanState;
  const lastMonth = orders[orders.length - 1].date?.slice(0, 7);

  if (lastMonth <= targetMonth) {
    // page contains target-or-older orders; boundary is here or earlier
    scanState.hi = currentStartIndex;
  } else {
    // entire page is newer than target; boundary is later (older orders)
    scanState.lo = currentStartIndex + PAGE_SIZE;
  }

  if (scanState.lo >= scanState.hi) {
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

// Linear scan forward collecting orders in [startMonth, targetMonth] until we cross before startMonth.
async function collectStep(orders) {
  const { stored, startMonth, targetMonth } = scanState;
  const targetOrders = orders.filter(o => {
    const m = o.date?.slice(0, 7);
    return m && m >= startMonth && m <= targetMonth;
  });
  const passedMonth = orders.some(o => {
    const m = o.date?.slice(0, 7);
    return m && m < startMonth;
  });

  targetOrders.forEach(o => {
    const key = o.id || `${o.date}_${o.amount}`;
    const existing = stored[key] || {};
    stored[key] = {
      ...existing, ...o,
      productName: o.productName || existing.productName || null,
      productNames: o.productNames || existing.productNames || null,
      shipTo: o.shipTo || existing.shipTo || null,
      paymentMethod: o.paymentMethod || existing.paymentMethod || null,
      // refund amount: prefer the latest scan (refunds can be issued after the order)
      refundedAmount: o.refundedAmount !== undefined ? o.refundedAmount : (existing.refundedAmount || 0),
    };
  });

  scanState.monthFound += targetOrders.length;

  // Track the oldest month touched on this page so the UI can show which month is being processed.
  if (targetOrders.length > 0) {
    const oldest = targetOrders[targetOrders.length - 1].date?.slice(0, 7);
    if (oldest) scanState.currentScanMonth = oldest;
  }

  // Read the full order history, merge this month's updates, then write everything
  // in a single call. scanState.stored holds only the target month so we must
  // merge rather than replace.
  const { orders: allOrders } = await chrome.storage.local.get({ orders: {} });
  await chrome.storage.local.set({
    orders: { ...allOrders, ...stored },
    lastScan: Date.now(),
    scanStatus: {
      scanning: true,
      scanned: scanState.cumScanned + scanState.scanned,
      monthFound: scanState.cumMonthFound + scanState.monthFound,
      total: scanState.total,
      phase: 'orders',
      startedAt: scanState.startedAt,
      targetMonth: scanState.overallTargetMonth,
      startMonth: scanState.overallStartMonth,
      currentScanMonth: scanState.currentScanMonth,
    },
  });

  if (passedMonth) {
    return finalizeSegment();
  }

  const nextIndex = scanState.currentStartIndex + PAGE_SIZE;
  if (scanState.lastPageIndex !== null && nextIndex > scanState.lastPageIndex) {
    return finalizeSegment();
  }
  return navigateToStartIndex(nextIndex);
}

// Completes the current year-segment: persists its completedMonths/yearTotals (skipped on a
// quick-exit, since nothing changed) and folds its counts into the running totals. If more
// segments remain (the requested range spanned multiple calendar years), advances to the next
// one; otherwise ends the whole scan.
async function finalizeSegment(opts = {}) {
  clearPageTimer();
  scanState.cumScanned += scanState.scanned || 0;
  scanState.cumMonthFound += scanState.monthFound || 0;
  if (!opts.upToDate) scanState.didWork = true;

  // Persist the year total and mark this segment's months as fully scanned. Only happens
  // on a clean finalize (not on timeout/tab-close, and not on a quick-exit where nothing
  // changed), so an interrupted scan won't falsely mark months complete.
  if (!opts.upToDate && scanState.total) {
    const { yearTotals = {}, completedMonths = {} } = await chrome.storage.local.get({ yearTotals: {}, completedMonths: {} });
    const monthUpdates = {};
    monthsBetween(scanState.startMonth, scanState.targetMonth).forEach(m => { monthUpdates[m] = Date.now(); });
    await chrome.storage.local.set({
      yearTotals: { ...yearTotals, [scanState.year]: scanState.total },
      completedMonths: { ...completedMonths, ...monthUpdates },
    });
  }

  if (scanState.segments.length > 0) {
    return startSegment();
  }
  return finishScan();
}

// Ends the overall (possibly multi-year) scan: closes the tab and writes the final status.
async function finishScan() {
  const tabId = scanState.tabId;
  // Clear tabId before removing the tab: chrome.tabs.remove() fires onRemoved
  // synchronously, and that listener nulls scanState if tabId still matches.
  scanState.tabId = null;
  if (tabId) { try { await chrome.tabs.remove(tabId); } catch (e) {} }
  const { cumScanned: scanned, cumMonthFound: monthFound, overallStartMonth, overallTargetMonth, didWork } = scanState;
  const storageUpdate = { scanTabId: null };
  if (!didWork) {
    storageUpdate.scanStatus = { scanning: false, upToDate: true };
  } else {
    const finalStatus = { scanning: false, scanned, monthFound, targetMonth: overallTargetMonth, startMonth: overallStartMonth };
    if (monthFound === 0) {
      const label = overallStartMonth === overallTargetMonth ? overallTargetMonth : `${overallStartMonth} to ${overallTargetMonth}`;
      finalStatus.info = `No orders found for ${label}.`;
    }
    storageUpdate.scanStatus = finalStatus;
  }
  await chrome.storage.local.set(storageUpdate);
  scanState = null;
}
