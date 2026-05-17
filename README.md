# CartWatch - Amazon Budget Tracker

Chrome MV3 extension that tracks Amazon spending against a monthly budget.

## Files

- `manifest.json` - MV3 manifest; content script runs on Amazon order-history pages only
- `background.js` - Service worker; drives the scan via a background browser tab
- `content.js` - Injected into order-list pages; scrapes order cards and sends data to background
- `popup.js` / `popup.html` / `popup.css` - UI: budget progress bar, order list, recipient and payment filters
- `gen-icons.js` - One-off icon generation utility
- `icons/` - PNG/SVG icons at 16/48/128px

## Architecture

**Scan flow (background.js):**
1. Opens a background tab on the Amazon order-history page (client-side encryption means fetch+DOMParser can't read the data directly)
2. Phase `discover` - binary search over `startIndex` to find the page boundary where the target month begins
3. Phase `collect` - linear scan from that boundary, collecting orders for the target month until a page with older orders is hit
4. Finalizes and closes the tab

**Content script (content.js):**
- Polls until Amazon's client-side decryption is done (`.order-card` elements have visible content)
- Scrapes each `.order-card` for: order ID, date, total, product names, ship-to name, payment method, and refund amounts
- Payment method is read directly from the card text via regex ("ending in XXXX" patterns) - there is no separate order-detail page scraping phase
- Sends results back via `chrome.runtime.sendMessage({ type: 'pageScraped', ... })`

**Storage:**
- Orders stored in `chrome.storage.local` keyed by order ID (falls back to `date_amount` composite key)
- Budget and scan status also stored in `chrome.storage.local`
