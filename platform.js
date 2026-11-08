// platform.js
// Cross-platform paths and browser discovery for Windows, Linux and macOS.
//
// Windows behaviour is kept byte-for-byte identical to the previous release:
//   data:  %LOCALAPPDATA%\NGF NOMI TOOLS
//   cache: %LOCALAPPDATA%\ms-playwright
//   exes:  chrome-win64\chrome.exe / chrome-win\chrome.exe
//
// Linux and macOS use their native locations so no feature depends on a
// Windows-only folder. The bundled Chromium shipped with the app always has
// priority over the Playwright cache and system browsers.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const IS_LINUX = process.platform === 'linux';

const APP_FOLDER = 'NGF NOMI TOOLS';

// --- Data directories ------------------------------------------------------

// Rendered dashboard/backend data (proxies.json, schedule.json, browsers/).
function appDataDir() {
  if (IS_WIN) {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, APP_FOLDER);
  }
  if (IS_MAC) {
    return path.join(os.homedir(), 'Library', 'Application Support', 'TrafficDrive');
  }
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'trafficdrive');
}

// Playwright's browser cache (npx playwright install chromium).
function playwrightCacheDir() {
  if (IS_WIN) {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'ms-playwright');
  }
  if (IS_MAC) {
    return path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
  }
  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return path.join(base, 'ms-playwright');
}

// --- Browser layouts -------------------------------------------------------

// Relative paths inside a Playwright chromium-<rev> folder, or inside the
// bundled `resources/chromium` folder.
function browserLayouts() {
  if (IS_WIN) {
    return [
      ['chrome-win64', 'chrome.exe'],
      ['chrome-win', 'chrome.exe'],
    ];
  }
  if (IS_MAC) {
    return [
      ['chrome-mac-x64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'],
      ['chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'],
      ['chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'],
    ];
  }
  return [
    ['chrome-linux64', 'chrome'],
    ['chrome-linux-arm64', 'chrome'],
    ['chrome-linux', 'chrome'],
  ];
}

function isExecutableFile(p) {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return false;
    if (!IS_WIN) {
      try { fs.accessSync(p, fs.constants.X_OK); } catch (_) { return false; }
    }
    return true;
  } catch (_) {
    return false;
  }
}

// A bundled browser must be a real build, not a tiny launcher stub.
function isValidBrowserBinary(exe) {
  try {
    const st = fs.statSync(exe);
    if (!st.isFile()) return false;
    if (IS_WIN) {
      // chrome.dll carries the actual browser code.
      return fs.existsSync(path.join(path.dirname(exe), 'chrome.dll'));
    }
    // Linux/macOS: the real binary is hundreds of MB; >1 MB filters stubs.
    return st.size > 1024 * 1024;
  } catch (_) {
    return false;
  }
}

// --- Bundled / cached Chromium --------------------------------------------

function bundledRoots() {
  const roots = [];
  try {
    if (process.resourcesPath) roots.push(path.join(process.resourcesPath, 'chromium'));
  } catch (_) {}
  if (process.env.TRAFFICDRIVE_CHROMIUM_DIR) {
    roots.push(path.resolve(process.env.TRAFFICDRIVE_CHROMIUM_DIR));
  }
  roots.push(path.join(__dirname, 'vendor', 'chromium'));
  roots.push(path.join(__dirname, 'bundled-chromium'));
  return roots;
}

function findBundledBrowser() {
  for (const root of bundledRoots()) {
    for (const rel of browserLayouts()) {
      const exe = path.join(root, ...rel);
      if (!isValidBrowserBinary(exe)) continue;
      return ensureRunnableBrowser(exe, rel);
    }
  }
  return '';
}

// Some distributions (e.g. an AppImage cross-built on Windows) can lose the
// Unix executable bit. Copy the browser once into the writable app-data folder
// and restore permissions instead of failing with EACCES at launch.
function ensureRunnableBrowser(exe, rel) {
  if (IS_WIN) return exe;
  try {
    if (isExecutableFile(exe)) return exe;
  } catch (_) {}

  try {
    const suffix = path.join(...rel);
    const root = exe.slice(0, exe.length - suffix.length).replace(/[\\/]$/, '');
    const destRoot = path.join(appDataDir(), 'browser-runtime', path.basename(root));
    const destExe = path.join(destRoot, ...rel);
    const marker = path.join(destRoot, '.trafficdrive-source');
    let sourceKey = '';
    try {
      const st = fs.statSync(exe);
      sourceKey = `${exe}|${st.size}|${st.mtimeMs}`;
    } catch (_) {}
    if (isValidBrowserBinary(destExe) && isExecutableFile(destExe)) {
      try { if (fs.readFileSync(marker, 'utf8') === sourceKey) return destExe; } catch (_) {}
    }

    fs.rmSync(destRoot, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(destRoot), { recursive: true });
    fs.cpSync(root, destRoot, { recursive: true });

    const makeExecutable = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) makeExecutable(p);
        else { try { fs.chmodSync(p, 0o755); } catch (_) {} }
      }
    };
    makeExecutable(destRoot);
    try { fs.writeFileSync(marker, sourceKey, 'utf8'); } catch (_) {}
    return isValidBrowserBinary(destExe) ? destExe : exe;
  } catch (_) {
    return exe;
  }
}

function findCachedBrowser() {
  const cacheDir = playwrightCacheDir();
  try {
    if (!fs.existsSync(cacheDir)) return '';
    const dirs = fs.readdirSync(cacheDir)
      .filter(d => /^chromium-\d+$/.test(d))
      .sort((a, b) => {
        // Prefer the highest revision number (most recent).
        return parseInt(b.replace('chromium-', ''), 10) - parseInt(a.replace('chromium-', ''), 10);
      });
    for (const d of dirs) {
      for (const rel of browserLayouts()) {
        const exe = path.join(cacheDir, d, ...rel);
        if (isValidBrowserBinary(exe)) return exe;
      }
    }
  } catch (_) {}
  return '';
}

// --- System-installed browsers --------------------------------------------

function findOnPath(names) {
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const found = [];
  for (const dir of dirs) {
    for (const name of names) {
      const p = path.join(dir, name);
      if (isExecutableFile(p) && !found.includes(p)) found.push(p);
    }
  }
  return found;
}

function winSystemPaths() {
  const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const localAppData = process.env['LOCALAPPDATA'] || path.join(os.homedir(), 'AppData', 'Local');
  return [
    path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(programFiles, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    path.join(programFilesX86, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    path.join(programFiles, 'Chromium', 'Application', 'chrome.exe'),
    path.join(localAppData, 'Chromium', 'Application', 'chrome.exe'),
  ];
}

function macApp(name, exe) {
  return `/Applications/${name}.app/Contents/MacOS/${exe}`;
}

// [browserId, [absolute paths and/or PATH names]]
function posixBrowserDefs() {
  const home = os.homedir();
  if (IS_MAC) {
    const userApps = path.join(home, 'Applications');
    return [
      ['chrome', [macApp('Google Chrome', 'Google Chrome'), path.join(userApps, 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome')]],
      ['chrome-beta', [macApp('Google Chrome Beta', 'Google Chrome Beta')]],
      ['chrome-dev', [macApp('Google Chrome Dev', 'Google Chrome Dev')]],
      ['chrome-canary', [macApp('Google Chrome Canary', 'Google Chrome Canary')]],
      ['chromium', [macApp('Chromium', 'Chromium')]],
      ['edge', [macApp('Microsoft Edge', 'Microsoft Edge')]],
      ['edge-beta', [macApp('Microsoft Edge Beta', 'Microsoft Edge Beta')]],
      ['edge-dev', [macApp('Microsoft Edge Dev', 'Microsoft Edge Dev')]],
      ['brave', [macApp('Brave Browser', 'Brave Browser')]],
      ['brave-beta', [macApp('Brave Browser Beta', 'Brave Browser Beta')]],
      ['brave-nightly', [macApp('Brave Browser Nightly', 'Brave Browser Nightly')]],
      ['vivaldi', [macApp('Vivaldi', 'Vivaldi')]],
      ['opera', [macApp('Opera', 'Opera')]],
      ['opera-gx', [macApp('Opera GX', 'Opera GX')]],
      ['firefox', [macApp('Firefox', 'firefox')]],
      ['firefox-dev', [macApp('Firefox Developer Edition', 'firefox')]],
      ['firefox-nightly', [macApp('Firefox Nightly', 'firefox')]],
      ['waterfox', [macApp('Waterfox', 'waterfox')]],
      ['librewolf', [macApp('LibreWolf', 'librewolf')]],
    ];
  }
  // Linux: absolute package locations first, then PATH lookup.
  return [
    ['chrome', ['/opt/google/chrome/chrome', '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', 'google-chrome-stable', 'google-chrome']],
    ['chrome-beta', ['/usr/bin/google-chrome-beta', 'google-chrome-beta']],
    ['chrome-dev', ['/usr/bin/google-chrome-unstable', 'google-chrome-unstable']],
    ['chrome-canary', ['/opt/google/chrome-canary/chrome', 'google-chrome-canary']],
    ['chromium', ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium', 'chromium', 'chromium-browser']],
    ['edge', ['/opt/microsoft/msedge/msedge', '/usr/bin/microsoft-edge-stable', '/usr/bin/microsoft-edge', 'microsoft-edge-stable', 'microsoft-edge']],
    ['edge-beta', ['/usr/bin/microsoft-edge-beta', 'microsoft-edge-beta']],
    ['edge-dev', ['/usr/bin/microsoft-edge-dev', 'microsoft-edge-dev']],
    ['brave', ['/opt/brave.com/brave/brave', '/usr/bin/brave-browser', '/snap/bin/brave', 'brave-browser', 'brave']],
    ['brave-beta', ['/usr/bin/brave-browser-beta', 'brave-browser-beta']],
    ['brave-nightly', ['/usr/bin/brave-browser-nightly', 'brave-browser-nightly']],
    ['vivaldi', ['/usr/bin/vivaldi-stable', '/usr/bin/vivaldi', 'vivaldi-stable', 'vivaldi']],
    ['opera', ['/usr/bin/opera', 'opera']],
    ['opera-gx', ['/usr/bin/opera-gx', 'opera-gx']],
    ['firefox', ['/usr/bin/firefox', '/snap/bin/firefox', 'firefox']],
    ['firefox-dev', ['/usr/bin/firefox-developer-edition', 'firefox-developer-edition']],
    ['firefox-nightly', ['/usr/bin/firefox-nightly', 'firefox-nightly']],
    ['waterfox', ['/usr/bin/waterfox', '/opt/waterfox/waterfox', 'waterfox']],
    ['librewolf', ['/usr/bin/librewolf', '/opt/librewolf/librewolf', 'librewolf']],
    ['thorium', ['/usr/bin/thorium', '/opt/thorium/thorium', 'thorium']],
  ];
}

// Detected system browsers as [{ id, path }] for /api/browsers/detect.
function detectPosixBrowsers() {
  if (IS_WIN) return [];
  const detected = [];
  for (const [id, list] of posixBrowserDefs()) {
    for (const item of list) {
      const candidates = item.startsWith('/') ? [item] : findOnPath([item]);
      const hit = candidates.find(isExecutableFile);
      if (hit) {
        detected.push({ id, path: hit });
        break;
      }
    }
  }
  return detected;
}

// Ordered flat list of usable system browsers for the launcher fallback.
function systemBrowserPaths() {
  const out = [];
  const push = (p) => { if (p && isExecutableFile(p) && !out.includes(p)) out.push(p); };
  if (IS_WIN) {
    winSystemPaths().forEach(push);
    return out;
  }
  for (const [, list] of posixBrowserDefs()) {
    for (const item of list) {
      if (item.startsWith('/')) push(item);
      else findOnPath([item]).forEach(push);
    }
  }
  return out;
}

module.exports = {
  IS_WIN,
  IS_MAC,
  IS_LINUX,
  appDataDir,
  playwrightCacheDir,
  browserLayouts,
  isValidBrowserBinary,
  findBundledBrowser,
  findCachedBrowser,
  findOnPath,
  detectPosixBrowsers,
  systemBrowserPaths,
};
