// PageGuard.js
// Shared runtime guards used by every traffic module.
//
//   1. installProxyErrorWatcher()
//      Watches the tab for Chrome's "This site can't be reached" page and
//      closes it immediately. The session then retries with a DIFFERENT proxy
//      instead of waiting 10+ seconds on a dead tunnel.
//
//   2. installPopupGuard() + waitForExtraTabs()
//      Ad popups / new tabs are NEVER closed while their view timer is
//      running. waitForExtraTabs() is called before the session closes the
//      browser so every ad tab gets its full minimum lifetime.
//
//   3. isVerifyPage() / autoHandleVerify()
//      Detects "Verify you are human" / "Just a moment" interstitials and
//      clicks the checkbox (or the widget / page middle) automatically.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Network level failures that mean "this proxy cannot open this site".
const PROXY_FAIL_CODES = new Set([
  'ERR_CONNECTION_RESET',
  'ERR_CONNECTION_CLOSED',
  'ERR_CONNECTION_ABORTED',
  'ERR_CONNECTION_REFUSED',
  'ERR_CONNECTION_TIMED_OUT',
  'ERR_CONNECTION_FAILED',
  'ERR_TUNNEL_CONNECTION_FAILED',
  'ERR_PROXY_CONNECTION_FAILED',
  'ERR_PROXY_AUTH_UNSUPPORTED',
  'ERR_EMPTY_RESPONSE',
  'ERR_SOCKET_NOT_CONNECTED',
  'ERR_NETWORK_CHANGED',
  'ERR_TIMED_OUT',
  'ERR_ADDRESS_UNREACHABLE',
  'ERR_NAME_NOT_RESOLVED',
  'ERR_SSL_PROTOCOL_ERROR',
  'ERR_SSL_VERSION_OR_CIPHER_MISMATCH',
  'ERR_CERT_AUTHORITY_INVALID',
  'ERR_HTTP2_PROTOCOL_ERROR',
  'ERR_QUIC_PROTOCOL_ERROR',
  'ERR_BLOCKED_BY_CLIENT',
  'ERR_BLOCKED_BY_RESPONSE',
]);

// Parses `net::ERR_XXX` out of a Playwright navigation error message.
function parseNetError(message) {
  const m = /net::(ERR_[A-Z0-9_]+)/.exec(String(message || ''));
  if (!m) return null;
  return PROXY_FAIL_CODES.has(m[1]) ? m[1] : null;
}

// Returns the error code when the tab is showing Chrome's network error page,
// otherwise null.
async function detectChromeErrorPage(page) {
  let url = '';
  try {
    if (page.isClosed()) return null;
    url = page.url() || '';
  } catch (_) {
    return null;
  }

  let isErrorPage = url.startsWith('chrome-error://') || url.startsWith('edge-error://');
  if (!isErrorPage) {
    // Cheap check — the marker element only exists on Chromium error pages.
    // Only trust it once the document has finished loading, so a page that is
    // still loading is never mistaken for an error page.
    const marker = await page
      .evaluate(() => {
        try {
          if (document.readyState !== 'complete') return false;
          return !!document.getElementById('main-frame-error');
        } catch (_) {
          return false;
        }
      })
      .catch(() => false);
    if (!marker) return null;
    isErrorPage = true;
  }
  if (!isErrorPage) return null;

  const code = await page
    .evaluate(() => {
      try {
        const el = document.querySelector('.error-code, #error-code');
        if (el && el.textContent) {
          const m = /(ERR_[A-Z0-9_]+)/.exec(el.textContent);
          if (m) return m[1];
        }
        const body = document.body ? document.body.innerText || '' : '';
        const m = /(ERR_[A-Z0-9_]+)/.exec(body);
        return m ? m[1] : '';
      } catch (_) {
        return '';
      }
    })
    .catch(() => '');

  return code || 'ERR_CONNECTION_FAILED';
}

// Watches a page and fires `onFailure(code)` once, then closes the tab.
// `ref` is a plain object the session can inspect ({ failed, code }).
//
// The watcher is deliberately conservative. A page is only treated as
// unreachable when Chrome's own error page has been sitting there, unchanged,
// with no navigation in flight, for confirmMs + graceMs. This stops ad
// redirects / Steam-style interstitials / slow proxy tunnels from being
// mistaken for a dead site and closed before they finish.
function installProxyErrorWatcher(page, opts = {}) {
  const {
    sessionId = 'Session',
    onLog = () => {},
    onFailure = () => {},
    ref = null,
    intervalMs = 500,
    // Error page must persist this long (default 6s) before we even start the
    // grace window. Slow redirect chains recover inside this window.
    confirmMs = 6000,
    // Extra patience after confirmation — if the page recovers in this window
    // we leave it alone.
    graceMs = 3000,
    // Ignore errors for a moment after a main-frame navigation has started.
    // While a new URL is loading, the old error page is still on screen and
    // must not be mistaken for the result of the new navigation.
    navQuietMs = 5000,
    // If an ad/popup tab is open, the main site clearly loaded once. Never
    // kill the browser (and the ad) because the main tab momentarily shows an
    // error during a redirect chain.
    ignoreWhenExtraTabs = true,
  } = opts;

  let stopped = false;
  let paused = false;
  let fired = false;
  let firstSeenAt = 0;
  let firstSeenUrl = '';
  let navQuietUntil = 0;

  const onRequest = (request) => {
    try {
      if (!request.isNavigationRequest()) return;
      if (request.frame() !== page.mainFrame()) return;
      navQuietUntil = Date.now() + navQuietMs;
      // A new navigation started: any previous error page is stale.
      firstSeenAt = 0;
      firstSeenUrl = '';
    } catch (_) {}
  };

  try {
    page.on('request', onRequest);
  } catch (_) {}

  async function loop() {
    while (!stopped) {
      await sleep(intervalMs);
      if (stopped) break;
      try {
        if (page.isClosed()) break;
      } catch (_) {
        break;
      }

      if (paused) {
        firstSeenAt = 0;
        continue;
      }
      if (Date.now() < navQuietUntil) {
        firstSeenAt = 0;
        continue;
      }

      if (ignoreWhenExtraTabs) {
        let extras = 0;
        try {
          const context = page.context();
          extras = context.pages().filter((p) => {
            try {
              return p !== page && !p.isClosed();
            } catch (_) {
              return false;
            }
          }).length;
        } catch (_) {
          extras = 0;
        }
        if (extras > 0) {
          firstSeenAt = 0;
          continue;
        }
      }

      let currentUrl = '';
      try {
        currentUrl = page.url() || '';
      } catch (_) {
        break;
      }

      const code = await detectChromeErrorPage(page);
      if (!code) {
        firstSeenAt = 0;
        firstSeenUrl = '';
        continue;
      }
      if (fired) continue;

      // Error page URL changed (another redirect) — restart the timer.
      if (firstSeenAt && currentUrl !== firstSeenUrl) {
        firstSeenAt = 0;
      }

      // First sighting — start the confirmation window.
      if (!firstSeenAt) {
        firstSeenAt = Date.now();
        firstSeenUrl = currentUrl;
        continue;
      }
      if (Date.now() - firstSeenAt < confirmMs) continue;

      // Grace window: give a slow/retrying navigation a chance to recover.
      await sleep(graceMs);
      if (stopped) break;
      try {
        if (page.isClosed()) break;
      } catch (_) {
        break;
      }
      if (Date.now() < navQuietUntil) {
        firstSeenAt = 0;
        continue;
      }
      let recheckUrl = '';
      try {
        recheckUrl = page.url() || '';
      } catch (_) {
        break;
      }
      const recheck = await detectChromeErrorPage(page);
      if (!recheck || recheckUrl !== firstSeenUrl) {
        // The page recovered (or navigated away) — do not close it.
        firstSeenAt = 0;
        firstSeenUrl = '';
        continue;
      }

      fired = true;
      if (ref) {
        ref.failed = true;
        ref.code = recheck;
      }
      try {
        page.__proxyFailed = recheck;
      } catch (_) {}

      onLog(
        `[${sessionId}] Site unreachable (${recheck}) - closing window and switching to another proxy`,
        'WARN'
      );
      try {
        await onFailure(recheck);
      } catch (_) {}
      try {
        await page.close({ runBeforeUnload: false });
      } catch (_) {}
      break;
    }
  }

  loop().catch(() => {});

  const stop = () => {
    stopped = true;
    try {
      page.off('request', onRequest);
    } catch (_) {}
  };
  // Kept callable for backwards compatibility, with explicit controls attached.
  stop.pause = () => {
    paused = true;
    firstSeenAt = 0;
    firstSeenUrl = '';
  };
  stop.resume = () => {
    paused = false;
    firstSeenAt = 0;
    firstSeenUrl = '';
    navQuietUntil = Date.now() + navQuietMs;
  };
  stop.stop = stop;
  return stop;
}

// Tracks every ad/popup tab so the session can wait for it before closing the
// browser. WeakMap keeps this leak-free when a page goes away.
const extraPageInfo = new WeakMap();

// Keeps new tabs/popups (ads, popunders) alive so their view timer can finish.
//
// IMPORTANT: new tabs are NEVER closed immediately. Each one gets a minimum
// lifetime (default 30s). Only when a context exceeds the tab budget do we
// close the oldest extras — and still only after their minimum lifetime.
function installPopupGuard(context, opts = {}) {
  const {
    mainPage = null,
    onLog = () => {},
    sessionId = 'Session',
    minLifeMs = 30000,
    maxExtraPages = 16,
  } = opts;

  const timers = new Map();

  const track = (p) => {
    try {
      if (!p || p === mainPage) return;
      if (timers.has(p)) return;
    } catch (_) {
      return;
    }

    let url = '';
    try {
      url = p.url() || 'about:blank';
    } catch (_) {}

    extraPageInfo.set(p, { openedAt: Date.now() });

    onLog(
      `[${sessionId}] New tab opened (${String(url).slice(0, 60)}) - left open so it can finish`,
      'info'
    );

    const timer = setTimeout(async () => {
      try {
        if (p.isClosed()) {
          timers.delete(p);
          return;
        }

        const extras = context.pages().filter((x) => {
          try {
            return x !== mainPage && !x.isClosed();
          } catch (_) {
            return false;
          }
        });

        if (extras.length > maxExtraPages) {
          const age = Math.round(minLifeMs / 1000);
          onLog(
            `[${sessionId}] Closing an extra tab after ${age}s (over ${maxExtraPages} tab limit)`,
            'info'
          );
          try {
            await p.close({ runBeforeUnload: false });
          } catch (_) {}
        } else {
          onLog(
            `[${sessionId}] Extra tab kept open (${extras.length}/${maxExtraPages} tabs)`,
            'info'
          );
        }
      } catch (_) {}
      timers.delete(p);
    }, minLifeMs);

    if (timer.unref) timer.unref();
    timers.set(p, timer);

    try {
      p.once('close', () => {
        const t = timers.get(p);
        if (t) clearTimeout(t);
        timers.delete(p);
      });
    } catch (_) {}
  };

  context.on('page', track);

  return () => {
    try {
      context.off('page', track);
    } catch (_) {}
    for (const t of timers.values()) {
      try {
        clearTimeout(t);
      } catch (_) {}
    }
    timers.clear();
  };
}

const VERIFY_TEXT_RE =
  /verify you are human|verify you are a human|i.m not a robot|protected by adex|checking your browser|just a moment|attention required|verifying you are human/i;

// Returns { hit, rect } — hit is true when the page is a human-verification
// interstitial; rect is the widget bounding box (if one can be found).
async function isVerifyPage(page) {
  try {
    if (page.isClosed()) return { hit: false, rect: null };
  } catch (_) {
    return { hit: false, rect: null };
  }

  const info = await page
    .evaluate(() => {
      const body = document.body;
      if (!body) return { hit: false, rect: null };
      const text = (body.innerText || '').toLowerCase().slice(0, 4000);
      const hit =
        /verify you are human|verify you are a human|i'm not a robot|i.m not a robot|protected by adex|checking your browser|just a moment|verifying you are human/.test(
          text
        );
      if (!hit) return { hit: false, rect: null };

      let rect = null;
      const cand = document.querySelector(
        'iframe[src*="captcha" i], iframe[src*="adex" i], iframe[src*="turnstile" i], #checkbox, [class*="captcha" i], [id*="captcha" i]'
      );
      if (cand) {
        const r = cand.getBoundingClientRect();
        if (r.width > 4 && r.height > 4) {
          rect = { x: r.x, y: r.y, w: r.width, h: r.height };
        }
      }
      return { hit, rect };
    })
    .catch(() => ({ hit: false, rect: null }));

  return info || { hit: false, rect: null };
}

const VERIFY_CLICK_SELECTORS = [
  'input[type="checkbox"]',
  '#checkbox',
  '[id*="checkbox" i]',
  '[class*="checkbox" i]',
  '[role="checkbox"]',
  '.cb-lb input',
  'label[class*="cb" i]',
  '.recaptcha-checkbox',
  '#challenge-stage input',
];

async function clickVerifyCheckbox(page) {
  const frames = [page.mainFrame(), ...page.frames().filter((f) => f !== page.mainFrame())];
  for (const frame of frames) {
    for (const sel of VERIFY_CLICK_SELECTORS) {
      try {
        const loc = frame.locator(sel).first();
        if ((await loc.count()) === 0) continue;
        const box = await loc.boundingBox();
        if (!box || box.width < 3 || box.height < 3) continue;
        try {
          await loc.click({ timeout: 2500 });
        } catch (_) {
          await loc.click({ timeout: 1500, force: true });
        }
        return true;
      } catch (_) {
        /* try next selector */
      }
    }
  }
  return false;
}

// Clicks the verification widget: real checkbox first, then widget centre,
// then page centre. Returns true when the interstitial disappeared.
async function autoHandleVerify(page, opts = {}) {
  const { sessionId = 'Session', onLog = () => {}, attempts = 4 } = opts;

  let info = await isVerifyPage(page);
  if (!info.hit) return false;

  onLog(`[${sessionId}] "Verify you are human" found - clicking it automatically...`, 'warning');

  for (let a = 0; a < attempts; a++) {
    let clicked = false;
    try {
      clicked = await clickVerifyCheckbox(page);
    } catch (_) {}

    if (!clicked) {
      const rect = info.rect;
      let vp = { width: 1366, height: 768 };
      try {
        vp = page.viewportSize() || vp;
      } catch (_) {}

      const cx = rect ? rect.x + rect.w / 2 : Math.round(vp.width / 2);
      const cy = rect ? rect.y + rect.h / 2 : Math.round(vp.height * 0.55);

      try {
        await page.mouse.move(cx + (Math.random() * 12 - 6), cy + (Math.random() * 10 - 5), {
          steps: 8,
        });
      } catch (_) {}
      await sleep(120 + Math.floor(Math.random() * 200));
      try {
        await page.mouse.click(cx, cy);
      } catch (_) {}
    }

    await sleep(1600 + Math.floor(Math.random() * 700));

    info = await isVerifyPage(page);
    if (!info.hit) {
      onLog(`[${sessionId}] Human verification cleared.`, 'success');
      return true;
    }
  }

  onLog(`[${sessionId}] Verification still visible after auto-click.`, 'warning');
  return false;
}

// Removes links that are almost certainly ads / affiliate trackers, so the
// internal-click routine does not behave like an ad clicker.
const AD_LINK_RE = new RegExp(
  [
    '(^|[?&])(ad|ads|adid|ad_id|aff|affid|aff_id|zoneid|zone_id|gclid|fbclid|msclkid|popunder)=',
    '/(adclick|adserver|popunder|adservice|adsense|sponsor)(/|\\?|$)',
    '/(click|clk|redirect|redir|out)(\\.php|\\.aspx)?([/?]|$)',
  ].join('|'),
  'i'
);

function looksLikeAdLink(href) {
  if (!href) return true;
  try {
    const u = new URL(href);
    return AD_LINK_RE.test(u.pathname + u.search);
  } catch (_) {
    return true;
  }
}

// Called just before `browser.close()`. Every ad/popup tab that is still open
// is allowed to reach `minLifeMs` (default 25s) of its own lifetime; the total
// wait is capped by `maxWaitMs`. This is what stops ads from being killed
// before their configured view time.
async function waitForExtraTabs(browser, opts = {}) {
  const {
    minLifeMs = 25000,
    maxWaitMs = 45000,
    onLog = () => {},
    sessionId = 'Session',
  } = opts;

  const collect = () => {
    const out = [];
    let contexts = [];
    try {
      contexts = browser.contexts();
    } catch (_) {
      return out;
    }
    for (const ctx of contexts) {
      let pages = [];
      try {
        pages = ctx.pages();
      } catch (_) {
        continue;
      }
      for (const p of pages) {
        const info = extraPageInfo.get(p);
        if (!info) continue;
        try {
          if (p.isClosed()) continue;
        } catch (_) {
          continue;
        }
        out.push({ page: p, openedAt: info.openedAt });
      }
    }
    return out;
  };

  let totalWait = 0;
  for (let round = 0; round < 2; round++) {
    const extras = collect();
    if (!extras.length) break;

    const now = Date.now();
    let need = 0;
    for (const e of extras) need = Math.max(need, minLifeMs - (now - e.openedAt));

    const wait = Math.min(Math.max(0, need), maxWaitMs - totalWait);
    if (wait < 500) break;

    onLog(
      `[${sessionId}] Waiting ${Math.ceil(wait / 1000)}s so ${extras.length} ad tab(s) finish their view time`,
      'info'
    );
    await sleep(wait);
    totalWait += wait;
  }

  if (totalWait > 0) {
    onLog(
      `[${sessionId}] Ad tabs given ${Math.round(totalWait / 1000)}s extra - closing browser now`,
      'info'
    );
  }
  return totalWait;
}

module.exports = {
  parseNetError,
  detectChromeErrorPage,
  installProxyErrorWatcher,
  installPopupGuard,
  waitForExtraTabs,
  isVerifyPage,
  autoHandleVerify,
  looksLikeAdLink,
  PROXY_FAIL_CODES,
};
