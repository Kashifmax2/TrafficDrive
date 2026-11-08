const { launchBrowser: _launchBrowser } = require('./browser-launcher.js');
const PopupHandler = require('./PopupHandler.js');
const EventEmitter = require('events');
const stopManager = require('./StopManager.js');
const { installCaptchaGuard } = require('./CaptchaGuard.js');
const { installPrivacyGuard, privacyContextOptions } = require('./PrivacyGuard.js');
const {
  installProxyErrorWatcher,
  installPopupGuard,
  waitForExtraTabs,
  looksLikeAdLink,
  parseNetError,
  detectChromeErrorPage,
} = require('./PageGuard.js');
const {
  resolveProxyGeo,
  installContextEgressGuard,
  verifyEgress,
} = require('./EgressGuard.js');
const { runWithProxyRetry } = require('./ProxyRotation.js');
const { visitInternalLinks: visitLinks } = require('./LinkClicker.js');
const { startRandomClicker } = require('./RandomClicker.js');
const { chooseViewport, describeProfile, resolveSessionDevice, uaPlatform, uaBrands, uaChPlatform, physicalScreen } = require('./SessionProfile.js');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

const DESKTOP_USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
];

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
  return pickRandom(DESKTOP_USER_AGENTS);
}

function getViewport(device, autoRotateResolutions, vpWidth, vpHeight, sessionNum) {
  // Applies the exact per-thread resolutions chosen in Screen Resolutions,
  // including mobile physical → CSS conversion.
  return chooseViewport(device, autoRotateResolutions, vpWidth, vpHeight, sessionNum);
}

async function humanScroll(page, scrollDirection, waitTimeMs) {
  try {
    // page.evaluate has no timeout of its own and can hang forever while the
    // page is navigating (seen on heavy sites like Facebook). Never let a
    // scroll stall a session.
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

      // Native smooth scroll: requestAnimationFrame is paused in background
      // tabs, so a JS animation loop could hang for 10+ seconds per page.
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

// Normalize a URL so the same page is never counted twice (drops hash,
// query-only tracking differences are kept, trailing slash is unified).
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
  const {
    internalPagesCount, internalScrollMode, internalPageWaitMs,
    scrollDownWaitMs, scrollUpWaitMs, targetUrl
  } = config;
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

async function runDirectSession(config, emitter, sessionNum, browserTracker, isStoppedRef, campaignId) {
  const {
    targetUrl, sessions, threads, headless, proxy,
    userAgents, uaAutoRotate, device, customBrowserPath, browserEngine,
    visitTimeMs, viewportWidth, viewportHeight, autoRotateResolutions,
    scrollingInternalPagesEnabled, scrollDirection, scrollDownWaitMs, 
    scrollUpWaitMs, internalPagesCount, internalScrollMode, internalPageWaitMs, proxies: proxiesData
  } = config;

  // Debug logging
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`[Direct Traffic] Session ${sessionNum} Config:`);
  console.log('Headless:', headless, '(type:', typeof headless, ')');
  console.log('Target URL:', targetUrl);
  console.log('Threads:', threads);
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

  const ua = getUserAgent(userAgents, uaAutoRotate, device);
  const effectiveDevice = resolveSessionDevice(device, ua);
  const deviceChanged = effectiveDevice !== device;
  // If the UA switched the device type, the resolutions chosen for the other
  // device (e.g. 1920x1080 desktop sizes) are unrealistic: use the matching
  // built-in pool instead.
  const vp = getViewport(effectiveDevice, deviceChanged ? true : autoRotateResolutions, viewportWidth, viewportHeight, sessionNum);
  emitter.emit('log', `[Session ${sessionNum}] ${describeProfile(ua, vp, effectiveDevice)}`);
  if (deviceChanged) {
    emitter.emit(
      'log',
      `[Session ${sessionNum}] Device Setting was "${device}" but the user agent is ${effectiveDevice} - ${effectiveDevice} emulation (Sec-CH-UA-Mobile) applied so trackers see the correct device. Select Mobile + mobile user agents for phone traffic.`,
      'WARN'
    );
  }

  // Prepare proxy options
  let proxyOptions = {};
  let assignedProxy = null;
  let activeProxy = null;
  if (proxiesData && proxiesData.useProxies) {
    // Use proxies validated against the real campaign / ad target first, then
    // the generic working list. Never fall back to the direct connection.
    const working = Array.isArray(proxiesData.workingProxies) ? proxiesData.workingProxies : [];
    const allProxies = Array.isArray(proxiesData.proxies) ? proxiesData.proxies : [];
    const targetOkPool = working.filter(p => p && p.targetOk === true &&
      (!proxiesData.checkUrl || !p.targetUrl || p.targetUrl === proxiesData.checkUrl));
    const proxyPool = targetOkPool.length > 0
      ? targetOkPool
      : (working.length > 0 ? working : allProxies);

    if (!proxyPool.length) {
      emitter.emit('log', `[Session ${sessionNum}] Proxy mode is ON but no proxy is available. Session aborted - direct-IP fallback is disabled.`, 'ERROR');
      return 'proxy_blocked';
    }

    if (proxiesData.checkUrl && !targetOkPool.length && working.length) {
      emitter.emit('log', `[Session ${sessionNum}] WARNING: no proxy is verified against ${proxiesData.checkUrl} - using the working pool. Validate the target once on the Proxies page for better ad acceptance.`, 'WARN');
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
        let reachOk = false;
        for (let t = 0; t < maxTries; t++) {
          const reach = await ph.testReachability(sessionProxy, proxiesData.checkUrl, 6000);
          if (reach.ok) { reachOk = true; break; }
          const nextRaw = proxyPool[(sessionNum + proxyOffset + t + 1) % proxyPool.length];
          const nextProxy = ph.buildSessionProxy(nextRaw, `t${sessionNum}`);
          emitter.emit('log', `[Session ${sessionNum}] Proxy ${sessionProxy.host}:${sessionProxy.port} cannot open ${proxiesData.checkUrl} (${reach.reason}) - switching to ${nextProxy.host}:${nextProxy.port}`, 'WARN');
          assignedProxy = nextRaw;
          sessionProxy = nextProxy;
        }
        if (!reachOk) {
          emitter.emit('log', `[Session ${sessionNum}] No proxy in the list can open the target ${proxiesData.checkUrl}. Session aborted - direct-IP fallback is disabled.`, 'ERROR');
          return 'proxy_blocked';
        }
      }
      proxyOptions = ph.buildPlaywrightProxyOpts(sessionProxy);
      activeProxy = sessionProxy;

      const proxyLabel = sessionProxy.username
        ? `${sessionProxy.host}:${sessionProxy.port} (user: ${sessionProxy.username})`
        : `${sessionProxy.host}:${sessionProxy.port}`;
      emitter.emit('log', `[Session ${sessionNum}] Using proxy: ${proxyLabel}`);
    }
  }

  // Resolve the proxy's own egress IP + timezone through the proxy. This is
  // used for geolocation/timezone spoofing and for the egress IP check, so
  // the session can never present the PC's real network identity.
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
  console.log(`[Direct Traffic] Session ${sessionNum} - About to launch browser`);
  console.log('Launch Args:', launchArgs);
  console.log('Headless value being passed:', headless, '(expected: false)');
  console.log('Viewport:', vp);
  console.log('User Agent: ' + (ua ? ua.substring(0, 50) + '...' : 'undefined'));
  console.log('═══════════════════════════════════════════════════════════');

  // Launch Playwright's Chromium browser — NO proxy at launch level.
  // Proxy is applied exclusively on browser.newContext() below to avoid
  // Chromium spawning a blocking system-level proxy auth dialog.
  const browser = await _launchBrowser({
    headless: headless,
    customBrowserPath: customBrowserPath || undefined,
    args: launchArgs,
    onLog: (msg) => emitter.emit('log', msg),
    sessionId: `Session ${sessionNum}`,
  });
  
  emitter.emit('log', `[Session ${sessionNum}] Browser launched successfully`);

  // Register with StopManager so Stop can force-close it immediately
  if (campaignId) stopManager.registerBrowser(campaignId, browser);

  if (browserTracker) {
    browserTracker(browser);
  }

  // Set to { failed: true, code: 'ERR_...' } by the error-page watcher so the
  // session can abort immediately and the caller can retry with another proxy.
  let proxyFailRef = { failed: false, code: '' };
  let proxyFailedResult = null;
  // Only set after the full visit time has elapsed on a real page. A session
  // that ends on a Chrome error page is never counted as a visit.
  let visitCompleted = false;
  // Random auto-clicking runs in the background for the whole visit window.
  let randomClicker = null;

  try {
    if (isStopped()) {
      return false;
    }

    const contextOptions = {
      viewport: { width: vp.width, height: vp.height },
      userAgent: ua,
      isMobile: !!vp.isMobile,
      hasTouch: !!vp.hasTouch,
      deviceScaleFactor: vp.deviceScaleFactor || 1,
    };
    // Real screen size in physical pixels (window.screen / fingerprinting).
    if (vp.hasTouch) {
      const screenSize = physicalScreen(vp);
      if (screenSize) contextOptions.screen = screenSize;
    }
    // Network-level privacy (DNT / Accept-Language) must be set on the
    // context; an init script cannot change request headers.
    Object.assign(contextOptions, privacyContextOptions(config.privacyFeatures || []));
    if (proxyOptions && proxyOptions.proxy) {
      contextOptions.proxy = proxyOptions.proxy;
    }
    // Match the browser's clock and geolocation to the proxy's real location.
    if (proxyGeo && proxyGeo.timezone) {
      contextOptions.timezoneId = proxyGeo.timezone;
    } else if (proxyOptions && proxyOptions.proxy) {
      // Never fall back to the PC's own (Asia/Karachi) timezone while a proxy
      // is active - that alone reveals the real location.
      contextOptions.timezoneId = 'America/New_York';
    }
    if (proxyGeo && typeof proxyGeo.lat === 'number' && typeof proxyGeo.lon === 'number') {
      contextOptions.geolocation = {
        latitude: proxyGeo.lat,
        longitude: proxyGeo.lon,
        accuracy: 5000,
      };
      contextOptions.permissions = ['geolocation'];
    } else if (proxyOptions && proxyOptions.proxy) {
      // No proxy location available: deny geolocation instead of exposing
      // the PC's real location.
      contextOptions.permissions = [];
    }

    const context = await browser.newContext(contextOptions);

    // Spoof the traffic source (referrer) if the global option is enabled.
    const trafficSourceResult = await require('./TrafficSource.js').installTrafficSource(context, config.trafficSource, {
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

    // CAPTCHA guard — pauses the workflow if a reCAPTCHA challenge appears
    // during the direct visit. The bundled extension attempts an auto-solve;
    // otherwise the UI notifies the user to complete it manually.
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

    // "This site can't be reached" -> close the tab immediately so the session
    // can be retried with a different proxy (instead of wasting 10+ seconds).
    installProxyErrorWatcher(page, {
      sessionId: `Session ${sessionNum}`,
      onLog: (msg, type) => emitter.emit('log', msg, type),
      ref: proxyFailRef,
    });

    // Apply privacy/anti-detection features (from the Privacy page toggles)
    // to the whole context, so ad popups / background tabs are covered too.
    const privacyFeatures = config.privacyFeatures || [];
    const privacyLevel = config.privacyLevel || 'standard';
    await installPrivacyGuard(context, {
      privacyFeatures,
      privacyLevel,
      timezone: proxyGeo && proxyGeo.timezone,
      ua,
      platform: uaPlatform(ua),
      chPlatform: uaChPlatform(ua),
      brands: uaBrands(ua),
      device: effectiveDevice,
      viewport: vp,
      hasTouch: !!vp.hasTouch,
      trafficReferrer: trafficSourceResult && trafficSourceResult.applied ? trafficSourceResult.referrer : '',
      onLog: (msg) => emitter.emit('log', msg),
    });

    // Workaround for Playwright Chromium proxy-auth redirect hang. fallback()
    // (not continue()) so the context-level privacy routes still run.
    if (proxyOptions && proxyOptions.proxy && proxyOptions.proxy.server) {
      try { await page.route('**/*', route => route.fallback()); } catch (_) {}
    }

    try { await page.bringToFront(); } catch (_) {}

    if (isStopped()) {
      return false;
    }

    const popupOpts = { label: `[Session ${sessionNum}]`, log: emitter };

    const forceNavigate = async (url) => {
      try {
        await page.evaluate((u) => { window.location.href = u; }, url);
      } catch (_) {}
    };

    const navigateWithRetry = async (url, label) => {
      // When using a proxy, the website can take much longer to load due to
      // proxy latency / tunnel priming. Use more attempts and longer timeouts
      // so the browser doesn't give up and close before the page actually opens.
      const usingProxy = !!(proxyOptions && proxyOptions.proxy && proxyOptions.proxy.server);
      const maxAttempts = usingProxy ? 8 : 4;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (isStopped && isStopped()) throw new Error('__STOPPED__');
        if (proxyFailRef.failed) throw new Error('__PROXY_FAILED__:' + proxyFailRef.code);

        // ── CAPTCHA pause: wait for any active CAPTCHA to be resolved before
        // attempting navigation.  This prevents the retry loop from
        // navigating away while the extension is solving a CAPTCHA.
        if (captchaGuard && captchaGuard.isBusy()) {
          emitter.emit('log', `[Session ${sessionNum}] CAPTCHA in progress — pausing navigation to ${label}...`, 'warning');
          await captchaGuard.waitForCaptchaResolution();
          if (isStopped && isStopped()) throw new Error('__STOPPED__');
        }

        const aboutBlankWatchdog = setTimeout(() => {
          const current = page.url();
          // Don't fire the watchdog if a CAPTCHA is being solved
          if (captchaGuard && captchaGuard.isBusy()) return;
          if (!current || current === 'about:blank') {
            emitter.emit('log', `[Session ${sessionNum}] Watchdog: about:blank detected, forcing navigation...`, 'WARN');
            forceNavigate(url).catch(() => {});
          }
        }, usingProxy ? (attempt === 1 ? 30000 : 50000) : (attempt === 1 ? 15000 : 25000));

        try {
          emitter.emit('log', `[Session ${sessionNum}] Navigating to ${label} (attempt ${attempt}/${maxAttempts})...`);

          const currentUrl = page.url();
          if (currentUrl === 'about:blank' && attempt > 1) {
            // Don't reload if a CAPTCHA is active
            if (!captchaGuard || !captchaGuard.isBusy()) {
              try { await page.reload({ waitUntil: 'commit', timeout: usingProxy ? 30000 : 15000 }); } catch (_) {}
            }
          }

          // Longer timeouts when using a proxy — the proxy tunnel adds latency
          const navTimeout = usingProxy
            ? (attempt <= 2 ? 60000 : (attempt <= 5 ? 90000 : 120000))
            : (attempt === 1 ? 25000 : 45000);
          const waitStage = attempt <= 2 ? 'commit' : 'domcontentloaded';

          try {
            await page.goto(url, { waitUntil: waitStage, timeout: navTimeout });
          } catch (firstNavErr) {
            if (isStopped && isStopped()) throw new Error('__STOPPED__');
            // Proxy/network level failure: the site can never load with this
            // proxy. Abort immediately instead of retrying the same tunnel.
            const netCode = parseNetError(firstNavErr.message);
            if (netCode) throw new Error('__PROXY_FAILED__:' + netCode);
            // Don't force-navigate if a CAPTCHA appeared during the timeout
            if (captchaGuard && captchaGuard.isBusy()) {
              emitter.emit('log', `[Session ${sessionNum}] CAPTCHA detected during navigation — waiting for extension to solve...`, 'warning');
              clearTimeout(aboutBlankWatchdog);
              await captchaGuard.waitForCaptchaResolution();
              if (isStopped && isStopped()) throw new Error('__STOPPED__');
              const landed = page.url();
              if (landed && landed !== 'about:blank') {
                try { await page.waitForLoadState('domcontentloaded', { timeout: usingProxy ? 30000 : 15000 }); } catch (_) {}
                return landed;
              }
              continue;
            }
            const errMsg = firstNavErr.message || '';
            if (/timeout|timed out/i.test(errMsg) && attempt < maxAttempts) {
              emitter.emit('log', `[Session ${sessionNum}] Navigation slow, trying window.location fallback...`, 'WARN');
              try {
                await Promise.race([
                  new Promise((_, rej) => setTimeout(() => rej(new Error('force-timeout')), usingProxy ? 40000 : 20000)),
                  (async () => {
                    await forceNavigate(url);
                    await page.waitForNavigation({ waitUntil: 'commit', timeout: usingProxy ? 30000 : 15000 }).catch(() => {});
                  })(),
                ]);
              } catch (_) {}
            } else {
              throw firstNavErr;
            }
          }
        } catch (navErr) {
          clearTimeout(aboutBlankWatchdog);
          if (isStopped && isStopped()) throw new Error('__STOPPED__');
          if (proxyFailRef.failed) throw new Error('__PROXY_FAILED__:' + proxyFailRef.code);
          if (String(navErr.message || '').startsWith('__PROXY_FAILED__')) throw navErr;
          if (attempt < maxAttempts) {
            emitter.emit('log', `[Session ${sessionNum}] Navigation error (${navErr.message.substring(0, 90)}) — retrying in 2s...`, 'WARN');
            await sleep(2000);
            continue;
          }
          throw navErr;
        } finally {
          clearTimeout(aboutBlankWatchdog);
        }

        const errCode = await detectChromeErrorPage(page);
        if (errCode) throw new Error('__PROXY_FAILED__:' + errCode);

        const landed = page.url();
        if (landed && landed !== 'about:blank') {
          emitter.emit('log', `[Session ${sessionNum}] Page loaded: ${landed.substring(0, 70)}`);
          try {
            await page.waitForLoadState('domcontentloaded', { timeout: usingProxy ? 30000 : 15000 });
          } catch (_) {}
          // Wait for CAPTCHA after landing
          if (captchaGuard) await captchaGuard.waitForCaptchaResolution();
          return landed;
        }

        emitter.emit('log', `[Session ${sessionNum}] Still on about:blank — forcing navigation via window.location...`, 'WARN');
        await forceNavigate(url);
        try { await page.waitForNavigation({ waitUntil: 'commit', timeout: usingProxy ? 30000 : 15000 }); } catch (_) {}
        if (attempt < maxAttempts) await sleep(2000);
      }

      // ── FINAL PATIENT WAIT ────────────────────────────────────────────────
      // All retry attempts exhausted but the page might still be loading
      // through a slow proxy. Instead of immediately closing the browser,
      // wait up to 3 minutes for the page to actually land on a real URL.
      const finalCheck = page.url();
      if (finalCheck && finalCheck !== 'about:blank') {
        const finalErr = await detectChromeErrorPage(page);
        if (finalErr) throw new Error('__PROXY_FAILED__:' + finalErr);
        emitter.emit('log', `[Session ${sessionNum}] Page loaded on final check: ${finalCheck.substring(0, 70)}`);
        return finalCheck;
      }

      if (usingProxy) {
        emitter.emit('log', `[Session ${sessionNum}] Proxy is slow — waiting up to 3 minutes for page to load...`, 'WARN');
        const patientDeadline = Date.now() + 180000; // 3 minutes
        while (Date.now() < patientDeadline) {
          if (isStopped && isStopped()) throw new Error('__STOPPED__');
          if (captchaGuard && captchaGuard.isBusy()) {
            await captchaGuard.waitForCaptchaResolution();
          }
          await sleep(5000);
          const patientUrl = page.url();
          if (patientUrl && patientUrl !== 'about:blank') {
            emitter.emit('log', `[Session ${sessionNum}] Page finally loaded: ${patientUrl.substring(0, 70)}`);
            try { await page.waitForLoadState('domcontentloaded', { timeout: 30000 }); } catch (_) {}
            if (captchaGuard) await captchaGuard.waitForCaptchaResolution();
            return patientUrl;
          }
        }
      }

      throw new Error(`Page stuck on about:blank after ${maxAttempts} attempts — proxy may be blocking`);
    };

    if (proxyOptions && proxyOptions.proxy && proxyOptions.proxy.server) {
      emitter.emit('log', `[Session ${sessionNum}] Priming proxy tunnel with lightweight warm-up request...`);
      try {
        const warmupUrl = /https?:\/\//i.test(targetUrl)
          ? (new URL(targetUrl).origin + '/favicon.ico')
          : 'https://www.google.com/favicon.ico';
        await Promise.race([
          new Promise((_, rej) => setTimeout(() => rej(new Error('warmup-timeout')), 25000)),
          page.goto(warmupUrl, { waitUntil: 'commit', timeout: 20000 }).catch(() => {}),
        ]);
      } catch (_) {}
    }

    try {
      await navigateWithRetry(targetUrl, targetUrl.length > 60 ? targetUrl.substring(0, 60) + '...' : targetUrl);
      if (isStopped()) return false;
      await sleep(2000);
      if (isStopped()) return false;
      // Pause if the target site (or an interstitial) shows a CAPTCHA
      if (captchaGuard) await captchaGuard.waitForCaptchaResolution();
      if (isStopped()) return false;
      await PopupHandler.dismissAll(page, popupOpts);
      await sleep(1000);
      if (isStopped()) return false;

      // Random clicks anywhere on the page (ads included), with optional
      // scroll + refresh, for the duration of the visit window only.
      randomClicker = startRandomClicker(page, {
        config: config.randomClicks,
        sessionId: `Session ${sessionNum}`,
        onLog: (msg, type) => emitter.emit('log', msg, type),
        isStopped,
      });

      if (scrollingInternalPagesEnabled) {
        await smoothNaturalScroll(page, scrollDirection, scrollDownWaitMs, scrollUpWaitMs);
        if (isStopped()) return false;
        await sleep((visitTimeMs || 20000) + randomBetween(0, 5000));
        if (isStopped()) return false;
        // Internal links must be clicked by LinkClicker alone: pause random
        // clicks so they cannot steal the click or navigate mid-step.
        if (randomClicker) await randomClicker.pause();
        await visitInternalPages(page, config, emitter, sessionNum, isStopped, captchaGuard);
        if (randomClicker) randomClicker.resume();
        if (isStopped()) return false;
      } else {
        await sleep((visitTimeMs || 20000) + randomBetween(0, 5000));
        if (isStopped()) return false;
      }
      if (randomClicker) randomClicker.stop();
      // Full visit time has elapsed. Refuse to count the visit if the tab
      // ended up on Chrome's "This site can't be reached" page.
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
      visitCompleted = true;
      emitter.emit('log', `[Session ${sessionNum}] Direct visit completed`);
    } catch (error) {
      const errMsg = String((error && error.message) || '');
      if (proxyFailRef.failed || errMsg.startsWith('__PROXY_FAILED__')) {
        const code = proxyFailRef.code || errMsg.split(':')[1] || 'ERR_CONNECTION_FAILED';
        emitter.emit(
          'log',
          `[Session ${sessionNum}] Site can't be reached (${code}) - closing and switching to another proxy`,
          'WARN'
        );
        return 'proxy_blocked';
      }
      emitter.emit('log', `[Session ${sessionNum}] Direct visit failed: ${error.message}`);
    }

    if (isStopped()) return false;
    await sleep(randomBetween(2000, 5000));
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
      emitter.emit('log', `[Session ${sessionNum}] Fatal error: ${err.message}`);
      console.error(err);
    }
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
  return proxyFailedResult || visitCompleted;
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
    const stats = {
      total: total,
      completed: completed,
      running: tasks.filter(t => t.status === 'running').length,
      pending: tasks.filter(t => t.status === 'pending').length,
      failed: tasks.filter(t => t.status === 'failed').length,
      stopped: tasks.filter(t => t.status === 'stopped').length,
      activeBrowsers: activeBrowsers,
      remaining: tasks.filter(t => t.status === 'pending' || t.status === 'running').length,
      progress: Math.round((completed / total) * 100)
    };
    emitter.emit('stats', stats);
  }

  const trackedRunDirectSession = async (config, emitter, sessionNum, isStoppedRef) => {
    let browser = null;
    try {
      const result = await runDirectSession(config, emitter, sessionNum, (b) => { 
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
          runOnce: (cfg) => trackedRunDirectSession(cfg, emitter, sessionIndex + 1, () => isStopped),
          onLog: (msg, type) => emitter.emit('log', `[Session ${sessionIndex + 1}] ${msg}`, type),
          isStopped: () => isStopped,
        });
        if (isStopped) {
          tasks[sessionIndex].status = 'stopped';
        } else if (result) {
          tasks[sessionIndex].status = 'completed';
          emitter.emit('log', `[Session ${sessionIndex + 1}] Completed successfully`);
        } else {
          tasks[sessionIndex].status = 'failed';
          emitter.emit('log', `[Session ${sessionIndex + 1}] Failed to complete`);
        }
      } catch (err) {
        tasks[sessionIndex].status = isStopped ? 'stopped' : 'failed';
        if (!isStopped) emitter.emit('log', `[Session ${sessionIndex + 1}] Error: ${err.message}`);
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
    
    // StopManager: abort all sleeps + force-close all registered browsers instantly
    await stopManager.stopCampaign(campaignId);

    // Also close any browsers tracked in the local array (belt-and-suspenders)
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
    stopManager.endCampaign(campaignId);
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
  emitter.emit('log', `Starting direct traffic with ${threads} active browsers...`);
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

  stopManager.endCampaign(campaignId);

  return emitter;
}

module.exports = {
  startDirectTraffic: (config) => {
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
  pickRandom,
  // Exposed for diagnostics/tests only.
  __internal: require('./LinkClicker.js'),
};
