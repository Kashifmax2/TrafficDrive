const { launchBrowser: _launchBrowser } = require('./browser-launcher.js');
const { runInternalLinkNavigation, readArticlesOnPage, waitForFullPageLoad, dismissConsentPopup } = require('./Internal link navigator.js');
const PopupHandler = require('./PopupHandler.js');
const EventEmitter = require('events');
const { installCaptchaGuard } = require('./CaptchaGuard.js');
const { installPrivacyGuard, privacyContextOptions } = require('./PrivacyGuard.js');
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
const { chooseViewport, chooseUserAgent, describeProfile, resolveSessionDevice, uaPlatform, uaBrands, uaChPlatform, physicalScreen } = require('./SessionProfile.js');
const { visitInternalLinks: visitLinks } = require('./LinkClicker.js');
const { startRandomClicker } = require('./RandomClicker.js');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

const DESKTOP_USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
];

const MOBILE_USER_AGENTS = [
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
];

const TABLET_USER_AGENTS = [
  'Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 13; SM-X816B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
];

async function humanScroll(page, direction, waitTimeMs) {
  try {
    // page.evaluate has no timeout and can hang forever during navigation.
    await Promise.race([
      page.evaluate((dir) => {
      const body = document.body;
      const html = document.documentElement;
      const documentHeight = Math.max(
        body.scrollHeight, body.offsetHeight,
        html.clientHeight, html.scrollHeight, html.offsetHeight
      );
      const viewportHeight = window.innerHeight;
      const startY = window.scrollY;
      let targetY;

      if (dir === 'down') {
        const scrollAmount = documentHeight * (0.6 + Math.random() * 0.2);
        targetY = Math.min(startY + scrollAmount, documentHeight - viewportHeight);
      } else {
        targetY = Math.max(0, startY - (startY * (0.4 + Math.random() * 0.2)));
      }

      // Native smooth scroll (requestAnimationFrame is paused in background
      // tabs and a JS animation loop could hang for 10+ seconds).
      window.scrollTo({ top: targetY, behavior: 'smooth' });
      }, direction).catch(() => {}),
      sleep(8000),
    ]);

    await sleep(waitTimeMs || randomBetween(500, 2000));
  } catch (err) {
    console.warn('Scroll error:', err);
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

  if (!internalPagesCount || internalPagesCount <= 0) return;

  try {
    const internalLinks = await page.evaluate((target) => {
      const anchors = Array.from(document.querySelectorAll('a[href]'));
      const baseUrl = new URL(target).origin;
      return anchors
        .map(a => a.href)
        .filter(href => {
          try {
            const url = new URL(href);
            if (url.origin !== baseUrl) return false;
            if (href.includes('#')) return false;
            // Skip ad / affiliate / tracker redirect links.
            if (/(^|[?&])(ad|ads|adid|ad_id|aff|affid|aff_id|zoneid|zone_id|gclid|fbclid|msclkid|popunder)=/i.test(url.search)) return false;
            if (/\/(adclick|adserver|popunder|adservice|adsense|sponsor)(\/|\?|$)/i.test(url.pathname)) return false;
            return true;
          } catch { return false; }
        })
        .filter((href, index, arr) => arr.indexOf(href) === index);
    }, targetUrl);

    if (internalLinks.length === 0) {
      emitter.emit('log', `[Session ${sessionNum}] No internal links found`);
      return;
    }

    await visitLinks(page, {
      count: internalPagesCount,
      origin: (() => {
        try {
          return new URL(page.url() || targetUrl).origin;
        } catch (_) {
          return new URL(targetUrl).origin;
        }
      })(),
      onLog: (m) => emitter.emit('log', `[Session ${sessionNum}] ${m}`),
      isStopped: () => false,
      gotoTimeoutMs: 120000,
      ensureCaptcha: captchaGuard ? () => captchaGuard.waitForCaptchaResolution() : null,
      onPage: async () => {
        if (captchaGuard) await captchaGuard.waitForCaptchaResolution();
        try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch (_) {}
        await sleep(2000);
        await smoothNaturalScroll(page, internalScrollMode, scrollDownWaitMs, scrollUpWaitMs);
        await sleep(internalPageWaitMs || 5000);
      },
    });
  } catch (err) {
    emitter.emit('log', `[WARN] Internal pages visit failed: ${err.message}`);
  }
}

async function typeWithDelay(page, selector, text, delayMs = 80) {
  try {
    await page.click(selector).catch(() => {});
    await page.focus(selector).catch(() => {});
    for (const char of text) {
      await page.keyboard.type(char, { delay: delayMs + Math.random() * 40 });
    }
  } catch (err) {
    console.warn('Typing error:', err);
  }
}

/**
 * Normalize a business name for fuzzy matching: lowercase, collapse whitespace,
 * strip common suffixes/punctuation that Google Maps may add or omit.
 */
function normalizeBusinessName(name) {
  if (!name) return '';
  return name
    .toLowerCase()
    .replace(/[.,&'""'']/g, ' ')
    .replace(/\b(inc|llc|ltd|co|company|corp|corporation|the)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extract a hostname from a URL string for comparison purposes.
 */
function urlHostname(urlStr) {
  try {
    const u = new URL(urlStr);
    // Strip leading "www." for comparison
    return u.hostname.replace(/^www\./, '').toLowerCase();
  } catch (_) {
    return '';
  }
}

/**
 * Find and click the correct business in the Google Maps search results.
 *
 * This function scrolls the results feed incrementally (Google Maps lazily
 * loads more results as you scroll) and checks each result card against the
 * provided business name and/or website URL. It uses business-specific
 * selectors (NOT generic feed-child divs which also match filter chips and
 * ads) to avoid clicking on non-result elements.
 *
 * @param {import('playwright').Page} page
 * @param {string} businessName - The business name to match (may be partial)
 * @param {string} businessUrl  - The business website URL to match (optional)
 * @param {Function} onLog      - Log callback
 * @returns {Promise<boolean>} true if a business result was found and clicked
 */
async function findAndClickBusiness(page, businessName, businessUrl, onLog) {
  try {
    onLog(`[Session] Looking for business: "${businessName}" (url: ${businessUrl || 'n/a'}) in results...`);
    await sleep(3000);

    const targetName = normalizeBusinessName(businessName);
    const targetHost = urlHostname(businessUrl);

    // ── Selectors ──────────────────────────────────────────────────────────
    // We deliberately prefer STABLE, semantic selectors over Google's
    // obfuscated class names (e.g. `a.hfpxzc`, `div.Nv2PK`). Those obfuscated
    // classes change with every Google Maps DOM refresh and are the most
    // common reason the bot stops finding results. The obfuscated selectors
    // are kept only as last-resort extras.
    //
    // Place-link anchors: each has aria-label = business name and an href
    // containing "/maps/place/". These are the most reliable clickable result
    // elements.
    const resultLinkSelectors = [
      'a[aria-label][href*="/maps/place/"]',
      'a[aria-label][href*="/maps/dir/"]',
      '[role="feed"] a[href*="/maps/place/"]',
      'a.hfpxzc', // legacy obfuscated class — extra fallback only
    ];
    // Card containers: used when no place-link anchor is found. We then look
    // for a place link inside each card, falling back to clicking the card.
    const resultCardSelectors = [
      'div[role="article"]',
      'div.Nv2PK',
      '[role="feed"] > div',
    ];

    // Scroll the results feed up to maxScrolls times, checking for the target
    // business after each scroll. Google Maps loads ~6 results initially and
    // appends more as the feed is scrolled.
    const maxScrolls = 15;
    const seenHrefs = new Set();
    let scrollAttempt = 0;
    let firstResultClicked = false;

    for (scrollAttempt = 0; scrollAttempt <= maxScrolls; scrollAttempt++) {
      if (scrollAttempt > 0) {
        onLog(`[Session] Scrolling results feed (attempt ${scrollAttempt}/${maxScrolls})...`);
        const scrolled = await page.evaluate(() => {
          const feed = document.querySelector('div[role="feed"]');
          if (!feed) return false;
          const before = feed.scrollTop;
          feed.scrollBy(0, feed.clientHeight * 0.8);
          return feed.scrollTop !== before;
        }).catch(() => false);

        // Wait for newly scrolled results to render / lazy-load
        await sleep(2500);
        if (!scrolled && scrollAttempt > 2) {
          onLog(`[Session] Feed fully scrolled, no more results loading.`);
          break;
        }
      }

      // ── Collect result element handles ──────────────────────────────────
      // We grab ElementHandles (NOT just data) so we can click the exact
      // element later without reconstructing fragile CSS attribute selectors
      // from its aria-label (which breaks on quotes / special characters).
      let linkHandles = [];
      for (const sel of resultLinkSelectors) {
        const handles = await page.$$(sel).catch(() => []);
        if (handles.length > 0) {
          linkHandles = handles;
          onLog(`[Session] Found ${handles.length} result links via "${sel}"`);
          break;
        }
      }

      // If no place-link anchors, try card containers and resolve each card
      // to its inner place link (or the card itself). This runs on EVERY
      // scroll attempt (not just the first) so newly lazy-loaded cards are
      // always considered.
      if (linkHandles.length === 0) {
        for (const sel of resultCardSelectors) {
          const cards = await page.$$(sel).catch(() => []);
          if (cards.length > 0) {
            onLog(`[Session] Found ${cards.length} result cards via "${sel}"`);
            for (const card of cards) {
              const innerLink = await card.$('a[href*="/maps/place/"], a.hfpxzc').catch(() => null);
              linkHandles.push(innerLink || card);
            }
            break;
          }
        }
      }

      if (linkHandles.length === 0) {
        onLog(`[Session] No result elements found on scroll attempt ${scrollAttempt}.`);
        continue;
      }

      // ── Inspect & match each handle ──────────────────────────────────────
      for (const handle of linkHandles) {
        let ariaLabel = '';
        let text = '';
        let href = '';
        try {
          ariaLabel = (await handle.getAttribute('aria-label')) || '';
          text = ((await handle.textContent()) || '').trim();
          href = (await handle.getAttribute('href')) || '';
        } catch (_) { continue; }

        // De-duplicate by href (only when we have a real place href). Card
        // handles without an href are always inspected.
        if (href && seenHrefs.has(href)) continue;
        if (href) seenHrefs.add(href);

        const normLabel = normalizeBusinessName(ariaLabel);
        const normText = normalizeBusinessName(text);

        // Match by business name — use word-level matching for better accuracy
        // Checks if any significant word from target appears in the result
        let nameMatch = false;
        if (targetName) {
          // Direct substring match (both directions for partial names)
          if (normLabel.includes(targetName) || targetName.includes(normLabel) ||
              normText.includes(targetName) || targetName.includes(normText)) {
            nameMatch = true;
          } else {
            // Word-level match: check if key words from target name appear in result
            const targetWords = targetName.split(' ').filter(w => w.length > 2);
            const resultText = normLabel + ' ' + normText;
            if (targetWords.length > 0) {
              const matchedWords = targetWords.filter(w => resultText.includes(w));
              // If at least 60% of significant words match, consider it a match
              if (matchedWords.length >= Math.ceil(targetWords.length * 0.6)) {
                nameMatch = true;
              }
            }
          }
        }

        // Match by website URL hostname. Google Maps result cards usually do
        // NOT expose the website URL (only the detail panel does), so this is
        // a weak/secondary signal — but some layouts do render the domain in
        // the card, so we still check the surrounding card HTML.
        let urlMatch = false;
        if (targetHost) {
          try {
            const container = await handle.evaluateHandle(el =>
              el.closest('[role="article"], .Nv2PK, [role="feed"] > div') || el.parentElement || el
            );
            const html = await container.evaluate(el => el.innerHTML || '').catch(() => '');
            if (html && html.includes(targetHost)) {
              urlMatch = true;
            }
          } catch (_) {}
        }

        if (nameMatch || urlMatch) {
          const display = ariaLabel || text || href;
          onLog(`[Session] Found target business: "${display}" (match: ${nameMatch ? 'name' : ''}${urlMatch ? ' +url' : ''})`);
          // Click the exact handle we matched — no CSS reconstruction.
          await handle.click().catch((err) => onLog(`[WARN] Error clicking business: ${err.message}`));
          onLog(`[Session] Clicked business result: ${display}`);
          return true;
        }
      }

      onLog(`[Session] Checked ${seenHrefs.size} results so far, target not found yet.`);
    }

    // ── FALLBACK: If no match found after all scrolls, click the first result ──
    // This ensures the flow continues: search → click result → click website
    if (!firstResultClicked) {
      onLog(`[WARN] Business "${businessName}" not found after scrolling through ${seenHrefs.size} results. Clicking first result as fallback...`);
      for (const sel of [...resultLinkSelectors, ...resultCardSelectors]) {
        const firstResult = await page.$(sel).catch(() => null);
        if (firstResult) {
          await firstResult.click().catch((err) => onLog(`[WARN] Error clicking first result: ${err.message}`));
          onLog(`[Session] Clicked first result (fallback via "${sel}")`);
          firstResultClicked = true;
          return true;
        }
      }
      // Last resort: try clicking via evaluate
      const clickedSel = await page.evaluate(() => {
        const linkSels = [
          'a[aria-label][href*="/maps/place/"]',
          '[role="feed"] a[href*="/maps/place/"]',
          'a.hfpxzc',
        ];
        for (const s of linkSels) {
          const el = document.querySelector(s);
          if (el) { el.click(); return s; }
        }
        const cardSels = ['div[role="article"]', 'div.Nv2PK', '[role="feed"] > div'];
        for (const s of cardSels) {
          const el = document.querySelector(s);
          if (el) { el.click(); return s; }
        }
        return null;
      }).catch(() => null);
      if (clickedSel) {
        onLog(`[Session] Clicked first result via evaluate (fallback: "${clickedSel}")`);
        firstResultClicked = true;
        return true;
      }
    }

    onLog(`[WARN] No results found to click on Google Maps.`);
    return false;
  } catch (e) {
    onLog(`[ERROR] Error finding business: ${e.message}`);
    console.error(e);
    return false;
  }
}

async function clickWebsiteLink(page, businessUrl, onLog, retries, delay) {
  onLog(`[Session] Looking for website link (will try up to ${retries} times)...`);

  // Selectors ordered by reliability for current Google Maps DOM (2024-2025).
  // a[data-item-id="authority"] is the canonical website button — it has
  // data-item-id="authority", aria-label="Website: <domain>", and an href
  // pointing to the business website. This is the most stable selector.
  const websiteSelectors = [
    'a[data-item-id="authority"]',
    'a[aria-label*="Website" i]',
    'a[data-tooltip*="Website" i]',
    'button[aria-label*="Website" i]',
    'a[jsaction*="authority"]',
    'a[href*="authority"]',
    // Newer Google Maps DOM selectors
    'a[data-item-id^="authority"]',
    'button[data-item-id^="authority"]',
    'a[aria-label*="Site" i]',
    'a[aria-label*="site web" i]',
    // Generic link selectors within the info panel
    '.Io6YTe a[href]',
    'a.CsEnBe[href^="http"]',
    // Broader fallbacks — any external link in the detail panel
    '[data-item-id] a[href^="http"]',
    'div[role="dialog"] a[href^="http"]',
    'div[class*="info"] a[href^="http"]',
  ];

  for (let i = 0; i < retries; i++) {
    try {
      onLog(`[Session] Website link click attempt ${i+1}/${retries}`);

      for (const selector of websiteSelectors) {
        try {
          const links = await page.$$(selector);
          for (const link of links) {
            const visible = await link.isVisible().catch(() => false);
            if (!visible) continue;
            const href = await link.evaluate(el => el.href).catch(() => '');
            // Only click links that point to an external (non-Google) website
            if (href && href.startsWith('http') && !href.includes('google.com') && !href.includes('google.')) {
              await link.click();
              onLog(`[Session] Clicked website link (${selector}): ${href}`);
              return true;
            }
          }
        } catch (e) {
          console.warn('Link click error:', e);
        }
      }

      // Broader fallback: scan all links in the page for external non-Google URLs
      if (i >= 1) {
        const externalLink = await page.evaluate(() => {
          const allLinks = Array.from(document.querySelectorAll('a[href^="http"]'));
          // Filter out Google domains
          const external = allLinks.filter(a => {
            const href = a.href || '';
            return href && !href.includes('google.com') && !href.includes('google.') &&
                   !href.includes('gstatic') && !href.includes('googleapis') &&
                   !href.includes('gppd') && !href.includes('maps/app');
          });
          // Prefer links that look like website buttons (have website-related attributes)
          const websiteLink = external.find(a => {
            const label = (a.getAttribute('aria-label') || '').toLowerCase();
            const tooltip = (a.getAttribute('data-tooltip') || '').toLowerCase();
            const itemId = (a.getAttribute('data-item-id') || '').toLowerCase();
            return label.includes('website') || label.includes('site') ||
                   tooltip.includes('website') || itemId.includes('authority');
          });
          if (websiteLink) { websiteLink.click(); return websiteLink.href; }
          // Otherwise click the first external link that's not a Google service
          if (external.length > 0) { external[0].click(); return external[0].href; }
          return null;
        }).catch(() => null);
        if (externalLink) {
          onLog(`[Session] Clicked website link via broad scan: ${externalLink}`);
          return true;
        }
      }

      onLog(`[WARN] Website link click attempt ${i + 1} failed, retrying in ${delay}ms...`);
      await sleep(delay);
    } catch (e) {
      onLog(`[WARN] Website link click attempt ${i + 1} error: ${e.message}`);
      await sleep(delay);
    }
  }

  return false;
}

async function runMapsSession(config, emitter, sessionNum, browserTracker, isStoppedRef) {
  const {
    businessName,
    keyword,
    targetUrl,
    headless,
    proxy,
    device,
    userAgents,
    uaAutoRotate,
    viewportWidth,
    viewportHeight,
    autoRotateResolutions,
    scrollingInternalPagesEnabled,
    scrollDirection,
    scrollDownWaitMs,
    scrollUpWaitMs,
    internalPagesCount,
    internalScrollMode,
    internalPageWaitMs,
    visitTimeMs,
    mapsLoadWaitMs = 8000,
    searchResultWaitMs = 8000,
    websiteLoadWaitMs = 5000,
    typingDelayMs = 80,
    stepRetryAttempts = 5,
    stepRetryDelayMs = 5000,
    proxies: proxiesData
  } = config;

  // Check stop immediately
  if (isStoppedRef && isStoppedRef()) {
    return false;
  }

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
  if (isStoppedRef && isStoppedRef()) {
    return false;
  }

  let browser = null;
  let context = null;
  let popupMonitorStop = null;
  // Set by the error-page watcher so this session can abort immediately and
  // the caller can retry with a different proxy.
  let proxyFailRef = { failed: false, code: '' };
  let proxyFailedResult = null;
  // Random auto-clicking runs in the background for the whole visit window.
  let randomClicker = null;
  try {
    const launchArgs = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars'
    ];

    // Launch Playwright's Chromium browser (proxy attached at newContext()).
    browser = await _launchBrowser({
      headless: headless,
      customBrowserPath: undefined,
      args: launchArgs,
      onLog: (msg) => emitter.emit('log', msg),
      sessionId: `Session ${sessionNum}`,
    });
    emitter.emit('log', `[Session ${sessionNum}] Browser launched successfully`);
    
    if (browserTracker) {
      browserTracker(browser);
    }

    // Check stop after browser launch
    if (isStoppedRef && isStoppedRef()) {
      return false;
    }

    // Use the same UA + resolution rules as Direct/Organic/Social. Previously
    // Gmaps always picked a random device UA and ignored the selected UA list
    // and auto-rotate resolutions.
    const ua = chooseUserAgent(userAgents, !!uaAutoRotate, device, {
      desktop: DESKTOP_USER_AGENTS,
      mobile: MOBILE_USER_AGENTS,
      tablet: TABLET_USER_AGENTS,
    });
    const effectiveDevice = resolveSessionDevice(device, ua);
    const deviceChanged = effectiveDevice !== device;
    const viewport = chooseViewport(effectiveDevice, deviceChanged ? true : autoRotateResolutions, viewportWidth, viewportHeight, sessionNum);
    emitter.emit('log', `[Session ${sessionNum}] ${describeProfile(ua, viewport, effectiveDevice)}`);
    if (deviceChanged) {
      emitter.emit(
        'log',
        `[Session ${sessionNum}] Device Setting was "${device}" but the user agent is ${effectiveDevice} - ${effectiveDevice} emulation (Sec-CH-UA-Mobile) applied so trackers see the correct device. Select Mobile + mobile user agents for phone traffic.`,
        'WARN'
      );
    }

    const privacyOptions = privacyContextOptions(config.privacyFeatures || []);
    const contextOptions = {
      viewport: { width: viewport.width, height: viewport.height },
      userAgent: ua,
      isMobile: !!viewport.isMobile,
      hasTouch: !!viewport.hasTouch,
      deviceScaleFactor: viewport.deviceScaleFactor || 1,
    };
    if (privacyOptions.extraHTTPHeaders) contextOptions.extraHTTPHeaders = privacyOptions.extraHTTPHeaders;
    if (privacyOptions.locale) contextOptions.locale = privacyOptions.locale;
    if (viewport.hasTouch) {
      const screenSize = physicalScreen(viewport);
      if (screenSize) contextOptions.screen = screenSize;
    }
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

    // CAPTCHA guard — Google Maps search flows can surface reCAPTCHA
    // challenges; the guard pauses this session until the bundled extension
    // (or the user) resolves them.
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
      try { await page.route('**/*', route => route.fallback()); } catch (_) {}
    }
    
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
      viewport,
      hasTouch: !!viewport.hasTouch,
      trafficReferrer: trafficSourceResult && trafficSourceResult.applied ? trafficSourceResult.referrer : '',
      onLog: (msg) => emitter.emit('log', msg),
    });

    if (isStoppedRef && isStoppedRef()) {
      return false;
    }

    emitter.emit('log', `[Session ${sessionNum}] Opening Google Maps`);
    await page.goto('https://www.google.com/maps', { waitUntil: 'domcontentloaded', timeout: 120000 });
    if (isStoppedRef && isStoppedRef()) return false;
    // Dismiss Google consent screen (shown on first visit, especially in EU)
    await PopupHandler.dismissGoogle(page, { label: `[Session ${sessionNum}]`, log: emitter });
    await sleep(mapsLoadWaitMs);
    if (isStoppedRef && isStoppedRef()) return false;
    // Pause if Google presented a CAPTCHA on the Maps homepage
    if (captchaGuard) await captchaGuard.waitForCaptchaResolution();
    if (isStoppedRef && isStoppedRef()) return false;

    // ─────────────────────────────────────────────────────────────────────
    // App-upsell popup handling (mobile) — covers two known dialog variants:
    //   1. "Open the Google Maps app?" — "Keep using web" vs "Continue" (app)
    //   2. "Upgrade to a smarter Google Maps" — "Go back to web" vs "Continue" (app)
    // We ALWAYS click "Keep using web" / "Go back to web" / "Continue to
    // Website" and NEVER click "Continue" (app) or "Download App".
    // ─────────────────────────────────────────────────────────────────────
    const isMobileDevice = device === 'mobile' || device === 'tablet';
    const continueBrowsingAttempts = isMobileDevice ? 5 : 2;
    for (let cbAttempt = 0; cbAttempt < continueBrowsingAttempts; cbAttempt++) {
      if (isStoppedRef && isStoppedRef()) break;
      const dismissed = await PopupHandler.dismissContinueBrowsing(page, {
        label: `[Session ${sessionNum}]`,
        log: emitter,
      });
      if (dismissed) {
        // Give the Maps UI a moment to settle after dismissing the interstitial
        await sleep(1500);
        break;
      }
      if (cbAttempt < continueBrowsingAttempts - 1) {
        await sleep(1500);
      }
    }

    // Start a background monitor that keeps dismissing the "Keep using web" /
    // "Continue to Website" popup (and other consent popups) while the search
    // and browse flow runs.
    //
    // IMPORTANT: We use a Google Maps-specific dismiss function, NOT the
    // generic dismissAll. The generic dismissAll uses text-based selectors
    // like `button:has-text("OK")`, `button[aria-label*="accept" i]`, etc.
    // These match Google Maps UI buttons (e.g. the "OK" / "Accept" buttons
    // in Maps dialogs) and clicking them clears the search results and
    // navigates back to the Maps homepage — destroying the very results we
    // are trying to click.
    //
    // Our custom function ONLY dismisses known cookie-consent framework
    // banners by their specific, stable IDs/classes (OneTrust, Cookiebot,
    // etc.) — NEVER text-based or aria-label-based matching that could hit
    // Maps UI elements.
    const mapsDismissFn = async (page, opts) => {
      // 1. "Continue Browsing" / "Keep using web" interstitial — only the
      //    specific mobile interstitial, handled by exact text match of the
      //    known button labels (NOT generic "OK"/"Accept"/"Agree").
      try {
        const mobileBtns = await page.$$([
          'button:has-text("Keep using web")',
          'button:has-text("Go back to web")',
          'button:has-text("Continue to Website")',
          'button:has-text("Continue to website")',
        ].join(', ')).catch(() => []);
        for (const btn of mobileBtns) {
          const visible = await btn.isVisible().catch(() => false);
          if (visible) { await btn.click({ timeout: 2000 }).catch(() => {}); }
        }
      } catch (_) {}
      // 2. Known cookie-consent framework banners ONLY — by specific IDs /
      //    classes, never text-based matching. These selectors are unique to
      //    the consent frameworks and will never match Google Maps UI.
      try {
        const cookieBtns = await page.$$([
          '#onetrust-accept-btn-handler',           // OneTrust
          '#CybotCookiebotDialogBodyButton',        // Cookiebot
          '#cookie-accept', '#cookieAccept',         // generic cookie IDs
          '.js-accept-cookies',                      // common class
          '#cmpbntyestext',                          // CMP
          '#sp_message_container_...',               // Sourcepoint
        ].join(', ')).catch(() => []);
        for (const btn of cookieBtns) {
          const visible = await btn.isVisible().catch(() => false);
          if (visible) { await btn.click({ timeout: 2000 }).catch(() => {}); }
        }
      } catch (_) {}
    };
    popupMonitorStop = PopupHandler.startMonitor(page, {
      label: `[Session ${sessionNum}]`,
      log: emitter,
      interval: 2500,
      verbose: false,
      dismissFn: mapsDismissFn,
    });

    const searchTerm = keyword || businessName;
    emitter.emit('log', `[Session ${sessionNum}] Searching for: "${searchTerm}"`);

    // Preferred selectors for the Google Maps search box (ordered). We always
    // prefer a VISIBLE input so we never type into a hidden duplicate field —
    // Google Maps sometimes keeps an old/hidden #searchboxinput around while
    // the real, clickable search box is a different element.
    const searchInputSelectors = [
      '#searchboxinput',
      'input[name="q"]',
      'input[placeholder*="Find a place" i]',
      'input[placeholder*="Search Google Maps" i]',
      'input[aria-label*="Search Google Maps" i]',
      'input[aria-label*="Find a place" i]',
      'input[aria-label*="Search" i]',
      'input.tactile-searchbox-input',
      'input[type="search"]',
      '[role="combobox"] input',
      'input[type="text"]',
    ];

    const searchButtonSelectors = [
      'button#searchbox-searchbutton',
      'button[aria-label*="Search" i]',
      '[role="button"][aria-label*="Search" i]',
      'button[data-tooltip*="Search" i]',
      'button[jsaction*="search"]',
    ];

    let searchSuccess = false;
    for (let attempt = 0; attempt < stepRetryAttempts && !searchSuccess; attempt++) {
      if (isStoppedRef && isStoppedRef()) break;

      // Re-check for the "Keep using web" popup before each search attempt.
      await PopupHandler.dismissContinueBrowsing(page, {
        label: `[Session ${sessionNum}]`,
        log: emitter,
        verbose: false,
      }).catch(() => {});

      try {
        // Find a visible search input and type into it.
        for (const sel of searchInputSelectors) {
          const loc = page.locator(sel);
          const count = await loc.count().catch(() => 0);
          for (let i = 0; i < count; i++) {
            const input = loc.nth(i);
            const visible = await input.isVisible().catch(() => false);
            if (!visible) continue;
            try {
              await input.click({ timeout: 3000 });
              await sleep(300);
              await input.fill('');
              await input.type(searchTerm, { delay: typingDelayMs });
              await sleep(500);
              await page.keyboard.press('Enter');
              searchSuccess = true;
            } catch (_) {
              searchSuccess = false;
            }
            break; // moved on from this selector after the first visible input
          }
          if (searchSuccess) break;
        }

        // Verify the search actually executed (URL changed to a Maps search /
        // place page). If not, some Maps builds need the search button instead
        // of the Enter key.
        if (searchSuccess) {
          const executed = await page.evaluate(() => /\/maps\/search|\/maps\/place|\/maps\/dir/i.test(location.href)).catch(() => false);
          if (!executed) {
            for (const sel of searchButtonSelectors) {
              const btn = page.locator(sel).first();
              if (await btn.isVisible().catch(() => false)) {
                await btn.click({ timeout: 3000 }).catch(() => {});
                break;
              }
            }
          }
        }
      } catch (e) {
        emitter.emit('log', `[WARN] Search attempt ${attempt + 1} failed: ${e.message}`);
      }

      if (!searchSuccess) {
        emitter.emit('log', `[WARN] Search attempt ${attempt + 1} failed, retrying...`);
        await sleep(stepRetryDelayMs);
      }
    }

    // Wait for search results to actually appear in the DOM (not just a fixed
    // sleep). Google Maps renders results inside a div[role="feed"] container
    // and each business card has an a.hfpxzc name link.
    emitter.emit('log', `[Session ${sessionNum}] Waiting for search results to load...`);
    // Ordered so the most specific, stable result-card selectors are tried
    // first. `div[role="feed"]` (the bare container) is intentionally LAST so
    // we don't falsely report "results loaded" when the feed exists but no
    // business cards have rendered yet.
    const resultWaitSelectors = [
      'a[aria-label][href*="/maps/place/"]',
      '[role="feed"] a[href*="/maps/place/"]',
      'div[role="article"]',
      'a.hfpxzc',
      'div.Nv2PK',
      'div[role="feed"] a',
      'div[role="feed"]',
    ];
    let resultsLoaded = false;
    for (const sel of resultWaitSelectors) {
      try {
        await page.waitForSelector(sel, { timeout: Math.min(searchResultWaitMs, 15000) });
        emitter.emit('log', `[Session ${sessionNum}] Search results detected via "${sel}"`);
        resultsLoaded = true;
        break;
      } catch (_) {}
    }

    // Fallback: if the interactive search produced no results (Google Maps
    // changed its search box or blocked the Enter/submit), navigate straight
    // to the Maps search URL — this performs the search reliably.
    if (!resultsLoaded) {
      const searchUrl = `https://www.google.com/maps/search/${encodeURIComponent(searchTerm)}`;
      emitter.emit('log', `[Session ${sessionNum}] No results after interactive search — navigating directly to ${searchUrl}`);
      try {
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
        if (captchaGuard) await captchaGuard.waitForCaptchaResolution();
      } catch (navErr) {
        emitter.emit('log', `[WARN] Direct Maps search navigation failed: ${navErr.message}`);
      }
      // Re-wait for results after the direct navigation
      resultsLoaded = false;
      for (const sel of resultWaitSelectors) {
        try {
          await page.waitForSelector(sel, { timeout: Math.min(searchResultWaitMs, 15000) });
          emitter.emit('log', `[Session ${sessionNum}] Search results detected via "${sel}" (direct nav)`);
          resultsLoaded = true;
          break;
        } catch (_) {}
      }
      if (!resultsLoaded) {
        await sleep(searchResultWaitMs);
      }
    } else {
      // Give results a moment to fully render after the selector appears
      await sleep(2000);
    }

    if (isStoppedRef && isStoppedRef()) return false;
    emitter.emit('log', `[Session ${sessionNum}] Search results loaded`);
    // Pause if a CAPTCHA appeared after the Maps search
    if (captchaGuard) await captchaGuard.waitForCaptchaResolution();
    if (isStoppedRef && isStoppedRef()) return false;

    // ── Safety net: verify we're still on a search results page ─────────────
    // The background popup monitor or a Maps UI interaction can sometimes
    // clear the search and navigate back to the plain Maps homepage (URL
    // becomes /maps/@lat,lng with no /search/ or /place/ segment). If that
    // happened, re-navigate to the search URL so findAndClickBusiness has
    // actual results to work with.
    {
      const currentUrl = page.url();
      const isSearchPage = /\/maps\/(search|place|dir)/i.test(currentUrl);
      if (!isSearchPage) {
        const searchUrl = `https://www.google.com/maps/search/${encodeURIComponent(searchTerm)}`;
        emitter.emit('log', `[WARN] Results page lost (URL: ${currentUrl}). Re-navigating to ${searchUrl}`);
        try {
          await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
          if (captchaGuard) await captchaGuard.waitForCaptchaResolution();
          // Re-wait for results to render after re-navigation
          for (const sel of resultWaitSelectors) {
            try {
              await page.waitForSelector(sel, { timeout: Math.min(searchResultWaitMs, 15000) });
              emitter.emit('log', `[Session ${sessionNum}] Results re-detected via "${sel}"`);
              break;
            } catch (_) {}
          }
          await sleep(2000);
        } catch (navErr) {
          emitter.emit('log', `[WARN] Re-navigation failed: ${navErr.message}`);
        }
      }
    }
    if (isStoppedRef && isStoppedRef()) return false;

    const found = await findAndClickBusiness(page, businessName, targetUrl, (msg) => emitter.emit('log', msg));
    if (isStoppedRef && isStoppedRef()) return false;

    if (found) {
      // Wait for the business detail panel to load before looking for the
      // website link. The panel renders asynchronously after clicking a result.
      emitter.emit('log', `[Session ${sessionNum}] Waiting for business detail panel to load...`);
      try {
        await page.waitForSelector('[data-item-id="authority"], a[aria-label*="Website" i]', { timeout: 10000 });
      } catch (_) {
        // Detail panel might still be loading; clickWebsiteLink will retry
      }
      await sleep(2000);
      if (isStoppedRef && isStoppedRef()) return false;

      // Set up a popup listener BEFORE clicking the website link so we catch
      // the new tab the moment it opens (Google Maps opens website links in a
      // new tab via target="_blank" / JS window.open).
      let popupPage = null;
      const popupPromise = new Promise((resolve) => {
        context.once('page', (p) => { popupPage = p; resolve(p); });
        // Timeout: if no popup opens within 15s, resolve null (same-tab nav)
        setTimeout(() => resolve(null), 15000);
      });

      const websiteClicked = await clickWebsiteLink(page, targetUrl, (msg) => emitter.emit('log', msg), stepRetryAttempts, stepRetryDelayMs);
      if (isStoppedRef && isStoppedRef()) return false;

      let websitePage = page;
      if (websiteClicked) {
        // Wait for either a new tab (popup) or same-tab navigation to complete.
        // Google Maps website links typically open in a new tab, but some may
        // navigate the current page instead.
        const newPage = await Promise.race([
          popupPromise,
          sleep(3000).then(() => null),
        ]);

        if (newPage || popupPage) {
          websitePage = newPage || popupPage;
          emitter.emit('log', `[Session ${sessionNum}] Website opened in new tab`);
          try { await websitePage.bringToFront(); } catch (_) {}
          // Wait for the new tab to load
          try {
            await websitePage.waitForLoadState('domcontentloaded', { timeout: 60000 }).catch(() => {});
          } catch (e) {}
        } else {
          // Check if a new tab appeared (fallback for race conditions)
          const allPages = context.pages();
          if (allPages.length > 1) {
            websitePage = allPages[allPages.length - 1];
            emitter.emit('log', `[Session ${sessionNum}] Website opened in new tab (detected via pages())`);
            try { await websitePage.bringToFront(); } catch (_) {}
            try {
              await websitePage.waitForLoadState('domcontentloaded', { timeout: 60000 }).catch(() => {});
            } catch (e) {}
          } else {
            // Same-tab navigation — the current page navigated to the website
            emitter.emit('log', `[Session ${sessionNum}] Website opened in same tab`);
            try {
              await page.waitForLoadState('domcontentloaded', { timeout: 60000 }).catch(() => {});
            } catch (e) {}
          }
        }

        await sleep(websiteLoadWaitMs);
        if (isStoppedRef && isStoppedRef()) return false;
        // Dismiss any cookie consent on the target website
        await PopupHandler.dismissAll(websitePage, { label: `[Session ${sessionNum}]`, log: emitter });
      } else {
        emitter.emit('log', `[WARN] Could not click website link, visiting directly`);
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 120000 }).catch(() => {});
        if (captchaGuard) await captchaGuard.waitForCaptchaResolution();
        const directErr = await detectChromeErrorPage(websitePage || page);
        if (directErr) throw new Error('__PROXY_FAILED__:' + directErr);
      }

      if (isStoppedRef && isStoppedRef()) return false;

      // Random clicks anywhere on the business website (ads included), inside
      // the configured visit window only.
      randomClicker = startRandomClicker(websitePage || page, {
        config: config.randomClicks,
        sessionId: `Session ${sessionNum}`,
        onLog: (msg, type) => emitter.emit('log', msg, type),
        isStopped: () => (isStoppedRef && isStoppedRef()),
      });

      if (scrollingInternalPagesEnabled) {
        emitter.emit('log', `[Session ${sessionNum}] Scrolling website...`);
        await smoothNaturalScroll(websitePage, scrollDirection, scrollDownWaitMs, scrollUpWaitMs);
        if (isStoppedRef && isStoppedRef()) return false;
      }

      emitter.emit('log', `[Session ${sessionNum}] Staying on page for ${visitTimeMs / 1000} seconds...`);
      await sleep(visitTimeMs);
      if (isStoppedRef && isStoppedRef()) return false;

      if (scrollingInternalPagesEnabled) {
        if (randomClicker) await randomClicker.pause();
        await visitInternalPages(websitePage, config, emitter, sessionNum, captchaGuard);
        if (randomClicker) randomClicker.resume();
        if (isStoppedRef && isStoppedRef()) return false;
      }
      if (randomClicker) randomClicker.stop();

      // Full visit time has elapsed. Never count a visit that ended on
      // Chrome's "This site can't be reached" page.
      const endErr = await detectChromeErrorPage(websitePage || page);
      if (endErr) throw new Error('__PROXY_FAILED__:' + endErr);
      const endUrl = websitePage ? (websitePage.url() || '') : '';
      if (!endUrl || endUrl === 'about:blank' || endUrl.startsWith('chrome-error://')) {
        throw new Error('__PAGE_NOT_LOADED__');
      }

      emitter.emit('log', `[SUCCESS] Session ${sessionNum} completed successfully`);
      return true;
    } else {
      emitter.emit('log', `[WARN] Business "${businessName}" not found in Maps results`);
      return false;
    }

  } catch (err) {
    const errMsg = String((err && err.message) || '');
    const netCode = parseNetError(errMsg);
    if (proxyFailRef.failed || errMsg.startsWith('__PROXY_FAILED__') || netCode) {
      const code = proxyFailRef.code || netCode || errMsg.split(':')[1] || 'ERR_CONNECTION_FAILED';
      emitter.emit(
        'log',
        `[Session ${sessionNum}] Site can't be reached (${code}) - switching to another proxy`,
        'WARN'
      );
      return 'proxy_blocked';
    }
    emitter.emit('log', `[ERROR] Session ${sessionNum} error: ${err.message}`);
    console.error(err);
    return false;
  } finally {
    if (randomClicker) {
      try { randomClicker.stop(); } catch (_) {}
      randomClicker = null;
    }
    // Stop the background popup monitor before closing the browser
    if (popupMonitorStop) {
      try { popupMonitorStop(); } catch (_) {}
      popupMonitorStop = null;
    }
    if (browser) {
      // Let ad popups finish their own view timer before the browser goes away.
      if (!(isStoppedRef && isStoppedRef())) {
        try {
          await waitForExtraTabs(browser, {
            sessionId: `Session ${sessionNum}`,
            onLog: (msg, type) => emitter.emit('log', msg, type),
          });
        } catch (_) {}
      }
      await browser.close();
      emitter.emit('log', `[Session ${sessionNum}] Browser closed`);
    }
  }
}

async function runGoogleMapsTraffic(config, emitter = new EventEmitter()) {
  let isRunning = true;
  let isPaused = false;
  let nextSessionIndex = 0;
  let activeBrowsers = 0;
  const openBrowsers = [];

  const {
    sessions = 1,
    threads = 1
  } = config;

  const tasks = [];
  for (let i = 0; i < sessions; i++) {
    tasks.push({ id: i + 1, status: 'pending' });
  }

  function emitStatsUpdate() {
    const total = tasks.length;
    const completed = tasks.filter(t => t.status === 'completed').length;
    const failed = tasks.filter(t => t.status === 'failed').length;
    const stopped = tasks.filter(t => t.status === 'stopped').length;
    const running = tasks.filter(t => t.status === 'running').length;
    const pending = tasks.filter(t => t.status === 'pending').length;

    emitter.emit('stats', {
      total,
      completed,
      running,
      pending,
      failed,
      stopped,
      activeBrowsers,
      progress: total > 0 ? Math.round((completed / total) * 100) : 0,
      remaining: pending + running
    });
  }

  const trackedRunMapsSession = async (config, emitter, sessionNum, isStoppedRef) => {
    let browser = null;
    try {
      const result = await runMapsSession(config, emitter, sessionNum, (b) => {
        browser = b;
        openBrowsers.push(b);
      }, isStoppedRef);
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

  emitter.on('stop', async () => {
    isRunning = false;
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
    openBrowsers.length = 0;
    activeBrowsers = 0;
    emitStatsUpdate();
  });

  emitter.on('pause', () => {
    isPaused = true;
    emitter.emit('status', 'paused');
    emitter.emit('log', 'Campaign paused');
    emitStatsUpdate();
  });

  emitter.on('resume', () => {
    isPaused = false;
    emitter.emit('status', 'running');
    emitter.emit('log', 'Campaign resumed');
    emitStatsUpdate();
  });

  (async () => {
    try {
      emitter.emit('status', 'starting');
      emitter.emit('log', `Starting Google Maps traffic for business: ${config.businessName}`);
      emitStatsUpdate();

      const processSession = async () => {
        while (nextSessionIndex < sessions && isRunning) {
          while (isPaused && isRunning) {
            await sleep(100);
          }
          if (!isRunning) break;

          const sessionIndex = nextSessionIndex++;
          tasks[sessionIndex].status = 'running';
          activeBrowsers++;
          emitStatsUpdate();

          try {
            emitter.emit('log', `[Session ${sessionIndex + 1}] Starting...`);
            const result = await runWithProxyRetry({
              config,
              runOnce: (cfg) => trackedRunMapsSession(cfg, emitter, sessionIndex + 1, () => !isRunning),
              onLog: (msg, type) => emitter.emit('log', `[Session ${sessionIndex + 1}] ${msg}`, type),
              isStopped: () => !isRunning,
            });
            if (result) {
              tasks[sessionIndex].status = 'completed';
            } else {
              tasks[sessionIndex].status = 'failed';
            }
          } catch (err) {
            tasks[sessionIndex].status = 'failed';
            emitter.emit('log', `[ERROR] Session ${sessionIndex + 1} error: ${err.message}`);
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

      emitter.emit('status', 'running');
      await maintainActiveBrowsers();

      emitter.emit('status', isRunning ? 'completed' : 'stopped');
      emitter.emit('log', isRunning ? 'All sessions complete!' : 'Campaign stopped');

      const finalStats = {
        completed: tasks.filter(t => t.status === 'completed').length,
        failed: tasks.filter(t => t.status === 'failed').length,
        stopped: tasks.filter(t => t.status === 'stopped').length,
        totalProcessed: tasks.filter(t => t.status === 'completed' || t.status === 'failed').length,
        remaining: tasks.filter(t => t.status === 'pending' || t.status === 'running').length
      };
      emitter.emit('summary', finalStats);
      emitStatsUpdate();

    } catch (error) {
      emitter.emit('log', `[ERROR] Google Maps traffic error: ${error.message}`);
      console.error(error);
      emitter.emit('status', 'error');
    }
  })();

  return emitter;
}

function startGoogleMapsTraffic(config) {
  const emitter = new EventEmitter();
  setImmediate(() => {
    runGoogleMapsTraffic(config, emitter).catch((err) => {
      try {
        emitter.emit('log', `Fatal error: ${err.message}`);
        emitter.emit('status', 'failed');
      } catch (_) {}
    });
  });
  return emitter;
}

module.exports = { 
  run: runGoogleMapsTraffic, 
  startGoogleMapsTraffic 
};
