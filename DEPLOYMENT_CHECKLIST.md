# SmartFill Deployment Checklist

Use this checklist before creating a Chrome Web Store package.

## Local validation

1. Run `npm run check`.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked** and choose this folder.
5. Test on a normal `https://` form page.

## Packaging

Include only:

- `manifest.json`
- `background.js`
- `api-handler.js`
- `content.js`
- `crypto-utils.js`
- `popup.html`
- `popup.css`
- `popup.js`
- `icons/`

Exclude:

- `node_modules/`
- `archive/`
- `package*.json`
- `DEPLOYMENT_CHECKLIST.md`
- `.gitignore`

## Privacy notes

- API keys are stored encrypted in `chrome.storage.local`.
- PAN, Aadhaar, and passport values are filled locally only.
- AI providers receive non-document profile data, page field labels, and small field context snippets.
- The content script is injected only after the user clicks **Auto-Fill Page** or enables **Auto-Pilot** on the active tab.
