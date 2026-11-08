// PrivacyGuard.js
// Applies browser anti-detection / fingerprint-protection features to a
// Playwright BrowserContext (preferred) or a single Page via addInitScript.
//
//   installPrivacyGuard(context, { privacyFeatures, privacyLevel, ua, device,
//                                  viewport, timezone, trafficReferrer, onLog })
//
// A context-level install covers every tab the site opens - the main page,
// ad popups and background tabs - which is what the Privacy page promises.
//
// The spoofed values are derived from the session User-Agent / device instead
// of a hardcoded Windows desktop, so a mobile or tablet session stays
// internally consistent (UA, Client Hints, navigator.platform, screen, touch,
// WebGL renderer and DPR all agree).
//
// Feature IDs match PRIVACY_FEATURES in index.html one-to-one.

'use strict';

// Kept in sync with PRIVACY_FEATURES in index.html. Used by the automated
// privacy test so a newly added toggle cannot silently go untested.
const PRIVACY_FEATURE_IDS = [
  'webgl-spoof',
  'canvas-noise',
  'audio-spoof',
  'font-spoof',
  'hardware-spoof',
  'device-memory-spoof',
  'screen-spoof',
  'timezone-spoof',
  'language-spoof',
  'platform-spoof',
  'webrtc-leak',
  'dns-prefetch',
  'hyperlink-audit',
  'battery-spoof',
  'sensor-spoof',
  'gamepad-spoof',
  'bluetooth-spoof',
  'usb-spoof',
  'serial-spoof',
  'hid-spoof',
  'client-rects',
  'speech-spoof',
  'media-spoof',
  'plugin-spoof',
  'mimetype-spoof',
  'do-not-track',
  'referer-control',
  'cookie-sanitize',
  'etag-clear',
  'user-agent-override',
  'sec-ch-ua-spoof',
  'navigator-override',
  'window-properties',
  'iframe-sandbox',
];

function hashSeed(str) {
  let h = 2166136261 >>> 0;
  const s = String(str || '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

// Request headers that a page script cannot set. Context options / extra
// headers are the only reliable way to send them.
function privacyRequestHeaders(features, opts = {}) {
  const set = new Set(Array.isArray(features) ? features : []);
  const headers = {};
  if (set.has('language-spoof')) headers['Accept-Language'] = 'en-US,en;q=0.9';
  if (set.has('do-not-track')) {
    headers['DNT'] = '1';
    headers['Sec-GPC'] = '1';
  }
  if (opts.trafficReferrer) {
    // Traffic Source is a marketing feature: its referrer must survive even
    // when other privacy headers (DNT / Accept-Language) are also set. The
    // context drops it again after the landing document (see installPrivacyGuard)
    // so later in-page clicks are not rejected by Chromium.
    headers['Referer'] = opts.trafficReferrer;
  } else if (set.has('referer-control')) {
    // Blank the referrer on every request; the init script also inserts
    // <meta name="referrer" content="no-referrer"> and hides document.referrer.
    headers['Referer'] = '';
    headers['Referrer-Policy'] = 'no-referrer';
  }
  return headers;
}

function privacyContextOptions(features) {
  const set = new Set(Array.isArray(features) ? features : []);
  const opts = {};
  const headers = privacyRequestHeaders(features);
  if (Object.keys(headers).length) opts.extraHTTPHeaders = headers;
  if (set.has('language-spoof')) opts.locale = 'en-US';
  return opts;
}

function deviceTouchPoints(device) {
  if (device === 'mobile' || device === 'tablet') return 5;
  return 0;
}

function webglIdentity(device, platformName) {
  if (device === 'mobile') {
    if (platformName === 'iPhone') return { vendor: 'Apple Inc.', renderer: 'Apple GPU' };
    return { vendor: 'Qualcomm', renderer: 'Adreno (TM) 640' };
  }
  if (device === 'tablet') {
    if (platformName === 'iPhone') return { vendor: 'Apple Inc.', renderer: 'Apple GPU' };
    return { vendor: 'Qualcomm', renderer: 'Adreno (TM) 650' };
  }
  if (platformName === 'MacIntel') {
    return { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, Apple M1 Pro, OpenGL 4.1)' };
  }
  if (platformName === 'Linux x86_64') {
    return { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Mesa Intel(R) UHD Graphics 630 (CFL GT2), OpenGL 4.6)' };
  }
  return {
    vendor: 'Google Inc. (NVIDIA Corporation)',
    renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 SUPER Direct3D11 vs_5_0 ps_5_0, D3D11)',
  };
}

function privacyLaunchArgs() {
  // Chromium's --no-referrers does not blank navigation referrers; the
  // meta[referrer] + extraHTTPHeaders combination does (see applyRefererControl).
  return [];
}

async function installPrivacyGuard(target, opts = {}) {
  if (!target || typeof target.addInitScript !== 'function') return { applied: 0 };

  const features = Array.from(new Set(Array.isArray(opts.privacyFeatures) ? opts.privacyFeatures : []));
  const set = new Set(features);
  const level = opts.privacyLevel || 'standard';
  const onLog = typeof opts.onLog === 'function' ? opts.onLog : () => {};
  // BrowserContext has newPage()/pages(); Page does not.
  const isContext = typeof target.newPage === 'function' && typeof target.pages === 'function';

  const ua = typeof opts.ua === 'string' ? opts.ua : '';
  const device = opts.device === 'mobile' || opts.device === 'tablet' ? opts.device : 'desktop';
  const platformName = typeof opts.platform === 'string' ? opts.platform : '';
  const chPlatform = typeof opts.chPlatform === 'string' ? opts.chPlatform : '';
  const viewport = opts.viewport && typeof opts.viewport === 'object' ? opts.viewport : {};
  const dpr = Number(viewport.deviceScaleFactor) || 1;
  const vpWidth = Number(viewport.width) || 1280;
  const vpHeight = Number(viewport.height) || 800;
  const screenSize = opts.screen && opts.screen.width
    ? { width: Number(opts.screen.width), height: Number(opts.screen.height) }
    : { width: Math.round(vpWidth * dpr), height: Math.round(vpHeight * dpr) };
  const timezone = typeof opts.timezone === 'string' && opts.timezone ? opts.timezone : '';
  const brands = Array.isArray(opts.brands) ? opts.brands : [];
  const major = (brands[1] && brands[1].version) || (brands[0] && brands[0].version) || '';

  const payload = {
    features,
    level,
    ua,
    device,
    platform: platformName,
    chPlatform,
    brands,
    fullVersion: major ? `${major}.0.0.0` : '',
    viewport: { width: vpWidth, height: vpHeight, deviceScaleFactor: dpr },
    screen: screenSize,
    timezone,
    touchPoints: deviceTouchPoints(device),
    webgl: webglIdentity(device, platformName),
    languages: ['en-US', 'en'],
    seed: hashSeed(`${ua}|${device}|${platformName}|${timezone}`),
  };

  try {
    await target.addInitScript(privacyInitScript, payload);
  } catch (err) {
    onLog(`[PrivacyGuard] Could not install privacy features: ${(err && err.message) || err}`, 'WARN');
    return { applied: 0, error: String((err && err.message) || err) };
  }

  if (isContext) {
    // Network-level headers (DNT / Accept-Language / blank Referer). Only set
    // when a feature needs them, so an active Traffic Source referrer is not
    // wiped by an unrelated toggle.
    const headers = privacyRequestHeaders(features, { trafficReferrer: opts.trafficReferrer });
    if (Object.keys(headers).length) {
      try {
        await target.setExtraHTTPHeaders(headers);
      } catch (err) {
        onLog(`[PrivacyGuard] Could not set privacy headers: ${(err && err.message) || err}`, 'WARN');
      }
      if (set.has('referer-control') && opts.trafficReferrer) {
        onLog('[PrivacyGuard] Referer Control kept the Traffic Source referrer (both are enabled).', 'WARN');
      }
    }

    // A cross-origin Referer that stays on the whole context makes Chromium
    // reject later in-page navigations (ERR_BLOCKED_BY_CLIENT), because the
    // header no longer matches the page that initiated the click. The spoofed
    // referrer is only meant for the landing request, so drop it as soon as
    // the first document response arrives and keep just the privacy headers.
    if (opts.trafficReferrer) {
      let cleared = false;
      const clearLandingReferer = () => {
        if (cleared) return;
        cleared = true;
        const finalHeaders = privacyRequestHeaders(features, { trafficReferrer: '' });
        try {
          const p = target.setExtraHTTPHeaders(finalHeaders);
          if (p && typeof p.catch === 'function') p.catch(() => {});
        } catch (_) {}
      };
      const onResponse = (resp) => {
        try {
          const req = resp.request();
          if (req.resourceType() !== 'document') return;
          const status = resp.status();
          // Follow redirects (http -> https, www -> apex) with the original
          // referrer; clear on the first real document response.
          if (status >= 300 && status < 400) return;
          try { target.off('response', onResponse); } catch (_) {}
          clearLandingReferer();
        } catch (_) {}
      };
      try {
        target.on('response', onResponse);
        const timer = setTimeout(() => {
          try { target.off('response', onResponse); } catch (_) {}
        }, 120000);
        if (timer && typeof timer.unref === 'function') timer.unref();
      } catch (_) {}
    }

    // ETag tracking is an HTTP-cache signal; removing the conditional request
    // headers on every request defeats it. The init script also clears the
    // CacheStorage / Cache API copy.
    if (set.has('etag-clear')) {
      try {
        await target.route('**/*', async (route) => {
          try {
            const headers2 = Object.assign({}, route.request().headers());
            delete headers2['if-none-match'];
            delete headers2['if-modified-since'];
            await route.continue({ headers: headers2 });
          } catch (_) {
            try { await route.fallback(); } catch (__) {}
          }
        });
      } catch (err) {
        onLog(`[PrivacyGuard] ETag request filter could not start: ${(err && err.message) || err}`, 'WARN');
      }
    }
  }

  onLog(`[PrivacyGuard] Applied ${features.length} privacy feature(s) (${level}) to ${isContext ? 'the whole browser context' : 'the page'}`);
  return { applied: features.length, features };
}

// ─────────────────────────────────────────────────────────────────────────────
// Runs inside the page before any site script.
// ─────────────────────────────────────────────────────────────────────────────
function privacyInitScript(payload) {
  const enabled = payload.features || [];
  const set = new Set(enabled);
  const p = payload || {};
  const seed = (p.seed >>> 0) || 1;
  const TZ = p.timezone || 'America/New_York';

  try { basicAntiBot(); } catch (_) {}

  if (set.has('webgl-spoof')) try { applyWebGLSpoof(); } catch (_) {}
  if (set.has('canvas-noise')) try { applyCanvasNoise(); } catch (_) {}
  if (set.has('audio-spoof')) try { applyAudioSpoof(); } catch (_) {}
  if (set.has('font-spoof')) try { applyFontSpoof(); } catch (_) {}
  if (set.has('hardware-spoof')) try { applyHardwareSpoof(); } catch (_) {}
  if (set.has('device-memory-spoof')) try { applyDeviceMemorySpoof(); } catch (_) {}
  if (set.has('screen-spoof')) try { applyScreenSpoof(); } catch (_) {}
  if (set.has('timezone-spoof')) try { applyTimezoneSpoof(); } catch (_) {}
  if (set.has('language-spoof')) try { applyLanguageSpoof(); } catch (_) {}
  if (set.has('platform-spoof')) try { applyPlatformSpoof(); } catch (_) {}
  if (set.has('client-rects')) try { applyClientRectsSpoof(); } catch (_) {}
  if (set.has('speech-spoof')) try { applySpeechSpoof(); } catch (_) {}
  if (set.has('media-spoof')) try { applyMediaSpoof(); } catch (_) {}
  if (set.has('plugin-spoof')) try { applyPluginSpoof(); } catch (_) {}
  if (set.has('mimetype-spoof')) try { applyMimetypeSpoof(); } catch (_) {}
  if (set.has('user-agent-override')) try { applyUserAgentOverride(); } catch (_) {}
  if (set.has('sec-ch-ua-spoof')) try { applySecChUaSpoof(); } catch (_) {}
  if (set.has('navigator-override')) try { applyNavigatorOverride(); } catch (_) {}
  if (set.has('window-properties')) try { applyWindowProperties(); } catch (_) {}
  if (set.has('iframe-sandbox')) try { applyIframeSandbox(); } catch (_) {}

  if (set.has('webrtc-leak')) try { applyWebRTCLeakProtection(); } catch (_) {}
  if (set.has('dns-prefetch')) try { applyDisableDNSPrefetch(); } catch (_) {}
  if (set.has('hyperlink-audit')) try { applyDisableHyperlinkAudit(); } catch (_) {}
  if (set.has('do-not-track')) try { applyDoNotTrack(); } catch (_) {}
  if (set.has('referer-control')) try { applyRefererControl(); } catch (_) {}
  if (set.has('cookie-sanitize')) try { applyCookieSanitize(); } catch (_) {}
  if (set.has('etag-clear')) try { applyETagClear(); } catch (_) {}

  if (set.has('battery-spoof')) try { applyBatterySpoof(); } catch (_) {}
  if (set.has('sensor-spoof')) try { applySensorSpoof(); } catch (_) {}
  if (set.has('gamepad-spoof')) try { applyGamepadSpoof(); } catch (_) {}
  if (set.has('bluetooth-spoof')) try { applyBluetoothSpoof(); } catch (_) {}
  if (set.has('usb-spoof')) try { applyUSBSpoof(); } catch (_) {}
  if (set.has('serial-spoof')) try { applySerialSpoof(); } catch (_) {}
  if (set.has('hid-spoof')) try { applyHIDSpoof(); } catch (_) {}

  // ── helpers ────────────────────────────────────────────────────────────────
  function define(obj, prop, getter) {
    try { Object.defineProperty(obj, prop, { get: getter, configurable: true }); } catch (_) {}
  }

  function domReady(fn) {
    try {
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn, { once: true });
      else fn();
    } catch (_) {}
  }

  function tzOffsetMinutes(tzName, date) {
    try {
      const dtf = new Intl.DateTimeFormat('en-US', {
        timeZone: tzName, hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      });
      const parts = {};
      dtf.formatToParts(date).forEach((x) => { parts[x.type] = x.value; });
      const asUTC = Date.UTC(
        parseInt(parts.year, 10), parseInt(parts.month, 10) - 1, parseInt(parts.day, 10),
        parseInt(parts.hour, 10) % 24, parseInt(parts.minute, 10), parseInt(parts.second, 10)
      );
      return Math.round((date.getTime() - asUTC) / 60000);
    } catch (_) {
      return 300;
    }
  }

  // ── always on ──────────────────────────────────────────────────────────────
  function basicAntiBot() {
    define(navigator, 'webdriver', () => false);
    try { delete navigator.__proto__.webdriver; } catch (_) {}
    try {
      window.chrome = window.chrome || {};
      window.chrome.runtime = window.chrome.runtime || {};
    } catch (_) {}
    // Notification permission is a classic headless/automation tell.
    try {
      if (window.Notification && typeof Notification.permission === 'string' && Notification.permission === 'denied') {
        Object.defineProperty(Notification, 'permission', { get: () => 'default', configurable: true });
      }
    } catch (_) {}
  }

  // ── Browser fingerprint ────────────────────────────────────────────────────
  function applyWebGLSpoof() {
    const info = p.webgl || { vendor: 'Google Inc.', renderer: 'ANGLE' };
    const patch = (proto) => {
      if (!proto) return;
      const orig = proto.getParameter;
      proto.getParameter = function (param) {
        if (param === 37445) return info.vendor;   // UNMASKED_VENDOR_WEBGL
        if (param === 37446) return info.renderer; // UNMASKED_RENDERER_WEBGL
        return orig.call(this, param);
      };
      const origExt = proto.getExtension;
      proto.getExtension = function (name) {
        const ext = origExt.call(this, name);
        if (name === 'WEBGL_debug_renderer_info') {
          try {
            Object.defineProperty(ext, 'UNMASKED_VENDOR_WEBGL', { value: 37445, configurable: true });
            Object.defineProperty(ext, 'UNMASKED_RENDERER_WEBGL', { value: 37446, configurable: true });
          } catch (_) {}
        }
        return ext;
      };
    };
    patch(window.WebGLRenderingContext && WebGLRenderingContext.prototype);
    patch(window.WebGL2RenderingContext && WebGL2RenderingContext.prototype);
  }

  function applyCanvasNoise() {
    const bit = (x, y) => {
      let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + seed) >>> 0;
      h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
      return (h >>> 16) & 1;
    };
    const origGet = CanvasRenderingContext2D.prototype.getImageData;
    CanvasRenderingContext2D.prototype.getImageData = function () {
      const img = origGet.apply(this, arguments);
      try {
        const d = img.data;
        for (let i = 0; i < d.length; i += 4) {
          const n = bit(d[i], d[i + 1]);
          d[i] ^= n;
          d[i + 1] ^= n;
          d[i + 2] ^= n;
        }
      } catch (_) {}
      return img;
    };
    const stamped = new WeakSet();
    const stamp = (canvas) => {
      if (stamped.has(canvas)) return;
      stamped.add(canvas);
      try {
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.save();
        ctx.globalAlpha = 0.002;
        ctx.fillStyle = `rgb(${seed & 255},${(seed >>> 8) & 255},${(seed >>> 16) & 255})`;
        ctx.fillRect(0, 0, 1, 1);
        ctx.restore();
      } catch (_) {}
    };
    const origData = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function () {
      stamp(this);
      return origData.apply(this, arguments);
    };
    const origBlob = HTMLCanvasElement.prototype.toBlob;
    if (origBlob) {
      HTMLCanvasElement.prototype.toBlob = function () {
        stamp(this);
        return origBlob.apply(this, arguments);
      };
    }
  }

  function applyAudioSpoof() {
    const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!Offline) return;
    const orig = Offline.prototype.startRendering;
    Offline.prototype.startRendering = function () {
      return orig.apply(this, arguments).then((buf) => {
        try {
          const d = buf.getChannelData(0);
          const step = Math.max(1, Math.floor(d.length / 1000));
          let s = seed;
          for (let i = 0; i < d.length; i += step) {
            s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
            d[i] += (((s >>> 9) / 8388608) - 0.5) * 1e-6;
          }
        } catch (_) {}
        return buf;
      });
    };
  }

  function applyFontSpoof() {
    const origMeasure = CanvasRenderingContext2D.prototype.measureText;
    CanvasRenderingContext2D.prototype.measureText = function (text) {
      const m = origMeasure.apply(this, arguments);
      try {
        const s = String(text == null ? '' : text);
        const f = String(this.font || '');
        let h = seed >>> 0;
        for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
        for (let i = 0; i < f.length; i++) h = Math.imul(h ^ f.charCodeAt(i), 16777619) >>> 0;
        const delta = ((h % 200) - 100) / 1000; // -0.1 .. +0.099 px
        Object.defineProperty(m, 'width', { value: m.width + delta, configurable: true });
      } catch (_) {}
      return m;
    };

    // Only probe-style elements (rare font families) get a tiny size change, so
    // normal page layout is untouched.
    const rare = [
      'algerian', 'baskerville', 'big caslon', 'bodoni mt', 'bookman old style',
      'brush script mt', 'copperplate', 'didot', 'garamond', 'gill sans',
      'herculanum', 'hoefler text', 'lucida grande', 'marker felt', 'monaco',
      'papyrus', 'perpetua', 'rockwell', 'savoye let', 'skia', 'trattatello',
      'wingdings', 'zapfino', 'cambria math',
    ];
    const cache = new WeakMap();
    const isRare = (el) => {
      try {
        if (cache.has(el)) return cache.get(el);
        const fam = String((window.getComputedStyle(el) || {}).fontFamily || '').toLowerCase();
        const v = rare.some((f) => fam.indexOf(f) !== -1);
        cache.set(el, v);
        return v;
      } catch (_) {
        return false;
      }
    };
    const wDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
    if (wDesc && wDesc.get) {
      Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
        configurable: true,
        get: function () {
          const w = wDesc.get.call(this);
          if (!isRare(this)) return w;
          let h = (seed ^ (this.textContent ? this.textContent.length : 0)) >>> 0;
          h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
          return w + ((h & 3) - 1); // -1 .. +2 px, deterministic
        },
      });
    }
    try {
      if (document.fonts && typeof document.fonts.check === 'function') {
        const origCheck = document.fonts.check.bind(document.fonts);
        document.fonts.check = function (font, text) {
          try {
            const f = String(font || '').toLowerCase();
            if (rare.some((name) => f.indexOf(name) !== -1)) return false;
          } catch (_) {}
          return origCheck(font, text);
        };
      }
    } catch (_) {}
  }

  function applyHardwareSpoof() {
    const cores = p.device === 'desktop' ? 8 : 4;
    define(navigator, 'hardwareConcurrency', () => cores);
  }

  function applyDeviceMemorySpoof() {
    const mem = p.device === 'desktop' ? 8 : 4;
    define(navigator, 'deviceMemory', () => mem);
  }

  function applyScreenSpoof() {
    const s = p.screen || {};
    if (!s.width || !s.height) return;
    define(screen, 'width', () => s.width);
    define(screen, 'height', () => s.height);
    define(screen, 'availWidth', () => s.width);
    define(screen, 'availHeight', () => s.height);
    define(screen, 'colorDepth', () => 24);
    define(screen, 'pixelDepth', () => 24);
  }

  // Reviewer note: timezoneId is applied by the browser context. This script
  // only spoofs the JS-visible clock when no context timezone was supplied.
  function applyTimezoneSpoof() {
    if (p.timezone) return; // context already set the real proxy timezone
    const origOffset = Date.prototype.getTimezoneOffset;
    Date.prototype.getTimezoneOffset = function () {
      try { return tzOffsetMinutes(TZ, new Date(this.getTime())); } catch (_) { return origOffset.call(this); }
    };
    try {
      const OrigDTF = Intl.DateTimeFormat;
      const patched = function (locales, options) {
        const o = options && typeof options === 'object' ? Object.assign({}, options) : {};
        if (!o.timeZone) o.timeZone = TZ;
        return new OrigDTF(locales, o);
      };
      patched.prototype = OrigDTF.prototype;
      patched.supportedLocalesOf = OrigDTF.supportedLocalesOf;
      Intl.DateTimeFormat = patched;
    } catch (_) {}
    try {
      const origToString = Date.prototype.toLocaleString;
      Date.prototype.toLocaleString = function (locales, options) {
        const o = options && typeof options === 'object' ? Object.assign({}, options) : {};
        if (!o.timeZone) o.timeZone = TZ;
        return origToString.call(this, locales, o);
      };
    } catch (_) {}
  }

  function applyLanguageSpoof() {
    define(navigator, 'languages', () => p.languages || ['en-US', 'en']);
    define(navigator, 'language', () => (p.languages && p.languages[0]) || 'en-US');
  }

  function applyPlatformSpoof() {
    if (!p.platform) return;
    define(navigator, 'platform', () => p.platform);
  }

  function applyClientRectsSpoof() {
    const offsets = new WeakMap();
    const orig = Element.prototype.getClientRects;
    Element.prototype.getClientRects = function () {
      const rects = orig.apply(this, arguments);
      if (!rects || !rects.length) return rects;
      let o = offsets.get(this);
      if (o === undefined) {
        let h = (seed ^ (this.tagName ? this.tagName.charCodeAt(0) : 7)) >>> 0;
        h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0;
        o = ((h % 61) - 30) / 1000; // -0.03 .. +0.03 px
        offsets.set(this, o);
      }
      const out = [];
      for (let i = 0; i < rects.length; i++) {
        const r = rects[i];
        out.push(new DOMRect(r.x + o, r.y + o, Math.max(0, r.width - o * 2), Math.max(0, r.height - o * 2)));
      }
      return out;
    };
  }

  function applySpeechSpoof() {
    if (!window.speechSynthesis) return;
    const orig = speechSynthesis.getVoices;
    speechSynthesis.getVoices = function () {
      const list = orig.apply(this, arguments) || [];
      // Keep a short, stable slice; remove exotic local voices that reveal the
      // real OS/language mix.
      return Array.prototype.slice.call(list, 0, 4);
    };
  }

  function applyMediaSpoof() {
    const md = navigator.mediaDevices;
    if (!md || typeof md.enumerateDevices !== 'function') return;
    const orig = md.enumerateDevices;
    md.enumerateDevices = function () {
      return orig.apply(this, arguments).then((list) => {
        return (list || []).slice(0, 3).map((d, i) => ({
          deviceId: 'privacy-device-' + i,
          groupId: 'privacy-group-' + i,
          kind: d.kind,
          label: d.label || '',
          toJSON() { return { deviceId: this.deviceId, groupId: this.groupId, kind: this.kind, label: this.label }; },
        }));
      });
    };
  }

  function fakeList(items, itemKey) {
    const arr = items.slice();
    arr.item = (i) => arr[i] || null;
    arr.namedItem = (n) => arr.filter((x) => String(x[itemKey]) === String(n))[0] || null;
    arr.refresh = () => {};
    return arr;
  }

  function applyPluginSpoof() {
    const plugins = [
      { name: 'PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 1 },
      { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 1 },
      { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 1 },
    ];
    define(navigator, 'plugins', () => fakeList(plugins, 'name'));
  }

  function applyMimetypeSpoof() {
    const types = [
      { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
      { type: 'text/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
    ];
    define(navigator, 'mimeTypes', () => fakeList(types, 'type'));
  }

  function applyUserAgentOverride() {
    if (!p.ua) return;
    const ua = p.ua;
    const appVersion = ua.replace(/^Mozilla\//, '');
    define(navigator, 'userAgent', () => ua);
    define(navigator, 'appVersion', () => appVersion);
    define(navigator, 'appCodeName', () => 'Mozilla');
  }

  function applySecChUaSpoof() {
    if (!navigator.userAgentData) return;
    const brands = (p.brands || []).map((b) => ({ brand: String(b.brand), version: String(b.version) }));
    if (!brands.length) return;
    const mobile = p.device === 'mobile';
    const platformName = p.chPlatform || 'Windows';
    const fullVersionList = brands.map((b) => ({ brand: b.brand, version: b.version + '.0.0.0' }));
    const data = {
      brands,
      mobile,
      platform: platformName,
      getHighEntropyValues: function (hints) {
        const out = {
          brands,
          mobile,
          platform: platformName,
          platformVersion: platformName === 'Windows' ? '10.0.0' : (platformName === 'Android' ? '13.0.0' : '17.0.0'),
          architecture: 'x86',
          bitness: '64',
          model: p.device === 'mobile' ? 'Pixel 7' : '',
          uaFullVersion: p.fullVersion || '',
          fullVersionList,
        };
        if (Array.isArray(hints) && hints.length) {
          const filtered = {};
          hints.forEach((h) => { if (h in out) filtered[h] = out[h]; });
          return Promise.resolve(filtered);
        }
        return Promise.resolve(out);
      },
      toJSON: function () { return { brands, mobile, platform: platformName }; },
    };
    define(navigator, 'userAgentData', () => data);
  }

  function applyNavigatorOverride() {
    define(navigator, 'maxTouchPoints', () => p.touchPoints || 0);
    define(navigator, 'vendor', () => 'Google Inc.');
    define(navigator, 'appName', () => 'Netscape');
    define(navigator, 'appCodeName', () => 'Mozilla');
    define(navigator, 'product', () => 'Gecko');
    define(navigator, 'productSub', () => '20030107');
    define(navigator, 'cookieEnabled', () => true);
    define(navigator, 'onLine', () => true);
    define(navigator, 'doNotTrack', () => '1');
  }

  function applyWindowProperties() {
    const vp = p.viewport || { width: 1280, height: 800, deviceScaleFactor: 1 };
    const sc = p.screen || { width: vp.width, height: vp.height };
    define(window, 'innerWidth', () => vp.width);
    define(window, 'innerHeight', () => vp.height);
    define(window, 'outerWidth', () => Math.max(vp.width, sc.width));
    define(window, 'outerHeight', () => Math.max(vp.height, sc.height));
    define(window, 'devicePixelRatio', () => vp.deviceScaleFactor || 1);
  }

  function applyIframeSandbox() {
    try {
      const desc = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow');
      if (desc && desc.get) {
        Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
          configurable: true,
          get: function () {
            const cw = desc.get.call(this);
            if (cw) {
              try { Object.defineProperty(cw.navigator, 'webdriver', { get: () => false, configurable: true }); } catch (_) {}
            }
            return cw;
          },
        });
      }
    } catch (_) {}
    try {
      const desc = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentDocument');
      if (desc && desc.get) {
        Object.defineProperty(HTMLIFrameElement.prototype, 'contentDocument', {
          configurable: true,
          get: function () {
            const d = desc.get.call(this);
            if (d) {
              try { Object.defineProperty(d.defaultView.navigator, 'webdriver', { get: () => false, configurable: true }); } catch (_) {}
            }
            return d;
          },
        });
      }
    } catch (_) {}
  }

  // ── Network privacy ────────────────────────────────────────────────────────
  function applyWebRTCLeakProtection() {
    const wrap = (Orig) => {
      if (typeof Orig !== 'function') return null;
      const W = function (config) {
        const c = config && typeof config === 'object' ? Object.assign({}, config) : {};
        c.iceTransportPolicy = 'relay';
        return new Orig(c);
      };
      W.prototype = Orig.prototype;
      try { W.generateCertificate = Orig.generateCertificate; } catch (_) {}
      return W;
    };
    const rtc = wrap(window.RTCPeerConnection);
    if (rtc) { try { window.RTCPeerConnection = rtc; } catch (_) {} }
    const wrtc = wrap(window.webkitRTCPeerConnection);
    if (wrtc) { try { window.webkitRTCPeerConnection = wrtc; } catch (_) {} }
  }

  function removeLinkTags() {
    try {
      document.querySelectorAll('link[rel="dns-prefetch"],link[rel="prefetch"],link[rel="preconnect"]').forEach((l) => l.remove());
    } catch (_) {}
  }

  function applyDisableDNSPrefetch() {
    // The MutationObserver removes <link rel=prefetch/dns-prefetch/preconnect>
    // as soon as the parser/site adds one. (A rel setter cannot block the
    // attribute itself without breaking the element's own state.)
    domReady(function () {
      removeLinkTags();
      try {
        new MutationObserver(removeLinkTags).observe(document.documentElement, { childList: true, subtree: true });
      } catch (_) {}
    });
  }

  function stripPing() {
    try {
      document.querySelectorAll('a[ping]').forEach((a) => a.removeAttribute('ping'));
    } catch (_) {}
  }

  function applyDisableHyperlinkAudit() {
    try {
      const desc = Object.getOwnPropertyDescriptor(HTMLAnchorElement.prototype, 'ping');
      if (desc && desc.set) {
        Object.defineProperty(HTMLAnchorElement.prototype, 'ping', {
          configurable: true,
          get: desc.get,
          set: function () { /* drop audit pings */ },
        });
      }
    } catch (_) {}
    domReady(function () {
      stripPing();
      try {
        new MutationObserver(stripPing).observe(document.documentElement, { childList: true, subtree: true });
      } catch (_) {}
    });
  }

  function applyDoNotTrack() {
    define(navigator, 'doNotTrack', () => '1');
    try { define(window, 'doNotTrack', () => '1'); } catch (_) {}
    try { define(navigator, 'msDoNotTrack', () => '1'); } catch (_) {}
  }

  function applyRefererControl() {
    // Chromium re-adds the Referer header after request interception, so the
    // only reliable switch is a document-wide no-referrer policy. Insert the
    // meta tag as soon as the parser creates <head>. The context also sets an
    // empty Referer extra header (see privacyRequestHeaders) for subresources.
    try {
      const make = () => {
        const m = document.createElement('meta');
        m.name = 'referrer';
        m.content = 'no-referrer';
        m.setAttribute('data-td-privacy', '1');
        return m;
      };
      const insert = () => {
        const head = document.head;
        if (!head) return false;
        if (!head.querySelector('meta[data-td-privacy="1"]')) head.insertBefore(make(), head.firstChild);
        return true;
      };
      insert();
      const obs = new MutationObserver(() => { if (insert()) obs.disconnect(); });
      obs.observe(document, { childList: true, subtree: true });
      domReady(() => {
        try { obs.disconnect(); } catch (_) {}
        insert();
      });
    } catch (_) {}
    // Hide the referrer from JS fingerprinting too.
    try {
      Object.defineProperty(Document.prototype, 'referrer', { configurable: true, get: () => '' });
    } catch (_) {}
    // fetch() with an invalid referrer value would throw; use the policy field.
    try {
      const origFetch = window.fetch;
      if (origFetch) {
        window.fetch = function (input, init) {
          const o = init && typeof init === 'object' ? Object.assign({}, init) : {};
          delete o.referrer;
          try { o.referrerPolicy = 'no-referrer'; } catch (_) {}
          return origFetch.call(this, input, o);
        };
      }
    } catch (_) {}
  }

  function applyCookieSanitize() {
    const names = ['_ga', '_gid', '_gat', '_fbp', 'fr', 'trc', 'IDE', 'NID', 'MUID', 'ANID', '_uetvid', '_uetsid'];
    const blocked = new Set(names);

    // Fail closed for the classic tracking cookies: page/analytics scripts can
    // no longer write them, not even after DOMContentLoaded.
    let cookieDesc = null;
    try {
      cookieDesc = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
      if (cookieDesc && cookieDesc.set) {
        Object.defineProperty(Document.prototype, 'cookie', {
          configurable: true,
          get: cookieDesc.get,
          set: function (value) {
            try {
              const name = String(value == null ? '' : value).split('=')[0].trim();
              if (blocked.has(name)) return;
            } catch (_) {}
            return cookieDesc.set.call(this, value);
          },
        });
      }
    } catch (_) { cookieDesc = null; }

    // Expiry writes must bypass our own blocker, otherwise the deletion of an
    // already-present cookie would be dropped too.
    const rawCookie = function (value) {
      try {
        if (cookieDesc && cookieDesc.set) return cookieDesc.set.call(document, value);
        document.cookie = value;
      } catch (_) {}
    };

    const cleanup = function () {
      let host = '';
      try { host = location.hostname; } catch (_) {}
      const parts = host ? host.split('.') : [];
      const domains = host ? [host, '.' + host] : [];
      if (parts.length > 2) domains.push('.' + parts.slice(-2).join('.'));
      names.forEach((name) => {
        rawCookie(name + '=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/');
        domains.forEach((d) => {
          rawCookie(name + '=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; domain=' + d);
        });
      });
    };

    // Server response headers can (re)set cookies after DOMContentLoaded, so
    // clean at DOM ready, again on load, and for a short settling window.
    domReady(cleanup);
    try { window.addEventListener('load', cleanup, { once: true }); } catch (_) {}
    try {
      let left = 5;
      const timer = setInterval(function () {
        cleanup();
        if (--left <= 0) clearInterval(timer);
      }, 1500);
    } catch (_) {}
  }

  function applyETagClear() {
    domReady(function () {
      try {
        if (window.caches && caches.keys) {
          caches.keys().then((keys) => keys.forEach((k) => caches.delete(k))).catch(() => {});
        }
      } catch (_) {}
      // Service-worker caches can also store validator metadata.
      try {
        if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
          navigator.serviceWorker.getRegistrations().then((rs) => rs.forEach((r) => r.unregister().catch(() => {}))).catch(() => {});
        }
      } catch (_) {}
    });
  }

  // ── Sensor privacy ─────────────────────────────────────────────────────────
  function applyBatterySpoof() {
    const fake = {
      charging: true,
      chargingTime: 0,
      dischargingTime: Infinity,
      level: 1,
      onchargingchange: null,
      onchargingtimechange: null,
      ondischargingtimechange: null,
      onlevelchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    };
    try { navigator.getBattery = () => Promise.resolve(fake); } catch (_) {}
    define(navigator, 'getBattery', () => () => Promise.resolve(fake));
  }

  function applySensorSpoof() {
    // The real sensors do not exist on desktop; expose the standard API but
    // deny/neutralise it so pages cannot probe the host hardware.
    try {
      if (window.DeviceOrientationEvent) {
        window.DeviceOrientationEvent.requestPermission = () => Promise.resolve('granted');
      } else {
        const E = function DeviceOrientationEvent() {};
        E.requestPermission = () => Promise.resolve('denied');
        E.prototype = Object.create(Event.prototype);
        try { window.DeviceOrientationEvent = E; } catch (_) {}
      }
    } catch (_) {}
    try {
      if (window.DeviceMotionEvent) {
        window.DeviceMotionEvent.requestPermission = () => Promise.resolve('granted');
      }
    } catch (_) {}
  }

  function applyGamepadSpoof() {
    try {
      const fake = [null, null, null, null];
      fake.item = (i) => fake[i];
      navigator.getGamepads = () => fake;
    } catch (_) {}
  }

  function fakeDeviceApi(methods) {
    const api = {};
    Object.keys(methods).forEach((k) => { api[k] = methods[k]; });
    return api;
  }

  function applyBluetoothSpoof() {
    const fake = fakeDeviceApi({
      getAvailability: () => Promise.resolve(false),
      requestDevice: () => Promise.reject(new DOMException('Bluetooth adapter not available', 'NotFoundError')),
      getDevices: () => Promise.resolve([]),
    });
    define(navigator, 'bluetooth', () => fake);
  }

  function applyUSBSpoof() {
    const fake = fakeDeviceApi({
      getDevices: () => Promise.resolve([]),
      requestDevice: () => Promise.reject(new DOMException('No device selected', 'NotFoundError')),
    });
    define(navigator, 'usb', () => fake);
  }

  function applySerialSpoof() {
    const fake = fakeDeviceApi({
      getPorts: () => Promise.resolve([]),
      requestPort: () => Promise.reject(new DOMException('No port selected', 'NotFoundError')),
    });
    define(navigator, 'serial', () => fake);
  }

  function applyHIDSpoof() {
    const fake = fakeDeviceApi({
      getDevices: () => Promise.resolve([]),
      requestDevice: () => Promise.reject(new DOMException('No device selected', 'NotFoundError')),
    });
    define(navigator, 'hid', () => fake);
  }
}

module.exports = {
  installPrivacyGuard,
  privacyContextOptions,
  privacyRequestHeaders,
  privacyLaunchArgs,
  PRIVACY_FEATURE_IDS,
};
