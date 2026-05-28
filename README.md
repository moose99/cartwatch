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

CartWatch opens a background browser tab to navigate Amazon order history pages (direct fetch isn't possible due to client-side encryption). A content script reads each page and sends order data back to the service worker, which uses a binary search to find the target month quickly before doing a linear scan to collect orders. Everything is stored locally in `chrome.storage.local` - nothing leaves the browser.

See the source for implementation details.
