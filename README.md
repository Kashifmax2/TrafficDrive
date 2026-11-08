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

## What's new in 5.9.1

**Mobile traffic is now classified as Mobile** (this was the "Mobile 0" bug on
ad networks).

Playwright derives `Sec-CH-UA-Mobile` from the context's `isMobile` flag, not
from the User-Agent. The old code always launched phone/tablet sessions with
`isMobile:false`, so Android phones were reported as **Tablet** and iPhones as
**Desktop**:

| Hit | Old report | 5.9.1 report |
|---|---|---|
| Android phone UA | Tablet `?0` | **Mobile `?1`** |
| iPhone UA | Desktop `?0` | **Mobile `?1`** |
| iPad / Android tablet UA | Tablet `?1` | **Tablet `?0`** |

- Phones now use `isMobile:true`; tablets use `hasTouch:true` with
  `isMobile:false`, which is exactly what real phones/tablets send.
- The user agent now decides the emulation. If the Device Setting and the chosen
  UA disagree, the UA wins and a `WARN` explains it in the log.
- Touch sessions get a physical `screen` and a realistic DPR (3 for phones,
  2 for tablets), so `window.screen` / `devicePixelRatio` match the device.
- The same rules apply to Direct, Organic, Referral, Google Maps and RPA replay.

**Every Privacy option was audited and fixed** (34 toggles):

- Privacy is installed at **browser-context** level, so ad popups and background
  tabs are protected too, not just the first page.
- Spoofed values are derived from the session UA/device instead of a hardcoded
  Windows desktop (a mobile session no longer reports `Win32` / 1920x1080).
- Fixed: DNS prefetch removal, Referer Control (real navigation + subresources
  are sent with no Referer; `document.referrer` is blank), Cookie Sanitization
  (blocks writes and deletes existing `_ga`/`_fbp`/... cookies), ETag clearing,
  WebGL, Canvas, Audio, Font, ClientRects, WebRTC, sensors and fake device APIs.
- If a Traffic Source referrer is configured it wins over Referer Control (with
  a warning), so marketing attribution is not silently lost.

Run the automated audit on any OS:

```bash
npm run test:privacy          # Windows/macOS
xvfb-run -a npm run test:privacy   # headless Linux
```

It checks every feature against real browser APIs and real request headers, then
the Traffic Source referral interaction and the UA → emulation → `Sec-CH-UA`
matrix (Windows, Android phone/tablet, iPhone, iPad). Expected output:
`42 passed, 0 failed` → `ALL CHECKS PASSED`.

## Features that stay identical on every OS

- Random clicks open links in **background tabs** (no focus stealing)
- RPA replay, campaigns, dwell and tab lifetime behave the same
- Proxy sessions are **fail-closed** (no silent direct-IP fallback)
- Privacy / popup / captcha guards, schedules and proxy persistence
- Bundled Chromium, so campaigns work offline after install

## Download & install

### Windows

1. Download **`TrafficDrive-Setup-5.9.1.exe`** (installer) or
   **`TrafficDrive-Portable-5.9.1.exe`** (no installation).
2. Run it. Because the build is not code-signed, SmartScreen may show
   "Windows protected your PC" → **More info → Run anyway**.
3. The app opens directly. No Node.js, no Playwright download required.

If you use the portable EXE, the browser is extracted to a temp folder on
every launch (15–30 seconds the first time).

### Linux (AppImage — recommended)

```bash
chmod +x TrafficDrive-5.9.1-x86_64.AppImage
./TrafficDrive-5.9.1-x86_64.AppImage
```

- Ubuntu 22.04+ needs FUSE 2 for AppImage:
  `sudo apt install libfuse2`
- If your desktop blocks AppImage, extract and run:
  `./TrafficDrive-5.9.1-x86_64.AppImage --appimage-extract` then
  `./squashfs-root/TrafficDrive`
- The app starts with `--no-sandbox` on Linux only, because Ubuntu 24.04+
  restricts unprivileged user namespaces. This does not change campaign
  behaviour.

### Linux (deb)

```bash
sudo apt install ./TrafficDrive-5.9.1-amd64.deb
trafficdrive
```

Or install from your file manager. All Chromium/Playwright libraries are
declared as dependencies.

### Linux portable archive (fallback)

If AppImage/deb cannot be used, extract the portable archive and run it:

```bash
tar -xzf TrafficDrive-5.9.1-linux-x64-portable.tar.gz
./TrafficDrive-5.9.1-linux-x64/TrafficDrive
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
   `5.9.1` AppImage, and launches TrafficDrive.
3. Open the **Ports** tab → port **6080** → add `/vnc.html`:

   ```
   https://<your-codespace>-6080.app.github.dev/vnc.html
   ```

   That is the desktop. Campaign browser windows appear there.
4. The dashboard listens on `http://127.0.0.1:3000` (port **3000** is already
   forwarded if you prefer opening it directly).
5. Press `Ctrl+C` to stop the app. The desktop and viewer keep running, so
   `bash scripts/codespaces.sh` starts the app again instantly.

The script also works on any headless Ubuntu/Debian machine (VPS, container).
Set `TD_VERSION=5.9.1` to pick a different release.

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

chmod +x TrafficDrive-5.9.1-x86_64.AppImage
./TrafficDrive-5.9.1-x86_64.AppImage --appimage-extract
./squashfs-root/TrafficDrive --no-sandbox
```

On Ubuntu 22.04 use `libasound2` instead of `libasound2t64`. If FUSE is
unavailable in the container, always use the `--appimage-extract` route above,
or the portable tar:

```bash
tar -xzf TrafficDrive-5.9.1-linux-x64-portable.tar.gz
./TrafficDrive-5.9.1-linux-x64/TrafficDrive --no-sandbox
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
   - `TrafficDrive-windows` → installer + portable EXE
   - `TrafficDrive-linux` → `.AppImage` + `.deb`

The Linux job runs a real smoke test first (`xvfb-run`) that starts the
backend, launches the bundled Chromium, renders a page, and checks
`/api/health` and `/api/browsers/detect`. Both jobs then run the full privacy +
device audit (`npm run test:privacy`) before building, so a broken toggle fails
the build instead of shipping.

Pushing a tag (`git tag v5.9.1 && git push origin v5.9.1`) also publishes a
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
installers on Linux or through GitHub Actions. If you only need a portable
archive from a Windows machine:

```bash
# build the unpacked Linux app (requires vendor/chromium with chrome-linux64)
npx electron-builder --linux dir --x64
npm run pack:linux:tar
```

`pack-linux-tar.js` writes a proper ustar archive and restores the Unix
executable bits that Windows loses, so `TrafficDrive` and the bundled Chromium
stay runnable after extraction. This archive is not a substitute for the
CI-tested AppImage/deb release.

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
| `SessionProfile.js` | UA → device/platform/CH, viewport + screen + DPR rules |
| `PrivacyGuard.js` | Context-level privacy/fingerprint engine (34 features) |
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
| `scripts/smoke-test.js` | Backend + browser + detection smoke test |
| `scripts/privacy-test.js` | One-by-one privacy + device matrix test |
| `electron-builder.yml` | Installer configuration |

## Hindi / Roman Urdu quick start

1. GitHub par naya **empty** repository banao.
2. Is folder me:
   ```bash
   git remote add origin https://github.com/<user>/<repo>.git
   git push -u origin main
   ```
3. GitHub → **Actions** → *Build installers* → **Run workflow**.
4. Windows ke liye `TrafficDrive-Setup-5.9.1.exe`, Linux ke liye
   `TrafficDrive-5.9.1-x86_64.AppImage` download karo.
5. Linux par: `chmod +x TrafficDrive-*.AppImage` phir double-click / run.
6. Source se chalana ho to: `npm install` → `npx playwright install chromium`
   → `npm start`.
7. Linux Codespaces me chalane ke liye upar wala
   **"Run the Linux build in GitHub Codespaces"** section follow karo
   (`Xvfb` + `x11vnc` + noVNC port `6080`, phir `--no-sandbox`).

## License

MIT — see `LICENSE`.
