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

    if (!nextLi || nextLi.classList.contains('a-disabled')) {
      const nextByText = Array.from(document.querySelectorAll('a')).find(a => /^\s*next\s*(page)?\s*$|next\s*→/i.test(a.textContent));
      if (nextByText) return nextByText.href;
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
    let productNames = null;
    if (titleEls.length > 0) {
      let names = titleEls.map(el => el.textContent.trim()).filter(Boolean);

      // For multi-item orders, bubble items from a "Return started" shipment block
      // to the front so the badge lands on the correct product.
      if (names.length > 1) {
        const returningNames = new Set();
        titleEls.forEach(el => {
          let p = el.parentElement;
          while (p && p !== card) {
            if (Array.from(p.children).some(c => /^\s*Return started\s*$/i.test(c.textContent))) {
              returningNames.add(el.textContent.trim());
              break;
            }
            p = p.parentElement;
          }
        });
        if (returningNames.size > 0) {
          names = [
            ...names.filter(n => returningNames.has(n)),
            ...names.filter(n => !returningNames.has(n)),
          ];
        }
      }

      if (names.length > 0) {
        productNames = names;
        productName = names.slice(0, 2).join(', ');
        if (names.length > 2) productName += ` +${names.length - 2} more`;
      }
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

    // Strategy A: sum explicit "Refund... $X.XX" amounts (handles partial refunds)
    let refundedAmount = 0;
    const innerText = card.innerText || '';
    const refundRe = /\b(?:Item\s+refund|Refund(?:ed|\s+(?:issued|complete|total|received|amount))?)\s*[:\-]?\s*\$([\d,]+(?:\.\d{2})?)/gi;
    let rm;
    while ((rm = refundRe.exec(innerText)) !== null) {
      refundedAmount += parseFloat(rm[1].replace(/,/g, ''));
    }
    // Strategy B: full-refund indicator without an explicit $ amount
    // (e.g. "Your refund has been issued" + "Return complete"). Fill in the order
    // total as the refund amount once it's parsed, below.
    const fullRefundIndicator = refundedAmount === 0 && /\b(?:Your refund has been issued|Return complete|Refund issued|Refund complete|Refund received)\b/i.test(innerText);

    const cancelled = /\bCancelled\b/i.test(innerText) && /\bYou have not been charged\b/i.test(innerText);
    const returnStarted = !cancelled && (/\bReturn started\b/i.test(innerText) || /\bYour refund will be processed when we receive\b/i.test(innerText));

    // payment method - visible on the order card for some account/page layouts
    let paymentMethod = null;
    const cardText = (card.innerText || '').replace(/\s+/g, ' ');

    // Strategy 1: known brand + "ending in XXXX" / "•••• XXXX"
    const pmtMatch = cardText.match(
      /\b((?:(?:Amazon|Chase|Citi|Capital One|Bank of America|Costco|Synchrony)\s+)?(?:Visa|Mastercard|MasterCard|American\s+Express|Amex|Discover|JCB|Diners)[^:,\n·•]{0,30}?(?:ending in|[•*\.]{2,}\s*)\d{4})/i
    );
    if (pmtMatch) {
      const raw = pmtMatch[1].replace(/[\s·•\-|]+$/, '').trim();
      const last4 = raw.match(/(\d{4})$/)?.[1];
      if (last4) {
        const brand = raw.replace(/\s*(?:ending\s+in\s+|[•*\.·]{1,}\s*)\d{4}$/i, '').trim();
        paymentMethod = `${brand || 'Card'} ending in ${last4}`;
      } else {
        paymentMethod = raw;
      }
    }

    // Strategy 2: fallback - generic "<word(s)> ending in XXXX" anywhere on the card.
    // Catches brands not listed above (e.g. Wells Fargo, Apple, store-brand cards).
    if (!paymentMethod) {
      const m2 = cardText.match(/([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,3})\s+ending in (\d{4})/);
      if (m2) {
        paymentMethod = `${m2[1].trim()} ending in ${m2[2]}`;
      } else {
        const m3 = cardText.match(/ending in (\d{4})/i);
        if (m3) paymentMethod = `Card ending in ${m3[1]}`;
      }
    }

    // shipping recipient name - "Delivered to John Smith", "Ships to Jane Doe", etc.
    let shipTo = null;
    const recipientLink = card.querySelector('.recipient a, [class*="recipient"] a');
    if (recipientLink) {
      shipTo = recipientLink.textContent.trim() || null;
    }
    if (!shipTo) {
      const ct = (card.innerText || '').replace(/[ \t]+/g, ' ');
      const sm = ct.match(/(?:Deliver(?:ed|ing|s)?\s+to|Ship(?:ped|ping)?\s+to)[:\s]+([A-Z][A-Za-z\s.'`\-]{2,50}?)(?:\n|$)/im);
      if (sm) shipTo = sm[1].trim() || null;
    }

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
    if (fullRefundIndicator || cancelled) refundedAmount = amount || 0;
    return { id, date, amount: amount || 0, productName, productNames, shipTo, paymentMethod, refundedAmount, refundComplete: fullRefundIndicator, cancelled, returnStarted };
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
