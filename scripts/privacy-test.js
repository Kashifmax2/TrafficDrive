// scripts/privacy-test.js
// One-by-one verification of every Privacy toggle (Windows and Linux) plus the
// device/User-Agent -> Sec-CH-UA matrix that ad networks use to classify a hit
// as Desktop / Mobile / Tablet.
//
//   node scripts/privacy-test.js
//   xvfb-run -a node scripts/privacy-test.js   (headless Linux CI)
//
// Every feature gets a fresh browser context so one spoof cannot mask another.
// The page probes real browser APIs and the local server records real request
// headers, so this tests what a tracked website actually sees.

'use strict';

const http = require('http');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const platform = require(path.join(ROOT, 'platform.js'));
const { launchBrowser } = require(path.join(ROOT, 'browser-launcher.js'));
const {
  installPrivacyGuard,
  privacyContextOptions,
  PRIVACY_FEATURE_IDS,
} = require(path.join(ROOT, 'PrivacyGuard.js'));
const { installTrafficSource } = require(path.join(ROOT, 'TrafficSource.js'));
const {
  resolveSessionDevice,
  chooseViewport,
  physicalScreen,
  uaPlatform,
  uaChPlatform,
  uaBrands,
} = require(path.join(ROOT, 'SessionProfile.js'));

const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const VIEWPORT = { width: 1000, height: 700, deviceScaleFactor: 1, isMobile: false, hasTouch: false };
const SCREEN = { width: 1000, height: 700 };

const UAS = {
  win: DESKTOP_UA,
  androidPhone: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  androidTablet: 'Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
  ipad: 'Mozilla/5.0 (iPad; CPU OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
};

// ── local probe server ───────────────────────────────────────────────────────
let etagHits = [];
let lastTargetReferer = null;
let lastRefReferer = null;
let lastRefererToTarget;

function startProbeServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/echo') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(req.headers));
      return;
    }
    if (url.pathname === '/target') {
      lastTargetReferer = req.headers.referer || null;
      lastRefererToTarget = lastTargetReferer;
      res.setHeader('content-type', 'text/html');
      res.end('<!doctype html><html><body>target</body></html>');
      return;
    }
    if (url.pathname === '/ref') {
      lastRefReferer = req.headers.referer || null;
      res.setHeader('content-type', 'text/html');
      res.end('<!doctype html><html><body><a id="l" href="/target">go</a></body></html>');
      return;
    }
    if (url.pathname === '/') {
      etagHits.push(req.headers['if-none-match'] || null);
      res.setHeader('set-cookie', '_ga=GA1.2.3.4; Path=/; SameSite=Lax');
    }
    res.setHeader('content-type', 'text/html');
    res.setHeader('etag', '"v1"');
    res.setHeader('cache-control', 'max-age=0');
    res.end('<!doctype html><html><head><title>probe</title></head><body><div id="probe" style="width:120px;height:40px">fingerprint text</div></body></html>');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

// ── in-page probe ────────────────────────────────────────────────────────────
/* eslint-disable no-undef */
async function probePage() {
  const hash = (s) => {
    let h = 2166136261 >>> 0;
    const str = String(s);
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h >>> 0;
  };
  const out = {};
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl') || c.getContext('experimental-webgl');
    const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
    out.webglVendor = ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : null;
    out.webglRenderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null;
  } catch (_) { out.webglVendor = null; out.webglRenderer = null; }
  try {
    const c = document.createElement('canvas');
    c.width = 200; c.height = 40;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#f60'; ctx.fillRect(10, 10, 150, 20);
    ctx.font = '14px Arial'; ctx.fillText('TrafficDrive', 4, 30);
    out.canvasData = hash(c.toDataURL());
    const d = ctx.getImageData(0, 0, 50, 20).data;
    let s = 0;
    for (let i = 0; i < d.length; i += 7) s = (Math.imul(s, 31) + d[i]) >>> 0;
    out.canvasPixels = s;
  } catch (_) { out.canvasData = null; out.canvasPixels = null; }
  try {
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const ac = new OAC(1, 4096, 44100);
    const osc = ac.createOscillator();
    osc.type = 'triangle'; osc.frequency.value = 1000;
    osc.connect(ac.destination); osc.start(0);
    const buf = await ac.startRendering();
    const d = buf.getChannelData(0);
    let s = 0;
    for (let i = 0; i < 1024; i++) s += d[i];
    out.audioSum = s;
  } catch (_) { out.audioSum = null; }
  try {
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d');
    ctx.font = '16px Papyrus, serif';
    out.fontWidth = ctx.measureText('mmmmmmmmmmlli').width;
  } catch (_) { out.fontWidth = null; }
  try { out.fontCheck = document.fonts ? document.fonts.check('16px Papyrus') : null; } catch (_) { out.fontCheck = null; }
  out.hardwareConcurrency = navigator.hardwareConcurrency;
  out.deviceMemory = navigator.deviceMemory;
  out.screenW = screen.width; out.screenH = screen.height; out.screenDepth = screen.colorDepth;
  try {
    out.tzOffset = new Date().getTimezoneOffset();
    out.tzResolved = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch (_) {}
  out.languages = Array.prototype.slice.call(navigator.languages || []);
  out.language = navigator.language;
  out.platform = navigator.platform;
  out.dnt = navigator.doNotTrack;
  out.ua = navigator.userAgent;
  out.appVersion = navigator.appVersion;
  try {
    out.uaData = navigator.userAgentData ? {
      brands: navigator.userAgentData.brands.map((b) => ({ brand: b.brand, version: b.version })),
      mobile: navigator.userAgentData.mobile,
      platform: navigator.userAgentData.platform,
    } : null;
  } catch (_) { out.uaData = null; }
  out.maxTouchPoints = navigator.maxTouchPoints;
  out.vendor = navigator.vendor;
  out.innerW = innerWidth; out.innerH = innerHeight;
  out.outerW = outerWidth; out.outerH = outerHeight;
  out.dpr = devicePixelRatio;
  try {
    const el = document.getElementById('probe');
    const r = el.getClientRects()[0];
    out.rectW = r ? r.width : null;
  } catch (_) { out.rectW = null; }
  try { out.voices = speechSynthesis.getVoices().length; } catch (_) { out.voices = null; }
  try {
    out.devices = (await navigator.mediaDevices.enumerateDevices()).map((d) => ({ kind: d.kind, deviceId: d.deviceId }));
  } catch (_) { out.devices = []; }
  out.plugins = navigator.plugins ? navigator.plugins.length : null;
  out.mimeTypes = navigator.mimeTypes ? navigator.mimeTypes.length : null;
  try { out.rtcSource = String(RTCPeerConnection).slice(0, 260); } catch (_) { out.rtcSource = ''; }
  try { out.battery = await navigator.getBattery().then((b) => ({ level: b.level, charging: b.charging })); } catch (_) { out.battery = null; }
  try {
    out.sensorPermission = (typeof DeviceOrientationEvent !== 'undefined' && DeviceOrientationEvent.requestPermission)
      ? await DeviceOrientationEvent.requestPermission() : null;
  } catch (_) { out.sensorPermission = 'err'; }
  try {
    const g = navigator.getGamepads ? navigator.getGamepads() : null;
    out.gamepads = g ? { len: g.length, nonNull: Array.prototype.filter.call(g, Boolean).length } : null;
  } catch (_) { out.gamepads = null; }
  try { out.bluetooth = navigator.bluetooth ? await navigator.bluetooth.getAvailability() : null; } catch (_) { out.bluetooth = 'err'; }
  try { out.usb = navigator.usb ? (await navigator.usb.getDevices()).length : null; } catch (_) { out.usb = null; }
  try { out.serial = navigator.serial ? (await navigator.serial.getPorts()).length : null; } catch (_) { out.serial = null; }
  try { out.hid = navigator.hid ? (await navigator.hid.getDevices()).length : null; } catch (_) { out.hid = null; }
  try { out.metaReferrer = (document.querySelector('meta[name="referrer"]') || {}).content || null; } catch (_) { out.metaReferrer = null; }
  out.docReferrer = document.referrer;
  try { out.cookies = document.cookie; } catch (_) { out.cookies = ''; }
  try {
    const l = document.createElement('link');
    l.rel = 'dns-prefetch'; l.href = '//privacy-test.example/x';
    document.head.appendChild(l);
    await new Promise((r) => setTimeout(r, 80));
    out.dnsLink = l.isConnected;
  } catch (_) { out.dnsLink = null; }
  try {
    const a = document.createElement('a');
    a.href = '#'; a.setAttribute('ping', '//privacy-test.example/ping');
    document.body.appendChild(a);
    await new Promise((r) => setTimeout(r, 80));
    out.ping = a.getAttribute('ping');
  } catch (_) { out.ping = null; }
  try {
    const f = document.createElement('iframe');
    f.srcdoc = '<p>x</p>';
    document.body.appendChild(f);
    await new Promise((r) => setTimeout(r, 50));
    out.iframeWebdriver = f.contentWindow.navigator.webdriver;
  } catch (_) { out.iframeWebdriver = 'err'; }
  try {
    out.headers = await fetch('/echo', { cache: 'no-store' }).then((r) => r.json());
  } catch (_) { out.headers = {}; }
  return out;
}
/* eslint-enable no-undef */

async function runCase(browser, base, features, opts = {}) {
  const ua = opts.ua || DESKTOP_UA;
  const vp = opts.viewport || VIEWPORT;
  const screenSize = opts.screen || SCREEN;
  const device = opts.device || 'desktop';
  const ctxOpts = Object.assign({
    viewport: { width: vp.width, height: vp.height },
    userAgent: ua,
    isMobile: !!vp.isMobile,
    hasTouch: !!vp.hasTouch,
    deviceScaleFactor: vp.deviceScaleFactor || 1,
    screen: { width: screenSize.width, height: screenSize.height },
  }, privacyContextOptions(features));
  const context = await browser.newContext(ctxOpts);
  await installPrivacyGuard(context, {
    privacyFeatures: features,
    privacyLevel: 'standard',
    ua,
    platform: uaPlatform(ua) || 'Win32',
    chPlatform: uaChPlatform(ua) || 'Windows',
    brands: uaBrands(ua),
    device,
    viewport: vp,
    screen: screenSize,
    timezone: opts.timezone === undefined ? '' : opts.timezone,
    onLog: () => {},
  });
  const page = await context.newPage();
  await page.goto(base + '/', { waitUntil: 'load' });
  const p = await page.evaluate(probePage);

  // Real navigation referrer check.
  let targetReferer = null;
  let docRef = null;
  if (features.includes('referer-control')) {
    lastRefererToTarget = undefined;
    await page.goto(base + '/ref', { waitUntil: 'load' });
    await Promise.all([page.waitForURL('**/target'), page.click('#l')]);
    targetReferer = lastRefererToTarget;
    docRef = await page.evaluate(() => document.referrer);
  }

  // Real HTTP cache revalidation check.
  let secondEtag = null;
  if (features.includes('etag-clear')) {
    etagHits = [];
    await page.goto(base + '/', { waitUntil: 'load' });
    await page.goto(base + '/', { waitUntil: 'load' });
    secondEtag = etagHits.length ? etagHits[etagHits.length - 1] : null;
  }

  await context.close();
  return { p, targetReferer, docRef, secondEtag };
}

const CHECKS = {
  'webgl-spoof': (p, b) => p.webglVendor !== b.webglVendor && p.webglRenderer !== b.webglRenderer,
  'canvas-noise': (p, b) => p.canvasData !== b.canvasData && p.canvasPixels !== b.canvasPixels,
  'audio-spoof': (p, b) => Math.abs((p.audioSum || 0) - (b.audioSum || 0)) > 1e-8,
  'font-spoof': (p, b) => p.fontWidth !== b.fontWidth || p.fontCheck !== b.fontCheck,
  'hardware-spoof': (p) => p.hardwareConcurrency === 8,
  'device-memory-spoof': (p) => p.deviceMemory === 8,
  'screen-spoof': (p) => p.screenW === 1920 && p.screenH === 1080,
  'timezone-spoof': (p) => p.tzResolved === 'America/New_York' && (p.tzOffset === 300 || p.tzOffset === 240),
  'language-spoof': (p, b, x) => (p.languages || [])[0] === 'en-US' && /en-US/i.test((x.p.headers || {})['accept-language'] || ''),
  'platform-spoof': (p) => p.platform === 'Win32',
  'webrtc-leak': (p) => /iceTransportPolicy/.test(String(p.rtcSource || '')),
  'dns-prefetch': (p) => p.dnsLink === false,
  'hyperlink-audit': (p) => p.ping === null,
  'battery-spoof': (p) => !!p.battery && p.battery.level === 1 && p.battery.charging === true,
  'sensor-spoof': (p) => p.sensorPermission === 'granted' || p.sensorPermission === 'denied',
  'gamepad-spoof': (p) => !!p.gamepads && p.gamepads.len === 4 && p.gamepads.nonNull === 0,
  'bluetooth-spoof': (p) => p.bluetooth === false,
  'usb-spoof': (p) => p.usb === 0,
  'serial-spoof': (p) => p.serial === 0,
  'hid-spoof': (p) => p.hid === 0,
  'client-rects': (p, b) => p.rectW !== b.rectW,
  'speech-spoof': (p) => p.voices !== null && p.voices <= 4,
  'media-spoof': (p) => Array.isArray(p.devices) && p.devices.length <= 3 && p.devices.every((d) => String(d.deviceId).indexOf('privacy-device-') === 0),
  'plugin-spoof': (p) => p.plugins === 3,
  'mimetype-spoof': (p) => p.mimeTypes === 2,
  'do-not-track': (p, b, x) => p.dnt === '1' && String((x.p.headers || {}).dnt || '') === '1',
  'referer-control': (p, b, x) => x.targetReferer === null && x.docRef === '' && p.metaReferrer === 'no-referrer',
  'cookie-sanitize': (p) => !/_ga=/.test(p.cookies || ''),
  'etag-clear': (p, b, x) => x.secondEtag === null,
  'user-agent-override': (p) => p.ua === DESKTOP_UA && p.appVersion === DESKTOP_UA.replace(/^Mozilla\//, ''),
  'sec-ch-ua-spoof': (p) => !!p.uaData && p.uaData.mobile === false && p.uaData.platform === 'Windows' && p.uaData.brands.some((b) => b.brand === 'Google Chrome'),
  'navigator-override': (p) => p.maxTouchPoints === 0 && p.dnt === '1',
  'window-properties': (p) => p.innerW === 1000 && p.innerH === 700 && p.dpr === 1 && p.outerW >= 1000,
  'iframe-sandbox': (p) => p.iframeWebdriver === false,
};

async function main() {
  console.log('[privacy] platform:', process.platform, process.arch);
  const bundled = platform.findBundledBrowser();
  console.log('[privacy] browser:', bundled || '(auto)');
  if (!bundled && process.platform === 'linux' && !process.env.DISPLAY) {
    console.log('[privacy] NOTE: on Linux CI run with xvfb-run -a if no DISPLAY is set.');
  }

  const { server, base } = await startProbeServer();
  const browser = await launchBrowser({
    headless: true,
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
    ],
    sessionId: 'privacy-test',
    onLog: () => {},
  });

  let failures = 0;
  let passes = 0;
  const notes = [];

  try {
    console.log('\n[privacy] Baseline (no toggles) ...');
    const baseline = await runCase(browser, base, []);
    console.log('[privacy] baseline UA:', baseline.p.ua);
    console.log('[privacy] baseline platform:', baseline.p.platform, '| CH:', JSON.stringify(baseline.p.uaData));

    console.log(`\n[privacy] Checking ${PRIVACY_FEATURE_IDS.length} features one by one ...`);
    for (const id of PRIVACY_FEATURE_IDS) {
      const check = CHECKS[id];
      if (!check) {
        console.log(`  [SKIP] ${id.padEnd(22)} no check implemented`);
        notes.push(`${id}: no automated check`);
        continue;
      }
      let result;
      try {
        const opts = id === 'screen-spoof'
          ? { screen: { width: 1920, height: 1080 } }
          : (id === 'timezone-spoof' ? { timezone: '' } : {});
        result = await runCase(browser, base, [id], opts);
        const ok = !!check(result.p, baseline.p, result);
        if (ok) { passes++; console.log(`  [PASS] ${id}`); }
        else {
          failures++;
          console.log(`  [FAIL] ${id}`);
          const keys = Object.keys(CHECKS);
          if (id === 'media-spoof') notes.push('media-spoof needs fake capture devices in this environment');
          if (id === 'speech-spoof') notes.push('speech-spoof: headless Chromium may expose 0 voices');
          void keys;
        }
      } catch (err) {
        failures++;
        console.log(`  [FAIL] ${id.padEnd(22)} ${(err && err.message) || err}`);
      }
    }

    // ── popup / background tab coverage ────────────────────────────────
    console.log('\n[privacy] Popup coverage (context-level install) ...');
    try {
      const ctx = await browser.newContext(Object.assign({
        viewport: { width: 1000, height: 700 },
        userAgent: DESKTOP_UA,
      }, privacyContextOptions(['platform-spoof', 'do-not-track'])));
      await installPrivacyGuard(ctx, {
        privacyFeatures: ['platform-spoof', 'do-not-track'],
        privacyLevel: 'standard',
        ua: DESKTOP_UA,
        platform: 'Win32',
        chPlatform: 'Windows',
        brands: uaBrands(DESKTOP_UA),
        device: 'desktop',
        viewport: VIEWPORT,
        onLog: () => {},
      });
      const page = await ctx.newPage();
      await page.goto(base + '/', { waitUntil: 'load' });
      const popupPromise = ctx.waitForEvent('page');
      await page.evaluate(() => { window.open('/echo', '_blank'); });
      const popup = await popupPromise;
      await popup.waitForLoadState('domcontentloaded');
      const popupPlatform = await popup.evaluate(() => navigator.platform);
      const popupDnt = await popup.evaluate(() => navigator.doNotTrack);
      const ok = popupPlatform === 'Win32' && popupDnt === '1';
      if (ok) { passes++; console.log('  [PASS] popup / background tab privacy'); }
      else { failures++; console.log(`  [FAIL] popup / background tab privacy (platform=${popupPlatform}, dnt=${popupDnt})`); }
      await ctx.close();
    } catch (err) {
      failures++;
      console.log(`  [FAIL] popup coverage: ${(err && err.message) || err}`);
    }

    // ── Traffic Source referral + Referer Control interaction ──────────
    console.log('\n[privacy] Traffic Source referral (must survive privacy, clicks must not be blocked) ...');
    const trafficCases = [
      ['traffic + referer-control', ['do-not-track', 'language-spoof', 'referer-control'], true],
      ['traffic + DNT only', ['do-not-track', 'language-spoof'], false],
    ];
    for (const [label, features, expectBlankTarget] of trafficCases) {
      try {
        const ctx = await browser.newContext(Object.assign({
          viewport: { width: 1000, height: 700 },
          userAgent: DESKTOP_UA,
        }, privacyContextOptions(features)));
        const ts = await installTrafficSource(ctx, {
          enabled: true,
          mode: 'fixed',
          source: 'google',
        }, { log: () => {} });
        await installPrivacyGuard(ctx, {
          privacyFeatures: features,
          privacyLevel: 'standard',
          ua: DESKTOP_UA,
          platform: 'Win32',
          chPlatform: 'Windows',
          brands: uaBrands(DESKTOP_UA),
          device: 'desktop',
          viewport: VIEWPORT,
          timezone: '',
          trafficReferrer: ts.applied ? ts.referrer : '',
          onLog: () => {},
        });
        const page = await ctx.newPage();
        lastRefReferer = null;
        lastRefererToTarget = undefined;
        await page.goto(base + '/ref', { waitUntil: 'load' });
        const landing = lastRefReferer;
        let clickOk = true;
        try {
          await Promise.all([page.waitForURL('**/target'), page.click('#l')]);
        } catch (_) { clickOk = false; }
        const docRef = clickOk ? await page.evaluate(() => document.referrer) : null;
        const targetRef = clickOk ? lastRefererToTarget : null;
        const ok = !!ts.applied
          && landing === 'https://www.google.com/'
          && clickOk
          && (expectBlankTarget ? targetRef === null && docRef === '' : targetRef !== null);
        if (ok) { passes++; console.log(`  [PASS] ${label}`); }
        else {
          failures++;
          console.log(`  [FAIL] ${label} landing=${landing} clickOk=${clickOk} targetRef=${targetRef} docRef=${docRef}`);
        }
        await ctx.close();
      } catch (err) {
        failures++;
        console.log(`  [FAIL] ${label}: ${(err && err.message) || err}`);
      }
    }

    // ── device / Sec-CH-UA matrix (the Mobile=0 bug) ────────────────────
    console.log('\n[privacy] Device matrix (UA -> emulation -> Sec-CH-UA) ...');
    const matrix = [
      ['Windows desktop', 'win', 'desktop', 'Desktop', '?0', 'Windows'],
      ['Android phone', 'androidPhone', 'mobile', 'Mobile', '?1', 'Android'],
      ['Android tablet', 'androidTablet', 'tablet', 'Tablet', '?0', 'Android'],
      ['iPhone', 'iphone', 'mobile', 'Mobile', '?1', 'iOS'],
      ['iPad', 'ipad', 'tablet', 'Tablet', '?0', 'iOS'],
    ];
    for (const [name, uaKey, selected, expectedCategory, expectedMobile, expectedPlatform] of matrix) {
      try {
        const ua = UAS[uaKey];
        const device = resolveSessionDevice(selected, ua);
        const vp = chooseViewport(device, true, 0, 0, 1);
        const screenSize = physicalScreen(vp) || SCREEN;
        const ctx = await browser.newContext({
          viewport: { width: vp.width, height: vp.height },
          userAgent: ua,
          isMobile: !!vp.isMobile,
          hasTouch: !!vp.hasTouch,
          deviceScaleFactor: vp.deviceScaleFactor || 1,
          screen: { width: screenSize.width, height: screenSize.height },
        });
        const page = await ctx.newPage();
        await page.goto(base + '/echo', { waitUntil: 'domcontentloaded' });
        const headers = JSON.parse(await page.evaluate(() => document.body.innerText));
        const uaData = await page.evaluate(() => navigator.userAgentData
          ? { mobile: navigator.userAgentData.mobile, platform: navigator.userAgentData.platform }
          : null);
        const gotMobile = headers['sec-ch-ua-mobile'];
        const gotPlatform = headers['sec-ch-ua-platform'];
        const category = gotMobile === '?1' ? 'Mobile' : (gotPlatform === '"Android"' || gotPlatform === '"iOS"' ? 'Tablet' : 'Desktop');
        const ok = device === expectedCategory.toLowerCase()
          && gotMobile === expectedMobile
          && gotPlatform === `"${expectedPlatform}"`
          && category === expectedCategory
          && !!uaData && uaData.mobile === (expectedMobile === '?1');
        if (ok) { passes++; console.log(`  [PASS] ${name.padEnd(16)} -> ${device.padEnd(7)} | ${gotMobile} | ${gotPlatform} | ${category}`); }
        else { failures++; console.log(`  [FAIL] ${name.padEnd(16)} -> device=${device} chMobile=${gotMobile} chPlatform=${gotPlatform} category=${category} js=${JSON.stringify(uaData)}`); }
        await ctx.close();
      } catch (err) {
        failures++;
        console.log(`  [FAIL] ${name}: ${(err && err.message) || err}`);
      }
    }
  } finally {
    try { await browser.close(); } catch (_) {}
    try { server.close(); } catch (_) {}
  }

  console.log(`\n[privacy] Result: ${passes} passed, ${failures} failed`);
  if (notes.length) notes.forEach((n) => console.log('[privacy] note:', n));
  if (failures) {
    console.log('[privacy] FAILED');
    process.exit(1);
  }
  console.log('[privacy] ALL CHECKS PASSED');
}

main().catch((err) => {
  console.error('[privacy] fatal:', err);
  process.exit(1);
});
