# KG TRF Tool

Desktop traffic-automation app built with **Electron + Node.js + Playwright**.

- Product name: **KG TRF Tool** (version **5.9.7**)
- Dashboard UI: plain HTML/CSS/JS (`index.html`, `i18n.js`)
- Local REST backend: `server.js` on `http://127.0.0.1:3000`
- Automation: Playwright 1.63 driving Chromium
- Modules: Direct, Organic, Referral, Google Maps, RPA record/replay, Random Clicks
- Platforms: **Windows 10/11**, **Linux x64** (AppImage / deb), macOS

> Source-only repository. `node_modules`, the Electron runtime, the bundled
> Chromium browser and the packaged `app.asar` are **not** committed. They are
> installed or downloaded by the build steps below.

## What's new in 5.9.7

### Session Diagnostics — catch a broken profile before a campaign runs

A new **Session Diagnostics** card on the Privacy page adds two read-only
preflight checks. Neither one clicks, starts traffic, edits settings or writes
anything to disk.

- **Fingerprint audit** (`POST /api/diagnostics/fingerprint`) opens **one**
  short-lived headless Chromium, loads a local loopback probe page and compares
  what a tracked site actually sees: `navigator.webdriver`, UA vs
  `navigator.platform`, Client Hints (`mobile` / `platform`), touch points,
  viewport/DPR, screen size, timezone, language, canvas determinism, WebGL
  renderer, `hardwareConcurrency` / `deviceMemory`, plugin list and
  `window.chrome`. Each item is `pass` / `warn` / `fail` with a concrete hint.
  A score is shown and failures are listed first.
- **Canvas noise must be deterministic**: two independent draws are hashed.
  Random noise is reported as a hard failure because it breaks logins and
  CAPTCHAs on real sites.
- **Proxy / timezone consistency**: when a target timezone is supplied the audit
  verifies that the context really reports it (timezone aliases such as
  `Asia/Calcutta` and `Asia/Kolkata` are treated as equal).
- **System preflight** (`GET /api/system/check`) reports CPU model, cores, RAM,
  free disk space, data-folder write access, bundled-browser health, app
  version, running campaigns and a conservative **recommended thread limit**
  (`min(20, RAM GB / 1.5, cores × 2)`). The Traffic Settings page shows a hint
  when the chosen thread count is above the safe value for this PC.
- The audit runs only when the **Run audit** button is pressed (or the endpoint
  is called). Nothing runs in the background during a campaign.

### Safety

- The audit reuses the app's own `SessionProfile` / `PrivacyGuard` helpers, so
  it measures exactly the profile a real session would use.
- One audit at a time (`_running` guard), 5–25 s timeouts, context and browser
  always closed, loopback probe server stopped in `finally`.
- `npm run test:system` adds **82 checks** (system values, check-rule matrix,
  viewport normalisation, three live audits and both HTTP endpoints). CI runs
  it on Windows and Linux.

## What's new in 5.9.6

### Only click ads — live popunder / social-bar fix

On real sponsored pages (e.g. `https://webadsforadsads.vercel.app/`) 5.9.5
found the ads but the click still ended in an empty `page/#` tab instead of the
advertiser. Two separate causes were found and fixed:

- **Full-page click layer (popunder)**: ad networks stretch one invisible
  third-party `<a>` over the whole viewport. Because it covered every slot, the
  "is the creative on top?" check rejected all of them and no click was sent.
  The layer is now recognised as an ad in its own right, and clicking a covered
  slot is accepted when the click point resolves to that layer.
- **`href="#"` social-bar links**: the background-tab shield used to intercept
  fragment / `javascript:` / same-document links, cancel the site's own click
  handler and open a bare `page/#`. Those links are left alone now, so the
  site's `window.open(...)` runs and the shield captures the real offer URL
  instead. Any same-document link that still reaches the queue is dropped
  before a tab is opened.

Verified on the live site: 6 clicks → 6 ad clicks → 5 real ad tabs, zero `#`
tabs. `npm run test:ads` grew from 36 to **45 checks** with two new fixtures
(a popunder page whose click layer covers a banner slot, and a social-bar
iframe whose `href="#"` anchor calls `window.open`), asserting that the real
destination opens and that no `#` URL is ever used.

## What's new in 5.9.5

### Only click ads — real-world coverage fix

5.9.3 introduced ad-only clicking, but on many sponsored pages it found **no**
ad at all: the sidebar / right-side top banners, the mid-page sponsored cards
and the native image widgets were skipped. The scanner now recognises every
shape those pages use.

- **Label cards without a link**: a card whose only marking is a
  `SPONSORED` / `ADVERTISEMENT` badge is clicked even when the offer is a
  `div` with a React `onClick`, a `role="link"`, `cursor:pointer`, or no
  handler at all. The scanner climbs up to 7 ancestors to find the offer, so
  cards padded with filler nodes are found too.
- **Fixed / sticky corner banners** ("The Best Times to Quit Your Job" style)
  are detected by position and creative size, without needing an ad class.
- **Native image widgets**: creative-sized image tiles that link out are
  clicked even when the widget has no ad class or label.
- **camelCase ad classes** such as `adCard`, `sponsorBox`, `nativeAdUnit` are
  now matched, together with more `data-ad*` / `aria-label` / `data-testid`
  markers.
- **Unmarked ad iframes**: a third-party iframe at least 150×80 that is not a
  known embed is treated as a creative, and common banner sizes
  (300×250, 728×90, 160×600, …) are accepted from any host.
- **Open shadow roots**: ad widgets built as web components are scanned, and
  the click point is resolved through `host >>> inner` selectors.
- **Non-ads stay untouched**: header / navigation, article links, cookie and
  consent bars, chat, maps, video, captcha, payment, translate and comment
  embeds are explicitly excluded (the embed blocklist was expanded with
  giscus, JW Player, Wistia, Brightcove, Google Translate and more).

### Regression coverage

- `npm run test:ads` grew from 24 to **36 checks** with a new fixture that
  reproduces these shapes: JS-only card, handler-less label card, filler-heavy
  card, native ADVERTISEMENT widget, fixed corner banner, unmarked 300×250
  iframe — plus assertions that the sticky header, the article card and the
  cookie bar are never clicked.

## What's new in 5.9.4

### Fresh start — no demo campaigns

- The Campaigns page no longer ships sample campaigns or fake totals. A new
  install opens with **0 campaigns, 0 active, 0 sessions, 0 visits** and a
  clear "No campaigns yet" empty state.
- Existing installs automatically drop the three demo cards that older builds
  saved (`Ecommerce Store Boost`, `Local Restaurant Maps`,
  `Blog Referral Drive`) the first time campaigns load. Real user campaigns
  are preserved.
- Dashboard live logs start empty instead of showing a fake
  "25 proxies loaded successfully" session.
- Campaign stat cards are computed from the campaigns actually present, so
  they start at zero and update after save / delete.
- Windows data folder moved from `%LOCALAPPDATA%\NGF NOMI TOOLS` to
  `%LOCALAPPDATA%\KG TRF Tool`. Existing proxies, schedules and installed
  browsers are migrated automatically on first launch (rename, with a copy
  fallback if the old folder is locked).

### Regression coverage

- `npm run smoke` now asserts that a fresh install has no demo campaigns,
  that old demo rows are cleaned while real campaigns survive, and that the
  empty state returns after deleting everything.

## What's new in 5.9.3

### Only click ads (recommended)

**Random Clicks → Only click ads** stops clicking random page points and clicks
only ad slots that a real visitor can actually see and use. It applies
everywhere the click engine runs: **Direct / website URL, Organic, Referral,
Google Maps and the RPA replay**.

- Visible display iframes from the major networks (Adsterra, Monetag, PopAds,
  PropellerAds, Google/GPT, MGID, Taboola, Outbrain, ...).
- Native **SPONSORED** / **Advertisement** cards that wrap a real link.
- `adsbygoogle` and `div-gpt-ad` units.

Hidden, transparent, blank/unfilled, 1×1 tracking slots and ordinary page
blocks are never clicked, and no click is ever sent to empty page space. An ad
below the fold is scrolled into view first. Elements are addressed by a stable
CSS path, so nothing is injected into the page — a site cannot detect the
clicker by diffing its DOM.

Each ad click is humanised: scroll into view, two-step mouse approach with a
short hover, random press delay, ~10% natural skip and a 45-second per-slot
memory. Afterwards the mouse moves away and the offer opens in a **background
tab**, so the visited page stays in front. If a page shows no working ad, the
clicker waits and sends no click at all (visible in the log as
`Ad-only: no visible working ad`).

The modal shows an `ADS` badge while the option is active, and the setting is
saved with every other setting, so it survives close / reopen.

### Dashboard polish

Sidebar active states, cards, stat cards, mode list, buttons, focus rings and
the action bar received a cleaner professional pass.

### Verification

- **`npm run test:ads` (new)** — 24 checks in a real Chromium: ad discovery
  (iframe / sponsored card / adsbygoogle / below-the-fold), rejection of
  hidden, transparent, blank and 1×1 slots, click destinations, background
  tabs, ad-free pages and classic random clicking.
- `npm run test:privacy` — 46 checks; `npm run smoke` — all pass.

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

npm run test:ads              # only-ads clicking, real Chromium
xvfb-run -a npm run test:ads       # headless Linux

npm run smoke                 # backend + browser + dashboard + settings
```

The privacy audit checks every toggle against real browser APIs and real request
headers, then the Traffic Source referral interaction and the UA → emulation →
`Sec-CH-UA` matrix (Windows, Android phone/tablet, iPhone, iPad). 5.9.2 also
adds static regressions that fail the build if Referer Control starts injecting
`Referer` / `Referrer-Policy` again, or if a bare-domain referrer is rejected.
Expected output: **46 passed, 0 failed** → `ALL CHECKS PASSED`.

The ad test serves a fixture page with a working display ad, an `adsbygoogle`
unit, a native sponsored card and an ad below the fold, next to a hidden ad, a
1×1 tracker, a blank slot, a hero banner, plus hidden and transparent cards. It
asserts that only the real ad slots are found and clicked, that every opened
destination is an ad, that an ad-free page receives zero clicks, and that
classic random clicking still works when the option is off. Expected output:
**24 passed, 0 failed**.

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

1. Download **`KG-TRF-Tool-Setup-5.9.7.exe`** (installer) or
   **`KG-TRF-Tool-Portable-5.9.7.exe`** (no installation).
2. Run it. Because the build is not code-signed, SmartScreen may show
   "Windows protected your PC" → **More info → Run anyway**.
3. The app opens directly. No Node.js, no Playwright download required.

If you use the portable EXE, the browser is extracted to a temp folder on
every launch (15–30 seconds the first time).

### Linux (AppImage — recommended)

```bash
chmod +x KG-TRF-Tool-5.9.7-x86_64.AppImage
./KG-TRF-Tool-5.9.7-x86_64.AppImage
```

- Ubuntu 22.04+ needs FUSE 2 for AppImage:
  `sudo apt install libfuse2`
- If your desktop blocks AppImage, extract and run:
  `./KG-TRF-Tool-5.9.7-x86_64.AppImage --appimage-extract` then
  `./squashfs-root/AppRun` (or `./squashfs-root/KG-TRF-Tool`)
- The app starts with `--no-sandbox` on Linux only, because Ubuntu 24.04+
  restricts unprivileged user namespaces. This does not change campaign
  behaviour.

### Linux (deb)

```bash
sudo apt install ./KG-TRF-Tool-5.9.7-amd64.deb
kg-trf-tool
```

Or install from your file manager. All Chromium/Playwright libraries are
declared as dependencies.

### Linux portable archive (fallback)

If AppImage/deb cannot be used, extract the portable archive and run it:

```bash
tar -xzf KG-TRF-Tool-5.9.7-linux-x64-portable.tar.gz
./KG-TRF-Tool-5.9.7-linux-x64/KG-TRF-Tool
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
   `5.9.7` AppImage, and launches KG TRF Tool.
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
Set `TD_VERSION=5.9.7` to pick a different release.

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

chmod +x KG-TRF-Tool-5.9.7-x86_64.AppImage
./KG-TRF-Tool-5.9.7-x86_64.AppImage --appimage-extract
./squashfs-root/AppRun --no-sandbox
```

On Ubuntu 22.04 use `libasound2` instead of `libasound2t64`. If FUSE is
unavailable in the container, always use the `--appimage-extract` route above,
or the portable tar:

```bash
tar -xzf KG-TRF-Tool-5.9.7-linux-x64-portable.tar.gz
./KG-TRF-Tool-5.9.7-linux-x64/KG-TRF-Tool --no-sandbox
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
and the only-ads regression test (`npm run test:ads`) before building, so a
broken toggle or a broken ad click fails the build instead of shipping.

Pushing a tag (`git tag v5.9.7 && git push origin v5.9.7`) also publishes a
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

The product was renamed. Windows data now lives in
`%LOCALAPPDATA%\KG TRF Tool`. On first launch the old
`%LOCALAPPDATA%\NGF NOMI TOOLS` folder is migrated automatically (rename with a
copy fallback), so proxies, schedules and browsers survive the upgrade.

| Data | Windows | Linux | macOS |
|---|---|---|---|
| App window / settings | `%APPDATA%\trafficdrive` | `~/.config/trafficdrive` | `~/Library/Application Support/trafficdrive` |
| Proxies | `%LOCALAPPDATA%\KG TRF Tool\proxies.json` | `~/.config/trafficdrive/proxies.json` | `~/Library/Application Support/TrafficDrive/proxies.json` |
| Schedule | `...\KG TRF Tool\schedule.json` | `~/.config/trafficdrive/schedule.json` | `...\TrafficDrive\schedule.json` |
| Installed browsers | `...\KG TRF Tool\browsers\` | `~/.config/trafficdrive/browsers/` | `...\TrafficDrive\browsers/` |
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
| `RandomClicker.js` | Random clicks / only-ads clicking, background tabs |
| `ProxiedSession.js`, `EgressGuard.js`, `ProxyBrowserCheck.js` | Proxy + IP verification |
| `PageGuard.js`, `PopupHandler.js` | Runtime guards |
| `i18n.js` | English/Urdu strings |
| `scripts/prepare-chromium.js` | Copies Chromium into `vendor/chromium` |
| `scripts/smoke-test.js` | Backend + browser + dashboard + settings smoke test |
| `scripts/privacy-test.js` | One-by-one privacy + device + ad-compat audit |
| `scripts/adclick-test.js` | Only-ads discovery + click regression test |
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
4. Windows ke liye `KG-TRF-Tool-Setup-5.9.7.exe`, Linux ke liye
   `KG-TRF-Tool-5.9.7-x86_64.AppImage` download karo.
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
