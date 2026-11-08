// TrafficSource.js
// Spoofs the traffic source (referrer) of a visit so analytics tools such as
// Google Analytics 4, Plausible, Matomo, Yandex Metrica, etc. report the visit
// as coming from Facebook / YouTube / TikTok / Instagram / ... instead of
// "direct".
//
// Why header interception:
//   `page.goto()` behaves exactly like typing the URL in the address bar, so
//   Chromium sends no Referer at all. Injecting an anchor click only works when
//   the current document is already on the "source" domain (that is what the
//   Referral module does), which is impossible for Direct / Organic / Maps.
//   Overriding the `Referer` request header on the first top-level navigation
//   to the target site works for every module, and Chromium then exposes the
//   same value to the page as `document.referrer` - which is exactly what
//   analytics scripts read.
//
// Usage (after the context exists, before navigating):
//   const traffic = require('./TrafficSource.js');
//   await traffic.installTrafficSource(context, config.trafficSource, {
//     targetUrl: config.targetUrl,
//     log: (msg, type) => emitter.emit('log', msg, type),
//   });

'use strict';

// Realistic referrer origins. GA4 recognises the host and reports the matching
// source/medium, e.g. facebook.com -> "facebook / referral".
const TRAFFIC_SOURCES = [
  { id: 'facebook', name: 'Facebook', referrer: 'https://www.facebook.com/' },
  { id: 'youtube', name: 'YouTube', referrer: 'https://www.youtube.com/' },
  { id: 'tiktok', name: 'TikTok', referrer: 'https://www.tiktok.com/' },
  { id: 'instagram', name: 'Instagram', referrer: 'https://www.instagram.com/' },
  { id: 'snapchat', name: 'Snapchat', referrer: 'https://www.snapchat.com/' },
  { id: 'twitter', name: 'X (Twitter)', referrer: 'https://twitter.com/' },
  { id: 'linkedin', name: 'LinkedIn', referrer: 'https://www.linkedin.com/' },
  { id: 'reddit', name: 'Reddit', referrer: 'https://www.reddit.com/' },
  { id: 'pinterest', name: 'Pinterest', referrer: 'https://www.pinterest.com/' },
  { id: 'telegram', name: 'Telegram', referrer: 'https://t.me/' },
  { id: 'whatsapp', name: 'WhatsApp', referrer: 'https://web.whatsapp.com/' },
  { id: 'quora', name: 'Quora', referrer: 'https://www.quora.com/' },
  { id: 'medium', name: 'Medium', referrer: 'https://medium.com/' },
  { id: 'tumblr', name: 'Tumblr', referrer: 'https://www.tumblr.com/' },
  { id: 'twitch', name: 'Twitch', referrer: 'https://www.twitch.tv/' },
  { id: 'discord', name: 'Discord', referrer: 'https://discord.com/' },
  { id: 'google', name: 'Google', referrer: 'https://www.google.com/' },
  { id: 'bing', name: 'Bing', referrer: 'https://www.bing.com/' },
  { id: 'yahoo', name: 'Yahoo', referrer: 'https://search.yahoo.com/' },
  { id: 'duckduckgo', name: 'DuckDuckGo', referrer: 'https://duckduckgo.com/' },
  { id: 'stackoverflow', name: 'Stack Overflow', referrer: 'https://stackoverflow.com/' },
  { id: 'github', name: 'GitHub', referrer: 'https://github.com/' },
];

const SOURCE_BY_ID = new Map(TRAFFIC_SOURCES.map((s) => [s.id, s]));

// Requests that are never the "landing page" of a visit. The Direct module
// warms up the proxy tunnel by loading `<target-origin>/favicon.ico`, which
// would otherwise consume the spoofed referrer before the real page loads.
const ASSET_RE = /\.(?:ico|png|jpe?g|gif|webp|svg|bmp|css|js|mjs|map|woff2?|ttf|otf|eot|mp4|webm|mp3|wav|pdf|zip|gz|webmanifest)(?:[?#]|$)/i;
const FAVICON_RE = /\/favicon\.ico(?:[?#]|$)/i;

function isDocumentNavigation(url) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return false;
  if (FAVICON_RE.test(url) || ASSET_RE.test(url)) return false;
  return true;
}

function isValidReferrer(url) {
  if (typeof url !== 'string') return '';
  const clean = url.trim();
  if (!/^https?:\/\/[^\s]+$/i.test(clean)) return '';
  try {
    const u = new URL(clean);
    if (!u.hostname || u.hostname.indexOf('.') === -1) return '';
    return u.origin + '/';
  } catch (_) {
    return '';
  }
}

/**
 * Normalize the UI payload into a stable config object, or null when disabled.
 */
function normalizeTrafficSource(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const enabled = raw.enabled === true || raw.enabled === 1 || raw.enabled === '1' || raw.enabled === 'true';
  if (!enabled) return null;
  const mode = raw.mode === 'fixed' ? 'fixed' : 'random';
  let source = String(raw.source || 'random').toLowerCase();
  if (source === 'x') source = 'twitter';
  if (source === 'custom' && !isValidReferrer(raw.customUrl)) source = 'random';
  if (source !== 'random' && source !== 'custom' && !SOURCE_BY_ID.has(source)) source = 'random';
  return {
    enabled: true,
    mode,
    source,
    customUrl: typeof raw.customUrl === 'string' ? raw.customUrl.trim() : '',
  };
}

/**
 * Resolve the referrer for one session.
 * @returns {{ id:string, name:string, referrer:string }}
 */
function resolveTrafficSource(cfg) {
  const conf = normalizeTrafficSource(cfg);
  if (!conf) return { id: '', name: '', referrer: '' };

  if (conf.mode === 'fixed') {
    if (conf.source === 'custom') {
      const custom = isValidReferrer(conf.customUrl);
      if (custom) {
        let name = 'Custom';
        try { name = new URL(custom).hostname.replace(/^www\./, ''); } catch (_) {}
        return { id: 'custom', name, referrer: custom };
      }
    } else {
      const found = SOURCE_BY_ID.get(conf.source);
      if (found) return { id: found.id, name: found.name, referrer: found.referrer };
    }
  }

  const pick = TRAFFIC_SOURCES[Math.floor(Math.random() * TRAFFIC_SOURCES.length)];
  return { id: pick.id, name: pick.name, referrer: pick.referrer };
}

/**
 * Backwards-friendly helper: just the referrer URL.
 */
function resolveTrafficReferrer(cfg) {
  return resolveTrafficSource(cfg).referrer;
}

/**
 * Install the referrer override on a browser context.
 *
 * @param {import('playwright').BrowserContext} context
 * @param {object} rawCfg          trafficSource config from the UI
 * @param {object} [opts]
 * @param {string} [opts.targetUrl]  only rewrite navigations to this host
 * @param {Function} [opts.log]      (message, type) logger
 * @returns {Promise<{applied:boolean, referrer:string, source:string, name:string}>}
 */
async function installTrafficSource(context, rawCfg, opts = {}) {
  const cfg = normalizeTrafficSource(rawCfg);
  if (!cfg || !context) return { applied: false, referrer: '', source: '', name: '' };

  const picked = resolveTrafficSource(cfg);
  if (!picked.referrer) return { applied: false, referrer: '', source: '', name: '' };

  const log = typeof opts.log === 'function' ? opts.log : () => {};

  try {
    // Chromium strips a Referer override done through request interception, but
    // context-level extra HTTP headers are honoured and also become
    // document.referrer - exactly what analytics scripts read.
    await context.setExtraHTTPHeaders({ Referer: picked.referrer });
  } catch (e) {
    try {
      log(`Traffic source could not be applied (${(e && e.message) || 'unknown error'})`, 'warning');
    } catch (_) {}
    return { applied: false, referrer: picked.referrer, source: picked.id, name: picked.name };
  }

  log(`Traffic source active: referrer ${picked.referrer} (${picked.name})`, 'info');
  return { applied: true, referrer: picked.referrer, source: picked.id, name: picked.name };
}

module.exports = {
  TRAFFIC_SOURCES,
  normalizeTrafficSource,
  resolveTrafficSource,
  resolveTrafficReferrer,
  installTrafficSource,
  isValidReferrer,
  isDocumentNavigation,
};
