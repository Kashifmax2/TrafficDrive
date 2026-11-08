// PopupHandler.js
// Conservative popup / consent-banner dismissor.
//
// IMPORTANT BEHAVIOUR CHANGE
//   Older versions clicked *any* visible element matching broad selectors such
//   as `button[class*="accept"]`, `button:has-text("OK")` or "Got it". On real
//   ad-heavy sites that meant the bot clicked page buttons even when Random
//   Clicks was OFF, which looked like hidden auto-clicking.
//
//   Now a button is clicked only when it is a known cookie-consent control, or
//   when ALL of these are true:
//     - its text is an exact consent phrase (Accept all / I agree / ...)
//     - it sits inside a fixed/sticky/dialog overlay
//     - that overlay mentions cookie/consent/GDPR/privacy/tracking/terms
//
//   That keeps real consent banners usable without ever clicking an ordinary
//   site "OK" button, ad button or login control.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Well-known consent-management buttons. These are unambiguous.
const CONSENT_SELECTORS = [
  'button#onetrust-accept-btn-handler',
  '#onetrust-accept-btn-handler',
  '#truste-consent-button',
  '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
  '#CybotCookiebotDialogBodyButtonAccept',
  '#cookie-accept',
  '#cookieAccept',
  '#cookie-accept-all',
  '#accept-cookies',
  '[data-testid="cookie-policy-banner-accept"]',
  '[data-testid="accept-cookies"]',
  '.cookie-accept',
  '.cookie__accept',
  '.js-accept-cookies',
  '.cc-btn.cc-allow',
  '.cc-allow',
  'button[aria-label*="accept cookies" i]',
  'button[aria-label*="accept all" i]',
  'button[aria-label*="allow cookies" i]',
  'button[title*="accept cookies" i]',
  'button[title*="accept all" i]',
];

// Generic phrases are only accepted inside a real consent overlay (checked in
// the page). Do not add "OK"/"Got it" alone here unless they are in-context:
// those are the exact buttons that caused accidental clicks.
const CONSENT_TEXTS = [
  'accept all',
  'accept all cookies',
  'accept cookies',
  'allow all',
  'allow all cookies',
  'allow cookies',
  'i agree',
  'i accept',
  'agree and continue',
  'agree & continue',
];

function visibleInViewport(box, vp) {
  if (!box) return false;
  if (box.width < 3 || box.height < 3) return false;
  return box.x + box.width > 0 && box.y + box.height > 0 && box.x < vp.w && box.y < vp.h;
}

async function clickKnownSelector(page, selector, log) {
  let loc;
  try {
    loc = page.locator(selector).first();
    if ((await loc.count()) === 0) return false;
    if (!(await loc.isVisible().catch(() => false))) return false;
    const box = await loc.boundingBox().catch(() => null);
    let vp = { w: 1280, h: 800 };
    try {
      vp = page.viewportSize() || vp;
    } catch (_) {}
    if (!visibleInViewport(box, vp)) return false;
    await loc.click({ timeout: 1500 }).catch(async () => {
      await loc.click({ timeout: 1000, force: true }).catch(() => {});
    });
    return true;
  } catch (_) {
    return false;
  }
}

// Finds exact consent-text controls inside a consent overlay and returns how
// many were tagged. No click happens here.
async function tagInContextConsentButtons(page) {
  return page
    .evaluate((texts) => {
      const wanted = new Set(texts.map((t) => t.toLowerCase()));
      const all = Array.from(
        document.querySelectorAll('button, [role="button"], input[type="submit"], input[type="button"]')
      ).slice(0, 400);
      let tagged = 0;

      const isConsentOverlay = (el) => {
        let node = el;
        for (let depth = 0; node && depth < 8; depth++, node = node.parentElement) {
          let style = null;
          try {
            style = getComputedStyle(node);
          } catch (_) {}
          const role = String(node.getAttribute('role') || '').toLowerCase();
          const modal = String(node.getAttribute('aria-modal') || '').toLowerCase();
          const overlay =
            role === 'dialog' ||
            modal === 'true' ||
            (style && (style.position === 'fixed' || style.position === 'sticky'));
          if (!overlay) continue;
          let text = '';
          try {
            text = (node.innerText || '') + ' ' + (node.className || '') + ' ' + (node.id || '');
          } catch (_) {}
          if (/cookie|consent|gdpr|privacy|tracking|terms|accept all|allow all/i.test(String(text))) {
            return true;
          }
        }
        return false;
      };

      for (const el of all) {
        let text = '';
        try {
          text = String(el.innerText || el.value || '').trim().toLowerCase();
        } catch (_) {}
        if (!wanted.has(text)) continue;
        try {
          const r = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          if (r.width < 3 || r.height < 3) continue;
          if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) continue;
          if (!isConsentOverlay(el)) continue;
          el.setAttribute('data-tp-consent-click', '1');
          tagged++;
          if (tagged >= 4) break;
        } catch (_) {}
      }
      return tagged;
    }, CONSENT_TEXTS)
    .catch(() => 0);
}

async function clickTaggedConsentButtons(page, log) {
  let clicked = 0;
  for (let i = 0; i < 4; i++) {
    const loc = page.locator('[data-tp-consent-click="1"]').first();
    try {
      if ((await loc.count()) === 0) break;
      const handle = await loc.elementHandle();
      if (!handle) break;
      // Untag this exact element before clicking, otherwise the next loop
      // iteration finds the same still-visible button and clicks it again.
      await handle.evaluate((el) => el.removeAttribute('data-tp-consent-click')).catch(() => {});
      await handle.click({ timeout: 1200 }).catch(() => {});
      clicked++;
      await sleep(180);
    } catch (_) {
      break;
    }
  }
  return clicked;
}

/**
 * Dismisses real cookie-consent banners only.
 *
 * @param {import('playwright').Page} page
 * @param {{log?:object, maxDismiss?:number, label?:string}} [opts]
 * @returns {Promise<number>} number of consent controls clicked
 */
async function dismissAll(page, opts = {}) {
  const log =
    opts.log && opts.log.emit
      ? (m) => opts.log.emit('log', m)
      : typeof opts.log === 'function'
        ? opts.log
        : () => {};
  const maxDismiss = Math.max(0, Math.min(8, parseInt(opts.maxDismiss, 10) || 4));
  let dismissed = 0;

  try {
    if (page.isClosed()) return 0;
  } catch (_) {
    return 0;
  }

  for (const selector of CONSENT_SELECTORS) {
    if (dismissed >= maxDismiss) break;
    if (await clickKnownSelector(page, selector, log)) {
      dismissed++;
      await sleep(200);
    }
  }

  if (dismissed < maxDismiss) {
    const tagged = await tagInContextConsentButtons(page);
    if (tagged > 0) {
      dismissed += await clickTaggedConsentButtons(page, log);
    }
  }

  if (dismissed > 0) {
    log(`Dismissed ${dismissed} cookie-consent control(s)`);
  }
  return dismissed;
}

async function tryFrameworkSelectors(page, opts = {}) {
  return dismissAll(page, opts);
}

function startMonitor(page, opts = {}) {
  const intervalMs = opts.interval || opts.intervalMs || 2500;
  const dismissFn = opts.dismissFn || dismissAll;
  const timer = setInterval(() => {
    try {
      dismissFn(page, { log: opts.log });
    } catch (_) {}
  }, intervalMs);
  if (timer.unref) timer.unref();
  return () => clearInterval(timer);
}

class PopupHandler {
  static dismissAll = dismissAll;
  static dismissGoogle = dismissAll;
  static dismissContinueBrowsing = dismissAll;
  static tryFrameworkSelectors = tryFrameworkSelectors;
  static startMonitor = startMonitor;
}

PopupHandler.dismissAll = dismissAll;
PopupHandler.dismissGoogle = dismissAll;
PopupHandler.dismissContinueBrowsing = dismissAll;
PopupHandler.tryFrameworkSelectors = tryFrameworkSelectors;
PopupHandler.startMonitor = startMonitor;

module.exports = PopupHandler;
module.exports.dismissAll = dismissAll;
module.exports.dismissGoogle = dismissAll;
module.exports.dismissContinueBrowsing = dismissAll;
module.exports.tryFrameworkSelectors = tryFrameworkSelectors;
module.exports.startMonitor = startMonitor;
