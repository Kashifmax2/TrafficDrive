// browser-launcher.js
// Minimal Playwright browser launcher used by all traffic modules.
//
// Exposes `launchBrowser(opts)` which returns a Playwright Browser instance.
// Supports an optional custom Chromium/Edge/Chrome executable path so users
// can target a specific browser binary; otherwise falls back to the bundled
// Playwright Chromium build.
//
// If the exact Chromium revision Playwright expects is missing (e.g. disk
// was too full to download it), we automatically scan the ms-playwright
// cache for any complete chromium-* build and use that instead. We also fall
// back to the system-installed Google Chrome / Microsoft Edge as a last
// resort so the app works even with zero Playwright browsers downloaded.

const { chromium } = require('playwright');
const platform = require('./platform.js');

// Cache the resolved fallback path so we only scan the filesystem once.
let _cachedFallbackPath = null;

/**
 * When running inside a packaged Electron app (built with electron-builder),
 * the bundled Chromium browser is shipped under `process.resourcesPath/chromium`.
 * On Windows that is chrome-win64/chrome.exe, on Linux chrome-linux/chrome and
 * on macOS Chromium.app/Contents/MacOS/Chromium. This avoids requiring the user
 * to download Playwright browsers separately.
 * Returns the path to the bundled browser, or null when not packaged / missing.
 */
function findBundledBrowser() {
  return platform.findBundledBrowser() || null;
}

/**
 * Scan the platform's ms-playwright cache for any complete chromium-* build
 * and return the path to its executable. Returns null if none found.
 */
function findCachedChromium() {
  if (_cachedFallbackPath !== null) return _cachedFallbackPath;
  _cachedFallbackPath = platform.findCachedBrowser() || null;
  return _cachedFallbackPath;
}

/**
 * Look for a system-installed Chrome / Chromium / Edge / Brave binary as a
 * last resort.
 */
function findSystemBrowser() {
  return platform.systemBrowserPaths()[0] || null;
}

/**
 * Launch a Chromium-based browser.
 *
 * @param {Object} opts
 * @param {boolean} [opts.headless=true]  - run headless or visible
 * @param {string} [opts.customBrowserPath] - path to a custom browser executable
 * @param {string[]} [opts.args] - extra Chromium launch args
 * @param {Function} [opts.onLog] - log callback (msg) => void
 * @param {string} [opts.sessionId] - label used in log messages
 * @returns {Promise<import('playwright').Browser>}
 */
async function launchBrowser(opts = {}) {
  const {
    headless = true,
    customBrowserPath,
    args = [],
    onLog = () => {},
    sessionId = 'Session',
  } = opts;

  const launchOptions = {
    headless: !!headless,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
      // Network-identity hardening: never send UDP/STUN or QUIC outside the
      // configured proxy, and don't resolve/prefetch hostnames locally.
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      '--enforce-webrtc-ip-permission-check',
      '--webrtc-ip-handling-policy=disable_non_proxied_udp',
      '--disable-quic',
      '--dns-prefetch-disable',
      // Background ad tabs must keep their own view timer running even though
      // they never take focus from the page being visited.
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-features=PreconnectToSearch,PreconnectToSearchWithDnsTxt',
      ...args,
    ],
  };

  // Priority 1: explicit custom browser path from the user.
  if (customBrowserPath && typeof customBrowserPath === 'string' && customBrowserPath.trim()) {
    launchOptions.executablePath = customBrowserPath.trim();
    onLog(`[${sessionId}] Using custom browser: ${customBrowserPath}`);
  }

  // Priority 1b: when running inside a packaged app, prefer the browser we
  // shipped alongside the app (extraResources) so no separate download is
  // required. This is skipped if the user explicitly set a custom path.
  if (!launchOptions.executablePath) {
    const bundled = findBundledBrowser();
    if (bundled) {
      launchOptions.executablePath = bundled;
      onLog(`[${sessionId}] Using bundled browser: ${bundled}`);
    }
  }

  let lastErr = null;
  try {
    const browser = await chromium.launch(launchOptions);
    return browser;
  } catch (err) {
    lastErr = err;
    onLog(`[${sessionId}] Primary browser launch failed: ${err.message}`);
  }

  // Priority 2: fall back to any complete cached Playwright Chromium build.
  if (launchOptions.executablePath) {
    delete launchOptions.executablePath;
  }
  const cached = findCachedChromium();
  if (cached) {
    onLog(`[${sessionId}] Falling back to cached Chromium build: ${cached}`);
    try {
      launchOptions.executablePath = cached;
      return await chromium.launch(launchOptions);
    } catch (err) {
      lastErr = err;
      onLog(`[${sessionId}] Cached Chromium failed: ${err.message}`);
      delete launchOptions.executablePath;
    }
  }

  // Priority 3: fall back to system Chrome / Edge.
  const sysBrowser = findSystemBrowser();
  if (sysBrowser) {
    onLog(`[${sessionId}] Falling back to system browser: ${sysBrowser}`);
    try {
      launchOptions.executablePath = sysBrowser;
      return await chromium.launch(launchOptions);
    } catch (err) {
      lastErr = err;
      onLog(`[${sessionId}] System browser failed: ${err.message}`);
    }
  }

  throw lastErr || new Error('No usable Chromium browser found');
}

module.exports = { launchBrowser, chromium, findBundledBrowser, findCachedChromium, findSystemBrowser };
