# KG TRF Tool

Desktop traffic-automation app built with **Electron + Node.js + Playwright**.

- Product name: **KG TRF Tool** (version **5.9.2**)
- Dashboard UI: plain HTML/CSS/JS (`index.html`, `i18n.js`)
- Local REST backend: `server.js` on `http://127.0.0.1:3000`
- Automation: Playwright 1.63 driving Chromium
- Modules: Direct, Organic, Referral, Google Maps, RPA record/replay, Random Clicks
- Platforms: **Windows 10/11**, **Linux x64** (AppImage / deb), macOS

> Source-only repository. `node_modules`, the Electron runtime, the bundled
> Chromium browser and the packaged `app.asar` are **not** committed. They are
> installed or downloaded by the build steps below.

## What's new in 5.9.2

### Ads work again (Adsterra / Monetag)

Referer Control used to send `Referer: ''` and `Referrer-Policy: no-referrer`
as context-wide request headers. Chromium treats those as custom headers on
every subresource, so cross-origin ad scripts failed their CORS check with
`net::ERR_FAILED` and no ad rendered. Referer Control is now enforced **inside
the page** with `<meta name="referrer" content="no-referrer">` plus a
`document.referrer` override. Privacy is the same for normal sites, but ad
scripts load and render again.

The Traffic Source referrer is still applied as a real `Referer` header on the
landing navigation (tested: ads render, `document.referrer` is spoofed).

### Start / Traffic Source actually respond

- The website URL field now accepts `example.com`, `www.example.com/page` and
  `https://example.com`; it is normalized before the campaign starts.
- A rejected URL shows a visible toast instead of silently doing nothing. The
  same applies to Traffic Source custom referrers.
- Traffic Source accepts a bare domain (`facebook.com`) and shows the
  normalized value (`https://facebook.com/`) that will be sent.

### Settings survive close / reopen

- Screen Resolution, resolution category, Auto Rotate, custom width/height,
  thread count, User-Agent selection and UA Auto Rotate are all saved.
- Restoring a profile no longer lets the Device toggle overwrite the saved
  resolution category (a mobile resolution stayed mobile after restart).
- Every Settings-page control is saved on change and again on window close.

### RPA replay is safer by default

- If no proxy is selected, replay uses the **direct IP** like a normal browser
  (best ad fill, lowest ban risk). A proxy is optional.
- A failed preflight/exit-IP probe no longer aborts the whole run. Replay keeps
  the proxy candidates, verifies each session's exit IP and rotates on failure
  (up to 10 attempts).

### Codespaces / remote Linux is one click

The backend now serves the dashboard itself on port **3000** (same-origin), with
an explicit asset allowlist. In a Codespace you can open forwarded port 3000 in
any browser and use the full app; noVNC on port 6080 is only needed to watch the
separate campaign browser windows.

### Product rename

The app is now **KG TRF Tool 5.9.2**, but the user-data folder is intentionally
pinned to the previous `trafficdrive` profile, so existing settings, proxies and
RPA recordings are not lost after upgrading.

## Automated checks

```bash
npm run test:privacy          # Windows/macOS
xvfb-run -a npm run test:privacy   # headless Linux

npm run smoke                 # backend + browser + dashboard + settings
```

The privacy audit checks every toggle against real browser APIs and real request
headers, then the Traffic Source referral interaction and the UA → emulation →
`Sec-CH-UA` matrix (Windows, Android phone/tablet, iPhone, iPad). 5.9.2 also
adds static regressions that fail the build if Referer Control starts injecting
`Referer` / `Referrer-Policy` again, or if a bare-domain referrer is rejected.
Expected output: **46 passed, 0 failed** → `ALL CHECKS PASSED`.

The smoke test additionally verifies that `/` serves the dashboard, `/i18n.js`
is reachable, `/server.js` is **not** served, URL helpers work, and saved
resolution/auto-rotate values are restored by `loadFormData()`.

## Features that stay identical on every OS

- Random clicks open links in **background tabs** (no focus stealing)
- RPA replay, campaigns, dwell and tab lifetime behave the same
- Proxy sessions are **fail-closed** when a proxy is required (no silent
  direct-IP fallback); direct IP is an explicit choice
- Privacy / popup / captcha guards, schedules and proxy persistence
- Bundled Chromium, so campaigns work offline after install

## Download & install

### Windows

1. Download **`KG-TRF-Tool-Setup-5.9.2.exe`** (installer) or
   **`KG-TRF-Tool-Portable-5.9.2.exe`** (no installation).
2. Run it. Because the build is not code-signed, SmartScreen may show
   "Windows protected your PC" → **More info → Run anyway**.
3. The app opens directly. No Node.js, no Playwright download required.

If you use the portable EXE, the browser is extracted to a temp folder on
every launch (15–30 seconds the first time).

### Linux (AppImage — recommended)

```bash
chmod +x KG-TRF-Tool-5.9.2-x86_64.AppImage
./KG-TRF-Tool-5.9.2-x86_64.AppImage
```

- Ubuntu 22.04+ needs FUSE 2 for AppImage:
  `sudo apt install libfuse2`
- If your desktop blocks AppImage, extract and run:
  `./KG-TRF-Tool-5.9.2-x86_64.AppImage --appimage-extract` then
  `./squashfs-root/AppRun` (or `./squashfs-root/KG-TRF-Tool`)
- The app starts with `--no-sandbox` on Linux only, because Ubuntu 24.04+
  restricts unprivileged user namespaces. This does not change campaign
  behaviour.

### Linux (deb)

```bash
sudo apt install ./KG-TRF-Tool-5.9.2-amd64.deb
kg-trf-tool
```

Or install from your file manager. All Chromium/Playwright libraries are
declared as dependencies.

### Linux portable archive (fallback)

If AppImage/deb cannot be used, extract the portable archive and run it:

```bash
tar -xzf KG-TRF-Tool-5.9.2-linux-x64-portable.tar.gz
./KG-TRF-Tool-5.9.2-linux-x64/KG-TRF-Tool
```

It contains the same app and bundled Chromium; only the installer integration
(menu entry, auto-update paths) is missing.

## Run the Linux build in GitHub Codespaces (no Linux PC)

A Codespace is a full Ubuntu machine, so it can run the Linux build and you can
watch the real browser through your browser tab.

### One command

1. Push the repo to GitHub and open it → **Code → Codespaces → Create
   codespace** (pick the **4-core / 8 GB** machine; Chromium needs the RAM).
2. In the Codespace terminal:

   ```bash
   bash scripts/codespaces.sh
   ```

   This installs Xvfb / x11vnc / noVNC / Chromium libraries (once per
   codespace), starts a 1600x900 virtual desktop, downloads and extracts the
   `5.9.2` AppImage, and launches KG TRF Tool.
3. Open the **Ports** tab → port **3000**:

   ```
   https://<your-codespace>-3000.app.github.dev
   ```

   That is the full dashboard. It is served by the backend itself, so Start,
   Stop, proxies, RPA and settings all work directly in your browser.
4. To watch the separate campaign browser windows, open port **6080** and add
   `/vnc.html`:

   ```
   https://<your-codespace>-6080.app.github.dev/vnc.html
   ```

5. Press `Ctrl+C` to stop the app. The desktop and viewer keep running, so
   `bash scripts/codespaces.sh` starts the app again instantly.

The script also works on any headless Ubuntu/Debian machine (VPS, container).
Set `TD_VERSION=5.9.2` to pick a different release.

> Note: Codespace IPs are datacenter IPs. Some ad networks may label them
> "Anonymous Proxy". For real ad fill, run the app on a normal residential
> connection or use a residential proxy; the app itself is the same.

### Manual steps (or when the script cannot run)

```bash
sudo apt-get update
sudo apt-get install -y --no-install-recommends \
  xvfb x11vnc novnc websockify openbox libfuse2 \
  libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
  libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
  libgbm1 libasound2t64 libpango-1.0-0 libcairo2 libgtk-3-0

Xvfb :99 -screen 0 1600x900x24 &
export DISPLAY=:99
openbox &
x11vnc -display :99 -nopw -forever -shared -rfbport 5900 &
websockify --web /usr/share/novnc 6080 localhost:5900 &

chmod +x KG-TRF-Tool-5.9.2-x86_64.AppImage
./KG-TRF-Tool-5.9.2-x86_64.AppImage --appimage-extract
./squashfs-root/AppRun --no-sandbox
```

On Ubuntu 22.04 use `libasound2` instead of `libasound2t64`. If FUSE is
unavailable in the container, always use the `--appimage-extract` route above,
or the portable tar:

```bash
tar -xzf KG-TRF-Tool-5.9.2-linux-x64-portable.tar.gz
./KG-TRF-Tool-5.9.2-linux-x64/KG-TRF-Tool --no-sandbox
```

Notes:

- Use `--no-sandbox` in containers; the app already adds it on Linux.
- If Chromium complains about missing libraries, run
  `npx playwright install-deps chromium` inside the repo once.
- Codespaces stops when idle; rerun `bash scripts/codespaces.sh` after it
  resumes (it skips everything that is already running).

## Install from GitHub Actions (no local toolchain)

Every push to `main`, every tag `v*`, or a manual run builds both platforms:

1. Push this repository to GitHub.
2. Open **Actions → Build installers → Run workflow**.
3. Download the artifacts:
   - `KG-TRF-Tool-windows` → installer + portable EXE
   - `KG-TRF-Tool-linux` → `.AppImage` + `.deb`

The Linux job runs a real smoke test first (`xvfb-run`) that starts the
backend, launches the bundled Chromium, checks `/api/health`,
`/api/browsers/detect`, the dashboard on port 3000 and settings persistence.
Both jobs then run the full privacy + device audit (`npm run test:privacy`)
before building, so a broken toggle fails the build instead of shipping.

Pushing a tag (`git tag v5.9.2 && git push origin v5.9.2`) also publishes a
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
KG TRF Tool), point the prepare script at it:

```powershell
$env:CHROMIUM_SOURCE = "D:\TrafficDrive\resources\chromium"
npm run chromium:prepare
npm run build:win
```

### Cross-building Linux from Windows

`AppImage` needs symlink privileges and a Linux `mksquashfs`, so build Linux
installers on Linux or through GitHub Actions. If you only need a portable
archive from a Windows machine:

```bash
# build the unpacked Linux app (requires vendor/chromium with chrome-linux64)
npx electron-builder --linux dir --x64
npm run pack:linux:tar
```

`pack-linux-tar.js` writes a proper ustar archive and restores the Unix
executable bits that Windows loses, so `KG-TRF-Tool` and the bundled Chromium
stay runnable after extraction. This archive is not a substitute for the
CI-tested AppImage/deb release.

## Local data (not in git)

The product was renamed, but the profile folder is pinned to the old name so
upgrading does not look like a factory reset.

| Data | Windows | Linux | macOS |
|---|---|---|---|
| App window / settings | `%APPDATA%\trafficdrive` | `~/.config/trafficdrive` | `~/Library/Application Support/trafficdrive` |
| Proxies | `%LOCALAPPDATA%\NGF NOMI TOOLS\proxies.json` | `~/.config/trafficdrive/proxies.json` | `~/Library/Application Support/TrafficDrive/proxies.json` |
| Schedule | `...\NGF NOMI TOOLS\schedule.json` | `~/.config/trafficdrive/schedule.json` | `...\TrafficDrive\schedule.json` |
| Installed browsers | `...\NGF NOMI TOOLS\browsers\` | `~/.config/trafficdrive/browsers/` | `...\TrafficDrive\browsers/` |
| Settings / recordings | app window `localStorage` | app window `localStorage` | app window `localStorage` |

Back these up separately when moving to another computer. Never commit proxy
credentials or recordings.

## Project layout

| File | Purpose |
|---|---|
| `main.js` | Electron window + starts the backend (pins the old userData path) |
| `preload.js` | Safe bridge exposed to the UI |
| `index.html` | Dashboard (UI, modals, settings, persistence) |
| `server.js` | REST API for campaigns, RPA, proxies + dashboard static server |
| `platform.js` | Cross-platform data dirs + browser discovery |
| `browser-launcher.js` | Bundled/cached/system Chromium resolution |
| `SessionProfile.js` | UA → device/platform/CH, viewport + screen + DPR rules |
| `PrivacyGuard.js` | Context-level privacy/fingerprint engine (34 features) |
| `TrafficSource.js` | Referrer spoofing + bare-domain normalization |
| `Directtraffic.js` | Direct traffic campaign |
| `Organic Search.js` | Search-engine traffic |
| `SocialTraffic.js` | Referral / social traffic |
| `Google map traffic.js` | Google Maps traffic |
| `Automation controller.js`, `RpaRecorder.js` | RPA record/replay |
| `RandomClicker.js` | Random clicks, background tabs |
| `ProxiedSession.js`, `EgressGuard.js`, `ProxyBrowserCheck.js` | Proxy + IP verification |
| `PageGuard.js`, `PopupHandler.js` | Runtime guards |
| `i18n.js` | English/Urdu strings |
| `scripts/prepare-chromium.js` | Copies Chromium into `vendor/chromium` |
| `scripts/smoke-test.js` | Backend + browser + dashboard + settings smoke test |
| `scripts/privacy-test.js` | One-by-one privacy + device + ad-compat audit |
| `scripts/codespaces.sh` | One-command Codespaces / headless Linux runner |
| `electron-builder.yml` | Installer configuration |

## Hindi / Roman Urdu quick start

1. GitHub par naya **empty** repository banao.
2. Is folder me:
   ```bash
   git remote add origin https://github.com/<user>/<repo>.git
   git push -u origin main
   ```
3. GitHub → **Actions** → *Build installers* → **Run workflow**.
4. Windows ke liye `KG-TRF-Tool-Setup-5.9.2.exe`, Linux ke liye
   `KG-TRF-Tool-5.9.2-x86_64.AppImage` download karo.
5. Linux par: `chmod +x KG-TRF-Tool-*.AppImage` phir double-click / run.
6. Source se chalana ho to: `npm install` → `npx playwright install chromium`
   → `npm start`.
7. Linux Codespaces me chalane ke liye upar wala
   **"Run the Linux build in GitHub Codespaces"** section follow karo. Full app
   ke liye port **3000** kholo; campaign browser windows dekhne ke liye port
   **6080** + `/vnc.html`.
8. Settings (resolution, auto rotate, user agents) ek baar set karo — app band
   karke dobara kholne par wahi rahengi.

## License

MIT — see `LICENSE`.
