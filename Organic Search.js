const { launchBrowser: _launchBrowser } = require('./browser-launcher.js');
const { runInternalLinkNavigation, readArticlesOnPage, waitForFullPageLoad, dismissConsentPopup } = require('./Internal link navigator.js');
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

function getSearchHomepage(engineObj) {
  return engineObj.homepage;
}

// ---------------------------------------------------------------------------
// URL matching helpers for finding the target website in search results.
//
// Search engines (Google especially) rarely expose the destination URL as a
// plain substring of the anchor's href:
//   - Google wraps many results in /url?q=<encoded>&sa=... redirects
//   - The href may differ from the user's target in trailing slash, www.
//     prefix, http vs https, or capitalisation
//   - The visible "cite" text in a result often shows the bare domain while
//     the anchor href is a redirect
//
// normalizeUrl() strips the protocol, leading www., trailing slash, query and
// fragment so two URLs that point to the same page compare equal.
// unwrapRedirect() extracts the real destination from a /url?q= style redirect
// (Google, Bing, Yahoo variants).
// ---------------------------------------------------------------------------

// Returns { host, path } (lowercased, www-stripped, trailing-slash-stripped)
// or null if the URL cannot be parsed.
function normalizeUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    let path = u.pathname.toLowerCase().replace(/\/+$/, '');
    if (path === '') path = '/';
    return { host, path };
  } catch {
    return null;
  }
}

// Extract the real destination URL from a search-engine redirect wrapper.
// Returns the unwrapped URL string, or the original href if it isn't a redirect.
function unwrapRedirect(href, baseHref) {
  try {
    const u = new URL(href, baseHref || undefined);
    // Google: /url?q=...  /imgres?imgurl=...  /search?q=... (rare)
    if (u.pathname === '/url' || u.pathname === '/imgres') {
      const q = u.searchParams.get('q') || u.searchParams.get('url') || u.searchParams.get('imgurl');
      if (q) return q;
    }
    // Bing / Yahoo sometimes use u= or rurl=
    const alt = u.searchParams.get('u') || u.searchParams.get('rurl');
    if (alt) return alt;
  } catch {
    // fall through
  }
  return href;
}

// Score how well a candidate href matches the target URL.
// 0 = no match, 1 = hostname only, 2 = path prefix, 3 = exact path.
function scoreMatch(candNorm, targetNorm) {
  if (!candNorm || !targetNorm) return 0;
  if (candNorm.host !== targetNorm.host) return 0;
  if (candNorm.path === targetNorm.path) return 3;
  if (targetNorm.path === '/' || candNorm.path === '/') return 2;
  if (candNorm.path.startsWith(targetNorm.path) || targetNorm.path.startsWith(candNorm.path)) return 2;
  return 1;
}

function getSearchUrl(engineObj, keyword, pageNum) {
  const q = encodeURIComponent(keyword);
  let searchUrl = engineObj.searchUrl.replace('{query}', q);

  if (pageNum > 1) {
    const engineId = (engineObj.id || '').toLowerCase();
    const engineName = (engineObj.name || '').toLowerCase();

    if (engineId.includes('google') || engineName.includes('google')) {
      const startIndex = (pageNum - 1) * 10;
      searchUrl += searchUrl.includes('?') ? `&start=${startIndex}` : `?start=${startIndex}`;
    } else if (engineId.includes('bing') || engineName.includes('bing')) {
      const firstIndex = (pageNum - 1) * 10 + 1;
      searchUrl += searchUrl.includes('?') ? `&first=${firstIndex}` : `?first=${firstIndex}`;
    } else if (engineId.includes('yahoo') || engineName.includes('yahoo')) {
      const bIndex = (pageNum - 1) * 10 + 1;
      searchUrl += searchUrl.includes('?') ? `&b=${bIndex}` : `?b=${bIndex}`;
    } else if (engineId.includes('duckduckgo') || engineName.includes('duckduckgo') || engineName.includes('duck')) {
      const sIndex = (pageNum - 1) * 30;
      searchUrl += searchUrl.includes('?') ? `&s=${sIndex}` : `?s=${sIndex}`;
    } else if (engineId.includes('yandex') || engineName.includes('yandex')) {
      const pIndex = pageNum - 1;
      searchUrl += searchUrl.includes('?') ? `&p=${pIndex}` : `?p=${pIndex}`;
    } else if (engineId.includes('ask') || engineName.includes('ask')) {
      searchUrl += searchUrl.includes('?') ? `&page=${pageNum}` : `?page=${pageNum}`;
    } else {
      searchUrl += searchUrl.includes('?') ? `&page=${pageNum}` : `?page=${pageNum}`;
    }
  }

  return searchUrl;
}

// ---------------------------------------------------------------------------
// tryClickNextPage
// Tries to find and click the "Next page" button/link in the search engine UI.
// Returns true if a Next button was found and clicked, false otherwise.
// ---------------------------------------------------------------------------
async function tryClickNextPage(page, engineObj) {
  // Ordered list of selectors to try, from most-specific to generic.
  // Covers Google, Bing, Yahoo, DuckDuckGo, Yandex, Ask, and a generic fallback.
  const nextSelectors = [
    // Google
    'a#pnnext',
    'a[aria-label="Next page"]',
    // Bing
    'a.sb_pagN',
    'a.b_widgetNextPage',
    // Yahoo
    'a.next',
    'a[aria-label="Next"]',
    // DuckDuckGo
    'button#more-results',
    'a.btn--primary[data-testid="pagination-button-next"]',
    // Yandex
    'a.pager__item_kind_next',
    // Ask
    'li.next a',
    // Generic fallbacks (ordered safest to most broad)
    'a[rel="next"]',
    'a:has-text("Next")',
    'button:has-text("Next")',
    'a:has-text("next")',
  ];

  for (const selector of nextSelectors) {
    try {
      const el = await page.$(selector);
      if (el) {
        const isVisible = await el.isVisible();
        if (isVisible) {
          await el.scrollIntoViewIfNeeded();
          await sleep(randomBetween(300, 800));
          await el.click({ delay: randomBetween(50, 150) });
          return true;
        }
      }
    } catch (_) {
      // Selector not found or not clickable — try next
    }
  }

  return false;
}

const MOBILE_USER_AGENTS = [
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 13; SM-A546B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 15_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.5 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 12; OnePlus CPH2449) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/111.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 13; XQ-AT52) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Mobile Safari/537.36',
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
  if (device === "mobile") return pickRandom(MOBILE_USER_AGENTS);
  if (device === "tablet") return pickRandom(TABLET_USER_AGENTS);
  return "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
}

// Resolution pools per device type — used when Auto Rotate Resolutions is on.
// Each session picks a random resolution suitable for the selected device.
const MOBILE_RESOLUTIONS = [
  [360, 640], [360, 740], [360, 780], [375, 667], [375, 812],
  [390, 844], [393, 851], [412, 915], [414, 896], [360, 800],
];
const TABLET_RESOLUTIONS = [
  [600, 960], [601, 962], [768, 1024], [800, 1280], [810, 1080],
  [834, 1194], [1024, 1366], [1280, 800],
];
const DESKTOP_RESOLUTIONS = [
  [1280, 720], [1280, 800], [1360, 768], [1366, 768], [1440, 900],
  [1536, 864], [1600, 900], [1680, 1050], [1920, 1080],
];

function getViewport(device, autoRotateResolutions, vpWidth, vpHeight, sessionNum) {
  // Applies the exact per-thread resolutions chosen in Screen Resolutions.
  return chooseViewport(device, autoRotateResolutions, vpWidth, vpHeight, sessionNum);
}

async function humanType(page, selector, text) {
  await page.click(selector, { delay: randomBetween(50, 150) });
  await sleep(randomBetween(200, 600));
  for (const char of text) {
    await page.keyboard.type(char, { delay: randomBetween(30, 180) });
    if (Math.random() < 0.05) {
      await sleep(randomBetween(200, 700));
    }
  }
}

async function humanScroll(page, scrollDirection, waitTimeMs) {
  try {
    // page.evaluate has no timeout and can hang forever during navigation.
    await Promise.race([
      page.evaluate((direction) => {
      const body = document.body;
      const html = document.documentElement;
      const documentHeight = Math.max(
        body.scrollHeight, body.offsetHeight,
        html.clientHeight, html.scrollHeight, html.offsetHeight
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

      // Native smooth scroll (requestAnimationFrame is paused in background
      // tabs and a JS animation loop could hang for 10+ seconds).
      window.scrollTo({ top: targetY, behavior: 'smooth' });
      }, scrollDirection).catch(() => {}),
      sleep(8000),
    ]);

    await sleep(waitTimeMs || randomBetween(500, 2000));
  } catch (err) {
    // Page/browser may have been closed mid-scroll — don't crash the session.
  }
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

async function visitInternalPages(page, config, emitter, sessionNum, captchaGuard) {
  const { internalPagesCount, internalScrollMode, internalPageWaitMs, scrollDownWaitMs, scrollUpWaitMs, targetUrl } = config;
  const popupOpts = { label: `[Session ${sessionNum}]`, log: emitter };

  if (!internalPagesCount || internalPagesCount <= 0) {
    emitter.emit('log', `[Session ${sessionNum}] Internal pages skipped (count is 0)`);
    return;
  }

  // Let the page settle and trigger lazy-loaded content before collecting links.
  try {
    await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
  } catch (_) {}
  await sleep(800);
  // A small scroll nudges many sites to render hidden/lazy navigation links
  // (especially on mobile/tablet views where menus are off-screen).
  try {
    await page.evaluate(() => window.scrollBy(0, 300));
  } catch (_) {}
  await sleep(500);

  // Collect internal links robustly.  We resolve relative hrefs against the
  // page's own URL (not the configured targetUrl) so sites that redirect
  // (http→https, www→non-www, etc.) still match.  We also accept any link
  // whose hostname matches the current page hostname.
  const internalLinks = await page.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll('a[href]'));
    const currentOrigin = window.location.origin;
    const currentHref = window.location.href.split('#')[0];
    const seen = new Set();
    const result = [];
    for (const a of anchors) {
      const raw = a.getAttribute('href');
      if (!raw) continue;
      if (/^(javascript:|mailto:|tel:|data:|#)/i.test(raw)) continue;
      let url;
      try { url = new URL(a.href, window.location.href); } catch { continue; }
      if (url.origin !== currentOrigin) continue;
      // Skip ad / affiliate / tracker redirect links.
      if (/(^|[?&])(ad|ads|adid|ad_id|aff|affid|aff_id|zoneid|zone_id|gclid|fbclid|msclkid|popunder)=/i.test(url.search)) continue;
      if (/\/(adclick|adserver|popunder|adservice|adsense|sponsor)(\/|\?|$)/i.test(url.pathname)) continue;
      const clean = url.href.split('#')[0];
      if (clean === currentHref) continue;          // skip the page we're already on
      if (seen.has(clean)) continue;
      seen.add(clean);
      result.push(clean);
    }
    return result;
  }).catch(() => []);

  if (!internalLinks || internalLinks.length === 0) {
    emitter.emit('log', `[Session ${sessionNum}] No internal links found on the page`);
    return;
  }

  emitter.emit('log', `[Session ${sessionNum}] Found ${internalLinks.length} internal link(s), visiting ${Math.min(internalPagesCount, internalLinks.length)}`);

  // Re-collect links from whatever page is currently open on every step, so a
  // link from the landing page is never "not found" after we have navigated.
  await visitLinks(page, {
    count: internalPagesCount,
    origin: (() => {
      try {
        return new URL(page.url() || targetUrl).origin;
      } catch (_) {
        return originFrom(targetUrl);
      }
    })(),
    onLog: (m) => emitter.emit('log', `[Session ${sessionNum}] ${m}`),
    isStopped: () => false,
    gotoTimeoutMs: 60000,
    ensureCaptcha: captchaGuard ? () => captchaGuard.waitForCaptchaResolution() : null,
    onPage: async () => {
      if (captchaGuard) await captchaGuard.waitForCaptchaResolution();
      try { await page.waitForLoadState('networkidle', { timeout: 12000 }); } catch (_) {}
      await sleep(1500);
      await PopupHandler.dismissAll(page, popupOpts);
      await smoothNaturalScroll(page, internalScrollMode, scrollDownWaitMs, scrollUpWaitMs);
      await sleep(internalPageWaitMs || 5000);
    },
  });
}

function originFrom(u) {
  try { return new URL(u).origin; } catch (_) { return ''; }
}

async function runSearchSession(config, emitter, sessionNum, browserTracker, isStoppedRef, campaignId) {
  const {
    targetUrl, keywords, searchEngines, assignedEngine, maxPages, headless, proxy,
    userAgents, uaAutoRotate, device, customBrowserPath, browserEngine,
    openWebSeed, webSeedUrl, scrollLinkSystem, articlesToRead, internalLinkNavigation,
    visitTimeMs, internalLinkVisitTimeMs, viewportWidth, viewportHeight, autoRotateResolutions,
    scrollingInternalPagesEnabled, scrollDirection, scrollDownWaitMs, scrollUpWaitMs, internalPagesCount,
    internalScrollMode, internalPageWaitMs, proxies: proxiesData
  } = config;

  // Debug logging
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`[Search Traffic] Session ${sessionNum} Config:`);
  console.log('Headless:', headless, '(type:', typeof headless, ')');
  console.log('Target URL:', targetUrl);
  console.log('Keywords:', keywords ? keywords.length : 0);
  console.log('Search Engines:', searchEngines ? searchEngines.length : 0);
  console.log('═══════════════════════════════════════════════════════════');

  // Unified stop check: StopManager (primary) or legacy isStoppedRef fallback
  const isStopped = () => stopManager.isStopped(campaignId) || (isStoppedRef && isStoppedRef());

  // Cancellable sleep — aborts instantly when Stop is pressed so the session
  // doesn't hang inside a long setTimeout waiting for nothing.
  const csleep = (ms) => stopManager.sleep(campaignId, ms);

  // Check stop immediately
  if (isStopped()) {
    return false;
  }

  let keyword = '';
  if (keywords && keywords.length > 0) {
    keyword = pickRandom(keywords);
  }

  let engineObj = assignedEngine;
  if (!engineObj && searchEngines && searchEngines.length > 0) {
    engineObj = pickRandom(searchEngines);
  }

  const vp = getViewport(device, autoRotateResolutions, viewportWidth, viewportHeight, sessionNum);
  const ua = getUserAgent(userAgents, uaAutoRotate, device);
  emitter.emit('log', `[Session ${sessionNum}] ${describeProfile(ua, vp, device)}`);

  const launchArgs = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-blink-features=AutomationControlled",
    "--disable-infobars",
    `--window-size=${vp.width},${vp.height}`,
  ];

  // Prepare proxy options
  let proxyOptions = {};
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
      proxyOptions = ph.buildPlaywrightProxyOpts(sessionProxy);
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

  // Launch Playwright's Chromium browser (proxy is applied at newContext() level,
  // NOT here — launch-level proxy auth causes a blocking dialog / about:blank).
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

  let found = false;
  // Set by the error-page watcher so this session can abort immediately and
  // the caller can retry with a different proxy.
  let proxyFailRef = { failed: false, code: '' };
  let proxyFailedResult = null;
  // Random auto-clicking runs in the background for the whole visit window.
  let randomClicker = null;
  try {
    // Check stop after browser launch — if stopped, close immediately without
    // creating any context/page so no window flashes on screen.
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
    if (proxyOptions && proxyOptions.proxy) {
      contextOptions.proxy = proxyOptions.proxy;
    }
    if (proxyGeo && proxyGeo.timezone) {
      contextOptions.timezoneId = proxyGeo.timezone;
    } else if (proxyOptions && proxyOptions.proxy) {
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
    } else if (proxyOptions && proxyOptions.proxy) {
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

    // Stop check right after context creation
    if (isStopped()) {
      try { await context.close(); } catch (_) {}
      return false;
    }

    const page = await context.newPage();

    // ── CAPTCHA guard ───────────────────────────────────────────────────────
    // Watches for reCAPTCHA challenges during search navigation. When a
    // challenge appears the workflow pauses (the bundled extension attempts an
    // auto-solve; if it can't, the UI notifies the user to solve manually).
    // waitForCaptchaResolution() resolves immediately when no challenge is
    // active, so calls are safe no-ops in the normal flow.
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
    if (proxyOptions && proxyOptions.proxy && proxyOptions.proxy.server) {
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

    // ── Proxy-aware navigation helper ────────────────────────────────────────
    // When an authenticated proxy is used, Playwright Chromium's first
    // navigation frequently hangs on about:blank (the proxy-auth handshake
    // stalls the very first request). Directtraffic.js solves this with a
    // warm-up request + a retrying navigator that force-loads via
    // window.location when about:blank is detected. We replicate the same
    // behaviour here so Search Traffic works with proxies.
    const forceNavigate = async (url) => {
      try { await page.evaluate((u) => { window.location.href = u; }, url); } catch (_) {}
    };

    const navigateWithRetry = async (url, label, opts = {}) => {
      const maxAttempts = opts.maxAttempts || 4;
      const finalWait = opts.finalWait || 'domcontentloaded';
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (isStopped()) throw new Error('__STOPPED__');
        if (proxyFailRef.failed) throw new Error('__PROXY_FAILED__:' + proxyFailRef.code);

        // ── CAPTCHA pause: wait for any active CAPTCHA to be resolved before
        // attempting navigation.  This prevents the retry loop from
        // navigating away while the extension is solving a CAPTCHA.
        if (captchaGuard && captchaGuard.isBusy()) {
          emitter.emit('log', `[Session ${sessionNum}] CAPTCHA in progress — pausing navigation to ${label}...`, 'warning');
          await captchaGuard.waitForCaptchaResolution();
          if (isStopped()) throw new Error('__STOPPED__');
        }

        const aboutBlankWatchdog = setTimeout(() => {
          const current = page.url();
          // Don't fire the watchdog if a CAPTCHA is being solved — the page
          // may appear stuck but the extension is actively working on it.
          if (captchaGuard && captchaGuard.isBusy()) return;
          if (!current || current === 'about:blank') {
            emitter.emit('log', `[Session ${sessionNum}] Watchdog: about:blank detected, forcing navigation...`);
            forceNavigate(url).catch(() => {});
          }
        }, attempt === 1 ? 15000 : 25000);

        try {
          emitter.emit('log', `[Session ${sessionNum}] Navigating to ${label} (attempt ${attempt}/${maxAttempts})...`);
          const currentUrl = page.url();
          if (currentUrl === 'about:blank' && attempt > 1) {
            // Don't reload if a CAPTCHA is active — it would interrupt the solve
            if (!captchaGuard || !captchaGuard.isBusy()) {
              try { await page.reload({ waitUntil: 'commit', timeout: 15000 }); } catch (_) {}
            }
          }
          const navTimeout = attempt === 1 ? 25000 : 45000;
          const waitStage = attempt <= 2 ? 'commit' : 'domcontentloaded';
          try {
            await page.goto(url, { waitUntil: waitStage, timeout: navTimeout });
          } catch (firstNavErr) {
            if (isStopped()) throw new Error('__STOPPED__');
            // Proxy/network level failure: abort now, never retry this tunnel.
            const netCode = parseNetError(firstNavErr.message);
            if (netCode) throw new Error('__PROXY_FAILED__:' + netCode);
            // Don't force-navigate if a CAPTCHA appeared during the timeout
            if (captchaGuard && captchaGuard.isBusy()) {
              emitter.emit('log', `[Session ${sessionNum}] CAPTCHA detected during navigation — waiting for extension to solve...`, 'warning');
              clearTimeout(aboutBlankWatchdog);
              await captchaGuard.waitForCaptchaResolution();
              if (isStopped()) throw new Error('__STOPPED__');
              // After CAPTCHA resolves, check if we landed successfully
              const landed = page.url();
              if (landed && landed !== 'about:blank') {
                try { await page.waitForLoadState(finalWait, { timeout: 15000 }); } catch (_) {}
                return landed;
              }
              continue; // retry
            }
            const errMsg = firstNavErr.message || '';
            if (/timeout|timed out/i.test(errMsg) && attempt < maxAttempts) {
              emitter.emit('log', `[Session ${sessionNum}] Navigation slow, trying window.location fallback...`);
              try {
                await Promise.race([
                  new Promise((_, rej) => setTimeout(() => rej(new Error('force-timeout')), 20000)),
                  (async () => {
                    await forceNavigate(url);
                    await page.waitForNavigation({ waitUntil: 'commit', timeout: 15000 }).catch(() => {});
                  })(),
                ]);
              } catch (_) {}
            } else {
              throw firstNavErr;
            }
          }
        } catch (navErr) {
          clearTimeout(aboutBlankWatchdog);
          if (isStopped()) throw new Error('__STOPPED__');
          if (proxyFailRef.failed) throw new Error('__PROXY_FAILED__:' + proxyFailRef.code);
          if (String(navErr.message || '').startsWith('__PROXY_FAILED__')) throw navErr;
          if (attempt < maxAttempts) {
            emitter.emit('log', `[Session ${sessionNum}] Navigation error (${(navErr.message || '').substring(0, 90)}) — retrying in 2s...`);
            await csleep(2000);
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
          try { await page.waitForLoadState(finalWait, { timeout: 15000 }); } catch (_) {}
          // Wait for CAPTCHA after landing — a CAPTCHA may have appeared
          // on the landed page (e.g., Google search CAPTCHA)
          if (captchaGuard) await captchaGuard.waitForCaptchaResolution();
          return landed;
        }
        emitter.emit('log', `[Session ${sessionNum}] Still on about:blank — forcing navigation via window.location...`);
        await forceNavigate(url);
        try { await page.waitForNavigation({ waitUntil: 'commit', timeout: 15000 }); } catch (_) {}
        if (attempt < maxAttempts) await csleep(2000);
      }
      const finalCheck = page.url();
      if (finalCheck && finalCheck !== 'about:blank') return finalCheck;
      throw new Error(`Page stuck on about:blank after ${maxAttempts} attempts — proxy may be blocking`);
    };

    // Prime the proxy tunnel with a lightweight warm-up request so the
    // proxy-auth handshake completes before the real navigation begins.
    if (proxyOptions && proxyOptions.proxy && proxyOptions.proxy.server) {
      emitter.emit('log', `[Session ${sessionNum}] Priming proxy tunnel with lightweight warm-up request...`);
      try {
        const warmupUrl = /https?:\/\//i.test(targetUrl)
          ? (new URL(targetUrl).origin + '/favicon.ico')
          : 'https://www.google.com/favicon.ico';
        await Promise.race([
          new Promise((_, rej) => setTimeout(() => rej(new Error('warmup-timeout')), 12000)),
          page.goto(warmupUrl, { waitUntil: 'commit', timeout: 10000 }).catch(() => {}),
        ]);
      } catch (_) {}
    }

    if (openWebSeed && webSeedUrl) {
      emitter.emit('log', `[Session ${sessionNum}] Visiting web seed: ${webSeedUrl}`);
      try {
        if (proxyOptions && proxyOptions.proxy && proxyOptions.proxy.server) {
          await navigateWithRetry(webSeedUrl, 'web seed', { finalWait: 'domcontentloaded' });
        } else {
          await page.goto(webSeedUrl, { waitUntil: 'networkidle', timeout: 60000 });
        }
        if (isStopped()) return false;
        await csleep(3000);
        if (isStopped()) return false;
        if (scrollingInternalPagesEnabled) {
          await smoothNaturalScroll(page, scrollDirection, scrollDownWaitMs, scrollUpWaitMs);
          if (isStopped()) return false;
        }
        await csleep(randomBetween(3000, 8000));
      } catch (_) {}
    }

    if (isStopped()) {
      return false;
    }

    if (engineObj && keyword) {
      const homepageUrl = getSearchHomepage(engineObj);
      emitter.emit('log', `[Session ${sessionNum}] Navigating to ${engineObj.name} homepage: ${homepageUrl}`);
      if (proxyOptions && proxyOptions.proxy && proxyOptions.proxy.server) {
        await navigateWithRetry(homepageUrl, `${engineObj.name} homepage`, { finalWait: 'domcontentloaded' });
        try { await page.waitForLoadState('networkidle', { timeout: 10000 }); } catch (_) {}
      } else {
        await page.goto(homepageUrl, { waitUntil: 'networkidle', timeout: 60000 });
        if (captchaGuard) await captchaGuard.waitForCaptchaResolution();
      }
      if (isStopped()) return false;
      // Dismiss any cookie/consent popup on the search engine homepage
      await PopupHandler.dismissAll(page, { label: `[Session ${sessionNum}]`, log: emitter });
      await csleep(randomBetween(800, 2000));
      if (isStopped()) return false;
      // Pause if the search engine presented a CAPTCHA on the homepage
      if (captchaGuard) await captchaGuard.waitForCaptchaResolution();
      if (isStopped()) return false;

      const possibleSelectors = [
        'input[name="q"]', 'textarea[name="q"]', 'input[name="p"]',
        'input[name="query"]', 'input[name="search"]', 'input[type="search"]',
        '#search', '.search-input'
      ];

      let searchInputSel = null;
      for (const sel of possibleSelectors) {
        const el = await page.$(sel);
        if (el) { searchInputSel = sel; break; }
      }
      if (!searchInputSel) {
        searchInputSel = 'input[type="text"], input[type="search"]';
      }

      emitter.emit('log', `[Session ${sessionNum}] Typing keyword naturally: "${keyword}"`);
      try {
        await page.click(searchInputSel, { delay: randomBetween(50, 150) });
        if (isStopped()) return false;
        await csleep(randomBetween(300, 800));
        if (isStopped()) return false;
        await humanType(page, searchInputSel, keyword);
        if (isStopped()) return false;
        await csleep(randomBetween(500, 1500));
        if (isStopped()) return false;
        await page.keyboard.press("Enter");
        await page.waitForLoadState("domcontentloaded", { timeout: 30000 });
        if (isStopped()) return false;
        await csleep(randomBetween(1000, 2000));
        if (isStopped()) return false;
        try {
          await page.waitForLoadState("networkidle", { timeout: 10000 });
        } catch (e) {
          emitter.emit('log', `[Session ${sessionNum}] Network idle timeout, proceeding anyway...`);
        }
        // Search results may surface a CAPTCHA — pause for resolution
        if (captchaGuard) await captchaGuard.waitForCaptchaResolution();
        if (isStopped()) return false;
      } catch (err) {
        emitter.emit('log', `[Session ${sessionNum}] Failed to interact with search input: ${err.message}, navigating directly`);
        // Check for CAPTCHA before fallback — the search input interaction
        // may have failed because a CAPTCHA appeared
        if (captchaGuard) await captchaGuard.waitForCaptchaResolution();
        if (isStopped()) return false;
        const searchUrl = getSearchUrl(engineObj, keyword, 1);
        if (proxyOptions && proxyOptions.proxy && proxyOptions.proxy.server) {
          await navigateWithRetry(searchUrl, 'search results', { finalWait: 'domcontentloaded' });
          try { await page.waitForLoadState('networkidle', { timeout: 10000 }); } catch (_) {}
        } else {
          await page.goto(searchUrl, { waitUntil: 'networkidle', timeout: 60000 });
          if (captchaGuard) await captchaGuard.waitForCaptchaResolution();
        }
        if (isStopped()) return false;
      }

      if (isStopped()) {
        return false;
      }

      // -----------------------------------------------------------------------
      // Multi-page search loop (always scans up to 30 pages)
      // -----------------------------------------------------------------------
      const maxSearchPages = 30;
      emitter.emit('log', `[Session ${sessionNum}] Will scan up to ${maxSearchPages} pages`);

      for (let pageNum = 1; pageNum <= maxSearchPages; pageNum++) {
        if (isStopped()) {
          break;
        }

        if (pageNum > 1) {
          if (isStopped()) break;
          // Wait for CAPTCHA before trying to click "Next" — a CAPTCHA may
          // have appeared on the current page
          if (captchaGuard) await captchaGuard.waitForCaptchaResolution();
          if (isStopped()) break;
          // Try clicking the "Next" button — more human-like than jumping by URL
          let nextClicked = false;
          try {
            nextClicked = await tryClickNextPage(page, engineObj);
          } catch (clickErr) {
            // Page may have navigated due to CAPTCHA — wait and retry
            emitter.emit('log', `[Session ${sessionNum}] Next button click failed — checking for CAPTCHA...`, 'warning');
            if (captchaGuard) await captchaGuard.waitForCaptchaResolution();
          }
          if (nextClicked) {
            emitter.emit('log', `[Session ${sessionNum}] Clicked "Next" → loading page ${pageNum}`);
            try {
              await page.waitForLoadState("domcontentloaded", { timeout: 30000 });
              if (isStopped()) break;
              await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
            } catch (_) {}
            // Wait for CAPTCHA after "Next" page loads
            if (captchaGuard) await captchaGuard.waitForCaptchaResolution();
          } else {
            // Fallback: navigate directly by constructing the paginated URL
            const searchUrl = getSearchUrl(engineObj, keyword, pageNum);
            emitter.emit('log', `[Session ${sessionNum}] No "Next" button — navigating directly to page ${pageNum}: ${searchUrl}`);
            try {
              if (proxyOptions && proxyOptions.proxy && proxyOptions.proxy.server) {
                await navigateWithRetry(searchUrl, `page ${pageNum}`, { finalWait: 'domcontentloaded' });
                try { await page.waitForLoadState('networkidle', { timeout: 10000 }); } catch (_) {}
              } else {
                await page.goto(searchUrl, { waitUntil: 'networkidle', timeout: 60000 });
                if (captchaGuard) await captchaGuard.waitForCaptchaResolution();
              }
            } catch (navErr) {
              emitter.emit('log', `[Session ${sessionNum}] Failed to navigate to page ${pageNum}: ${navErr.message}. Stopping search.`);
              break;
            }
          }
          if (isStopped()) break;
          await csleep(randomBetween(1000, 2500));
          // Paginated SERPs sometimes re-challenge — pause if needed
          if (captchaGuard) await captchaGuard.waitForCaptchaResolution();
          if (isStopped()) break;
        }

        if (isStopped()) break;

        emitter.emit('log', `[Session ${sessionNum}] Page ${pageNum} scanned`);

        // Scroll through the results naturally before looking for the target
        if (scrollingInternalPagesEnabled) {
          await smoothNaturalScroll(page, scrollDirection, scrollDownWaitMs, scrollUpWaitMs);
          if (isStopped()) break;
        }
        await csleep(randomBetween(1000, 3000));
        if (isStopped()) break;

        // Check for CAPTCHA right before scanning the page — Google may
        // redirect to a CAPTCHA page at any time, and if the page navigates
        // during the evaluate below, it will throw "Execution context
        // destroyed".  Wait for CAPTCHA first, then scan.
        if (captchaGuard) await captchaGuard.waitForCaptchaResolution();
        if (isStopped()) break;

        // Check whether any link on this page points to the target URL.
        // Wrapped in a retry loop because the execution context can be
        // destroyed if the page navigates (e.g., CAPTCHA redirect) between
        // the CAPTCHA check above and this evaluate call.
        let links = { found: false };
        for (let evalAttempt = 0; evalAttempt < 3; evalAttempt++) {
          if (isStopped()) break;
          try {
            // Robust target detection.
            //
            // Modern Google SERPs wrap every organic result in an encrypted
            // /goto?url=<opaque-token> redirect, so the destination URL is NOT
            // present in the anchor's href at all. Google does, however, render
            // the destination as the "cite" text inside the anchor's
            // textContent (e.g. "GitHubWikipediahttps://en.wikipedia.org › wiki › GitHub").
            //
            // We therefore gather candidate destination URLs from BOTH:
            //   1. The anchor's href — unwrapping legacy /url?q=... redirects
            //      and using direct http(s) hrefs (Bing/Yahoo/DuckDuckGo still
            //      expose the real URL this way, as do some Google results).
            //   2. URL-like substrings inside the anchor's textContent —
            //      https://..., www...., and the "domain.tld › path" cite
            //      breadcrumb that Google shows.
            //
            // Each candidate is normalised (strip protocol, www., trailing
            // slash, query/fragment) and scored against the target (exact path
            // > path prefix > hostname only). The best-scoring VISIBLE anchor
            // is marked with data-tp-target="1" so the caller can click it
            // reliably, and the unwrapped real URL is returned for fallback
            // navigation.
            links = await page.evaluate(({ target }) => {
              function normalize(rawUrl) {
                try {
                  const u = new URL(rawUrl);
                  const host = u.hostname.toLowerCase().replace(/^www\./, '');
                  let path = u.pathname.toLowerCase().replace(/\/+$/, '');
                  if (path === '') path = '/';
                  return { host, path };
                } catch { return null; }
              }
              function unwrap(href) {
                try {
                  const u = new URL(href, location.href);
                  if (u.pathname === '/url' || u.pathname === '/imgres') {
                    const q = u.searchParams.get('q') || u.searchParams.get('url') || u.searchParams.get('imgurl');
                    if (q) return q;
                  }
                  const alt = u.searchParams.get('u') || u.searchParams.get('rurl');
                  if (alt) return alt;
                } catch {}
                return href;
              }
              function score(cand, tgt) {
                if (!cand || !tgt) return 0;
                if (cand.host !== tgt.host) return 0;
                if (cand.path === tgt.path) return 3;
                if (tgt.path === '/' || cand.path === '/') return 2;
                if (cand.path.startsWith(tgt.path) || tgt.path.startsWith(cand.path)) return 2;
                return 1;
              }
              // Pull every URL-like substring out of a block of text.
              function extractUrlsFromText(text) {
                const out = new Set();
                if (!text) return [];
                let m;
                const httpRe = /https?:\/\/[^\s'"<>]+/gi;
                while ((m = httpRe.exec(text)) !== null) out.add(m[0]);
                const wwwRe = /www\.[a-z0-9.-]+\.[a-z]{2,}(?:\/[^\s'"<>]*)?/gi;
                while ((m = wwwRe.exec(text)) !== null) out.add('https://' + m[0]);
                // Google "cite" breadcrumb: "en.wikipedia.org › wiki › GitHub"
                const crumbRe = /\b([a-z0-9-]+(?:\.[a-z0-9-]+)+\.[a-z]{2,})(?:\s*›\s*[^\s]+)*/gi;
                while ((m = crumbRe.exec(text)) !== null) out.add('https://' + m[1]);
                return Array.from(out);
              }
              function isVisible(el) {
                if (!el) return false;
                if (el.offsetWidth || el.offsetHeight) return true;
                const r = el.getBoundingClientRect();
                return !!(r.width && r.height);
              }

              const targetNorm = normalize(target);
              if (!targetNorm) return { found: false };

              const anchors = Array.from(document.querySelectorAll('a[href]'));
              let bestAnchor = null;
              let bestScore = 0;
              let bestVisible = false;
              let bestInfo = null;

              for (const a of anchors) {
                const rawHref = a.href || '';
                const text = a.textContent || '';
                // Gather candidate destination URLs from href + textContent.
                const candidates = [];
                if (rawHref) {
                  const unwrapped = unwrap(rawHref);
                  if (/^https?:\/\//i.test(unwrapped)) candidates.push(unwrapped);
                }
                for (const u of extractUrlsFromText(text)) candidates.push(u);

                let anchorBestScore = 0;
                let anchorBestUrl = rawHref;
                for (const cand of candidates) {
                  const cn = normalize(cand);
                  const s = score(cn, targetNorm);
                  if (s > anchorBestScore) {
                    anchorBestScore = s;
                    anchorBestUrl = cand;
                  }
                }
                if (anchorBestScore === 0) continue;

                const vis = isVisible(a);
                // Prefer a higher score; on ties prefer a visible anchor so the
                // click actually lands on a clickable element.
                const better = anchorBestScore > bestScore
                  || (anchorBestScore === bestScore && vis && !bestVisible);
                if (better) {
                  bestScore = anchorBestScore;
                  bestVisible = vis;
                  bestAnchor = a;
                  bestInfo = {
                    href: rawHref,
                    realUrl: anchorBestUrl,
                    text: text.trim().slice(0, 80),
                    score: anchorBestScore,
                    visible: vis,
                  };
                }
              }

              if (bestAnchor && bestScore >= 1) {
                // Mark the anchor so the caller can click it robustly (avoids
                // the fragile a[href="..."] attribute-vs-property mismatch).
                bestAnchor.setAttribute('data-tp-target', '1');
                bestAnchor.removeAttribute('target'); // navigate in same tab
                try { bestAnchor.scrollIntoView({ block: 'center', behavior: 'instant' }); } catch {}
                return { found: true, ...bestInfo };
              }
              return { found: false };
            }, { target: targetUrl });
            break; // success — exit retry loop
          } catch (evalErr) {
            // Execution context destroyed — likely a CAPTCHA redirect.
            // Wait for CAPTCHA to be solved, then retry.
            emitter.emit('log', `[Session ${sessionNum}] Page changed during scan (attempt ${evalAttempt + 1}) — checking for CAPTCHA...`, 'warning');
            if (captchaGuard) await captchaGuard.waitForCaptchaResolution();
            if (isStopped()) break;
            await csleep(2000);
          }
        }

        if (links.found) {
          if (isStopped()) break;
          emitter.emit('log', `[Session ${sessionNum}] [FOUND] Target URL found on page ${pageNum} (score ${links.score}): ${links.realUrl}`);

          // The real destination (already unwrapped from any Google /url?q= /
          // /goto redirect by the detection step above).
          const targetRealUrl = links.realUrl || links.href;
          const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
          const targetHost = hostOf(targetRealUrl);

          // 1) Click the marked result link like a real visitor.
          //
          // We deliberately do NOT block on page.waitForNavigation() here.
          // Google frequently intercepts result clicks (JS redirect, new tab,
          // consent interstitial) and in those cases a long waitForNavigation
          // would sit for a full minute right after "FOUND" — which looks
          // exactly like "it found the site but never clicked it". Instead we
          // click with a short timeout and then poll the URL to confirm we
          // actually left the SERP and reached the target.
          try {
            await page.click('[data-tp-target="1"]', { delay: randomBetween(50, 200), timeout: 8000, noWaitAfter: true });
          } catch (clickErr) {
            try {
              // Element may be covered by a cookie bar / consent overlay —
              // retry once ignoring hit-testing so the click still lands.
              await page.click('[data-tp-target="1"]', { delay: randomBetween(50, 200), timeout: 5000, force: true, noWaitAfter: true });
            } catch (forceErr) {
              emitter.emit('log', `[Session ${sessionNum}] Result click failed: ${forceErr.message}`);
            }
          }

          // Poll briefly for the navigation to settle (covers direct clicks
          // and Google's JS/meta redirects). Most real-world SERP navigations
          // complete well within this window.
          let landed = false;
          for (let i = 0; i < 10 && !landed && !isStopped(); i++) {
            await csleep(1000);
            landed = hostOf(page.url()) === targetHost;
          }

          // 2) If the click didn't land us on the target (intercepted, opened
          //    a new tab, showed a consent interstitial, etc.), navigate there
          //    directly — guaranteed to reach the site.
          if (!landed) {
            emitter.emit('log', `[Session ${sessionNum}] Click did not reach target — navigating directly to ${targetRealUrl}`);
            try {
              if (proxyOptions && proxyOptions.proxy && proxyOptions.proxy.server) {
                await navigateWithRetry(targetRealUrl, 'target URL', { finalWait: 'domcontentloaded' });
                try { await page.waitForLoadState('networkidle', { timeout: 10000 }); } catch (_) {}
              } else {
                await page.goto(targetRealUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
                if (captchaGuard) await captchaGuard.waitForCaptchaResolution();
              }
              landed = true;
            } catch (err2) {
              emitter.emit('log', `[Session ${sessionNum}] Direct navigation also failed: ${err2.message}`);
            }
          }

          if (isStopped()) break;

          // 3) Once on the target, behave like a real visitor.
          if (landed) {
            if (captchaGuard) await captchaGuard.waitForCaptchaResolution();
            await PopupHandler.dismissAll(page, { label: `[Session ${sessionNum}]`, log: emitter });

            // Random clicks anywhere on the target site (ads included).
            randomClicker = startRandomClicker(page, {
              config: config.randomClicks,
              sessionId: `Session ${sessionNum}`,
              onLog: (msg, type) => emitter.emit('log', msg, type),
              isStopped,
            });

            if (scrollingInternalPagesEnabled) {
              await smoothNaturalScroll(page, scrollDirection, scrollDownWaitMs, scrollUpWaitMs);
              if (isStopped()) break;
            }
            await csleep((visitTimeMs || 20000) + randomBetween(0, 5000));
            if (isStopped()) break;
            if (scrollingInternalPagesEnabled) {
              if (randomClicker) await randomClicker.pause();
              await visitInternalPages(page, config, emitter, sessionNum, captchaGuard);
              if (randomClicker) randomClicker.resume();
              if (isStopped()) break;
            }
            if (randomClicker) randomClicker.stop();
            // Do not count a visit that ended on Chrome's error page.
            const endErr = await detectChromeErrorPage(page);
            if (endErr) {
              emitter.emit(
                'log',
                `[Session ${sessionNum}] Page ended on an error page (${endErr}) - not counting this visit`,
                'WARN'
              );
              proxyFailRef.failed = true;
              proxyFailRef.code = endErr;
              throw new Error('__PROXY_FAILED__:' + endErr);
            } else {
              const endUrl = page.url() || '';
              if (!endUrl || endUrl === 'about:blank' || endUrl.startsWith('chrome-error://')) {
                throw new Error('__PAGE_NOT_LOADED__');
              }
              found = true;
            }
          }

          // Whether click succeeded or failed, stop paging — we found the target
          break;

        }
      }

      if (!found) {
        emitter.emit('log', `[Session ${sessionNum}] [NOT FOUND] Target URL not found in first 30 pages. Closing browser.`);
      }
    }

    if (isStopped()) return false;
    await csleep(randomBetween(2000, 5000));
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
    try { await browser.close(); } catch (_) {}
    emitter.emit('log', `[Session ${sessionNum}] Closed browser`);
  }
  return proxyFailedResult || found;
}

async function main(config, emitter = new EventEmitter()) {

  const { sessions, threads, searchEngines, mixedModeEnabled, distributionStrategy } = config;

  // Register campaign with StopManager — this id flows to every session/browser
  const campaignId = stopManager.startCampaign();

  let isStopped = false;
  let isPaused = false;
  let nextSessionIndex = 0;
  let engineUsageCount = {};
  let sequentialIndex = 0;
  let activeBrowsers = 0;
  let openBrowsers = [];

  const tasks = [];
  for (let i = 0; i < sessions; i++) {
    tasks.push({ id: i + 1, status: 'pending' });
  }

  searchEngines.forEach(engine => { engineUsageCount[engine.id] = 0; });

  function assignEngine(sessionIndex) {
    if (!mixedModeEnabled || searchEngines.length === 1) {
      return searchEngines[0];
    }
    switch (distributionStrategy) {
      case 'sequential': {
        const engine = searchEngines[sequentialIndex % searchEngines.length];
        sequentialIndex++;
        return engine;
      }
      case 'equal': {
        let leastUsedId = searchEngines[0].id;
        let minCount = engineUsageCount[leastUsedId];
        searchEngines.forEach(e => {
          if (engineUsageCount[e.id] < minCount) { leastUsedId = e.id; minCount = engineUsageCount[e.id]; }
        });
        const leastUsedEngine = searchEngines.find(e => e.id === leastUsedId);
        engineUsageCount[leastUsedId]++;
        return leastUsedEngine;
      }
      case 'smart': {
        const sorted = [...searchEngines].sort((a, b) => engineUsageCount[a.id] - engineUsageCount[b.id]);
        const candidates = sorted.filter(e => engineUsageCount[e.id] === engineUsageCount[sorted[0].id]);
        const chosen = pickRandom(candidates);
        engineUsageCount[chosen.id]++;
        return chosen;
      }
      case 'random':
      default:
        return pickRandom(searchEngines);
    }
  }

  function emitStatsUpdate() {
    const total = tasks.length;
    const completed = tasks.filter(t => t.status === 'completed').length;
    const stats = {
      total, completed,
      running: tasks.filter(t => t.status === 'running').length,
      pending: tasks.filter(t => t.status === 'pending').length,
      failed: tasks.filter(t => t.status === 'failed').length,
      stopped: tasks.filter(t => t.status === 'stopped').length,
      activeBrowsers,
      remaining: tasks.filter(t => t.status === 'pending' || t.status === 'running').length,
      progress: Math.round((completed / total) * 100)
    };
    emitter.emit('stats', stats);
  }

  const trackedRunSearchSession = async (config, emitter, sessionNum, isStoppedRef) => {
    let browser = null;
    try {
      const result = await runSearchSession(config, emitter, sessionNum, (b) => {
        browser = b;
        openBrowsers.push(b);
      }, isStoppedRef, campaignId);
      return result;
    } finally {
      if (browser) {
        const index = openBrowsers.indexOf(browser);
        if (index > -1) openBrowsers.splice(index, 1);
      }
    }
  };

  const processSession = async () => {
    while (nextSessionIndex < sessions && !isStopped) {
      // Cancellable pause wait — aborts instantly on Stop
      while (isPaused && !isStopped) { await stopManager.sleep(campaignId, 100); }
      // Final stop check right before claiming a session — prevents new
      // browsers/threads from opening after the Stop button is clicked.
      if (isStopped) break;

      const sessionIndex = nextSessionIndex++;
      const assignedEngine = assignEngine(sessionIndex);
      const sessionConfig = { ...config, assignedEngine };

      tasks[sessionIndex].status = 'running';
      activeBrowsers++;
      emitStatsUpdate();

      try {
        emitter.emit('log', `[Session ${sessionIndex + 1}] Starting...`);
        const result = await runWithProxyRetry({
          config: sessionConfig,
          runOnce: (cfg) => trackedRunSearchSession(cfg, emitter, sessionIndex + 1, () => isStopped),
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
      }
      catch (err) { 
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
  emitter.emit('log', `Starting organic search with ${threads} active browsers...`);
  emitStatsUpdate();

  // Run the campaign loop in the background and expose a done promise on the
  // emitter so callers can await full shutdown (e.g. before starting a new
  // campaign with a different device type).  The emitter itself is returned
  // immediately so Stop/Pause/Resume can control the live campaign.
  emitter._donePromise = (async () => {
    try {
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
    } catch (err) {
      emitter.emit('log', `Fatal campaign error: ${(err && err.message) || err}`);
    } finally {
      stopManager.endCampaign(campaignId);
    }
  })();

  return emitter;
}

module.exports = {
  startOrganicSearch: (config) => {
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
  getSearchUrl,
  runSearchSession
};