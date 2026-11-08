// EgressGuard.js
// Keeps every browser page on the proxy's network identity.
//
// Three separate leaks are handled here:
//
//   1. WebRTC (STUN) - the browser gathers UDP candidates directly from the
//      home connection, exposing the real IP even when an HTTP proxy is set.
//      Chromium's --force-webrtc-ip-handling-policy is not enough on every
//      build, so every page gets a WebRTC stub that never emits a candidate.
//
//   2. Geolocation - Chrome's geolocation provider can resolve the real
//      location outside the proxy. When we know the proxy's coordinates we
//      grant the context those exact coordinates; otherwise permission is
//      denied so the real location is never exposed.
//
//   3. Egress verification - every proxy is looked up through itself once so
//      we know the IP it actually exits from, and the session can log a
//      warning if the browser's egress IP differs.

const http = require('http');
const https = require('https');
const { URL } = require('url');

const GEO_TTL_MS = 30 * 60 * 1000;
const geoCache = new Map();

// The PC's own public IP (no proxy), resolved once and cached. Used only to
// decide whether an unexpected egress IP is an actual leak of the home
// connection (proxy rotation returning a different IP is harmless).
let localIpCache = { ip: '', exp: 0 };

function getLocalIp(timeoutMs = 5000) {
  if (localIpCache.ip && localIpCache.exp > Date.now()) {
    return Promise.resolve(localIpCache.ip);
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ip) => {
      if (settled) return;
      settled = true;
      if (ip) localIpCache = { ip, exp: Date.now() + 60 * 60 * 1000 };
      resolve(ip || '');
    };
    const req = https.get(
      'https://api.ipify.org?format=json',
      { timeout: timeoutMs, headers: { Accept: 'application/json' } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          try {
            finish((JSON.parse(body) || {}).ip || '');
          } catch (_) {
            finish('');
          }
        });
      }
    );
    req.on('timeout', () => { try { req.destroy(); } catch (_) {} finish(''); });
    req.on('error', () => finish(''));
  });
}

function proxyKey(proxy) {
  if (!proxy) return '';
  return `${(proxy.type || 'http').toLowerCase()}://${proxy.host}:${proxy.port}`;
}

function httpGetViaProxy(proxy, targetUrl, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    let target;
    try {
      target = new URL(targetUrl);
    } catch (_) {
      finish(null);
      return;
    }
    if (target.protocol !== 'http:') {
      // Geo lookup endpoints below are plain HTTP on purpose: no CONNECT
      // tunnel is needed, which keeps the lookup fast and dependency free.
      finish(null);
      return;
    }

    const headers = {
      Host: target.host,
      'User-Agent': 'Mozilla/5.0',
      Accept: 'application/json',
      Connection: 'close',
    };
    if (proxy.username) {
      headers['Proxy-Authorization'] =
        'Basic ' + Buffer.from(`${proxy.username}:${proxy.password || ''}`).toString('base64');
    }

    const req = http.request(
      {
        host: proxy.host,
        port: parseInt(proxy.port, 10),
        path: target.href,
        method: 'GET',
        headers,
        timeout: timeoutMs,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
          if (body.length > 65536) {
            try { req.destroy(); } catch (_) {}
            finish(null);
          }
        });
        res.on('end', () => {
          try {
            finish(JSON.parse(body));
          } catch (_) {
            finish(null);
          }
        });
      }
    );
    req.on('timeout', () => { try { req.destroy(); } catch (_) {} finish(null); });
    req.on('error', () => finish(null));
    req.end();
  });
}

/**
 * Resolve the public IP + approximate location of a proxy by querying through
 * the proxy itself. Cached for 30 minutes per proxy.
 *
 * @returns {Promise<{ip:string,country:string,countryCode:string,region:string,city:string,timezone:string,lat:number,lon:number}|null>}
 */
async function resolveProxyGeo(proxy, opts = {}) {
  const { timeoutMs = 6000 } = opts;
  if (!proxy || !proxy.host || !proxy.port) return null;

  const key = proxyKey(proxy);
  const hit = geoCache.get(key);
  if (hit && hit.exp > Date.now()) return hit.geo;

  const endpoints = [
    'http://ip-api.com/json/?fields=status,message,country,countryCode,regionName,city,timezone,lat,lon,query',
    'http://ipinfo.io/json',
  ];

  for (const url of endpoints) {
    const data = await httpGetViaProxy(proxy, url, timeoutMs);
    if (!data) continue;

    let geo = null;
    if (data.status === 'success' && data.query) {
      geo = {
        ip: data.query,
        country: data.country || '',
        countryCode: data.countryCode || '',
        region: data.regionName || '',
        city: data.city || '',
        timezone: data.timezone || '',
        lat: typeof data.lat === 'number' ? data.lat : null,
        lon: typeof data.lon === 'number' ? data.lon : null,
      };
    } else if (data.ip) {
      // ipinfo.io shape.
      const loc = typeof data.loc === 'string' ? data.loc.split(',') : [];
      geo = {
        ip: data.ip,
        country: data.country || '',
        countryCode: data.country || '',
        region: data.region || '',
        city: data.city || '',
        timezone: data.timezone || '',
        lat: loc.length === 2 ? parseFloat(loc[0]) : null,
        lon: loc.length === 2 ? parseFloat(loc[1]) : null,
      };
    }

    if (geo && geo.ip) {
      geoCache.set(key, { geo, exp: Date.now() + GEO_TTL_MS });
      return geo;
    }
  }

  // Negative cache so a dead proxy doesn't get hammered every session.
  geoCache.set(key, { geo: null, exp: Date.now() + 5 * 60 * 1000 });
  return null;
}

/**
 * Install a context-wide init script so EVERY page (including ad popups and
 * popunders opened with window.open) shares the same leak protection.
 */
async function installContextEgressGuard(context, opts = {}) {
  const { geo = null } = opts;
  const payload = {
    hasGeo: !!(geo && typeof geo.lat === 'number' && typeof geo.lon === 'number'),
  };

  await context.addInitScript((cfg) => {
    try {
      // --- WebRTC ---------------------------------------------------------
      // A stub peer connection is used instead of deleting the API: some
      // pages do `new RTCPeerConnection()` unguarded and would crash the
      // whole page if the constructor disappeared.
      function LeakSafePeerConnection() {
        const noop = function () {};
        this.localDescription = null;
        this.remoteDescription = null;
        this.currentLocalDescription = null;
        this.currentRemoteDescription = null;
        this.pendingLocalDescription = null;
        this.pendingRemoteDescription = null;
        this.iceConnectionState = 'new';
        this.iceGatheringState = 'new';
        this.connectionState = 'new';
        this.signalingState = 'stable';
        this.onicecandidate = null;
        this.onicecandidateerror = null;
        this.ondatachannel = null;
        this.onconnectionstatechange = null;
        this.oniceconnectionstatechange = null;
        this.onicegatheringstatechange = null;
        this.onsignalingstatechange = null;
        this.onnegotiationneeded = null;
        this.onaddstream = null;
        this.onremovestream = null;
        this.createDataChannel = function () {
          return {
            label: '',
            readyState: 'open',
            close: noop,
            send: noop,
            addEventListener: noop,
            removeEventListener: noop,
            addStream: noop,
          };
        };
        this.createOffer = function () {
          return Promise.resolve({ type: 'offer', sdp: 'v=0\r\n' });
        };
        this.createAnswer = function () {
          return Promise.resolve({ type: 'answer', sdp: 'v=0\r\n' });
        };
        this.setLocalDescription = function (desc) {
          this.localDescription = desc || null;
          this.iceGatheringState = 'complete';
          return Promise.resolve();
        };
        this.setRemoteDescription = function (desc) {
          this.remoteDescription = desc || null;
          return Promise.resolve();
        };
        this.addIceCandidate = function () { return Promise.resolve(); };
        this.addTrack = function () { return {}; };
        this.addStream = noop;
        this.getStats = function () { return Promise.resolve(new Map()); };
        this.getSenders = function () { return []; };
        this.getReceivers = function () { return []; };
        this.getTransceivers = function () { return []; };
        this.getLocalStreams = function () { return []; };
        this.getRemoteStreams = function () { return []; };
        this.restartIce = noop;
        this.close = noop;
        this.addEventListener = noop;
        this.removeEventListener = noop;
        this.dispatchEvent = function () { return true; };
      }

      try {
        Object.defineProperty(window, 'RTCPeerConnection', {
          value: LeakSafePeerConnection,
          configurable: true,
          writable: true,
        });
        Object.defineProperty(window, 'webkitRTCPeerConnection', {
          value: LeakSafePeerConnection,
          configurable: true,
          writable: true,
        });
        Object.defineProperty(window, 'mozRTCPeerConnection', {
          value: undefined,
          configurable: true,
          writable: true,
        });
      } catch (_) {}

      // Never hand out real camera/mic devices to ad pages.
      try {
        if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
          const empty = function () { return Promise.resolve([]); };
          navigator.mediaDevices.enumerateDevices = empty;
        }
      } catch (_) {}

      // --- Geolocation ----------------------------------------------------
      // With proxy coordinates the context returns those; without them the
      // request is denied so the real location cannot be resolved.
      if (!cfg.hasGeo) {
        try {
          const g = navigator.geolocation;
          if (g) {
            const deny = function (success, failure) {
              if (typeof failure === 'function') {
                setTimeout(function () {
                  try {
                    failure({ code: 1, message: 'User denied Geolocation', PERMISSION_DENIED: 1 });
                  } catch (_) {}
                }, 0);
              }
            };
            g.getCurrentPosition = deny;
            g.watchPosition = function (success, failure) {
              deny(success, failure);
              return 0;
            };
            g.clearWatch = function () {};
          }
        } catch (_) {}
      }
    } catch (_) {}
  }, payload);
}

/**
 * Confirm that page traffic really leaves through the proxy. `expectedIp` is
 * the IP returned by resolveProxyGeo() (it was obtained through the proxy).
 * Returns { ok, ip, skipped }.
 */
async function verifyEgress(context, expectedIp, opts = {}) {
  const {
    timeoutMs = 8000,
    onLog = () => {},
    sessionId = 'Session',
    onLeak = () => {},
  } = opts;

  if (!expectedIp) return { ok: true, skipped: true };

  try {
    const response = await context.request.get('https://api.ipify.org?format=json', {
      timeout: timeoutMs,
      headers: { Accept: 'application/json' },
    });
    const text = (await response.text()).trim();
    let ip = '';
    try {
      ip = (JSON.parse(text) || {}).ip || '';
    } catch (_) {
      ip = text;
    }
    if (!ip) return { ok: true, skipped: true };

    if (ip === expectedIp) {
      onLog(`[${sessionId}] Egress IP verified: ${ip} (proxy IP)`, 'info');
      return { ok: true, ip };
    }

    // A different IP can simply be a rotating proxy. It is a real leak only
    // when the session exits through the PC's own connection.
    const localIp = await getLocalIp();
    if (localIp && ip === localIp) {
      onLog(
        `[${sessionId}] LEAK BLOCKED: session used the PC IP ${ip} instead of proxy ${expectedIp} - closing and switching proxy`,
        'WARN'
      );
      try { onLeak(ip); } catch (_) {}
      return { ok: false, ip, expectedIp, leaked: true };
    }

    onLog(
      `[${sessionId}] WARNING: egress IP ${ip} differs from proxy IP ${expectedIp} (rotating proxy) - not the PC connection`,
      'WARN'
    );
    return { ok: false, ip, expectedIp, leaked: false };
  } catch (err) {
    return { ok: true, skipped: true, error: err && err.message };
  }
}

module.exports = {
  resolveProxyGeo,
  installContextEgressGuard,
  verifyEgress,
  getLocalIp,
};
