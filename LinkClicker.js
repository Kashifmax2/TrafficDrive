// LinkClicker.js
// Real, human-like internal link clicking shared by every traffic module.
//
// Why this exists:
//   Earlier versions either jumped straight to page.goto() (Organic / Google
//   Maps) or force-clicked the link (which landed on ad overlays). Both mean
//   the site never sees a genuine click. This module:
//
//     1. Finds the real <a> element on the current page.
//     2. Scrolls it into view and removes target="_blank".
//     3. Hit-tests several points inside the link (multi-line inline links have
//        many client rects, so the geometric centre is often empty space).
//     4. If an ad overlay covers every point -> NO click at all (ad safety).
//     5. Otherwise dispatches a real mouse click (move -> down -> up).
//
// Returns a result object, never throws:
//   { clicked, navigated, reason, coveredBy }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Playwright's page.evaluate() has no timeout of its own: if the page starts a
// navigation while the script is queued, the call can hang forever and stall
// the whole session. Every DOM probe goes through this helper.
function withTimeout(promise, ms, fallback) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

// Optional timing trace: set TP_TIMING=1 to print link-click stage timings.
const TIMING = !!process.env.TP_TIMING;
function mark(label, start) {
  if (!TIMING) return;
  try {
    console.log(`[TP_TIMING] ${label} +${Date.now() - start}ms`);
  } catch (_) {}
}

function normalizeUrl(u) {
  try {
    const x = new URL(String(u || ''));
    let p = x.pathname.replace(/\/+$/, '');
    if (p === '') p = '/';
    return `${x.origin}${p}${x.search}`;
  } catch (_) {
    return String(u || '');
  }
}

const AD_QUERY_RE =
  /(^|[?&])(ad|ads|adid|ad_id|aff|affid|aff_id|zoneid|zone_id|gclid|fbclid|msclkid|popunder)=/i;
const AD_PATH_RE = /\/(adclick|adserver|popunder|adservice|adsense|sponsor)(\/|\?|$)/i;

function looksLikeAdLink(href) {
  try {
    const u = new URL(href);
    return AD_QUERY_RE.test(u.search) || AD_PATH_RE.test(u.pathname);
  } catch (_) {
    return true;
  }
}

// Collects same-origin, downloadable-page links from the page the browser is
// on right now. Ad / affiliate / tracker links are excluded.
async function collectInternalLinks(page, origin) {
  return withTimeout(
    page
    .evaluate(
      ({ o, adQuerySrc, adPathSrc }) => {
        const adQuery = new RegExp(adQuerySrc, 'i');
        const adPath = new RegExp(adPathSrc, 'i');
        const skip =
          /\.(pdf|zip|rar|7z|jpe?g|png|gif|svg|webp|mp4|mp3|avi|dmg|exe|apk|css|js)(\?|$)/i;
        const seen = new Set();
        const out = [];
        for (const a of Array.from(document.querySelectorAll('a[href]'))) {
          const href = a.href;
          if (!href) continue;
          let u;
          try {
            u = new URL(href);
          } catch (_) {
            continue;
          }
          if (u.origin !== o) continue;
          if (!/^https?:$/.test(u.protocol)) continue;
          if (skip.test(u.pathname)) continue;
          if (adQuery.test(u.search)) continue;
          if (adPath.test(u.pathname)) continue;
          if (u.pathname === location.pathname && u.search === location.search) continue;
          if (seen.has(href)) continue;
          seen.add(href);
          out.push(href);
        }
        return out;
      },
      { o: origin, adQuerySrc: AD_QUERY_RE.source, adPathSrc: AD_PATH_RE.source }
    )
    .catch(() => []),
    10000,
    []
  );
}

// Finds a point inside the link that actually receives the click.
async function findClickablePoint(page, href) {
  return withTimeout(
    page
    .evaluate((target) => {
      const anchors = Array.from(document.querySelectorAll('a[href]'));
      const exact = anchors.find((x) => x.href === target);
      const loose =
        exact ||
        anchors.find((x) => {
          try {
            return x.href.split('#')[0] === target.split('#')[0];
          } catch (_) {
            return false;
          }
        });
      if (!loose) return { ok: false, reason: 'link-not-found' };

      const a = loose;
      try {
        a.removeAttribute('target');
      } catch (_) {}
      try {
        a.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      } catch (_) {}

      const rects = Array.from(a.getClientRects()).filter(
        (r) => r.width >= 2 && r.height >= 2
      );
      if (rects.length === 0) {
        const r = a.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) return { ok: false, reason: 'invisible' };
        rects.push(r);
      }

      const points = [];
      for (const r of rects) {
        // Inline links wrap: the middle of the bounding box may be whitespace.
        points.push([r.x + r.width / 2, r.y + r.height / 2]);
        points.push([r.x + Math.min(24, Math.max(4, r.width / 2)), r.y + r.height / 2]);
        points.push([r.x + Math.max(4, r.width * 0.75), r.y + r.height / 2]);
        points.push([r.x + r.width / 2, r.y + Math.min(10, Math.max(3, r.height / 2))]);
      }

      let coveredBy = '';
      for (const [px, py] of points) {
        const x = Math.min(Math.max(px, 1), window.innerWidth - 1);
        const y = Math.min(Math.max(py, 1), window.innerHeight - 1);
        const el = document.elementFromPoint(x, y);
        if (!el) continue;
        const hit = el.closest ? el.closest('a') : null;
        if (hit === a) return { ok: true, x, y };
        if (!coveredBy) {
          coveredBy = `${el.tagName}${el.id ? '#' + el.id : ''}${
            el.className && typeof el.className === 'string'
              ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.')
              : ''
          }`;
        }
      }
      return { ok: false, reason: 'covered', coveredBy };
    }, href)
    .catch((err) => ({ ok: false, reason: 'evaluate-failed: ' + (err && err.message) })),
    10000,
    { ok: false, reason: 'evaluate-timeout' }
  );
}

/**
 * Clicks an internal link like a real visitor.
 *
 * @param {import('playwright').Page} page
 * @param {string} href
 * @param {{timeoutMs?:number, onLog?:(msg:string)=>void}} opts
 * @returns {Promise<{clicked:boolean, navigated:boolean, reason:string, coveredBy?:string}>}
 */
async function clickInternalLink(page, href, opts = {}) {
  const { timeoutMs = 15000, onLog = () => {} } = opts;
  const t0 = Date.now();

  let before = '';
  try {
    before = page.url();
  } catch (_) {}

  // A popup/ad tab may have taken focus. Chromium throttles background tabs, so
  // mouse input and scrolling crawl (5s+ per click) unless we re-activate the
  // page we are driving. This does NOT close the ad tab — it only focuses ours.
  try {
    await page.bringToFront();
  } catch (_) {}

  const point = await findClickablePoint(page, href);
  mark('point-found', t0);
  if (!point || !point.ok) {
    const why = point ? point.reason : 'unknown';
    if (why === 'covered') {
      onLog(
        `Link is covered by an overlay (${point.coveredBy || 'ad'}) - skipped click to avoid the ad`
      );
    } else if (why === 'link-not-found') {
      onLog('Link no longer present on the page - skipped click');
    } else {
      onLog(`Link is not clickable (${why}) - skipped click`);
    }
    return {
      clicked: false,
      navigated: false,
      reason: why,
      coveredBy: point && point.coveredBy,
    };
  }

  // Human-ish mouse approach before pressing.
  await sleep(120 + Math.floor(Math.random() * 220));
  try {
    await page.mouse.move(point.x + (Math.random() * 6 - 3), point.y + (Math.random() * 4 - 2), {
      steps: 6,
    });
  } catch (_) {}
  await sleep(60 + Math.floor(Math.random() * 120));

  let popup = null;
  let navDone = false;

  const navPromise = page
    .waitForNavigation({ waitUntil: 'domcontentloaded', timeout: timeoutMs })
    .then(() => {
      navDone = true;
      return true;
    })
    .catch(() => false);

  const popupPromise = page
    .context()
    .waitForEvent('page', { timeout: 4000 })
    .then((p) => {
      popup = p;
      return p;
    })
    .catch(() => null);

  try {
    await page.mouse.down();
    await sleep(50 + Math.floor(Math.random() * 80));
    await page.mouse.up();
  } catch (err) {
    onLog(`Mouse click failed: ${err.message}`);
    return { clicked: false, navigated: false, reason: 'mouse-failed' };
  }

  mark('mouse-up', t0);
  onLog(`Clicked internal link: ${href}`);

  const navOk = await navPromise;
  mark('nav-settled', t0);
  // A popup only matters when the click did not navigate the main tab. Waiting
  // the full popup timeout on every click would waste seconds per page.
  await Promise.race([popupPromise, sleep(navOk ? 200 : 1200)]);

  let after = before;
  try {
    after = page.url();
  } catch (_) {}

  let popupUrl = '';
  if (popup) {
    try {
      popupUrl = popup.url() || '';
    } catch (_) {}
  }

  const navigatedMain = !!after && normalizeUrl(after) !== normalizeUrl(before);
  const navigatedPopup =
    !!popupUrl &&
    (normalizeUrl(popupUrl) === normalizeUrl(href) ||
      normalizeUrl(popupUrl).startsWith(normalizeUrl(href)));

  if (!navigatedMain && !navigatedPopup && !navDone) {
    // Give SPA / delayed navigations a short extra window before giving up.
    await sleep(1200);
    try {
      after = page.url();
    } catch (_) {}
    if (after && normalizeUrl(after) !== normalizeUrl(before)) {
      return { clicked: true, navigated: true, reason: 'delayed-navigation' };
    }
  }

  return {
    clicked: true,
    navigated: navigatedMain || navigatedPopup,
    reason: navigatedPopup && !navigatedMain ? 'opened-in-new-tab' : 'navigated',
  };
}

/**
 * Visits `count` internal pages, always clicking real links on the page that is
 * currently open (a stale link pool from the landing page is useless once the
 * browser has navigated away). Falls back to a direct navigation only when the
 * click is impossible (ad overlay / no anchor).
 *
 * @returns {Promise<number>} number of pages processed
 */
async function visitInternalLinks(page, opts = {}) {
  const {
    count,
    origin,
    onLog = () => {},
    isStopped = () => false,
    clickTimeoutMs = 15000,
    gotoTimeoutMs = 60000,
    onPage = async () => {},
    goBackWhenStuck = true,
    maxBack = 2,
    ensureCaptcha = null,
  } = opts;

  const wanted = parseInt(count, 10);
  if (!wanted || wanted <= 0) return 0;

  const visited = new Set([normalizeUrl(page.url())]);
  const failed = new Set();
  const sameOrigin = (u) => {
    try {
      return new URL(u).origin === origin;
    } catch (_) {
      return false;
    }
  };
  let lastGoodUrl = page.url() || '';
  let processed = 0;
  let loops = 0;
  let backs = 0;
  const maxLoops = wanted * 6 + 10;

  while (processed < wanted && loops++ < maxLoops) {
    if (isStopped()) {
      onLog('Stop requested - aborting internal pages');
      return processed;
    }

    let candidates = (await collectInternalLinks(page, origin)).filter(
      (h) => !visited.has(normalizeUrl(h)) && !failed.has(normalizeUrl(h))
    );

    if (candidates.length === 0) {
      // Never walk back off the landing page. If nothing was clickable yet the
      // browser history still holds the warm-up/about:blank entry, and going
      // back would move the session to about:blank (looks like "page did not
      // load" and the visit would not be counted).
      if (!goBackWhenStuck || processed === 0 || backs >= maxBack) break;
      let before = '';
      try {
        before = page.url();
        await page.goBack({ waitUntil: 'domcontentloaded', timeout: 20000 });
      } catch (_) {}
      backs++;
      // A back step can land on about:blank / an ad page. Return to the last
      // real page of the site instead of ending the visit there.
      let after = '';
      try {
        after = page.url() || '';
      } catch (_) {}
      if (after === before) break;
      if (!sameOrigin(after)) {
        try {
          if (lastGoodUrl) await page.goto(lastGoodUrl, { waitUntil: 'domcontentloaded', timeout: gotoTimeoutMs });
        } catch (_) {}
      }
      continue;
    }

    const link = candidates[Math.floor(Math.random() * candidates.length)];
    const key = normalizeUrl(link);
    const tStep = Date.now();
    onLog(`Visiting internal page ${processed + 1}/${wanted}: ${link}`);

    const cr = await clickInternalLink(page, link, { timeoutMs: clickTimeoutMs, onLog });
    mark('click-returned', tStep);
    let navigated = !!cr.navigated;

    if (!navigated) {
      onLog(
        cr.clicked
          ? `Click landed but did not navigate (${cr.reason}) - opening directly: ${link}`
          : `Click skipped (${cr.reason}) - opening directly: ${link}`
      );
      try {
        await page.goto(link, { waitUntil: 'domcontentloaded', timeout: gotoTimeoutMs });
        navigated = true;
      } catch (err) {
        onLog(`Failed to open ${link}: ${err.message}`);
      }
    }

    if (!navigated) {
      failed.add(key);
      continue;
    }

    try {
      await page.waitForLoadState('domcontentloaded', { timeout: 15000 });
    } catch (_) {}
    mark('domcontentloaded', tStep);
    try {
      await page.waitForLoadState('networkidle', { timeout: 12000 });
    } catch (_) {}
    mark('networkidle', tStep);

    // A popup may have taken focus — re-activate our tab (never closes the ad).
    try {
      await page.bringToFront();
    } catch (_) {}

    if (ensureCaptcha) {
      try {
        await ensureCaptcha();
      } catch (_) {}
    }

    visited.add(key);
    visited.add(normalizeUrl(page.url()));
    try {
      lastGoodUrl = page.url() || lastGoodUrl;
    } catch (_) {}

    // Keep our tab active while scrolling/reading, otherwise background-tab
    // throttling stretches the configured read time several times over.
    try {
      await page.bringToFront();
    } catch (_) {}
    await onPage(page);
    mark('onPage-done', tStep);

    processed++;
    onLog(`Internal page ${processed}/${wanted} processed: ${page.url()}`);
  }

  if (processed < wanted) {
    onLog(
      `Internal pages finished: processed ${processed}/${wanted} (site did not expose enough links)`
    );
  } else {
    onLog(`Internal pages finished: processed ${processed}/${wanted}`);
  }
  return processed;
}

module.exports = {
  normalizeUrl,
  looksLikeAdLink,
  collectInternalLinks,
  findClickablePoint,
  clickInternalLink,
  visitInternalLinks,
};
