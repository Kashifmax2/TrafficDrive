// Internal link navigator.js
// Minimal internal-link navigation helpers shared by the traffic modules.
//
// The production version has elaborate article-reading / link-traversal
// heuristics; this minimal implementation provides the four exported
// functions the traffic files import, with sensible default behaviour so the
// sessions run end-to-end.

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForFullPageLoad(page, timeoutMs = 30000) {
  try {
    await page.waitForLoadState('domcontentloaded', { timeout: timeoutMs });
  } catch (_) {}
  try {
    await page.waitForLoadState('networkidle', { timeout: Math.min(timeoutMs, 15000) });
  } catch (_) {}
}

// Dismiss common consent popups that would block link clicks.
async function dismissConsentPopup(page) {
  const selectors = [
    'button#onetrust-accept-btn-handler',
    'button[id*="accept" i]',
    'button[aria-label*="accept" i]',
    'button[aria-label="Close" i]',
    'button.close',
  ];
  for (const sel of selectors) {
    try {
      const el = await page.$(sel).catch(() => null);
      if (el && (await el.isVisible().catch(() => false))) {
        await el.click({ timeout: 2000 }).catch(() => {});
        await sleep(250);
      }
    } catch (_) {}
  }
}

// Collect same-origin navigable links from the current page.
async function collectLinks(page, origin) {
  return page.evaluate((o) => {
    const skip = /\.(pdf|zip|rar|7z|jpe?g|png|gif|svg|webp|mp4|mp3|avi|dmg|exe|apk|css|js)(\?|$)/i;
    const seen = new Set();
    const out = [];
    for (const a of Array.from(document.querySelectorAll('a[href]'))) {
      const href = a.href;
      if (!href) continue;
      let u;
      try { u = new URL(href); } catch { continue; }
      if (u.origin !== o) continue;
      if (!/^https?:$/.test(u.protocol)) continue;
      if (skip.test(u.pathname)) continue;
      // Skip ad / affiliate / tracker redirect links.
      if (/(^|[?&])(ad|ads|adid|ad_id|aff|affid|aff_id|zoneid|zone_id|gclid|fbclid|msclkid|popunder)=/i.test(u.search)) continue;
      if (/\/(adclick|adserver|popunder|adservice|adsense|sponsor)(\/|\?|$)/i.test(u.pathname)) continue;
      if (u.pathname === location.pathname && u.search === location.search) continue;
      if (seen.has(href)) continue;
      seen.add(href);
      out.push(href);
    }
    return out;
  }, origin).catch(() => []);
}

// Visit up to `count` internal links, scrolling and waiting on each.
async function runInternalLinkNavigation(page, config, emitter, sessionNum) {
  const {
    internalLinkCount = 3,
    internalLinkReadTime = 3000,
    scrollDirection = 'down',
    scrollDownWaitMs = 1500,
    scrollUpWaitMs = 1500,
    targetUrl,
  } = config;

  const wanted = parseInt(internalLinkCount, 10);
  if (!wanted || wanted <= 0) return;

  let origin;
  try {
    origin = new URL(page.url() || targetUrl).origin;
  } catch {
    return;
  }

  await dismissConsentPopup(page);
  const links = (await collectLinks(page, origin))
    .sort(() => 0.5 - Math.random())
    .slice(0, wanted);

  if (links.length === 0) {
    if (emitter) emitter.emit('log', `[Session ${sessionNum}] No internal links found`);
    return;
  }

  for (let i = 0; i < links.length; i++) {
    const link = links[i];
    if (emitter) emitter.emit('log', `[Session ${sessionNum}] Internal link ${i + 1}/${links.length}: ${link}`);
    try {
      await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await waitForFullPageLoad(page, 20000);
      // simple scroll
      try {
        await page.evaluate((dir) => {
          const amount = window.innerHeight * 0.7;
          window.scrollBy(0, dir === 'up' ? -amount : amount);
        }, scrollDirection);
      } catch (_) {}
      await sleep(scrollDownWaitMs || 1500);
      await sleep(internalLinkReadTime || 3000);
    } catch (err) {
      if (emitter) emitter.emit('log', `[Session ${sessionNum}] Internal link failed: ${err.message}`);
    }
  }
}

// Read N "articles" on the current page — minimal version just scrolls
// through the page in segments to simulate reading.
async function readArticlesOnPage(page, count = 1, readTimeMs = 3000) {
  for (let i = 0; i < count; i++) {
    try {
      await page.evaluate(() => {
        window.scrollBy(0, window.innerHeight * 0.8);
      });
    } catch (_) {}
    await sleep(readTimeMs);
  }
}

module.exports = {
  runInternalLinkNavigation,
  readArticlesOnPage,
  waitForFullPageLoad,
  dismissConsentPopup,
  collectLinks,
};
