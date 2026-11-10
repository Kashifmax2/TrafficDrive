// RandomClicker.js
// Human-ish random clicking for every traffic module.
//
// The user configures:
//   - how many seconds pass before the first click
//   - how many clicks happen together (a "burst") and the gap between them
//   - how many seconds pass between bursts
//   - how far the page scrolls after each burst (and in which direction)
//   - optional random refresh interval
//
// IMPORTANT: a click that would open a link / popup never switches focus away
// from the page the module is working on. The link is captured in the page and
// then opened by Node in a real background Chromium tab. The main page stays
// active, so Back keeps working and the user can keep using the old page.
// The same engine is shared by Direct / Organic / Referral / Maps campaigns,
// the RPA replay and the standalone Random Clicks feature.
//
// Everything runs inside the visit window that the module already controls
// (visitTimeMs / dwell time). The clicker never extends a session: it is
// stopped when the session ends, and it can be paused around critical steps
// (e.g. internal-link navigation or recorded RPA actions) so real clicks never
// race with random clicks.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => {
  const a = Math.round(min);
  const b = Math.round(max);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.floor(Math.random() * (Math.max(a, b) - Math.min(a, b) + 1)) + Math.min(a, b);
};
const clampInt = (v, fallback, min, max) => {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

// page.evaluate() has no timeout of its own: a navigation can leave the call
// pending forever. Every DOM probe is therefore raced against a timer.
function withTimeout(promise, ms, fallback) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

function normalizeRandomClickConfig(raw = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const burstMin = clampInt(r.burstMin, 3, 1, 50);
  const burstMax = Math.max(burstMin, clampInt(r.burstMax, burstMin, 1, 50));
  const intervalMinSec = clampInt(r.intervalMinSec, 5, 1, 3600);
  const intervalMaxSec = Math.max(intervalMinSec, clampInt(r.intervalMaxSec, intervalMinSec, 1, 3600));
  const refreshMinSec = clampInt(r.refreshMinSec, 30, 5, 7200);
  const refreshMaxSec = Math.max(refreshMinSec, clampInt(r.refreshMaxSec, refreshMinSec, 5, 7200));
  const clickGapMinMs = clampInt(r.clickGapMinMs, 250, 50, 60000);
  const clickGapMaxMs = Math.max(clickGapMinMs, clampInt(r.clickGapMaxMs, Math.max(clickGapMinMs, 650), 50, 60000));
  const dir = String(r.scrollDirection || 'down').toLowerCase();
  return {
    enabled: !!r.enabled,
    // First click after this many seconds (lets the landing page settle).
    initialDelaySec: clampInt(r.initialDelaySec, 2, 0, 600),
    burstMin,
    burstMax,
    // Gap between clicks inside one burst.
    clickGapMinMs,
    clickGapMaxMs,
    intervalMinSec,
    intervalMaxSec,
    // 0 = unlimited (the session's own visit time is the real limit)
    maxClicks: clampInt(r.maxClicks, 0, 0, 1000000),
    scrollEnabled: r.scrollEnabled !== false,
    scrollDirection: ['down', 'up', 'random'].includes(dir) ? dir : 'down',
    scrollAmountPx: clampInt(r.scrollAmountPx, 600, 50, 20000),
    refreshEnabled: !!r.refreshEnabled,
    refreshMinSec,
    refreshMaxSec,
    // Keep the campaign / replay page on its original URL. If a random click
    // still managed to navigate the same tab, go back to the page that was
    // being visited. Recommended ON.
    revertNavigation: r.revertNavigation !== false,
    // Links/popups are opened in background tabs (never steal focus).
    openInBackground: r.openInBackground !== false,
    // How many links a single click may open (ad scripts sometimes open two).
    maxLinksPerClick: clampInt(r.maxLinksPerClick, 2, 1, 6),
    // 5.9.3 "Only click ads": instead of clicking random viewport points, find
    // ad slots that are actually rendered (visible iframe creatives, sponsored
    // cards, marked ad units) and click those only. Empty / hidden / 1x1
    // tracking slots and plain whitespace are never clicked, which looks much
    // more like a real visitor and keeps invalid-traffic signals low.
    adOnly: !!r.adOnly,
    // A slot smaller than this is treated as a tracking pixel, not a creative.
    adMinWidth: clampInt(r.adMinWidth, 60, 20, 2000),
    adMinHeight: clampInt(r.adMinHeight, 30, 10, 2000),
  };
}

async function viewportSize(page) {
  const size = await withTimeout(
    page.evaluate(() => ({ w: window.innerWidth || 1280, h: window.innerHeight || 800 })).catch(() => null),
    4000,
    null
  );
  let w = size && size.w ? size.w : 0;
  let h = size && size.h ? size.h : 0;
  if (!w || !h) {
    try {
      const vp = page.viewportSize && page.viewportSize();
      if (vp) {
        w = vp.width;
        h = vp.height;
      }
    } catch (_) {}
  }
  return { w: w || 1280, h: h || 800 };
}

// Injected into every document / frame the clicker drives. While the flag is
// set:
//   * an anchor click is cancelled and its destination is queued;
//   * window.open() is intercepted and its destination is queued instead of
//     opening a foreground tab.
// Node drains the queue and opens the links with CDP background targets, so
// the page that is being visited never loses focus.
function backgroundLinkShield() {
  if (window.__rcShieldInstalled) return;
  window.__rcShieldInstalled = true;
  window.__rcForceNewTab = false;
  window.__rcPendingLinks = [];

  const normalize = (href) => {
    try {
      const u = new URL(String(href), location.href);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
      return u.href;
    } catch (_) {
      return '';
    }
  };

  const enqueue = (href) => {
    const url = normalize(href);
    if (!url) return false;
    const list = window.__rcPendingLinks;
    if (list.length >= 15) return false;
    if (!list.length || list[list.length - 1] !== url) list.push(url);
    return true;
  };

  window.__rcEnqueueLink = enqueue;
  window.__rcTakeLinks = function () {
    const out = window.__rcPendingLinks.slice();
    window.__rcPendingLinks.length = 0;
    return out;
  };

  // Intercept actual link clicks (capture phase, before the page's handlers).
  document.addEventListener(
    'click',
    (e) => {
      if (!window.__rcForceNewTab) return;
      let anchor = null;
      try {
        const path = e.composedPath ? e.composedPath() : [];
        for (const el of path) {
          if (el && el.tagName === 'A' && el.href) {
            anchor = el;
            break;
          }
        }
        if (!anchor) {
          const target = e.target;
          if (target && target.closest) anchor = target.closest('a[href]');
        }
      } catch (_) {}
      if (!anchor) return;
      try {
        if (anchor.getAttribute('download') !== null) return;
        if (!enqueue(anchor.href)) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        e.stopPropagation();
      } catch (_) {}
    },
    true
  );

  // Intercept window.open() / popunders while the flag is set.
  try {
    const origOpen = window.open;
    if (origOpen && !origOpen.__rcPatched) {
      const patched = function (url) {
        if (window.__rcForceNewTab && url) {
          let href = '';
          try {
            href = String(url);
          } catch (_) {}
          if (href && enqueue(href)) {
            // Popunder scripts expect a window-like object back.
            return {
              closed: false,
              opener: null,
              focus() {},
              blur() {},
              close() {
                this.closed = true;
              },
              postMessage() {},
              moveTo() {},
              resizeTo() {},
              document: {
                write() {},
                writeln() {},
                close() {},
                open() {},
                get body() {
                  return null;
                },
              },
              location: {
                href,
                assign() {},
                replace() {},
                reload() {},
              },
            };
          }
        }
        return origOpen.apply(window, arguments);
      };
      patched.__rcPatched = true;
      try {
        window.open = patched;
      } catch (_) {}
    }
  } catch (_) {}
}

async function ensureClickShield(page) {
  const shieldedPages = ensureClickShield._pages || (ensureClickShield._pages = new WeakSet());
  if (shieldedPages.has(page)) {
    const installed = await withTimeout(
      page
        .evaluate(() => {
          try {
            return !!window.__rcShieldInstalled;
          } catch (_) {
            return false;
          }
        })
        .catch(() => false),
      900,
      false
    );
    if (installed) return;
  }
  try {
    await page.addInitScript(backgroundLinkShield);
    shieldedPages.add(page);
  } catch (_) {}
  // addInitScript covers future documents; install it in the current document
  // and in every current iframe too (ads often live inside an iframe).
  let frames = [];
  try {
    frames = page.frames();
  } catch (_) {
    frames = [];
  }
  if (!frames.length) {
    try {
      frames = [page.mainFrame()];
    } catch (_) {}
  }
  await Promise.allSettled(
    frames.map((f) =>
      withTimeout(f.evaluate(backgroundLinkShield).catch(() => {}), 1500, null)
    )
  );
}

async function setForceNewTab(page, value) {
  let frames = [];
  try {
    frames = page.frames();
  } catch (_) {
    frames = [];
  }
  if (!frames.length) {
    try {
      frames = [page.mainFrame()];
    } catch (_) {}
  }
  await Promise.allSettled(
    frames.map((f) =>
      withTimeout(
        f
          .evaluate((v) => {
            window.__rcForceNewTab = !!v;
          }, value)
          .catch(() => {}),
        1200,
        null
      )
    )
  );
}

// Reads and clears the background-link queue from every frame of `page`.
async function drainPendingLinks(page) {
  const out = [];
  let frames = [];
  try {
    frames = page.frames();
  } catch (_) {
    frames = [];
  }
  if (!frames.length) {
    try {
      frames = [page.mainFrame()];
    } catch (_) {}
  }
  for (const frame of frames) {
    try {
      const links = await withTimeout(
        frame.evaluate(() => {
          try {
            return (window.__rcTakeLinks ? window.__rcTakeLinks() : []) || [];
          } catch (_) {
            return [];
          }
        }),
        900,
        []
      );
      if (Array.isArray(links)) {
        for (const l of links) {
          if (l && /^https?:/i.test(String(l))) out.push(String(l));
        }
      }
    } catch (_) {}
  }
  return out;
}

// If a popup/ad took focus, make the page we are working on active again.
// Background tabs are left open - only focus changes. In headless mode this is
// a no-op (all pages report visible). `force` skips the visibility probe, which
// is unreliable in headed Chromium (every tab reports "visible" there); it is
// used only right after a foreground popup / fallback tab appeared, never on a
// timer, so the user's other windows are not disturbed.
async function refocusMain(page, force = false) {
  try {
    if (!page || page.isClosed()) return;
  } catch (_) {
    return;
  }
  if (!force) {
    const visibility = await withTimeout(
      page
        .evaluate(() => {
          try {
            return document.visibilityState;
          } catch (_) {
            return '';
          }
        })
        .catch(() => ''),
      900,
      'timeout'
    );
    if (visibility === 'visible') return;
  }
  try {
    await withTimeout(page.bringToFront().catch(() => {}), 2000, null);
  } catch (_) {}
}

// Opens `url` in a real Chromium tab that is created in the BACKGROUND. The
// page that called us keeps focus, so Back / reading / typing all keep working.
async function openBackgroundTab(context, mainPage, url, opts = {}) {
  if (!context || !url) return null;
  const onLog = typeof opts.onLog === 'function' ? opts.onLog : () => {};
  const sessionId = opts.sessionId || 'Session';

  let cdp = null;
  let created = null;
  const newPages = [];
  const onPage = (p) => {
    try {
      newPages.push(p);
    } catch (_) {}
  };

  try {
    try {
      context.on('page', onPage);
    } catch (_) {}
    try {
      cdp = await context.newCDPSession(mainPage);
    } catch (_) {
      cdp = null;
    }
    if (cdp) {
      // The browserContextId keeps the new tab inside the SAME cookie / proxy
      // context as the campaign (important for incognito contexts).
      let browserContextId = '';
      try {
        const info = await cdp.send('Target.getTargetInfo');
        browserContextId =
          (info && info.targetInfo && info.targetInfo.browserContextId) || '';
      } catch (_) {}
      const params = { url: 'about:blank', background: true };
      if (browserContextId) params.browserContextId = browserContextId;
      try {
        await cdp.send('Target.createTarget', params);
      } catch (_) {
        try {
          await cdp.send('Target.createTarget', { url: 'about:blank', background: true });
        } catch (_) {}
      }
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline && !created) {
        for (const p of newPages) {
          try {
            if (!p.isClosed()) {
              created = p;
              break;
            }
          } catch (_) {}
        }
        if (!created) await sleep(50);
      }
    }
  } catch (_) {
  } finally {
    try {
      context.off('page', onPage);
    } catch (_) {}
    try {
      if (cdp) await cdp.detach();
    } catch (_) {}
  }

  if (created) {
    try {
      created.__rcBackgroundTab = true;
    } catch (_) {}
    // Some ad pages call focus() on themselves. Ignore it so the visited page
    // keeps the foreground.
    try {
      await created.addInitScript(() => {
        try {
          window.focus = function () {};
        } catch (_) {}
        try {
          window.blur = function () {};
        } catch (_) {}
      });
    } catch (_) {}
    try {
      await created.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (_) {}
    onLog(`[${sessionId}] Link opened in background tab: ${String(url).slice(0, 70)}`, 'info');
    return created;
  }

  // Fallback: a normal new page, then put the visited page back in front.
  try {
    const p = await context.newPage();
    try {
      p.__rcBackgroundTab = true;
    } catch (_) {}
    try {
      await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (_) {}
    // context.newPage() activates the tab, so force the visited page back to
    // the front (the visibility probe is unreliable in headed Chromium).
    await refocusMain(mainPage, true);
    onLog(`[${sessionId}] Link opened in background tab (fallback): ${String(url).slice(0, 70)}`, 'info');
    return p;
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// "Only click ads" (5.9.3)
//
// Real visitors click the ad that is in front of them, not the page background.
// This scanner collects the ad slots a visitor could actually click:
//   * iframes whose src / container belongs to a known ad network, or that are
//     marked as an ad slot by id / class / data-ad* attributes;
//   * native "SPONSORED" / "Advertisement" cards that wrap a real link;
//   * adsbygoogle / GPT ([id^="div-gpt-ad"]) units.
// A slot is only returned when it is visible, big enough to be a creative (not
// a 1x1 tracker), has rendered content (same-origin slots only) and sits inside
// the viewport once scrolled to. Nothing is injected into the DOM: the element
// is addressed by a stable CSS path, so the page cannot notice a clicker.
// ---------------------------------------------------------------------------
// Runs inside the page. Must stay self-contained (serialized by evaluate()).
function pageScanAdSlots(args) {
  const opts = args || {};
  const minW = opts.minWidth || 60;
  const minH = opts.minHeight || 30;
  const maxSlots = opts.max || 14;
  // Kept inside the page function: evaluate() serializes this function alone,
  // so module-level constants are not available here.
  const AD_HOST = /(adsterra|highperformanceformat|profitableratecpm|monetag|popads|popcash|propellerads|onclickads|onclickmax|hilltopads|exoclick|juicyads|trafficjunky|adcash|clickadu|adnium|trafficstars|tsyndicate|ad-?maven|bidvertiser|mgid|revcontent|taboola|outbrain|zedo|media\.net|amazon-adsystem|doubleclick|googlesyndication|googleadservices|adservice\.google|serving-sys|smartadserver|adform|criteo|pubmatic|rubiconproject|openx|casalemedia|33across|sharethrough|teads|spotx|springserve|adroll|quantserve|scorecardresearch|adx|adsrvr|yieldmo|smaato|inmobi|applovin|unityads|vungle|chartboost|ironsrc|adcolony|tapjoy|fyber|adkernel|adnxs|appnexus|pubnative|moatads|doubleverify|adsafeprotected|agkn|rlcdn|crwdcntrl|bluekai|demdex|everesttech|mathtag|tapad|sitescout|bidswitch|tremor|districtm|gumgum|sovrn|lijit|indexww|ezoic|monumetric|mediavine|raptive|freestar|snigel|setupad|playwire|venatus|nitropay|adplugg)/i;

  const AD_ATTR = /(^|[-_\s])(ads?|adv|advert|advertisement|advertising|adslot|adunit|adbox|adcontainer|adsense|adsbygoogle|sponsor|sponsored|dfp|gpt)([-_\s]|$)/i;
  const AD_TEXT = /(sponsored|advertisement|adchoices|promoted|anzeige)/i;
  // Real embeds that are not ads: never click these even if the container has
  // an "ad" class (many themes reuse one wrapper for all third-party embeds).
  const EMBED_BLOCK = /(recaptcha|youtube(-nocookie)?\.com\/embed|player\.vimeo|google\.com\/maps|maps\.google|disqus|facebook\.com\/plugins|platform\.twitter|instagram\.com\/embed|openstreetmap|calendly|stripe\.com|js\.stripe|paypal\.com)/i;

  const out = [];
  const used = [];

  const abs = (u) => {
    try {
      return new URL(String(u || ''), location.href).href;
    } catch (_) {
      return '';
    }
  };
  const isHttp = (u) => /^https?:/i.test(String(u || ''));
  const hostOf = (u) => {
    try {
      return new URL(String(u), location.href).hostname.replace(/^www\./i, '');
    } catch (_) {
      return String(u || '').slice(0, 40);
    }
  };
  const classText = (el) => {
    try {
      if (!el) return '';
      if (typeof el.className === 'string') return el.className;
      return el.getAttribute ? el.getAttribute('class') || '' : '';
    } catch (_) {
      return '';
    }
  };
  const attrsOf = (el, depth) => {
    let text = '';
    let node = el;
    for (let i = 0; node && node.nodeType === 1 && i <= depth; i++) {
      try {
        text += ' ' + (node.id || '') + ' ' + classText(node) + ' ';
        const names = ['data-ad', 'data-ad-slot', 'data-ad-client', 'data-ad-unit',
          'data-google-query-id', 'aria-label', 'name', 'title', 'role'];
        for (const n of names) {
          const v = node.getAttribute ? node.getAttribute(n) : '';
          if (v) text += ' ' + v + ' ';
        }
      } catch (_) {}
      node = node.parentElement;
    }
    return text;
  };
  const isVisible = (el, needW, needH) => {
    try {
      if (!el || !el.isConnected) return false;
      if (el.getAttribute && el.getAttribute('aria-hidden') === 'true') return false;
      const cs = getComputedStyle(el);
      if (!cs) return false;
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return false;
      if (parseFloat(cs.opacity || '1') <= 0.05) return false;
      // opacity is not inherited: a transparent card still gives its link a
      // computed opacity of 1, so walk the ancestors.
      let node = el.parentElement;
      for (let i = 0; node && node.nodeType === 1 && i < 5; i++) {
        const ps = getComputedStyle(node);
        if (ps) {
          if (ps.display === 'none') return false;
          if (ps.visibility === 'hidden' || ps.visibility === 'collapse') return false;
          if (parseFloat(ps.opacity || '1') <= 0.05) return false;
        }
        node = node.parentElement;
      }
      const r = el.getBoundingClientRect();
      return r.width >= (needW || minW) && r.height >= (needH || minH);
    } catch (_) {
      return false;
    }
  };
  const overlaps = (r) => {
    for (const u of used) {
      const ix = Math.max(0, Math.min(r.right, u.right) - Math.max(r.left, u.left));
      const iy = Math.max(0, Math.min(r.bottom, u.bottom) - Math.max(r.top, u.top));
      if (!ix || !iy) continue;
      const small = Math.min(r.width * r.height, u.width * u.height) || 1;
      if ((ix * iy) / small > 0.75) return true;
    }
    return false;
  };
  // Stable CSS path - no attribute is written on the page, so a site cannot
  // discover the clicker by diffing its DOM.
  const pathOf = (el) => {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 9) {
      try {
        if (node.id && /^[A-Za-z][\w-]*$/.test(node.id)) {
          parts.unshift('#' + node.id);
          break;
        }
      } catch (_) {}
      let sel = String(node.tagName || '').toLowerCase();
      if (!sel) break;
      const cls = classText(node).trim().split(/\s+/)
        .filter((c) => /^[A-Za-z][\w-]*$/.test(c))
        .slice(0, 2);
      if (cls.length) sel += '.' + cls.join('.');
      const parent = node.parentElement;
      if (parent) {
        const same = Array.prototype.filter.call(parent.children, (c) => c.tagName === node.tagName);
        if (same.length > 1) sel += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
      }
      parts.unshift(sel);
      node = parent;
    }
    return parts.join(' > ');
  };
  const push = (el, kind, label, contentOk, container) => {
    if (out.length >= maxSlots) return;
    // A native card's link is only as tall as its text; the card around it is
    // the ad. Clicks still land on the link itself, but the card has to be a
    // real creative-sized block.
    const isElement = kind === 'element';
    const needW = isElement ? Math.min(minW, 14) : minW;
    const needH = isElement ? Math.min(minH, 8) : minH;
    if (!isVisible(el, needW, needH)) return;
    if (isElement && container && container !== el) {
      if (!isVisible(container, minW, minH)) return;
    }
    let r;
    try {
      r = el.getBoundingClientRect();
    } catch (_) {
      return;
    }
    if (r.width < needW || r.height < needH) return;
    if (overlaps(r)) return;
    const sel = pathOf(el);
    if (!sel) return;
    used.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height });
    out.push({
      sel,
      kind,
      label: String(label || '').slice(0, 48),
      x: Math.round(r.left),
      y: Math.round(r.top),
      w: Math.round(r.width),
      h: Math.round(r.height),
      contentOk: contentOk === undefined ? null : contentOk,
    });
  };
  const pickClickable = (el) => {
    const hrefOf = (a) => {
      try {
        const h = abs(a.getAttribute('href'));
        return isHttp(h) ? h : '';
      } catch (_) {
        return '';
      }
    };
    try {
      if (el.tagName === 'A') {
        const h = hrefOf(el);
        if (h) return { el, href: h };
      }
      const inner = el.querySelector('a[href]');
      if (inner) {
        const h = hrefOf(inner);
        if (h) return { el: inner, href: h };
      }
      const outer = el.closest ? el.closest('a[href]') : null;
      if (outer) {
        const h = hrefOf(outer);
        if (h) return { el: outer, href: h };
      }
      const role = el.getAttribute && (el.getAttribute('role') || '');
      if (role === 'link' || (el.getAttribute && el.hasAttribute('onclick'))) {
        return { el, href: '' };
      }
    } catch (_) {}
    return null;
  };

  // 1) iframes: the shape every display network (Adsterra, Monetag, ...) uses.
  let frames = [];
  try {
    frames = Array.prototype.slice.call(document.querySelectorAll('iframe, frame'));
  } catch (_) {}
  for (const el of frames) {
    if (!el || !el.isConnected) continue;
    let src = '';
    let srcdoc = '';
    try {
      src = el.getAttribute('src') || '';
      srcdoc = el.getAttribute('srcdoc') || '';
    } catch (_) {}
    if (EMBED_BLOCK.test(src)) continue;
    const attrText = attrsOf(el, 3);
    const knownNetwork = AD_HOST.test(src) || AD_HOST.test(srcdoc);
    const marked = AD_ATTR.test(attrText);
    if (!knownNetwork && !marked) continue;
    let contentOk = null;
    try {
      const doc = el.contentDocument;
      if (doc) {
        const body = doc.body;
        const text = body ? String(body.textContent || '').trim() : '';
        const kids = body ? body.children.length : 0;
        const media = doc.querySelector('img,video,canvas,iframe,svg,picture,object,embed');
        contentOk = !!(kids > 0 || text.length > 2 || media);
      }
    } catch (_) {
      contentOk = null; // cross-origin: verified from Node instead
    }
    if (contentOk === false) continue; // blank / not filled slot
    push(el, 'frame', knownNetwork ? hostOf(src || srcdoc) : 'ad iframe', contentOk);
  }

  // 2) slots marked with ad attributes / classes, and native sponsored cards.
  let all = [];
  try {
    all = Array.prototype.slice.call(
      document.querySelectorAll('div,section,aside,article,figure,li,span,a,p,ins,ul')
    );
  } catch (_) {}

  for (const el of all) {
    if (out.length >= maxSlots) break;
    if (el.tagName === 'IFRAME') continue;
    const attrText = attrsOf(el, 1);
    if (!AD_ATTR.test(attrText)) continue;
    const picked = pickClickable(el);
    if (!picked) continue; // nothing clickable inside: not an ad creative
    push(picked.el, 'element', 'ad slot', null, el);
  }

  for (const el of all) {
    if (out.length >= maxSlots) break;
    if (el.tagName === 'IFRAME') continue;
    let text = '';
    try {
      text = String(el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
    } catch (_) {}
    if (!text || text.length > 120) continue;
    // The label must open the block ("SPONSORED / See today's offer"), not be
    // mentioned inside an article about advertising.
    if (!AD_TEXT.test(text.slice(0, 40))) continue;
    let descendants = 0;
    try {
      descendants = el.querySelectorAll('*').length;
    } catch (_) {}
    if (descendants > 9) continue; // a card, not a whole section
    const picked = pickClickable(el);
    if (!picked) continue;
    push(picked.el, 'element', text.slice(0, 32), null, el);
  }

  return out;
}

// Node side: drops cross-origin iframes that have no rendered content.
async function collectAdCandidates(page, opts = {}) {
  const cfg = opts.config || {};
  const minWidth = clampInt(cfg.adMinWidth, 60, 20, 2000);
  const minHeight = clampInt(cfg.adMinHeight, 30, 10, 2000);
  let list = [];
  try {
    list = await withTimeout(
      page.evaluate(pageScanAdSlots, { minWidth, minHeight, max: 14 }),
      6000,
      []
    );
  } catch (_) {
    list = [];
  }
  if (!Array.isArray(list) || !list.length) return [];

  const kept = [];
  let checks = 0;
  for (const c of list) {
    if (!c || typeof c.sel !== 'string' || !c.sel) continue;
    if (c.kind === 'frame' && c.contentOk === null && checks < 8) {
      checks++;
      let ok = true;
      let handle = null;
      try {
        handle = await page.$(c.sel);
        const frame = handle ? await handle.contentFrame() : null;
        if (frame) {
          ok = await withTimeout(
            frame
              .evaluate(() => {
                try {
                  const b = document.body;
                  if (!b) return false;
                  const txt = String(b.textContent || '').trim();
                  return (
                    b.children.length > 0 ||
                    txt.length > 1 ||
                    !!document.querySelector('img,video,canvas,iframe,svg,picture,object,embed')
                  );
                } catch (_) {
                  return true;
                }
              })
              .catch(() => true),
            1800,
            true
          );
        }
      } catch (_) {
        ok = true;
      } finally {
        if (handle) {
          try {
            await handle.dispose();
          } catch (_) {}
        }
      }
      if (!ok) continue;
    }
    kept.push(c);
  }
  return kept;
}

// Returns a click point inside the slot (viewport coordinates) or null.
async function adCandidatePoint(page, sel, opts = {}) {
  const res = await withTimeout(
    page
      .evaluate(
        ({ selector, doScroll }) => {
          const el = document.querySelector(selector);
          if (!el || !el.isConnected) return { ok: false, reason: 'gone' };
          if (doScroll) {
            try {
              el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
            } catch (_) {
              try {
                el.scrollIntoView(true);
              } catch (_) {}
            }
          }
          const r = el.getBoundingClientRect();
          const vw = window.innerWidth || 1280;
          const vh = window.innerHeight || 800;
          const left = Math.max(2, r.left);
          const right = Math.min(vw - 2, r.right);
          const top = Math.max(2, r.top);
          const bottom = Math.min(vh - 2, r.bottom);
          if (right - left < 12 || bottom - top < 10) return { ok: false, reason: 'offscreen' };
          const x = left + (right - left) * (0.28 + Math.random() * 0.44);
          const y = top + (bottom - top) * (0.28 + Math.random() * 0.44);
          let hit = null;
          try {
            hit = document.elementFromPoint(x, y);
          } catch (_) {}
          if (!hit) return { ok: false, reason: 'nohit' };
          let owns = hit === el || (el.contains && el.contains(hit));
          if (!owns && hit.closest) {
            const marked = hit.closest('[data-ad], ins.adsbygoogle, iframe');
            owns = !!(marked && (marked === el || (el.contains && el.contains(marked))));
          }
          if (!owns) return { ok: false, reason: 'covered' };
          return { ok: true, x, y };
        },
        { selector: sel, doScroll: opts.scroll !== false }
      )
      .catch(() => ({ ok: false, reason: 'eval' })),
    5000,
    { ok: false, reason: 'timeout' }
  );
  return res && res.ok ? res : null;
}

// Remembers recently clicked slots per page so one ad is not hammered while
// other ads on the page are still unseen.
const adClickMemory = new WeakMap();
function adMemoryFor(page) {
  let m = null;
  try {
    m = adClickMemory.get(page);
  } catch (_) {}
  if (!m) {
    m = new Map();
    try {
      adClickMemory.set(page, m);
    } catch (_) {}
  }
  return m;
}

// Click one rendered ad. Returns true when a click was dispatched.
async function adClickOnce(page, stats, opts = {}) {
  try {
    if (!page || page.isClosed()) return false;
  } catch (_) {
    return false;
  }
  const cfg = opts.config || {};
  const onLog = typeof opts.onLog === 'function' ? opts.onLog : () => {};
  const sessionId = opts.sessionId || 'Session';

  const candidates = await collectAdCandidates(page, { config: cfg });
  stats.adScans = (stats.adScans || 0) + 1;

  if (!candidates.length) {
    stats.adMisses = (stats.adMisses || 0) + 1;
    if (stats.adMisses === 1 || stats.adMisses % 10 === 0) {
      onLog(
        `[${sessionId}] Ad-only: no visible working ad on this page ` +
          `(scan ${stats.adScans}) - waiting, no click sent`,
        'warn'
      );
    }
    return false;
  }

  // Real people do not click every single ad. Skipping one now and then keeps
  // the click pattern irregular.
  if (candidates.length > 1 && Math.random() < 0.1) {
    stats.adSkips = (stats.adSkips || 0) + 1;
    return false;
  }

  const now = Date.now();
  const memory = adMemoryFor(page);
  if (memory.size > 200) memory.clear();
  const fresh = candidates.filter((c) => now - (memory.get(c.sel) || 0) > 45000);
  const pool = fresh.length ? fresh : candidates;
  const pick = pool[Math.floor(Math.random() * pool.length)];
  if (!pick) return false;

  // Scroll the ad into view first (like a reader noticing it), then pause.
  const scrolled = await adCandidatePoint(page, pick.sel, { scroll: true });
  if (!scrolled) {
    stats.adSkips = (stats.adSkips || 0) + 1;
    return false;
  }
  await sleep(rand(420, 1050));

  const point = await adCandidatePoint(page, pick.sel, { scroll: false });
  if (!point) {
    stats.adSkips = (stats.adSkips || 0) + 1;
    return false;
  }

  let beforeUrl = '';
  try {
    beforeUrl = page.url();
  } catch (_) {}
  const beforePages = new Set();
  try {
    for (const p of page.context().pages()) beforePages.add(p);
  } catch (_) {}

  try {
    await ensureClickShield(page);
    await drainPendingLinks(page).catch(() => {});
    await setForceNewTab(page, true);

    // Human mouse path: coarse approach, small correction, then press.
    await withTimeout(
      page.mouse
        .move(point.x + rand(-22, 22), point.y + rand(-18, 18), { steps: rand(4, 9) })
        .catch(() => {}),
      5000,
      null
    );
    await sleep(rand(90, 260));
    await withTimeout(
      page.mouse.move(point.x + rand(-2, 2), point.y + rand(-2, 2), { steps: rand(6, 14) }).catch(() => {}),
      5000,
      null
    );
    await sleep(rand(110, 340));
    await withTimeout(
      page.mouse.click(point.x, point.y, { delay: rand(35, 115), button: 'left' }).catch(() => {}),
      9000,
      null
    );

    stats.clicks++;
    stats.adClicks = (stats.adClicks || 0) + 1;
    stats.lastClickAt = Date.now();
    stats.lastPoint = { x: point.x, y: point.y };
    stats.lastAd = pick.label || pick.kind;
    memory.set(pick.sel, Date.now());

    // Move away afterwards, then let the ad handlers / popunder timers run.
    try {
      await page.mouse.move(point.x + rand(40, 160), point.y + rand(25, 120), { steps: rand(3, 7) });
    } catch (_) {}
    return await settleAfterClick(page, stats, opts, { beforeUrl, beforePages });
  } catch (_) {
    return false;
  } finally {
    try {
      if (!page.isClosed()) await setForceNewTab(page, false);
    } catch (_) {}
  }
}

// Shared "what happened after the mouse click" handling: collect links the
// shield captured, open them in background tabs, keep the visited page in
// front, and go back if the click navigated the tab itself.
async function settleAfterClick(page, stats, opts, before = {}) {
  const cfg = opts.config || {};
  const onLog = typeof opts.onLog === 'function' ? opts.onLog : () => {};
  const sessionId = opts.sessionId || 'Session';
  const maxLinks = clampInt(cfg.maxLinksPerClick, 2, 1, 6);
  const beforeUrl = before.beforeUrl || '';
  const beforePages = before.beforePages || new Set();

  let openBackground = opts.openBackground;
  if (typeof openBackground !== 'function') {
    openBackground = (href) => openBackgroundTab(page.context(), page, href, { onLog, sessionId });
  }

  await sleep(cfg.adOnly ? rand(300, 650) : rand(220, 480));
  const links = await drainPendingLinks(page);
  await setForceNewTab(page, false);

  const seen = new Set();
  let openedNow = 0;
  for (const href of links) {
    if (openedNow >= maxLinks) break;
    if (seen.has(href)) continue;
    seen.add(href);
    let opened = null;
    try {
      opened = await openBackground(href);
    } catch (_) {}
    openedNow++;
    if (opened) {
      stats.newTabs = (stats.newTabs || 0) + 1;
      try {
        stats.lastNewTab = opened.url() || href;
      } catch (_) {
        stats.lastNewTab = href;
      }
      if (typeof opts.onNewTabs === 'function') {
        try {
          opts.onNewTabs([opened]);
        } catch (_) {}
      }
    }
  }

  // Tabs opened natively (a popunder that bypassed the shield).
  let context = null;
  try {
    context = page.context();
  } catch (_) {}
  let nativeOpened = 0;
  if (context) {
    let opened = [];
    try {
      opened = context.pages().filter((p) => {
        try {
          return (
            !beforePages.has(p) &&
            !p.isClosed() &&
            !p.__rcBackgroundTab &&
            !p.__rcCountedByClicker
          );
        } catch (_) {
          return false;
        }
      });
    } catch (_) {}
    if (opened.length) {
      for (const p of opened) {
        try {
          p.__rcCountedByClicker = true;
        } catch (_) {}
      }
      stats.newTabs = (stats.newTabs || 0) + opened.length;
      nativeOpened = opened.length;
      try {
        stats.lastNewTab = opened[opened.length - 1].url() || stats.lastNewTab;
      } catch (_) {}
    }
  }

  await refocusMain(page, nativeOpened > 0);

  let afterUrl = '';
  try {
    afterUrl = page.url();
  } catch (_) {}
  if (afterUrl && beforeUrl && afterUrl !== beforeUrl) {
    stats.navigations++;
    stats.lastNavigatedTo = afterUrl;
    if (cfg.revertNavigation !== false) {
      try {
        const back = await withTimeout(
          page.goBack({ waitUntil: 'domcontentloaded', timeout: 12000 }).catch(() => null),
          15000,
          null
        );
        if (back) {
          stats.revertedNavigations = (stats.revertedNavigations || 0) + 1;
          await refocusMain(page);
        }
      } catch (_) {}
    }
  }
  return true;
}

// Clicks one random point in the viewport. Returns true when the click was
// dispatched. Never throws.
async function randomClickOnce(page, stats, opts = {}) {
  try {
    if (!page || page.isClosed()) return false;
  } catch (_) {
    return false;
  }

  const cfg = opts.config || {};
  const onLog = typeof opts.onLog === 'function' ? opts.onLog : () => {};
  const sessionId = opts.sessionId || 'Session';
  const openBackground =
    typeof opts.openBackground === 'function'
      ? opts.openBackground
      : (href) => openBackgroundTab(page.context(), page, href, { onLog, sessionId });

  // "Only click ads": never send a click to empty page space.
  if (cfg.adOnly) {
    return adClickOnce(
      page,
      stats,
      Object.assign({}, opts, { config: cfg, onLog, sessionId, openBackground })
    );
  }

  const { w, h } = await viewportSize(page);
  // Keep away from the outer 4% so we never hit the OS window edge.
  const padX = Math.max(8, Math.round(w * 0.04));
  const padY = Math.max(8, Math.round(h * 0.04));
  const x = rand(padX, Math.max(padX + 1, w - padX));
  const y = rand(padY, Math.max(padY + 1, h - padY));

  let beforeUrl = '';
  try {
    beforeUrl = page.url();
  } catch (_) {}

  let context = null;
  const beforePages = new Set();
  try {
    context = page.context();
    for (const p of context.pages()) beforePages.add(p);
  } catch (_) {}

  try {
    await ensureClickShield(page);
    // Drop anything a previous navigation left in the queue.
    await drainPendingLinks(page).catch(() => {});
    await setForceNewTab(page, true);

    // Move first (more human), then click.
    await withTimeout(
      page.mouse.move(x + rand(-4, 4), y + rand(-3, 3), { steps: rand(3, 8) }).catch(() => {}),
      5000,
      null
    );
    await withTimeout(page.mouse.click(x, y, { delay: rand(20, 90) }).catch(() => {}), 8000, null);
    stats.clicks++;
    stats.lastClickAt = Date.now();
    stats.lastPoint = { x, y };

    // Let click handlers / popunder timers run, then collect their links.
    return await settleAfterClick(
      page,
      stats,
      Object.assign({}, opts, { config: cfg, onLog, sessionId, openBackground }),
      { beforeUrl, beforePages }
    );
  } catch (_) {
    return false;
  } finally {
    try {
      if (!page.isClosed()) await setForceNewTab(page, false);
    } catch (_) {}
  }
}

async function randomScrollOnce(page, cfg, stats) {
  const direction =
    cfg.scrollDirection === 'random'
      ? Math.random() < 0.78
        ? 'down'
        : 'up'
      : cfg.scrollDirection;
  const amount = Math.round(cfg.scrollAmountPx * (0.7 + Math.random() * 0.6));
  const delta = direction === 'up' ? -amount : amount;
  try {
    if (page.isClosed()) return false;
  } catch (_) {
    return false;
  }
  try {
    await withTimeout(
      page
        .evaluate((dy) => {
          try {
            window.scrollBy({ top: dy, left: 0, behavior: 'smooth' });
          } catch (_) {
            window.scrollBy(0, dy);
          }
        }, delta)
        .catch(() => {}),
      6000,
      null
    );
    stats.scrolls++;
    await sleep(rand(350, 900));
    return true;
  } catch (_) {
    return false;
  }
}

async function randomRefreshOnce(page, sessionId, onLog) {
  try {
    if (page.isClosed()) return false;
  } catch (_) {
    return false;
  }
  try {
    onLog(`[${sessionId}] Random refresh`, 'info');
    await withTimeout(
      page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {}),
      50000,
      null
    );
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Starts the random clicker on `page`.
 *
 * @param {import('playwright').Page} page  initial page to click on
 * @param {{
 *   config?: object,
 *   sessionId?: string,
 *   onLog?: (msg: string, type?: string) => void,
 *   isStopped?: () => boolean,
 *   tabLifeMs?: number,
 *   maxExtraTabs?: number,
 *   manageNewPages?: boolean,
 * }} opts
 * @returns {{ stop: Function, pause: Function, resume: Function,
 *   setActivePage: Function, getActivePage: Function, getStats: Function }}
 */
function startRandomClicker(page, opts = {}) {
  const cfg = normalizeRandomClickConfig(opts.config || opts);
  const onLog = typeof opts.onLog === 'function' ? opts.onLog : () => {};
  const sessionId = opts.sessionId || 'Session';
  const isStopped = typeof opts.isStopped === 'function' ? opts.isStopped : () => false;

  const stats = {
    clicks: 0,
    bursts: 0,
    scrolls: 0,
    refreshes: 0,
    navigations: 0,
    revertedNavigations: 0,
    newTabs: 0,
    // ad-only mode counters
    adScans: 0,
    adClicks: 0,
    adSkips: 0,
    adMisses: 0,
    lastAd: '',
    startedAt: Date.now(),
    lastClickAt: 0,
    lastPoint: null,
    lastNavigatedTo: '',
    lastNewTab: '',
  };

  if (!cfg.enabled) {
    return {
      stop() {},
      pause() {},
      resume() {},
      setActivePage() {},
      getActivePage: () => page,
      getStats: () => stats,
      config: cfg,
      enabled: false,
    };
  }

  let stopped = false;
  let paused = false;
  let inFlight = false;
  let activePage = page;
  const timers = new Set();
  const wakeups = new Set();
  let nextRefreshAt = cfg.refreshEnabled
    ? Date.now() + rand(cfg.refreshMinSec, cfg.refreshMaxSec) * 1000
    : 0;

  const getActivePage = () => {
    try {
      if (activePage && !activePage.isClosed()) return activePage;
    } catch (_) {}
    try {
      if (page && !page.isClosed()) return page;
    } catch (_) {}
    return activePage || page;
  };

  // --- Background tab management -----------------------------------------
  // Background ad tabs stay alive (their view timer needs time), but they never
  // take focus. Only a small number are kept so a long session cannot eat
  // gigabytes of RAM.
  let clickContext = null;
  try {
    clickContext = page.context();
  } catch (_) {}
  const tabLifeMs = clampInt(opts.tabLifeMs, 30000, 5000, 180000);
  const maxExtraTabs = clampInt(opts.maxExtraTabs, 10, 1, 20);
  const manageNewPages = opts.manageNewPages !== false;
  const backgroundTabs = new Map(); // page -> close timer

  const scheduleTabClose = (p) => {
    if (!p || p === getActivePage() || backgroundTabs.has(p)) return;
    const timer = setTimeout(async () => {
      backgroundTabs.delete(p);
      try {
        if (p.isClosed()) return;
        onLog(`[${sessionId}] Closing background ad tab after ${Math.round(tabLifeMs / 1000)}s`, 'info');
        await p.close({ runBeforeUnload: false }).catch(() => {});
      } catch (_) {}
    }, tabLifeMs);
    if (timer.unref) timer.unref();
    backgroundTabs.set(p, timer);
    try {
      p.once('close', () => {
        const t = backgroundTabs.get(p);
        if (t) clearTimeout(t);
        backgroundTabs.delete(p);
      });
    } catch (_) {}
  };

  // Keep the browser light: only the oldest extras are closed early; the rest
  // keep their full view time.
  const enforceTabBudget = () => {
    try {
      const live = Array.from(backgroundTabs.keys()).filter((x) => {
        try {
          return !x.isClosed();
        } catch (_) {
          return false;
        }
      });
      while (live.length >= maxExtraTabs) {
        const old = live.shift();
        const t = backgroundTabs.get(old);
        if (t) clearTimeout(t);
        backgroundTabs.delete(old);
        try {
          onLog(`[${sessionId}] Closing oldest background tab (${maxExtraTabs} tab limit)`, 'info');
          old.close({ runBeforeUnload: false }).catch(() => {});
        } catch (_) {}
      }
    } catch (_) {}
  };

  const onNewPage = (p) => {
    try {
      if (!p || p === page || p === getActivePage() || backgroundTabs.has(p)) return;
      if (p.isClosed()) return;
      if (stopped) return;
    } catch (_) {
      return;
    }
    if (!manageNewPages) {
      // RPA owns its recorded tabs (a recorded click is supposed to open its
      // popup in front). Random-click background tabs are created through
      // openBackgroundTab and never go through this path.
      return;
    }

    let url = '';
    try {
      url = p.url() || 'about:blank';
    } catch (_) {}
    onLog(
      `[${sessionId}] New tab opened in background (${String(url).slice(0, 60)}) - main page kept active`,
      'info'
    );

    enforceTabBudget();
    scheduleTabClose(p);
    refocusMain(getActivePage()).catch(() => {});
  };

  if (clickContext) {
    try {
      clickContext.on('page', onNewPage);
    } catch (_) {}
  }
  // The shield must exist before the first click (current document + future).
  ensureClickShield(getActivePage()).catch(() => {});

  // Abortable sleep: stop()/pause() resolve it immediately so the loop can
  // react (and park) instead of sleeping through a long interval.
  const wait = (ms) =>
    new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(t);
        timers.delete(t);
        wakeups.delete(finish);
        resolve();
      };
      const t = setTimeout(finish, Math.max(0, ms));
      timers.add(t);
      wakeups.add(finish);
    });

  // pause() resolves once no click is physically in flight, so callers can
  // safely navigate (recorded RPA actions, internal links) without racing a
  // synthetic click.
  function pauseNow() {
    paused = true;
    for (const finish of [...wakeups]) finish();
    return new Promise((resolve) => {
      const deadline = Date.now() + 8000;
      const check = () => {
        if (stopped || !inFlight || Date.now() >= deadline) {
          resolve();
          return;
        }
        setTimeout(check, 60);
      };
      check();
    });
  }

  async function pageReady(target) {
    try {
      if (!target || target.isClosed()) return false;
    } catch (_) {
      return false;
    }
    const state = await withTimeout(
      target
        .evaluate(() => {
          try {
            return document.readyState;
          } catch (_) {
            return 'complete';
          }
        })
        .catch(() => 'complete'),
      3500,
      'timeout'
    );
    return state !== 'timeout';
  }

  const openBackground = (href) => {
    const main = getActivePage();
    return openBackgroundTab(clickContext || (main && main.context()), main, href, {
      onLog,
      sessionId,
    }).then((p) => {
      if (p) {
        enforceTabBudget();
        scheduleTabClose(p);
        refocusMain(main).catch(() => {});
      }
      return p;
    });
  };

  async function loop() {
    // Let the landing page settle before the first burst.
    await wait(cfg.initialDelaySec * 1000 + rand(0, 800));

    while (!stopped && !isStopped()) {
      if (paused) {
        await wait(400);
        continue;
      }
      if (cfg.maxClicks && stats.clicks >= cfg.maxClicks) break;
      const target = getActivePage();
      if (!target || !(await pageReady(target))) {
        await wait(1000);
        continue;
      }

      const burst = rand(cfg.burstMin, cfg.burstMax);
      for (let i = 0; i < burst; i++) {
        if (stopped || paused || isStopped()) break;
        if (cfg.maxClicks && stats.clicks >= cfg.maxClicks) break;
        const clickPage = getActivePage();
        if (!clickPage) break;
        inFlight = true;
        try {
          await randomClickOnce(clickPage, stats, {
            config: cfg,
            onLog,
            sessionId,
            openBackground,
            onNewTabs: opts.onNewTabs,
          });
        } finally {
          inFlight = false;
        }
        await wait(rand(cfg.clickGapMinMs, cfg.clickGapMaxMs));
      }
      stats.bursts++;

      const scrollPage = getActivePage();
      if (cfg.scrollEnabled && scrollPage && !stopped && !paused) {
        await randomScrollOnce(scrollPage, cfg, stats);
      }

      if (cfg.refreshEnabled && !stopped && !paused && Date.now() >= nextRefreshAt) {
        const refreshPage = getActivePage();
        await refocusMain(refreshPage);
        await randomRefreshOnce(refreshPage, sessionId, onLog);
        stats.refreshes++;
        await refocusMain(refreshPage);
        nextRefreshAt = Date.now() + rand(cfg.refreshMinSec, cfg.refreshMaxSec) * 1000;
      }

      // A pause in the middle of a burst must not end the clicker: the next
      // loop iteration parks in the `if (paused)` branch until resume().
      if (stopped || isStopped()) break;

      onLog(
        `[${sessionId}] Random clicks: burst ${stats.bursts} (${stats.clicks} clicks total` +
          (cfg.adOnly
            ? `, ${stats.adClicks || 0} ad clicks, ${stats.adSkips || 0} skipped, ${stats.adMisses || 0} empty`
            : '') +
          (cfg.scrollEnabled ? `, ${stats.scrolls} scrolls` : '') +
          (stats.navigations ? `, ${stats.navigations} page changes` : '') +
          (stats.newTabs ? `, ${stats.newTabs} background tabs` : '') +
          ')'
      );

      await wait(rand(cfg.intervalMinSec, cfg.intervalMaxSec) * 1000);
    }
  }

  loop().catch(() => {});

  return {
    stop() {
      stopped = true;
      paused = false;
      for (const finish of [...wakeups]) finish();
      for (const t of timers) clearTimeout(t);
      timers.clear();
      wakeups.clear();
      if (clickContext) {
        try {
          clickContext.off('page', onNewPage);
        } catch (_) {}
      }
      for (const t of backgroundTabs.values()) {
        try {
          clearTimeout(t);
        } catch (_) {}
      }
      backgroundTabs.clear();
    },
    pause() {
      return pauseNow();
    },
    resume() {
      if (!stopped) paused = false;
    },
    // The clicker follows the tab the module/RPA is currently working on.
    setActivePage(p) {
      try {
        if (!p || p.isClosed()) return;
      } catch (_) {
        return;
      }
      activePage = p;
      ensureClickShield(p).catch(() => {});
    },
    getActivePage,
    getStats: () => stats,
    config: cfg,
    enabled: true,
  };
}

module.exports = {
  normalizeRandomClickConfig,
  startRandomClicker,
  randomClickOnce,
  adClickOnce,
  collectAdCandidates,
  randomScrollOnce,
  openBackgroundTab,
  drainPendingLinks,
  refocusMain,
};
