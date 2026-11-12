// server.js
// KG TRF Tool backend server — wires the 4 traffic modules to the dashboard's
// REST API on http://localhost:3000.
//
// Endpoints (all match what index.html calls):
//   POST /api/organic/start    → Organic Search.js   (startOrganicSearch)
//   POST /api/direct/start     → Directtraffic.js    (startDirectTraffic)
//   POST /api/referral/start   → SocialTraffic.js    (startSocialTraffic)
//   POST /api/gmaps/start      → Google map traffic.js (startGoogleMapsTraffic)
//   POST /api/stop/:id         → stop a specific campaign
//   POST /api/stop-all         → stop all campaigns
//   POST /api/pause/:id        → pause a campaign
//   POST /api/resume/:id       → resume a campaign
//   GET  /api/logs/:id         → poll logs for a campaign
//   GET  /api/proxies          → return loaded proxies
//   POST /api/proxies/load     → store proxies
//   POST /api/proxies/validate → validate proxies
//   POST /api/autorestart/enable  → enable auto-restart
//   POST /api/autorestart/disable → disable auto-restart
//   GET  /api/browsers/detect  → detect installed browsers
//   GET  /api/system/check     → CPU/RAM/disk + recommended thread limit
//   POST /api/diagnostics/fingerprint → read-only fingerprint consistency audit
//   GET  /api/health           → health check

const http = require('http');
const https = require('https');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const socks = require('socks'); // SOCKS4/5 proxy support
const extractZip = require('extract-zip'); // Browser zip extraction
const platform = require('./platform.js'); // Cross-platform paths / browsers
const {
  resolveSessionDevice,
  uaPlatform,
  uaChPlatform,
  uaBrands,
  physicalScreen,
} = require('./SessionProfile.js');
const { installPrivacyGuard, privacyContextOptions } = require('./PrivacyGuard.js');
const {
  configureProxyUsage,
  dedupeProxyPool,
  buildRotationPool,
  acquireRotationProxy,
  getProxyUsageSnapshot,
  markProxyFailure,
  markProxySuccess,
} = require('./ProxyRotation.js');

// --- Traffic modules -------------------------------------------------------
// Lazy-loaded to avoid blocking startup
let directTraffic = null;
let organicSearch = null;
let googleMapsTraffic = null;
let socialTraffic = null;

function getDirectTraffic() {
  if (!directTraffic) directTraffic = require('./Directtraffic.js');
  return directTraffic;
}

function getOrganicSearch() {
  if (!organicSearch) organicSearch = require('./Organic Search.js');
  return organicSearch;
}

function getGoogleMapsTraffic() {
  if (!googleMapsTraffic) googleMapsTraffic = require('./Google map traffic.js');
  return googleMapsTraffic;
}

function getSocialTraffic() {
  if (!socialTraffic) socialTraffic = require('./SocialTraffic.js');
  return socialTraffic;
}

// --- State -----------------------------------------------------------------
// processId → { emitter, logs: [], status, type, config }
const processes = new Map();
let nextProcessId = 1;

// Proxy store. Loaded from disk on boot so the list survives app restarts.
const PROXY_STORE_FILE = path.join(platform.appDataDir(), 'proxies.json');
let loadedProxies = [];

// Background validation jobs (jobId -> { total, queue, done }) so the UI can
// stream results instead of waiting for thousands of proxies.
const validationJobs = new Map();

function loadProxiesFromDisk() {
  try {
    if (!fs.existsSync(PROXY_STORE_FILE)) return;
    const data = JSON.parse(fs.readFileSync(PROXY_STORE_FILE, 'utf8'));
    const list = Array.isArray(data) ? data : data.proxies;
    if (Array.isArray(list)) {
      // Drop junk that older versions may have stored (headers like
      // "Free proxies from ..." or "Updated at ..." parsed as host names).
      loadedProxies = list
        .filter((p) => p && p.host && p.port && !/\s/.test(String(p.host)))
        .map((p) => ({
          ...p,
          type: String(p.type || 'http').toLowerCase(),
          port: parseInt(p.port, 10) || p.port,
        }));
    }
  } catch (e) {
    console.error('[KG TRF Tool] Could not load saved proxies:', e.message);
  }
}

function saveProxiesToDisk() {
  try {
    fs.mkdirSync(path.dirname(PROXY_STORE_FILE), { recursive: true });
    fs.writeFileSync(PROXY_STORE_FILE, JSON.stringify({ proxies: loadedProxies }, null, 2), 'utf8');
  } catch (e) {
    console.error('[KG TRF Tool] Could not save proxies:', e.message);
  }
}

// Snapshot the proxy file before a destructive operation (clear / remove-all)
// so a bad validation run can never silently destroy the user's pool.
function backupProxiesToDisk() {
  try {
    if (!fs.existsSync(PROXY_STORE_FILE)) return;
    const backup = PROXY_STORE_FILE.replace(/\.json$/i, '.backup.json');
    fs.copyFileSync(PROXY_STORE_FILE, backup);
  } catch (_) {}
}

function proxyStoreKey(p) {
  return (String((p && p.type) || 'http').toLowerCase()) + ':' + (p && p.host) + ':' + (p && p.port);
}

// Persist the outcome of the last real-browser validation on each proxy so the
// traffic modules can send only proxies that actually work - and so the result
// survives an app restart.
let proxySaveTimer = null;
function scheduleProxiesSave() {
  if (proxySaveTimer) return;
  proxySaveTimer = setTimeout(() => {
    proxySaveTimer = null;
    saveProxiesToDisk();
  }, 1500);
}

function recordProxyResult(key, r, targetUrl, opts = {}) {
  const entry = loadedProxies.find((p) => proxyStoreKey(p) === key);
  if (!entry) return;
  const ok = !!(r && r.ok);
  // A proxy can tunnel traffic perfectly and still be refused by one ad /
  // campaign target ("Anonymous Proxy detected", 403, 5xx). That is a target
  // result, not a dead proxy - marking the tunnel dead would shrink the
  // rotation pool to nothing over a few runs.
  const tunnelOk = typeof opts.tunnelOk === 'boolean' ? opts.tunnelOk : ok;
  entry.status = tunnelOk ? 'ok' : 'dead';
  entry.reason = (r && r.reason) || (ok ? 'ok' : 'failed');
  entry.ms = r && typeof r.ms === 'number' ? r.ms : 0;
  if (r && r.egressIp) entry.egressIp = r.egressIp;
  if (r && typeof r.localIpMatched === 'boolean') entry.localIpMatched = r.localIpMatched;
  if (r && r.country) entry.country = r.country;
  if (r && r.countryCode) entry.countryCode = r.countryCode;
  if (r && r.timezone) entry.timezone = r.timezone;
  entry.validatedAt = Date.now();
  // Target-specific result: only a real-browser check against the actual ad /
  // campaign URL can say whether the network accepts this IP.
  if (targetUrl) {
    entry.targetUrl = targetUrl;
    entry.targetCheckedAt = Date.now();
    entry.targetOk = ok;
    entry.targetReason = entry.reason;
  }
  scheduleProxiesSave();
}

loadProxiesFromDisk();

// Persistent IP-usage ledger (5.9.8). It survives restarts so the same exit IP
// is never quietly reused dozens of times in one 12 h window.
const PROXY_USAGE_FILE = path.join(platform.appDataDir(), 'proxy-usage.json');
configureProxyUsage({ file: PROXY_USAGE_FILE });

let autoRestartEnabled = false;

// Prevent unhandled rejections/exceptions from crashing the server
process.on('unhandledRejection', (reason) => {
  console.error('[KG TRF Tool] Unhandled rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[KG TRF Tool] Uncaught exception:', err.message);
});

// RPA state — holds the recording browser/context/page and actions.
// Actions are appended in Node (via a context binding), not read from the page
// afterwards, so they survive navigation, reloads and tab switches.
const rpaState = {
  browser: null,
  context: null,
  page: null,
  pages: [],
  actions: [],
  recording: false,
  startedAt: 0,
  focusTracker: null,
  // Network identity of the recording browser (shown in the UI and saved
  // with the recording so Play can reuse the same proxy).
  proxy: null,
  proxyLabel: '',
  proxyEgress: '',
  proxyVerified: false,
};

// RPA replay state — replay runs in the background (loop aware) so a long
// recording never blocks the HTTP request. The UI polls /api/rpa/status.
const RpaProxyHandler = require('./Proxyhandler.js');
const rpaPh = new RpaProxyHandler();
const { createProxiedSession, proxyLabel: proxiedLabel, proxyKey: proxiedKey, isProxyFailure } = require('./ProxiedSession.js');
const rpaPlayState = {
  running: false,
  stopRequested: false,
  sessions: 1,
  loop: 1,
  iteration: 0,
  round: 0,
  totalRounds: 0,
  totalActions: 0,
  actionsDone: 0,
  actionsCompleted: 0,
  startedAt: 0,
  finishedAt: 0,
  lastError: '',
  randomClicks: 0,
  randomScrolls: 0,
  // Multiple parallel sessions can run at once, so every browser is tracked.
  browsers: new Set(),
  sessionStats: [],
  logs: [],
  // Proxy / network identity shown by the live replay monitor.
  proxyMode: 'none',
  proxyLabel: '',
  proxyTarget: '',
  proxyPoolSize: 0,
  proxyVerifiedPoolSize: 0,
  proxyRawPoolSize: 0,
  proxyUniqueIps: [],
  proxyUsage: null,
  proxyVerified: false,
  proxyEgress: '',
  proxySwitches: 0,
  proxyRetries: 0,
  proxyPoolRef: null,
  currentAction: '',
  currentTab: '',
  currentUrl: '',
};

// Per-session replay result rows shown by the RPA UI.
function rpaSessionRow(id) {
  return {
    id,
    iteration: 0,
    completed: 0,
    failed: 0,
    running: true,
    clicks: 0,
    scrolls: 0,
    actionsDone: 0,
    actionsTotal: 0,
    currentAction: '',
    currentTab: '',
    proxyLabel: '',
    proxyEgress: '',
    proxyCountry: '',
    proxyVerified: false,
    proxySwitches: 0,
    retries: 0,
    lastError: '',
  };
}

// Find the URL a recording actually visits, used for target-specific proxy
// validation. Falls back to the first recorded URL, then Google.
function rpaTargetUrl(actions) {
  const nav = (actions || []).find(a => a && a.type === 'navigate' && a.url);
  const any = nav || (actions || []).find(a => a && a.url);
  const url = any && any.url ? String(any.url) : 'https://www.google.com';
  return /^https?:\/\//i.test(url) ? url : 'https://www.google.com';
}

function rpaProxyRecord(p) {
  if (!p || !p.host || !p.port) return null;
  return {
    type: (p.type || 'http').toLowerCase(),
    host: p.host,
    port: p.port,
    username: p.username || '',
    password: p.password || '',
    sessionSuffix: !!p.sessionSuffix,
    rotating: !!p.rotating,
    raw: p.raw || '',
    // Kept so the rotation pool can dedupe by real exit IP and mix countries.
    egressIp: p.egressIp || '',
    countryCode: p.countryCode || p.country || '',
    timezone: p.timezone || '',
    status: p.status || '',
    targetOk: !!p.targetOk,
  };
}

// The pool for random mode: only proxies the browser has already validated as
// working. Dead/unknown entries are never used for a replay.
function rpaWorkingPool() {
  const list = Array.isArray(loadedProxies) ? loadedProxies : [];
  return list
    .filter(p => p && p.host && p.port && p.status === 'ok')
    .map(rpaProxyRecord)
    .filter(Boolean);
}

function rpaRecomputeRandomTotals() {
  let clicks = 0;
  let scrolls = 0;
  for (const row of (rpaPlayState.sessionStats || [])) {
    clicks += Number(row.clicks) || 0;
    scrolls += Number(row.scrolls) || 0;
  }
  rpaPlayState.randomClicks = clicks;
  rpaPlayState.randomScrolls = scrolls;
}

// Small UA pool used only when no UA was selected in the UI. Without this a
// mobile/tablet RPA replay would still send the desktop default UA.
const RPA_MOBILE_UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36';
const RPA_TABLET_UA = 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

function rpaPickUserAgent(opts, index) {
  const list = Array.isArray(opts.userAgents) ? opts.userAgents.filter(Boolean) : [];
  if (list.length) {
    if (opts.uaAutoRotate) return list[Math.floor(Math.random() * list.length)];
    return list[0];
  }
  if (opts.device === 'mobile') return RPA_MOBILE_UA;
  if (opts.device === 'tablet') return RPA_TABLET_UA;
  return '';
}

// Mobile resolutions chosen in the UI are physical device pixels (e.g.
// 1080x2340). A browser viewport is CSS pixels, so convert with a device scale
// factor - otherwise a "mobile" session would render the desktop layout.
function rpaPickViewport(opts, index, ua) {
  const selectedDevice = opts.device || 'desktop';
  // The UA is what the visited site sees; emulation must follow it (same rule
  // as the campaign modules) or Android/iOS hits are reported as Tablet/Desktop.
  const device = resolveSessionDevice(selectedDevice, ua);
  const deviceChanged = device !== selectedDevice;
  const pickFrom = (arr, i) => {
    if (!Array.isArray(arr) || !arr.length) return null;
    const item = arr[i % arr.length];
    if (Array.isArray(item)) return { width: parseInt(item[0], 10) || 0, height: parseInt(item[1], 10) || 0 };
    if (item && typeof item === 'object') return { width: parseInt(item.width, 10) || 0, height: parseInt(item.height, 10) || 0 };
    return null;
  };
  const rotated = deviceChanged ? null : pickFrom(opts.autoRotateResolutions, Math.max(0, index - 1));
  const baseW = parseInt(opts.viewportWidth, 10) || (device === 'mobile' ? 390 : (device === 'tablet' ? 768 : 1280));
  const baseH = parseInt(opts.viewportHeight, 10) || (device === 'mobile' ? 844 : (device === 'tablet' ? 1024 : 800));
  const chosen = rotated || { width: baseW, height: baseH };

  if (device === 'mobile' || device === 'tablet') {
    let w = chosen.width || (device === 'mobile' ? 390 : 768);
    let h = chosen.height || (device === 'mobile' ? 844 : 1024);
    let scale = 1;
    const minW = device === 'mobile' ? 320 : 600;
    const maxW = device === 'mobile' ? 500 : 1280;
    if (w > maxW) {
      scale = w >= 1000 ? 3 : 2;
      // Prefer a scale that lands inside a realistic CSS width.
      const candidate = Math.round(w / scale);
      if (candidate < minW) scale = 1;
      w = Math.round(w / scale);
      h = Math.round(h / scale);
    }
    // Phones report Sec-CH-UA-Mobile:?1; tablets are touch devices that must
    // report ?0, otherwise ad networks count them as phones. A CSS-size value
    // still needs a real mobile/tablet DPR.
    if (scale === 1) scale = device === 'tablet' ? 2 : 3;
    return {
      width: w,
      height: h,
      isMobile: device === 'mobile',
      hasTouch: true,
      deviceScaleFactor: scale,
      device,
      deviceChanged,
    };
  }
  return {
    width: chosen.width || 1280,
    height: chosen.height || 800,
    isMobile: false,
    hasTouch: false,
    deviceScaleFactor: 1,
    device,
    deviceChanged,
  };
}

// Turn a loaded proxy record into Playwright's { proxy: {...} } context option.
// Each replay iteration gets its own session token (residential pools rotate
// per session) and a plain proxy is used exactly as typed.
function rpaResolveProxy(rawProxy, sessionTag) {
  try {
    if (!rawProxy || !rawProxy.host || !rawProxy.port) return null;
    const sessionProxy = rpaPh.buildSessionProxy(rawProxy, sessionTag || 'rpa');
    const opts = rpaPh.buildPlaywrightProxyOpts(sessionProxy);
    return (opts && opts.proxy && opts.proxy.server) ? opts : null;
  } catch (_) {
    return null;
  }
}

function rpaPushLog(state, msg, type) {
  state.logs.push({ t: Date.now(), type: type || 'info', message: String(msg) });
  if (state.logs.length > 300) state.logs.shift();
}

// Live counters for the recording UI (clicks / inputs / scrolls / ...).
function rpaRecordingStats() {
  const stats = { clicks: 0, inputs: 0, scrolls: 0, keys: 0, navs: 0, other: 0, tabs: 0 };
  for (const a of (rpaState.actions || [])) {
    if (!a) continue;
    if (a.type === 'click') stats.clicks++;
    else if (a.type === 'input' || a.type === 'select') stats.inputs++;
    else if (a.type === 'scroll') stats.scrolls++;
    else if (a.type === 'key') stats.keys++;
    else if (a.type === 'navigate' || a.type === 'reload') stats.navs++;
    else if (a.type === 'switch') stats.tabs++;
    else stats.other++;
  }
  return stats;
}

// Executes the recorded action list exactly once through a verified proxy.
// Each recorded tab id gets its own real page/tab, so a link that opened a new
// tab during recording opens a new tab during replay as well (the old replay
// navigated the original page and closed the previous tab).
async function rpaReplayOnce(actions, opts) {
  const sessionTag = opts.sessionId ? `S${opts.sessionId}` : 'S1';
  const log = (msg, type) => rpaPushLog(rpaPlayState, `[${sessionTag}] ${msg}`, type);
  const totalActions = actions.length;

  const session = await createProxiedSession({
    proxy: opts.proxy || null,
    requireProxy: !!opts.requireProxy,
    sessionTag: `rpa-s${opts.sessionId || 1}-${opts.iteration || 1}`,
    headless: !!opts.headless,
    contextOpts: opts.contextOpts || {},
    verifyEgress: opts.verifyProxy !== false,
    onLog: (msg, type) => log(msg, type),
    sessionId: sessionTag,
  });

  const browser = session.browser;
  const context = session.context;
  rpaPlayState.browsers.add(browser);
  let clicker = null;
  let statsTimer = null;
  let actionsDone = 0;

  // Surface the verified proxy identity immediately in the live monitor.
  opts.onSessionReady && opts.onSessionReady({
    proxyLabel: proxiedLabel(session.proxy),
    proxyEgress: session.egressIp || (session.geo && session.geo.ip) || '',
    proxyCountry: (session.geo && (session.geo.countryCode || session.geo.country)) || '',
    proxyTimezone: (session.geo && session.geo.timezone) || '',
    proxyVerified: !!session.proxyVerified,
    proxyRotating: !!session.rotating,
  });

  try {
    // Optional traffic-source spoofing for the replay as well.
    let trafficSourceResult = { applied: false, referrer: '' };
    if (opts.trafficCfg) {
      try {
        trafficSourceResult = await require('./TrafficSource.js').installTrafficSource(context, opts.trafficCfg, {
          targetUrl: (actions.find(a => a.url) || {}).url || '',
          log: (msg, type) => log(msg, type),
        }) || { applied: false, referrer: '' };
      } catch (_) {}
    }

    // Privacy / anti-detection features apply to the RPA replay too. Install
    // on the context before the first page so every recorded tab and popup is
    // covered, and align the spoofed identity with the replay UA/device.
    const rpaUa = (opts.contextOpts && opts.contextOpts.userAgent) || '';
    const rpaDevice = resolveSessionDevice(opts.device || 'desktop', rpaUa);
    const rpaVp = Object.assign({}, (opts.contextOpts && opts.contextOpts.viewport) || {}, {
      deviceScaleFactor: (opts.contextOpts && opts.contextOpts.deviceScaleFactor) || 1,
      hasTouch: !!(opts.contextOpts && opts.contextOpts.hasTouch),
    });
    await installPrivacyGuard(context, {
      privacyFeatures: opts.privacyFeatures || [],
      privacyLevel: opts.privacyLevel || 'standard',
      timezone: (session.geo && session.geo.timezone) || '',
      ua: rpaUa,
      platform: uaPlatform(rpaUa),
      chPlatform: uaChPlatform(rpaUa),
      brands: uaBrands(rpaUa),
      device: rpaDevice,
      viewport: rpaVp,
      hasTouch: !!rpaVp.hasTouch,
      trafficReferrer: trafficSourceResult && trafficSourceResult.applied ? trafficSourceResult.referrer : '',
      onLog: (msg) => log(msg),
    }).catch(() => {});

    // --- Tab bookkeeping --------------------------------------------------
    // tabPages maps a recorded tab id to a live Playwright page.
    // freshPages holds popups the click itself opened; when the matching
    // navigate action arrives we consume that popup instead of opening a
    // second blank tab.
    const tabPages = new Map();
    const mappedPages = new Set();
    const freshPages = [];
    context.on('page', (p) => {
      try {
        if (!p || mappedPages.has(p)) return;
        freshPages.push(p);
        if (freshPages.length > 20) freshPages.shift();
      } catch (_) {}
    });
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    const firstAction = actions[0] || {};
    const firstTab = firstAction.tab || 'tab1';
    const firstUrl = (actions.find(a => a.type === 'navigate' && a.url) || actions.find(a => a.url) || {}).url || 'https://www.google.com';
    // The context is only created after the egress check, so this first
    // navigation can never happen on the PC's direct connection.
    const firstPage = await context.newPage();
    mappedPages.add(firstPage);
    tabPages.set(firstTab, firstPage);
    try { await firstPage.goto(firstUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }); } catch (_) {}

    // Random clicks follow whichever replay tab is active. Links they click
    // open in background tabs; the replay tab never loses focus because of a
    // random click.
    if (opts.randomCfg && opts.randomCfg.enabled) {
      const { startRandomClicker } = require('./RandomClicker.js');
      clicker = startRandomClicker(firstPage, {
        config: opts.randomCfg,
        sessionId: `RPA ${sessionTag}`,
        onLog: (msg, type) => log(msg, type),
        isStopped: () => rpaPlayState.stopRequested,
        // The replay owns its recorded tabs. Only random-click background tabs
        // are tracked/closed by the clicker; recorded popups are never closed
        // by it.
        manageNewPages: false,
      });
      const report = () => {
        try {
          const st = clicker.getStats();
          opts.onRandomStats && opts.onRandomStats(st.clicks, st.scrolls);
        } catch (_) {}
      };
      statsTimer = setInterval(report, 500);
    }

    // Wait briefly for a popup that a click just opened. If Playwright never
    // emits one (some websites block window.open), a real new page is created.
    async function pageForTab(tab, waitForPopup) {
      if (tabPages.has(tab)) return tabPages.get(tab);
      if (waitForPopup) {
        const deadline = Date.now() + 2500;
        while (Date.now() < deadline) {
          const candidate = freshPages.shift();
          if (!candidate) {
            await sleep(100);
            continue;
          }
          // Never consume a tab that the random clicker opened in the
          // background as if it were a recorded/popup tab.
          if (candidate.__rcBackgroundTab) continue;
          if (!mappedPages.has(candidate) && !candidate.isClosed()) {
            mappedPages.add(candidate);
            tabPages.set(tab, candidate);
            log(`Opened recorded tab ${tab} as a new browser tab (popup)`);
            return candidate;
          }
        }
      }
      const created = await context.newPage();
      mappedPages.add(created);
      tabPages.set(tab, created);
      log(`Opened recorded tab ${tab} as a new browser tab`);
      return created;
    }

    let lastTs = (actions[0] || {}).ts || 0;
    let legacyPage = firstPage;
    // Random clicks must never race a recorded action. Pause around the
    // actions that touch the page, then resume on the tab the action used.
    const exclusiveTypes = new Set([
      'click',
      'input',
      'key',
      'select',
      'navigate',
      'reload',
      'switch',
      'scroll',
    ]);
    for (let actionIndex = 0; actionIndex < actions.length; actionIndex++) {
      const action = actions[actionIndex];
      if (rpaPlayState.stopRequested) break;
      const actualDelay = action.ts ? (action.ts - lastTs) : 100;
      lastTs = action.ts || lastTs;
      const delay = Math.max(50, Math.min(actualDelay / opts.speed, 5000));
      await new Promise(r => setTimeout(r, delay));
      if (rpaPlayState.stopRequested) break;

      opts.onProgress && opts.onProgress({
        index: actionIndex,
        done: actionsDone,
        total: totalActions,
        type: action.type || '',
        tab: action.tab || firstTab,
        url: action.url || '',
      });

      let page = legacyPage;
      const needsExclusive = !!clicker && exclusiveTypes.has(action.type);
      if (needsExclusive) {
        try { await clicker.pause(); } catch (_) {}
      }
      try {
        if (action.tab) {
          page = tabPages.get(action.tab) || null;
          if (!page && (action.type === 'navigate' || action.type === 'switch' || action.type === 'click')) {
            // The click/navigate before this action may have opened the tab.
            page = await pageForTab(action.tab, true);
          }
          if (!page) page = tabPages.get(firstTab) || firstPage;
        } else if (action.url && action.url !== legacyPage.url() && action.type !== 'navigate') {
          // Older recordings have no tab ids. Keep the legacy fallback so they
          // still replay in a single page.
          try { await legacyPage.goto(action.url, { waitUntil: 'domcontentloaded', timeout: 30000 }); } catch (_) {}
          page = legacyPage;
        }

        if (action.type === 'switch') {
          // Recorded tab switch: make that tab the active one again. This is
          // what makes "new tab -> go back to previous tab" replay correctly.
          try {
            await page.bringToFront();
          } catch (_) {}
          log(`Switched to tab ${action.tab || '?'}`);
          await new Promise((r) => setTimeout(r, 80));
        } else if (action.type === 'click') {
          let clicked = false;
          const x = Number(action.x);
          const y = Number(action.y);
          // Coordinates FIRST: ads rotate, so replaying the recorded mouse
          // position clicks whatever ad is showing now instead of reusing an
          // old link/selector. Selector remains a fallback.
          if (Number.isFinite(x) && Number.isFinite(y) && x > 0 && y > 0) {
            try {
              const vp = page.viewportSize() || { width: 1280, height: 800 };
              if (x < vp.width && y < vp.height) {
                await page.bringToFront().catch(() => {});
                await page.mouse.move(x, y, { steps: 4 + Math.floor(Math.random() * 6) });
                await page.mouse.click(x, y, { delay: 30 + Math.floor(Math.random() * 60) });
                clicked = true;
              }
            } catch (_) {}
          }
          if (!clicked && action.selector) {
            try {
              await page.click(action.selector, { timeout: 3000 });
              clicked = true;
            } catch (_) {}
          }
          if (!clicked) {
            try { await page.mouse.click(x || 0, y || 0); } catch (_) {}
          }
        } else if (action.type === 'input' && action.selector) {
          try {
            await page.click(action.selector, { timeout: 5000 });
            await page.fill(action.selector, action.value || '');
          } catch (_) {
            try { await page.keyboard.type(action.value || ''); } catch (_) {}
          }
        } else if (action.type === 'key' && action.key) {
          try { await page.press(action.selector || 'body', action.key); } catch (_) {
            try { await page.keyboard.press(action.key); } catch (_) {}
          }
        } else if (action.type === 'scroll') {
          await page.evaluate((a) => {
            const x = Number(a.x) || 0;
            const y = Number(a.y) || 0;
            if (a.container && a.selector) {
              let el = null;
              try { el = document.querySelector(a.selector); } catch (_) {}
              if (el) {
                el.scrollTo({ left: x, top: y, behavior: 'auto' });
                return;
              }
            }
            window.scrollTo({ left: x, top: y, behavior: 'auto' });
          }, action).catch(() => {});
        } else if (action.type === 'select' && action.selector) {
          try { await page.selectOption(action.selector, action.value || ''); } catch (_) {}
        } else if (action.type === 'reload') {
          // Refresh is replayed as a real refresh - never as a goto() of an
          // old URL.
          try {
            await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
            log(`Refreshed tab ${action.tab || '?'}`);
          } catch (_) {
            if (action.url) {
              try { await page.goto(action.url, { waitUntil: 'domcontentloaded', timeout: 30000 }); } catch (_) {}
            }
          }
        } else if (action.type === 'navigate' && action.url) {
          // A navigate event for the page we are already on is a no-op (do not
          // reload the page unnecessarily).
          if (page.url() !== action.url) {
            try { await page.goto(action.url, { waitUntil: 'domcontentloaded', timeout: 30000 }); } catch (_) {}
          }
        }
      } catch (_) {}
      finally {
        // The random clicker always works on the tab the replay just used.
        if (clicker) {
          try {
            const activeTabPage = (action.tab && tabPages.get(action.tab)) || page;
            if (activeTabPage && !activeTabPage.isClosed()) clicker.setActivePage(activeTabPage);
          } catch (_) {}
          if (needsExclusive) {
            try { clicker.resume(); } catch (_) {}
          }
        }
      }
      actionsDone++;
      opts.onProgress && opts.onProgress({
        index: actionIndex + 1,
        done: actionsDone,
        total: totalActions,
        type: '',
        tab: action.tab || firstTab,
        url: action.url || '',
      });
    }

    // Stay on the final page so the random clicker can finish its visit.
    if (clicker && opts.dwellMs > 0) {
      // Make sure the replay tab is the visible tab when the free-click phase
      // starts (an ad popup opened by the recording must not own the window).
      try {
        const finalPage = clicker.getActivePage();
        if (finalPage && !finalPage.isClosed()) await finalPage.bringToFront();
      } catch (_) {}
      const end = Date.now() + opts.dwellMs;
      while (Date.now() < end && !rpaPlayState.stopRequested) {
        await new Promise(r => setTimeout(r, 250));
      }
    }
    return { actionsDone, totalActions };
  } finally {
    if (statsTimer) clearInterval(statsTimer);
    if (clicker) {
      try {
        const st = clicker.getStats();
        opts.onRandomStats && opts.onRandomStats(st.clicks, st.scrolls);
      } catch (_) {}
      try { clicker.stop(); } catch (_) {}
    }
    rpaPlayState.browsers.delete(browser);
    try { await session.close(); } catch (_) {}
  }
}

// Reasons where the proxy tunnel works but the ad/site target refuses that IP.
// These must NOT mark the proxy dead, otherwise the rotation pool would be
// emptied by a few preflights against a strict ad network.
function rpaProxyTargetRejected(reason) {
  return ['proxy_detected', 'site_blocked', 'no_response', 'timeout'].includes(String(reason || '').toLowerCase());
}

// Preflight a proxy pool against the real target in a real Chromium context.
// onlyTargetOk=true (browser validation) catches dead tunnels, MITM certs,
// HTTP block pages ("Anonymous Proxy detected") and direct-IP leaks before the
// replay starts. The outcome is also persisted on each proxy record.
async function rpaPreflightProxyPool(pool, targetUrl, opts = {}) {
  const { BrowserProxyChecker } = require('./ProxyBrowserCheck.js');
  const timeoutMs = Math.max(5000, Math.min(30000, parseInt(opts.timeoutMs, 10) || 20000));
  const maxCheck = Math.max(1, Math.min(12, parseInt(opts.maxCheck, 10) || 8));
  const concurrency = Math.max(1, Math.min(4, parseInt(opts.concurrency, 10) || 3));
  let candidates = Array.isArray(pool) ? pool.filter(Boolean).slice() : [];
  if (!candidates.length) return { checked: [], verified: [], rejected: [], targetUrl };

  // Never spend minutes checking a huge free-proxy list at play time; take a
  // random sample of the working pool. Fixed mode always checks its one proxy.
  const skipped = Math.max(0, candidates.length - maxCheck);
  if (skipped > 0) {
    candidates = candidates.sort(() => Math.random() - 0.5).slice(0, maxCheck);
  }

  const checker = new BrowserProxyChecker({ headless: true, timeoutMs, sessionId: 'RPA preflight' });
  const checked = new Array(candidates.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= candidates.length) return;
      const p = candidates[i];
      let r;
      try {
        r = await checker.check(p, targetUrl, timeoutMs);
      } catch (e) {
        r = { ok: false, ms: 0, reason: 'browser_failed', error: (e && e.message) || String(e) };
      }
      checked[i] = { proxy: p, ok: !!r.ok, reason: r.reason || (r.ok ? 'ok' : 'failed'), result: r };
      try {
        recordProxyResult(proxiedKey(p), r, targetUrl, {
          tunnelOk: !!r.ok || rpaProxyTargetRejected(r.reason),
        });
      } catch (_) {}
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, worker));
  } finally {
    try { await checker.close(); } catch (_) {}
  }
  const verified = checked.filter(x => x && x.ok).map(x => x.proxy);
  const rejected = checked.filter(x => x && !x.ok);
  return { checked: checked.filter(Boolean), verified, rejected, targetUrl, skipped };
}

// Resolve the real exit IP for pool entries whose egress is still unknown.
// Deduping by host:port is not enough: different ports of the same provider
// frequently share one IP, which is exactly the "same IP again" bug. These are
// cheap HTTP checks through the proxy (no browser), capped so a big free list
// cannot stall the replay.
async function rpaResolvePoolEgress(pool, opts = {}) {
  const { resolveProxyGeo } = require('./EgressGuard.js');
  const timeoutMs = Math.max(3000, Math.min(10000, parseInt(opts.timeoutMs, 10) || 5000));
  const concurrency = Math.max(1, Math.min(8, parseInt(opts.concurrency, 10) || 6));
  const max = Math.max(0, Math.min(pool.length, parseInt(opts.max, 10) || 40));
  const unknown = pool.filter(p => !String(p.egressIp || '').trim());
  if (!unknown.length) return { resolved: 0, unknown: 0, checked: 0 };
  const todo = unknown.slice(0, max);
  let next = 0;
  let resolved = 0;
  async function worker() {
    while (true) {
      const idx = next++;
      if (idx >= todo.length) return;
      const p = todo[idx];
      try {
        const geo = await resolveProxyGeo(p, { timeoutMs });
        if (geo && geo.ip) {
          p.egressIp = geo.ip;
          if (geo.countryCode) p.countryCode = geo.countryCode;
          resolved++;
          const key = proxyStoreKey(p);
          const entry = loadedProxies.find(x => proxyStoreKey(x) === key);
          if (entry) {
            entry.egressIp = geo.ip;
            if (geo.countryCode) entry.countryCode = geo.countryCode;
            if (geo.timezone) entry.timezone = geo.timezone;
            scheduleProxiesSave();
          }
        }
      } catch (_) {}
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker));
  return { resolved, unknown: unknown.length, checked: todo.length };
}

// One session = one independent browser that repeats the recording `loop`
// times. Multiple sessions run in parallel (the UI lets you pick 1-10).
async function rpaPlaySessionWorker(actions, opts, sessionId) {
  const row = rpaSessionRow(sessionId);
  rpaPlayState.sessionStats.push(row);
  const tag = `S${sessionId}`;
  const mode = opts.proxyMode || 'none';

  for (let i = 0; i < opts.loop; i++) {
    if (rpaPlayState.stopRequested) break;
    row.iteration = i + 1;
    rpaPlayState.iteration = Math.max(rpaPlayState.iteration, i + 1);
    rpaPlayState.round = Math.max(rpaPlayState.round, i + 1);

    // Pick the proxy for this round/session from the shared rotation ledger.
    // The ledger never returns an IP that already hit the 12 h reuse cap and
    // never returns the same exit twice in a row, even across parallel
    // sessions.
    let candidate = null;
    let pickMeta = {};
    if (mode === 'fixed') {
      candidate = opts.proxyPool[0] || null;
    } else if (mode === 'random') {
      if (opts.proxyRotation === 'session') {
        if (!opts.sessionProxyMap) opts.sessionProxyMap = new Map();
        if (!opts.sessionProxyMap.has(sessionId)) {
          opts.sessionProxyMap.set(sessionId, acquireRotationProxy(opts.proxyPool, pickMeta));
        }
        candidate = opts.sessionProxyMap.get(sessionId) || null;
      } else {
        candidate = acquireRotationProxy(opts.proxyPool, pickMeta);
      }
    }
    if (mode !== 'none' && !candidate) {
      row.failed++;
      row.lastError = pickMeta && pickMeta.tier === 99
        ? `IP reuse safety cap reached (${pickMeta.hardLimit} uses / 12 h per IP)`
        : 'No safe proxy available for this round';
      rpaPlayState.lastError = row.lastError;
      rpaPushLog(rpaPlayState, `[${tag}] Replay ${i + 1}/${opts.loop} skipped: ${row.lastError}. Add more proxies or wait - reusing an IP is blocked.`, 'error');
      break;
    }
    if (mode === 'random' && pickMeta && pickMeta.tier >= 3) {
      rpaPushLog(rpaPlayState, `[${tag}] WARNING: this IP already had ${Math.max(0, (pickMeta.uses || 1) - 1)} use(s) in the last 12 h. It is the 4th/5th (last allowed) use - add more proxies to stay safer.`, 'warning');
    }

    const maxProxyAttempts = mode === 'random'
      ? Math.min(Math.max(1, opts.proxyPool.length), 10)
      : 1;
    let completedThisRound = false;

    for (let attempt = 0; attempt < maxProxyAttempts; attempt++) {
      if (rpaPlayState.stopRequested) break;
      let attemptProxy = candidate;
      if (attempt > 0) {
        const retryMeta = {};
        attemptProxy = acquireRotationProxy(opts.proxyPool, retryMeta);
        if (!attemptProxy) {
          row.failed++;
          row.lastError = 'No safe proxy left for a retry (IP reuse cap reached)';
          rpaPlayState.lastError = row.lastError;
          rpaPushLog(rpaPlayState, `[${tag}] ${row.lastError}; stopping this round instead of reusing an IP.`, 'error');
          break;
        }
        row.retries++;
        row.proxySwitches++;
        rpaPlayState.proxyRetries++;
        rpaPlayState.proxySwitches++;
      }
      const proxyText = attemptProxy ? proxiedLabel(attemptProxy) : 'direct IP';
      rpaPushLog(rpaPlayState, `[${tag}] Replay ${i + 1}/${opts.loop} started via ${proxyText}`, 'info');
      try {
        const uaForRound = rpaPickUserAgent(opts, i + 1);
        const vpForRound = rpaPickViewport(opts, i + 1, uaForRound);
        if (vpForRound.deviceChanged) {
          rpaPushLog(rpaPlayState, `[${tag}] Device Setting was "${opts.device}" but the user agent is ${vpForRound.device} - ${vpForRound.device} emulation (Sec-CH-UA-Mobile) applied so trackers see the correct device.`, 'warning');
        }
        const contextOpts = {
          viewport: { width: vpForRound.width, height: vpForRound.height },
          isMobile: !!vpForRound.isMobile,
          hasTouch: !!vpForRound.hasTouch,
          deviceScaleFactor: vpForRound.deviceScaleFactor || 1,
        };
        if (vpForRound.hasTouch) {
          const screenSize = physicalScreen(vpForRound);
          if (screenSize) contextOpts.screen = screenSize;
        }
        Object.assign(contextOpts, privacyContextOptions(opts.privacyFeatures || []));
        if (uaForRound) contextOpts.userAgent = uaForRound;
        const result = await rpaReplayOnce(actions, {
          ...opts,
          sessionId,
          iteration: i + 1,
          proxy: attemptProxy,
          requireProxy: mode !== 'none',
          contextOpts,
          onSessionReady: (info) => {
            row.proxyLabel = info.proxyLabel;
            row.proxyEgress = info.proxyEgress;
            row.proxyCountry = info.proxyCountry;
            row.proxyVerified = !!info.proxyVerified;
            rpaPlayState.proxyLabel = info.proxyLabel;
            rpaPlayState.proxyEgress = info.proxyEgress;
            rpaPlayState.proxyVerified = !!info.proxyVerified;
            // Show the rotation clearly: every round logs the exit IP the site
            // actually sees, not just the proxy host:port.
            rpaPushLog(
              rpaPlayState,
              `[${tag}] Round ${i + 1}/${opts.loop} exit IP: ${info.proxyEgress || 'unverified'}${info.proxyCountry ? ' (' + info.proxyCountry + ')' : ''} via ${info.proxyLabel}`,
              info.proxyVerified ? 'info' : 'warn'
            );
            if (info.proxyEgress) {
              if (!Array.isArray(rpaPlayState.proxyUniqueIps)) rpaPlayState.proxyUniqueIps = [];
              if (!rpaPlayState.proxyUniqueIps.includes(info.proxyEgress)) {
                rpaPlayState.proxyUniqueIps.push(info.proxyEgress);
                if (rpaPlayState.proxyUniqueIps.length > 200) rpaPlayState.proxyUniqueIps.shift();
              }
              // Persist the proven exit so the next pool build dedupes by real IP.
              try {
                const key = proxyStoreKey(attemptProxy);
                const entry = loadedProxies.find(p => proxyStoreKey(p) === key);
                if (entry && entry.egressIp !== info.proxyEgress) {
                  entry.egressIp = info.proxyEgress;
                  if (info.proxyCountry) entry.countryCode = info.proxyCountry;
                  scheduleProxiesSave();
                }
              } catch (_) {}
              try { markProxySuccess(attemptProxy, { egressIp: info.proxyEgress, country: info.proxyCountry }); } catch (_) {}
            }
            if (info.proxyRotating) {
              rpaPushLog(rpaPlayState, `[${tag}] Rotating proxy exit: ${info.proxyEgress}`, 'info');
            }
          },
          onProgress: (p) => {
            row.actionsDone = p.done;
            row.actionsTotal = p.total;
            row.currentAction = p.type || '';
            row.currentTab = p.tab || '';
            rpaPlayState.currentAction = p.type || '';
            rpaPlayState.currentTab = p.tab || '';
            rpaPlayState.currentUrl = p.url || '';
            rpaPlayState.actionsDone = (rpaPlayState.sessionStats || []).reduce((n, r) => Math.max(n, Number(r.actionsDone) || 0), 0);
          },
          onRandomStats: (clicks, scrolls) => {
            row.clicks = clicks || 0;
            row.scrolls = scrolls || 0;
            rpaRecomputeRandomTotals();
          },
        });
        row.completed++;
        row.actionsDone = result.actionsDone;
        row.actionsTotal = result.totalActions;
        rpaPlayState.actionsCompleted += Number(result.actionsDone) || 0;
        row.lastError = '';
        completedThisRound = true;
        rpaPushLog(rpaPlayState, `[${tag}] Replay ${i + 1}/${opts.loop} complete via ${proxyText} (${result.actionsDone}/${result.totalActions} actions)`, 'success');
        break;
      } catch (e) {
        const msg = (e && e.message) || String(e);
        row.actionsDone = 0;
        row.actionsTotal = 0;
        const proxyFailure = !!attemptProxy && isProxyFailure(e);
        if (proxyFailure) {
          try { markProxyFailure(attemptProxy, msg); } catch (_) {}
        }
        if (proxyFailure && attempt < maxProxyAttempts - 1) {
          row.lastError = msg;
          rpaPushLog(rpaPlayState, `[${tag}] Proxy ${proxyText} failed: ${msg} - switching to the next safe proxy`, 'warn');
          continue;
        }
        row.failed++;
        row.lastError = msg;
        rpaPlayState.lastError = msg;
        rpaPushLog(rpaPlayState, `[${tag}] Replay ${i + 1}/${opts.loop} failed: ${msg}`, 'error');
        break;
      }
    }

    if (!completedThisRound && !row.lastError) {
      row.lastError = 'Replay did not complete';
    }
    if (rpaPlayState.stopRequested) break;
  }

  row.running = false;
  row.actionsDone = row.actionsDone || 0;
  if (!row.lastError) rpaPushLog(rpaPlayState, `[${tag}] Session finished (${row.completed}/${opts.loop} replays)`, 'success');
}

async function rpaPlayLoop(actions, opts) {
  rpaPlayState.running = true;
  rpaPlayState.stopRequested = false;
  rpaPlayState.startedAt = Date.now();
  rpaPlayState.finishedAt = 0;
  rpaPlayState.lastError = '';
  rpaPlayState.iteration = 0;
  rpaPlayState.round = 0;
  rpaPlayState.sessions = opts.sessions;
  rpaPlayState.loop = opts.loop;
  rpaPlayState.totalRounds = opts.sessions * opts.loop;
  rpaPlayState.totalActions = actions.length;
  rpaPlayState.actionsDone = 0;
  rpaPlayState.actionsCompleted = 0;
  rpaPlayState.randomClicks = 0;
  rpaPlayState.randomScrolls = 0;
  rpaPlayState.sessionStats = [];
  rpaPlayState.proxyMode = opts.proxyMode || 'none';
  rpaPlayState.proxyTarget = rpaTargetUrl(actions);
  rpaPlayState.proxyLabel = '';
  rpaPlayState.proxyEgress = '';
  rpaPlayState.proxyVerified = false;
  rpaPlayState.proxyPoolSize = 0;
  rpaPlayState.proxyVerifiedPoolSize = 0;
  rpaPlayState.proxyRawPoolSize = 0;
  rpaPlayState.proxyUniqueIps = [];
  rpaPlayState.proxyUsage = null;
  rpaPlayState.proxySwitches = 0;
  rpaPlayState.proxyRetries = 0;
  rpaPlayState.currentAction = '';
  rpaPlayState.currentTab = '';
  rpaPlayState.currentUrl = '';

  try {
    const mode = opts.proxyMode || 'none';
    if (mode === 'none') {
      opts.proxyPool = [];
      opts.verifiedPool = [];
      rpaPushLog(
        rpaPlayState,
        'Network: direct IP (same as a normal browser). Ads and sites behave normally; use a residential proxy only when you need a different country exit.',
        'info'
      );
    } else {
      const rawPool = Array.isArray(opts.proxyPool) && opts.proxyPool.length
        ? opts.proxyPool.map(rpaProxyRecord).filter(Boolean)
        : (opts.rawProxy ? [rpaProxyRecord(opts.rawProxy)] : []);
      if (!rawPool.length) {
        rpaPlayState.lastError = 'No proxy selected for this proxy mode';
        rpaPushLog(rpaPlayState, 'Replay aborted: no proxy selected. Direct-IP fallback is disabled.', 'error');
        return;
      }
      // Resolve missing exit IPs first. Without this, two ports of the same
      // provider look like two proxies while the site still sees one IP.
      if (mode === 'random' && rawPool.length > 1) {
        const unknownCount = rawPool.filter(p => !p.egressIp).length;
        if (unknownCount) {
          rpaPushLog(rpaPlayState, `Resolving exit IPs for ${unknownCount}/${rawPool.length} proxies before rotation (light HTTP checks, no browser)...`, 'info');
          const eg = await rpaResolvePoolEgress(rawPool).catch(() => null);
          if (eg) {
            rpaPushLog(rpaPlayState, `Exit-IP lookup: ${eg.resolved}/${eg.checked} resolved${eg.unknown > eg.checked ? `, ${eg.unknown - eg.checked} still unknown` : ''}.`, eg.resolved ? 'success' : 'warn');
          }
        }
      }
      // 82 free-proxy entries often expose only a handful of real exit IPs.
      // Dedupe by exit identity BEFORE preflight/rotation so "different proxy"
      // really means "different IP".
      const distinctPool = dedupeProxyPool(rawPool);
      rpaPlayState.proxyRawPoolSize = rawPool.length;
      rpaPlayState.proxyPoolSize = distinctPool.length;
      rpaPlayState.proxyLabel = proxiedLabel(distinctPool[0]);
      rpaPushLog(
        rpaPlayState,
        `Rotation pool: ${distinctPool.length} distinct exit IP(s) from ${rawPool.length} prox${rawPool.length === 1 ? 'y' : 'ies'}. Each round/session gets a different IP; an IP is capped at 5 uses per 12 h and spaced by ~20 min.`,
        'info'
      );
      if (distinctPool.length < rawPool.length) {
        rpaPushLog(
          rpaPlayState,
          `${rawPool.length - distinctPool.length} duplicate entr${rawPool.length - distinctPool.length === 1 ? 'y' : 'ies'} shared an exit IP and ${rawPool.length - distinctPool.length === 1 ? 'was' : 'were'} merged (using them would NOT have changed the IP).`,
          'info'
        );
      }
      if (distinctPool.length === 1) {
        rpaPushLog(
          rpaPlayState,
          'Only 1 usable exit IP is configured, so rotation cannot be shown yet. Add more proxies (or a rotating residential endpoint) to rotate IPs between rounds.',
          'warn'
        );
      }

      if (opts.verifyProxy) {
        // Preflight is a real-browser probe of the target. It is only used to
        // ORDER the pool (accepted exits first); it must never shrink rotation
        // down to the one or two proxies that happened to pass this probe.
        const maxCheck = mode === 'random'
          ? Math.max(1, Math.min(distinctPool.length, 12))
          : distinctPool.length;
        rpaPushLog(
          rpaPlayState,
          `Preflight: checking ${Math.min(maxCheck, distinctPool.length)} of ${distinctPool.length} distinct exit(s) against the real target ${rpaPlayState.proxyTarget} in a browser...`,
          'info'
        );
        const pre = await rpaPreflightProxyPool(distinctPool, rpaPlayState.proxyTarget, {
          timeoutMs: 15000,
          maxCheck,
          concurrency: 4,
        });
        const okList = dedupeProxyPool(pre.verified);
        rpaPlayState.proxyVerifiedPoolSize = okList.length;
        for (const bad of pre.rejected) {
          rpaPushLog(rpaPlayState, `Proxy ${proxiedLabel(bad.proxy)} rejected: ${bad.reason}`, 'warn');
        }
        // Verified exits first, then every other distinct exit - the session
        // egress guard still proves each one before it navigates.
        const orderedPool = okList.concat(distinctPool.filter(p => !okList.includes(p)));
        opts.verifiedPool = okList;
        if (!okList.length) {
          opts.proxyPool = distinctPool;
          rpaPlayState.lastError = 'Preflight could not confirm any proxy; continuing with per-session egress checks.';
          rpaPushLog(
            rpaPlayState,
            `Preflight warning: no proxy passed the real-target check (${rpaPlayState.proxyTarget}). Rotating all ${distinctPool.length} distinct exit(s); each replay verifies its own exit IP and switches proxy on failure.`,
            'warn'
          );
        } else {
          if (mode === 'fixed' && pre.checked.length && pre.checked[0] && !pre.checked[0].ok) {
            rpaPlayState.lastError = `Selected proxy failed the real-target check (${pre.checked[0].reason}).`;
            rpaPushLog(rpaPlayState, `Preflight warning: ${rpaPlayState.lastError} Trying it anyway; the session will switch/stop if it really fails.`, 'warn');
          }
          opts.proxyPool = mode === 'fixed' ? [rawPool[0]] : orderedPool;
          rpaPlayState.proxyLabel = proxiedLabel(opts.proxyPool[0]);
          rpaPushLog(
            rpaPlayState,
            `Preflight complete: ${okList.length}/${pre.checked.length} accepted by the target${pre.skipped ? ` (${pre.skipped} not probed)` : ''}. Rotation uses all ${opts.proxyPool.length} distinct exit(s), accepted ones first.`,
            'success'
          );
        }
      } else {
        opts.proxyPool = distinctPool;
        opts.verifiedPool = distinctPool;
        rpaPushLog(rpaPlayState, 'Proxy preflight disabled. Egress leak protection is also disabled for this run.', 'warn');
      }
      rpaPlayState.proxyPoolSize = opts.proxyPool.length;
      rpaPlayState.proxyPoolRef = opts.proxyPool;
      if (mode === 'random') {
        const capacity = getProxyUsageSnapshot(opts.proxyPool);
        rpaPlayState.proxyUsage = capacity;
        rpaPushLog(
          rpaPlayState,
          `Safe rotation capacity: ${capacity.available}/${capacity.poolSize} exit(s) available now · ${capacity.safeCapacity} session(s) before the ${capacity.windowHours} h cap${capacity.cooling ? ` · ${capacity.cooling} cooling down` : ''}${capacity.capped ? ` · ${capacity.capped} capped` : ''}.`,
          capacity.available > 0 ? 'info' : 'warn'
        );
      }
    }

    rpaPushLog(
      rpaPlayState,
      `Starting ${opts.sessions} parallel session${opts.sessions > 1 ? 's' : ''} × ${opts.loop} replay${opts.loop > 1 ? 's' : ''}${opts.headless ? ' (headless)' : ' (visible)'} · proxy mode: ${mode}`,
      'info'
    );
    const workers = [];
    for (let s = 1; s <= opts.sessions; s++) {
      workers.push(rpaPlaySessionWorker(actions, opts, s));
    }
    await Promise.allSettled(workers);

    if (rpaPlayState.stopRequested) {
      rpaPushLog(rpaPlayState, 'RPA replay stopped.', 'warn');
    } else {
      const done = rpaPlayState.sessionStats.reduce((n, r) => n + (r.completed || 0), 0);
      const failed = rpaPlayState.sessionStats.reduce((n, r) => n + (r.failed || 0), 0);
      rpaPushLog(rpaPlayState, `RPA replay finished. ${done} completed, ${failed} failed.`, failed ? 'warn' : 'success');
    }
  } finally {
    rpaPlayState.running = false;
    rpaPlayState.finishedAt = Date.now();
    rpaPlayState.sessionStats.forEach(r => { r.running = false; });
  }
}

// Schedule state - persisted to disk
const SCHEDULE_FILE = path.join(platform.appDataDir(), 'schedule.json');
let scheduleState = {};
let savedSchedules = [];
let scheduleLoaded = false;

function loadScheduleData() {
  if (scheduleLoaded) return;
  try {
    if (fs.existsSync(SCHEDULE_FILE)) {
      scheduleState = JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8'));
      savedSchedules = Array.isArray(scheduleState.savedSchedules) ? scheduleState.savedSchedules : [];
    }
    scheduleLoaded = true;
  } catch (_) {}
}

// --- Proxy scraping helpers -----------------------------------------------
// Fetches free proxy lists from multiple public sources and returns an
// array of { type, host, port, username, password, raw } records.

function fetchText(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(url, { timeout: timeoutMs, headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // Follow redirect
        res.resume();
        fetchText(res.headers.location, timeoutMs).then(resolve).catch(reject);
        return;
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve(data));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}

async function scrapeProxyList() {
  const proxies = [];
  const seen = new Set();

  // Helper to add a proxy without duplicates — validates that host looks like
  // a real IP address or hostname (not "error code" or other junk text).
  function isValidHost(h) {
    if (!h || typeof h !== 'string') return false;
    // IPv4
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return true;
    // Hostname (at least one dot, alphanumeric + hyphens, no spaces)
    if (/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(h)) return true;
    return false;
  }
  function addProxy(type, host, port) {
    if (!isValidHost(host)) return;
    const portNum = parseInt(port, 10);
    if (!portNum || portNum < 1 || portNum > 65535) return;
    const key = `${type}:${host}:${portNum}`;
    if (seen.has(key)) return;
    seen.add(key);
    proxies.push({ type, host, port: portNum, username: null, password: null, raw: `${host}:${portNum}` });
  }

  // Source 1: ProxyScrape API — supports http, socks4, socks5
  const psProtocols = [
    { proto: 'http', type: 'http' },
    { proto: 'socks4', type: 'socks4' },
    { proto: 'socks5', type: 'socks5' },
  ];
  for (const { proto, type } of psProtocols) {
    try {
      const url = `https://api.proxyscrape.com/v2/?request=getproxies&protocol=${proto}&timeout=10000&country=all&ssl=all&anonymity=all`;
      const text = await fetchText(url, 15000);
      const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      for (const line of lines) {
        const parts = line.split(':');
        if (parts.length >= 2 && parts[0] && parts[1]) {
          addProxy(type, parts[0], parts[1]);
        }
      }
    } catch (_) {}
  }

  // Source 2: GeoNode API — returns JSON with ip + port + protocols
  try {
    const url = 'https://proxylist.geonode.com/api/proxy-list?limit=500&page=1&sort_by=lastChecked&sort_type=desc';
    const text = await fetchText(url, 15000);
    const data = JSON.parse(text);
    if (data && Array.isArray(data.data)) {
      for (const p of data.data) {
        if (p.ip && p.port) {
          const protos = Array.isArray(p.protocols) ? p.protocols : [p.protocols || 'http'];
          for (const proto of protos) {
            const type = String(proto).toLowerCase().includes('socks4') ? 'socks4'
                       : String(proto).toLowerCase().includes('socks5') ? 'socks5'
                       : String(proto).toLowerCase().includes('https') ? 'https'
                       : 'http';
            addProxy(type, p.ip, p.port);
          }
        }
      }
    }
  } catch (_) {}

  // Source 3: proxy-list.download — supports http, https, socks4, socks5
  const pldTypes = [
    { urlType: 'http', type: 'http' },
    { urlType: 'https', type: 'https' },
    { urlType: 'socks4', type: 'socks4' },
    { urlType: 'socks5', type: 'socks5' },
  ];
  for (const { urlType, type } of pldTypes) {
    try {
      const url = `https://www.proxy-list.download/api/v1/get?type=${urlType}`;
      const text = await fetchText(url, 15000);
      const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      for (const line of lines) {
        const parts = line.split(':');
        if (parts.length >= 2 && parts[0] && parts[1]) {
          addProxy(type, parts[0], parts[1]);
        }
      }
    } catch (_) {}
  }

  return proxies;
}

// --- Proxy validation helper ---------------------------------------------
// Tests a single proxy by connecting through it to a target URL. Returns
// { ok, ms } — ok=true if the proxy responded within the timeout.
function validateProxy(proxy, timeoutMs = 5000, targetUrl = null) {
  // When a target URL is supplied, test the proxy the same way a browser
  // does: CONNECT tunnel + TLS handshake to the real destination. This
  // catches providers that block a site even though the proxy itself works.
  if (targetUrl) {
    const ProxyHandler = require('./Proxyhandler.js');
    const ph = new ProxyHandler();
    return ph.testReachability(proxy, targetUrl, timeoutMs).then(r => ({
      ok: !!r.ok,
      ms: r.ok ? r.ms : 0,
      reason: r.reason || (r.ok ? 'ok' : 'failed'),
    }));
  }
  return new Promise((resolve) => {
    const start = Date.now();
    const type = (proxy.type || 'http').toLowerCase();
    const host = proxy.host;
    const port = parseInt(proxy.port, 10);
    if (!host || !port) { resolve({ ok: false, ms: 0, reason: 'invalid' }); return; }

    // Guarantee every check finishes, even if a socket never reports an event.
    let settled = false;
    let globalTimer = null;
    const finish = (ok, reason) => {
      if (settled) return;
      settled = true;
      if (globalTimer) clearTimeout(globalTimer);
      resolve({ ok, ms: ok ? Date.now() - start : 0, reason });
    };
    globalTimer = setTimeout(() => finish(false, 'timeout'), timeoutMs + 500);

    const testHost = 'api.ipify.org';
    const testPort = 80;
    const testUrl = `http://${testHost}/`;

    // --- SOCKS4 / SOCKS5 ---------------------------------------------------
    if (type.startsWith('socks')) {
      const socksType = type === 'socks4' ? 4 : 5;
      const proxyOpts = { host, port, type: socksType, timeout: timeoutMs };
      if (proxy.username) {
        proxyOpts.userId = proxy.username;
        if (socksType === 5) proxyOpts.password = proxy.password || '';
      }

      socks.SocksClient.createConnection({
        proxy: proxyOpts,
        command: 'connect',
        destination: { host: testHost, port: testPort },
        timeout: timeoutMs
      }).then(({ socket }) => {
        if (settled) { try { socket.destroy(); } catch (_) {} return; }
        socket.setTimeout(timeoutMs);
        socket.once('timeout', () => { try { socket.destroy(); } catch (_) {} finish(false, 'timeout'); });
        socket.once('error', () => finish(false, 'connect_failed'));
        const req = http.request({
          createConnection: () => socket,
          host: testHost,
          port: testPort,
          path: '/',
          method: 'GET',
          headers: { Host: testHost, 'User-Agent': 'Mozilla/5.0', Connection: 'close' }
        }, (res) => {
          res.resume();
          res.on('end', () => {
            const code = res.statusCode || 0;
            finish(code >= 200 && code < 400, code >= 200 && code < 400 ? 'ok' : 'http_' + code);
          });
        });
        req.on('error', () => finish(false, 'connect_failed'));
        req.end();
      }).catch((err) => {
        finish(false, err && err.code === 'ETIMEDOUT' ? 'timeout' : 'connect_failed');
      });
      return;
    }

    // --- HTTP / HTTPS ------------------------------------------------------
    // Absolute-form request to the proxy, with optional Basic auth.
    const options = {
      hostname: host,
      port,
      path: testUrl,
      method: 'GET',
      headers: { Host: testHost, 'User-Agent': 'Mozilla/5.0', Connection: 'close' },
      timeout: timeoutMs,
    };
    if (proxy.username) {
      const auth = Buffer.from(`${proxy.username}:${proxy.password || ''}`).toString('base64');
      options.headers['Proxy-Authorization'] = `Basic ${auth}`;
    }
    const req = http.request(options, (res) => {
      res.resume();
      res.on('end', () => {
        const code = res.statusCode || 0;
        if (code >= 200 && code < 400) finish(true, 'ok');
        else if (code === 407) finish(false, 'auth');
        else if (code === 402) finish(false, 'payment');
        else finish(false, 'http_' + code);
      });
    });
    req.on('timeout', () => { req.destroy(); finish(false, 'timeout'); });
    req.on('error', (err) => {
      finish(false, err && err.code === 'ECONNREFUSED' ? 'refused' : 'connect_failed');
    });
    req.end();
  });
}

// --- Real-browser proxy validation ---------------------------------------
// validateProxy() above only proves that a tunnel can be opened. Many free
// proxies pass that but are unusable in Chromium (cert MITM, CONNECT refused,
// silent direct fallback). This runs a real browser per proxy so the saved
// list only keeps proxies a traffic session can actually use.
async function runBrowserValidation(list, targetUrl, onResult, opts = {}) {
  const { BrowserProxyChecker } = require('./ProxyBrowserCheck.js');
  const timeoutMs = Math.max(5000, Math.min(30000, parseInt(opts.timeoutMs, 10) || 15000));
  const concurrency = Math.max(1, Math.min(8, parseInt(opts.concurrency, 10) || 6));
  const checker = new BrowserProxyChecker({
    headless: true,
    timeoutMs,
    checkEgress: opts.checkEgress !== false,
  });
  let next = 0;
  async function worker() {
    while (true) {
      if (typeof opts.shouldStop === 'function' && opts.shouldStop()) return;
      const i = next++;
      if (i >= list.length) return;
      const p = list[i];
      let r;
      try {
        r = await checker.check(p, targetUrl || 'https://example.com', timeoutMs);
      } catch (e) {
        r = { ok: false, ms: 0, reason: 'browser_failed' };
      }
      try { onResult(i, p, r); } catch (_) {}
    }
  }
  try {
    const workers = Math.min(concurrency, Math.max(1, list.length));
    await Promise.all(Array.from({ length: workers }, worker));
  } finally {
    await checker.close();
  }
}

// --- Browser install manager ----------------------------------------------
// Downloads browser installers/zip archives, extracts them, and tracks
// progress via SSE. Installed browsers are stored in a known directory and
// detected by /api/browsers/detect.

const BROWSER_INSTALL_DIR = path.join(platform.appDataDir(), 'browsers');
const BROWSER_REGISTRY_FILE = path.join(BROWSER_INSTALL_DIR, 'registry.json');

// In-memory progress state for active downloads, keyed by browser id.
// Each entry: { id, name, status, percent, downloaded, total, speed, error }
const browserInstallProgress = new Map();
// SSE clients waiting for progress updates
const browserProgressClients = new Set();

// Custom browsers added by the user (persisted in registry.json)
let customBrowsers = [];
let browserRegistryLoaded = false;

function ensureInstallDir() {
  try {
    if (!fs.existsSync(BROWSER_INSTALL_DIR)) {
      fs.mkdirSync(BROWSER_INSTALL_DIR, { recursive: true });
    }
  } catch (_) {}
}

function loadBrowserRegistry() {
  if (browserRegistryLoaded) return;
  try {
    ensureInstallDir();
    if (fs.existsSync(BROWSER_REGISTRY_FILE)) {
      const data = JSON.parse(fs.readFileSync(BROWSER_REGISTRY_FILE, 'utf8'));
      customBrowsers = Array.isArray(data.customBrowsers) ? data.customBrowsers : [];
    }
    browserRegistryLoaded = true;
  } catch (_) {}
}

function saveBrowserRegistry() {
  try {
    ensureInstallDir();
    fs.writeFileSync(BROWSER_REGISTRY_FILE, JSON.stringify({ customBrowsers }, null, 2));
  } catch (_) {}
}

loadBrowserRegistry();

function broadcastBrowserProgress(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of browserProgressClients) {
    try { client.write(msg); } catch (_) {}
  }
}

// Download a file with progress tracking. Returns a Promise that resolves
// with the local file path on completion.
function downloadWithProgress(url, destPath, browserId, browserName) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    let totalBytes = 0;
    let downloadedBytes = 0;
    let lastEmit = 0;
    let startTime = Date.now();

    const req = lib.get(url, { timeout: 30000, headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        downloadWithProgress(res.headers.location, destPath, browserId, browserName).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      totalBytes = parseInt(res.headers['content-length'] || '0', 10);
      const stream = fs.createWriteStream(destPath);
      res.on('data', (chunk) => {
        downloadedBytes += chunk.length;
        const now = Date.now();
        // Emit progress at most every 300ms
        if (now - lastEmit > 300 || downloadedBytes === totalBytes) {
          lastEmit = now;
          const percent = totalBytes > 0 ? Math.round((downloadedBytes / totalBytes) * 100) : 0;
          const elapsed = (now - startTime) / 1000;
          const speed = elapsed > 0 ? downloadedBytes / elapsed : 0;
          const data = {
            id: browserId,
            name: browserName,
            status: 'downloading',
            percent,
            downloaded: downloadedBytes,
            total: totalBytes,
            speed,
          };
          browserInstallProgress.set(browserId, data);
          broadcastBrowserProgress(data);
        }
      });
      res.pipe(stream);
      stream.on('finish', () => {
        stream.close();
        resolve(destPath);
      });
      stream.on('error', reject);
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Download timeout')); });
    req.on('error', reject);
  });
}

// Extract a zip archive to a target directory.
async function extractZipArchive(zipPath, targetDir) {
  try {
    await extractZip(zipPath, { dir: targetDir });
    return true;
  } catch (e) {
    // Fallback 1: PowerShell's Expand-Archive (Windows only).
    if (platform.IS_WIN) {
      try {
        const { execFileSync } = require('child_process');
        execFileSync('powershell', ['-Command', 'Expand-Archive -Path "' + zipPath + '" -DestinationPath "' + targetDir + '" -Force'], { timeout: 120000 });
        return true;
      } catch (_) {}
    }
    // Fallback 2: the `unzip` CLI when it is installed (Linux / macOS).
    if (!platform.IS_WIN) {
      try {
        const { execFileSync } = require('child_process');
        execFileSync('unzip', ['-o', '-q', zipPath, '-d', targetDir], { timeout: 120000 });
        return true;
      } catch (_) {}
    }
    throw e;
  }
}

// Find the browser executable inside an extracted directory.
function findBrowserExe(dir, browserId) {
  try {
    // Common executable names by browser type.
    const exeNames = platform.IS_WIN
      ? {
        'chrome': ['chrome.exe', 'chrome-win64\\chrome.exe', 'chrome-win\\chrome.exe'],
        'chromium': ['chrome.exe', 'chrome-win64\\chrome.exe', 'chrome-win\\chrome.exe'],
        'edge': ['msedge.exe'],
        'brave': ['brave.exe'],
        'vivaldi': ['vivaldi.exe'],
        'opera': ['opera.exe'],
        'opera-gx': ['opera.exe'],
        'firefox': ['firefox.exe'],
        'waterfox': ['waterfox.exe'],
        'librewolf': ['librewolf.exe'],
        'thorium': ['thorium.exe', 'chrome.exe'],
        'ungoogled': ['chrome.exe', 'chrome-win64\\chrome.exe'],
      }
      : {
        'chrome': ['chrome', 'chrome-linux/chrome', 'google-chrome', 'google-chrome-stable'],
        'chromium': ['chrome', 'chrome-linux/chrome', 'chromium', 'chromium-browser'],
        'edge': ['msedge', 'microsoft-edge', 'microsoft-edge-stable', 'msedge-linux64/msedge'],
        'brave': ['brave', 'brave-browser'],
        'vivaldi': ['vivaldi', 'vivaldi-stable'],
        'opera': ['opera'],
        'opera-gx': ['opera'],
        'firefox': ['firefox'],
        'waterfox': ['waterfox'],
        'librewolf': ['librewolf'],
        'thorium': ['thorium', 'chrome'],
        'ungoogled': ['chrome', 'chrome-linux/chrome'],
      };
    const names = exeNames[browserId] || (platform.IS_WIN
      ? ['chrome.exe', 'firefox.exe', 'msedge.exe']
      : ['chrome', 'chromium', 'firefox', 'msedge']);
    // First, try direct paths (normalize separators for the current OS).
    for (const n of names) {
      const p = path.join(dir, ...n.split(/[\\/]+/));
      if (fs.existsSync(p)) return p;
    }
    // Then, search recursively (limited depth)
    function search(d, depth) {
      if (depth > 3) return '';
      try {
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
          if (entry.isDirectory()) {
            const r = search(path.join(d, entry.name), depth + 1);
            if (r) return r;
          } else {
            for (const n of names) {
              if (entry.name === path.basename(n)) return path.join(d, entry.name);
            }
          }
        }
      } catch (_) {}
      return '';
    }
    return search(dir, 0);
  } catch (_) {
    return '';
  }
}

// Install a browser: download → extract → find exe → register
async function installBrowserTask(id, name, url) {
  ensureInstallDir();
  const browserDir = path.join(BROWSER_INSTALL_DIR, id);
  const archivePath = path.join(BROWSER_INSTALL_DIR, id + '.zip');

  // Check if already installed
  const registry = getInstalledBrowsers();
  const existing = registry.find(b => b.id === id && b.path && fs.existsSync(b.path));
  if (existing) {
    broadcastBrowserProgress({ id, name, status: 'complete' });
    return;
  }

  try {
    // Step 1: Download
    broadcastBrowserProgress({ id, name, status: 'downloading', percent: 0, downloaded: 0, total: 0, speed: 0 });
    await downloadWithProgress(url, archivePath, id, name);

    // Step 2: Extract
    broadcastBrowserProgress({ id, name, status: 'extracting' });
    if (!fs.existsSync(browserDir)) fs.mkdirSync(browserDir, { recursive: true });
    const ext = path.extname(url).toLowerCase();
    if (ext === '.zip' || url.includes('.zip')) {
      await extractZipArchive(archivePath, browserDir);
    } else if (ext === '.exe') {
      // For .exe installers, just keep the installer — user can run it
      // Move it to the browser dir
      fs.copyFileSync(archivePath, path.join(browserDir, path.basename(url)));
    } else {
      // Try zip extraction as fallback
      await extractZipArchive(archivePath, browserDir);
    }

    // Step 3: Find executable
    const exePath = findBrowserExe(browserDir, id);
    if (exePath) {
      // Register the browser
      const installed = getInstalledBrowsers();
      const idx = installed.findIndex(b => b.id === id);
      const entry = { id, name, path: exePath, dir: browserDir, installedAt: new Date().toISOString() };
      if (idx >= 0) installed[idx] = entry;
      else installed.push(entry);
      saveInstalledBrowsers(installed);
    }

    // Clean up archive
    try { fs.unlinkSync(archivePath); } catch (_) {}

    broadcastBrowserProgress({ id, name, status: 'complete' });
  } catch (e) {
    broadcastBrowserProgress({ id, name, status: 'error', error: e.message });
  }
}

// Installed browsers registry (separate from custom browsers)
const INSTALLED_BROWSERS_FILE = path.join(BROWSER_INSTALL_DIR, 'installed.json');
let installedBrowsersCache = null;

function getInstalledBrowsers() {
  if (installedBrowsersCache !== null) return installedBrowsersCache;
  try {
    ensureInstallDir();
    if (fs.existsSync(INSTALLED_BROWSERS_FILE)) {
      installedBrowsersCache = JSON.parse(fs.readFileSync(INSTALLED_BROWSERS_FILE, 'utf8'));
      return installedBrowsersCache;
    }
  } catch (_) {}
  installedBrowsersCache = [];
  return installedBrowsersCache;
}

function saveInstalledBrowsers(list) {
  try {
    ensureInstallDir();
    fs.writeFileSync(INSTALLED_BROWSERS_FILE, JSON.stringify(list, null, 2));
    installedBrowsersCache = list; // Update cache
  } catch (_) {}
}

// System-installed browser detection — scans common paths for all
// browsers in the BROWSERS list.
function detectSystemBrowsers() {
  // Linux / macOS: scan native package locations and PATH.
  if (!platform.IS_WIN) return platform.detectPosixBrowsers();

  const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const localAppData = process.env['LOCALAPPDATA'] || path.join(os.homedir(), 'AppData', 'Local');

  const paths = {
    'chromium': [findCachedChromiumSafe()],
    'chrome': [
      path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ],
    'chrome-beta': [
      path.join(programFiles, 'Google', 'Chrome Beta', 'Application', 'chrome.exe'),
      path.join(programFilesX86, 'Google', 'Chrome Beta', 'Application', 'chrome.exe'),
    ],
    'chrome-dev': [
      path.join(programFiles, 'Google', 'Chrome Dev', 'Application', 'chrome.exe'),
      path.join(programFilesX86, 'Google', 'Chrome Dev', 'Application', 'chrome.exe'),
    ],
    'chrome-canary': [
      path.join(programFiles, 'Google', 'Chrome SxS', 'Application', 'chrome.exe'),
      path.join(programFilesX86, 'Google', 'Chrome SxS', 'Application', 'chrome.exe'),
    ],
    'edge': [
      path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ],
    'edge-beta': [
      path.join(programFilesX86, 'Microsoft', 'Edge Beta', 'Application', 'msedge.exe'),
    ],
    'edge-dev': [
      path.join(programFilesX86, 'Microsoft', 'Edge Dev', 'Application', 'msedge.exe'),
    ],
    'edge-canary': [
      path.join(programFilesX86, 'Microsoft', 'Edge SxS', 'Application', 'msedge.exe'),
    ],
    'brave': [
      path.join(programFiles, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
      path.join(programFilesX86, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    ],
    'brave-beta': [
      path.join(programFiles, 'BraveSoftware', 'Brave-Browser-Beta', 'Application', 'brave.exe'),
      path.join(programFilesX86, 'BraveSoftware', 'Brave-Browser-Beta', 'Application', 'brave.exe'),
    ],
    'brave-nightly': [
      path.join(programFiles, 'BraveSoftware', 'Brave-Browser-Nightly', 'Application', 'brave.exe'),
      path.join(programFilesX86, 'BraveSoftware', 'Brave-Browser-Nightly', 'Application', 'brave.exe'),
    ],
    'vivaldi': [
      path.join(localAppData, 'Vivaldi', 'Application', 'vivaldi.exe'),
      path.join(programFiles, 'Vivaldi', 'Application', 'vivaldi.exe'),
    ],
    'opera': [
      path.join(localAppData, 'Programs', 'Opera', 'opera.exe'),
      path.join(programFiles, 'Opera', 'opera.exe'),
    ],
    'opera-gx': [
      path.join(localAppData, 'Programs', 'Opera GX', 'opera.exe'),
      path.join(programFiles, 'Opera GX', 'opera.exe'),
    ],
    'firefox': [
      path.join(programFiles, 'Mozilla Firefox', 'firefox.exe'),
      path.join(programFilesX86, 'Mozilla Firefox', 'firefox.exe'),
    ],
    'firefox-beta': [
      path.join(programFiles, 'Mozilla Firefox', 'firefox.exe'),
      path.join(programFilesX86, 'Mozilla Firefox', 'firefox.exe'),
    ],
    'firefox-dev': [
      path.join(programFiles, 'Firefox Developer Edition', 'firefox.exe'),
      path.join(programFilesX86, 'Firefox Developer Edition', 'firefox.exe'),
    ],
    'firefox-nightly': [
      path.join(programFiles, 'Nightly', 'firefox.exe'),
      path.join(programFilesX86, 'Nightly', 'firefox.exe'),
    ],
    'waterfox': [
      path.join(programFiles, 'Waterfox', 'waterfox.exe'),
      path.join(programFilesX86, 'Waterfox', 'waterfox.exe'),
    ],
    'librewolf': [
      path.join(programFiles, 'LibreWolf', 'librewolf.exe'),
      path.join(programFilesX86, 'LibreWolf', 'librewolf.exe'),
    ],
    'thorium': [
      path.join(programFiles, 'Thorium', 'thorium.exe'),
      path.join(programFilesX86, 'Thorium', 'thorium.exe'),
    ],
    'maxthon': [
      path.join(programFiles, 'Maxthon', 'Maxthon.exe'),
      path.join(programFilesX86, 'Maxthon', 'Maxthon.exe'),
    ],
    'slimjet': [
      path.join(programFiles, 'Slimjet', 'slimjet.exe'),
      path.join(programFilesX86, 'Slimjet', 'slimjet.exe'),
    ],
  };

  const detected = [];
  for (const [id, candidatePaths] of Object.entries(paths)) {
    for (const p of candidatePaths) {
      if (p && safeExists(p)) {
        detected.push({ id, path: p });
        break;
      }
    }
  }
  return detected;
}
// The Organic Search module expects engine objects with:
//   { id, name, homepage, searchUrl (with {query} placeholder), enabled }
const SEARCH_ENGINES = {
  google: {
    id: 'google', name: 'Google',
    homepage: 'https://www.google.com',
    searchUrl: 'https://www.google.com/search?q={query}',
    enabled: true,
  },
  bing: {
    id: 'bing', name: 'Bing',
    homepage: 'https://www.bing.com',
    searchUrl: 'https://www.bing.com/search?q={query}',
    enabled: true,
  },
  yahoo: {
    id: 'yahoo', name: 'Yahoo',
    homepage: 'https://search.yahoo.com',
    searchUrl: 'https://search.yahoo.com/search?p={query}',
    enabled: true,
  },
  duckduckgo: {
    id: 'duckduckgo', name: 'DuckDuckGo',
    homepage: 'https://duckduckgo.com',
    searchUrl: 'https://duckduckgo.com/?q={query}',
    enabled: true,
  },
  yandex: {
    id: 'yandex', name: 'Yandex',
    homepage: 'https://yandex.com',
    searchUrl: 'https://yandex.com/search/?text={query}',
    enabled: true,
  },
  ask: {
    id: 'ask', name: 'Ask',
    homepage: 'https://www.ask.com',
    searchUrl: 'https://www.ask.com/web?q={query}',
    enabled: true,
  },
};

// --- Social platform definitions ------------------------------------------
// SocialTraffic.js expects { id, name, url } objects.
const SOCIAL_PLATFORMS = {
  facebook: { id: 'facebook', name: 'Facebook', url: 'https://www.facebook.com' },
  youtube: { id: 'youtube', name: 'YouTube', url: 'https://www.youtube.com' },
  tiktok: { id: 'tiktok', name: 'TikTok', url: 'https://www.tiktok.com' },
  instagram: { id: 'instagram', name: 'Instagram', url: 'https://www.instagram.com' },
  twitter: { id: 'twitter', name: 'X (Twitter)', url: 'https://twitter.com' },
  reddit: { id: 'reddit', name: 'Reddit', url: 'https://www.reddit.com' },
  linkedin: { id: 'linkedin', name: 'LinkedIn', url: 'https://www.linkedin.com' },
  pinterest: { id: 'pinterest', name: 'Pinterest', url: 'https://www.pinterest.com' },
};

// --- Helpers ---------------------------------------------------------------

function sendJSON(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(body);
}

// Dashboard asset allowlist. Everything else (server.js, package.json,
// proxies.json, RPA recordings, .env, ...) is never served over HTTP.
const DASHBOARD_ASSETS = new Map([
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/i18n.js', 'i18n.js'],
  ['/browser-logos.js', 'browser-logos.js'],
  ['/Automation controller.js', 'Automation controller.js'],
  ['/Scrollscrollingsystem .js', 'Scrollscrollingsystem .js'],
  ['/logo.png', 'logo.png'],
]);

const STATIC_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function serveDashboardAsset(pathname, req, res) {
  let name = '';
  try { name = decodeURIComponent(pathname || ''); } catch (_) { name = ''; }
  if (!name) name = '/';
  const file = DASHBOARD_ASSETS.get(name);
  if (!file) return false;
  const full = path.join(__dirname, file);
  try {
    const data = fs.readFileSync(full);
    const ext = path.extname(full).toLowerCase();
    res.writeHead(200, {
      'Content-Type': STATIC_MIME[ext] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') res.end();
    else res.end(data);
    return true;
  } catch (_) {
    return false;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

// Wrap a plain proxy array into the { useProxies, proxies, workingProxies }
// shape the traffic modules expect.
function normalizeProxies(raw, checkUrl) {
  const url = typeof checkUrl === 'string' && /^https?:\/\//i.test(checkUrl.trim()) ? checkUrl.trim() : '';
  if (!raw) return { useProxies: false, proxies: [], workingProxies: [], checkUrl: url };
  if (Array.isArray(raw)) {
    return { useProxies: raw.length > 0, proxies: raw, workingProxies: [], checkUrl: url };
  }
  // Already an object — ensure required fields exist.
  return {
    useProxies: !!raw.useProxies,
    proxies: raw.proxies || [],
    workingProxies: raw.workingProxies || [],
    checkUrl: raw.checkUrl || url,
  };
}

// Attach log/status listeners to a campaign emitter and store the process.
function registerProcess(type, config, emitter) {
  const id = `proc_${nextProcessId++}`;
  const proc = { id, type, config, emitter, logs: [], status: 'starting' };
  processes.set(id, proc);

  emitter.on('log', (msg, logType) => {
    const entry = {
      time: new Date().toISOString(),
      type: logType || 'info',
      message: typeof msg === 'string' ? msg : JSON.stringify(msg),
    };
    proc.logs.push(entry);
    // Cap log buffer to prevent unbounded memory growth.
    if (proc.logs.length > 2000) proc.logs.shift();
  });

  emitter.on('status', (status) => {
    proc.status = status;
  });

  emitter.on('stats', (stats) => {
    proc.stats = stats;
  });

  emitter.on('summary', (summary) => {
    proc.summary = summary;
  });

  return id;
}

// --- Config builders -------------------------------------------------------

function buildOrganicConfig(body) {
  const engineId = (body.engine || 'google').toLowerCase();
  const engineObj = SEARCH_ENGINES[engineId] || SEARCH_ENGINES.google;

  // The Organic module expects `keywords` as an array and `searchEngines`
  // as an array of engine objects.
  const keywords = body.keyword
    ? body.keyword.split('\n').map(k => k.trim()).filter(Boolean)
    : (body.keywords || []);

  return {
    targetUrl: body.url || body.targetUrl || '',
    keywords,
    searchEngines: [engineObj],
    assignedEngine: engineObj,
    maxPages: body.maxPages || 1,
    mixedModeEnabled: false,
    distributionStrategy: 'random',
    sessions: parseInt(body.sessions, 10) || 1,
    threads: parseInt(body.threads, 10) || 1,
    headless: !!body.headless,
    proxy: body.proxy || null,
    userAgents: body.userAgents || [],
    uaAutoRotate: body.uaAutoRotate || body.uaMode === 'rotate',
    device: body.device || 'desktop',
    customBrowserPath: body.customBrowserPath || '',
    browserEngine: body.browserEngine || 'chromium',
    scrollLinkSystem: body.scrollLinkSystem || false,
    scrollMode: body.scrollMode || 'natural',
    scrollDirection: body.scrollDirection || 'down',
    scrollDistance: parseInt(body.scrollDistance, 10) || 800,
    scrollDuration: parseInt(body.scrollDuration, 10) || 5000,
    scrollDownWaitMs: parseInt(body.scrollDownWaitMs, 10) || 1500,
    scrollUpWaitMs: parseInt(body.scrollUpWaitMs, 10) || 1500,
    scrollingInternalPagesEnabled: body.internalLinkNavigation || body.scrollLinkSystem || false,
    internalPagesCount: parseInt(body.internalLinkCount, 10) || 0,
    internalScrollMode: body.scrollDirection || 'random',
    internalPageWaitMs: parseInt(body.internalLinkReadTime, 10) || 3000,
    internalLinkNavigation: body.internalLinkNavigation || false,
    articlesToRead: body.articlesToRead || 0,
    visitTimeMs: parseInt(body.visitTimeMs, 10) || 20000,
    internalLinkVisitTimeMs: parseInt(body.internalLinkVisitTimeMs, 10) || 10000,
    viewportWidth: parseInt(body.viewportWidth, 10) || 1280,
    viewportHeight: parseInt(body.viewportHeight, 10) || 800,
    autoRotateResolutions: body.autoRotateResolutions || null,
    proxies: normalizeProxies(body.proxies, body.url || body.targetUrl || ''),
    proxyWarmupMs: parseInt(body.proxyWarmupMs, 10) || 15000,
    privacyFeatures: body.privacyFeatures || [],
    privacyLevel: body.privacyLevel || 'standard',
    randomClicks: body.randomClicks || null,
    trafficSource: require('./TrafficSource.js').normalizeTrafficSource(body.trafficSource),
  };
}

function buildDirectConfig(body) {
  return {
    targetUrl: body.url || body.targetUrl || '',
    sessions: parseInt(body.sessions, 10) || 1,
    threads: parseInt(body.threads, 10) || 1,
    headless: !!body.headless,
    proxy: body.proxy || null,
    userAgents: body.userAgents || [],
    uaAutoRotate: body.uaAutoRotate || body.uaMode === 'rotate',
    device: body.device || 'desktop',
    customBrowserPath: body.customBrowserPath || '',
    browserEngine: body.browserEngine || 'chromium',
    scrollLinkSystem: body.scrollLinkSystem || false,
    scrollMode: body.scrollMode || 'natural',
    scrollDirection: body.scrollDirection || 'down',
    scrollDistance: parseInt(body.scrollDistance, 10) || 800,
    scrollDuration: parseInt(body.scrollDuration, 10) || 5000,
    scrollDownWaitMs: parseInt(body.scrollDownWaitMs, 10) || 1500,
    scrollUpWaitMs: parseInt(body.scrollUpWaitMs, 10) || 1500,
    scrollingInternalPagesEnabled: body.internalLinkNavigation || body.scrollLinkSystem || false,
    internalPagesCount: parseInt(body.internalLinkCount, 10) || 0,
    internalScrollMode: body.scrollDirection || 'random',
    internalPageWaitMs: parseInt(body.internalLinkReadTime, 10) || 3000,
    visitTimeMs: parseInt(body.visitTimeMs, 10) || 20000,
    viewportWidth: parseInt(body.viewportWidth, 10) || 1280,
    viewportHeight: parseInt(body.viewportHeight, 10) || 800,
    autoRotateResolutions: body.autoRotateResolutions || null,
    proxies: normalizeProxies(body.proxies, body.url || body.targetUrl || ''),
    privacyFeatures: body.privacyFeatures || [],
    privacyLevel: body.privacyLevel || 'standard',
    randomClicks: body.randomClicks || null,
    trafficSource: require('./TrafficSource.js').normalizeTrafficSource(body.trafficSource),
  };
}

function buildReferralConfig(body) {
  // Referral Traffic = SocialTraffic.js with the selected platform.
  const platformId = (body.platform || 'random').toLowerCase();
  let platforms;
  if (platformId === 'random') {
    platforms = Object.values(SOCIAL_PLATFORMS);
  } else {
    const p = SOCIAL_PLATFORMS[platformId];
    platforms = p ? [p] : Object.values(SOCIAL_PLATFORMS);
  }

  return {
    targetUrl: body.url || body.targetUrl || '',
    sessions: parseInt(body.sessions, 10) || 1,
    threads: parseInt(body.threads, 10) || 1,
    headless: !!body.headless,
    socialPlatforms: platforms,
    socialStayTime: parseInt(body.socialStayTime, 10) || 15,
    socialRedirectDelay: parseInt(body.socialRedirectDelay, 10) || 3,
    socialLaunchBehavior: body.socialLaunchBehavior || 'platform_then_target',
    userAgents: body.userAgents || [],
    uaAutoRotate: body.uaAutoRotate || body.uaMode === 'rotate',
    device: body.device || 'desktop',
    customBrowserPath: body.customBrowserPath || '',
    browserEngine: body.browserEngine || 'chromium',
    scrollLinkSystem: body.scrollLinkSystem || false,
    scrollMode: body.scrollMode || 'natural',
    scrollDirection: body.scrollDirection || 'down',
    scrollDistance: parseInt(body.scrollDistance, 10) || 800,
    scrollDuration: parseInt(body.scrollDuration, 10) || 5000,
    scrollDownWaitMs: parseInt(body.scrollDownWaitMs, 10) || 1500,
    scrollUpWaitMs: parseInt(body.scrollUpWaitMs, 10) || 1500,
    scrollingInternalPagesEnabled: body.internalLinkNavigation || body.scrollLinkSystem || false,
    internalPagesCount: parseInt(body.internalLinkCount, 10) || 0,
    internalScrollMode: body.scrollDirection || 'random',
    internalPageWaitMs: parseInt(body.internalLinkReadTime, 10) || 3000,
    visitTimeMs: parseInt(body.visitTimeMs, 10) || 20000,
    viewportWidth: parseInt(body.viewportWidth, 10) || 1280,
    viewportHeight: parseInt(body.viewportHeight, 10) || 800,
    autoRotateResolutions: body.autoRotateResolutions || null,
    proxies: normalizeProxies(body.proxies, body.url || body.targetUrl || ''),
    privacyFeatures: body.privacyFeatures || [],
    privacyLevel: body.privacyLevel || 'standard',
    randomClicks: body.randomClicks || null,
    trafficSource: require('./TrafficSource.js').normalizeTrafficSource(body.trafficSource),
  };
}

function buildGmapsConfig(body) {
  return {
    businessName: body.restaurant || body.businessName || '',
    keyword: body.keyword || body.restaurant || '',
    targetUrl: body.website || body.targetUrl || '',
    sessions: parseInt(body.sessions, 10) || 1,
    threads: parseInt(body.threads, 10) || 1,
    headless: !!body.headless,
    proxy: body.proxy || null,
    device: body.device || 'desktop',
    userAgents: body.userAgents || [],
    uaAutoRotate: body.uaAutoRotate || body.uaMode === 'rotate',
    customBrowserPath: body.customBrowserPath || '',
    browserEngine: body.browserEngine || 'chromium',
    scrollLinkSystem: body.scrollLinkSystem || false,
    scrollMode: body.scrollMode || 'natural',
    scrollDirection: body.scrollDirection || 'down',
    scrollDistance: parseInt(body.scrollDistance, 10) || 800,
    scrollDuration: parseInt(body.scrollDuration, 10) || 5000,
    scrollDownWaitMs: parseInt(body.scrollDownWaitMs, 10) || 1500,
    scrollUpWaitMs: parseInt(body.scrollUpWaitMs, 10) || 1500,
    scrollingInternalPagesEnabled: body.internalLinkNavigation || body.scrollLinkSystem || false,
    internalPagesCount: parseInt(body.internalLinkCount, 10) || 0,
    internalScrollMode: body.scrollDirection || 'random',
    internalPageWaitMs: parseInt(body.internalLinkReadTime, 10) || 3000,
    visitTimeMs: parseInt(body.visitTimeMs, 10) || 20000,
    viewportWidth: parseInt(body.viewportWidth, 10) || 1280,
    viewportHeight: parseInt(body.viewportHeight, 10) || 800,
    autoRotateResolutions: body.autoRotateResolutions || null,
    mapsLoadWaitMs: parseInt(body.mapsLoadWaitMs, 10) || 8000,
    searchResultWaitMs: parseInt(body.searchResultWaitMs, 10) || 8000,
    websiteLoadWaitMs: parseInt(body.websiteLoadWaitMs, 10) || 5000,
    typingDelayMs: parseInt(body.typingDelayMs, 10) || 80,
    stepRetryAttempts: parseInt(body.stepRetryAttempts, 10) || 5,
    stepRetryDelayMs: parseInt(body.stepRetryDelayMs, 10) || 5000,
    proxies: normalizeProxies(body.proxies, body.website || body.targetUrl || 'https://www.google.com/maps'),
    privacyFeatures: body.privacyFeatures || [],
    privacyLevel: body.privacyLevel || 'standard',
    randomClicks: body.randomClicks || null,
    trafficSource: require('./TrafficSource.js').normalizeTrafficSource(body.trafficSource),
  };
}

// --- Route handlers --------------------------------------------------------

async function handleRequest(req, res) {
  const parsed = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = parsed.pathname;
  const method = req.method;

  // CORS preflight
  if (method === 'OPTIONS') {
    sendJSON(res, 204, {});
    return;
  }

  // --- Health check ---
  if (pathname === '/api/health' && method === 'GET') {
    sendJSON(res, 200, { success: true, status: 'ok', processes: processes.size });
    return;
  }

  // --- System preflight (read-only) ---
  if (pathname === '/api/system/check' && method === 'GET') {
    try {
      const Diagnostics = require('./Diagnostics.js');
      const info = Diagnostics.collectSystemInfo({ runningCampaigns: processes.size });
      sendJSON(res, 200, Object.assign({ success: true }, info));
    } catch (e) {
      sendJSON(res, 500, { success: false, error: e.message });
    }
    return;
  }

  // --- Fingerprint audit (one short-lived headless browser, nothing is saved) ---
  if (pathname === '/api/diagnostics/fingerprint' && method === 'POST') {
    let body = {};
    try {
      body = await readBody(req);
    } catch (e) {
      sendJSON(res, 400, { success: false, error: 'invalid JSON body' });
      return;
    }
    try {
      const Diagnostics = require('./Diagnostics.js');
      const result = await Diagnostics.runFingerprintAudit({
        userAgent: body.userAgent || body.ua || '',
        device: body.device || 'desktop',
        viewportWidth: body.viewportWidth,
        viewportHeight: body.viewportHeight,
        deviceScaleFactor: body.deviceScaleFactor,
        timezone: body.timezone || '',
        privacyFeatures: Array.isArray(body.privacyFeatures) ? body.privacyFeatures : [],
        privacyLevel: body.privacyLevel || 'standard',
        onLog: () => {},
      });
      sendJSON(res, 200, Object.assign({ success: true }, result));
    } catch (e) {
      sendJSON(res, 500, { success: false, error: e.message });
    }
    return;
  }

  // --- Browser detection ---
  if (pathname === '/api/browsers/detect' && method === 'GET') {
    loadBrowserRegistry();
    const systemBrowsers = detectSystemBrowsers();
    const installed = getInstalledBrowsers();
    const browsers = [
      { id: 'chromium', name: 'Chromium (Playwright)', path: findCachedChromiumSafe() },
      { id: 'custom', name: 'Custom Path', path: '' },
    ];
    // Add system-detected browsers
    for (const sb of systemBrowsers) {
      const idx = browsers.findIndex(b => b.id === sb.id);
      if (idx >= 0) {
        browsers[idx].path = sb.path;
      } else {
        const names = {
          'chrome': 'Google Chrome', 'chrome-beta': 'Chrome Beta', 'chrome-dev': 'Chrome Dev',
          'chrome-canary': 'Chrome Canary', 'edge': 'Microsoft Edge', 'edge-beta': 'Edge Beta',
          'edge-dev': 'Edge Dev', 'edge-canary': 'Edge Canary', 'brave': 'Brave',
          'brave-beta': 'Brave Beta', 'brave-nightly': 'Brave Nightly', 'vivaldi': 'Vivaldi',
          'opera': 'Opera', 'opera-gx': 'Opera GX', 'firefox': 'Mozilla Firefox',
          'firefox-dev': 'Firefox Developer', 'firefox-nightly': 'Firefox Nightly',
          'waterfox': 'Waterfox', 'librewolf': 'LibreWolf', 'thorium': 'Thorium',
          'maxthon': 'Maxthon', 'slimjet': 'Slimjet',
        };
        browsers.push({ id: sb.id, name: names[sb.id] || sb.id, path: sb.path });
      }
    }
    // Add NGF NOMI TOOLS-installed browsers
    for (const ib of installed) {
      if (ib.path && fs.existsSync(ib.path)) {
        const idx = browsers.findIndex(b => b.id === ib.id);
        if (idx >= 0) {
          browsers[idx].path = ib.path;
        } else {
          browsers.push({ id: ib.id, name: ib.name, path: ib.path });
        }
      }
    }
    // Add custom browsers
    for (const cb of customBrowsers) {
      if (cb.path && fs.existsSync(cb.path)) {
        browsers.push({ id: cb.id, name: cb.name, path: cb.path });
      }
    }
    sendJSON(res, 200, { success: true, browsers, installed, customBrowsers });
    return;
  }

  // --- Browsers: install (download + extract) ---
  if (pathname === '/api/browsers/install' && method === 'POST') {
    const body = await readBody(req);
    const id = body.id;
    const name = body.name || id;
    const url = body.url;
    if (!id || !url) {
      sendJSON(res, 400, { success: false, error: 'id and url are required' });
      return;
    }
    // Start the install in the background
    installBrowserTask(id, name, url).catch(() => {});
    sendJSON(res, 200, { success: true, message: 'Install started' });
    return;
  }

  // --- Browsers: progress (SSE stream) ---
  if (pathname === '/api/browsers/progress' && method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write('retry: 2000\n\n');
    // Send current state for all in-progress installs
    for (const [id, data] of browserInstallProgress) {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    }
    browserProgressClients.add(res);
    req.on('close', () => { browserProgressClients.delete(res); });
    return;
  }

  // --- Browsers: add custom browser ---
  if (pathname === '/api/browsers/add' && method === 'POST') {
    loadBrowserRegistry();
    const body = await readBody(req);
    const id = body.id || ('custom-' + Date.now());
    const name = body.name || 'Custom Browser';
    const browserPath = body.path || '';
    if (!browserPath || !fs.existsSync(browserPath)) {
      sendJSON(res, 400, { success: false, error: 'Invalid browser path' });
      return;
    }
    const entry = { id, name, path: browserPath, addedAt: new Date().toISOString() };
    // Replace if same id exists
    const idx = customBrowsers.findIndex(b => b.id === id);
    if (idx >= 0) customBrowsers[idx] = entry;
    else customBrowsers.push(entry);
    saveBrowserRegistry();
    sendJSON(res, 200, { success: true, browser: entry });
    return;
  }

  // --- Browsers: remove custom browser ---
  if (pathname === '/api/browsers/remove' && method === 'POST') {
    loadBrowserRegistry();
    const body = await readBody(req);
    const id = body.id;
    if (!id) { sendJSON(res, 400, { success: false, error: 'id required' }); return; }
    customBrowsers = customBrowsers.filter(b => b.id !== id);
    saveBrowserRegistry();
    sendJSON(res, 200, { success: true });
    return;
  }

  // --- Browsers: list installed ---
  if (pathname === '/api/browsers/installed' && method === 'GET') {
    loadBrowserRegistry();
    const installed = getInstalledBrowsers().filter(b => b.path && fs.existsSync(b.path));
    sendJSON(res, 200, { success: true, installed, customBrowsers });
    return;
  }

  // --- Browsers: launch (open a browser for testing) ---
  if (pathname === '/api/browsers/launch' && method === 'POST') {
    const body = await readBody(req);
    const browserPath = body.path;
    if (!browserPath || !fs.existsSync(browserPath)) {
      sendJSON(res, 400, { success: false, error: 'Browser not found' });
      return;
    }
    try {
      const { execFile } = require('child_process');
      const args = body.url ? [body.url] : [];
      execFile(browserPath, args, { detached: true, stdio: 'ignore' }).unref();
      sendJSON(res, 200, { success: true });
    } catch (e) {
      sendJSON(res, 500, { success: false, error: e.message });
    }
    return;
  }

  // --- Proxies: GET ---
  if (pathname === '/api/proxies' && method === 'GET') {
    const summary = { total: loadedProxies.length, ok: 0, dead: 0, unknown: 0 };
    for (const p of loadedProxies) {
      if (p && p.status === 'ok') summary.ok++;
      else if (p && p.status === 'dead') summary.dead++;
      else summary.unknown++;
    }
    // Distinct exit IPs + how many safe sessions the 12 h policy still allows.
    try {
      const okPool = loadedProxies.filter(p => p && p.status === 'ok');
      const pool = buildRotationPool({ workingProxies: okPool, proxies: loadedProxies });
      summary.distinctExits = pool.length;
      summary.rotation = getProxyUsageSnapshot(pool);
    } catch (_) {}
    sendJSON(res, 200, { success: true, proxies: loadedProxies, summary, rotation: summary.rotation || null });
    return;
  }

  // --- Proxies: load (append to existing list) ---
  if (pathname === '/api/proxies/load' && method === 'POST') {
    const body = await readBody(req);
    const incoming = Array.isArray(body.proxies) ? body.proxies : [];
    // De-duplicate by host:port:type to avoid loading the same proxy twice
    const seen = new Set(loadedProxies.map(p => proxyStoreKey(p)));
    let added = 0;
    let skipped = 0;
    for (const p of incoming) {
      if (!p || !p.host || !p.port || /\s/.test(String(p.host))) { skipped++; continue; }
      const port = parseInt(p.port, 10);
      if (!port || port < 1 || port > 65535) { skipped++; continue; }
      const key = proxyStoreKey(p);
      if (!seen.has(key)) {
        loadedProxies.push({
          type: String(p.type || 'http').toLowerCase(),
          host: String(p.host),
          port,
          username: p.username || null,
          password: p.password || null,
          raw: p.raw || (p.host + ':' + p.port),
          status: p.status === 'ok' || p.status === 'dead' ? p.status : 'unknown',
        });
        seen.add(key);
        added++;
      }
    }
    saveProxiesToDisk();
    sendJSON(res, 200, { success: true, count: loadedProxies.length, added, skipped });
    return;
  }

  // --- Proxies: scrape (fetch free proxies from public sources) ---
  if (pathname === '/api/proxies/scrape' && method === 'POST') {
    try {
      const scraped = await scrapeProxyList();
      // Append scraped proxies to the loaded list (de-duplicated)
      const seen = new Set(loadedProxies.map(p => `${p.type}:${p.host}:${p.port}`));
      let added = 0;
      for (const p of scraped) {
        const key = `${p.type}:${p.host}:${p.port}`;
        if (!seen.has(key)) {
          loadedProxies.push(p);
          seen.add(key);
          added++;
        }
      }
      saveProxiesToDisk();
      sendJSON(res, 200, { success: true, scraped: scraped.length, added, total: loadedProxies.length, proxies: scraped });
    } catch (e) {
      sendJSON(res, 500, { success: false, error: e.message });
    }
    return;
  }

  // --- Proxies: validate (background job, results streamed) ---
  if (pathname === '/api/proxies/validate/start' && method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    const supplied = Array.isArray(body.proxies) && body.proxies.length > 0 ? body.proxies : null;
    const keyOf = (p) => (String(p.type || 'http').toLowerCase()) + ':' + p.host + ':' + p.port;
    const normalize = (p) => ({
      type: String(p.type || 'http').toLowerCase(),
      host: String(p.host),
      port: parseInt(p.port, 10),
      username: p.username || null,
      password: p.password || null,
      raw: p.raw || (p.host + ':' + p.port),
    });
    const valid = (p) => { const port = p && parseInt(p.port, 10); return !!(p && p.host && port && port > 0 && port < 65536 && !/\s/.test(String(p.host))); };

    // The UI sends the list it is showing. Sync any missing entries into the
    // persistent store so validation results (and bulk removal) apply to
    // exactly the proxies the user sees, not a stale disk snapshot.
    if (supplied) {
      const seen = new Set(loadedProxies.map(proxyStoreKey));
      let added = 0;
      for (const raw of supplied) {
        if (!valid(raw)) continue;
        const p = normalize(raw);
        const key = keyOf(p);
        if (seen.has(key)) continue;
        loadedProxies.push({ ...p, status: 'unknown' });
        seen.add(key);
        added++;
      }
      if (added) { try { saveProxiesToDisk(); } catch (_) {} }
    }

    const list = (supplied || loadedProxies).filter(valid).map(normalize);
    if (!list.length) {
      sendJSON(res, 400, { success: false, error: 'No valid proxies to validate' });
      return;
    }

    const targetUrl = typeof body.targetUrl === 'string' && /^https?:\/\//i.test(body.targetUrl.trim()) ? body.targetUrl.trim() : null;
    const mode = body.mode === 'browser' ? 'browser' : 'reachability';
    const jobId = 'vj_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const job = { total: list.length, queue: [], done: false, cancelled: false, createdAt: Date.now(), mode };
    validationJobs.set(jobId, job);
    (async () => {
      try {
        if (mode === 'browser') {
          await runBrowserValidation(list, targetUrl, (i, p, r) => {
            if (job.cancelled) return;
            const key = keyOf(p);
            recordProxyResult(key, r, targetUrl);
            job.queue.push({
              key,
              ok: !!r.ok,
              ms: r.ms,
              reason: r.reason || (r.ok ? 'ok' : 'failed'),
              egressIp: r.egressIp || '',
              country: r.country || '',
              countryCode: r.countryCode || '',
              timezone: r.timezone || '',
              localIpMatched: !!r.localIpMatched,
            });
          }, {
            timeoutMs: body.timeoutMs,
            concurrency: body.concurrency,
            checkEgress: body.checkEgress,
            shouldStop: () => job.cancelled,
          });
        } else {
          // Bounded worker pool. A huge burst (hundreds of sockets) could
          // stall the HTTP server, which made the UI look "stuck" until the
          // app was restarted.
          const concurrency = Math.max(1, Math.min(20, parseInt(body.concurrency, 10) || 12));
          let next = 0;
          async function worker() {
            while (true) {
              if (job.cancelled) return;
              const i = next++;
              if (i >= list.length) return;
              const p = list[i];
              let r;
              try { r = await validateProxy(p, 4000, targetUrl); } catch (e) { r = { ok: false, ms: 0, reason: 'failed' }; }
              if (job.cancelled) return;
              const key = keyOf(p);
              recordProxyResult(key, r);
              job.queue.push({ key, ok: !!r.ok, ms: r.ms, reason: r.reason || (r.ok ? 'ok' : 'failed') });
            }
          }
          await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker));
        }
      } catch (e) {
        job.error = e.message;
      } finally {
        job.done = true;
        try { saveProxiesToDisk(); } catch (_) {}
        setTimeout(() => validationJobs.delete(jobId), 10 * 60 * 1000);
      }
    })();
    sendJSON(res, 200, { success: true, jobId, total: list.length, mode });
    return;
  }

  // --- Proxies: cancel a running validation job ---
  if (pathname === '/api/proxies/validate/cancel' && method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    const job = validationJobs.get(body.job || '');
    if (job) { job.cancelled = true; job.done = true; }
    sendJSON(res, 200, { success: true, cancelled: !!job });
    return;
  }

  // --- Proxies: validation progress (only new results since `from`) ---
  if (pathname === '/api/proxies/validate/progress' && method === 'GET') {
    const q = new URL(req.url, 'http://localhost');
    const jobId = q.searchParams.get('job') || '';
    const from = Math.max(0, parseInt(q.searchParams.get('from') || '0', 10) || 0);
    const job = validationJobs.get(jobId);
    if (!job) { sendJSON(res, 404, { success: false, error: 'job not found' }); return; }
    sendJSON(res, 200, {
      success: true,
      done: job.done,
      total: job.total,
      processed: job.queue.length,
      mode: job.mode || 'reachability',
      error: job.error || '',
      results: job.queue.slice(from),
    });
    return;
  }

  // --- Proxies: validate (real validation — tests each proxy) ---
  if (pathname === '/api/proxies/validate' && method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    const toValidate = Array.isArray(body.proxies) && body.proxies.length > 0 ? body.proxies : loadedProxies;
    const targetUrl = typeof body.targetUrl === 'string' && /^https?:\/\//i.test(body.targetUrl.trim()) ? body.targetUrl.trim() : null;
    const mode = body.mode === 'browser' ? 'browser' : 'reachability';

    if (mode === 'browser') {
      const results = new Array(toValidate.length);
      await runBrowserValidation(toValidate, targetUrl, (i, p, r) => {
        const key = proxyStoreKey(p);
        recordProxyResult(key, r, targetUrl);
        results[i] = { key, ok: !!r.ok, ms: r.ms, reason: r.reason || (r.ok ? 'ok' : 'failed'), egressIp: r.egressIp || '', country: r.country || '', timezone: r.timezone || '', localIpMatched: !!r.localIpMatched };
      }, {
        timeoutMs: body.timeoutMs,
        concurrency: body.concurrency,
        checkEgress: body.checkEgress,
      });
      try { saveProxiesToDisk(); } catch (_) {}
      const workingCount = results.filter(r => r && r.ok).length;
      sendJSON(res, 200, { success: true, results, working: workingCount, total: toValidate.length, mode });
      return;
    }

    // Validate with a bounded worker pool instead of sequential batches.
    // This keeps total time low even for large lists while still limiting
    // simultaneous connections.
    const results = new Array(toValidate.length);
    const concurrency = Math.max(1, Math.min(20, parseInt(body.concurrency, 10) || 12));
    let nextIndex = 0;
    async function worker() {
      while (true) {
        const i = nextIndex++;
        if (i >= toValidate.length) return;
        results[i] = await validateProxy(toValidate[i], 5000, targetUrl);
        try { recordProxyResult(proxyStoreKey(toValidate[i]), results[i]); } catch (_) {}
      }
    }
    await Promise.all(Array.from({ length: concurrency }, worker));
    try { saveProxiesToDisk(); } catch (_) {}
    // Keep the saved list intact so a failed check never wipes the user's
    // proxy pool. Campaigns read the list as-is and skip dead entries.
    const workingCount = results.filter(r => r && r.ok).length;
    sendJSON(res, 200, { success: true, results, working: workingCount, total: toValidate.length });
    return;
  }

  // --- Proxies: clear all ---
  if (pathname === '/api/proxies/clear' && method === 'POST') {
    backupProxiesToDisk();
    loadedProxies = [];
    saveProxiesToDisk();
    sendJSON(res, 200, { success: true });
    return;
  }
  // --- Proxies: remove a single proxy ---
  if (pathname === '/api/proxies/remove' && method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    const key = body.key || (String(body.type || 'http').toLowerCase() + ':' + body.host + ':' + body.port);
    const before = loadedProxies.length;
    loadedProxies = loadedProxies.filter(p => (String(p.type || 'http').toLowerCase() + ':' + p.host + ':' + p.port) !== key);
    saveProxiesToDisk();
    sendJSON(res, 200, { success: true, removed: before - loadedProxies.length, count: loadedProxies.length });
    return;
  }

  // --- Proxies: bulk remove (dead list from the UI) ---
  if (pathname === '/api/proxies/remove-dead' && method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    const keys = new Set(Array.isArray(body.keys) ? body.keys : []);
    const before = loadedProxies.length;
    const remaining = keys.size
      ? loadedProxies.filter(p => !keys.has(proxyStoreKey(p)))
      : loadedProxies;
    if (before > 0 && remaining.length === 0 && keys.size >= before) backupProxiesToDisk();
    loadedProxies = remaining;
    saveProxiesToDisk();
    sendJSON(res, 200, { success: true, removed: before - loadedProxies.length, count: loadedProxies.length });
    return;
  }

  // --- Proxies: bulk remove by validation status ---
  // `ok` = verified/working, `unknown` = loaded but never validated.
  if (pathname === '/api/proxies/remove-status' && method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    const raw = String(body.status || '').toLowerCase();
    const status = raw === 'loaded' ? 'unknown' : raw;
    if (!['ok', 'dead', 'unknown'].includes(status)) {
      sendJSON(res, 400, { success: false, error: 'status must be ok, dead or unknown' });
      return;
    }
    backupProxiesToDisk();
    const before = loadedProxies.length;
    loadedProxies = loadedProxies.filter((p) => {
      const s = p && (p.status === 'ok' || p.status === 'dead') ? p.status : 'unknown';
      return s !== status;
    });
    saveProxiesToDisk();
    sendJSON(res, 200, {
      success: true,
      status,
      removed: before - loadedProxies.length,
      count: loadedProxies.length,
    });
    return;
  }

  // --- Auto-restart ---
  if (pathname === '/api/autorestart/enable' && method === 'POST') {
    autoRestartEnabled = true;
    sendJSON(res, 200, { success: true, enabled: true });
    return;
  }
  if (pathname === '/api/autorestart/disable' && method === 'POST') {
    autoRestartEnabled = false;
    sendJSON(res, 200, { success: true, enabled: false });
    return;
  }

  // --- RPA: Start recording (opens a browser for recording) ---
  if (pathname === '/api/rpa/start' && method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    // Default to google.com if no URL provided — fresh tab experience
    const url = body.url || 'https://www.google.com';
    const rawProxy = body.proxy && typeof body.proxy === 'object' ? body.proxy : null;
    const proxyMode = rawProxy ? 'fixed' : 'none';
    try {
      // A previous recording browser may still be open (e.g. the UI was
      // reloaded). Close it so two recorders never fight over one state.
      if (rpaState.browser) {
        try { await rpaState.browser.close(); } catch (_) {}
        if (rpaState.focusTracker) {
          try { rpaState.focusTracker.stop(); } catch (_) {}
        }
        rpaState.focusTracker = null;
        rpaState.browser = null;
        rpaState.context = null;
        rpaState.page = null;
        rpaState.pages = [];
      }

      // The recording browser uses the exact same verified-proxy path as a
      // replay: no silent direct-IP fallback when a proxy was selected.
      const session = await createProxiedSession({
        proxy: rawProxy,
        requireProxy: proxyMode !== 'none',
        sessionTag: 'rpa-record',
        headless: false,
        verifyEgress: true,
        sessionId: 'RPA record',
        onLog: (msg, type) => rpaPushLog(rpaPlayState, msg, type),
      });
      const browser = session.browser;
      const context = session.context;

      // Reset state BEFORE instrumenting the context.
      rpaState.browser = browser;
      rpaState.context = context;
      rpaState.page = null;
      rpaState.pages = [];
      rpaState.actions = [];
      rpaState.recording = true;
      rpaState.startedAt = Date.now();
      rpaState.focusTracker = null;
      rpaState.proxy = session.proxy || null;
      rpaState.proxyLabel = session.hasProxy ? proxiedLabel(session.proxy) : 'direct IP';
      rpaState.proxyEgress = session.egressIp || '';
      rpaState.proxyVerified = !!session.proxyVerified;


      // Reset state BEFORE instrumenting the context.
      rpaState.browser = browser;
      rpaState.context = context;
      rpaState.page = null;
      rpaState.pages = [];
      rpaState.actions = [];
      rpaState.recording = true;
      rpaState.startedAt = Date.now();
      rpaState.focusTracker = null;

      // Recorder: every action is pushed to Node as it happens, so it
      // survives navigation, reloads and new tabs.
      const rpaRec = require('./RpaRecorder.js');
      const addRecorded = (action) => {
        if (!rpaState.recording || !action) return;
        // Chromium can fire duplicate navigation events for one document.
        if (action.type === 'navigate') {
          const last = rpaState.actions[rpaState.actions.length - 1];
          if (last && last.type === 'navigate' && last.url === action.url && Math.abs((last.ts || 0) - (action.ts || 0)) < 600) return;
        }
        rpaState.actions.push(action);
      };
      // Tab switches are inferred from where the user actually acts. Browser
      // visibility polling is unreliable inside an automated Chromium window
      // (background tabs can still report "visible"), but every recorded
      // click/scroll/key/navigation carries its real tab id, so the first
      // action on another tab is a genuine switch and gets an explicit
      // `switch` action before it.
      const routedRecorded = rpaRec.createTabSwitchRouter(addRecorded);
      const recorderOpts = { onAction: routedRecorded, isActive: () => rpaState.recording };
      // IMPORTANT: install before the first page exists. Adding the script
      // after page.goto() (the old behaviour) left the already-open document
      // uninstrumented, which is why recordings showed 0 actions.
      await rpaRec.installRecorder(context, recorderOpts);
      const attachPage = (p) => {
        if (!p || rpaState.pages.includes(p)) return;
        rpaState.pages.push(p);
        rpaRec.trackPage(p, recorderOpts);
      };
      context.on('page', attachPage);

      const page = await context.newPage();
      attachPage(page);
      rpaState.page = page;
      // Navigate to the URL (default: google.com)
      try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }); } catch (_) {}
      sendJSON(res, 200, {
        success: true,
        message: 'Recording browser opened',
        url,
        proxyMode,
        proxy: rpaState.proxyLabel,
        proxyEgress: rpaState.proxyEgress,
        proxyVerified: rpaState.proxyVerified,
      });
    } catch (e) {
      sendJSON(res, 500, { success: false, error: e.message });
    }
    return;
  }

  // --- RPA: Stop & Save (closes browser, returns recorded actions) ---
  if (pathname === '/api/rpa/stop' && method === 'POST') {
    try {
      // Stop accepting live pushes first, then drain each tab's buffer as a
      // fallback for anything the binding could not deliver.
      rpaState.recording = false;
      if (rpaState.focusTracker) {
        try { rpaState.focusTracker.stop(); } catch (_) {}
      }
      rpaState.focusTracker = null;
      const openPages = Array.isArray(rpaState.pages) ? rpaState.pages.slice() : [];
      // Drain each tab's in-page buffer as a fallback for actions the binding
      // could not deliver (e.g. very early interactions).
      let buffered = [];
      try {
        const rpaRec = require('./RpaRecorder.js');
        buffered = await rpaRec.collectBufferedActions(openPages, 2000);
      } catch (_) { buffered = []; }

      const byId = new Map();
      const addUnique = (a) => {
        if (!a || typeof a !== 'object' || !a.type) return;
        const key = a.id || [a.type, a.ts || 0, a.url || '', a.x || 0, a.y || 0, a.selector || '', a.key || '', a.value || ''].join('|');
        if (!byId.has(key)) byId.set(key, a);
      };
      (rpaState.actions || []).forEach(addUnique);
      buffered.forEach(addUnique);
      const actions = Array.from(byId.values()).sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0));

      const browser = rpaState.browser;
      const recordingProxy = {
        mode: rpaState.proxy ? 'fixed' : 'none',
        proxy: rpaState.proxy || null,
        label: rpaState.proxyLabel || 'direct IP',
        egressIp: rpaState.proxyEgress || '',
        verified: !!rpaState.proxyVerified,
      };
      rpaState.browser = null;
      rpaState.context = null;
      rpaState.page = null;
      rpaState.pages = [];
      rpaState.actions = [];
      rpaState.startedAt = 0;
      rpaState.focusTracker = null;
      rpaState.proxy = null;
      rpaState.proxyLabel = '';
      rpaState.proxyEgress = '';
      rpaState.proxyVerified = false;
      // Close browser in background — don't block the response
      if (browser) {
        browser.close().catch(() => {});
      }
      sendJSON(res, 200, { success: true, actions, recordingProxy });
    } catch (e) {
      // Reset state even on error
      rpaState.recording = false;
      rpaState.browser = null;
      rpaState.context = null;
      rpaState.page = null;
      rpaState.pages = [];
      rpaState.startedAt = 0;
      rpaState.focusTracker = null;
      sendJSON(res, 200, { success: true, actions: [], error: e.message });
    }
    return;
  }

  // --- RPA: Play (replays recorded actions in the background, loop aware) ---
  if (pathname === '/api/rpa/play' && method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    if (rpaPlayState.running) {
      sendJSON(res, 409, { success: false, error: 'RPA replay already running' });
      return;
    }
    const actions = Array.isArray(body.actions) ? body.actions : [];
    if (!actions.length) {
      sendJSON(res, 400, { success: false, error: 'No actions to replay' });
      return;
    }
    // loop = how many times EACH session repeats the recording (1 = once).
    const loop = Math.max(1, Math.min(100000, parseInt(body.loop, 10) || 1));
    // sessions = how many independent browsers replay in parallel (1-10).
    const sessions = Math.max(1, Math.min(10, parseInt(body.sessions, 10) || 1));
    const speed = Math.max(0.1, Math.min(20, parseFloat(body.speed) || 1));
    const headless = body.headless === true || body.headless === '1';
    // stayMs = keep the browser open after the last action (random clicks).
    const dwellMs = Math.max(0, Math.min(3600000, parseInt(body.dwellMs, 10) || 0));
    const rawProxy = body.proxy && typeof body.proxy === 'object' ? body.proxy : null;
    const suppliedPool = Array.isArray(body.proxyPool) ? body.proxyPool.filter(p => p && p.host && p.port) : [];
    let proxyMode = body.proxyMode;
    if (proxyMode !== 'none' && proxyMode !== 'fixed' && proxyMode !== 'random') {
      proxyMode = rawProxy ? 'fixed' : (body.randomProxy === true ? 'random' : 'none');
    }
    if (proxyMode === 'fixed' && !rawProxy && suppliedPool.length) proxyMode = 'random';
    const proxyRotation = body.proxyRotation === 'session' ? 'session' : 'round';
    const proxyPool = proxyMode === 'random'
      ? (suppliedPool.length ? suppliedPool : rpaWorkingPool())
      : (rawProxy ? [rawProxy] : []);
    const proxyName = proxyMode === 'none'
      ? ''
      : (proxyMode === 'random'
        ? `random (${dedupeProxyPool(proxyPool).length} distinct-IP proxies)`
        : (rawProxy ? `${rawProxy.host}:${rawProxy.port}` : ''));
    // Verify the selected proxy in a real Chromium context before replaying.
    const verifyProxy = body.verifyProxy !== false;
    const randomCfg = body.randomClicks && typeof body.randomClicks === 'object' ? body.randomClicks : null;
    const trafficCfg = require('./TrafficSource.js').normalizeTrafficSource(body.trafficSource);
    // Same UA / device / resolution rules as the campaign modules.
    const uaAutoRotate = body.uaAutoRotate === true || body.uaMode === 'rotate';
    const device = body.device === 'mobile' || body.device === 'tablet' ? body.device : 'desktop';
    // Privacy page toggles travel with the replay exactly like they do with the
    // campaign modules.
    const privacyFeatures = Array.isArray(body.privacyFeatures)
      ? body.privacyFeatures.filter(x => typeof x === 'string')
      : [];
    const privacyLevel = ['standard', 'balanced', 'stealth'].includes(body.privacyLevel)
      ? body.privacyLevel
      : 'standard';

    rpaPlayState.logs = [];
    rpaPlayLoop(actions, {
      loop,
      sessions,
      speed,
      headless,
      dwellMs,
      rawProxy,
      proxyMode,
      proxyPool,
      proxyRotation,
      proxyName,
      verifyProxy,
      randomCfg,
      trafficCfg,
      onLog: rpaPushLog,
      userAgents: Array.isArray(body.userAgents) ? body.userAgents : [],
      uaAutoRotate,
      device,
      privacyFeatures,
      privacyLevel,
      viewportWidth: parseInt(body.viewportWidth, 10) || 1280,
      viewportHeight: parseInt(body.viewportHeight, 10) || 800,
      autoRotateResolutions: Array.isArray(body.autoRotateResolutions) ? body.autoRotateResolutions : null,
    }).catch((e) => {
      rpaPlayState.lastError = (e && e.message) || String(e);
      rpaPlayState.running = false;
      rpaPlayState.finishedAt = Date.now();
      rpaPushLog(rpaPlayState, `Replay crashed: ${rpaPlayState.lastError}`, 'error');
    });

    sendJSON(res, 200, {
      success: true,
      started: true,
      loop,
      sessions,
      headless,
      verifyProxy,
      proxy: proxyName,
      proxyMode,
      proxyPoolSize: dedupeProxyPool(proxyPool).length,
      randomClicks: !!(randomCfg && randomCfg.enabled),
      trafficSource: trafficCfg ? trafficCfg.mode : '',
    });
    return;
  }

  // --- RPA: Replay status (polled by the UI) ---
  if (pathname === '/api/rpa/status' && method === 'GET') {
    const elapsedSec = rpaPlayState.startedAt
      ? Math.round(((rpaPlayState.finishedAt || Date.now()) - rpaPlayState.startedAt) / 1000)
      : 0;
    sendJSON(res, 200, {
      success: true,
      recording: {
        active: !!rpaState.recording,
        actions: (rpaState.actions && rpaState.actions.length) || 0,
        stats: rpaRecordingStats(),
        elapsedSec: (rpaState.recording && rpaState.startedAt)
          ? Math.round((Date.now() - rpaState.startedAt) / 1000)
          : 0,
        proxy: rpaState.proxyLabel || 'direct IP',
        proxyEgress: rpaState.proxyEgress || '',
        proxyVerified: !!rpaState.proxyVerified,
      },
      play: {
        running: rpaPlayState.running,
        stopRequested: rpaPlayState.stopRequested,
        sessions: rpaPlayState.sessions,
        loop: rpaPlayState.loop,
        iteration: rpaPlayState.iteration,
        round: rpaPlayState.round,
        totalRounds: rpaPlayState.totalRounds,
        activeSessions: (rpaPlayState.sessionStats || []).filter(r => r.running).length,
        sessionStats: (rpaPlayState.sessionStats || []).map(r => ({ ...r })),
        totalActions: rpaPlayState.totalActions,
        actionsDone: rpaPlayState.actionsDone,
        actionsCompleted: rpaPlayState.actionsCompleted,
        totalExpectedActions: (rpaPlayState.totalRounds || 0) * (rpaPlayState.totalActions || 0),
        elapsedSec,
        lastError: rpaPlayState.lastError,
        randomClicks: rpaPlayState.randomClicks,
        randomScrolls: rpaPlayState.randomScrolls,
        proxyMode: rpaPlayState.proxyMode,
        proxyLabel: rpaPlayState.proxyLabel,
        proxyTarget: rpaPlayState.proxyTarget,
        proxyPoolSize: rpaPlayState.proxyPoolSize,
        proxyVerifiedPoolSize: rpaPlayState.proxyVerifiedPoolSize,
        proxyRawPoolSize: rpaPlayState.proxyRawPoolSize,
        proxyUniqueIpCount: (rpaPlayState.proxyUniqueIps || []).length,
        proxyRecentIps: (rpaPlayState.proxyUniqueIps || []).slice(-8),
        proxyUsage: rpaPlayState.proxyMode === 'none'
          ? null
          : getProxyUsageSnapshot(rpaPlayState.proxyPoolRef || []),
        proxyVerified: rpaPlayState.proxyVerified,
        proxyEgress: rpaPlayState.proxyEgress,
        proxySwitches: rpaPlayState.proxySwitches,
        proxyRetries: rpaPlayState.proxyRetries,
        currentAction: rpaPlayState.currentAction,
        currentTab: rpaPlayState.currentTab,
        currentUrl: rpaPlayState.currentUrl,
        logs: rpaPlayState.logs.slice(-60),
      },
    });
    return;
  }

  // --- RPA: Stop a running replay ---
  if (pathname === '/api/rpa/stop-play' && method === 'POST') {    const browsers = Array.from(rpaPlayState.browsers || []);
    const wasRunning = rpaPlayState.running || browsers.length > 0;
    rpaPlayState.stopRequested = true;
    // Close every parallel session browser, not just one.
    for (const browser of browsers) {
      try { browser.close().catch(() => {}); } catch (_) {}
    }
    rpaPlayState.browsers.clear();
    sendJSON(res, 200, { success: true, stopped: wasRunning });
    return;
  }

  // --- App temp cleanup (never touches the user's Chrome profile) ---
  if (pathname === '/api/temp/clean' && method === 'POST') {
    if (rpaPlayState.running || rpaState.recording) {
      sendJSON(res, 409, { success: false, error: 'Stop recording/replay before clearing temporary browser data.' });
      return;
    }
    const tmpRoot = os.tmpdir();
    const patterns = [
      /^ngf-nomi-browser-/i,
      /^playwright_chromiumdev_profile-/i,
      /^playwright-artifacts-/i,
      /^playwright_firefoxdev_profile-/i,
      /^playwright_webkitdev_profile-/i,
    ];
    const removed = [];
    const skipped = [];
    let freed = 0;
    try {
      const entries = fs.readdirSync(tmpRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry || !entry.isDirectory()) continue;
        const name = entry.name || '';
        if (!patterns.some(re => re.test(name))) continue;
        const full = path.join(tmpRoot, name);
        // Safety: only paths directly under the OS temp directory and never a
        // Chrome/Edge profile location.
        if (path.dirname(path.resolve(full)) !== path.resolve(tmpRoot)) continue;
        if (/google[\\/]+chrome|microsoft[\\/]+edge|user data/i.test(full)) { skipped.push(name); continue; }
        let age = 0;
        try { age = Date.now() - fs.statSync(full).mtimeMs; } catch (_) { age = 0; }
        if (age < 5 * 60 * 1000) { skipped.push(name); continue; }
        let size = 0;
        try {
          const walk = (dir) => {
            for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
              const p = path.join(dir, item.name);
              if (item.isDirectory()) walk(p);
              else { try { size += fs.statSync(p).size; } catch (_) {} }
            }
          };
          walk(full);
        } catch (_) {}
        try {
          fs.rmSync(full, { recursive: true, force: true });
          removed.push(name);
          freed += size;
        } catch (_) {
          skipped.push(name);
        }
      }
    } catch (e) {
      sendJSON(res, 500, { success: false, error: e.message });
      return;
    }
    sendJSON(res, 200, {
      success: true,
      tempRoot: tmpRoot,
      removedCount: removed.length,
      removed: removed.slice(0, 30),
      skippedCount: skipped.length,
      freedBytes: freed,
      note: 'Only app-owned Playwright/ngf-nomi temp folders were removed. Your personal Chrome/Edge profile was not touched.',
    });
    return;
  }

  // --- Schedule: Save (saves to list of saved schedules) ---
  if (pathname === '/api/schedule/save' && method === 'POST') {
    loadScheduleData();
    const body = await readBody(req);
    const sched = { ...body, id: body.id || ('sched_' + Date.now()), enabled: true, savedAt: Date.now() };
    // Add to saved schedules list (replace if same id exists)
    const idx = savedSchedules.findIndex(s => s.id === sched.id);
    if (idx >= 0) savedSchedules[idx] = sched;
    else savedSchedules.push(sched);
    scheduleState = { ...sched, savedSchedules };
    try {
      fs.writeFileSync(SCHEDULE_FILE, JSON.stringify({ ...scheduleState, savedSchedules }, null, 2));
    } catch (_) {}
    sendJSON(res, 200, { success: true, schedule: sched, savedSchedules });
    return;
  }

  // --- Schedule: List (returns all saved schedules) ---
  if (pathname === '/api/schedule/list' && method === 'GET') {
    loadScheduleData();
    sendJSON(res, 200, { success: true, savedSchedules });
    return;
  }

  // --- Schedule: Get ---
  if (pathname === '/api/schedule/get' && method === 'GET') {
    loadScheduleData();
    sendJSON(res, 200, { success: true, schedule: scheduleState, savedSchedules });
    return;
  }

  // --- Schedule: Toggle ---
  if (pathname === '/api/schedule/toggle' && method === 'POST') {
    loadScheduleData();
    const body = await readBody(req).catch(() => ({}));
    if (body.id) {
      // Toggle a specific saved schedule
      const sched = savedSchedules.find(s => s.id === body.id);
      if (sched) {
        sched.enabled = body.enabled !== undefined ? body.enabled : !sched.enabled;
        try {
          fs.writeFileSync(SCHEDULE_FILE, JSON.stringify({ ...scheduleState, savedSchedules }, null, 2));
        } catch (_) {}
        sendJSON(res, 200, { success: true, enabled: sched.enabled, savedSchedules });
        return;
      }
    }
    scheduleState.enabled = body.enabled !== undefined ? body.enabled : !scheduleState.enabled;
    try { fs.writeFileSync(SCHEDULE_FILE, JSON.stringify({ ...scheduleState, savedSchedules }, null, 2)); } catch (_) {}
    sendJSON(res, 200, { success: true, enabled: scheduleState.enabled, savedSchedules });
    return;
  }

  // --- Schedule: Delete (removes a specific schedule or all) ---
  if (pathname === '/api/schedule/delete' && method === 'POST') {
    loadScheduleData();
    const body = await readBody(req).catch(() => ({}));
    if (body.id) {
      // Delete a specific saved schedule
      savedSchedules = savedSchedules.filter(s => s.id !== body.id);
      try {
        fs.writeFileSync(SCHEDULE_FILE, JSON.stringify({ ...scheduleState, savedSchedules }, null, 2));
      } catch (_) {}
      sendJSON(res, 200, { success: true, savedSchedules });
      return;
    }
    // Delete all
    scheduleState = {};
    savedSchedules = [];
    try { fs.unlinkSync(SCHEDULE_FILE); } catch (_) {}
    sendJSON(res, 200, { success: true, savedSchedules });
    return;
  }

  // --- Traffic start endpoints ---
  if (pathname === '/api/organic/start' && method === 'POST') {
    try {
      const body = await readBody(req);
      const config = buildOrganicConfig(body);
      if (!config.targetUrl) {
        sendJSON(res, 400, { success: false, error: 'URL is required' });
        return;
      }
      const emitter = getOrganicSearch().startOrganicSearch(config);
      const id = registerProcess('organic', config, emitter);
      sendJSON(res, 200, { success: true, processId: id });
    } catch (e) {
      sendJSON(res, 500, { success: false, error: e.message });
    }
    return;
  }

  if (pathname === '/api/direct/start' && method === 'POST') {
    try {
      const body = await readBody(req);
      const config = buildDirectConfig(body);
      if (!config.targetUrl) {
        sendJSON(res, 400, { success: false, error: 'URL is required' });
        return;
      }
      const emitter = getDirectTraffic().startDirectTraffic(config);
      const id = registerProcess('direct', config, emitter);
      sendJSON(res, 200, { success: true, processId: id });
    } catch (e) {
      sendJSON(res, 500, { success: false, error: e.message });
    }
    return;
  }

  if (pathname === '/api/referral/start' && method === 'POST') {
    try {
      const body = await readBody(req);
      const config = buildReferralConfig(body);
      if (!config.targetUrl) {
        sendJSON(res, 400, { success: false, error: 'URL is required' });
        return;
      }
      const emitter = getSocialTraffic().startSocialTraffic(config);
      const id = registerProcess('referral', config, emitter);
      sendJSON(res, 200, { success: true, processId: id });
    } catch (e) {
      sendJSON(res, 500, { success: false, error: e.message });
    }
    return;
  }

  if (pathname === '/api/gmaps/start' && method === 'POST') {
    try {
      const body = await readBody(req);
      const config = buildGmapsConfig(body);
      if (!config.businessName) {
        sendJSON(res, 400, { success: false, error: 'Business name is required' });
        return;
      }
      const emitter = getGoogleMapsTraffic().startGoogleMapsTraffic(config);
      const id = registerProcess('gmaps', config, emitter);
      sendJSON(res, 200, { success: true, processId: id });
    } catch (e) {
      sendJSON(res, 500, { success: false, error: e.message });
    }
    return;
  }

  // --- Stop / pause / resume ---
  const stopMatch = pathname.match(/^\/api\/stop\/(.+)$/);
  if (stopMatch && method === 'POST') {
    const id = stopMatch[1];
    const proc = processes.get(id);
    if (proc && proc.emitter) {
      proc.emitter.emit('stop');
      proc.status = 'stopped';
    }
    sendJSON(res, 200, { success: true });
    return;
  }

  if (pathname === '/api/stop-all' && method === 'POST') {
    for (const [id, proc] of processes) {
      if (proc.emitter) {
        try { proc.emitter.emit('stop'); } catch (_) {}
      }
      proc.status = 'stopped';
    }
    sendJSON(res, 200, { success: true, stopped: processes.size });
    return;
  }

  const pauseMatch = pathname.match(/^\/api\/pause\/(.+)$/);
  if (pauseMatch && method === 'POST') {
    const id = pauseMatch[1];
    const proc = processes.get(id);
    if (proc && proc.emitter) {
      proc.emitter.emit('pause');
      proc.status = 'paused';
    }
    sendJSON(res, 200, { success: true });
    return;
  }

  const resumeMatch = pathname.match(/^\/api\/resume\/(.+)$/);
  if (resumeMatch && method === 'POST') {
    const id = resumeMatch[1];
    const proc = processes.get(id);
    if (proc && proc.emitter) {
      proc.emitter.emit('resume');
      proc.status = 'running';
    }
    sendJSON(res, 200, { success: true });
    return;
  }

  // --- Logs polling ---
  const logsMatch = pathname.match(/^\/api\/logs\/(.+)$/);
  if (logsMatch && method === 'GET') {
    const id = logsMatch[1];
    const proc = processes.get(id);
    if (!proc) {
      sendJSON(res, 404, { success: false, error: 'Process not found' });
      return;
    }
    sendJSON(res, 200, { success: true, logs: proc.logs, status: proc.status, stats: proc.stats || null });
    return;
  }

  // --- Dashboard (same-origin static files) ---------------------------------
  // Serving the UI on the API port makes Codespaces / remote Linux use trivial:
  // open port 3000 and the whole app works over http:// instead of file://.
  // Only the dashboard asset allowlist is exposed; server.js / proxies.json and
  // every other backend file stay private.
  if ((method === 'GET' || method === 'HEAD') && serveDashboardAsset(pathname, req, res)) {
    return;
  }

  // --- 404 ---
  sendJSON(res, 404, { success: false, error: `Unknown endpoint: ${method} ${pathname}` });
}

// --- Small filesystem helpers for browser detection ---
function safeExists(p) {
  try { return fs.existsSync(p) ? p : ''; } catch (_) { return ''; }
}

function findBundledChromium() {
  // In a packaged Electron app electron-builder copies extraResources to
  // process.resourcesPath. We ship Chromium there so users do not need to
  // download anything extra. Windows -> chrome-win64\chrome.exe,
  // Linux -> chrome-linux/chrome, macOS -> Chromium.app/Contents/MacOS/Chromium.
  return platform.findBundledBrowser() || '';
}

function findCachedChromiumSafe() {
  // Prefer the Chromium we ship with the app over a system ms-playwright cache.
  const bundled = findBundledChromium();
  if (bundled) return bundled;
  return platform.findCachedBrowser() || '';
}

// --- Server startup --------------------------------------------------------

const PORT = parseInt(process.env.TRAFFICDRIVE_PORT || process.env.PORT || '3000', 10);

// Bind to loopback by default (a local desktop tool should not be reachable
// from the LAN). Inside GitHub Codespaces the port forwarder needs a socket
// that is reachable from outside the container, so there we listen on all
// interfaces. TRAFFICDRIVE_HOST overrides both.
const HOST = process.env.TRAFFICDRIVE_HOST
  || (process.env.CODESPACES === 'true' ? '0.0.0.0' : '127.0.0.1');

let serverInstance = null;

function createServer() {
  if (serverInstance) return serverInstance;
  
  serverInstance = http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      console.error('[server] Unhandled error:', err);
      sendJSON(res, 500, { success: false, error: err.message });
    });
  });
  
  return serverInstance;
}

function startServer() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    
    server.listen(PORT, HOST, () => {
      console.log(`[KG TRF Tool] Backend + dashboard running on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
      resolve(server);
    });

    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`[KG TRF Tool] Port ${PORT} is already in use. Is another instance running?`);
      } else {
        console.error('[KG TRF Tool] Server error:', err);
      }
      reject(err);
    });
  });
}

module.exports = { 
  get server() { return createServer(); },
  startServer 
};
