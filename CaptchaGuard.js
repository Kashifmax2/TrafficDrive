// CaptchaGuard.js
// CAPTCHA detection + automatic "Verify you are human" handling.
//
// Flow:
//   1. Watch the page for captcha widgets / verification interstitials
//      ("Verify you are human", "Just a moment", ADEX, Turnstile, reCAPTCHA...)
//   2. When one appears, try to clear it automatically:
//        - click the real checkbox (page or iframe)
//        - otherwise click the widget centre / page centre
//   3. If it still does not clear (image puzzle, etc.) pause the workflow and
//      wait for manual resolution in the visible window.

const { isVerifyPage, autoHandleVerify } = require('./PageGuard.js');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const CAPTCHA_SELECTORS = [
  'iframe[src*="recaptcha"]',
  'iframe[src*="captcha"]',
  'iframe[src*="turnstile"]',
  'iframe[src*="hcaptcha"]',
  'iframe[src*="adex"]',
  'div.g-recaptcha',
  '#captcha-container',
  '[id*="captcha" i]',
  '[class*="captcha" i]',
  'iframe[title*="reCAPTCHA" i]',
  'iframe[title*="recaptcha" i]',
  'img[src*="captcha" i]',
];

function installCaptchaGuard(page, opts = {}) {
  const { sessionId = 'Session', onLog = () => {} } = opts;
  let busy = false;
  let autoAttempts = 0;

  async function detect() {
    try {
      for (const sel of CAPTCHA_SELECTORS) {
        const el = await page.$(sel).catch(() => null);
        if (el) {
          const visible = await el.isVisible().catch(() => false);
          if (visible) return true;
        }
      }
    } catch (_) {}

    // Text based detection catches interstitials that do not use a known
    // widget (e.g. the "Verify you are human / Protected by ADEX.COM" page).
    try {
      const v = await isVerifyPage(page);
      if (v.hit) return true;
    } catch (_) {}

    return false;
  }

  function isBusy() {
    return busy;
  }

  // Polls until no CAPTCHA is visible. Resolves immediately if not busy.
  async function waitForCaptchaResolution() {
    if (!busy) {
      // Even when the guard is idle, try to clear a verification page that is
      // currently on screen (this covers pages loaded before the watcher ran).
      try {
        const cleared = await autoHandleVerify(page, { sessionId, onLog, attempts: 2 });
        if (cleared) return;
      } catch (_) {}
      return;
    }

    onLog(`[${sessionId}] CAPTCHA detected — attempting auto-verify...`, 'warning');
    try {
      const cleared = await autoHandleVerify(page, { sessionId, onLog, attempts: 3 });
      if (cleared) {
        busy = false;
        onLog(`[${sessionId}] CAPTCHA resolved — resuming workflow.`, 'success');
        return;
      }
    } catch (_) {}

    onLog(`[${sessionId}] CAPTCHA needs manual action — waiting...`, 'warning');
    while (busy) {
      await sleep(2500);
      const stillThere = await detect();
      if (!stillThere) {
        busy = false;
        onLog(`[${sessionId}] CAPTCHA resolved — resuming workflow.`, 'success');
        break;
      }
      // Keep trying the automatic click while we wait.
      try {
        const cleared = await autoHandleVerify(page, { sessionId, onLog, attempts: 1 });
        if (cleared) {
          busy = false;
          onLog(`[${sessionId}] CAPTCHA resolved — resuming workflow.`, 'success');
          break;
        }
      } catch (_) {}
    }
  }

  // Lightweight background watcher — marks the guard busy when a CAPTCHA
  // appears so the next navigation retry loop can pause for it.
  let watcherRunning = false;
  async function startWatcher() {
    if (watcherRunning) return;
    watcherRunning = true;
    while (watcherRunning) {
      try {
        const pageClosed = page.isClosed();
        if (pageClosed) {
          watcherRunning = false;
          break;
        }
        if (!busy) {
          const found = await detect();
          if (found) {
            busy = true;
            // Auto-click immediately, before the workflow pauses.
            if (autoAttempts < 6) {
              autoAttempts++;
              try {
                const cleared = await autoHandleVerify(page, { sessionId, onLog, attempts: 2 });
                if (cleared) busy = false;
              } catch (_) {}
            }
          }
        } else {
          // re-check whether it cleared on its own
          const found = await detect();
          if (!found) busy = false;
        }
      } catch (_) {
        watcherRunning = false;
        break;
      }
      await sleep(2500);
    }
  }
  startWatcher().catch(() => {});

  return { isBusy, waitForCaptchaResolution, detect };
}

module.exports = { installCaptchaGuard };
