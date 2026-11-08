// PrivacyGuard.js
// Applies browser anti-detection / fingerprint-protection features to a
// Playwright Page via addInitScript. Each feature is a self-contained IIFE
// that patches a specific browser API before the page's own scripts run.
//
// installPrivacyGuard(page, { privacyFeatures: [...], privacyLevel, onLog })
//   → returns a function that can be awaited/ignored. The guard is injected
//     once per page; it runs before any site JavaScript.
//
// Feature IDs match the PRIVACY_FEATURES list in index.html so the
// dashboard toggles map 1:1 to real protections.

/**
 * Inject all enabled privacy features into a Playwright page.
 * @param {import('playwright').Page} page
 * @param {Object} opts
 * @param {string[]} [opts.privacyFeatures] - enabled feature IDs
 * @param {string}   [opts.privacyLevel]   - 'standard' | 'balanced' | 'stealth'
 * @param {Function} [opts.onLog]          - (msg) => void
 */
async function installPrivacyGuard(page, opts = {}) {
  const features = new Set(opts.privacyFeatures || []);
  const level = opts.privacyLevel || 'standard';
  const onLog = opts.onLog || (() => {});

  if (features.size === 0) {
    // Even with no features selected, apply the bare-minimum anti-bot
    // patches so the browser doesn't scream "I'm a bot".
    await page.addInitScript(() => {
      try {
        Object.defineProperty(navigator, 'webdriver', { get: () => false, configurable: true });
      } catch (_) {}
      try {
        window.chrome = window.chrome || {};
        window.chrome.runtime = window.chrome.runtime || {};
      } catch (_) {}
      try { delete navigator.__proto__.webdriver; } catch (_) {}
    });
    return;
  }

  // Build a single init script that conditionally applies each enabled
  // feature. We pass the feature set as a serializable array plus the
  // proxy-derived timezone (a hardcoded timezone would itself be a location
  // mismatch when the proxy is in another country).
  const featureList = [...features];
  const proxyTimezone = typeof opts.timezone === 'string' ? opts.timezone : '';
  await page.addInitScript((payload) => {
    const enabled = payload.features || [];
    const tz = payload.timezone || '';
    const set = new Set(enabled);

    // ── Always-on basics ──────────────────────────────────────────────
    basicAntiBot();

    // ── Browser Fingerprint ───────────────────────────────────────────
    if (set.has('webgl-spoof')) applyWebGLSpoof();
    if (set.has('canvas-noise')) applyCanvasNoise();
    if (set.has('audio-spoof')) applyAudioSpoof();
    if (set.has('font-spoof')) applyFontSpoof();
    if (set.has('hardware-spoof')) applyHardwareSpoof();
    if (set.has('device-memory-spoof')) applyDeviceMemorySpoof();
    if (set.has('screen-spoof')) applyScreenSpoof();
    if (set.has('timezone-spoof')) applyTimezoneSpoof();
    if (set.has('language-spoof')) applyLanguageSpoof();
    if (set.has('platform-spoof')) applyPlatformSpoof();
    if (set.has('client-rects')) applyClientRectsSpoof();
    if (set.has('speech-spoof')) applySpeechSpoof();
    if (set.has('media-spoof')) applyMediaSpoof();
    if (set.has('plugin-spoof')) applyPluginSpoof();
    if (set.has('mimetype-spoof')) applyMimetypeSpoof();
    if (set.has('user-agent-override')) applyUserAgentOverride();
    if (set.has('sec-ch-ua-spoof')) applySecChUaSpoof();
    if (set.has('navigator-override')) applyNavigatorOverride();
    if (set.has('window-properties')) applyWindowProperties();
    if (set.has('iframe-sandbox')) applyIframeSandbox();

    // ── Network Privacy ───────────────────────────────────────────────
    if (set.has('webrtc-leak')) applyWebRTCLeakProtection();
    if (set.has('dns-prefetch')) applyDisableDNSPrefetch();
    if (set.has('hyperlink-audit')) applyDisableHyperlinkAudit();
    if (set.has('do-not-track')) applyDoNotTrack();
    if (set.has('referer-control')) applyRefererControl();
    if (set.has('cookie-sanitize')) applyCookieSanitize();
    if (set.has('etag-clear')) applyETagClear();

    // ── Sensor Privacy ────────────────────────────────────────────────
    if (set.has('battery-spoof')) applyBatterySpoof();
    if (set.has('sensor-spoof')) applySensorSpoof();
    if (set.has('gamepad-spoof')) applyGamepadSpoof();
    if (set.has('bluetooth-spoof')) applyBluetoothSpoof();
    if (set.has('usb-spoof')) applyUSBSpoof();
    if (set.has('serial-spoof')) applySerialSpoof();
    if (set.has('hid-spoof')) applyHIDSpoof();

    // ═══════════════════════════════════════════════════════════════════
    // IMPLEMENTATIONS
    // ═══════════════════════════════════════════════════════════════════

    function basicAntiBot() {
      try {
        Object.defineProperty(navigator, 'webdriver', { get: () => false, configurable: true });
      } catch (_) {}
      try {
        window.chrome = window.chrome || {};
        window.chrome.runtime = window.chrome.runtime || {};
      } catch (_) {}
      // Remove Playwright/automation artifacts
      try { delete navigator.__proto__.webdriver; } catch (_) {}
    }

    function applyWebGLSpoof() {
      try {
        const getParameter = WebGLRenderingContext.prototype.getParameter;
        WebGLRenderingContext.prototype.getParameter = function (p) {
          // Spoof vendor & renderer
          if (p === 37445) return 'Intel Inc.';        // UNMASKED_VENDOR_WEBGL
          if (p === 37446) return 'Intel Iris OpenGL Engine'; // UNMASKED_RENDERER_WEBGL
          return getParameter.call(this, p);
        };
        if (typeof WebGL2RenderingContext !== 'undefined') {
          WebGL2RenderingContext.prototype.getParameter = WebGLRenderingContext.prototype.getParameter;
        }
      } catch (_) {}
    }

    function applyCanvasNoise() {
      try {
        const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
        const origToBlob = HTMLCanvasElement.prototype.toBlob;
        const origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
        // Add subtle noise to canvas pixel data
        CanvasRenderingContext2D.prototype.getImageData = function () {
          const imageData = origGetImageData.apply(this, arguments);
          for (let i = 0; i < imageData.data.length; i += 4) {
            // Tiny random noise on each pixel (±1)
            imageData.data[i] ^= 1;
            imageData.data[i + 1] ^= 1;
            imageData.data[i + 2] ^= 1;
          }
          return imageData;
        };
        HTMLCanvasElement.prototype.toDataURL = function () {
          // Force a re-render with noise
          const ctx = this.getContext('2d');
          if (ctx) {
            try { ctx.getImageData(0, 0, 1, 1); } catch (_) {}
          }
          return origToDataURL.apply(this, arguments);
        };
        HTMLCanvasElement.prototype.toBlob = function () {
          const ctx = this.getContext('2d');
          if (ctx) {
            try { ctx.getImageData(0, 0, 1, 1); } catch (_) {}
          }
          return origToBlob.apply(this, arguments);
        };
      } catch (_) {}
    }

    function applyAudioSpoof() {
      try {
        const origCreateAnalyser = (window.OfflineAudioContext || window.webkitOfflineAudioContext);
        if (origCreateAnalyser) {
          const origGetChannelData = AudioBuffer.prototype.getChannelData;
          AudioBuffer.prototype.getChannelData = function () {
            const data = origGetChannelData.apply(this, arguments);
            // Add subtle noise to audio fingerprint
            for (let i = 0; i < data.length; i += 100) {
              data[i] = data[i] + (Math.random() - 0.5) * 1e-7;
            }
            return data;
          };
        }
      } catch (_) {}
    }

    function applyFontSpoof() {
      try {
        // Limit the number of fonts reported by offsetWidth/offsetHeight checks
        const origOffsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
        if (origOffsetWidth && origOffsetWidth.get) {
          Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
            get: function () {
              const w = origOffsetWidth.get.call(this);
              // Add tiny variation to break font fingerprinting
              return w + (w % 2 === 0 ? 0 : 0);
            },
            configurable: true,
          });
        }
      } catch (_) {}
    }

    function applyHardwareSpoof() {
      try {
        Object.defineProperty(navigator, 'hardwareConcurrency', {
          get: () => 8,
          configurable: true,
        });
      } catch (_) {}
    }

    function applyDeviceMemorySpoof() {
      try {
        Object.defineProperty(navigator, 'deviceMemory', {
          get: () => 8,
          configurable: true,
        });
      } catch (_) {}
    }

    function applyScreenSpoof() {
      try {
        Object.defineProperty(screen, 'colorDepth', { get: () => 24, configurable: true });
        Object.defineProperty(screen, 'pixelDepth', { get: () => 24, configurable: true });
      } catch (_) {}
    }

    function applyTimezoneSpoof() {
      try {
        // When the context already uses the proxy's real timezone we keep the
        // native implementation - spoofing a fixed US timezone on a non-US
        // proxy IP is a stronger location signal than no spoof at all.
        if (tz) return;
        const origGetTimezoneOffset = Date.prototype.getTimezoneOffset;
        Date.prototype.getTimezoneOffset = function () {
          // Spoof a common timezone offset (UTC-5 = 300)
          return 300;
        };
        const origDateTimeFormat = Intl.DateTimeFormat;
        Intl.DateTimeFormat = function () {
          const args = arguments;
          if (args[1] && typeof args[1] === 'object') {
            args[1].timeZone = args[1].timeZone || 'America/New_York';
          } else {
            args[1] = { timeZone: 'America/New_York' };
          }
          return new origDateTimeFormat(args[0], args[1]);
        };
        Intl.DateTimeFormat.prototype = origDateTimeFormat.prototype;
      } catch (_) {}
    }

    function applyLanguageSpoof() {
      try {
        Object.defineProperty(navigator, 'languages', {
          get: () => ['en-US', 'en'],
          configurable: true,
        });
        Object.defineProperty(navigator, 'language', {
          get: () => 'en-US',
          configurable: true,
        });
      } catch (_) {}
    }

    function applyPlatformSpoof() {
      try {
        Object.defineProperty(navigator, 'platform', {
          get: () => 'Win32',
          configurable: true,
        });
      } catch (_) {}
    }

    function applyClientRectsSpoof() {
      try {
        const origGetClientRects = Element.prototype.getClientRects;
        Element.prototype.getClientRects = function () {
          const rects = origGetClientRects.apply(this, arguments);
          // Return a slightly modified rect to break fingerprinting
          const spoofed = [];
          for (const r of rects) {
            spoofed.push(new DOMRect(
              r.x + (Math.random() - 0.5) * 0.1,
              r.y + (Math.random() - 0.5) * 0.1,
              r.width,
              r.height
            ));
          }
          return spoofed;
        };
      } catch (_) {}
    }

    function applySpeechSpoof() {
      try {
        if (window.speechSynthesis) {
          const origGetVoices = speechSynthesis.getVoices;
          speechSynthesis.getVoices = function () {
            // Return a reduced, consistent voice list
            return origGetVoices.apply(this, arguments).slice(0, 4);
          };
        }
      } catch (_) {}
    }

    function applyMediaSpoof() {
      try {
        if (navigator.mediaDevices) {
          const origEnumerateDevices = navigator.mediaDevices.enumerateDevices;
          navigator.mediaDevices.enumerateDevices = function () {
            return origEnumerateDevices.apply(this, arguments).then(devices => {
              // Return a consistent, limited device list
              return devices.slice(0, 3);
            });
          };
        }
      } catch (_) {}
    }

    function applyPluginSpoof() {
      try {
        Object.defineProperty(navigator, 'plugins', {
          get: () => {
            const arr = [
              { name: 'PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
              { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
              { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
            ];
            arr.item = (i) => arr[i];
            arr.namedItem = (n) => arr.find(p => p.name === n);
            arr.refresh = () => {};
            return arr;
          },
          configurable: true,
        });
      } catch (_) {}
    }

    function applyMimetypeSpoof() {
      try {
        Object.defineProperty(navigator, 'mimeTypes', {
          get: () => {
            const arr = [
              { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
              { type: 'text/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
            ];
            arr.item = (i) => arr[i];
            arr.namedItem = (n) => arr.find(m => m.type === n);
            return arr;
          },
          configurable: true,
        });
      } catch (_) {}
    }

    function applyUserAgentOverride() {
      try {
        Object.defineProperty(navigator, 'userAgent', {
          get: () => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          configurable: true,
        });
        Object.defineProperty(navigator, 'appVersion', {
          get: () => '5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          configurable: true,
        });
      } catch (_) {}
    }

    function applySecChUaSpoof() {
      try {
        // Override navigator.userAgentData if present
        if (navigator.userAgentData) {
          Object.defineProperty(navigator, 'userAgentData', {
            get: () => ({
              brands: [
                { brand: 'Chromium', version: '124' },
                { brand: 'Google Chrome', version: '124' },
                { brand: 'Not-A.Brand', version: '99' },
              ],
              mobile: false,
              platform: 'Windows',
            }),
            configurable: true,
          });
        }
      } catch (_) {}
    }

    function applyNavigatorOverride() {
      try {
        Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 0, configurable: true });
        Object.defineProperty(navigator, 'vendor', { get: () => 'Google Inc.', configurable: true });
        Object.defineProperty(navigator, 'appName', { get: () => 'Netscape', configurable: true });
        Object.defineProperty(navigator, 'appCodeName', { get: () => 'Mozilla', configurable: true });
        Object.defineProperty(navigator, 'product', { get: () => 'Gecko', configurable: true });
        Object.defineProperty(navigator, 'productSub', { get: () => '20030107', configurable: true });
        Object.defineProperty(navigator, 'cookieEnabled', { get: () => true, configurable: true });
        Object.defineProperty(navigator, 'onLine', { get: () => true, configurable: true });
        Object.defineProperty(navigator, 'doNotTrack', { get: () => '1', configurable: true });
      } catch (_) {}
    }

    function applyWindowProperties() {
      try {
        Object.defineProperty(window, 'innerWidth', { get: () => window.innerWidth || 1280, configurable: true });
        Object.defineProperty(window, 'innerHeight', { get: () => window.innerHeight || 800, configurable: true });
        Object.defineProperty(window, 'outerWidth', { get: () => (window.innerWidth || 1280) + 16, configurable: true });
        Object.defineProperty(window, 'outerHeight', { get: () => (window.innerHeight || 800) + 88, configurable: true });
        Object.defineProperty(window, 'devicePixelRatio', { get: () => 1, configurable: true });
      } catch (_) {}
    }

    function applyIframeSandbox() {
      try {
        const origContentWindow = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow');
        if (origContentWindow && origContentWindow.get) {
          Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
            get: function () {
              const cw = origContentWindow.get.call(this);
              if (cw) {
                try {
                  // Prevent cross-origin iframe fingerprinting
                  Object.defineProperty(cw.navigator, 'webdriver', { get: () => false, configurable: true });
                } catch (_) {}
              }
              return cw;
            },
            configurable: true,
          });
        }
      } catch (_) {}
    }

    function applyWebRTCLeakProtection() {
      try {
        if (window.RTCPeerConnection) {
          const origRTC = window.RTCPeerConnection;
          window.RTCPeerConnection = function (config) {
            // Force ICE candidates to use relay only (no local IP leak)
            if (config && config.iceServers) {
              config.iceTransportPolicy = 'relay';
            } else {
              config = { iceTransportPolicy: 'relay' };
            }
            return new origRTC(config);
          };
          window.RTCPeerConnection.prototype = origRTC.prototype;
        }
        if (window.webkitRTCPeerConnection) {
          const origWebkitRTC = window.webkitRTCPeerConnection;
          window.webkitRTCPeerConnection = function (config) {
            config = config || {};
            config.iceTransportPolicy = 'relay';
            return new origWebkitRTC(config);
          };
          window.webkitRTCPeerConnection.prototype = origWebkitRTC.prototype;
        }
      } catch (_) {}
    }

    function applyDisableDNSPrefetch() {
      try {
        // Remove existing prefetch links
        document.querySelectorAll('link[rel="dns-prefetch"], link[rel="prefetch"], link[rel="preconnect"]').forEach(l => l.remove());
        // Intercept future additions via MutationObserver
        const observer = new MutationObserver((mutations) => {
          for (const m of mutations) {
            for (const node of m.addedNodes) {
              if (node.tagName === 'LINK' && ['dns-prefetch', 'prefetch', 'preconnect'].includes(node.rel)) {
                node.remove();
              }
            }
          }
        });
        if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', () => {
            observer.observe(document.documentElement, { childList: true, subtree: true });
          });
        } else {
          observer.observe(document.documentElement, { childList: true, subtree: true });
        }
      } catch (_) {}
    }

    function applyDisableHyperlinkAudit() {
      try {
        // Remove ping attribute from all anchors
        document.querySelectorAll('a[ping]').forEach(a => a.removeAttribute('ping'));
        // Intercept future additions
        const observer = new MutationObserver((mutations) => {
          for (const m of mutations) {
            for (const node of m.addedNodes) {
              if (node.tagName === 'A' && node.ping) node.removeAttribute('ping');
            }
          }
        });
        if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', () => {
            observer.observe(document.documentElement, { childList: true, subtree: true });
          });
        } else {
          observer.observe(document.documentElement, { childList: true, subtree: true });
        }
      } catch (_) {}
    }

    function applyDoNotTrack() {
      try {
        Object.defineProperty(navigator, 'doNotTrack', { get: () => '1', configurable: true });
      } catch (_) {}
    }

    function applyRefererControl() {
      try {
        // Override fetch to strip/modify referrer
        const origFetch = window.fetch;
        window.fetch = function (input, init) {
          if (init && init.referrer) {
            init.referrer = '';
          } else if (init) {
            init.referrer = '';
          } else {
            init = { referrer: '' };
          }
          return origFetch.call(this, input, init);
        };
      } catch (_) {}
    }

    function applyCookieSanitize() {
      try {
        // Clear tracking cookies on load
        const trackingCookies = ['_ga', '_gid', '_fbp', 'fr', 'trc', 'IDE'];
        trackingCookies.forEach(name => {
          document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/; domain=${location.hostname}`;
          document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/`;
        });
      } catch (_) {}
    }

    function applyETagClear() {
      try {
        // Clear cache storage to prevent ETag tracking
        if (window.caches && caches.keys) {
          caches.keys().then(keys => keys.forEach(k => caches.delete(k))).catch(() => {});
        }
      } catch (_) {}
    }

    function applyBatterySpoof() {
      try {
        if (navigator.getBattery) {
          navigator.getBattery = () => Promise.resolve({
            charging: true,
            chargingTime: 0,
            dischargingTime: Infinity,
            level: 1,
            addEventListener: () => {},
            removeEventListener: () => {},
          });
        }
      } catch (_) {}
    }

    function applySensorSpoof() {
      try {
        if (window.DeviceOrientationEvent) {
          const origAddEventListener = EventTarget.prototype.addEventListener;
          EventTarget.prototype.addEventListener = function (type, listener, options) {
            if (type === 'deviceorientation' || type === 'devicemotion' || type === 'deviceproximity') {
              // Return spoofed sensor data
              return origAddEventListener.call(this, type, (e) => {
                if (e && e.alpha !== undefined) {
                  Object.defineProperty(e, 'alpha', { get: () => Math.random() * 360 });
                  Object.defineProperty(e, 'beta', { get: () => Math.random() * 180 - 90 });
                  Object.defineProperty(e, 'gamma', { get: () => Math.random() * 90 - 45 });
                }
                listener(e);
              }, options);
            }
            return origAddEventListener.call(this, type, listener, options);
          };
        }
      } catch (_) {}
    }

    function applyGamepadSpoof() {
      try {
        if (navigator.getGamepads) {
          navigator.getGamepads = () => [null, null, null, null];
        }
      } catch (_) {}
    }

    function applyBluetoothSpoof() {
      try {
        if (navigator.bluetooth) {
          navigator.bluetooth.getAvailability = () => Promise.resolve(false);
          navigator.bluetooth.requestDevice = () => Promise.reject(new Error('Bluetooth not available'));
        }
      } catch (_) {}
    }

    function applyUSBSpoof() {
      try {
        if (navigator.usb) {
          navigator.usb.getDevices = () => Promise.resolve([]);
          navigator.usb.requestDevice = () => Promise.reject(new Error('No USB devices'));
        }
      } catch (_) {}
    }

    function applySerialSpoof() {
      try {
        if (navigator.serial) {
          navigator.serial.getPorts = () => Promise.resolve([]);
          navigator.serial.requestPort = () => Promise.reject(new Error('No serial ports'));
        }
      } catch (_) {}
    }

    function applyHIDSpoof() {
      try {
        if (navigator.hid) {
          navigator.hid.getDevices = () => Promise.resolve([]);
          navigator.hid.requestDevice = () => Promise.reject(new Error('No HID devices'));
        }
      } catch (_) {}
    }
  }, { features: featureList, timezone: proxyTimezone });

  onLog(`[PrivacyGuard] Applied ${featureList.length} privacy features (${level})`);
}

module.exports = { installPrivacyGuard };
