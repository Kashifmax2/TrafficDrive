# TrafficDrive

Desktop traffic-automation app built with **Electron + Node.js + Playwright**.

- Dashboard UI: plain HTML/CSS/JS (`index.html`, `i18n.js`)
- Local REST backend: `server.js` on `http://127.0.0.1:3000`
- Automation: Playwright 1.63 driving Chromium
- Modules: Direct, Organic, Referral, Google Maps, RPA record/replay, Random Clicks

> Source-only repository. The Electron runtime, Chromium browser and the
> packaged `app.asar` are **not** committed; they are installed/downloaded.

## Requirements

- Node.js 18 or newer (20+ recommended)
- npm
- Windows 10/11, Linux (X11/Wayland), or macOS

## Install & run

```bash
git clone https://github.com/<your-user>/<your-repo>.git
cd <your-repo>
npm install

# download the browser Playwright drives (once)
npx playwright install chromium
# Linux only: also install system libraries
npx playwright install-deps chromium

npm start
```

The dashboard opens and talks to the backend on port `3000`.

### Linux notes

- Run with a desktop session (Electron needs GTK). For a headless server use Xvfb.
- Playwright's own Chromium is used automatically once installed above.
- The in-app "Install browser" button and installed-browser detection are
  Windows-oriented; on Linux just use Playwright's browser or set a custom
  browser path in the UI.
- Local data is stored under `~/AppData/Local/NGF NOMI TOOLS/` (same path is
  used on every OS by the current code).

### Windows notes

- `npm install` + `npx playwright install chromium` is enough.
- To rebuild the packaged app, replace `resources/app.asar` with your packed
  source and restart `TrafficDrive.exe`.

## Project layout

| File | Purpose |
|---|---|
| `main.js` | Electron window + starts the backend |
| `preload.js` | Safe bridge exposed to the UI |
| `index.html` | Dashboard (UI, modals, settings) |
| `server.js` | REST API for campaigns, RPA, proxies |
| `Directtraffic.js` | Direct traffic campaign |
| `Organic Search.js` | Search-engine traffic |
| `SocialTraffic.js` | Referral / social traffic |
| `Google map traffic.js` | Google Maps traffic |
| `Automation controller.js`, `RpaRecorder.js` | RPA record/replay |
| `RandomClicker.js` | Random clicks, background tabs |
| `ProxiedSession.js`, `EgressGuard.js`, `ProxyBrowserCheck.js` | Proxy + IP verification |
| `PageGuard.js`, `PopupHandler.js`, `PrivacyGuard.js` | Runtime guards |
| `i18n.js` | English/Urdu strings |

## Local data (not in git)

| Data | Location |
|---|---|
| Proxies | `~/AppData/Local/NGF NOMI TOOLS/proxies.json` |
| Schedule | `~/AppData/Local/NGF NOMI TOOLS/schedule.json` |
| Settings / recordings | browser `localStorage` of the app window |

Back these up separately if you move machines. Never commit proxy credentials.

## Packaging (optional)

The app is a normal Electron project, so you can package it with
`electron-builder` or `electron-packager`. Bundle Chromium only if you need an
offline installer; otherwise let Playwright download it on first run.

## Hindi quick start (short)

1. GitHub par repository banao (README ke saath).
2. Source push karo — `node_modules`, `resources/`, `app.asar`, proxies/recordings
   push **na** karo (`.gitignore` already handles this).
3. Naye PC par: `git clone` → `npm install` → `npx playwright install chromium`
   → `npm start`.
4. Linux par Electron/GTK libs chahiye; `npx playwright install-deps chromium`
   se zyadatar dependencies aa jayengi.

## License

MIT (see `LICENSE` if included).
