// ProxyBrowserCheck.js
// Real-browser proxy validation.
//
// Proxyhandler.testReachability() only proves that a TCP/TLS tunnel can be
// opened (and it intentionally ignores certificate errors). Several free
// proxies pass that check but are unusable in Chromium:
//   - they MITM HTTPS (NET::ERR_CERT_AUTHORITY_INVALID)
//   - they refuse CONNECT after the handshake
//   - they silently fall back to the direct connection
//
// This module loads the target URL in a real Chromium context through each
// proxy - the exact path a traffic session takes - so the saved proxy list
// only keeps entries the browser can actually use.
//
// A single browser is launched and every check gets its own context, which is
// much faster than launching one browser per proxy.

'use strict';

const https = require('https');
const { launchBrowser } = require('./browser-launcher.js');
const ProxyHandler = require('./Proxyhandler.js');
const { resolveProxyGeo } = require('./EgressGuard.js');

const CHECK_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Cache the machine's own egress IP so we can detect proxies that do not
// actually proxy anything.
let localIpCache = { ip: '', exp: 0 };

function getLocalIp(timeoutMs = 4000) {
  if (localIpCache.ip && localIpCache.exp > Date.now()) return Promise.resolve(localIpCache.ip);
  return new Promise((resolve) => {
    const req = https.get('https://api.ipify.org?format=json', { timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        let ip = '';
        try { ip = (JSON.parse(body) || {}).ip || ''; } catch (_) { ip = body.trim(); }
        if (/^[0-9a-f:.]+$/i.test(ip)) {
          localIpCache = { ip, exp: Date.now() + 10 * 60 * 1000 };
        }
        resolve(ip);
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(''); });
    req.on('error', () => resolve(''));
  });
}

// Map a Chromium navigation error to a short, user-facing reason.
function classifyBrowserError(message) {
  const m = String(message || '');
  if (/ERR_PROXY_CONNECTION_FAILED|ERR_PROXY_AUTH_UNSUPPORTED|ERR_PROXY_CERTIFICATE_INVALID/i.test(m)) return 'proxy_conn_failed';
  if (/ERR_TUNNEL_CONNECTION_FAILED/i.test(m)) return 'tunnel_failed';
  if (/ERR_CERT_|ERR_SSL_|CERT_AUTHORITY_INVALID|SSL_ERROR/i.test(m)) return 'cert_error';
  if (/ERR_NAME_NOT_RESOLVED/i.test(m)) return 'dns_failed';
  if (/ERR_CONNECTION_REFUSED/i.test(m)) return 'refused';
  if (/ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|ERR_EMPTY_RESPONSE|ERR_CONNECTION_ABORTED/i.test(m)) return 'connection_reset';
  if (/ERR_TIMED_OUT|Timeout .*exceeded|timed out/i.test(m)) return 'timeout';
  if (/ERR_HTTP_RESPONSE_CODE_FAILURE/i.test(m)) return 'http_error';
  if (/Target page, context or browser has been closed|Target closed|browser has been closed/i.test(m)) return 'browser_closed';
  if (/ERR_ABORTED/i.test(m)) return 'aborted';
  if (/ERR_INVALID_URL|Cannot navigate to invalid URL/i.test(m)) return 'invalid_target';
  return 'browser_failed';
}

class BrowserProxyChecker {
  constructor(opts = {}) {
    this.headless = opts.headless !== false;
    this.customBrowserPath = opts.customBrowserPath || '';
    this.timeoutMs = Math.max(3000, Math.min(30000, parseInt(opts.timeoutMs, 10) || 12000));
    this.checkEgress = opts.checkEgress !== false;
    this.sessionId = opts.sessionId || 'Proxy check';
    this.ph = new ProxyHandler();
    this.browser = null;
    this.launching = null;
  }

  async ensureBrowser() {
    if (this.browser && typeof this.browser.isConnected === 'function' && this.browser.isConnected()) {
      return this.browser;
    }
    if (!this.launching) {
      this.launching = launchBrowser({
        headless: this.headless,
        customBrowserPath: this.customBrowserPath,
        sessionId: this.sessionId,
      }).then((browser) => {
        this.browser = browser;
        this.launching = null;
        try {
          browser.on('disconnected', () => {
            if (this.browser === browser) this.browser = null;
          });
        } catch (_) {}
        return browser;
      }).catch((err) => {
        this.launching = null;
        throw err;
      });
    }
    return this.launching;
  }

  async close() {
    const browser = this.browser;
    this.browser = null;
    this.launching = null;
    if (browser) {
      try { await browser.close(); } catch (_) {}
    }
  }

  // Read the egress IP through the proxy from inside the same context.
  async readEgress(context, timeoutMs) {
    let page = null;
    try {
      page = await context.newPage();
      const res = await page.goto('https://api.ipify.org?format=json', {
        waitUntil: 'domcontentloaded',
        timeout: Math.max(3000, Math.min(8000, timeoutMs)),
      });
      if (!res || res.status() !== 200) return '';
      const text = (await page.evaluate(() => (document.body ? document.body.innerText : ''))).trim();
      try {
        const parsed = JSON.parse(text);
        return (parsed && parsed.ip) ? String(parsed.ip).trim() : '';
      } catch (_) {
        return /^[0-9a-f:.]+$/i.test(text) ? text : '';
      }
    } catch (_) {
      return '';
    } finally {
      if (page) { try { await page.close(); } catch (_) {} }
    }
  }

  /**
   * Load `targetUrl` in Chromium through `proxy`.
   * @returns {Promise<{ok:boolean,ms:number,reason:string,status?:number,egressIp?:string}>}
   */
  async check(proxy, targetUrl, timeoutMs) {
    const start = Date.now();
    const budget = Math.max(3000, Math.min(30000, parseInt(timeoutMs, 10) || this.timeoutMs));
    const url = (typeof targetUrl === 'string' && /^https?:\/\//i.test(targetUrl.trim()))
      ? targetUrl.trim()
      : 'https://example.com';

    if (!proxy || !proxy.host || !proxy.port) return { ok: false, ms: 0, reason: 'invalid' };

    let context = null;
    try {
      const browser = await this.ensureBrowser();
      const proxyOpts = this.ph.buildPlaywrightProxyOpts(proxy);
      if (!proxyOpts || !proxyOpts.proxy) return { ok: false, ms: 0, reason: 'invalid' };

      context = await browser.newContext({
        proxy: proxyOpts.proxy,
        userAgent: CHECK_UA,
        viewport: { width: 1000, height: 700 },
        ignoreHTTPSErrors: false, // a MITM proxy must fail here, like in a real session
        serviceWorkers: 'block',
      });

      const page = await context.newPage();
      page.setDefaultTimeout(budget);
      page.setDefaultNavigationTimeout(budget);

      let response;
      try {
        response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: budget });
      } catch (err) {
        return { ok: false, ms: Date.now() - start, reason: classifyBrowserError(err && err.message) };
      }

      const finalUrl = page.url() || '';
      if (/^chrome-error:/i.test(finalUrl)) {
        return { ok: false, ms: Date.now() - start, reason: 'browser_error' };
      }
      const status = response ? response.status() : 0;
      if (status === 407) return { ok: false, ms: Date.now() - start, reason: 'auth' };
      if (status === 401 || status === 403) return { ok: false, ms: Date.now() - start, reason: 'site_blocked' };
      if (status >= 500) return { ok: false, ms: Date.now() - start, reason: 'site_blocked' };
      if (!response) return { ok: false, ms: Date.now() - start, reason: 'no_response' };

      // Some ad networks / target sites answer HTTP 200 with a block page that
      // says "Anonymous Proxy detected" (the URL usually has ?key=...). Such a
      // proxy is unusable even though the HTTP status is 200, so report it as
      // a failed candidate instead of sending campaign traffic into the block.
      try {
        const text = await page.evaluate(() => (document.body ? document.body.innerText : '').slice(0, 20000)).catch(() => '');
        if (/anonymous\s+proxy\s+detected|proxy\s*\/?\s*vpn\s+detected|vpn\s*\/?\s*proxy\s+detected|you\s+are\s+using\s+a\s+proxy|proxy\s+detected/i.test(text || '')) {
          return { ok: false, ms: Date.now() - start, reason: 'proxy_detected', status };
        }
      } catch (_) {}

      // Make sure the proxy is really in front of the traffic.
      let egressIp = '';
      let localIpMatched = false;
      let geo = null;
      if (this.checkEgress) {
        const [ip, localIp, geoRes] = await Promise.all([
          this.readEgress(context, Math.min(8000, budget)),
          getLocalIp(),
          resolveProxyGeo(proxy, { timeoutMs: Math.min(6000, budget) }).catch(() => null),
        ]);
        egressIp = ip;
        geo = geoRes;
        if (egressIp && localIp && egressIp === localIp) {
          localIpMatched = true;
          return { ok: false, ms: Date.now() - start, reason: 'ip_leak', egressIp, localIpMatched, geo };
        }
        if (egressIp && geo && geo.ip && egressIp !== geo.ip) {
          // Rotating proxy: different exit per request is expected. It passed
          // the local-IP comparison above, so it is not a leak.
        }
      }

      return {
        ok: true,
        ms: Date.now() - start,
        reason: 'ok',
        status,
        egressIp,
        localIpMatched,
        country: (geo && geo.country) || '',
        countryCode: (geo && geo.countryCode) || '',
        timezone: (geo && geo.timezone) || '',
        geoIp: (geo && geo.ip) || '',
      };
    } catch (err) {
      const reason = /browser/i.test(String(err && err.message)) ? 'browser_failed' : classifyBrowserError(err && err.message);
      return { ok: false, ms: Date.now() - start, reason };
    } finally {
      if (context) { try { await context.close(); } catch (_) {} }
    }
  }
}

module.exports = { BrowserProxyChecker, classifyBrowserError, getLocalIp };
