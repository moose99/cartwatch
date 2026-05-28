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

CartWatch navigates Amazon order history pages using a content script which reads each page and sends order data back to the service worker to collect orders. Everything is stored locally in `chrome.storage.local` - nothing leaves the browser. No sensitive payment details are read, only Amazon's descriptive names (e.g. "Visa ending in 1234").

See privacy policy for details:
https://moose99.github.io/cartwatch/privacy-policy.html

See the source for implementation details.
