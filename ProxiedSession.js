// ProxiedSession.js
// One shared, fail-closed way to open a browser that really uses a proxy.
//
// Campaign modules used to duplicate this logic (geo lookup, timezone,
// geolocation, egress check) while the RPA replay launched a raw Chromium and
// silently used the PC's own IP. This module is the single path for every
// proxy-bound browser:
//
//   proxy -> resolve exit geo -> launch hardened browser -> context with
//   proxy/timezone/geolocation -> egress guard -> verify exit IP -> caller
//   navigates for the first time
//
// If a proxy is required and cannot be proven (dead, unverifiable, or the
// traffic exits through the PC's own connection) this throws instead of
// falling back to the direct connection.

'use strict';

const { launchBrowser } = require('./browser-launcher.js');
const {
  resolveProxyGeo,
  installContextEgressGuard,
  getLocalIp,
} = require('./EgressGuard.js');
const ProxyHandler = require('./Proxyhandler.js');

const proxyHandler = new ProxyHandler();

const FALLBACK_TIMEZONE = 'America/New_York';

function normalizeProxy(raw) {
  if (!raw || !raw.host || !raw.port) return null;
  return {
    type: (raw.type || 'http').toLowerCase(),
    host: String(raw.host),
    port: parseInt(raw.port, 10) || raw.port,
    username: raw.username || '',
    password: raw.password || '',
    sessionSuffix: !!raw.sessionSuffix,
    rotating: !!raw.rotating,
    raw: raw.raw || '',
  };
}

function proxyLabel(proxy) {
  if (!proxy || !proxy.host) return 'direct IP';
  return `${proxy.type || 'http'}://${proxy.host}:${proxy.port}${proxy.username ? ' (' + proxy.username + ')' : ''}`;
}

function proxyKey(proxy) {
  if (!proxy || !proxy.host) return '';
  return `${(proxy.type || 'http').toLowerCase()}:${proxy.host}:${proxy.port}`;
}

function isProxyFailure(err) {
  return !!(err && (err.proxyFailure || /proxy|egress|ERR_PROXY|ERR_TUNNEL/i.test(String(err.code || err.message || ''))));
}

function proxyError(code, message, extra) {
  const err = new Error(message);
  err.proxyFailure = true;
  err.code = code;
  if (extra && typeof extra === 'object') Object.assign(err, extra);
  return err;
}

// Read the exit IP from inside the browser context. Returns '' when the read
// failed (blocked endpoint / no network).
async function readEgressIp(context, timeoutMs = 8000) {
  try {
    const response = await context.request.get('https://api.ipify.org?format=json', {
      timeout: timeoutMs,
      headers: { Accept: 'application/json' },
    });
    const text = (await response.text()).trim();
    let ip = '';
    try { ip = (JSON.parse(text) || {}).ip || ''; } catch (_) { ip = text; }
    return /^[0-9a-f:.]+$/i.test(ip) ? ip.trim() : '';
  } catch (_) {
    return '';
  }
}

/**
 * Build a context-wide browser session that is pinned to `proxy`.
 *
 * @param {Object} opts
 * @param {Object} [opts.proxy]                raw proxy record
 * @param {boolean} [opts.requireProxy=false]  throw when no proxy is supplied
 * @param {string}  [opts.sessionTag='session'] session suffix for rotating pools
 * @param {boolean} [opts.headless=true]
 * @param {string}  [opts.customBrowserPath]
 * @param {string[]}[opts.args]
 * @param {Object}  [opts.contextOpts]         userAgent/viewport/isMobile/...
 * @param {boolean} [opts.verifyEgress=true]   fail when the proxy cannot be proven
 * @param {Function}[opts.onLog]
 * @param {string}  [opts.sessionId]
 * @param {Function}[opts.onLeak]
 * @returns {Promise<{browser, context, proxy, proxyOpts, geo, egress, egressIp,
 *   proxyVerified, localIpMatched, rotating, close}>}
 */
async function createProxiedSession(opts = {}) {
  const {
    requireProxy = false,
    sessionTag = 'session',
    headless = true,
    customBrowserPath = '',
    args = [],
    contextOpts = {},
    verifyEgress: shouldVerify = true,
    onLog = () => {},
    sessionId = 'Session',
    onLeak = null,
  } = opts;

  const rawProxy = normalizeProxy(opts.proxy);
  if (!rawProxy && requireProxy) {
    throw proxyError('PROXY_REQUIRED', 'No proxy selected, but this run requires a proxy. Direct-IP fallback is disabled.');
  }

  // Session-token aware record (residential pools rotate by username token).
  const sessionProxy = rawProxy
    ? proxyHandler.buildSessionProxy(rawProxy, sessionTag)
    : null;
  const proxyOpts = sessionProxy ? proxyHandler.buildPlaywrightProxyOpts(sessionProxy) : {};
  const hasProxy = !!(proxyOpts && proxyOpts.proxy && proxyOpts.proxy.server);

  if (requireProxy && !hasProxy) {
    throw proxyError('PROXY_REQUIRED', 'Proxy record is invalid (host/port missing). Direct-IP fallback is disabled.');
  }

  // Resolve the proxy's own exit IP / location before any page navigates.
  let geo = null;
  if (hasProxy) {
    try {
      geo = await resolveProxyGeo(sessionProxy, { timeoutMs: 6000 });
    } catch (_) {}
    if (geo && geo.ip) {
      onLog(`[${sessionId}] Proxy exit: ${geo.ip}${geo.city ? ' - ' + geo.city : ''}${geo.countryCode ? ', ' + geo.countryCode : ''}${geo.timezone ? ' (' + geo.timezone + ')' : ''}`, 'info');
    } else {
      onLog(`[${sessionId}] Proxy location lookup unavailable - will verify the exit IP inside the browser.`, 'warn');
    }
  }

  let browser = null;
  let context = null;
  try {
    browser = await launchBrowser({
      headless: !!headless,
      customBrowserPath: customBrowserPath || undefined,
      args,
      onLog,
      sessionId,
    });

    const finalContextOpts = Object.assign({}, contextOpts || {});
    if (hasProxy) {
      finalContextOpts.proxy = proxyOpts.proxy;
      // Never keep the PC's timezone / location while a proxy is active.
      finalContextOpts.timezoneId = (geo && geo.timezone) ? geo.timezone : FALLBACK_TIMEZONE;
      if (geo && typeof geo.lat === 'number' && typeof geo.lon === 'number') {
        finalContextOpts.geolocation = {
          latitude: geo.lat,
          longitude: geo.lon,
          accuracy: 5000,
        };
        finalContextOpts.permissions = Array.from(new Set([...(finalContextOpts.permissions || []), 'geolocation']));
      } else {
        finalContextOpts.permissions = Array.isArray(finalContextOpts.permissions) ? finalContextOpts.permissions : [];
      }
    }

    context = await browser.newContext(finalContextOpts);

    if (hasProxy) {
      // WebRTC / geolocation guard for the main page and every ad popup.
      await installContextEgressGuard(context, { geo });
    }

    let egressIp = '';
    let localIpMatched = false;
    let rotating = false;
    let proxyVerified = hasProxy;

    if (hasProxy && shouldVerify) {
      egressIp = await readEgressIp(context);
      if (!egressIp) {
        throw proxyError(
          'PROXY_EGRESS_UNVERIFIED',
          'Proxy egress could not be verified (the exit-IP check failed). Replay aborted instead of using the PC IP.'
        );
      }
      const localIp = await getLocalIp();
      if (localIp && egressIp === localIp) {
        localIpMatched = true;
        try { onLeak && onLeak(egressIp); } catch (_) {}
        throw proxyError(
          'PROXY_LEAK',
          `Proxy leak: traffic exited from the PC IP ${egressIp} instead of the proxy. Session closed.`,
          { egressIp, localIpMatched: true }
        );
      }
      if (geo && geo.ip && egressIp !== geo.ip) {
        // Rotating residential proxy: a different exit is normal, but record it.
        rotating = true;
        onLog(`[${sessionId}] Egress IP ${egressIp} differs from lookup IP ${geo.ip} (rotating proxy, not the PC connection)`, 'warn');
      }
      proxyVerified = true;
    } else if (hasProxy) {
      proxyVerified = false;
      onLog(`[${sessionId}] Egress verification disabled by user.`, 'warn');
    }

    const close = async () => {
      try { if (context) await context.close(); } catch (_) {}
      try { if (browser) await browser.close(); } catch (_) {}
    };

    return {
      browser,
      context,
      proxy: sessionProxy,
      proxyOpts,
      geo,
      egress: { ip: egressIp, localIpMatched, rotating },
      egressIp,
      proxyVerified,
      localIpMatched,
      rotating,
      hasProxy,
      close,
    };
  } catch (err) {
    try { if (context) await context.close(); } catch (_) {}
    try { if (browser) await browser.close(); } catch (_) {}
    if (!err.proxyFailure && hasProxy && shouldVerify && /egress|proxy/i.test(String(err.message || ''))) {
      err.proxyFailure = true;
    }
    throw err;
  }
}

/**
 * Open a page only after the proxy has been proven. Kept as a tiny convenience
 * for replay loops that need `context.newPage()`.
 */
async function firstPageAfterVerify(session) {
  if (!session || !session.context) throw new Error('No proxied session');
  return session.context.newPage();
}

module.exports = {
  createProxiedSession,
  normalizeProxy,
  proxyLabel,
  proxyKey,
  isProxyFailure,
  readEgressIp,
  firstPageAfterVerify,
  FALLBACK_TIMEZONE,
};
