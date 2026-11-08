// RpaRecorder.js
// Records user actions (click / input / select / key / scroll / navigation)
// from a Playwright BrowserContext while the user drives a visible browser.
//
// Why a context binding instead of a page array:
//   Actions used to be stored in `window.__rpaActions` and read back once when
//   the recording stopped. That loses everything on navigation/reload and only
//   sees the single original tab. Here every action is pushed to Node the
//   moment it happens, so it survives navigation, new tabs and popups.
//
// Tab tracking:
//   Every page gets a stable id (`tab1`, `tab2`, ...). Actions carry that id so
//   replay can re-open a new tab instead of navigating the original page.
//
// Scroll tracking:
//   The old recorder only listened to `window` scroll. Most modern pages scroll
//   an inner container, and the handler debounced for 400 ms (so the last
//   scroll before Stop was lost). This version records window AND element
//   scrolls, and exposes `window.__rpaFlush()` so pending scrolls are flushed
//   before the recording is saved.
//
// Usage:
//   const rec = require('./RpaRecorder.js');
//   await rec.installRecorder(context, { onAction, isActive });
//   context.on('page', p => rec.trackPage(p, { onAction, isActive }));
//   ...
//   const actions = await rec.collectBufferedActions(context.pages());

'use strict';

const ACTION_TYPES = ['click', 'input', 'key', 'scroll', 'navigate', 'select', 'switch', 'reload'];
const BAD_URL_RE = /^(chrome-error:|about:|chrome:|edge:|devtools:)/i;

// page -> tab id. A WeakMap means closed pages are garbage collected with it.
let pageTabs = new WeakMap();
let nextTabId = 1;

function resetTabs() {
  pageTabs = new WeakMap();
  nextTabId = 1;
}

function getTabId(page) {
  if (!page) return 'tab1';
  let id = pageTabs.get(page);
  if (!id) {
    id = 'tab' + (nextTabId++);
    pageTabs.set(page, id);
  }
  return id;
}

function normalizeAction(payload, pageUrl, tabId) {
  if (!payload || typeof payload !== 'object') return null;
  const type = String(payload.type || '');
  if (!ACTION_TYPES.includes(type)) return null;
  const url = (typeof payload.url === 'string' && payload.url) ? payload.url : (pageUrl || '');
  if (!url || BAD_URL_RE.test(url)) return null;
  const action = Object.assign({}, payload, {
    type,
    url,
    ts: Number(payload.ts) || Date.now(),
  });
  if (tabId) action.tab = tabId;
  if (!action.id) action.id = action.ts + '_' + Math.random().toString(36).slice(2, 8);
  return action;
}

// This function is serialized into every document. It must be fully
// self-contained (no closures over Node-side variables).
function recorderInitScript() {
  if (window.__rpaInstalled) return;
  window.__rpaInstalled = true;
  window.__rpaRecord = true;
  window.__rpaActions = window.__rpaActions || [];

  var pending = [];
  var flush = function () {
    if (typeof window.__rpaSend !== 'function') return;
    while (pending.length) {
      var queued = pending[0];
      try {
        window.__rpaSend(queued);
      } catch (_) {
        return;
      }
      pending.shift();
    }
  };

  var send = function (action) {
    action.ts = action.ts || Date.now();
    action.id = action.id || (action.ts + '_' + Math.random().toString(36).slice(2, 8));
    try { window.__rpaActions.push(action); } catch (_) {}
    if (window.__rpaActions.length > 5000) window.__rpaActions.shift();
    if (pending.length > 500) pending.shift();
    pending.push(action);
    flush();
  };

  // Bindings may not be ready at document start on some documents; retrying
  // also drains actions that were buffered before the binding appeared.
  setInterval(flush, 250);

  // --- Selector helpers ---------------------------------------------------
  // Short, readable selector first (id / name / first class); if that is not
  // specific enough, fall back to an nth-of-type path so replay finds the same
  // element even when the page has many identical <div>s.
  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === 'function') {
      try { return window.CSS.escape(value); } catch (_) {}
    }
    return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  }

  function selectorFor(el) {
    if (!el || el.nodeType !== 1) return 'body';
    if (el.id) return '#' + cssEscape(el.id);
    var tag = (el.tagName || 'div').toLowerCase();
    var name = el.getAttribute && el.getAttribute('name');
    if (name) return tag + '[name="' + String(name).replace(/"/g, '\\"') + '"]';
    var cls = '';
    if (el.className && typeof el.className === 'string') {
      cls = el.className.trim().split(/\s+/).filter(Boolean)[0] || '';
    }
    var base = cls ? tag + '.' + cssEscape(cls) : tag;
    // Keep the simple selector when it is unique on the page.
    try {
      if (document.querySelectorAll(base).length === 1) return base;
    } catch (_) {}
    // Build a stable nth-of-type path (at most 5 levels).
    var parts = [];
    var node = el;
    for (var depth = 0; node && node.nodeType === 1 && depth < 5; depth++) {
      var part = node.tagName ? node.tagName.toLowerCase() : 'div';
      if (node.id) {
        parts.unshift('#' + cssEscape(node.id));
        break;
      }
      var parent = node.parentElement;
      if (parent) {
        var sameTag = 0;
        var index = 0;
        for (var i = 0; i < parent.children.length; i++) {
          var child = parent.children[i];
          if (child.tagName === node.tagName) {
            sameTag++;
            if (child === node) index = sameTag;
          }
        }
        if (sameTag > 1) part += ':nth-of-type(' + index + ')';
      }
      parts.unshift(part);
      node = node.parentElement;
      if (node && node.tagName && node.tagName.toLowerCase() === 'body') break;
    }
    return parts.join(' > ') || base;
  }

  document.addEventListener('click', function (e) {
    if (!window.__rpaRecord) return;
    send({ type: 'click', selector: selectorFor(e.target), x: Math.round(e.clientX), y: Math.round(e.clientY), url: location.href });
  }, true);

  var inputTimer = null;
  document.addEventListener('input', function (e) {
    if (!window.__rpaRecord) return;
    var el = e.target;
    if (!el) return;
    // <select> changes are recorded by the 'change' handler below.
    if (el.tagName && el.tagName.toLowerCase() === 'select') return;
    if (inputTimer) clearTimeout(inputTimer);
    inputTimer = setTimeout(function () {
      if (!window.__rpaRecord) return;
      send({ type: 'input', selector: selectorFor(el), value: el.value !== undefined ? el.value : '', url: location.href });
    }, 400);
  }, true);

  document.addEventListener('change', function (e) {
    if (!window.__rpaRecord) return;
    var el = e.target;
    if (!el || !el.tagName || el.tagName.toLowerCase() !== 'select') return;
    send({ type: 'select', selector: selectorFor(el), value: el.value, url: location.href });
  }, true);

  document.addEventListener('keydown', function (e) {
    if (!window.__rpaRecord) return;
    if (e.key === 'Enter' || e.key === 'Tab' || e.key === 'Escape') {
      send({ type: 'key', key: e.key, selector: selectorFor(e.target), url: location.href });
    }
  }, true);

  // --- Scroll tracking ----------------------------------------------------
  // Each scroll target keeps only its latest position. A light interval
  // flushes targets that stopped moving, so a burst of scroll events becomes
  // one replayable action (and no event is lost on Stop).
  var scrollTargets = [];
  function scrollTargetKey(el) {
    if (el === window || el === document || el === document.documentElement || el === document.body) {
      return 'window';
    }
    return el;
  }
  function findScrollTarget(el) {
    var key = scrollTargetKey(el);
    for (var i = 0; i < scrollTargets.length; i++) {
      if (scrollTargets[i].key === key) return scrollTargets[i];
    }
    var entry = { key: key, el: el, x: 0, y: 0, selector: '', container: false, dirty: false, last: 0 };
    scrollTargets.push(entry);
    if (scrollTargets.length > 40) scrollTargets.shift();
    return entry;
  }
  function readScrollPosition(entry) {
    if (entry.key === 'window') {
      var docEl = document.scrollingElement || document.documentElement || document.body;
      return {
        x: Math.round(window.scrollX || (docEl && docEl.scrollLeft) || 0),
        y: Math.round(window.scrollY || (docEl && docEl.scrollTop) || 0),
      };
    }
    var el = entry.el;
    if (!el || el.nodeType !== 1) return null;
    return {
      x: Math.round(el.scrollLeft || 0),
      y: Math.round(el.scrollTop || 0),
    };
  }
  function emitScroll(entry) {
    if (!entry || !entry.dirty) return;
    var pos = readScrollPosition(entry);
    entry.dirty = false;
    entry.last = Date.now();
    if (!pos) return;
    // Ignore the plenty of 0,0 scroll events on freshly loaded pages.
    if (pos.x === 0 && pos.y === 0 && !entry.sentOnce) {
      entry.sentOnce = true;
      return;
    }
    entry.sentOnce = true;
    send({
      type: 'scroll',
      x: pos.x,
      y: pos.y,
      selector: entry.container ? entry.selector : '',
      container: !!entry.container,
      url: location.href,
    });
  }
  function onScroll(e) {
    if (!window.__rpaRecord) return;
    var target = e.target;
    var entry = findScrollTarget(target);
    if (entry.key !== 'window' && entry.el && entry.el.nodeType === 1) {
      entry.container = true;
      entry.selector = selectorFor(entry.el);
    }
    entry.dirty = true;
  }
  window.addEventListener('scroll', onScroll, true);
  document.addEventListener('scroll', onScroll, true);

  // Flush targets that have been idle for ~250 ms.
  setInterval(function () {
    var now = Date.now();
    for (var i = 0; i < scrollTargets.length; i++) {
      var entry = scrollTargets[i];
      if (entry.dirty && (now - entry.last) >= 250) emitScroll(entry);
    }
  }, 250);

  // Public flush hook used right before a recording is saved, on tab close and
  // when the document is being unloaded.
  window.__rpaFlush = function () {
    for (var i = 0; i < scrollTargets.length; i++) emitScroll(scrollTargets[i]);
    if (typeof window.__rpaSend === 'function') {
      while (pending.length) {
        try { window.__rpaSend(pending[0]); } catch (_) { break; }
        pending.shift();
      }
    }
  };
  window.addEventListener('pagehide', function () { try { window.__rpaFlush(); } catch (_) {} }, true);
  window.addEventListener('beforeunload', function () { try { window.__rpaFlush(); } catch (_) {} }, true);
}

/**
 * Install the recorder on a context. Must be called BEFORE the first page is
 * created, otherwise the already-navigated document never gets the script.
 */
async function installRecorder(context, opts = {}) {
  const onAction = typeof opts.onAction === 'function' ? opts.onAction : () => {};
  const isActive = typeof opts.isActive === 'function' ? opts.isActive : () => true;

  resetTabs();

  await context.exposeBinding('__rpaSend', async (source, payload) => {
    if (!isActive()) return;
    let pageUrl = '';
    const page = source && source.page ? source.page : null;
    try {
      pageUrl = page ? page.url() : '';
    } catch (_) {}
    const action = normalizeAction(payload, pageUrl, page ? getTabId(page) : 'tab1');
    if (!action) return;
    try { onAction(action); } catch (_) {}
  });

  await context.addInitScript(recorderInitScript);
}

/**
 * Record main-frame navigations for one page (including popups/new tabs).
 * Returns a detach function.
 */
function trackPage(page, opts = {}) {
  const onAction = typeof opts.onAction === 'function' ? opts.onAction : () => {};
  const isActive = typeof opts.isActive === 'function' ? opts.isActive : () => true;
  let lastUrl = '';
  let lastTs = 0;

  const handler = (frame) => {
    if (!isActive()) return;
    try {
      if (frame !== page.mainFrame()) return;
      const url = frame.url();
      if (!url || BAD_URL_RE.test(url)) return;
      const now = Date.now();
      // Chromium fires this more than once for the same document.
      if (url === lastUrl && now - lastTs < 600) return;

      // Same URL after the duplicate window = the user pressed Reload (or
      // re-opened the same address). Record it as an explicit refresh so
      // replay can reload instead of navigating to the old captured URL.
      if (url === lastUrl) {
        lastTs = now;
        onAction({
          id: 'reload_' + now + '_' + Math.random().toString(36).slice(2, 8),
          type: 'reload',
          url,
          ts: now,
          tab: getTabId(page),
        });
        return;
      }

      lastUrl = url;
      lastTs = now;
      onAction({
        id: 'nav_' + now + '_' + Math.random().toString(36).slice(2, 8),
        type: 'navigate',
        url,
        ts: now,
        tab: getTabId(page),
      });
    } catch (_) {}
  };

  try { page.on('framenavigated', handler); } catch (_) {}
  return () => {
    try { page.off('framenavigated', handler); } catch (_) {}
  };
}

/**
 * Records tab switching in a BrowserContext.
 *
 * Playwright does not expose a "tab activated" event, so this polls the
 * visibility state of every page (lightweight, recording only). When the
 * visible page changes, a `switch` action is emitted with that tab id.
 * Replay calls `page.bringToFront()` for those actions.
 *
 * @returns {{ stop: Function, flush: Function }}
 */
function trackContextFocus(context, opts = {}) {
  const onAction = typeof opts.onAction === 'function' ? opts.onAction : () => {};
  const isActive = typeof opts.isActive === 'function' ? opts.isActive : () => true;
  const intervalMs = Math.max(150, parseInt(opts.intervalMs, 10) || 350);
  let stopped = false;
  let lastTab = '';
  let lastUrl = '';
  let running = false;

  const safeUrl = (p) => {
    try {
      return p.url() || '';
    } catch (_) {
      return '';
    }
  };

  const evaluateActive = async (p) => {
    const state = await Promise.race([
      p
        .evaluate(() => {
          try {
            return { visibility: document.visibilityState, focused: !!document.hasFocus() };
          } catch (_) {
            return { visibility: '', focused: false };
          }
        })
        .catch(() => null),
      new Promise((resolve) => setTimeout(() => resolve(null), 700)),
    ]);
    return state;
  };

  const detectActive = async () => {
    let pages = [];
    try {
      pages = context.pages().filter((p) => {
        try {
          return !p.isClosed();
        } catch (_) {
          return false;
        }
      });
    } catch (_) {
      return null;
    }
    if (!pages.length) return null;

    const states = await Promise.all(
      pages.map(async (p) => ({ page: p, state: await evaluateActive(p) }))
    );
    const visible = states.filter((x) => x.state && x.state.visibility === 'visible');
    if (!visible.length) return null;
    // Prefer the page that also has keyboard focus; otherwise the first
    // visible page (one browser window = exactly one visible tab).
    return (visible.find((x) => x.state.focused) || visible[0]).page;
  };

  const loop = async () => {
    while (!stopped) {
      await new Promise((r) => setTimeout(r, intervalMs));
      if (stopped) break;
      if (!isActive()) continue;
      if (running) continue;
      running = true;
      try {
        const active = await detectActive();
        if (!active) continue;
        const tab = getTabId(active);
        const url = safeUrl(active);
        if (lastTab && tab !== lastTab) {
          onAction({
            id: 'switch_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
            type: 'switch',
            tab,
            url,
            ts: Date.now(),
          });
        }
        lastTab = tab;
        if (url) lastUrl = url;
      } catch (_) {
      } finally {
        running = false;
      }
    }
  };
  loop().catch(() => {});

  return {
    stop() {
      stopped = true;
    },
    flush() {
      return { tab: lastTab, url: lastUrl };
    },
  };
}

/**
 * Drain the in-page fallback buffers. Used when stopping a recording so
 * actions the binding missed (e.g. very early interactions) are not lost.
 * Pending scroll positions are flushed first.
 */
async function collectBufferedActions(pages, timeoutMs = 2000) {
  const list = Array.isArray(pages) ? pages : [];
  const results = await Promise.all(list.map((p) => Promise.race([
    Promise.resolve()
      .then(async () => {
        try {
          await p.evaluate(() => {
            if (typeof window.__rpaFlush === 'function') window.__rpaFlush();
          });
        } catch (_) {}
        return p.evaluate(() => (window.__rpaActions || []));
      })
      .catch(() => []),
    new Promise((resolve) => setTimeout(() => resolve([]), timeoutMs)),
  ]).catch(() => [])));
  const out = [];
  for (let i = 0; i < results.length; i++) {
    const buffer = results[i];
    const tab = getTabId(list[i]);
    if (Array.isArray(buffer)) {
      for (const item of buffer) {
        if (item && typeof item === 'object') out.push(Object.assign({ tab }, item));
      }
    }
  }
  return out;
}

/**
 * Wraps an action sink so tab switches become explicit `switch` actions.
 *
 * Why not poll document.visibilityState? Inside an automated Chromium window
 * background tabs can keep reporting "visible"/focused, so polling produced
 * late or missing switches (and occasional bogus ones around reloads).
 *
 * Every recorded input/navigation already carries the real tab id, so the
 * first action on a different tab is a genuine user tab switch. Inserting a
 * `switch` action before it makes replay call `bringToFront()` - including the
 * "open new tab, then go back to the previous tab" case.
 *
 * @param {(action: object) => void} onAction
 * @returns {(action: object) => void}
 */
function createTabSwitchRouter(onAction) {
  let activeTab = '';
  return (action) => {
    if (!action || !action.type) return;
    const tab = action.tab || '';
    if (tab && activeTab && tab !== activeTab) {
      onAction({
        id: 'switch_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
        type: 'switch',
        tab,
        url: action.url || '',
        ts: Math.max(1, (action.ts || Date.now()) - 1),
      });
    }
    if (tab) activeTab = tab;
    onAction(action);
  };
}

module.exports = {
  installRecorder,
  trackPage,
  trackContextFocus,
  createTabSwitchRouter,
  collectBufferedActions,
  normalizeAction,
  recorderInitScript,
  getTabId,
  resetTabs,
  ACTION_TYPES,
};
