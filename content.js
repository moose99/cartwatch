// Scrapes Amazon order history and reports to background.js via message.
// Waits for Amazon's client-side decryption to complete before reading the DOM.

(function () {
  let reported = false;

  function init() {
    waitForDecryptedOrders(() => {
      if (reported) return;
      reported = true;

      const orders = scrapeOrders();
      const nextUrl = getNextUrl();
      const totalCount = getTotalCount();
      console.log('[ABT-content] Scraped page - URL:', location.href);
      console.log('[ABT-content] Orders found:', orders.length, 'totalCount:', totalCount, 'nextUrl:', nextUrl);
      console.log('[ABT-content] First order:', orders[0]);
      console.log('[ABT-content] All dates:', orders.map(o => o.date));
      if (orders.length === 0) {
        const cardCount = document.querySelectorAll('.order-card').length;
        const headerListCount = document.querySelectorAll('li.order-header__header-list-item').length;
        console.warn('[ABT-content] No orders parsed! .order-card:', cardCount, 'li.order-header__header-list-item:', headerListCount);
      }
      chrome.runtime.sendMessage({ type: 'pageScraped', orders, nextUrl, totalCount });
    });

    chrome.storage.local.get({ scanStatus: null }, ({ scanStatus }) => {
      if (scanStatus && scanStatus.scanning) updateBanner(scanStatus);
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.scanStatus) return;
      const s = changes.scanStatus.newValue;
      if (s && s.scanning) updateBanner(s);
      else removeBanner();
    });
  }

  // Poll until order cards have visible content (decryption complete), with timeout.
  function waitForDecryptedOrders(callback) {
    const start = Date.now();
    function check() {
      const card = document.querySelector('.order-card');
      if (card && card.querySelector('li.order-header__header-list-item')) {
        callback();
        return;
      }
      if (Date.now() - start > 8000) { callback(); return; }
      setTimeout(check, 300);
    }
    setTimeout(check, 600);
  }

  function scrapeOrders() {
    const results = [];
    document.querySelectorAll('.order-card').forEach(card => {
      const o = parseOrderCard(card);
      if (o) results.push(o);
    });
    return results;
  }

  function getNextUrl() {
    const nextLi = document.querySelector('.a-pagination .a-last');
    const pagination = document.querySelector('.a-pagination');

    console.log('[ABT-content] Pagination check on URL:', location.href);
    console.log('[ABT-content] .a-pagination found:', !!pagination);
    if (pagination) console.log('[ABT-content] .a-pagination outerHTML:', pagination.outerHTML.slice(0, 1500));
    console.log('[ABT-content] .a-pagination .a-last found:', !!nextLi, 'disabled:', nextLi?.classList.contains('a-disabled'));

    // Also try alternative selectors
    const altPaginations = document.querySelectorAll('[class*="pagination" i]');
    console.log('[ABT-content] All [class*="pagination"] elements:', altPaginations.length);
    altPaginations.forEach((el, i) => console.log(`  [${i}] class="${el.className}":`, el.outerHTML.slice(0, 400)));

    // Try links containing "Next" text or startIndex
    const allLinks = Array.from(document.querySelectorAll('a[href*="startIndex"]'));
    console.log('[ABT-content] Links with startIndex:', allLinks.length, allLinks.map(a => a.href).slice(0, 10));

    if (!nextLi || nextLi.classList.contains('a-disabled')) {
      // Fallback: find link with "Next" text
      const nextByText = Array.from(document.querySelectorAll('a')).find(a => /^\s*next\s*(page)?\s*$|next\s*→/i.test(a.textContent));
      if (nextByText) {
        console.log('[ABT-content] Fallback: found next-by-text link:', nextByText.href);
        return nextByText.href;
      }
      return null;
    }
    const a = nextLi.querySelector('a');
    return a ? a.href : null;
  }

  function parseOrderCard(card) {
    const idEl = card.querySelector('.yohtmlc-order-id span[dir="ltr"]');
    const id = idEl ? idEl.textContent.trim() : null;

    let titleEls = Array.from(card.querySelectorAll('.yohtmlc-product-title a'));
    if (titleEls.length === 0) {
      titleEls = Array.from(card.querySelectorAll('a[href*="/dp/"], a[href*="/gp/product/"]'));
    }
    let productName = null;
    if (titleEls.length > 0) {
      const names = titleEls.slice(0, 2).map(el => el.textContent.trim()).filter(Boolean);
      productName = names.join(', ') || null;
      if (productName && titleEls.length > 2) productName += ` +${titleEls.length - 2} more`;
    }

    let dateText = null;
    let totalText = null;
    card.querySelectorAll('li.order-header__header-list-item').forEach(item => {
      const allRows = item.querySelectorAll('.a-row');
      if (allRows.length < 2) return;
      const label = allRows[0].textContent.trim().toLowerCase();
      const value = allRows[1].textContent.trim();
      if (!dateText && label.includes('order placed')) dateText = value;
      if (!totalText && label === 'total') totalText = value;
    });

    if (!dateText) {
      console.warn('[ABT-content] parseOrderCard: missing dateText. id:', id, 'card snippet:', card.outerHTML.slice(0, 600));
      return null;
    }
    const date = parseDate(dateText);
    if (!date) {
      console.warn('[ABT-content] parseOrderCard: unparseable date. raw:', dateText, 'id:', id);
      return null;
    }
    // Allow $0.00 orders (gift cards, fully discounted, store credit) and missing total
    const amount = totalText ? parseAmount(totalText) : 0;
    if (amount === null) {
      console.warn('[ABT-content] parseOrderCard: unparseable amount. raw:', totalText, 'id:', id);
      return null;
    }
    return { id, date, amount: amount || 0, productName };
  }

  function parseDate(str) {
    if (!str) return null;
    const d = new Date(str.replace(/(\d+)(st|nd|rd|th)/g, '$1').trim());
    if (isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 10);
  }

  function parseAmount(str) {
    if (!str) return null;
    const m = str.replace(/,/g, '').match(/\d+\.\d+/);
    return m ? parseFloat(m[0]) : null;
  }

  function getTotalCount() {
    const m = document.body.innerText.match(/(\d[\d,]*)\s+orders?\s+placed/i);
    return m ? parseInt(m[1].replace(/,/g, ''), 10) : null;
  }

  // --- Banner ---

  function updateBanner(status) {
    const b = getBanner();
    if (status.phase === 'orders') {
      b.textContent = `Budget Tracker: scanning orders... (${status.scanned} saved)`;
    } else if (status.phase === 'details') {
      b.textContent = `Budget Tracker: getting payment info (${status.done || 0}/${status.total || 0})`;
    }
  }

  function getBanner() {
    let b = document.getElementById('abt-banner');
    if (!b) {
      b = document.createElement('div');
      b.id = 'abt-banner';
      b.style.cssText = [
        'position:fixed', 'top:0', 'left:50%', 'transform:translateX(-50%)',
        'background:#232f3e', 'color:#fff', 'padding:8px 18px', 'border-radius:0 0 8px 8px',
        'font:14px/1.4 Arial,sans-serif', 'z-index:99999', 'box-shadow:0 2px 8px rgba(0,0,0,.4)'
      ].join(';');
      document.body.appendChild(b);
    }
    return b;
  }

  function removeBanner() {
    const b = document.getElementById('abt-banner');
    if (b) {
      b.style.transition = 'opacity .5s';
      b.style.opacity = '0';
      setTimeout(() => b.remove(), 550);
    }
  }

  init();
})();
