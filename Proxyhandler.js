// Proxyhandler.js
// Builds Playwright-compatible proxy configuration from proxy records and can
// check whether a proxy can actually reach a given target URL.
//
// A proxy record looks like:
//   { type, host, port, username, password, raw }
//
// buildSessionProxy() only injects a session token when asked to (rotating
// pools); a plain user:pass proxy is always used exactly as typed.
//
// buildPlaywrightProxyOpts() turns a session proxy into the { proxy: {...} }
// object Playwright's newContext() expects.

const http = require('http');
const tls = require('tls');
const { URL } = require('url');

// Small cache so 1000 sessions don't re-check the same proxy+target over and
// over. Positive and negative results are both cached for 5 minutes.
const reachCache = new Map();
const REACH_TTL_MS = 5 * 60 * 1000;

class ProxyHandler {
  buildSessionProxy(proxy, sessionId) {
    if (!proxy) return null;
    const sessionProxy = { ...proxy };
    if (!sessionProxy.username || typeof sessionId !== 'string' || !sessionId) return sessionProxy;

    // IMPORTANT: a plain user:pass proxy must be used EXACTLY as typed.
    // Appending anything to the username (e.g. '-session-t1') makes the
    // provider reject the login with HTTP 407, which showed up as an empty
    // 'This page isn't working' browser tab.
    //
    // Session suffixes are opt-in only:
    //   1) username contains a {session} placeholder -> replace it, or
    //   2) the proxy record explicitly sets sessionSuffix/rotating = true.
    if (/\{session\}/i.test(sessionProxy.username)) {
      sessionProxy.username = sessionProxy.username.replace(/\{session\}/gi, sessionId);
      return sessionProxy;
    }

    if (sessionProxy.sessionSuffix === true || sessionProxy.rotating === true) {
      if (!/-session-/i.test(sessionProxy.username)) {
        sessionProxy.username = `${sessionProxy.username}-session-${sessionId}`;
      }
    }
    return sessionProxy;
  }

  buildPlaywrightProxyOpts(proxy) {
    if (!proxy || !proxy.host || !proxy.port) return {};
    const scheme = (proxy.type || 'http').toLowerCase();
    const server = `${scheme}://${proxy.host}:${proxy.port}`;
    const opts = {
      proxy: { server },
    };
    if (proxy.username) {
      opts.proxy.username = proxy.username;
      if (proxy.password) opts.proxy.password = proxy.password;
    }
    return opts;
  }

  // Returns { ok, reason, ms }. reason: ok | auth | site_blocked | timeout |
  // refused | connect_failed | invalid_target
  testReachability(proxy, targetUrl, timeoutMs = 6000) {
    return new Promise((resolve) => {
      if (!proxy || !proxy.host || !proxy.port) { resolve({ ok: false, reason: 'invalid', ms: 0 }); return; }
      let target;
      try { target = new URL(targetUrl); } catch (_) { resolve({ ok: false, reason: 'invalid_target', ms: 0 }); return; }

      const scheme = (proxy.type || 'http').toLowerCase();
      const cacheKey = scheme + ':' + proxy.host + ':' + proxy.port + ':' + target.origin;
      const hit = reachCache.get(cacheKey);
      if (hit && hit.exp > Date.now()) {
        resolve({ ok: hit.ok, reason: hit.reason, ms: 0, cached: true });
        return;
      }

      const start = Date.now();
      let settled = false;
      let timer = null;
      const finish = (ok, reason) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        const result = { ok, reason: reason || (ok ? 'ok' : 'failed'), ms: Date.now() - start };
        reachCache.set(cacheKey, { ok: result.ok, reason: result.reason, exp: Date.now() + REACH_TTL_MS });
        resolve(result);
      };
      timer = setTimeout(() => finish(false, 'timeout'), timeoutMs + 500);

      const host = target.hostname;
      const port = parseInt(target.port, 10) || (target.protocol === 'https:' ? 443 : 80);

      if (scheme.startsWith('socks')) {
        let socks;
        try { socks = require('socks'); } catch (_) { finish(false, 'connect_failed'); return; }
        const socksType = scheme === 'socks4' ? 4 : 5;
        const opts = { host: proxy.host, port: parseInt(proxy.port, 10), type: socksType, timeout: timeoutMs };
        if (proxy.username) { opts.userId = proxy.username; if (socksType === 5) opts.password = proxy.password || ''; }
        socks.SocksClient.createConnection({ proxy: opts, command: 'connect', destination: { host, port }, timeout: timeoutMs })
          .then(({ socket }) => {
            if (settled) { try { socket.destroy(); } catch (_) {} return; }
            if (target.protocol === 'http:') {
              const req = http.request({ createConnection: () => socket, host, port, path: target.pathname + target.search, method: 'GET', headers: { Host: target.host, 'User-Agent': 'Mozilla/5.0', Connection: 'close' } }, (res) => {
                res.resume();
                res.on('end', () => finish(res.statusCode < 500, res.statusCode === 407 ? 'auth' : 'ok'));
              });
              req.on('error', () => finish(false, 'site_blocked'));
              req.end();
            } else {
              const s = tls.connect({ socket, servername: host, rejectUnauthorized: false }, () => { finish(true, 'ok'); try { s.destroy(); } catch (_) {} });
              s.on('error', () => finish(false, 'site_blocked'));
            }
          })
          .catch(() => finish(false, 'connect_failed'));
        return;
      }

      // HTTP / HTTPS proxy.
      const headers = { Host: host + ':' + port };
      if (proxy.username) {
        headers['Proxy-Authorization'] = 'Basic ' + Buffer.from(proxy.username + ':' + (proxy.password || '')).toString('base64');
      }

      if (target.protocol === 'https:') {
        // Mirror the browser: CONNECT tunnel, then a real TLS handshake.
        const req = http.request({
          host: proxy.host,
          port: parseInt(proxy.port, 10),
          method: 'CONNECT',
          path: host + ':' + port,
          headers,
          timeout: timeoutMs,
        });
        req.on('connect', (res, socket) => {
          if (res.statusCode !== 200) {
            try { socket.destroy(); } catch (_) {}
            finish(false, res.statusCode === 407 ? 'auth' : 'proxy_' + res.statusCode);
            return;
          }
          const s = tls.connect({ socket, servername: host, rejectUnauthorized: false }, () => {
            finish(true, 'ok');
            try { s.destroy(); } catch (_) {}
          });
          s.on('error', () => finish(false, 'site_blocked'));
        });
        req.on('timeout', () => { req.destroy(); finish(false, 'timeout'); });
        req.on('error', (err) => finish(false, err && err.code === 'ECONNRESET' ? 'site_blocked' : (err && err.code === 'ECONNREFUSED' ? 'refused' : 'connect_failed')));
        req.end();
      } else {
        const req = http.request({
          host: proxy.host,
          port: parseInt(proxy.port, 10),
          path: target.href,
          method: 'GET',
          headers: Object.assign({}, headers, { Host: target.host, 'User-Agent': 'Mozilla/5.0', Connection: 'close' }),
          timeout: timeoutMs,
        }, (res) => {
          res.resume();
          res.on('end', () => finish(res.statusCode < 500, res.statusCode === 407 ? 'auth' : 'ok'));
        });
        req.on('timeout', () => { req.destroy(); finish(false, 'timeout'); });
        req.on('error', (err) => finish(false, err && err.code === 'ECONNRESET' ? 'site_blocked' : (err && err.code === 'ECONNREFUSED' ? 'refused' : 'connect_failed')));
        req.end();
      }
    });
  }
}

module.exports = ProxyHandler;
