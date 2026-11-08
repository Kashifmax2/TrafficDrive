# TrafficDrive

Desktop traffic-automation app built with **Electron + Node.js + Playwright**.

- Dashboard UI: plain HTML/CSS/JS (`index.html`, `i18n.js`)
- Local REST backend: `server.js` on `http://127.0.0.1:3000`
- Automation: Playwright 1.63 driving Chromium
- Modules: Direct, Organic, Referral, Google Maps, RPA record/replay, Random Clicks
- Platforms: **Windows 10/11**, **Linux x64** (AppImage / deb), macOS

> Source-only repository. `node_modules`, the Electron runtime, the bundled
> Chromium browser and the packaged `app.asar` are **not** committed. They are
> installed or downloaded by the build steps below.

## Features that stay identical on every OS

- Random clicks open links in **background tabs** (no focus stealing)
- RPA replay, campaigns, dwell and tab lifetime behave the same
- Proxy sessions are **fail-closed** (no silent direct-IP fallback)
- Privacy / popup / captcha guards, schedules and proxy persistence
- Bundled Chromium, so campaigns work offline after install

## Download & install

### Windows

1. Download **`TrafficDrive-Setup-5.9.0.exe`** (installer) or
   **`TrafficDrive-Portable-5.9.0.exe`** (no installation).
2. Run it. Because the build is not code-signed, SmartScreen may show
   "Windows protected your PC" → **More info → Run anyway**.
3. The app opens directly. No Node.js, no Playwright download required.

If you use the portable EXE, the browser is extracted to a temp folder on
every launch (15–30 seconds the first time).

### Linux (AppImage — recommended)

```bash
chmod +x TrafficDrive-5.9.0-x86_64.AppImage
./TrafficDrive-5.9.0-x86_64.AppImage
```

- Ubuntu 22.04+ needs FUSE 2 for AppImage:
  `sudo apt install libfuse2`
- If your desktop blocks AppImage, extract and run:
  `./TrafficDrive-5.9.0-x86_64.AppImage --appimage-extract` then
  `./squashfs-root/TrafficDrive`
- The app starts with `--no-sandbox` on Linux only, because Ubuntu 24.04+
  restricts unprivileged user namespaces. This does not change campaign
  behaviour.

### Linux (deb)

```bash
sudo apt install ./TrafficDrive-5.9.0-amd64.deb
trafficdrive
```

Or install from your file manager. All Chromium/Playwright libraries are
declared as dependencies.

## Install from GitHub Actions (no local toolchain)

Every push to `main`, every tag `v*`, or a manual run builds both platforms:

1. Push this repository to GitHub.
2. Open **Actions → Build installers → Run workflow**.
3. Download the artifacts:
   - `TrafficDrive-windows` → installer + portable EXE
   - `TrafficDrive-linux` → `.AppImage` + `.deb`

The Linux job runs a real smoke test first (`xvfb-run`) that starts the
backend, launches the bundled Chromium, renders a page, and checks
`/api/health` and `/api/browsers/detect`.

Pushing a tag (`git tag v5.9.0 && git push origin v5.9.0`) also publishes a
GitHub Release with all files attached.

## Build from source

Requirements: Node.js 20+ and npm.

```bash
git clone https://github.com/<your-user>/<your-repo>.git
cd <your-repo>
npm install

# download the Chromium that Playwright 1.63 expects
npx playwright install chromium
# Linux only: system libraries
npx playwright install-deps chromium

# copy the downloaded browser into vendor/chromium (offline bundle)
npm run chromium:prepare

# run in development
npm start
```

Build installers:

```bash
npm run build:win      # Windows: NSIS installer + portable EXE  → dist/
npm run build:linux    # Linux: AppImage + deb                   → dist/
```

`vendor/chromium` is required by `electron-builder` and is copied to
`resources/chromium` inside the app. It is ignored by git because it is
platform-specific and large.

### Build on Windows from an existing Chromium folder

If you already have a Chromium build (for example the one from an installed
TrafficDrive), point the prepare script at it:

```powershell
$env:CHROMIUM_SOURCE = "D:\TrafficDrive\resources\chromium"
npm run chromium:prepare
npm run build:win
```

### Cross-building Linux from Windows

`AppImage` needs symlink privileges and a Linux `mksquashfs`, so build Linux
artifacts on Linux or through GitHub Actions. A Windows `tar.gz` cross-build
loses Unix executable bits and is not a supported release artifact.

## Local data (not in git)

| Data | Windows | Linux | macOS |
|---|---|---|---|
| Proxies | `%LOCALAPPDATA%\NGF NOMI TOOLS\proxies.json` | `~/.config/trafficdrive/proxies.json` | `~/Library/Application Support/TrafficDrive/proxies.json` |
| Schedule | `...\NGF NOMI TOOLS\schedule.json` | `~/.config/trafficdrive/schedule.json` | `...\TrafficDrive\schedule.json` |
| Installed browsers | `...\NGF NOMI TOOLS\browsers\` | `~/.config/trafficdrive/browsers/` | `...\TrafficDrive\browsers/` |
| Settings / recordings | app window `localStorage` | app window `localStorage` | app window `localStorage` |

Back these up separately when moving to another computer. Never commit proxy
credentials or recordings.

## Project layout

| File | Purpose |
|---|---|
| `main.js` | Electron window + starts the backend |
| `preload.js` | Safe bridge exposed to the UI |
| `index.html` | Dashboard (UI, modals, settings) |
| `server.js` | REST API for campaigns, RPA, proxies |
| `platform.js` | Cross-platform data dirs + browser discovery |
| `browser-launcher.js` | Bundled/cached/system Chromium resolution |
| `Directtraffic.js` | Direct traffic campaign |
| `Organic Search.js` | Search-engine traffic |
| `SocialTraffic.js` | Referral / social traffic |
| `Google map traffic.js` | Google Maps traffic |
| `Automation controller.js`, `RpaRecorder.js` | RPA record/replay |
| `RandomClicker.js` | Random clicks, background tabs |
| `ProxiedSession.js`, `EgressGuard.js`, `ProxyBrowserCheck.js` | Proxy + IP verification |
| `PageGuard.js`, `PopupHandler.js`, `PrivacyGuard.js` | Runtime guards |
| `i18n.js` | English/Urdu strings |
| `scripts/prepare-chromium.js` | Copies Chromium into `vendor/chromium` |
| `scripts/smoke-test.js` | Backend + browser + detection smoke test |
| `electron-builder.yml` | Installer configuration |

## Hindi / Roman Urdu quick start

1. GitHub par naya **empty** repository banao.
2. Is folder me:
   ```bash
   git remote add origin https://github.com/<user>/<repo>.git
   git push -u origin main
   ```
3. GitHub → **Actions** → *Build installers* → **Run workflow**.
4. Windows ke liye `TrafficDrive-Setup-5.9.0.exe`, Linux ke liye
   `TrafficDrive-5.9.0-x86_64.AppImage` download karo.
5. Linux par: `chmod +x TrafficDrive-*.AppImage` phir double-click / run.
6. Source se chalana ho to: `npm install` → `npx playwright install chromium`
   → `npm start`.

## License

MIT — see `LICENSE`.
