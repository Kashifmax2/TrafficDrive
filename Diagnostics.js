// Diagnostics.js
// Read-only preflight checks for the dashboard.
//
// Two jobs:
//   1. collectSystemInfo() - CPU / RAM / disk / browser install health and a
//      conservative "recommended threads" value, so a campaign cannot be
//      started with a thread count that would freeze the PC.
//   2. runFingerprintAudit() - opens ONE short-lived headless browser with the
//      current UA / device / viewport / privacy settings and reports whether
//      the JS-visible fingerprint is internally consistent (UA vs platform vs
//      Client Hints vs timezone vs screen vs canvas ...).
//
// Nothing here changes a page, clicks, or writes settings. The audit exists to
// catch broken configurations (mobile UA on a desktop viewport, screen smaller
// than the window, non-deterministic canvas noise, headless-only plugins ...)
// before a campaign wastes hours on them.

'use strict';

const os = require('os');
const fs = require('fs');
const http = require('http');
const path = require('path');

const platform = require('./platform.js');
const { launchBrowser, findBundledBrowser, findCachedChromium } = require('./browser-launcher.js');
const { installPrivacyGuard, privacyContextOptions } = require('./PrivacyGuard.js');
const {
  resolveSessionDevice,
  uaPlatform,
  uaChPlatform,
  uaBrands,
  physicalScreen,
} = require('./SessionProfile.js');

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const round1 = (n) => Math.round(Number(n) * 10) / 10;
const gb = (bytes) => round1(Number(bytes) / (1024 * 1024 * 1024));
const norm = (v) => String(v == null ? '' : v).trim().toLowerCase();

// A conservative thread limit. One Chromium + page can take 400-700 MB, so
// reserve headroom for Windows, the dashboard and the site itself.
function recommendedThreads() {
  let cores = 1;
  try {
    cores = Math.max(1, (os.cpus() || []).length || 1);
  } catch (_) {}
  const totalGB = gb(os.totalmem());
  const byRam = Math.max(1, Math.floor(totalGB / 1.5));
  const byCpu = Math.max(1, cores * 2);
  return Math.max(1, Math.min(20, byRam, byCpu));
}

function dirWritable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, '.kgtrf-write-test-' + process.pid);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return true;
  } catch (_) {
    return false;
  }
}

function freeDiskGB(dir) {
  try {
    if (typeof fs.statfsSync !== 'function') return null;
    const st = fs.statfsSync(dir);
    return gb(st.bavail * st.bsize);
  } catch (_) {
    return null;
  }
}

function collectSystemInfo(opts = {}) {
  const dataDir = opts.dataDir || platform.appDataDir();
  let bundled = '';
  let cached = '';
  try {
    bundled = findBundledBrowser() || '';
  } catch (_) {}
  try {
    cached = findCachedChromium() || '';
  } catch (_) {}
  const browserPath = bundled || cached;
  const browserOk = !!browserPath && fs.existsSync(browserPath);

  let loadavg = [];
  try {
    loadavg = (os.loadavg() || []).map((n) => round1(n));
  } catch (_) {}

  return {
    platform: process.platform,
    arch: process.arch,
    cpuModel: (os.cpus()[0] || {}).model || 'Unknown CPU',
    cores: (os.cpus() || []).length,
    totalMemGB: gb(os.totalmem()),
    freeMemGB: gb(os.freemem()),
    loadavg,
    freeDiskGB: freeDiskGB(dataDir),
    dataDir,
    dataDirWritable: dirWritable(dataDir),
    browserPath,
    browserBundled: !!bundled,
    browserOk,
    appVersion: (() => {
      try {
        return require('./package.json').version;
      } catch (_) {
        return '';
      }
    })(),
    runningCampaigns: Math.max(0, parseInt(opts.runningCampaigns, 10) || 0),
    recommendedThreads: recommendedThreads(),
  };
}

// A tiny loopback page. navigator.userAgentData (Client Hints) only exists in a
// secure context, so a data: URL would falsely report them as missing. Binding
// an ephemeral port on 127.0.0.1 gives a secure origin without touching the
// app's routes or writing anything to disk.
const PROBE_HTML =
  '<!doctype html><html><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width, initial-scale=1">' +
  '</head><body><div id="audit">KG TRF audit</div></body></html>';

function startProbeServer() {
  return new Promise((resolve) => {
    let server;
    try {
      server = http.createServer((req, res) => {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(PROBE_HTML);
      });
    } catch (_) {
      resolve(null);
      return;
    }
    server.on('error', () => resolve(null));
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || !addr.port) {
        try {
          server.close();
        } catch (_) {}
        resolve(null);
        return;
      }
      resolve({ server, url: 'http://127.0.0.1:' + addr.port + '/audit' });
    });
  });
}

function withTimeout(promise, ms, fallback) {
  let timer = null;
  return Promise.race([
    Promise.resolve(promise).catch(() => fallback),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(fallback), Math.max(1, ms));
      if (typeof timer.unref === 'function') timer.unref();
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

// Timezone spellings that mean the same place ("Asia/Calcutta" vs "Asia/Kolkata").
const TZ_ALIASES = {
  'asia/calcutta': 'asia/kolkata',
  'asia/catamarca': 'america/argentina/catamarca',
  'us/eastern': 'america/new_york',
  'us/central': 'america/chicago',
  'us/mountain': 'america/denver',
  'us/pacific': 'america/los_angeles',
  'europe/kyiv': 'europe/kiev',
};
const normTz = (v) => TZ_ALIASES[norm(v)] || norm(v);

function buildChecks(env, expected) {
  const features = expected.features || new Set();
  const device = expected.device || 'desktop';
  const isTouchDevice = device === 'mobile' || device === 'tablet';
  const out = [];
  const add = (id, label, status, detail, hint) => {
    out.push({ id, label, status, detail: String(detail || ''), hint: hint || '' });
  };

  // 1. WebDriver flag: Chromium in automation mode reports `true` unless it is
  // patched. Every page a campaign opens must see `false`.
  add(
    'webdriver',
    'navigator.webdriver hidden',
    env.webdriver === false ? 'pass' : 'fail',
    'reported ' + String(env.webdriver),
    'Stealth / WebDriver patch did not apply to this context.'
  );

  // 2. navigator.platform must agree with the selected UA.
  const expPlatform = norm(expected.platform);
  if (!expPlatform) {
    add('ua_platform', 'UA / navigator.platform agree', 'warn', 'no platform supplied', 'Select a user agent first.');
  } else if (norm(env.platform) === expPlatform) {
    add('ua_platform', 'UA / navigator.platform agree', 'pass', env.platform);
  } else {
    add(
      'ua_platform',
      'UA / navigator.platform agree',
      'fail',
      'UA expects "' + expected.platform + '", page reports "' + env.platform + '"',
      'Enable Platform Spoofing (Privacy page) or pick a UA that matches the device.'
    );
  }

  // 3. UA-CH Client Hints: mobile flag + platform must agree with the UA.
  if (!env.uaData) {
    add('client_hints', 'Client Hints match the UA', 'warn', 'navigator.userAgentData missing', 'Chromium 90+ expected.');
  } else {
    const chMobile = String(expected.chMobile || '') === '?1' || expected.chMobile === true;
    const mobileOk = !!env.uaData.mobile === !!chMobile;
    const platformOk =
      !env.uaData.platform || !expected.chPlatform || norm(env.uaData.platform) === norm(expected.chPlatform);
    add(
      'client_hints',
      'Client Hints match the UA',
      mobileOk && platformOk ? 'pass' : 'fail',
      'mobile=' + String(env.uaData.mobile) + ', platform=' + String(env.uaData.platform || ''),
      'Enable Platform / Sec-CH-UA spoofing so hints follow the UA.'
    );
  }

  // 4. Touch points must match the device class.
  const touchOk = isTouchDevice ? (env.maxTouchPoints || 0) > 0 : (env.maxTouchPoints || 0) === 0;
  add(
    'touch',
    'Touch support matches the device',
    touchOk ? 'pass' : 'fail',
    'maxTouchPoints=' + String(env.maxTouchPoints),
    'Mobile / tablet must be touch-enabled; desktop must not be.'
  );

  // 5. Viewport sanity + DPR.
  const vp = expected.viewport || {};
  const vpOk = env.innerWidth >= 200 && env.innerHeight >= 200;
  let dprOk = env.dpr >= 1 && env.dpr <= 4;
  let dprWarn = false;
  if (isTouchDevice && env.dpr < 1.5) dprWarn = true;
  add(
    'viewport',
    'Viewport is usable',
    vpOk && (dprOk || dprWarn) ? (dprWarn ? 'warn' : 'pass') : 'fail',
    env.innerWidth + 'x' + env.innerHeight + ' @' + round1(env.dpr) + 'x' +
      (vp.width ? ' (requested ' + vp.width + 'x' + vp.height + ')' : ''),
    'Use a normal screen resolution; mobile profiles need a mobile DPR (2-3).'
  );

  // 6. Screen must never be smaller than the layout viewport.
  const screenOk = env.screen && env.screen.width >= env.innerWidth && env.screen.height >= env.innerHeight;
  add(
    'screen',
    'Screen covers the viewport',
    screenOk ? 'pass' : 'fail',
    'screen ' + (env.screen ? env.screen.width + 'x' + env.screen.height : '?'),
    'Enable Screen Spoofing or lower the viewport so it fits inside the screen.'
  );

  // 7. Timezone: only assert when the campaign has a target timezone (proxy).
  if (expected.timezone) {
    const ok = normTz(env.timezone) === normTz(expected.timezone);
    add(
      'timezone',
      'Timezone matches the target location',
      ok ? 'pass' : 'fail',
      'expected ' + expected.timezone + ', got ' + env.timezone,
      'Enable Timezone Spoofing; with a proxy the context should use the proxy timezone.'
    );
  } else {
    add('timezone', 'Timezone detected', 'pass', env.timezone || 'unknown');
  }

  // 8. Language list must not be empty and should follow en-US.
  const langs = env.languages || [];
  const langOk = langs.length > 0 && /^en/i.test(langs[0] || '');
  add(
    'language',
    'Language / Accept-Language agree',
    langOk ? 'pass' : features.has('language-spoof') ? 'fail' : 'warn',
    (langs.join(',') || env.language || 'none') + '',
    'Enable Language Spoofing for English profiles.'
  );

  // 9. Canvas noise must be deterministic: two independent canvases with the
  // same drawing commands must produce the same hash. Random noise breaks
  // logins and CAPTCHAs, so this is a hard failure.
  const stable = !!env.canvasHash && env.canvasHash === env.canvasHash2;
  add(
    'canvas',
    'Canvas fingerprint is stable',
    stable ? 'pass' : 'fail',
    stable ? env.canvasHash : 'hash changed between two draws',
    'Canvas noise must be seeded; non-deterministic noise breaks real sites.'
  );

  // 10. WebGL must exist and must not fall back to a software renderer.
  const gl = env.webgl || null;
  const software = gl && /swiftshader|llvmpipe|software|basic render/i.test(String(gl.renderer || ''));
  add(
    'webgl',
    'WebGL renderer looks real',
    !gl ? 'fail' : software ? 'warn' : 'pass',
    gl ? String(gl.vendor || '') + ' / ' + String(gl.renderer || '') : 'WebGL unavailable',
    software ? 'Software rendering is a headless signal; enable WebGL Spoofing.' : ''
  );

  // 11. Hardware values must be plausible.
  const hc = Number(env.hardwareConcurrency) || 0;
  const dm = env.deviceMemory == null ? null : Number(env.deviceMemory);
  const hwOk = hc >= 1 && hc <= 64 && (dm == null || (dm >= 0.25 && dm <= 64));
  add(
    'hardware',
    'Hardware values are plausible',
    hwOk ? 'pass' : 'warn',
    'cores=' + hc + ', memory=' + (dm == null ? 'n/a' : dm + 'GB'),
    'Enable Hardware / Device Memory Spoofing for a consistent profile.'
  );

  // 12. Desktop Chrome exposes plugins; zero plugins is a classic headless flag.
  if (device === 'desktop') {
    add(
      'plugins',
      'Plugin list is populated',
      env.plugins > 0 ? 'pass' : 'warn',
      env.plugins + ' plugin(s)',
      'Enable Plugin List Spoofing if headless Chromium reports none.'
    );
  } else {
    add('plugins', 'Plugin list', 'pass', env.plugins + ' plugin(s)');
  }

  // 13. window.chrome is expected by many site checks.
  add(
    'chrome_object',
    'window.chrome present',
    env.chrome ? 'pass' : 'warn',
    env.chrome ? 'yes' : 'missing',
    'Some anti-bot scripts require the Chrome object.'
  );

  return out;
}

function scoreChecks(checks) {
  if (!checks.length) return 0;
  let pts = 0;
  for (const c of checks) {
    if (c.status === 'pass') pts += 1;
    else if (c.status === 'warn') pts += 0.5;
  }
  return Math.round((pts / checks.length) * 100);
}

function normalizeViewport(opts, device) {
  const w = parseInt(opts.viewportWidth, 10) || 0;
  const h = parseInt(opts.viewportHeight, 10) || 0;
  const dpr = Number(opts.deviceScaleFactor) || 0;
  if (w >= 200 && h >= 200) {
    return {
      width: w,
      height: h,
      deviceScaleFactor: dpr > 0 ? dpr : device === 'mobile' || device === 'tablet' ? 2 : 1,
      hasTouch: device === 'mobile' || device === 'tablet',
      isMobile: device === 'mobile',
    };
  }
  if (device === 'mobile') return { width: 390, height: 844, deviceScaleFactor: 3, hasTouch: true, isMobile: true };
  if (device === 'tablet') return { width: 768, height: 1024, deviceScaleFactor: 2, hasTouch: true, isMobile: false };
  return { width: 1366, height: 768, deviceScaleFactor: 1, hasTouch: false, isMobile: false };
}

async function runFingerprintAudit(opts = {}) {
  if (runFingerprintAudit._running) {
    throw new Error('A fingerprint audit is already running. Wait for it to finish.');
  }
  runFingerprintAudit._running = true;
  const startedAt = Date.now();
  const onLog = typeof opts.onLog === 'function' ? opts.onLog : () => {};

  const ua = String(opts.userAgent || '').trim() || DEFAULT_UA;
  const requestedDevice = String(opts.device || 'desktop').toLowerCase();
  const device = resolveSessionDevice(requestedDevice, ua);
  const viewport = normalizeViewport(opts, device);
  const timezone = String(opts.timezone || '').trim();
  const features = Array.isArray(opts.privacyFeatures)
    ? opts.privacyFeatures.map(String)
    : [];
  const privacyLevel = String(opts.privacyLevel || 'standard');
  const expected = {
    ua,
    device,
    platform: uaPlatform(ua),
    chPlatform: uaChPlatform(ua),
    chMobile: device === 'mobile' ? '?1' : '?0',
    brands: uaBrands(ua),
    timezone,
    viewport,
    features: new Set(features),
  };

  let browser = null;
  let context = null;
  let probe = null;
  try {
    probe = await startProbeServer();
    browser = await launchBrowser({ headless: true, sessionId: 'Diagnostics', onLog });
    const contextOptions = {
      viewport: { width: viewport.width, height: viewport.height },
      userAgent: ua,
      isMobile: !!viewport.isMobile,
      hasTouch: !!viewport.hasTouch,
      deviceScaleFactor: viewport.deviceScaleFactor || 1,
    };
    if (viewport.hasTouch) {
      const screen = physicalScreen(viewport);
      if (screen) contextOptions.screen = screen;
    }
    Object.assign(contextOptions, privacyContextOptions(features));
    if (timezone) contextOptions.timezoneId = timezone;

    context = await browser.newContext(contextOptions);
    const guard = await installPrivacyGuard(context, {
      privacyFeatures: features,
      privacyLevel,
      timezone,
      ua,
      platform: expected.platform,
      chPlatform: expected.chPlatform,
      brands: expected.brands,
      device,
      viewport,
      hasTouch: !!viewport.hasTouch,
      onLog,
    }).catch((err) => ({ applied: 0, error: String((err && err.message) || err) }));

    const page = await withTimeout(context.newPage(), 15000, null);
    if (!page) throw new Error('Could not open the audit page.');

    const dataUrl =
      'data:text/html;charset=utf-8,' +
      encodeURIComponent(PROBE_HTML);
    await withTimeout(
      page.goto(probe ? probe.url : dataUrl, { waitUntil: 'load', timeout: 20000 }),
      25000,
      null
    );

    const env = await withTimeout(
      page.evaluate(() => {
        const nav = navigator;
        const hashCanvas = () => {
          try {
            const c = document.createElement('canvas');
            c.width = 220;
            c.height = 60;
            const ctx = c.getContext('2d');
            if (!ctx) return '';
            ctx.textBaseline = 'top';
            ctx.font = '15px Arial';
            ctx.fillStyle = '#f60';
            ctx.fillRect(0, 0, 220, 60);
            ctx.fillStyle = '#069';
            ctx.fillText('KG TRF fingerprint audit', 4, 18);
            const d = c.toDataURL();
            let h = 2166136261;
            for (let i = 0; i < d.length; i++) {
              h ^= d.charCodeAt(i);
              h = Math.imul(h, 16777619);
            }
            return (h >>> 0).toString(16);
          } catch (_) {
            return '';
          }
        };
        const readGl = () => {
          try {
            const c = document.createElement('canvas');
            const g = c.getContext('webgl') || c.getContext('experimental-webgl');
            if (!g) return null;
            const ext = g.getExtension('WEBGL_debug_renderer_info');
            return {
              vendor: ext ? g.getParameter(ext.UNMASKED_VENDOR_WEBGL) : g.getParameter(g.VENDOR),
              renderer: ext ? g.getParameter(ext.UNMASKED_RENDERER_WEBGL) : g.getParameter(g.RENDERER),
            };
          } catch (_) {
            return null;
          }
        };
        const uad = nav.userAgentData || null;
        let timezone = '';
        try {
          timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
        } catch (_) {}
        return {
          userAgent: nav.userAgent,
          platform: nav.platform,
          language: nav.language,
          languages: Array.from(nav.languages || []),
          hardwareConcurrency: nav.hardwareConcurrency,
          deviceMemory: nav.deviceMemory == null ? null : nav.deviceMemory,
          webdriver: nav.webdriver,
          plugins: nav.plugins ? nav.plugins.length : 0,
          mimeTypes: nav.mimeTypes ? nav.mimeTypes.length : 0,
          timezone,
          screen: {
            width: screen.width,
            height: screen.height,
            colorDepth: screen.colorDepth,
            pixelDepth: screen.pixelDepth,
          },
          innerWidth,
          innerHeight,
          outerWidth,
          outerHeight,
          dpr: devicePixelRatio,
          webgl: readGl(),
          canvasHash: hashCanvas(),
          canvasHash2: hashCanvas(),
          uaData: uad
            ? {
                mobile: uad.mobile,
                platform: uad.platform || '',
                brands: Array.from(uad.brands || []).map((b) => b.brand + ' ' + b.version),
              }
            : null,
          chrome: !!window.chrome,
          maxTouchPoints: nav.maxTouchPoints || 0,
        };
      }),
      15000,
      null
    );
    if (!env) throw new Error('The audit page did not return fingerprint data.');

    const checks = buildChecks(env, expected);
    const passed = checks.filter((c) => c.status === 'pass').length;
    const warned = checks.filter((c) => c.status === 'warn').length;
    const failed = checks.filter((c) => c.status === 'fail').length;

    return {
      ranAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      score: scoreChecks(checks),
      passed,
      warned,
      failed,
      checks,
      expected: {
        userAgent: ua,
        requestedDevice,
        device,
        platform: expected.platform,
        chPlatform: expected.chPlatform,
        timezone,
        viewport,
        privacyFeatures: features.length,
        privacyLevel,
        privacyApplied: guard && typeof guard.applied === 'number' ? guard.applied : null,
        privacyError: (guard && guard.error) || '',
      },
      environment: {
        userAgent: env.userAgent,
        platform: env.platform,
        languages: env.languages,
        timezone: env.timezone,
        viewport: { width: env.innerWidth, height: env.innerHeight, dpr: env.dpr },
        screen: env.screen,
        webgl: env.webgl,
        hardwareConcurrency: env.hardwareConcurrency,
        deviceMemory: env.deviceMemory,
        plugins: env.plugins,
        clientHints: env.uaData,
        webdriver: env.webdriver,
      },
    };
  } finally {
    try {
      if (context) await withTimeout(context.close(), 5000, null);
    } catch (_) {}
    try {
      if (browser) await withTimeout(browser.close(), 5000, null);
    } catch (_) {}
    try {
      if (probe && probe.server) await new Promise((resolve) => {
        try {
          probe.server.close(() => resolve());
        } catch (_) {
          resolve();
        }
      });
    } catch (_) {}
    runFingerprintAudit._running = false;
  }
}

module.exports = {
  DEFAULT_UA,
  recommendedThreads,
  collectSystemInfo,
  runFingerprintAudit,
  buildChecks,
  scoreChecks,
  normalizeViewport,
};
