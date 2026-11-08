const { launchBrowser: _launchBrowser } = require('./browser-launcher.js');
const PopupHandler = require('./PopupHandler.js');
const EventEmitter = require('events');
const stopManager = require('./StopManager.js');
const { installCaptchaGuard } = require('./CaptchaGuard.js');
const { installPrivacyGuard } = require('./PrivacyGuard.js');
const {
  installProxyErrorWatcher,
  installPopupGuard,
  waitForExtraTabs,
  parseNetError,
  detectChromeErrorPage,
} = require('./PageGuard.js');
const {
  resolveProxyGeo,
  installContextEgressGuard,
  verifyEgress,
} = require('./EgressGuard.js');
const { runWithProxyRetry } = require('./ProxyRotation.js');
const { chooseViewport, describeProfile } = require('./SessionProfile.js');
const { visitInternalLinks: visitLinks } = require('./LinkClicker.js');
const { startRandomClicker } = require('./RandomClicker.js');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

const MOBILE_USER_AGENTS = [
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 13; SM-A546B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
];

const TABLET_USER_AGENTS = [
  'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (iPad; CPU OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 13; SM-X816B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Linux; Android 13; SM-T870) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
];

function getUserAgent(userAgents, autoRotate, device) {
  if (userAgents && userAgents.length > 0) {
    return autoRotate ? pickRandom(userAgents) : userAgents[0];
  }
  if (device === 'mobile') return pickRandom(MOBILE_USER_AGENTS);
  if (device === 'tablet') return pickRandom(TABLET_USER_AGENTS);
  return "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
}

function getViewport(device, autoRotateResolutions, vpWidth, vpHeight, sessionNum) {
  // Applies the exact per-thread resolutions chosen in Screen Resolutions.
  return chooseViewport(device, autoRotateResolutions, vpWidth, vpHeight, sessionNum);
}

async function humanScroll(page, scrollDirection, waitTimeMs) {
  try {
    // page.evaluate has no timeout and can hang forever during navigation.
    await Promise.race([
      page.evaluate((direction) => {
      const body = document.body;
      const html = document.documentElement;
      const documentHeight = Math.max(
        body.scrollHeight,
        body.offsetHeight,
        html.clientHeight,
        html.scrollHeight,
        html.offsetHeight
      );
      const viewportHeight = window.innerHeight;
      const startY = window.scrollY;
      let targetY;

      if (direction === 'down') {
        const scrollAmount = documentHeight * (0.6 + Math.random() * 0.2);
        targetY = Math.min(startY + scrollAmount, documentHeight - viewportHeight);
      } else {
        targetY = Math.max(0, startY - (startY * (0.4 + Math.random() * 0.2)));
      }

      // Native smooth scroll (no requestAnimationFrame loop: it is paused in
      // background tabs and could hang for 10+ seconds per internal page).
      window.scrollTo({ top: targetY, behavior: 'smooth' });
      }, scrollDirection).catch(() => {}),
      sleep(8000),
    ]);
  } catch (_) {}

  await sleep(waitTimeMs || randomBetween(500, 2000));
}

async function smoothNaturalScroll(page, scrollDirectionConfig, scrollDownWaitMs, scrollUpWaitMs) {
  const direction = scrollDirectionConfig || 'random';

  if (direction === 'down-only') {
    await humanScroll(page, 'down', scrollDownWaitMs);
  } else if (direction === 'up-down') {
    await humanScroll(page, 'down', scrollDownWaitMs);
    await sleep(randomBetween(800, 2000));
    await humanScroll(page, 'up', scrollUpWaitMs);
  } else {
    const scrollPattern = Math.random();
    if (scrollPattern < 0.7) {
      await humanScroll(page, 'down', scrollDownWaitMs);
      if (Math.random() < 0.4) {
        await sleep(randomBetween(800, 2000));
        await humanScroll(page, 'up', scrollUpWaitMs);
      }
    } else if (scrollPattern < 0.9) {
      await humanScroll(page, 'down', scrollDownWaitMs);
      await sleep(randomBetween(1000, 2500));
      await humanScroll(page, 'up', scrollUpWaitMs);
      await sleep(randomBetween(1000, 2000));
      await humanScroll(page, 'down', scrollDownWaitMs);
    } else {
      await humanScroll(page, 'down', scrollDownWaitMs);
    }
  }
}

function normalizeUrl(href) {
  try {
    const u = new URL(href);
    u.hash = '';
    let path = u.pathname.replace(/\/+$/, '');
    if (path === '') path = '/';
    return `${u.origin}${path}${u.search}`;
  } catch {
    return href;
  }
}



async function visitInternalPages(page, config, emitter, sessionNum, isStopped, captchaGuard) {
  const { internalPagesCount, internalScrollMode, internalPageWaitMs, scrollDownWaitMs, scrollUpWaitMs, targetUrl } = config;
  const popupOpts = { label: `[Session ${sessionNum}]`, log: emitter };
  const log = (msg) => emitter.emit('log', `[Session ${sessionNum}] ${msg}`);

  const wanted = parseInt(internalPagesCount, 10);
  if (!wanted || wanted <= 0) return;

  let origin;
  try {
    origin = new URL(page.url() || targetUrl).origin;
  } catch {
    log('Cannot resolve site origin — skipping internal pages');
    return;
  }

  log(`Internal pages: opening ${wanted} page(s) as configured`);

  await visitLinks(page, {
    count: wanted,
    origin,
    onLog: log,
    isStopped: isStopped || (() => false),
    gotoTimeoutMs: 45000,
    ensureCaptcha: captchaGuard ? () => captchaGuard.waitForCaptchaResolution() : null,
    onPage: async () => {
      if (isStopped && isStopped()) return;
      await sleep(1500);
      await PopupHandler.dismissAll(page, popupOpts);
      if (isStopped && isStopped()) return;
      await smoothNaturalScroll(page, internalScrollMode, scrollDownWaitMs, scrollUpWaitMs);
      if (isStopped && isStopped()) return;
      await sleep(internalPageWaitMs || 5000);
    },
  });
}

/**
 * Navigate to targetUrl in a way that preserves the social platform page as
 * the HTTP Referer, so analytics tools (GA4, Plausible, etc.) record the
 * visit as social referral traffic rather than direct.
 *
 * Strategy: inject a hidden <a> element into the current page (which is still
 * on the social platform domain) and programmatically click it. The browser
 * then sends the social platform URL as the Referer header on the request to
 * targetUrl, and document.referrer on the target page will reflect it too.
 *
 * Returns true on success, false if we should fall back to page.goto().
 */
async function navigateWithReferrer(page, targetUrl, platformUrl, emitter, sessionNum, usingProxy = false) {
  try {
    // Inject an invisible anchor and click it. Using rel="noreferrer" would
    // strip the referer, so we deliberately omit it. We also set the referrer
    // policy on the element to "unsafe-url" to maximise referer preservation
    // across same-site / cross-site boundaries.
    await page.evaluate((url) => {
      const a = document.createElement('a');
      a.href = url;
      a.style.position = 'fixed';
      a.style.opacity = '0';
      a.style.pointerEvents = 'none';
      a.referrerPolicy = 'unsafe-url';   // send full URL as Referer
      document.body.appendChild(a);
      a.click();
    }, targetUrl);

    // Wait for the navigation that the click triggers. Give proxies more time.
    const navTimeout = usingProxy ? 120000 : 60000;
    await page.waitForNavigation({ waitUntil: 'networkidle', timeout: navTimeout });

    // Verify we landed on the right page (basic sanity check).
    const landed = page.url();
    const targetOrigin = new URL(targetUrl).origin;
    if (!landed.startsWith(targetOrigin)) {
      emitter.emit('log', `[Session ${sessionNum}] Referral click landed on unexpected URL: ${landed}`);
      return false;
    }

    emitter.emit('log', `[Session ${sessionNum}] Referral navigation succeeded (referrer: ${platformUrl})`);
    return true;
  } catch (err) {
    emitter.emit('log', `[Session ${sessionNum}] Referral click navigation error: ${err.message}`);
    return false;
  }
}

async function waitForPageToSettle(page) {
  try { await page.waitForLoadState('domcontentloaded', { timeout: 20000 }); } catch (_) {}
  try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch (_) {}
}

/**
 * Patient page.goto wrapper — when a proxy is active, the target site can
 * take much longer to load due to proxy latency / tunnel priming. This
 * helper retries the navigation with progressively longer timeouts and, as a
 * last resort, waits up to 3 minutes for the page to land on a real URL
 * before giving up. Without a proxy it behaves like a normal page.goto with
 * a single retry.
 */
async function patientGoto(page, url, opts = {}) {
  const { timeout = 60000, waitUntil = 'networkidle', usingProxy = false, label = '', emitter = null, sessionNum = 0, isStopped = null, proxyFailRef = null } = opts;
  const maxAttempts = usingProxy ? 6 : 2;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (isStopped && isStopped()) throw new Error('__STOPPED__');
    if (proxyFailRef && proxyFailRef.failed) throw new Error('__PROXY_FAILED__:' + proxyFailRef.code);
    const navTimeout = usingProxy
      ? (attempt <= 2 ? 90000 : (attempt <= 4 ? 120000 : 150000))
      : timeout;
    try {
      if (emitter && usingProxy) {
        emitter.emit('log', `[Session ${sessionNum}] Loading ${label} (attempt ${attempt}/${maxAttempts})...`);
      }
      await page.goto(url, { waitUntil, timeout: navTimeout });
      return true;
    } catch (err) {
      if (isStopped && isStopped()) throw new Error('__STOPPED__');
      const errMsg = (err.message || '');
      // Proxy/network level failure: never retry the same tunnel.
      const netCode = parseNetError(errMsg);
      if (netCode) throw new Error('__PROXY_FAILED__:' + netCode);
      if (/timeout|timed out/i.test(errMsg) && attempt < maxAttempts) {
        if (emitter) emitter.emit('log', `[Session ${sessionNum}] ${label} slow, retrying...`, 'WARN');
        // Try force-navigate via window.location
        try { await page.evaluate((u) => { window.location.href = u; }, url); } catch (_) {}
        try { await page.waitForNavigation({ waitUntil: 'commit', timeout: usingProxy ? 30000 : 15000 }).catch(() => {}); } catch (_) {}
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      // Last attempt failed — check if page actually landed despite the timeout
      const landed = page.url();
      if (landed && landed !== 'about:blank' && !landed.startsWith('chrome-error://')) {
        if (emitter) emitter.emit('log', `[Session ${sessionNum}] ${label} loaded despite timeout: ${landed.substring(0, 70)}`);
        return true;
      }
      if (!usingProxy) throw err;
    }
  }

  // Final patient wait — up to 3 minutes for slow proxy
  if (usingProxy) {
    if (emitter) emitter.emit('log', `[Session ${sessionNum}] Proxy slow — waiting up to 3 minutes for ${label}...`, 'WARN');
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      if (isStopped && isStopped()) throw new Error('__STOPPED__');
      await new Promise((r) => setTimeout(r, 5000));
      const patientUrl = page.url();
      if (patientUrl && patientUrl !== 'about:blank' && !patientUrl.startsWith('chrome-error://')) {
        if (emitter) emitter.emit('log', `[Session ${sessionNum}] ${label} finally loaded: ${patientUrl.substring(0, 70)}`);
        try { await page.waitForLoadState('domcontentloaded', { timeout: 30000 }); } catch (_) {}
        return true;
      }
    }
  }
  throw new Error(`${label || 'Page'} failed to load after ${maxAttempts} attempts`);
}

async function runSocialSession(config, emitter, sessionNum, browserTracker, isStoppedRef, campaignId) {
  const {
    targetUrl, sessions, threads, headless, socialPlatforms,
    socialStayTime, socialRedirectDelay, socialLaunchBehavior,
    userAgents, uaAutoRotate, device, customBrowserPath, browserEngine,
    viewportWidth, viewportHeight, autoRotateResolutions,
    scrollingInternalPagesEnabled, scrollDirection, scrollDownWaitMs,
    scrollUpWaitMs, internalPagesCount, internalScrollMode, internalPageWaitMs, proxies: proxiesData
  } = config;

  // The UI sends these two dwell settings in seconds (or omits them), while
  // some callers pass milliseconds. Normalise once so a 5s dwell can never
  // become 5000 * 1000 ms (83 minutes) and hang the whole campaign.
  const toSeconds = (value, fallbackSec) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return fallbackSec;
    return n > 300 ? Math.round(n / 1000) : Math.round(n);
  };
  const dwellSec = toSeconds(socialStayTime, 15);
  const redirectSec = toSeconds(socialRedirectDelay, 3);

  // Debug logging
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`[Social Traffic] Session ${sessionNum} Config:`);
  console.log('Headless:', headless, '(type:', typeof headless, ')');
  console.log('Target URL:', targetUrl);
  console.log('Threads:', threads);
  console.log('Social Platforms:', socialPlatforms ? socialPlatforms.length : 0);
  console.log('═══════════════════════════════════════════════════════════');

  // Unified stop check: StopManager (primary) or legacy isStoppedRef fallback
  const isStopped = () => stopManager.isStopped(campaignId) || (isStoppedRef && isStoppedRef());

  // Check stop immediately
  if (isStopped()) {
    return false;
  }

  const launchArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-blink-features=AutomationControlled',
    '--disable-infobars',
    `--window-size=${viewportWidth},${viewportHeight}`,
  ];

  const vp = getViewport(device, autoRotateResolutions, viewportWidth, viewportHeight, sessionNum);
  const ua = getUserAgent(userAgents, uaAutoRotate, device);
  emitter.emit('log', `[Session ${sessionNum}] ${describeProfile(ua, vp, device)}`);
  const platform = pickRandom(socialPlatforms);
  const launchBehavior = socialLaunchBehavior || 'platform_then_target';

  // Build context-level proxy options (NOT passed to chromium.launch).
  // Passing proxy at launch level can cause Playwright to open a proxy-auth
  // dialog that immediately closes the browser window.  Attaching the proxy
  // to newContext() instead is the stable, recommended approach.
  let contextProxyOpts = null;
  let assignedProxy = null;
  let activeProxy = null;
  if (proxiesData && proxiesData.useProxies) {
    // Prefer proxies verified against the real target, then generic working
    // ones. If proxy mode is ON but no usable proxy exists, abort instead of
    // silently browsing on the PC's direct IP.
    const workingPool = Array.isArray(proxiesData.workingProxies) ? proxiesData.workingProxies : [];
    const allProxyList = Array.isArray(proxiesData.proxies) ? proxiesData.proxies : [];
    const targetOkPool = workingPool.filter(p => p && p.targetOk === true &&
      (!proxiesData.checkUrl || !p.targetUrl || p.targetUrl === proxiesData.checkUrl));
    const proxyPool = targetOkPool.length > 0
      ? targetOkPool
      : (workingPool.length > 0 ? workingPool : allProxyList);

    if (!proxyPool.length) {
      emitter.emit('log', `[Session ${sessionNum}] Proxy mode is ON but no proxy is available. Session aborted - direct-IP fallback is disabled.`, 'ERROR');
      return 'proxy_blocked';
    }
    if (proxiesData.checkUrl && !targetOkPool.length && workingPool.length) {
      emitter.emit('log', `[Session ${sessionNum}] WARNING: no proxy is verified against ${proxiesData.checkUrl} - using the working pool. Validate this target on the Proxies page for better ad acceptance.`, 'WARN');
    }

    if (proxyPool.length > 0) {
      // Assign a proxy per session (round-robin through pool). __proxyOffset is
      // bumped on every retry so a blocked proxy is replaced by the next one.
      const proxyOffset = parseInt(config.__proxyOffset, 10) || 0;
      assignedProxy = proxyPool[(sessionNum + proxyOffset) % proxyPool.length];

      const ProxyHandler = require('./Proxyhandler.js');
      const ph = new ProxyHandler();

      // Inject a unique -session-<id> into the username for ProxyOmega / residential
      // proxies so each thread gets its own rotating IP. Plain IP proxies are unaffected.
      let sessionProxy = ph.buildSessionProxy(assignedProxy, `t${sessionNum}`);
      // If this proxy cannot reach the campaign target (some providers block
      // gambling/specific sites), automatically switch to the next proxy.
      if (proxiesData.checkUrl && proxyPool.length > 0) {
        const maxTries = Math.min(proxyPool.length, 6);
        for (let t = 0; t < maxTries; t++) {
          const reach = await ph.testReachability(sessionProxy, proxiesData.checkUrl, 6000);
          if (reach.ok) break;
          const nextRaw = proxyPool[(sessionNum + proxyOffset + t + 1) % proxyPool.length];
          const nextProxy = ph.buildSessionProxy(nextRaw, `t${sessionNum}`);
          emitter.emit('log', `[Session ${sessionNum}] Proxy ${sessionProxy.host}:${sessionProxy.port} cannot open ${proxiesData.checkUrl} (${reach.reason}) - switching to ${nextProxy.host}:${nextProxy.port}`, 'WARN');
          assignedProxy = nextRaw;
          sessionProxy = nextProxy;
          if (t === maxTries - 1) {
            emitter.emit('log', `[Session ${sessionNum}] No proxy in the list can open the target ${proxiesData.checkUrl}. Session aborted - direct-IP fallback is disabled.`, 'ERROR');
            return 'proxy_blocked';
          }
        }
      }
      const opts = ph.buildPlaywrightProxyOpts(sessionProxy);
      // opts = { proxy: { server, [username], [password] } }
      contextProxyOpts = opts.proxy || null;
      activeProxy = sessionProxy;

      const proxyLabel = sessionProxy.username
        ? `${sessionProxy.host}:${sessionProxy.port} (user: ${sessionProxy.username})`
        : `${sessionProxy.host}:${sessionProxy.port}`;
      emitter.emit('log', `[Session ${sessionNum}] Using proxy: ${proxyLabel}`);
    }
  }

  // Resolve the proxy's own egress IP + timezone through the proxy (used for
  // geolocation/timezone spoofing and the egress IP check).
  let proxyGeo = null;
  if (activeProxy) {
    try {
      proxyGeo = await resolveProxyGeo(activeProxy, { timeoutMs: 6000 });
      if (proxyGeo) {
        emitter.emit(
          'log',
          `[Session ${sessionNum}] Proxy exit IP: ${proxyGeo.ip}${proxyGeo.city ? ' - ' + proxyGeo.city : ''}${proxyGeo.countryCode ? ', ' + proxyGeo.countryCode : ''} (${proxyGeo.timezone || 'timezone unknown'})`
        );
      }
    } catch (_) {}
  }

  // Check stop before launching browser
  if (isStopped()) {
    return false;
  }

  // Debug: Log before launch
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`[Social Traffic] Session ${sessionNum} - About to launch browser`);
  console.log('Launch Args:', launchArgs);
  console.log('Headless value being passed:', headless, '(expected: false)');
  console.log('Viewport:', vp);
  console.log('User Agent: ' + (ua ? ua.substring(0, 50) + '...' : 'undefined'));
  console.log('═══════════════════════════════════════════════════════════');

  // Launch Playwright's Chromium browser
  // Do NOT pass proxy here — launch-level proxy causes Playwright to open
  // an auth dialog that makes the browser blink and close immediately.
  let browser;
  try {
    browser = await _launchBrowser({
      headless: headless,
      customBrowserPath: customBrowserPath || undefined,
      args: launchArgs,
      // proxy intentionally omitted — attached at newContext() level below
      onLog: (msg) => emitter.emit('log', msg),
      sessionId: `Session ${sessionNum}`,
    });
    emitter.emit('log', `[Session ${sessionNum}] Browser launched successfully`);
  } catch (launchErr) {
    emitter.emit('log', `[Session ${sessionNum}] Failed to launch browser: ${launchErr.message}`);
    console.error('[Social Traffic] Browser launch error:', launchErr);
    return false;
  }

  // Register with StopManager so Stop can force-close it immediately
  if (campaignId) stopManager.registerBrowser(campaignId, browser);
  if (browserTracker) {
    browserTracker(browser);
  }

  let success = false;
  // Set by the error-page watcher so this session can abort immediately and
  // the caller can retry with a different proxy.
  let proxyFailRef = { failed: false, code: '' };
  let proxyFailedResult = null;
  // Random auto-clicking runs in the background for the whole visit window.
  let randomClicker = null;
  try {
    // Check stop after browser launch
    if (isStopped()) {
      return false;
    }

    // Build newContext options — proxy is attached here (NOT at launch level).
    // This avoids the "browser blinks and closes" issue caused by Playwright's
    // proxy-auth dialog appearing before any page loads.
    const contextOptions = {
      viewport: { width: vp.width, height: vp.height },
      userAgent: ua,
      isMobile: !!vp.isMobile,
      hasTouch: !!vp.hasTouch,
      deviceScaleFactor: vp.deviceScaleFactor || 1,
      // Ensure the browser sends Referer headers on cross-origin navigations.
      extraHTTPHeaders: {
        'Referrer-Policy': 'unsafe-url',
      }
    };
    if (contextProxyOpts) {
      contextOptions.proxy = contextProxyOpts;
    }
    if (proxyGeo && proxyGeo.timezone) {
      contextOptions.timezoneId = proxyGeo.timezone;
    } else if (contextProxyOpts) {
      // Never fall back to the PC's own timezone while a proxy is active.
      contextOptions.timezoneId = 'America/New_York';
    }
    if (proxyGeo && typeof proxyGeo.lat === 'number' && typeof proxyGeo.lon === 'number') {
      contextOptions.geolocation = {
        latitude: proxyGeo.lat,
        longitude: proxyGeo.lon,
        accuracy: 5000,
      };
      contextOptions.permissions = ['geolocation'];
    } else if (contextProxyOpts) {
      contextOptions.permissions = [];
    }

    const context = await browser.newContext(contextOptions);

    // Spoof the traffic source (referrer) if the global option is enabled.
    await require('./TrafficSource.js').installTrafficSource(context, config.trafficSource, {
      targetUrl: config.targetUrl,
      log: (msg, type) => emitter.emit('log', `[Session ${sessionNum}] ${msg}`, type),
    }).catch(() => ({ applied: false }));

    // Applies to the main page AND every ad popup opened in this context.
    await installContextEgressGuard(context, { geo: proxyGeo });
    if (proxyGeo && proxyGeo.ip) {
      verifyEgress(context, proxyGeo.ip, {
        sessionId: `Session ${sessionNum}`,
        onLog: (msg, type) => emitter.emit('log', msg, type),
        onLeak: () => {
          proxyFailRef.failed = true;
          proxyFailRef.code = 'ERR_EGRESS_LEAK';
          try { context.close().catch(() => {}); } catch (_) {}
        },
      }).catch(() => {});
    }
    
    const page = await context.newPage();

    // CAPTCHA guard — social platforms occasionally surface reCAPTCHA
    // challenges during login/search flows. The guard pauses this session
    // until the bundled extension (or the user) resolves them.
    const captchaGuard = installCaptchaGuard(page, {
      sessionId: `Session ${sessionNum}`,
      onLog: (msg, type) => emitter.emit('log', msg, type),
    });

    // Keep ad popups / new tabs open so their view timer can complete. Tabs are
    // only cleaned up after a long minimum lifetime and when over the tab limit.
    installPopupGuard(context, {
      mainPage: page,
      sessionId: `Session ${sessionNum}`,
      onLog: (msg, type) => emitter.emit('log', msg, type),
    });

    // "This site can't be reached" -> close now and retry with another proxy.
    installProxyErrorWatcher(page, {
      sessionId: `Session ${sessionNum}`,
      onLog: (msg, type) => emitter.emit('log', msg, type),
      ref: proxyFailRef,
    });

    // Workaround for Playwright Chromium proxy-auth redirect hang.
    if (contextProxyOpts && contextProxyOpts.server) {
      try { await page.route('**/*', route => route.continue()); } catch (_) {}
    }
    
    // Apply privacy/anti-detection features (from the Privacy page toggles).
    const privacyFeatures = config.privacyFeatures || [];
    const privacyLevel = config.privacyLevel || 'standard';
    await installPrivacyGuard(page, {
      privacyFeatures,
      privacyLevel,
      timezone: proxyGeo && proxyGeo.timezone,
      onLog: (msg) => emitter.emit('log', msg),
    });

    if (isStopped()) {
      return false;
    }

    // Prime the proxy tunnel with a lightweight warm-up request before the
    // real navigation. Authenticated proxies stall Chromium's FIRST navigation
    // on about:blank (the proxy-auth handshake blocks the very first request),
    // so we warm up with /favicon.ico which is tiny and fast.
    if (contextProxyOpts && contextProxyOpts.server) {
      emitter.emit('log', `[Session ${sessionNum}] Priming proxy tunnel with warm-up request...`);
      try {
        const warmupUrl = /https?:\/\//i.test(platform.url)
          ? (new URL(platform.url).origin + '/favicon.ico')
          : 'https://www.google.com/favicon.ico';
        await Promise.race([
          new Promise((_, rej) => setTimeout(() => rej(new Error('warmup-timeout')), 25000)),
          page.goto(warmupUrl, { waitUntil: 'commit', timeout: 20000 }).catch(() => {}),
        ]);
      } catch (_) {}
    }

    emitter.emit('log', `[Session ${sessionNum}] Launch behavior: ${launchBehavior}`);
    emitter.emit('log', `[Session ${sessionNum}] Navigating to social platform: ${platform.name} (${platform.url})`);
    await patientGoto(page, platform.url, {
      waitUntil: 'networkidle',
      timeout: 60000,
      usingProxy: !!(contextProxyOpts && contextProxyOpts.server),
      label: platform.name,
      emitter,
      sessionNum,
      isStopped,
      proxyFailRef,
    });
    if (isStopped()) return false;
    // Pause if the social platform presented a CAPTCHA on landing
    if (captchaGuard) await captchaGuard.waitForCaptchaResolution();
    if (isStopped()) return false;
    // Dismiss cookie/consent popups on the social platform before interacting
    await PopupHandler.dismissAll(page, { label: `[Session ${sessionNum}]`, log: emitter });
    await waitForPageToSettle(page);
    await stopManager.sleep(campaignId, 1500);
    if (isStopped()) return false;

    const doPlatformInteraction = launchBehavior !== 'link_then_target';
    if (doPlatformInteraction) {
      emitter.emit('log', `[Session ${sessionNum}] Performing social behavior on ${platform.name}...`);
      if (scrollingInternalPagesEnabled) {
        await smoothNaturalScroll(page, scrollDirection, scrollDownWaitMs, scrollUpWaitMs);
        if (isStopped()) return false;
      }
      await stopManager.sleep(campaignId, dwellSec * 1000);
      if (isStopped()) return false;
    } else {
      emitter.emit('log', `[Session ${sessionNum}] Launch behavior is link-first, skipping platform dwell step`);
    }

    const destinationLink = (platform.destinationUrl || '').trim();
    const shouldOpenDestination = (
      launchBehavior === 'platform_then_link_then_target' ||
      launchBehavior === 'link_then_target'
    );

    if (shouldOpenDestination && destinationLink) {
      const currentSocialUrl = page.url();
      emitter.emit('log', `[Session ${sessionNum}] Opening custom social link: ${destinationLink}`);
      const destinationNavigated = await navigateWithReferrer(page, destinationLink, currentSocialUrl, emitter, sessionNum, !!(contextProxyOpts && contextProxyOpts.server));
      if (!destinationNavigated) {
        emitter.emit('log', `[Session ${sessionNum}] Custom link click failed, using direct navigation fallback...`);
        await patientGoto(page, destinationLink, {
          waitUntil: 'networkidle',
          timeout: 60000,
          usingProxy: !!(contextProxyOpts && contextProxyOpts.server),
          label: 'custom link',
          emitter,
          sessionNum,
          isStopped,
          proxyFailRef,
        });
        if (captchaGuard) await captchaGuard.waitForCaptchaResolution();
      }
      if (isStopped()) return false;
      await waitForPageToSettle(page);
      await PopupHandler.dismissAll(page, { label: `[Session ${sessionNum}]`, log: emitter });
      if (isStopped()) return false;
      if (scrollingInternalPagesEnabled) {
        await smoothNaturalScroll(page, scrollDirection, scrollDownWaitMs, scrollUpWaitMs);
      }
      if (isStopped()) return false;
      await stopManager.sleep(campaignId, Math.max(1000, redirectSec * 1000));
      if (isStopped()) return false;
    } else if (shouldOpenDestination) {
      emitter.emit('log', `[Session ${sessionNum}] Launch behavior requests custom link, but none is configured for ${platform.name}`);
    }

    emitter.emit('log', `[Session ${sessionNum}] Waiting ${redirectSec}s before redirecting to target...`);
    await stopManager.sleep(campaignId, redirectSec * 1000);
    if (isStopped()) return false;

    // Navigate via a real anchor click so the browser sends the social platform
    // URL as the HTTP Referer header. page.goto() bypasses referer entirely
    // (it behaves like typing in the address bar), which is why analytics
    // records these visits as "direct" instead of social referral traffic.
    const referralSource = page.url();
    emitter.emit('log', `[Session ${sessionNum}] Navigating to target via referral click from ${referralSource}...`);
    const navigated = await navigateWithReferrer(page, targetUrl, referralSource, emitter, sessionNum, !!(contextProxyOpts && contextProxyOpts.server));
    if (isStopped()) return false;

    if (!navigated) {
      // Last-resort fallback: use Playwright's referer option. This sets the
      // HTTP Referer request header directly, which most analytics libraries
      // (GA4, Plausible, etc.) read on the server side or via document.referrer.
      emitter.emit('log', `[Session ${sessionNum}] Click navigation failed, falling back to referer header...`);
      const usingProxy = !!(contextProxyOpts && contextProxyOpts.server);
      try {
        await patientGoto(page, targetUrl, {
          waitUntil: 'networkidle',
          timeout: 60000,
          usingProxy,
          label: 'target website',
          emitter,
          sessionNum,
          isStopped,
          proxyFailRef,
        });
      } catch (gotoErr) {
        // patientGoto already retried extensively — if it still failed, try
        // one last time with the referer header explicitly set.
        if (isStopped()) return false;
        emitter.emit('log', `[Session ${sessionNum}] Patient goto failed, trying with referer header...`, 'WARN');
        await page.goto(targetUrl, {
          waitUntil: 'networkidle',
          timeout: usingProxy ? 120000 : 60000,
          referer: referralSource,
        });
      }
      if (captchaGuard) await captchaGuard.waitForCaptchaResolution();
    }

    if (isStopped()) return false;
    await stopManager.sleep(campaignId, 2000);
    if (isStopped()) return false;
    // Dismiss cookie/consent popups on the target site
    await PopupHandler.dismissAll(page, { label: `[Session ${sessionNum}]`, log: emitter });
    await sleep(500);
    if (isStopped()) return false;

    // Random clicks anywhere on the target website (ads included), within the
    // configured visit window only.
    randomClicker = startRandomClicker(page, {
      config: config.randomClicks,
      sessionId: `Session ${sessionNum}`,
      onLog: (msg, type) => emitter.emit('log', msg, type),
      isStopped,
    });

    if (scrollingInternalPagesEnabled) {
      await smoothNaturalScroll(page, scrollDirection, scrollDownWaitMs, scrollUpWaitMs);
      if (isStopped()) return false;
      // Wait on the target page using socialStayTime (the dedicated on-page dwell setting),
      // NOT internalPageWaitMs which is only for individual internal pages.
      await stopManager.sleep(campaignId, (dwellSec * 1000) + randomBetween(0, 5000));
      if (isStopped()) return false;
      if (randomClicker) await randomClicker.pause();
      await visitInternalPages(page, config, emitter, sessionNum, isStopped, captchaGuard);
      if (randomClicker) randomClicker.resume();
      if (isStopped()) return false;
    } else {
      await stopManager.sleep(campaignId, (dwellSec * 1000) + randomBetween(0, 5000));
      if (isStopped()) return false;
    }
    if (randomClicker) randomClicker.stop();

    // Do not count a visit that ended on Chrome's error page.
    const endErr = await detectChromeErrorPage(page);
    if (endErr) {
      proxyFailRef.failed = true;
      proxyFailRef.code = endErr;
      throw new Error('__PROXY_FAILED__:' + endErr);
    }
    const endUrl = page.url() || '';
    if (!endUrl || endUrl === 'about:blank' || endUrl.startsWith('chrome-error://')) {
      throw new Error('__PAGE_NOT_LOADED__');
    }
    emitter.emit('log', `[Session ${sessionNum}] Social traffic visit completed`);
    success = true;

    if (isStopped()) return false;
    await stopManager.sleep(campaignId, randomBetween(2000, 5000));
  } catch (err) {
    const errMsg = String((err && err.message) || '');
    if (proxyFailRef.failed || errMsg.startsWith('__PROXY_FAILED__')) {
      const code = proxyFailRef.code || errMsg.split(':')[1] || 'ERR_CONNECTION_FAILED';
      emitter.emit(
        'log',
        `[Session ${sessionNum}] Site can't be reached (${code}) - switching to another proxy`,
        'WARN'
      );
      proxyFailedResult = 'proxy_blocked';
    } else {
      emitter.emit('log', `[Session ${sessionNum}] Failed: ${err.message}`);
      console.error(err);
    }
    success = false;
  } finally {
    if (randomClicker) {
      try { randomClicker.stop(); } catch (_) {}
      randomClicker = null;
    }
    if (campaignId) stopManager.unregisterBrowser(campaignId, browser);
    // Let ad popups finish their own view timer before the browser goes away.
    if (!isStopped()) {
      try {
        await waitForExtraTabs(browser, {
          sessionId: `Session ${sessionNum}`,
          onLog: (msg, type) => emitter.emit('log', msg, type),
        });
      } catch (_) {}
    }
    await browser.close();
    emitter.emit('log', `[Session ${sessionNum}] Closed browser`);
  }
  return proxyFailedResult || success;
}

async function main(config, emitter = new EventEmitter()) {

  const { sessions, threads } = config;

  // Register campaign with StopManager — this id flows to every session/browser
  const campaignId = stopManager.startCampaign();

  let isStopped = false;
  let isPaused = false;
  let nextSessionIndex = 0;
  let activeBrowsers = 0;
  let openBrowsers = [];

  const tasks = [];
  for (let i = 0; i < sessions; i++) {
    tasks.push({
      id: i + 1,
      status: 'pending'
    });
  }

  function emitStatsUpdate() {
    const total = tasks.length;
    const completed = tasks.filter(t => t.status === 'completed').length;
    // Enforce formula: Pending = Target - Completed
    const pending = total - completed;
    const stats = {
      total: total,
      completed: completed,
      running: tasks.filter(t => t.status === 'running').length,
      pending: pending,
      failed: tasks.filter(t => t.status === 'failed').length,
      stopped: tasks.filter(t => t.status === 'stopped').length,
      activeBrowsers: activeBrowsers,
      remaining: tasks.filter(t => t.status === 'pending' || t.status === 'running').length,
      progress: Math.round((completed / total) * 100)
    };
    emitter.emit('stats', stats);
  }

  const trackedRunSocialSession = async (config, emitter, sessionNum, isStoppedRef) => {
    let browser = null;
    try {
      const result = await runSocialSession(config, emitter, sessionNum, (b) => {
        browser = b;
        openBrowsers.push(b);
      }, isStoppedRef, campaignId);
      return result;
    } finally {
      if (browser) {
        const index = openBrowsers.indexOf(browser);
        if (index > -1) {
          openBrowsers.splice(index, 1);
        }
      }
    }
  };

  const processSession = async () => {
    while (nextSessionIndex < sessions && !isStopped) {
      while (isPaused && !isStopped) {
        await sleep(100);
      }
      if (isStopped) break;

      const sessionIndex = nextSessionIndex++;
      const sessionConfig = { ...config };

      tasks[sessionIndex].status = 'running';
      activeBrowsers++;
      emitStatsUpdate();

      try {
        emitter.emit('log', `[Session ${sessionIndex + 1}] Starting...`);
        const result = await runWithProxyRetry({
          config: sessionConfig,
          runOnce: (cfg) => trackedRunSocialSession(cfg, emitter, sessionIndex + 1, () => isStopped),
          onLog: (msg, type) => emitter.emit('log', `[Session ${sessionIndex + 1}] ${msg}`, type),
          isStopped: () => isStopped,
        });
        if (result) {
          tasks[sessionIndex].status = 'completed';
          emitter.emit('log', `[Session ${sessionIndex + 1}] Completed successfully`);
        } else {
          tasks[sessionIndex].status = 'failed';
          emitter.emit('log', `[Session ${sessionIndex + 1}] Failed to complete`);
        }
      } catch (err) {
        tasks[sessionIndex].status = 'failed';
        emitter.emit('log', `[Session ${sessionIndex + 1}] Error: ${err.message}`);
      } finally {
        activeBrowsers--;
        emitStatsUpdate();
      }
    }
  };

  const maintainActiveBrowsers = async () => {
    const workers = [];
    for (let i = 0; i < threads; i++) {
      workers.push(processSession());
    }
    await Promise.all(workers);
  };

  emitter.on('stop', async () => {
    isStopped = true;
    // Mark all non-completed tasks as stopped immediately
    tasks.forEach(task => {
      if (task.status === 'pending' || task.status === 'running') {
        task.status = 'stopped';
      }
    });
    emitter.emit('status', 'stopped');
    emitter.emit('log', 'Stop signal received. Force closing all browsers...');
    
    // Force close all browsers immediately
    const closePromises = openBrowsers.map(async (browser) => {
      try {
        await browser.close();
        emitter.emit('log', 'Browser force-closed.');
      } catch (err) {
        emitter.emit('log', `Error closing browser: ${err.message}`);
      }
    });
    await Promise.all(closePromises);
    openBrowsers = [];
    activeBrowsers = 0;
    emitStatsUpdate();
  });

  emitter.on('pause', () => {
    isPaused = true;
    emitter.emit('status', 'paused');
    emitter.emit('log', 'Campaign paused.');
    emitStatsUpdate();
  });

  emitter.on('resume', () => {
    isPaused = false;
    emitter.emit('status', 'running');
    emitter.emit('log', 'Campaign resumed.');
    emitStatsUpdate();
  });

  emitter.emit('status', 'running');
  emitter.emit('log', `Starting social traffic with ${threads} active browsers...`);
  emitStatsUpdate();

  await maintainActiveBrowsers();

  emitter.emit('status', isStopped ? 'stopped' : 'completed');
  emitter.emit('log', isStopped ? 'Campaign stopped.' : 'All sessions complete!');

  const finalStats = {
    completed: tasks.filter(t => t.status === 'completed').length,
    pending: tasks.filter(t => t.status === 'pending').length,
    failed: tasks.filter(t => t.status === 'failed').length,
    stopped: tasks.filter(t => t.status === 'stopped').length,
    totalProcessed: tasks.filter(t => t.status === 'completed' || t.status === 'failed').length,
    remaining: tasks.filter(t => t.status === 'pending' || t.status === 'running').length
  };
  emitter.emit('summary', finalStats);
  emitStatsUpdate();

  return emitter;
}

module.exports = {
  startSocialTraffic: (config) => {
    const emitter = new EventEmitter();
    setImmediate(() => {
      main(config, emitter).catch((err) => {
        try {
          emitter.emit('log', `Fatal error: ${err.message}`);
          emitter.emit('status', 'failed');
        } catch (_) {}
      });
    });
    return emitter;
  },
  sleep,
  randomBetween,
  pickRandom
};