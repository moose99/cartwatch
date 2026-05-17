// Scrapes Amazon order history and reports to background.js via message.
// Waits for Amazon's client-side decryption to complete before reading the DOM.

(function () {
  let reported = false;

  function init() {
    // wallet page - scrape user's saved cards once
    if (location.pathname.includes('/cpe/yourpayments/wallet') ||
        location.pathname.includes('/cpe/managepaymentmethods')) {
      initWallet();
      return;
    }

    // order details / print invoice page - scrape payment method for the scan tab
    if (location.pathname.includes('/order-details') || location.pathname.includes('/summary/print')) {
      initOrderDetails();
      return;
    }

    // order list page
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
      console.log('[ABT-content] Ship-to names:', orders.map(o => o.shipTo));
      console.log('[ABT-content] Payment methods:', orders.map(o => o.paymentMethod));
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

  // --- Wallet page ---

  function initWallet() {
    console.log('[ABT-content] Wallet page detected:', location.href);
    waitForWallet(() => {
      if (reported) return;
      reported = true;
      const cards = scrapeWalletCards();
      console.log('[ABT-content] Wallet scrape complete -', cards.length, 'cards:', cards);
      chrome.runtime.sendMessage({ type: 'walletScraped', cards });
      flashWalletBanner(cards.length);
    });
  }

  // Wait until the page has any "ending in XXXX" text, or timeout.
  function waitForWallet(callback) {
    const start = Date.now();
    function check() {
      if (/ending in \d{4}/i.test(document.body.innerText)) {
        console.log('[ABT-content] Wallet rendered after', Date.now() - start, 'ms');
        callback();
        return;
      }
      if (Date.now() - start > 20000) {
        console.warn('[ABT-content] Wallet wait timed out at', Date.now() - start, 'ms');
        callback();
        return;
      }
      setTimeout(check, 400);
    }
    setTimeout(check, 800);
  }

  // Walk the page and pull out (cardType, last4, cardholderName) tuples.
  // We rely on the universal "ending in XXXX" phrasing to locate each card block,
  // then look around it for card-type alt text and a cardholder name line.
  function scrapeWalletCards() {
    const seen = new Map();
    const candidates = [];
    document.querySelectorAll('*').forEach(el => {
      if (el.children.length > 0 && el.children.length <= 30) {
        const text = (el.innerText || '').trim();
        if (text && text.length < 500 && /ending in \d{4}/i.test(text)) {
          candidates.push(el);
        }
      }
    });

    candidates.forEach(el => {
      const text = el.innerText || '';
      const lastMatch = text.match(/ending in (\d{4})/i);
      if (!lastMatch) return;
      const last4 = lastMatch[1];
      if (seen.has(last4)) return;

      // card type: look for an img with alt text matching a known card brand
      let cardType = '';
      const img = el.querySelector('img[alt]');
      if (img) cardType = (img.alt || '').trim();
      if (!cardType) {
        const brand = text.match(/\b(Visa|Mastercard|MasterCard|American Express|Amex|Discover|Diners|JCB|Amazon Visa|Amazon Prime Visa)\b/i);
        if (brand) cardType = brand[1];
      }

      // cardholder name: a line near the "ending in" that's a capitalized name
      let name = '';
      const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
      const idx = lines.findIndex(l => /ending in \d{4}/i.test(l));
      const nameRe = /^[A-Z][A-Za-z'.\-]+(?:\s[A-Z][A-Za-z'.\-]+){1,3}$/;
      for (let off = 1; off <= 3 && idx + off < lines.length; off++) {
        if (nameRe.test(lines[idx + off])) { name = lines[idx + off]; break; }
      }
      if (!name) {
        for (let off = 1; off <= 3 && idx - off >= 0; off++) {
          if (nameRe.test(lines[idx - off])) { name = lines[idx - off]; break; }
        }
      }

      seen.set(last4, { last4, cardType, name });
    });

    return Array.from(seen.values());
  }

  function flashWalletBanner(count) {
    const b = document.createElement('div');
    b.textContent = count > 0
      ? `CartWatch: saved ${count} payment card${count === 1 ? '' : 's'}`
      : `CartWatch: couldn't find payment cards on this page`;
    b.style.cssText = [
      'position:fixed', 'top:0', 'left:50%', 'transform:translateX(-50%)',
      'background:#232f3e', 'color:#fff', 'padding:8px 18px', 'border-radius:0 0 8px 8px',
      'font:14px/1.4 Arial,sans-serif', 'z-index:99999', 'box-shadow:0 2px 8px rgba(0,0,0,.4)'
    ].join(';');
    document.body.appendChild(b);
    setTimeout(() => {
      b.style.transition = 'opacity .5s';
      b.style.opacity = '0';
      setTimeout(() => b.remove(), 600);
    }, 3500);
  }

  function initOrderDetails() {
    // Amazon uses both orderID (capital ID) and orderId in different code paths
    const params = new URLSearchParams(location.search);
    let orderId = params.get('orderID') || params.get('orderId') || params.get('orderId.1') || params.get('orderID.1');
    if (!orderId) {
      // try to extract a 3-7-7 Amazon order id pattern from the URL itself
      const m = location.href.match(/(\d{3}-\d{7}-\d{7})/);
      if (m) orderId = m[1];
    }
    if (!orderId) {
      console.warn('[ABT-content] order-details page has no orderID in URL:', location.href);
      return;
    }
    console.log('[ABT-content] Order detail page loaded for', orderId);
    waitForPaymentSection(() => {
      if (reported) return;
      reported = true;
      const paymentMethod = scrapePaymentMethod();
      console.log('[ABT-content] Order detail payment:', orderId, '->', paymentMethod);
      chrome.runtime.sendMessage({ type: 'orderDetailScraped', orderId, paymentMethod });
    });
  }

  // Poll until the payment method section has rendered, with timeout.
  // Amazon may lazy-load the payment row when it scrolls into view, so we kick the page.
  function waitForPaymentSection(callback) {
    const start = Date.now();
    let kicked = false;
    function check() {
      if (document.querySelector('img.pmts-payment-credit-card-instrument-logo') ||
          document.querySelector('[class*="pmts-payments-instrument"]') ||
          /ending in \d{4}|Gift\s+Card\s+Balance|Promotional\s+Credit/i.test(document.body.innerText)) {
        console.log('[ABT-content] Payment section ready after', Date.now() - start, 'ms');
        callback();
        return;
      }
      // after 2s with nothing visible, scroll to trigger any lazy-loaded sections
      if (!kicked && Date.now() - start > 2000) {
        kicked = true;
        try {
          window.scrollTo(0, document.body.scrollHeight);
          setTimeout(() => window.scrollTo(0, 0), 200);
        } catch (e) { console.warn('[ABT-content] kick error', e); }
      }
      if (Date.now() - start > 12000) {
        // diagnostic: dump what we see so we can figure out why payment info is missing
        const body = document.body.innerText || '';
        const iframeEls = document.querySelectorAll('iframe');
        const iframes = iframeEls.length;
        iframeEls.forEach((f, i) => console.log('[ABT-content] iframe', i, 'src:', f.src || '(no src)', 'id:', f.id || '-'));
        const pmtsAny = document.querySelectorAll('[class*="pmts"]').length;
        const cardImgs = document.querySelectorAll('img[class*="card"], img[class*="payment"]').length;
        console.log('[ABT-content] Payment section wait timed out at', Date.now() - start, 'ms.',
                    '| URL:', location.href,
                    '| innerText length:', body.length,
                    '| iframes:', iframes,
                    '| pmts-class elements:', pmtsAny,
                    '| card-img-like:', cardImgs);
        console.log('[ABT-content] Body snippet (first 800 chars):\n', body.slice(0, 800));
        console.log('[ABT-content] Body around "Payment" (if present):',
                    (body.match(/.{0,150}Payment.{0,300}/i) || ['(no "Payment" text found)'])[0]);
        callback();
        return;
      }
      setTimeout(check, 300);
    }
    setTimeout(check, 800);
  }

  function scrapePaymentMethod() {
    const cardImg = document.querySelector('img.pmts-payment-credit-card-instrument-logo');
    const pmtsAny = document.querySelectorAll('[class*="pmts"]').length;
    const hasEnding = /ending in \d{4}/i.test(document.body.innerText);
    console.log('[ABT-content] scrapePaymentMethod - cardImg:', !!cardImg, 'pmts-elements:', pmtsAny, 'has "ending in":', hasEnding, 'title:', document.title);
    if (cardImg) {
      const cardType = (cardImg.alt || '').trim();
      // walk up to find a container with "ending in XXXX"
      let container = cardImg.closest('[class*="pmts-payments-instrument"], [class*="payment-instrument"]')
                      || cardImg.parentElement?.parentElement
                      || cardImg.parentElement;
      const text = (container ? container.innerText : '') || document.body.innerText.slice(0, 3000);
      const m = text.match(/ending in (\d{4})/i);
      if (m) {
        const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
        const endIdx = lines.findIndex(l => /ending in \d{4}/i.test(l));
        let name = '';
        if (endIdx !== -1 && endIdx + 1 < lines.length) {
          const candidate = lines[endIdx + 1];
          // cardholder name: 2-4 capitalized words, no digits
          if (/^[A-Z][a-z]+(?: [A-Z][a-z]+)+$/.test(candidate) && !/^\d/.test(candidate)) {
            name = candidate;
          }
        }
        return name ? `${cardType} ending in ${m[1]} · ${name}` : `${cardType} ending in ${m[1]}`;
      }
    }
    const bodyText = document.body.innerText;
    if (/Gift\s+Card\s+Balance/i.test(bodyText)) return 'Gift Card Balance';
    if (/Promotional\s+(?:Credit|Balance)/i.test(bodyText)) return 'Promotional Credit';
    // last-ditch: look anywhere on page for a "<card-type> ending in XXXX" run
    const fallback = bodyText.replace(/\s+/g, ' ').match(/([A-Za-z][A-Za-z ]{0,30}?ending in \d{4})/i);
    if (fallback) {
      console.log('[ABT-content] Fallback extraction matched:', fallback[1]);
      return fallback[1].trim();
    }
    return null;
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
    let productNames = null;
    if (titleEls.length > 0) {
      const names = titleEls.map(el => el.textContent.trim()).filter(Boolean);
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

    // payment method - visible on the order card for some account/page layouts
    let paymentMethod = null;
    const cardText = (card.innerText || '').replace(/\s+/g, ' ');
    // catch "Visa ending in 1234", "Amazon Visa ending in 1234", "Visa •••• 1234", "Visa: ****1234"
    const pmtMatch = cardText.match(
      /\b((?:(?:Amazon|Chase|Citi|Capital One|Bank of America|Costco|Synchrony)\s+)?(?:Visa|Mastercard|MasterCard|American\s+Express|Amex|Discover|JCB|Diners)[^:,\n·•]{0,30}?(?:ending in|[•*\.]{2,}\s*)\d{4})/i
    );
    if (pmtMatch) {
      // strip any trailing separator chars before parsing
      const raw = pmtMatch[1].replace(/[\s·•\-|]+$/, '').trim();
      const last4 = raw.match(/(\d{4})$/)?.[1];
      if (last4) {
        // brand = everything before "ending in XXXX" or "•••• XXXX"
        const brand = raw.replace(/\s*(?:ending\s+in\s+|[•*\.·]{1,}\s*)\d{4}$/i, '').trim();
        paymentMethod = `${brand || 'Card'} ending in ${last4}`;
      } else {
        paymentMethod = raw;
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
    return { id, date, amount: amount || 0, productName, productNames, shipTo, paymentMethod };
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
