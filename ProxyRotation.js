// ProxyRotation.js
// Shared proxy-pool rotation for every browser user in the app:
//   - the campaign modules (direct / organic / social / maps)
//   - the RPA recorder + replay
//
// Why this module exists
// ----------------------
// A free-proxy list contains many host:port entries that share one exit IP
// (e.g. 102.244.78.61:8081..8086 -> 102.244.78.57). Picking a different entry
// therefore did NOT change the IP the site saw, and a "verified" pool of one
// entry made every session/round repeat the same IP - exactly the footprint
// that gets ad accounts suspended.
//
// Rotation policy (anti-ban)
// --------------------------
//   1. Dedupe the pool by *exit identity*, not host:port. Rotating proxies
//      (session token / {session} username) are kept because every session is
//      a new exit by design.
//   2. Keep a persistent usage ledger. One IP is never used more than
//      HARD_LIMIT times inside WINDOW_MS (default 5 / 12 h) and the 4th-5th
//      uses are only allowed when no fresher exit exists. A repeated use is
//      also spaced by MIN_GAP_MS (default 20 min) whenever possible.
//   3. Mix countries: when there is a choice, do not reuse the country of the
//      last two picks.
//   4. Failed exits get an exponential cooldown instead of being retried
//      immediately.
//   5. Never fall back to the direct connection; callers abort/retry.
//
// The ledger is persisted by the host app (configureProxyUsage({file})) so a
// restart cannot reset the counters and accidentally reuse an IP 20 times.

'use strict';

const fs = require('fs');
const path = require('path');

// ── Identity helpers ───────────────────────────────────────────────────────

function proxyIdentity(proxy) {
  if (!proxy || !proxy.host) return '';
  const type = String(proxy.type || 'http').toLowerCase();
  return `${type}://${String(proxy.host).toLowerCase()}:${proxy.port}`;
}

function isRotatingProxy(proxy) {
  if (!proxy) return false;
  if (proxy.rotating === true || proxy.sessionSuffix === true) return true;
  return /\{session\}/i.test(String(proxy.username || ''));
}

// What the visited site sees. Two records with the same value do not rotate
// the IP, so the pool keeps only one of them.
function proxyExitIdentity(proxy) {
  if (!proxy || !proxy.host) return '';
  if (isRotatingProxy(proxy)) return `rot:${proxyIdentity(proxy)}`;
  const egress = String(proxy.egressIp || proxy.exitIp || '').trim();
  return egress ? `ip:${egress}` : `host:${proxyIdentity(proxy)}`;
}

function proxyCountry(proxy) {
  if (!proxy) return '';
  return String(proxy.countryCode || proxy.country || '').trim().toUpperCase();
}

function dedupeProxyPool(list) {
  const source = Array.isArray(list) ? list : [];
  const groups = new Map();
  for (const proxy of source) {
    if (!proxy || !proxy.host || !proxy.port) continue;
    const key = proxyExitIdentity(proxy);
    if (!key) continue;
    // Prefer a target-verified record, then one with a known exit IP, then one
    // already marked working. Only the representative survives.
    const rank = (proxy.targetOk === true ? 0 : 2) +
      (String(proxy.egressIp || '').trim() ? 0 : 1) +
      (proxy.status === 'ok' ? 0 : 0.5);
    const prev = groups.get(key);
    if (!prev || rank < prev.rank) groups.set(key, { proxy, rank });
  }
  return Array.from(groups.values()).map(x => x.proxy);
}

// Pool precedence used by every campaign module: proxies verified against the
// actual campaign URL first, then the rest of the working list, then anything
// else. Everything is deduped by exit identity. Unlike the old behaviour this
// never shrinks the rotation pool to the (often tiny) target-verified subset -
// a frozen IP is worse than an unverified proxy that still passes the
// session-level egress guard.
function buildRotationPool(proxiesData) {
  const data = proxiesData || {};
  const alive = (p) => p && p.status !== 'dead';
  const working = (Array.isArray(data.workingProxies) ? data.workingProxies : []).filter(alive);
  const all = (Array.isArray(data.proxies) ? data.proxies : []).filter(alive);
  const checkUrl = data.checkUrl || '';
  const targetOk = working.filter(p => p && p.targetOk === true &&
    (!checkUrl || !p.targetUrl || p.targetUrl === checkUrl));
  const ordered = [];
  const push = (p) => { if (p && p.host && p.port) ordered.push(p); };
  targetOk.forEach(push);
  working.forEach(push);
  all.forEach(push);
  const pool = dedupeProxyPool(ordered);
  // Last resort: every record is marked dead, but the caller explicitly asked
  // for rotation. Let the session-level egress guard decide instead of a stale
  // status flag (the user may have fixed the provider).
  return pool.length ? pool : dedupeProxyPool(Array.isArray(data.proxies) ? data.proxies : []);
}

function proxyPoolOf(config) {
  const data = config && config.proxies;
  if (!data || !data.useProxies) return [];
  return buildRotationPool(data);
}

// ── Persistent usage ledger ────────────────────────────────────────────────

const HOUR = 60 * 60 * 1000;

const usage = {
  configured: false,
  file: '',
  windowMs: 12 * HOUR,     // rolling window
  softLimit: 3,            // normal maximum uses per IP per window
  hardLimit: 5,            // absolute maximum (4th/5th only when needed)
  minGapMs: 20 * 60 * 1000,// preferred spacing between uses of the same IP
  failCooldownMs: 5 * 60 * 1000,
  entries: new Map(),      // exit identity -> { ip, country, uses:[ms], fails, cooldownUntil }
  recent: [],              // [{ key, country, at }] latest picks (country mixing)
  loaded: false,
  dirty: false,
  saveTimer: null,
};

function configureProxyUsage(opts = {}) {
  if (Object.prototype.hasOwnProperty.call(opts, 'file')) {
    usage.file = opts.file ? String(opts.file) : '';
  }
  if (Number.isFinite(opts.windowMs) && opts.windowMs > 0) usage.windowMs = opts.windowMs;
  if (Number.isFinite(opts.softLimit) && opts.softLimit > 0) usage.softLimit = Math.floor(opts.softLimit);
  if (Number.isFinite(opts.hardLimit) && opts.hardLimit >= 1) usage.hardLimit = Math.floor(opts.hardLimit);
  if (Number.isFinite(opts.minGapMs) && opts.minGapMs >= 0) usage.minGapMs = opts.minGapMs;
  if (usage.hardLimit < usage.softLimit) usage.hardLimit = usage.softLimit;
  usage.configured = true;
  loadUsage();
}

function loadUsage() {
  if (usage.loaded) return;
  usage.loaded = true;
  if (!usage.file) return;
  try {
    if (!fs.existsSync(usage.file)) return;
    const raw = JSON.parse(fs.readFileSync(usage.file, 'utf8'));
    const entries = raw && raw.entries && typeof raw.entries === 'object' ? raw.entries : {};
    for (const [key, value] of Object.entries(entries)) {
      if (!value || typeof value !== 'object') continue;
      usage.entries.set(key, {
        ip: String(value.ip || ''),
        country: String(value.country || '').toUpperCase(),
        uses: Array.isArray(value.uses) ? value.uses.map(Number).filter(Number.isFinite) : [],
        fails: Number(value.fails) || 0,
        cooldownUntil: Number(value.cooldownUntil) || 0,
      });
    }
    usage.recent = Array.isArray(raw && raw.recent)
      ? raw.recent.filter(r => r && typeof r.key === 'string').slice(-8)
      : [];
  } catch (_) {
    // A corrupt ledger must never stop traffic; start clean instead.
    usage.entries.clear();
    usage.recent = [];
  }
}

function saveUsageNow() {
  if (!usage.file) return;
  try {
    fs.mkdirSync(path.dirname(usage.file), { recursive: true });
    const entries = {};
    for (const [key, value] of usage.entries) {
      const e = {
        ip: value.ip || '',
        country: value.country || '',
        uses: (value.uses || []).slice(-20),
        fails: value.fails || 0,
        cooldownUntil: value.cooldownUntil || 0,
      };
      if (e.uses.length || e.fails || e.cooldownUntil) entries[key] = e;
    }
    const payload = JSON.stringify({
      version: 1,
      windowMs: usage.windowMs,
      softLimit: usage.softLimit,
      hardLimit: usage.hardLimit,
      savedAt: Date.now(),
      recent: usage.recent.slice(-8),
      entries,
    }, null, 2);
    const tmp = usage.file + '.tmp';
    fs.writeFileSync(tmp, payload, 'utf8');
    fs.renameSync(tmp, usage.file);
  } catch (_) {}
  usage.dirty = false;
}

function scheduleUsageSave() {
  usage.dirty = true;
  if (usage.saveTimer) return;
  usage.saveTimer = setTimeout(() => {
    usage.saveTimer = null;
    saveUsageNow();
  }, 1500);
  if (usage.saveTimer.unref) usage.saveTimer.unref();
}

function pruneUsage(now = Date.now()) {
  for (const [key, value] of Array.from(usage.entries.entries())) {
    value.uses = (value.uses || []).filter(t => now - t < usage.windowMs);
    if (value.cooldownUntil && value.cooldownUntil <= now) value.cooldownUntil = 0;
    if (!value.uses.length && !value.fails && !value.cooldownUntil) usage.entries.delete(key);
  }
  usage.recent = usage.recent.filter(r => now - (Number(r.at) || 0) < usage.windowMs).slice(-8);
}

function entryState(key, now) {
  const entry = usage.entries.get(key);
  const uses = entry ? (entry.uses || []).filter(t => now - t < usage.windowMs) : [];
  return {
    uses: uses.length,
    lastUsed: uses.length ? Math.max(...uses) : 0,
    cooldownUntil: entry && entry.cooldownUntil > now ? entry.cooldownUntil : 0,
    fails: (entry && entry.fails) || 0,
    country: (entry && entry.country) || '',
  };
}

function reserveUse(key, proxy, now) {
  let entry = usage.entries.get(key);
  if (!entry) {
    entry = { ip: String(proxy && (proxy.egressIp || proxy.host) || ''), country: '', uses: [], fails: 0, cooldownUntil: 0 };
    usage.entries.set(key, entry);
  }
  if (!entry.ip) entry.ip = String((proxy && (proxy.egressIp || proxy.host)) || '');
  const country = proxyCountry(proxy) || entry.country || '';
  if (country) entry.country = country;
  entry.uses = (entry.uses || []).filter(t => now - t < usage.windowMs);
  entry.uses.push(now);
  usage.recent.push({ key, country, at: now });
  if (usage.recent.length > 8) usage.recent = usage.recent.slice(-8);
  scheduleUsageSave();
}

/**
 * Mark an exit as failed. The next attempt uses a different proxy and this one
 * is skipped for an exponentially longer cooldown (max 1 h).
 */
function markProxyFailure(proxy, reason) {
  if (!proxy || !proxy.host) return;
  loadUsage();
  const key = proxyExitIdentity(proxy);
  if (!key) return;
  const now = Date.now();
  let entry = usage.entries.get(key);
  if (!entry) {
    entry = { ip: String(proxy.egressIp || proxy.host || ''), country: proxyCountry(proxy), uses: [], fails: 0, cooldownUntil: 0 };
    usage.entries.set(key, entry);
  }
  entry.fails = (entry.fails || 0) + 1;
  const cooldown = Math.min(HOUR, usage.failCooldownMs * Math.pow(2, Math.max(0, entry.fails - 1)));
  entry.cooldownUntil = now + cooldown;
  if (reason) entry.lastReason = String(reason).slice(0, 120);
  scheduleUsageSave();
}

/** A successful session clears the failure streak for that exit. */
function markProxySuccess(proxy, info = {}) {
  if (!proxy || !proxy.host) return;
  loadUsage();
  const keys = [proxyExitIdentity(proxy)];
  const egress = String(info.egressIp || '').trim();
  // The pool may have been built from a host:port identity before the real IP
  // was known. Move the usage history to the ip:<egress> identity so a future
  // run that already knows the exit IP does not see a fresh budget for the
  // same IP.
  if (egress && !isRotatingProxy(proxy)) {
    const fromKey = proxyExitIdentity(proxy);
    const toKey = `ip:${egress}`;
    if (fromKey !== toKey) {
      const from = usage.entries.get(fromKey);
      if (from) {
        const to = usage.entries.get(toKey);
        if (!to) {
          from.ip = egress;
          usage.entries.delete(fromKey);
          usage.entries.set(toKey, from);
        } else {
          to.uses = (to.uses || []).concat(from.uses || []).sort((a, b) => a - b).slice(-30);
          to.fails = Math.max(to.fails || 0, from.fails || 0);
          to.cooldownUntil = Math.max(to.cooldownUntil || 0, from.cooldownUntil || 0);
          usage.entries.delete(fromKey);
        }
        usage.recent = usage.recent.map(r => (r && r.key === fromKey)
          ? { ...r, key: toKey, country: String(info.country || r.country || '').toUpperCase() }
          : r);
        keys.length = 0;
        keys.push(toKey);
      }
    }
  }
  if (egress) keys.push(`ip:${egress}`);
  for (const key of keys) {
    if (!key) continue;
    const entry = usage.entries.get(key);
    if (!entry) continue;
    entry.fails = 0;
    if (info.country) entry.country = String(info.country).toUpperCase();
  }
  scheduleUsageSave();
}

// ── Selection ──────────────────────────────────────────────────────────────

function scoreCandidate(proxy, now, recentCountries) {
  const key = proxyExitIdentity(proxy);
  if (isRotatingProxy(proxy)) {
    // Every session gets a fresh exit from the provider; never budget-limited.
    return { key, tier: -1, uses: 0, lastUsed: 0, cooldownUntil: 0, country: proxyCountry(proxy) };
  }
  const state = entryState(key, now);
  const country = proxyCountry(proxy) || state.country;
  let tier = 0;
  if (state.cooldownUntil) tier = 90;
  else if (state.uses >= usage.hardLimit) tier = 99;
  else if (state.uses >= usage.softLimit) tier = 3;
  else if (state.lastUsed && now - state.lastUsed < usage.minGapMs) tier = 2;
  else if (country && recentCountries.includes(country)) tier = 1;
  return { key, tier, uses: state.uses, lastUsed: state.lastUsed, cooldownUntil: state.cooldownUntil, country };
}

/**
 * Pick the safest next exit from a distinct-exit pool.
 *
 * @param {Array} pool distinct proxy records (dedupeProxyPool output)
 * @param {Object}[meta] optional out-parameter: tier / uses / country / waitMs
 * @returns {Object|null} proxy, or null when every exit hit the hard cap
 */
function acquireRotationProxy(pool, meta) {
  if (!Array.isArray(pool) || !pool.length) return null;
  loadUsage();
  const now = Date.now();
  pruneUsage(now);

  const unique = dedupeProxyPool(pool);
  if (!unique.length) return null;

  const recentCountries = usage.recent.slice(-2)
    .map(r => String(r.country || '').toUpperCase())
    .filter(Boolean);
  let lastKey = '';
  for (let i = usage.recent.length - 1; i >= 0; i--) {
    if (usage.recent[i] && usage.recent[i].key) { lastKey = usage.recent[i].key; break; }
  }

  const scored = unique.map(proxy => {
    const s = scoreCandidate(proxy, now, recentCountries);
    // Lower is better. Random jitter spreads equal candidates across parallel
    // sessions instead of handing every worker the same first entry.
    const ageMinutes = s.lastUsed ? (now - s.lastUsed) / 60000 : 1e6;
    s.score = s.tier * 1e6 + s.uses * 1000 + Math.max(0, 200 - ageMinutes) + Math.random() * 50;
    return { proxy, ...s };
  });

  const eligible = scored.filter(s => s.tier < 90);
  if (!eligible.length) {
    // Everything is cooling down or capped. Report when the first exit frees up
    // instead of silently reusing an IP.
    let waitMs = Infinity;
    for (const s of scored) {
      if (s.cooldownUntil) waitMs = Math.min(waitMs, s.cooldownUntil - now);
      else if (!isRotatingProxy(s.proxy)) {
        const entry = usage.entries.get(s.key);
        const oldest = entry && entry.uses && entry.uses.length ? Math.min(...entry.uses) : now;
        waitMs = Math.min(waitMs, Math.max(0, usage.windowMs - (now - oldest)));
      }
    }
    if (meta) {
      meta.tier = 99;
      meta.available = 0;
      meta.waitMs = Number.isFinite(waitMs) ? waitMs : 0;
      meta.windowMs = usage.windowMs;
      meta.hardLimit = usage.hardLimit;
    }
    return null;
  }

  // Prefer a different identity than the immediately previous pick.
  let best = null;
  for (const s of eligible) {
    if (s.key === lastKey && eligible.length > 1) continue;
    if (!best || s.score < best.score) best = s;
  }
  if (!best) best = eligible.sort((a, b) => a.score - b.score)[0];

  if (!isRotatingProxy(best.proxy)) reserveUse(best.key, best.proxy, now);
  if (meta) {
    meta.tier = best.tier;
    meta.uses = best.uses + (isRotatingProxy(best.proxy) ? 0 : 1);
    meta.country = best.country;
    meta.hardLimit = usage.hardLimit;
    meta.softLimit = usage.softLimit;
    meta.windowMs = usage.windowMs;
  }
  return best.proxy;
}

function getProxyUsageSnapshot(pool) {
  const list = dedupeProxyPool(pool);
  const now = Date.now();
  const snapshot = {
    poolSize: list.length,
    available: 0,
    cooling: 0,
    capped: 0,
    rotating: 0,
    windowHours: Math.round((usage.windowMs / HOUR) * 10) / 10,
    softLimit: usage.softLimit,
    hardLimit: usage.hardLimit,
    minGapMinutes: Math.round(usage.minGapMs / 60000),
    safeCapacity: 0,
    waitMs: 0,
  };
  let waitMs = Infinity;
  for (const proxy of list) {
    if (isRotatingProxy(proxy)) { snapshot.rotating++; snapshot.available++; continue; }
    const s = entryState(proxyExitIdentity(proxy), now);
    if (s.cooldownUntil) { snapshot.cooling++; waitMs = Math.min(waitMs, s.cooldownUntil - now); }
    else if (s.uses >= usage.hardLimit) {
      snapshot.capped++;
      const entry = usage.entries.get(proxyExitIdentity(proxy));
      const oldest = entry && entry.uses && entry.uses.length ? Math.min(...entry.uses) : now;
      waitMs = Math.min(waitMs, Math.max(0, usage.windowMs - (now - oldest)));
    } else snapshot.available++;
  }
  snapshot.safeCapacity = snapshot.available * usage.hardLimit + snapshot.rotating * 1000;
  snapshot.waitMs = Number.isFinite(waitMs) ? waitMs : 0;
  return snapshot;
}

// Test / maintenance helpers.
function resetRotationState() {
  usage.entries.clear();
  usage.recent = [];
  usage.loaded = true;
  scheduleUsageSave();
}

function usagePolicy() {
  return {
    windowMs: usage.windowMs,
    softLimit: usage.softLimit,
    hardLimit: usage.hardLimit,
    minGapMs: usage.minGapMs,
    failCooldownMs: usage.failCooldownMs,
  };
}

function flushUsage() {
  if (usage.saveTimer) { clearTimeout(usage.saveTimer); usage.saveTimer = null; }
  saveUsageNow();
}

function isProxyFailureResult(result) {
  return result === 'proxy_blocked' || result === 'proxy_failed';
}

// runOnce(configWithOffset) must resolve to true | false | 'proxy_blocked'.
async function runWithProxyRetry({ config, runOnce, onLog = () => {}, isStopped = () => false }) {
  const size = proxyPoolOf(config).length;

  let attempts = 1;
  if (size > 1) attempts = Math.min(size, 6);
  else if (size === 1) attempts = 2;

  let last = false;
  for (let i = 0; i < attempts; i++) {
    if (isStopped && isStopped()) return false;

    const result = await runOnce({ ...config, __proxyOffset: i });
    last = result;

    if (!isProxyFailureResult(result)) return !!result;
    if (i < attempts - 1) {
      onLog(`[Proxy] Switching to proxy #${i + 2} and reopening...`, 'WARN');
    }
  }

  return false;
}

module.exports = {
  proxyIdentity,
  proxyExitIdentity,
  isRotatingProxy,
  proxyCountry,
  dedupeProxyPool,
  buildRotationPool,
  proxyPoolOf,
  configureProxyUsage,
  acquireRotationProxy,
  getProxyUsageSnapshot,
  markProxyFailure,
  markProxySuccess,
  resetRotationState,
  usagePolicy,
  flushUsage,
  isProxyFailureResult,
  runWithProxyRetry,
};
